// Bitbucket client + process-wide request governor (src/bitbucket-governor.js,
// src/bitbucket.js). Timing tests use an injected fake clock so no real sleeps
// are needed; HTTP-level tests use a local stub server or a fetch monkeypatch.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  RequestGovernor,
  parseRetryAfterHeader,
  MIN_SPACING_MS,
  BREAKER_BASE_MS,
  BREAKER_MAX_MS,
  RETRY_AFTER_CAP_MS,
} from "../src/bitbucket-governor.js";
import { BitbucketClient } from "../src/bitbucket.js";

/** A fake clock whose sleep advances time synchronously (no real timers). */
function fakeClock(start = 0) {
  const clock = {
    t: start,
    sleeps: [],
    now: () => clock.t,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
  };
  return clock;
}

test("RequestGovernor: acquire() serializes callers and enforces min spacing", async () => {
  const c = fakeClock();
  const gov = new RequestGovernor({ now: c.now, sleep: c.sleep });
  const starts = [];
  const grab = async () => {
    await gov.acquire();
    starts.push(c.t);
  };
  await Promise.all([grab(), grab(), grab()]);
  assert.deepEqual(starts, [0, MIN_SPACING_MS, MIN_SPACING_MS * 2]);
});

test("RequestGovernor: a rejecting waiter does not poison the tail", async () => {
  const c = fakeClock();
  let failNext = false;
  const gov = new RequestGovernor({
    now: c.now,
    sleep: async (ms) => {
      if (failNext) {
        failNext = false;
        throw new Error("sleep failed");
      }
      c.sleeps.push(ms);
      c.t += ms;
    },
  });
  // Force the first acquire() to sleep so the injected failure is exercised.
  gov.noteRateLimited(1000);
  failNext = true;
  await assert.rejects(gov.acquire(), /sleep failed/);
  // A later caller still proceeds because the promise tail was released.
  await gov.acquire();
  assert.ok(c.t >= 1000, "a later caller was not stuck behind the rejecting one");
});

test("RequestGovernor: a 429 that lands mid-wait extends an already-waiting caller", async () => {
  const c = fakeClock();
  let extend = true;
  const gov = new RequestGovernor({
    now: c.now,
    sleep: async (ms) => {
      c.sleeps.push(ms);
      if (extend) {
        extend = false;
        gov.noteRateLimited(2000); // another client was rate-limited while we slept
      }
      c.t += ms;
    },
  });
  gov.noteRateLimited(1000);
  let grantedAt = null;
  await gov.acquire().then(() => {
    grantedAt = c.t;
  });
  assert.equal(grantedAt, 2000, "the waiter re-checked the extended pause after sleeping");
  assert.ok(c.sleeps.reduce((a, b) => a + b, 0) >= 2000);
});

test("RequestGovernor: noteSuccess resets the streak but keeps an open pause", async () => {
  const c = fakeClock();
  const gov = new RequestGovernor({ now: c.now, sleep: c.sleep });
  gov.noteRateLimited(1000);
  gov.noteRateLimited(1000);
  assert.equal(gov.getState().streak, 2);
  const pauseUntil = gov.getState().pauseUntil;
  gov.noteSuccess();
  assert.equal(gov.getState().streak, 0);
  assert.equal(gov.getState().pauseUntil, pauseUntil, "success must not shorten the time-based window");
});

test("parseRetryAfterHeader: numeric seconds, HTTP-date, caps and invalid input", () => {
  const now = 1_000_000;
  assert.equal(parseRetryAfterHeader("2", now), 2000);
  assert.equal(parseRetryAfterHeader("  3  ", now), 3000);
  // HTTP-dates carry whole seconds only, so use a whole-second delta.
  assert.equal(parseRetryAfterHeader(new Date(now + 2000).toUTCString(), now), 2000);
  assert.equal(parseRetryAfterHeader(new Date(now - 5000).toUTCString(), now), 0, "past date clamps to 0");
  assert.equal(parseRetryAfterHeader("999", now), RETRY_AFTER_CAP_MS, "capped");
  assert.equal(parseRetryAfterHeader(null, now), null);
  assert.equal(parseRetryAfterHeader("", now), null);
  assert.equal(parseRetryAfterHeader("garbage", now), null);
  assert.equal(parseRetryAfterHeader("-5", now), 0);
});

test("parseRetryAfterHeader/zero pause falls back to breaker backoff; pause is capped", () => {
  const c = fakeClock();
  const gov = new RequestGovernor({ now: c.now, sleep: c.sleep });
  // A past HTTP-date parses to 0 — noteRateLimited must still open a real pause.
  gov.noteRateLimited(parseRetryAfterHeader(new Date(-5000).toUTCString(), 0));
  assert.equal(gov.getState().pauseUntil, BREAKER_BASE_MS);

  const gov2 = new RequestGovernor({ now: () => 0, sleep: async () => {} });
  for (let i = 0; i < 20; i++) gov2.noteRateLimited(null);
  assert.equal(gov2.getState().pauseUntil, BREAKER_MAX_MS);
});

// --- client helpers ---------------------------------------------------------

function makeClient(c) {
  const gov = new RequestGovernor({ now: c.now, sleep: c.sleep });
  const client = new BitbucketClient({ baseUrl: "https://bb.example.com", token: "t", governor: gov });
  return { gov, client };
}

function response({ status = 200, body = "", headers = {}, arrayBuffer, text } = {}) {
  const textBody = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: text ?? (async () => textBody),
    arrayBuffer: async () =>
      typeof arrayBuffer === "function" ? arrayBuffer() : arrayBuffer ?? Buffer.from(textBody),
    headers: { get: (k) => headers[k.toLowerCase()] ?? headers[k] ?? null },
  };
}

/** Replace globalThis.fetch with a call-count-driven Response sequence. */
function stubFetch(responses, now = () => Date.now()) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const n = calls.length;
    calls.push({ n, at: now(), url: String(url), init, signal: init?.signal });
    const spec = typeof responses === "function" ? responses(n) : responses[n] ?? responses[responses.length - 1];
    return typeof spec === "function" ? spec() : spec;
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const COMMENT_REF = { projectKey: "ACME", repoSlug: "app", prId: 42 };

// --- client tests -----------------------------------------------------------

test("request(): paces consecutive GETs at >= MIN_SPACING_MS", async () => {
  const c = fakeClock();
  const { client } = makeClient(c);
  const stub = stubFetch(() => response({ body: { ok: 1 } }), c.now);
  try {
    for (let i = 0; i < 3; i++) await client.request(`/rest/x/${i}`);
    assert.equal(stub.calls.length, 3);
    for (let i = 1; i < stub.calls.length; i++) {
      assert.ok(
        stub.calls[i].at - stub.calls[i - 1].at >= MIN_SPACING_MS,
        `GET ${i} started ${stub.calls[i].at - stub.calls[i - 1].at}ms after GET ${i - 1}`,
      );
    }
  } finally {
    stub.restore();
  }
});

test("request(): a 429 with Retry-After pauses a second, independently constructed client", async () => {
  const c = fakeClock();
  const gov = new RequestGovernor({ now: c.now, sleep: c.sleep });
  const a = new BitbucketClient({ baseUrl: "https://bb.example.com", token: "t", governor: gov });
  const b = new BitbucketClient({ baseUrl: "https://bb.example.com", token: "t", governor: gov });
  const stub = stubFetch([
    response({ status: 429, body: "rate limited", headers: { "retry-after": "2" } }),
    response({ body: { ok: true } }),
  ], c.now);
  try {
    await assert.rejects(
      a.postPullRequestComment({ ...COMMENT_REF, text: "hi" }),
      /HTTP 429/,
    );
    assert.equal(gov.getState().pauseUntil, 2000, "the 429 opened the shared breaker");
    await b.request("/rest/after");
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[1].at, 2000, "the second client waited out the shared pause");
  } finally {
    stub.restore();
  }
});

test("request(): 429 without Retry-After uses exponential breaker backoff and succeeds on retry", async () => {
  const c = fakeClock();
  const { client, gov } = makeClient(c);
  const stub = stubFetch([
    response({ status: 429, body: "rate limit" }),
    response({ body: { ok: true } }),
  ], c.now);
  try {
    assert.deepEqual(await client.request("/rest/x"), { ok: true });
    assert.equal(stub.calls.length, 2);
    assert.equal(gov.getState().streak, 0, "a success resets the streak");
  } finally {
    stub.restore();
  }
});

test("request(): 500 -> 500 -> 200 succeeds after two bounded retries", async () => {
  const c = fakeClock();
  const { client } = makeClient(c);
  const boom = { errors: [{ message: "boom" }] };
  const stub = stubFetch([
    response({ status: 500, body: boom }),
    response({ status: 500, body: boom }),
    response({ body: { ok: true } }),
  ], c.now);
  try {
    assert.deepEqual(await client.request("/rest/x"), { ok: true });
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test("request(): persistent 500 throws after BITBUCKET_MAX_ATTEMPTS with status/body preserved", async () => {
  const c = fakeClock();
  const { client } = makeClient(c);
  const raw = JSON.stringify({ errors: [{ message: "server exploded" }] });
  const stub = stubFetch(() => response({ status: 500, body: raw }), c.now);
  try {
    await assert.rejects(client.request("/rest/x"), (err) => {
      assert.equal(err.status, 500);
      assert.equal(err.body, raw, "err.body stays the raw text");
      assert.match(err.message, /server exploded/);
      assert.doesNotMatch(err.message, /<!doctype|<html/i);
      return true;
    });
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test("request(): an HTML 429 body is trimmed to its <title> text", async () => {
  const c = fakeClock();
  const { client } = makeClient(c);
  const html = "<!doctype html><html><head><title>Rate limit exceeded &amp; slowed</title></head><body>big</body></html>";
  const stub = stubFetch(
    () => response({ status: 429, body: html, headers: { "content-type": "text/html; charset=utf-8" } }),
    c.now,
  );
  try {
    await assert.rejects(client.request("/rest/x"), (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.body, html, "raw HTML still preserved on err.body");
      assert.match(err.message, /Rate limit exceeded & slowed/);
      assert.doesNotMatch(err.message, /<!doctype|<html/i, "raw HTML must never reach the logged message");
      return true;
    });
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test("request(): a numeric Retry-After delays the retry by that many seconds", async () => {
  const c = fakeClock();
  const { client } = makeClient(c);
  const stub = stubFetch([
    response({ status: 429, body: "slow down", headers: { "retry-after": "1" } }),
    response({ body: { ok: true } }),
  ], c.now);
  try {
    await client.request("/rest/x");
    assert.equal(stub.calls[1].at - stub.calls[0].at, 1000, "waited once via the breaker, not twice");
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test("request(): a POST comment is never retried on 429/5xx but a 429 still opens the breaker", async () => {
  const c = fakeClock();
  const gov = new RequestGovernor({ now: c.now, sleep: c.sleep });
  const a = new BitbucketClient({ baseUrl: "https://bb.example.com", token: "t", governor: gov });
  const b = new BitbucketClient({ baseUrl: "https://bb.example.com", token: "t", governor: gov });
  const stub = stubFetch([
    response({ status: 429, body: "Rate limit", headers: { "retry-after": "2", "content-type": "text/html" } }),
    response({ body: { id: 9 } }),
  ], c.now);
  try {
    await assert.rejects(a.postPullRequestComment({ ...COMMENT_REF, text: "hi" }), /HTTP 429/);
    assert.equal(stub.calls.length, 1, "a write is issued exactly once");
    assert.ok(gov.getState().pauseUntil > 0);
    await b.request("/rest/after");
    assert.equal(stub.calls[1].at, 2000, "the POST 429 paused other clients");
  } finally {
    stub.restore();
  }

  const c2 = fakeClock();
  const { client: a2 } = makeClient(c2);
  const stub2 = stubFetch([response({ status: 500, body: "boom" }), response({ body: {} })], c2.now);
  try {
    await assert.rejects(a2.postPullRequestComment({ ...COMMENT_REF, text: "hi" }), /HTTP 500/);
    assert.equal(stub2.calls.length, 1, "a 5xx write is also issued exactly once");
  } finally {
    stub2.restore();
  }
});

test("request(): a non-transient 404 is not retried and keeps err.status/err.body", async () => {
  const c = fakeClock();
  const { client } = makeClient(c);
  const raw = JSON.stringify({ errors: [{ message: "PR missing" }] });
  const stub = stubFetch(() => response({ status: 404, body: raw }), c.now);
  try {
    await assert.rejects(client.request("/rest/x"), (err) => {
      assert.equal(err.status, 404);
      assert.equal(err.body, raw);
      assert.match(err.message, /PR missing/);
      return true;
    });
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("request(): retries a safe GET when res.text() rejects once, then succeeds", async () => {
  const c = fakeClock();
  const { client } = makeClient(c);
  const stub = stubFetch(
    [
      response({ status: 500, text: async () => { throw new Error("stream reset"); } }),
      response({ body: { ok: true } }),
    ],
    c.now,
  );
  try {
    assert.deepEqual(await client.request("/rest/x"), { ok: true });
    assert.equal(stub.calls.length, 2, "a transient body-read failure is retried, not escaped");
    assert.ok(c.sleeps.length >= 1, "the 5xx retry used local backoff");
  } finally {
    stub.restore();
  }
});

test("request(): a 429 with an unreadable body still opens the shared breaker", async () => {
  const c = fakeClock();
  const gov = new RequestGovernor({ now: c.now, sleep: c.sleep });
  const a = new BitbucketClient({ baseUrl: "https://bb.example.com", token: "t", governor: gov });
  const b = new BitbucketClient({ baseUrl: "https://bb.example.com", token: "t", governor: gov });
  const stub = stubFetch(
    [
      response({ status: 429, headers: { "retry-after": "2" }, text: async () => { throw new Error("stream reset"); } }),
      response({ body: { ok: true } }),
    ],
    c.now,
  );
  try {
    await assert.rejects(
      a.postPullRequestComment({ ...COMMENT_REF, text: "hi" }),
      (err) => {
        assert.equal(err.status, 429);
        assert.equal(err.body, "", "an unreadable body is preserved best-effort as empty");
        return true;
      },
    );
    assert.equal(stub.calls.length, 1, "a write is issued once even when the 429 body cannot be read");
    assert.equal(gov.getState().pauseUntil, 2000, "an unreadable 429 still opened the shared breaker");
    await b.request("/rest/after");
    assert.equal(stub.calls[1].at, 2000, "the second client waited out the shared pause");
  } finally {
    stub.restore();
  }
});

test("getAllPages(): every page is paced and a transient 429 on page 2 is retried without losing page 1", async () => {
  const c = fakeClock();
  const { client } = makeClient(c);
  const page = (values, nextStart) => response({
    body: nextStart === null
      ? { values, isLastPage: true }
      : { values, isLastPage: false, nextPageStart: nextStart },
  });
  const stub = stubFetch([
    page([{ id: 1 }, { id: 2 }], 2),
    response({ status: 429, body: "slow", headers: { "retry-after": "1" } }),
    page([{ id: 3 }, { id: 4 }], 4),
    page([{ id: 5 }], null),
  ], c.now);
  try {
    const values = await client.getAllPages("/rest/x", { limit: 100 });
    assert.deepEqual(values.map((v) => v.id), [1, 2, 3, 4, 5]);
    assert.equal(stub.calls.length, 4);
    for (let i = 1; i < stub.calls.length; i++) {
      assert.ok(stub.calls[i].at - stub.calls[i - 1].at >= MIN_SPACING_MS);
    }
    assert.ok(stub.calls[2].at - stub.calls[1].at >= 1000, "page 2 retry waited out the 429 window");
  } finally {
    stub.restore();
  }
});

test("fetchBuffer(): is paced, breaker-aware, retries with a fresh abort signal, and keeps the error shape", async () => {
  const c = fakeClock();
  const { client } = makeClient(c);
  const bytes = Buffer.from([1, 2, 3]);
  const stub = stubFetch([
    response({ status: 429, body: "slow", headers: { "retry-after": "1" }, arrayBuffer: Buffer.from("rate") }),
    response({ body: "", headers: { "content-type": "image/png" }, arrayBuffer: bytes }),
  ], c.now);
  try {
    const out = await client.fetchBuffer("/rest/img");
    assert.deepEqual(out.bytes, bytes);
    assert.equal(out.contentType, "image/png");
    assert.equal(stub.calls.length, 2);
    assert.notEqual(stub.calls[0].signal, stub.calls[1].signal, "a fresh AbortController per attempt");
    assert.equal(stub.calls[1].signal.aborted, false);
  } finally {
    stub.restore();
  }

  const c2 = fakeClock();
  const { client: client2 } = makeClient(c2);
  const html = "<!doctype html><title>Busy</title>";
  const stub2 = stubFetch(
    () => response({ status: 429, body: html, headers: { "content-type": "text/html" }, arrayBuffer: Buffer.from(html) }),
    c2.now,
  );
  try {
    await assert.rejects(client2.fetchBuffer("/rest/img"), (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.body, Buffer.from(html).subarray(0, 200).toString());
      assert.match(err.message, /Busy/);
      assert.doesNotMatch(err.message, /<!doctype/);
      return true;
    });
    assert.equal(stub2.calls.length, 3);
  } finally {
    stub2.restore();
  }
});

test("fetchBuffer(): retries when res.arrayBuffer() rejects once, then succeeds", async () => {
  const c = fakeClock();
  const { client } = makeClient(c);
  const bytes = Buffer.from([1, 2, 3]);
  const stub = stubFetch(
    [
      response({ status: 500, arrayBuffer: async () => { throw new Error("stream reset"); } }),
      response({ headers: { "content-type": "image/png" }, arrayBuffer: bytes }),
    ],
    c.now,
  );
  try {
    const out = await client.fetchBuffer("/rest/img");
    assert.deepEqual(out.bytes, bytes);
    assert.equal(out.contentType, "image/png");
    assert.equal(stub.calls.length, 2, "a transient body-read failure is retried");
    assert.notEqual(stub.calls[0].signal, stub.calls[1].signal, "a fresh AbortController per attempt");
    assert.ok(c.sleeps.length >= 1, "the 5xx retry used local backoff");
  } finally {
    stub.restore();
  }
});

test("fetchBuffer(): a 429 with an unreadable body opens the shared breaker and keeps status", async () => {
  const c = fakeClock();
  const gov = new RequestGovernor({ now: c.now, sleep: c.sleep });
  const client = new BitbucketClient({ baseUrl: "https://bb.example.com", token: "t", governor: gov });
  const stub = stubFetch(
    () => response({
      status: 429,
      headers: { "retry-after": "2" },
      arrayBuffer: async () => { throw new Error("stream reset"); },
    }),
    c.now,
  );
  try {
    await assert.rejects(client.fetchBuffer("/rest/img"), (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.body, "", "an unreadable body is preserved best-effort as empty");
      return true;
    });
    assert.equal(stub.calls.length, 3, "all attempts used, waiting via the breaker between each");
    assert.ok(gov.getState().pauseUntil > 0, "an unreadable 429 still opened the shared breaker");
  } finally {
    stub.restore();
  }
});

test("fetchBuffer(): a non-transient status with an unreadable body is not retried", async () => {
  const c = fakeClock();
  const { client } = makeClient(c);
  const stub = stubFetch(
    () => response({ status: 404, arrayBuffer: async () => { throw new Error("stream reset"); } }),
    c.now,
  );
  try {
    await assert.rejects(client.fetchBuffer("/rest/img"), (err) => {
      assert.equal(err.status, 404);
      assert.equal(err.body, "", "an unreadable body is preserved best-effort as empty");
      return true;
    });
    assert.equal(stub.calls.length, 1, "a non-transient status is never retried on a body-read failure");
  } finally {
    stub.restore();
  }
});

test("fetchBuffer(): the abort deadline is armed after the governor wait, not before", async () => {
  const c = fakeClock();
  let releaseGate = null;
  const gate = new Promise((r) => (releaseGate = r));
  const gov = new RequestGovernor({ now: c.now, sleep: c.sleep });
  const realAcquire = gov.acquire.bind(gov);
  // Hold the request in the governor queue so we can observe timer arming.
  gov.acquire = async () => {
    await realAcquire();
    await gate;
  };
  const client = new BitbucketClient({ baseUrl: "https://bb.example.com", token: "t", governor: gov });

  // Capture only fetchBuffer's abort timer (distinct delay), forwarding all
  // other timers to the real implementation. No real time needs to elapse.
  const TIMEOUT = 12345;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const armed = new Map();
  globalThis.setTimeout = (fn, ms) => {
    if (ms === TIMEOUT) {
      const id = Symbol("abort-timer");
      armed.set(id, fn);
      return id;
    }
    return realSetTimeout(fn, ms);
  };
  globalThis.clearTimeout = (id) => {
    if (armed.has(id)) {
      armed.delete(id);
      return;
    }
    return realClearTimeout(id);
  };
  const stub = stubFetch([
    response({ body: "", headers: { "content-type": "image/png" }, arrayBuffer: Buffer.from([1]) }),
  ], c.now);
  let pending;
  try {
    pending = client.fetchBuffer("/rest/img", { timeoutMs: TIMEOUT });
    await new Promise((r) => setImmediate(r)); // let it reach the held acquire()
    assert.equal(stub.calls.length, 0, "no fetch while still queued in the governor");
    assert.equal(
      armed.size,
      0,
      "the abort timer must not be armed before the governor grants the request",
    );

    // Simulate the whole timeout elapsing while the request sat in the queue.
    // With the timer armed late there is nothing to fire yet.
    for (const fn of [...armed.values()]) fn();
    releaseGate();
    const out = await pending;
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].signal.aborted, false, "the issued fetch is not pre-aborted");
    assert.deepEqual(out.bytes, Buffer.from([1]));
  } finally {
    releaseGate?.();
    if (pending) await pending.catch(() => {});
    stub.restore();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

// --- request() deadline (issue #6 class: a dead proxy must never wedge a
// review in a "running" stage forever) ---------------------------------------

/** fetch that never resolves until its AbortSignal fires (a dead-proxy hang). */
function hangingFetch() {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new Promise((_resolve, reject) => {
      calls.push({ url: String(url), init });
      init?.signal?.addEventListener("abort", () => {
        const e = new Error("The operation was aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test("request(): a never-answering response is aborted after the deadline; safe GETs retry then surface a clear timeout", async () => {
  const c = fakeClock();
  const gov = new RequestGovernor({ now: c.now, sleep: c.sleep });
  const client = new BitbucketClient({ baseUrl: "https://bb.example.com", token: "t", governor: gov, requestTimeoutMs: 40 });
  const stub = hangingFetch();
  try {
    await assert.rejects(client.request("/rest/x"), (err) => {
      assert.match(err.message, /Bitbucket GET \/rest\/x timed out after 40ms/);
      assert.equal(err.timedOut, true);
      return true;
    });
    assert.equal(stub.calls.length, 3, "a safe GET is retried across attempts, never wedging the caller");
    for (const call of stub.calls) assert.equal(call.init.signal.aborted, true, "each attempt is aborted by the deadline");
  } finally {
    stub.restore();
  }
});

test("request(): a write (comment POST) whose response never arrives times out once and is never re-sent", async () => {
  const c = fakeClock();
  const gov = new RequestGovernor({ now: c.now, sleep: c.sleep });
  const client = new BitbucketClient({ baseUrl: "https://bb.example.com", token: "t", governor: gov, requestTimeoutMs: 40 });
  const stub = hangingFetch();
  try {
    await assert.rejects(client.postPullRequestComment({ ...COMMENT_REF, text: "hi" }), (err) => {
      assert.match(err.message, /POST .*\/comments timed out after 40ms/);
      assert.equal(err.timedOut, true);
      return true;
    });
    assert.equal(stub.calls.length, 1, "a lost write is never blindly re-sent (no duplicate comment)");
  } finally {
    stub.restore();
  }
});

test("request(): the abort deadline is armed after the governor wait, not before", async () => {
  const c = fakeClock();
  let releaseGate = null;
  const gate = new Promise((r) => (releaseGate = r));
  const gov = new RequestGovernor({ now: c.now, sleep: c.sleep });
  const realAcquire = gov.acquire.bind(gov);
  // Hold the request in the governor queue so we can observe timer arming.
  gov.acquire = async () => {
    await realAcquire();
    await gate;
  };
  const TIMEOUT = 12345;
  const client = new BitbucketClient({ baseUrl: "https://bb.example.com", token: "t", governor: gov, requestTimeoutMs: TIMEOUT });

  // Capture only request()'s abort timer (distinct delay), forwarding all
  // other timers to the real implementation. No real time needs to elapse.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const armed = new Map();
  globalThis.setTimeout = (fn, ms) => {
    if (ms === TIMEOUT) {
      const id = Symbol("abort-timer");
      armed.set(id, fn);
      return id;
    }
    return realSetTimeout(fn, ms);
  };
  globalThis.clearTimeout = (id) => {
    if (armed.has(id)) {
      armed.delete(id);
      return;
    }
    return realClearTimeout(id);
  };
  const stub = stubFetch(() => response({ body: { ok: 1 } }), c.now);
  let pending;
  try {
    pending = client.request("/rest/x");
    await new Promise((r) => setImmediate(r)); // let it reach the held acquire()
    assert.equal(stub.calls.length, 0, "no fetch while still queued in the governor");
    assert.equal(
      armed.size,
      0,
      "the abort timer must not be armed before the governor grants the request",
    );

    // Simulate the whole timeout elapsing while the request sat in the queue.
    // With the timer armed late there is nothing to fire yet.
    for (const fn of [...armed.values()]) fn();
    releaseGate();
    assert.deepEqual(await pending, { ok: 1 });
    assert.equal(stub.calls[0].signal.aborted, false, "the issued fetch is not pre-aborted");
  } finally {
    releaseGate?.();
    if (pending) await pending.catch(() => {});
    stub.restore();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("request(): a fast response is returned with an un-aborted signal (deadline cleared)", async () => {
  const c = fakeClock();
  const { client } = makeClient(c);
  const stub = stubFetch(() => response({ body: { ok: true } }), c.now);
  try {
    assert.deepEqual(await client.request("/rest/x"), { ok: true });
    assert.equal(stub.calls[0].signal.aborted, false, "a fast response is never aborted");
  } finally {
    stub.restore();
  }
});

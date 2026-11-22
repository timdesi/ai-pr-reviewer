// HTTP-level tests for the GitHub webhook endpoint security gates in
// server.js: the empty-secret guard (403), the unsigned ping short-circuit
// (200), signature rejection (401), and a valid signature (200). These sit
// *in front of* parseGitHubWebhookRequest, so the unit tests cannot cover
// them — a regression here would open an unauthenticated review trigger.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createServer } from "../src/server.js";

const API = "https://api.github.com";
const SECRET = "s3cret";

const GH = {
  baseUrl: API,
  token: "t",
  username: "",
  webhookSecret: SECRET,
};

function baseConfig(overrides = {}) {
  return {
    projectRoot: process.cwd(),
    server: { host: "127.0.0.1", port: 0 },
    costs: {},
    models: {},
    review: { fetchPrDiscussion: false, visionModel: null },
    job: {
      dryRun: true,
      publishToGithub: false,
      allowedReviewerUsers: [],
      githubAutoReviewOffRepos: new Set(),
      reviewOnReviewerAddedSkip: [],
    },
    dirs: { jobs: mkdtempSync(path.join(tmpdir(), "gh-webhook-")) },
    github: { ...GH },
    // Bitbucket left unconfigured: assertAnyBackendConfig passes via github.
    ...overrides,
  };
}

const hmac = (raw) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

/** Boot an ephemeral server for one test; runs `fn(port)` and closes it. */
async function withServer({ config, reviewRunner }, fn) {
  const { server } = createServer({ config, runReview: reviewRunner });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const pingBody = JSON.stringify({ zen: "…", hook_id: 1 });
const benignBody = JSON.stringify({
  action: "closed",
  sender: { login: "alice" },
  repository: { name: "widgets", full_name: "acme/widgets", owner: { login: "acme" } },
  pull_request: { number: 42 },
});

test("an empty GITHUB_WEBHOOK_SECRET disables the endpoint (403, fail closed)", async () => {
  const config = baseConfig({ github: { ...GH, webhookSecret: "" } });
  await withServer({ config }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: { "x-github-event": "ping", "content-type": "application/json" },
      body: pingBody,
    });
    assert.equal(res.status, 403);
  });
});

test("unsigned ping is acknowledged without a signature (200)", async () => {
  await withServer({ config: baseConfig() }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: { "x-github-event": "ping", "content-type": "application/json" },
      body: pingBody,
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ignored, "ping");
  });
});

test("a non-ping delivery without a signature is rejected (401)", async () => {
  await withServer({ config: baseConfig() }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: { "x-github-event": "pull_request", "content-type": "application/json" },
      body: benignBody,
    });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /missing X-Hub-Signature/i);
  });
});

test("a wrong signature is rejected (401)", async () => {
  await withServer({ config: baseConfig() }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": hmac(pingBody).replace(/^sha256/, "sha256x"), // not the body's hash
        "content-type": "application/json",
      },
      body: benignBody,
    });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /signature mismatch/i);
  });
});

test("a valid signature on a non-trigger event is accepted (200) and ignored", async () => {
  await withServer({ config: baseConfig() }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": hmac(benignBody),
        "content-type": "application/json",
      },
      body: benignBody,
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.match(j.ignored || "", /closed|not a review trigger/i);
  });
});

// A signed, triggering /ai-review delivery must enqueue — and the enqueued
// review's publish flag must follow the GitHub gate (not the Bitbucket one).
// An injectable reviewRunner keeps this a unit test (no real agents/network).
const triggerHeaders = (body) => ({
  "x-github-event": "issue_comment",
  "x-hub-signature-256": hmac(body),
  "content-type": "application/json",
});

const triggerBody = JSON.stringify({
  action: "created",
  sender: { login: "alice" },
  repository: { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
  issue: { number: 42, pull_request: { url: "x", html_url: "y" } },
  comment: { id: 1234, body: "/ai-review", user: { login: "alice" } },
});

test("a signed /ai-review trigger enqueues a review (publish off by default)", async () => {
  const records = [];
  const reviewRunner = async ({ ref, options }) => records.push({ ref, publish: options.publish });
  const config = baseConfig({ job: { ...baseConfig().job, allowedReviewerUsers: ["alice"] } });
  await withServer({ config, reviewRunner }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: triggerHeaders(triggerBody),
      body: triggerBody,
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.accepted, true);
    assert.equal(j.queued, true);
    assert.equal(j.duplicate, false);
    // The fake runner is invoked synchronously inside enqueue → startNext, so
    // by response time the record exists and carries the platform publish gate.
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].ref, { projectKey: "acme", repoSlug: "widgets", prId: 42, platform: "github" });
    assert.equal(records[0].publish, false, "PUBLISH_TO_GITHUB off → not published");
  });
});

test("a duplicate concurrent /ai-review trigger is deduplicated (duplicate:true)", async () => {
  const records = [];
  const reviewRunner = async ({ options }) => records.push({ publish: options.publish });
  const config = baseConfig({ job: { ...baseConfig().job, allowedReviewerUsers: ["alice"] } });
  await withServer({ config, reviewRunner }, async (port) => {
    const url = `http://127.0.0.1:${port}/webhooks/github`;
    const first = await fetch(url, { method: "POST", headers: triggerHeaders(triggerBody), body: triggerBody });
    const firstJ = await first.json();
    const second = await fetch(url, { method: "POST", headers: triggerHeaders(triggerBody), body: triggerBody });
    const secondJ = await second.json();
    assert.equal(firstJ.queued, true);
    assert.equal(secondJ.duplicate, true, "same-head / same ref while running must be dropped");
    assert.equal(records.length, 1, "runner must not start twice");
  });
});

test("PUBLISH_TO_GITHUB=1 makes the posted review publish:true", async () => {
  const records = [];
  const reviewRunner = async ({ options }) => records.push({ publish: options.publish });
  const config = baseConfig({
    job: { ...baseConfig().job, allowedReviewerUsers: ["alice"], publishToGithub: true },
  });
  await withServer({ config, reviewRunner }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: triggerHeaders(triggerBody),
      body: triggerBody,
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.queued, true);
    assert.equal(records[0].publish, true, "PUBLISH_TO_GITHUB=1 → publish on");
  });
});

test("static UI app.js injects ui.modelOverrides over the __MODEL_OVERRIDES__ marker", async () => {
  const overrides = { "acme-gpt/gpt-6-luna": "GPT-6 Luna", "acme-openai/deepseek-v4-pro": "DeepSeek V4 Pro" };
  const config = baseConfig({ ui: { modelOverrides: overrides } });
  await withServer({ config }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/javascript/);
    const js = await res.text();
    assert.ok(!js.includes("__MODEL_OVERRIDES__"), "marker must be substituted away");
    assert.ok(js.includes('"acme-gpt/gpt-6-luna":"GPT-6 Luna"'), "override injected verbatim");
    // Served file must still be a single valid assignment: marker + fallback {} are
    // both replaced, leaving exactly one object literal.
    assert.match(js, /const MODEL_OVERRIDES = \{"acme-gpt\/gpt-6-luna":"GPT-6 Luna","acme-openai\/deepseek-v4-pro":"DeepSeek V4 Pro"\};/);
  });
});

test("static UI app.js serves the raw empty object when no modelOverrides configured", async () => {
  const config = baseConfig(); // no ui.modelOverrides
  await withServer({ config }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(res.status, 200);
    const js = await res.text();
    assert.match(js, /const MODEL_OVERRIDES = \{\};/, "empty overrides → empty object, file still valid");
  });
});

test("static UI app.js: display names with $ sequences are injected verbatim, not interpreted", async () => {
  // A `$` in a display name must not be treated as a $&/$1 replacement token
  // by String.replace — the substituted dashboard would corrupt otherwise (AI
  // review #18 minor). Use a replacer function and assert byte-fidelity.
  const overrides = { "acme-gpt/gpt-6-luna": "GPT $LUNA & $& $1" };
  const config = baseConfig({ ui: { modelOverrides: overrides } });
  await withServer({ config }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(res.status, 200);
    const js = await res.text();
    assert.ok(js.includes('"acme-gpt/gpt-6-luna":"GPT $LUNA & $& $1"'), `dollar sequences survive: ${js.match(/const MODEL_OVERRIDES = [^;]+/)?.[0] ?? "no match"}`);
    // And the served declaration must still parse as valid JS with the value intact.
    const seg = js.slice(js.indexOf("const MODEL_OVERRIDES"), js.indexOf("function friendlyModel", js.indexOf("const MODEL_OVERRIDES")));
    const val = new Function(`${seg}\nreturn JSON.stringify(MODEL_OVERRIDES);`)();
    assert.equal(JSON.parse(val)["acme-gpt/gpt-6-luna"], "GPT $LUNA & $& $1");
  });
});

// ESM imports cannot be spied, so the only honest proof that server.js calls
// clearPullCacheEntry(next.ref) (not a global flush) is end-to-end: two PRs
// cached via /api/pulls?live=1, one review completion emitted, then a second
// poll that must refetch only the completed PR.
test("review completion invalidates only the completed PR's pull cache", async () => {
  const refCounts = new Map();
  const bb = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    refCounts.set(p, (refCounts.get(p) || 0) + 1);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (p.endsWith("/commits")) {
      res.end(JSON.stringify({ values: [{ id: "newsha", message: "m", committerTimestamp: 1 }], isLastPage: true }));
    } else {
      res.end(
        JSON.stringify({
          state: "OPEN",
          fromRef: { latestCommit: "newsha", displayId: "feature" },
          toRef: { displayId: "master" },
          author: { displayName: "Ada" },
        }),
      );
    }
  });
  await new Promise((r) => bb.listen(0, "127.0.0.1", r));
  try {
    const baseUrl = `http://127.0.0.1:${bb.address().port}`;
    const jobsDir = mkdtempSync(path.join(tmpdir(), "pull-invalidate-"));
    const refs = [
      { projectKey: "ACME", repoSlug: "acme-app", prId: 5720, platform: "bitbucket" },
      { projectKey: "ACME", repoSlug: "acme-app", prId: 5721, platform: "bitbucket" },
    ];
    for (const ref of refs) {
      const dir = path.join(jobsDir, `job-${ref.prId}`);
      mkdirSync(dir, { recursive: true });
      const meta = { ref, reviewedSha: "oldsha", startedAt: "2026-10-20T09:00:00.000Z", title: `PR #${ref.prId}` };
      writeFileSync(path.join(dir, "job-meta.json"), JSON.stringify(meta));
      writeFileSync(path.join(dir, "status.json"), JSON.stringify({ job: `job-${ref.prId}`, ...meta, stage: "complete" }));
    }
    const config = baseConfig({ dirs: { jobs: jobsDir }, bitbucket: { baseUrl, token: "t", username: "" } });
    let emit = null;
    const reviewRunner = async ({ options }) => {
      emit = options.emit;
    };
    const aPath = "/rest/api/1.0/projects/ACME/repos/acme-app/pull-requests/5720";
    const bPath = "/rest/api/1.0/projects/ACME/repos/acme-app/pull-requests/5721";

    await withServer({ config, reviewRunner }, async (port) => {
      const root = `http://127.0.0.1:${port}`;
      const startRes = await fetch(`${root}/api/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pr: "ACME/acme-app#5720" }),
      });
      assert.equal(startRes.status, 202, "review start must be accepted");
      assert.ok(emit, "fake runner captured the completion emitter");

      const first = await fetch(`${root}/api/pulls?live=1`).then((r) => r.json());
      assert.equal(first.live, true);
      assert.equal(first.pulls.length, 2);
      const aBefore = refCounts.get(aPath) || 0;
      const bBefore = refCounts.get(bPath) || 0;

      emit({ type: "complete", job: "job-5720" }); // "complete", not "completed"

      await fetch(`${root}/api/pulls?live=1`);
      assert.equal(refCounts.get(aPath) || 0, aBefore + 1, "only PR A was refetched after its review completed");
      assert.equal(refCounts.get(bPath) || 0, bBefore, "PR B stayed cached");
    });
  } finally {
    await new Promise((r) => bb.close(r));
  }
});


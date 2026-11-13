import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJsonl, acquireStandaloneBootSlot } from "../src/opencode.js";

const evt = (obj) => JSON.stringify(obj);

test("parseJsonl accumulates usage from top-level tokens", () => {
  const stdout = [
    evt({ type: "step_finish", sessionID: "s1", tokens: { input: 100, output: 10, cache: { read: 5, write: 0 } } }),
    evt({ type: "step_finish", sessionID: "s1", tokens: { input: 50, output: 2, cache: { read: 100, write: 0 } } }),
  ].join("\n");
  const { usage } = parseJsonl(stdout);
  assert.deepEqual(usage, { input: 150, output: 12, cacheRead: 105, cacheWrite: 0 });
});

test("parseJsonl reads tokens nested under part (step_finish) and step", () => {
  const stdout = [
    // shape seen on the pod: tokens inside `part`
    evt({ type: "step_finish", sessionID: "s2", part: { id: "p1", type: "step-finish", reason: "tool-calls", tokens: { input: 15103, output: 143, cache: { read: 0, write: 0 } } } }),
    evt({ type: "step_finish", sessionID: "s2", part: { id: "p2", type: "step-finish", reason: "tool-calls", tokens: { input: 491, output: 47, cache: { read: 14848, write: 0 } } } }),
    // nested under `step`
    evt({ type: "step", sessionID: "s2", step: { tokens: { input: 7, output: 3, cache: { read: 0, write: 2 } } } }),
    // no tokens at all
    evt({ type: "text", sessionID: "s2", part: { type: "text", text: "hello" } }),
  ].join("\n");
  const { usage, text } = parseJsonl(stdout);
  assert.equal(text, "hello");
  assert.deepEqual(usage, { input: 15103 + 491 + 7, output: 143 + 47 + 3, cacheRead: 0 + 14848 + 0, cacheWrite: 0 + 0 + 2 });
});

test("parseJsonl returns usage null when there is no token data", () => {
  const { usage } = parseJsonl(evt({ type: "text", part: { type: "text", text: "hi" } }));
  assert.equal(usage, null);
});

test("parseJsonl counts tool calls from step_finish (tool-calls) and tool parts", () => {
  const stdout = [
    evt({ type: "step_finish", sessionID: "s3", part: { id: "p1", type: "step-finish", reason: "tool-calls", tokens: { input: 10, output: 1 } } }),
    evt({ type: "step_finish", sessionID: "s3", part: { id: "p2", type: "step-finish", reason: "tool-calls", tokens: { input: 5, output: 1 } } }),
    evt({ type: "step_finish", sessionID: "s3", part: { id: "p3", type: "step-finish", reason: "text" } }),
    evt({ type: "step_finish", sessionID: "s3", part: { id: "p4", type: "tool", state: "completed" } }),
    evt({ type: "text", sessionID: "s3", part: { type: "text", text: "done" } }),
  ].join("\n");
  const { text, toolCalls } = parseJsonl(stdout);
  assert.equal(text, "done");
  assert.equal(toolCalls, 3); // two tool-calls step_finish + one bare tool part
});

test("parseJsonl counts zero tool calls on an empty or text-only stream", () => {
  assert.equal(parseJsonl("").toolCalls, 0);
  assert.equal(parseJsonl(evt({ type: "text", part: { type: "text", text: "hi" } })).toolCalls, 0);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("standalone boot slots serialize: one at a time, FIFO", async () => {
  const acquired = [];
  const releases = [];

  const mk = async (name) => {
    const release = await acquireStandaloneBootSlot();
    acquired.push(name);
    releases.push({ name, release });
  };

  const p1 = mk("a");
  const p2 = mk("b");
  const p3 = mk("c");

  // Let the acquisition chain settle: only "a" should hold the slot.
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(acquired, ["a"]);

  // Release a → b acquires; c still waits.
  releases[0].release();
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(acquired, ["a", "b"]);

  // Release b → c acquires.
  releases[1].release();
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(acquired, ["a", "b", "c"]);

  // Release c; the queue drains cleanly.
  releases[2].release();
  await Promise.all([p1, p2, p3]);
});

test("boot slot release is idempotent and the queue recovers", async () => {
  const rel = await acquireStandaloneBootSlot();
  rel();
  rel(); // second call must be a no-op
  const rel2 = await acquireStandaloneBootSlot();
  rel2();
  // Both acquisitions completed without deadlock.
  assert.ok(true);
});

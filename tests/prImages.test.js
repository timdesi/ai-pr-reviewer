import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractImageRefs, collectImageRefs, loadScreenshotBlock, sweepVisionScratch, transcribeViaAgent } from "../src/prImages.js";

const BOT = "mybot@example.com";
const baseConfig = {
  review: {
    fetchPrImages: true,
    visionModel: "llmgw-gpt/gpt-6-luna",
    visionMaxImages: 6,
    visionMaxImageBytes: 10 * 1024 * 1024,
    visionFetchTimeoutMs: 5000,
    visionCallTimeoutMs: 5000,
  },
  bitbucket: { baseUrl: "https://bb.example.com", username: BOT },
};
const ref = { projectKey: "P", repoSlug: "r", prId: 7 };

// Stubbed-runner config for transcribeViaAgent: carries the `opencode` group the
// default `runner = runAgent` reads (bin / agentDir / standalone).
const visionConfig = {
  ...baseConfig,
  opencode: { bin: "opencode", agentDir: "/x/.opencode", standalone: false },
};

// --- extractImageRefs --------------------------------------------------------

test("extractImageRefs: attachment / http(s) / data refs, alt captured, others skipped", () => {
  const desc = `- Verify no revision level\n![Screenshot 2026-11-11 at 11.51.33.png](attachment:40875/174916)\n![ui](https://img.example/1.png) \n![inline](data:image/png;base64,AAAA) \n[link](relative/path) ![audio](attachment:1/2.mp3)`;
  const refs = extractImageRefs(desc);
  assert.equal(refs.length, 3, "attachment + url + data only");
  assert.deepEqual(refs[0], { type: "attachment", attachmentId: "174916", alt: "Screenshot 2026-11-11 at 11.51.33.png" });
  assert.deepEqual(refs[1], { type: "url", url: "https://img.example/1.png", alt: "ui" });
  assert.deepEqual(refs[2], { type: "data", url: "data:image/png;base64,AAAA", alt: "inline" });
  assert.equal(extractImageRefs("no images here").length, 0);
  assert.equal(extractImageRefs("").length, 0);
});

test("collectImageRefs: dedupes, labels description vs comment, skips bot comments", () => {
  const description = "![a](attachment:1/100) ![b](attachment:1/101)";
  const comments = [
    { id: 1, text: "explained ![a2](attachment:1/100) ![c](attachment:1/102)", author: { displayName: "Dong", name: "DONG", slug: "dong" } },
    { id: 2, text: "![d](http://x/z.png)", author: { displayName: "MYBOT", name: "MYBOT", slug: "mybot" } }, // bot
  ];
  const items = collectImageRefs({ description, comments, botUsernames: [BOT] });
  // description (100,101) + comment by Dong (100 dup, 102) + bot comment skipped
  assert.deepEqual(items.map((i) => `${i.sourceLabel}:${i.ref.attachmentId || i.ref.url}`), [
    "description:100",
    "description:101",
    "comment by Dong:102",
  ]);
});

test("collectImageRefs: bot email matches its local part", () => {
  const comments = [
    { id: 1, text: "![x](attachment:1/9)", author: { slug: "mybot", name: "MYBOT" } },
    { id: 2, text: "![y](attachment:1/8)", author: { displayName: null } },
  ];
  const items = collectImageRefs({ description: "", comments, botUsernames: [BOT] });
  assert.equal(items.length, 1);
  assert.equal(items[0].ref.attachmentId, "8");
});

// --- loadScreenshotBlock -----------------------------------------------------

function actComment(id, text, author = "Dong") {
  return { id, action: "COMMENTED", comment: { id, text, author: { displayName: author }, createdDate: 1, comments: [] } };
}

test("loadScreenshotBlock: empty/disabled → ''", async () => {
  assert.equal((await loadScreenshotBlock({ client: null, config: baseConfig, ref })).block, "");
  assert.equal(
    (await loadScreenshotBlock({ client: { fetchBuffer: async () => ({}) }, config: { ...baseConfig, review: { ...baseConfig.review, fetchPrImages: false } }, ref, description: "![a](attachment:1/2)" })).block,
    "",
  );
  assert.equal(
    (await loadScreenshotBlock({ client: { fetchBuffer: async () => ({}) }, config: baseConfig, ref, description: "no images" })).block,
    "",
  );
  assert.deepEqual((await loadScreenshotBlock({ client: null, config: baseConfig, ref })), { block: "", usage: null, transcribed: 0, unreadable: 0, images: [] });
});

test("loadScreenshotBlock: transcriptions from description + comments, dedupes", async () => {
  const fetchBuffer = async (url) => {
    const m = url.match(/attachments\/(\d+)$/);
    return { bytes: Buffer.from(`img-${m?.[1] || "?"}`), contentType: "image/png" };
  };
  const client = { fetchBuffer };
  const activities = [
    actComment(1, "![Screenshot 2026-11-11 at 11.51.33.png](attachment:40875/174916)"),
    actComment(2, "![same again](attachment:40875/174916) more text"), // dup id
  ];
  const res = await loadScreenshotBlock({
    client,
    config: baseConfig,
    ref,
    description: "![desc shot](attachment:1/174917)",
    activities,
    transcribe: async () => "the ATP Check config screen",
  });
  const block = res.block;
  assert.ok(block.includes("## PR screenshots (transcribed)"));
  assert.match(block, /\*\*description\*\*/);
  assert.match(block, /_desc shot_/);
  assert.match(block, /\*\*comment by Dong\*\*/);
  assert.match(block, /_Screenshot 2026-11-11 at 11.51.33.png_/);
  assert.match(block, /the ATP Check config screen/);
  assert.ok(!block.includes("not be fetched/read"), "no unreadable note (both worked)");
  // description (1) + comment (1 deduped) = 2 entries
  assert.equal((block.match(/^\d+\. \*\*/gm) || []).length, 2);
  // A plain-string caption carries no usage -> usage stays null.
  assert.equal(res.transcribed, 2);
  assert.equal(res.unreadable, 0);
  assert.equal(res.usage, null);
  // Per-image records for the pipeline to persist as artifacts.
  assert.equal(res.images.length, 2, "one image record per picked image, including metadata");
  assert.equal(res.images[0].index, 1);
  assert.equal(res.images[0].sourceLabel, "description");
  assert.equal(res.images[0].alt, "desc shot");
  assert.equal(res.images[0].ok, true);
  assert.equal(res.images[0].text, "the ATP Check config screen");
  assert.equal(res.images[1].alt, "Screenshot 2026-11-11 at 11.51.33.png");
});

test("loadScreenshotBlock: failed fetch/transcript → 'not viewable' note, never throws", async () => {
  const client = {
    fetchBuffer: async () => {
      throw new Error("no permission");
    },
  };
  const res = await loadScreenshotBlock({
    client,
    config: baseConfig,
    ref,
    description: "![a](attachment:1/55)",
    activities: [],
    transcribe: async () => "never called",
  });
  assert.ok(res.block.includes("could not be fetched/read"));
  assert.ok(!res.block.includes("never called"));
  assert.equal(res.unreadable, 1);
});

test("loadScreenshotBlock: respects visionMaxImages cap", async () => {
  const fetchBuffer = async () => ({ bytes: Buffer.from("x"), contentType: "image/png" });
  const client = { fetchBuffer };
  const res = await loadScreenshotBlock({
    client,
    config: { ...baseConfig, review: { ...baseConfig.review, visionMaxImages: 2 } },
    ref,
    description: "![1](attachment:1/1) ![2](attachment:1/2) ![3](attachment:1/3)",
    activities: [],
    transcribe: async () => "ok",
  });
  assert.equal((res.block.match(/^\d+\. \*\*/gm) || []).length, 2, "capped at 2 transcriptions");
});

test("loadScreenshotBlock: accumulates transcription usage across images", async () => {
  const fetchBuffer = async () => ({ bytes: Buffer.from("x"), contentType: "image/png" });
  const client = { fetchBuffer };
  const res = await loadScreenshotBlock({
    client,
    config: baseConfig,
    ref,
    description: "![1](attachment:1/1) ![2](attachment:1/2)",
    activities: [],
    transcribe: async () => ({ text: "ok", usage: { input: 100, output: 50, cacheRead: 5, cacheWrite: 2 } }),
  });
  assert.equal(res.transcribed, 2);
  assert.deepEqual(res.usage, { input: 200, output: 100, cacheRead: 10, cacheWrite: 4 });
  assert.ok(res.block.includes("## PR screenshots (transcribed)"));
});

test("loadScreenshotBlock: records agent usage even when captions are unusable (cost preserved)", async () => {
  const fetchBuffer = async () => ({ bytes: Buffer.from("x"), contentType: "image/png" });
  const client = { fetchBuffer };
  const res = await loadScreenshotBlock({
    client,
    config: baseConfig,
    ref,
    description: "![1](attachment:1/1) ![2](attachment:1/2)",
    activities: [],
    transcribe: async () => ({ text: null, usage: { input: 120, output: 40, cacheRead: 5, cacheWrite: 2 } }),
  });
  assert.equal(res.transcribed, 0);
  assert.equal(res.unreadable, 2, "unusable captions count as unreadable");
  assert.deepEqual(res.usage, { input: 240, output: 80, cacheRead: 10, cacheWrite: 4 }, "failed runs' tokens still priced (Copilot #17 MEDIUM 2)");
  assert.ok(res.block.includes("could not be fetched/read"));
});

test("loadScreenshotBlock: oversized / non-image downloads are unreadable", async () => {
  const client = {
    fetchBuffer: async () => ({ bytes: Buffer.from("x".repeat(99999999)), contentType: "image/png" }), // over 10MB
  };
  const res = await loadScreenshotBlock({
    client,
    config: baseConfig,
    ref,
    description: "![big](attachment:1/9)",
    activities: [],
    transcribe: async () => "nope",
  });
  assert.ok(res.block.includes("could not be fetched/read"));
});

test("loadScreenshotBlock: empty visionModel skips the image step (empty block, no unreadable note)", async () => {
  const client = { fetchBuffer: async () => ({ bytes: Buffer.from("x"), contentType: "image/png" }) };
  const res = await loadScreenshotBlock({
    client,
    config: { ...baseConfig, review: { ...baseConfig.review, visionModel: "" } },
    ref,
    description: "![a](attachment:1/2)",
    activities: [],
  });
  assert.deepEqual(res, { block: "", usage: null, transcribed: 0, unreadable: 0, images: [] });
  assert.ok(!res.block.includes("could not be fetched/read"), "downloads never attempted, no degrade note");
});

// --- transcribeViaAgent ------------------------------------------------------

test("transcribeViaAgent: writes the image to a temp file and calls runAgent (--agent pr-vision / --model / --file / timeout)", async () => {
  let captured = null;
  const runner = async (arg) => {
    captured = arg;
    captured.written = readFileSync(arg.file); // bytes must be on disk before the call
    return { text: "the ATP Check config screen", usage: { input: 100, output: 40, cacheRead: 5, cacheWrite: 3 } };
  };
  const out = await transcribeViaAgent({
    config: visionConfig,
    model: "llmgw-gpt/gpt-6-luna",
    imageBytes: Buffer.from("png"),
    mimeType: "image/png",
    timeoutMs: 60000,
    runner,
  });
  assert.ok(captured, "runner called exactly once");
  assert.equal(captured.agent, "pr-vision");
  assert.equal(captured.model, "llmgw-gpt/gpt-6-luna");
  assert.equal(captured.bin, "opencode");
  assert.equal(captured.timeoutSeconds, 60);
  assert.equal(captured.standalone, false);
  assert.equal(captured.env.OPENCODE_CONFIG_DIR, "/x/.opencode");
  assert.equal(captured.file.endsWith(".png"), true, "mime-derived extension");
  assert.ok(path.dirname(captured.file).split(path.sep).pop().startsWith("pr-vision-"), "file under a pr-vision- temp dir");
  assert.equal(captured.cwd, path.dirname(captured.file), "cwd isolated to the screenshot temp dir (Copilot #17 HIGH)");
  assert.equal(Buffer.from(captured.written).toString(), "png", "image bytes written verbatim");
  assert.match(captured.message, /[Tt]ranscrib/);
  assert.deepEqual(out, { ok: true, text: "the ATP Check config screen", usage: { input: 100, output: 40, cacheRead: 5, cacheWrite: 3 }, stdout: "", stderr: "", error: null });
  assert.ok(!existsSync(path.dirname(captured.file)), "temp dir removed after success");
});

test("transcribeViaAgent: runner throw → resolved fail envelope + cleanup (never throws)", async () => {
  let captured = null;
  const runner = async (arg) => {
    captured = arg;
    throw new Error("boom");
  };
  const out = await transcribeViaAgent({ config: visionConfig, model: "m", imageBytes: Buffer.from("x"), runner });
  assert.equal(out.ok, false);
  assert.equal(out.text, null);
  assert.equal(out.error, "boom");
  assert.match(out.stderr, /boom/, "the exception stack/reason is surfaced, not dropped");
  assert.ok(captured, "runner was reached");
  assert.ok(!existsSync(path.dirname(captured.file)), "temp dir removed after runner throw");
});

test("transcribeViaAgent: ok:false (timeout/non-zero exit) → resolved fail envelope; usage + stderr surfaced", async () => {
  const fail = await transcribeViaAgent({
    config: visionConfig,
    model: "m",
    imageBytes: Buffer.from("x"),
    runner: async () => ({ ok: false, text: "partial transcription…", error: "exit code 1", stderr: "Session.AgentNotFoundError: Agent not found: \"pr-vision\"", usage: null }),
  });
  assert.equal(fail.ok, false);
  assert.equal(fail.text, null);
  assert.equal(fail.error, "exit code 1");
  assert.match(fail.stderr, /AgentNotFoundError/, "the real stderr survives to the artifact, not just a bare 'exit code 1'");
  assert.equal(fail.usage, null);
  // A billable run with no usable caption still reports its tokens (Copilot #17 MEDIUM 2).
  const priced = await transcribeViaAgent({
    config: visionConfig,
    model: "m",
    imageBytes: Buffer.from("x"),
    runner: async () => ({ ok: false, text: "partial…", usage: { input: 90, output: 30, cacheRead: 4, cacheWrite: 1 } }),
  });
  assert.equal(priced.ok, false);
  assert.deepEqual(priced.usage, { input: 90, output: 30, cacheRead: 4, cacheWrite: 1 });
});

test("transcribeViaAgent: empty/whitespace text → fail envelope (never taken as context)", async () => {
  const a = await transcribeViaAgent({ config: visionConfig, model: "m", imageBytes: Buffer.from("x"), runner: async () => ({ text: "   ", usage: null }) });
  assert.equal(a.ok, false);
  assert.equal(a.text, null);
  assert.equal(a.error, "transcription returned no text");
  const b = await transcribeViaAgent({ config: visionConfig, model: "m", imageBytes: Buffer.from("x"), runner: async () => ({ text: "", usage: { input: 12, output: 3 } }) });
  assert.equal(b.ok, false);
  assert.deepEqual(b.usage, { input: 12, output: 3 });
});

test("transcribeViaAgent: success returns the full envelope (text + usage + streams)", async () => {
  const out = await transcribeViaAgent({
    config: visionConfig,
    model: "m",
    imageBytes: Buffer.from("x"),
    runner: async () => ({ text: "the ATP Check config screen", usage: { input: 100, output: 40, cacheRead: 5, cacheWrite: 3 }, stdout: "…agent boot lines…", stderr: "" }),
  });
  assert.deepEqual(out, {
    ok: true,
    text: "the ATP Check config screen",
    usage: { input: 100, output: 40, cacheRead: 5, cacheWrite: 3 },
    stdout: "…agent boot lines…",
    stderr: "",
    error: null,
  });
});

test("transcribeViaAgent: no retry — a transient ok:false runs the agent exactly once", async () => {
  let calls = 0;
  const runner = async (arg) => {
    calls += 1;
    return { ok: false, text: "", error: "exit code 1", stderr: "Session.AgentNotFoundError: Agent not found: \"pr-vision\"" };
  };
  const out = await transcribeViaAgent({ config: visionConfig, model: "m", imageBytes: Buffer.from("x"), runner });
  assert.equal(calls, 1, "no unbounded/automatic retry loop in the vision step (retry is explicitly out of scope; a rerun of the review is the retry)");
  assert.equal(out.ok, false);
  assert.match(out.stderr, /AgentNotFoundError/);
});

test("transcribeViaAgent: missing model → null (skip)", async () => {
  let called = false;
  const runner = async () => {
    called = true;
    return { text: "x" };
  };
  assert.equal(await transcribeViaAgent({ config: visionConfig, model: "", imageBytes: Buffer.from("x"), runner }), null);
  assert.equal(await transcribeViaAgent({ config: visionConfig, imageBytes: Buffer.from("x"), runner }), null);
  assert.equal(called, false, "runner never called without a model");
});

test("transcribeViaAgent: scratch dir lands under config.dirs.visionScratch when set", async () => {
  let captured = null;
  const runner = async (arg) => {
    captured = arg;
    return { text: "ok" };
  };
  const scratch = path.join(os.tmpdir(), "cfg-vision-scratch-test");
  const cfg = { ...visionConfig, dirs: { visionScratch: scratch } };
  const out = await transcribeViaAgent({ config: cfg, model: "m", imageBytes: Buffer.from("x"), runner });
  assert.ok(out);
  assert.ok(captured.cwd.startsWith(scratch + path.sep), "scratch is under the configured project-anchored root");
  assert.equal(captured.cwd, path.dirname(captured.file), "cwd still isolated to the screenshot dir");
  assert.ok(!existsSync(path.dirname(captured.file)), "temp dir removed after success");
});

test("transcribeViaAgent: invalid model id → null before delegating (validate-before-delegate)", async () => {
  let called = false;
  const runner = async () => {
    called = true;
    return { text: "x" };
  };
  for (const bad of [" ", "foo bar", "/abs/path", "..\\win", "a\tb"]) {
    assert.equal(
      await transcribeViaAgent({ config: visionConfig, model: bad, imageBytes: Buffer.from("x"), runner }),
      null,
      `rejected: ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(called, false, "runner never called for an invalid model id");
});

test("transcribeViaAgent: timeoutSeconds floors at 1", async () => {
  let captured = null;
  const runner = async (arg) => {
    captured = arg;
    return { text: "ok" };
  };
  await transcribeViaAgent({ config: visionConfig, model: "m", imageBytes: Buffer.from("x"), timeoutMs: 500, runner });
  assert.equal(captured.timeoutSeconds, 1);
});

test("transcribeViaAgent: mime type maps to the file extension (unknown → png)", async () => {
  const exts = [];
  const runner = async (arg) => {
    exts.push(path.extname(arg.file));
    return { text: "ok" };
  };
  await transcribeViaAgent({ config: visionConfig, model: "m", imageBytes: Buffer.from("x"), mimeType: "image/jpeg", runner });
  await transcribeViaAgent({ config: visionConfig, model: "m", imageBytes: Buffer.from("x"), mimeType: "image/webp", runner });
  await transcribeViaAgent({ config: visionConfig, model: "m", imageBytes: Buffer.from("x"), mimeType: "image/svg+xml", runner });
  await transcribeViaAgent({ config: visionConfig, model: "m", imageBytes: Buffer.from("x"), runner }); // default png
  assert.deepEqual(exts, [".jpg", ".webp", ".png", ".png"]);
});

test("loadScreenshotBlock: failed fetch still yields an image record (indexed, error surfaced)", async () => {
  const client = {
    fetchBuffer: async () => {
      throw new Error("no permission");
    },
  };
  const res = await loadScreenshotBlock({
    client,
    config: baseConfig,
    ref,
    description: "![a](attachment:1/55)",
    activities: [],
    transcribe: async () => "never called",
  });
  assert.equal(res.images.length, 1);
  assert.equal(res.images[0].ok, false);
  assert.equal(res.images[0].text, "");
  assert.equal(res.images[0].error, "image could not be fetched");
});

test("loadScreenshotBlock: structured fail envelope (stderr) lands in the image record, not the block", async () => {
  const fetchBuffer = async () => ({ bytes: Buffer.from("x"), contentType: "image/png" });
  const client = { fetchBuffer };
  const res = await loadScreenshotBlock({
    client,
    config: baseConfig,
    ref,
    description: "![a](attachment:1/1)",
    activities: [],
    transcribe: async () => ({
      ok: false,
      text: null,
      usage: { input: 5, output: 2 },
      stdout: "",
      stderr: "Session.AgentNotFoundError: Agent not found: \"pr-vision\"",
      error: "exit code 1",
    }),
  });
  assert.equal(res.unreadable, 1);
  assert.ok(res.block.includes("could not be fetched/read"));
  assert.equal(res.images[0].ok, false);
  assert.match(res.images[0].stderr, /AgentNotFoundError/, "the artifact source of truth carries the real error");
  assert.deepEqual(res.images[0].usage, { input: 5, output: 2 }, "failed run still priced");
});

// --- sweepVisionScratch ------------------------------------------------------

function scratchCfg({ maxAge, callTimeout, dir }) {
  return {
    dirs: { visionScratch: dir || path.join(os.tmpdir(), `sweep-cfg-${Math.random().toString(36).slice(2)}`) },
    review: { visionScratchMaxAgeMs: maxAge, visionCallTimeoutMs: callTimeout },
  };
}

async function makeScratchDir(cfg, name, mtimeMs) {
  const full = path.join(cfg.dirs.visionScratch, name);
  await import("node:fs/promises").then((fs) => fs.mkdir(full, { recursive: true }));
  await import("node:fs/promises").then((fs) => fs.writeFile(path.join(full, "image.png"), Buffer.from("x")));
  await import("node:fs/promises").then((fs) => {
    const t = new Date(mtimeMs);
    fs.utimes(full, t, t);
    fs.utimes(path.join(full, "image.png"), t, t);
  });
  return full;
}

test("sweepVisionScratch: removes only dirs older than the age floor", async () => {
  const cfg = scratchCfg({ maxAge: 3600000, callTimeout: 60000 });
  const now = Date.now();
  await makeScratchDir(cfg, "pr-vision-stale", now - 3 * 3600000); // 3 h old → sweep
  await makeScratchDir(cfg, "pr-vision-fresh", now - 60_000); // 1 min old → keep
  await makeScratchDir(cfg, "pr-vision-edge", now - 3601000); // just past floor → sweep
  await makeScratchDir(cfg, "not-a-vision-dir", now - 5 * 3600000); // non-matching name → keep
  const removed = await sweepVisionScratch(cfg);
  assert.equal(removed, 2, "stale + edge swept; fresh and non-matching kept");
  const fs = await import("node:fs/promises");
  assert.ok(!(await fs.stat(cfg.dirs.visionScratch + "/pr-vision-stale").catch(() => null)));
  assert.ok(!(await fs.stat(cfg.dirs.visionScratch + "/pr-vision-edge").catch(() => null)));
  assert.ok(await fs.stat(cfg.dirs.visionScratch + "/pr-vision-fresh"));
  assert.ok(await fs.stat(cfg.dirs.visionScratch + "/not-a-vision-dir"));
  await fs.rm(cfg.dirs.visionScratch, { recursive: true, force: true });
});

test("sweepVisionScratch: respects maxAge=0 (disabled) and a missing root", async () => {
  const disabled = scratchCfg({ maxAge: 0, callTimeout: 60000 });
  await makeScratchDir(disabled, "pr-vision-old", Date.now() - 100 * 3600000);
  assert.equal(await sweepVisionScratch(disabled), 0, "maxAge 0 disables the sweep entirely");
  // Missing/empty root → best-effort 0, never throws.
  const missing = scratchCfg({ maxAge: 3600000, callTimeout: 60000, dir: path.join(os.tmpdir(), `never-created-${Math.random().toString(36).slice(2)}`) });
  assert.equal(await sweepVisionScratch(missing), 0);
  assert.equal(await sweepVisionScratch({ dirs: {}, review: { visionScratchMaxAgeMs: 3600000 } }), 0, "falls back to os.tmpdir() without throwing");
  await import("node:fs/promises").then((fs) => fs.rm(disabled.dirs.visionScratch, { recursive: true, force: true }));
});

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractImageRefs, collectImageRefs, loadScreenshotBlock, transcribeViaAgent } from "../src/prImages.js";

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
  assert.deepEqual((await loadScreenshotBlock({ client: null, config: baseConfig, ref })), { block: "", usage: null, transcribed: 0, unreadable: 0 });
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
    transcribe: async () => ({ text: "ok", usage: { input: 100, output: 50 } }),
  });
  assert.equal(res.transcribed, 2);
  assert.deepEqual(res.usage, { input: 200, output: 100, cacheRead: 0, cacheWrite: 0 });
  assert.ok(res.block.includes("## PR screenshots (transcribed)"));
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
  assert.deepEqual(res, { block: "", usage: null, transcribed: 0, unreadable: 0 });
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
  assert.equal(Buffer.from(captured.written).toString(), "png", "image bytes written verbatim");
  assert.match(captured.message, /[Tt]ranscrib/);
  assert.deepEqual(out, { text: "the ATP Check config screen", usage: { input: 100, output: 40, cacheRead: 5, cacheWrite: 3 } });
  assert.ok(!existsSync(path.dirname(captured.file)), "temp dir removed after success");
});

test("transcribeViaAgent: returns null and cleans up when the agent call fails (never throws)", async () => {
  let captured = null;
  const runner = async (arg) => {
    captured = arg;
    throw new Error("boom");
  };
  assert.equal(await transcribeViaAgent({ config: visionConfig, model: "m", imageBytes: Buffer.from("x"), runner }), null);
  assert.ok(captured, "runner was reached");
  assert.ok(!existsSync(path.dirname(captured.file)), "temp dir removed after runner throw");
});

test("transcribeViaAgent: ok:false (timeout/non-zero exit) with partial text → null", async () => {
  const runner = async () => ({ ok: false, text: "partial transcription…", usage: null });
  assert.equal(await transcribeViaAgent({ config: visionConfig, model: "m", imageBytes: Buffer.from("x"), runner }), null);
});

test("transcribeViaAgent: empty/whitespace text → null", async () => {
  const runner = async () => ({ text: "   ", usage: null });
  assert.equal(await transcribeViaAgent({ config: visionConfig, model: "m", imageBytes: Buffer.from("x"), runner }), null);
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

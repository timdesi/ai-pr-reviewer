import { test } from "node:test";
import assert from "node:assert/strict";

import { extractImageRefs, collectImageRefs, loadScreenshotBlock } from "../src/prImages.js";
import { visionRoute, transcribeImage } from "../src/vision.js";

const BOT = "mybot@example.com";
const baseConfig = {
  review: {
    fetchPrImages: true,
    visionModel: "aifarm-gpt/gpt-6-luna-2026-09-22",
    visionMaxImages: 6,
    visionMaxImageBytes: 10 * 1024 * 1024,
    visionFetchTimeoutMs: 5000,
    visionCallTimeoutMs: 5000,
  },
  bitbucket: { baseUrl: "https://bb.example.com", username: BOT },
};
const ref = { projectKey: "P", repoSlug: "r", prId: 7 };

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
  assert.deepEqual(res.usage, { input: 200, output: 50 * 2 });
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

// --- vision routing ----------------------------------------------------------

test("visionRoute maps aifarm-gpt to the Azure deployments route", () => {
  const r = visionRoute("aifarm-gpt/gpt-6-luna-2026-09-22");
  assert.ok(r);
  assert.match(r.url, /\/api\/openai\/deployments\/gpt-6-luna-2026-09-22\/chat\/completions\?api-version=2025-04-01-preview$/);
  assert.equal(r.model, "gpt-6-luna-2026-09-22");
});

test("visionRoute: bare id defaults to aifarm-gpt; aifarm/claude maps to the Anthropic route; others are null", () => {
  assert.equal(visionRoute("gpt-6-luna-2026-09-22").model, "gpt-6-luna-2026-09-22");
  const anthropic = visionRoute("aifarm/claude-haiku-5-5");
  assert.ok(anthropic);
  assert.equal(anthropic.kind, "anthropic");
  assert.equal(anthropic.model, "claude-haiku-5-5");
  assert.match(anthropic.url, /\/api\/google\/v1\/publishers\/anthropic\/models\/claude-haiku-5-5:rawPredict$/);
  assert.equal(visionRoute("acme/bogus-1"), null);
  assert.equal(visionRoute(""), null);
});

test("visionRoute: aifarm-msp uses the model's per-model base URL from the config", () => {
  assert.equal(visionRoute("aifarm-msp/Qwen-38-27B"), null, "no base-URL map -> unroutable");
  const bases = { "aifarm-msp/Qwen-38-27B": "https://llm-gateway.example.com/api/providers/example/msp/qwen3.8-27b/v1/" };
  const r = visionRoute("aifarm-msp/Qwen-38-27B", bases);
  assert.ok(r);
  assert.equal(r.kind, "openai");
  assert.equal(r.model, "Qwen-38-27B");
  assert.equal(r.url, "https://llm-gateway.example.com/api/providers/example/msp/qwen3.8-27b/v1/chat/completions");
});

test("transcribeImage routes aifarm-msp to the per-model chat/completions endpoint", async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), hasImage: String(init.body).includes('"image_url"') });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ choices: [{ message: { content: "qwen read it" } }], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
    };
  };
  process.env.ANTHROPIC_AUTH_TOKEN = "tok";
  try {
    const out = await transcribeImage({
      model: "aifarm-msp/Qwen-38-27B",
      imageBytes: Buffer.from("png"),
      mimeType: "image/png",
      baseUrls: { "aifarm-msp/Qwen-38-27B": "https://llm-gateway.example.com/api/providers/example/msp/qwen3.8-27b/v1/" },
    });
    assert.equal(out.text, "qwen read it");
    assert.deepEqual(out.usage, { input: 9, output: 3 });
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /qwen3\.8-27b\/v1\/chat\/completions$/);
    assert.ok(seen[0].hasImage);
  } finally {
    globalThis.fetch = orig;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("transcribeImage posts the image and returns { text, usage } parsed from the response", async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), hasImage: String(init.body).includes('"image_url"'), hasB64: String(init.body).includes("data:image/png;base64,") });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: "verified 5 rows" } }],
          usage: { prompt_tokens: 120, completion_tokens: 40 },
        }),
    };
  };
  process.env.ANTHROPIC_AUTH_TOKEN = "tok";
  try {
    const out = await transcribeImage({ model: "aifarm-gpt/gpt-6-luna-2026-09-22", imageBytes: Buffer.from("png"), mimeType: "image/png" });
    assert.equal(out.text, "verified 5 rows");
    assert.deepEqual(out.usage, { input: 120, output: 40 });
    assert.equal(seen.length, 1);
    assert.ok(seen[0].hasImage && seen[0].hasB64);
  } finally {
    globalThis.fetch = orig;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("transcribeImage speaks the Anthropic messages format over :rawPredict (aifarm/claude-*)", async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({
      url: String(url),
      body: JSON.parse(init.body),
      hasB64: String(init.body).includes('"data":"'),
      sticky: init.headers["x-bmf-sticky-session-instance"],
    });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          content: [{ type: "text", text: "screenshot shows the login form" }],
          usage: { input_tokens: 150, output_tokens: 30 },
        }),
    };
  };
  process.env.ANTHROPIC_AUTH_TOKEN = "tok";
  try {
    const out = await transcribeImage({ model: "aifarm/claude-haiku-5-5", imageBytes: Buffer.from("png"), mimeType: "image/png" });
    assert.equal(out.text, "screenshot shows the login form");
    assert.deepEqual(out.usage, { input: 150, output: 30 });
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /claude-haiku-5-5:rawPredict$/);
    assert.equal(seen[0].body.anthropic_version, "vertex-2023-10-16");
    assert.equal(seen[0].body.max_tokens, 700);
    const image = seen[0].body.messages[0].content.find((c) => c.type === "image");
    assert.equal(image.source.media_type, "image/png");
    assert.equal(image.source.type, "base64");
    assert.ok(seen[0].hasB64);
    assert.equal(seen[0].sticky, "01");
  } finally {
    globalThis.fetch = orig;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("transcribeImage returns null without a token, on route miss, or with no text (never throws)", async () => {
  assert.equal(await transcribeImage({ model: "aifarm-gpt/gpt-6-luna-2026-09-22", imageBytes: Buffer.from("x") }), null); // no token
  assert.equal(await transcribeImage({ model: "acme/bogus-1", imageBytes: Buffer.from("x") }), null); // not routable
  // Text-only response without usage -> { text, usage: null }.
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
  });
  process.env.ANTHROPIC_AUTH_TOKEN = "tok";
  try {
    const out = await transcribeImage({ model: "aifarm-gpt/gpt-6-luna-2026-09-22", imageBytes: Buffer.from("x") });
    assert.equal(out.text, "ok");
    assert.equal(out.usage, null);
  } finally {
    globalThis.fetch = orig;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

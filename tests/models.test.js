import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { readModelAssignments, writeModelAssignments, MODEL_SLOTS } from "../src/models.js";
import { loadConfig } from "../src/config.js";

function tmpFile(name = "models.json") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "models-test-"));
  return path.join(dir, name);
}

test("readModelAssignments: missing file/corrupt JSON -> {}", () => {
  assert.deepEqual(readModelAssignments(tmpFile()), {});
  const f = tmpFile();
  writeFileSync(f, "not json{{{");
  assert.deepEqual(readModelAssignments(f), {});
});

test("readModelAssignments: extracts only valid string slots", () => {
  const f = tmpFile();
  writeFileSync(
    f,
    JSON.stringify({ a: "myprovider/discretestack-stable-fast", b: "  llmgw/claude-haiku-5-5  ", c: 42, consensus: "" }),
  );
  assert.deepEqual(readModelAssignments(f), {
    a: "myprovider/discretestack-stable-fast",
    b: "llmgw/claude-haiku-5-5",
  });
});

test("writeModelAssignments: persists merged slots atomically", () => {
  const f = tmpFile();
  writeModelAssignments(f, { a: "myprovider/discretestack-stable-fast" });
  // Second call with a different slot must keep the first.
  writeModelAssignments(f, { consensus: "llmgw-gpt/gpt-6-luna" });
  assert.deepEqual(readModelAssignments(f), {
    a: "myprovider/discretestack-stable-fast",
    consensus: "llmgw-gpt/gpt-6-luna",
  });
  // Invalid values are dropped.
  writeModelAssignments(f, { b: "   " });
  assert.deepEqual(readModelAssignments(f), {
    a: "myprovider/discretestack-stable-fast",
    consensus: "llmgw-gpt/gpt-6-luna",
  });
  // The vision slot persists like the reviewer slots.
  writeModelAssignments(f, { vision: "llmgw-gpt/gpt-6-luna" });
  assert.equal(readModelAssignments(f).vision, "llmgw-gpt/gpt-6-luna");
  assert.equal(MODEL_SLOTS.length, 6);
});

test("loadConfig: persisted model assignments override env defaults", () => {
  const settings = tmpFile();
  writeModelAssignments(settings, { b: "llmgw/claude-haiku-5-5", consensus: "llmgw-gpt/gpt-6-luna" });

  const prev = {};
  const keys = [
    "REVIEWER_MODEL_A",
    "REVIEWER_MODEL_B",
    "REVIEWER_MODEL_C",
    "CONSENSUS_MODEL",
    "MODEL_SETTINGS_FILE",
    "PUBLISH_TO_BITBUCKET",
  ];
  for (const k of keys) prev[k] = process.env[k];
  try {
    process.env.REVIEWER_MODEL_A = "myprovider/discretestack-stable-fast";
    process.env.REVIEWER_MODEL_B = "llmgw-anthropic/claude-haiku-5-5"; // legacy default
    process.env.REVIEWER_MODEL_C = "myprovider/discretestack-stable-fast";
    process.env.CONSENSUS_MODEL = "myprovider/discretestack-stable-fast";
    process.env.PUBLISH_TO_BITBUCKET = "1";
    process.env.MODEL_SETTINGS_FILE = settings;

    const config = loadConfig({ envFile: tmpFile("nonexistent.env") });
    assert.equal(config.models.reviewerA, "myprovider/discretestack-stable-fast"); // untouched
    assert.equal(config.models.reviewerB, "llmgw/claude-haiku-5-5"); // overridden
    assert.equal(config.models.reviewerC, "myprovider/discretestack-stable-fast"); // untouched
    assert.equal(config.models.consensus, "llmgw-gpt/gpt-6-luna"); // overridden
    assert.equal(config.models.settingsFile, settings);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

test("loadConfig applies the persisted vision model for the screenshot transcriber", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-vision-"));
  const settings = path.join(dir, ".models.json");
  writeFileSync(settings, JSON.stringify({ vision: "llmgw-gpt/gpt-6-luna" }));
  try {
    const prevVision = process.env.VISION_MODEL;
    process.env.MODEL_SETTINGS_FILE = settings;
    process.env.VISION_MODEL = "llmgw-openai/deepseek-v4-pro"; // env default
    try {
      const cfg = loadConfig({ envFile: tmpFile("nonexistent.env") });
      assert.equal(cfg.review.visionModel, "llmgw-gpt/gpt-6-luna", "persisted vision beats the env default");
    } finally {
      if (prevVision === undefined) delete process.env.VISION_MODEL;
      else process.env.VISION_MODEL = prevVision;
      delete process.env.MODEL_SETTINGS_FILE;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server /api/models marks image-capable models and gates the vision slot", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "models-vision-srv-"));
  const settings = path.join(dir, ".models.json");
  const template = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docker", "opencode.json.template");
  const { createServer } = await import("../src/server.js");
  let server = null;
  const prev = {};
  const envKeys = ["BITBUCKET_BASE_URL", "BITBUCKET_API_TOKEN", "MODEL_SETTINGS_FILE", "VISION_MODEL", "PUBLISH_TO_BITBUCKET"];
  for (const k of envKeys) prev[k] = process.env[k];
  try {
    process.env.BITBUCKET_BASE_URL = "https://bb.example.com";
    process.env.BITBUCKET_API_TOKEN = "tok";
    process.env.MODEL_SETTINGS_FILE = settings;
    process.env.PUBLISH_TO_BITBUCKET = "0";
    const config = loadConfig({ envFile: tmpFile("nonexistent.env") });
    config.costs.configPath = template; // deterministic model list from the template
    const created = createServer({ config, port: 0 });
    server = created.server;
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // GET: vision-capable models are flagged.
    const get = await fetch(`${base}/api/models`);
    assert.equal(get.status, 200);
    const j = await get.json();
    const byId = Object.fromEntries(j.available.map((m) => [m.id, m.vision]));
    assert.equal(byId["llmgw-gpt/gpt-6-luna"], true, "gpt-6-luna is image-capable");
    assert.equal(byId["llmgw/claude-haiku-5-5"], true, "claude-haiku-5-5 is image-capable (Anthropic)");
    assert.equal(byId["llmgw-msp/Qwen-27B"], true, "Qwen 27B is image-capable");
    assert.equal(byId["llmgw-openai/deepseek-v4-pro"], false, "DeepSeek V4 Pro is text-only");
    assert.equal(byId["llmgw-deepseek-flash/deepseek-v4-flash"], false, "DeepSeek V4 Flash is text-only");
    assert.equal(byId["llmgw-msp/DeepSeek-V4-Flash"], false, "DeepSeek V4 Flash 0731 is text-only");
    assert.equal(byId["llmgw-msp/glm-52"], false, "GLM-5.2 is text-only");
    assert.equal(byId["llmgw-glm/glm-5"], undefined, "GLM-5 MaaS removed from config");
    assert.equal(j.assigned.vision, "llmgw-gpt/gpt-6-luna", "default vision assignment present");

    // PUT: a non-image-capable model is rejected for the vision slot.
    const bad = await fetch(`${base}/api/models`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: { vision: "llmgw-openai/deepseek-v4-pro" } }),
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /not image-capable/);

    // PUT: an image-capable model is saved, applied immediately, persisted.
    const ok = await fetch(`${base}/api/models`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: { vision: "llmgw-gpt/gpt-6-luna" } }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).assigned.vision, "llmgw-gpt/gpt-6-luna");
    assert.equal(config.review.visionModel, "llmgw-gpt/gpt-6-luna", "applied for next reviews");
    assert.equal(readModelAssignments(settings).vision, "llmgw-gpt/gpt-6-luna", "persisted for next boot");
  } finally {
    if (server) await new Promise((r) => server.close(r));
    for (const k of envKeys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

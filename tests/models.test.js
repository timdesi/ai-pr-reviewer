import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
    JSON.stringify({ a: "myprovider/discretestack-stable-fast", b: "  prov-msg/mdl-an  ", c: 42, consensus: "" }),
  );
  assert.deepEqual(readModelAssignments(f), {
    a: "myprovider/discretestack-stable-fast",
    b: "prov-msg/mdl-an",
  });
});

test("writeModelAssignments: persists merged slots atomically", () => {
  const f = tmpFile();
  writeModelAssignments(f, { a: "myprovider/discretestack-stable-fast" });
  // Second call with a different slot must keep the first.
  writeModelAssignments(f, { consensus: "prov-gateway/mdl-gw" });
  assert.deepEqual(readModelAssignments(f), {
    a: "myprovider/discretestack-stable-fast",
    consensus: "prov-gateway/mdl-gw",
  });
  // Invalid values are dropped.
  writeModelAssignments(f, { b: "   " });
  assert.deepEqual(readModelAssignments(f), {
    a: "myprovider/discretestack-stable-fast",
    consensus: "prov-gateway/mdl-gw",
  });
  // The vision slot persists like the reviewer slots.
  writeModelAssignments(f, { vision: "prov-gateway/mdl-gw" });
  assert.equal(readModelAssignments(f).vision, "prov-gateway/mdl-gw");
  assert.equal(MODEL_SLOTS.length, 6);
});

test("loadConfig: persisted model assignments override env defaults", () => {
  const settings = tmpFile();
  writeModelAssignments(settings, { b: "prov-msg/mdl-an", consensus: "prov-gateway/mdl-gw" });

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
    process.env.REVIEWER_MODEL_B = "prov-msg/mdl-an"; // legacy default
    process.env.REVIEWER_MODEL_C = "myprovider/discretestack-stable-fast";
    process.env.CONSENSUS_MODEL = "myprovider/discretestack-stable-fast";
    process.env.PUBLISH_TO_BITBUCKET = "1";
    process.env.MODEL_SETTINGS_FILE = settings;

    const config = loadConfig({ envFile: tmpFile("nonexistent.env") });
    assert.equal(config.models.reviewerA, "myprovider/discretestack-stable-fast"); // untouched
    assert.equal(config.models.reviewerB, "prov-msg/mdl-an"); // overridden
    assert.equal(config.models.reviewerC, "myprovider/discretestack-stable-fast"); // untouched
    assert.equal(config.models.consensus, "prov-gateway/mdl-gw"); // overridden
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
  writeFileSync(settings, JSON.stringify({ vision: "prov-gateway/mdl-gw" }));
  try {
    const prevVision = process.env.VISION_MODEL;
    process.env.MODEL_SETTINGS_FILE = settings;
    process.env.VISION_MODEL = "prov-gateway/mdl-text"; // env default
    try {
      const cfg = loadConfig({ envFile: tmpFile("nonexistent.env") });
      assert.equal(cfg.review.visionModel, "prov-gateway/mdl-gw", "persisted vision beats the env default");
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
  const settingsA = path.join(dir, "a.models.json");
  const settingsB = path.join(dir, "b.models.json");
  // Deterministic neutral model list, written to a temp file so the test never
  // depends on docker/ literals.
  const modelConfig = path.join(dir, "opencode.json");
  writeFileSync(
    modelConfig,
    JSON.stringify({
      providers: {
        "prov-gateway": {
          models: {
            "mdl-gw": { capabilities: { input: ["text", "image"], output: ["text"] } },
            "mdl-text": { capabilities: { input: ["text"], output: ["text"] } },
          },
        },
        "prov-msg": {
          models: { "mdl-an": { capabilities: { input: ["text", "image"], output: ["text"] } } },
        },
        "prov-hosted": {
          models: { "mdl-h": { capabilities: { input: ["text", "image"], output: ["text"] } } },
        },
      },
    }),
  );
  const { createServer } = await import("../src/server.js");
  const spin = (config) =>
    new Promise((resolve, reject) => {
      const { server } = createServer({ config, port: 0 });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
      });
    });
  const prev = {};
  const envKeys = ["BITBUCKET_BASE_URL", "BITBUCKET_API_TOKEN", "MODEL_SETTINGS_FILE", "VISION_MODEL", "PUBLISH_TO_BITBUCKET"];
  for (const k of envKeys) prev[k] = process.env[k];
  try {
    process.env.BITBUCKET_BASE_URL = "https://bb.example.com";
    process.env.BITBUCKET_API_TOKEN = "tok";
    process.env.PUBLISH_TO_BITBUCKET = "0";
    process.env.MODEL_SETTINGS_FILE = settingsA;
    delete process.env.VISION_MODEL; // unset -> no baked-in default
    const configA = loadConfig({ envFile: tmpFile("nonexistent.env") });
    configA.costs.configPath = modelConfig;
    const { server: serverA, base: baseA } = await spin(configA);
    try {
      // GET: vision-capable models are flagged; unset VISION_MODEL -> "".
      const get = await fetch(`${baseA}/api/models`);
      assert.equal(get.status, 200);
      const j = await get.json();
      const byId = Object.fromEntries(j.available.map((m) => [m.id, m.vision]));
      assert.equal(byId["prov-gateway/mdl-gw"], true, "mdl-gw is image-capable");
      assert.equal(byId["prov-msg/mdl-an"], true, "mdl-an is image-capable");
      assert.equal(byId["prov-hosted/mdl-h"], true, "mdl-h is image-capable");
      assert.equal(byId["prov-gateway/mdl-text"], false, "mdl-text is text-only");
      assert.equal(j.assigned.vision, "", "no baked-in default vision assignment");

      // PUT: a non-image-capable model is rejected for the vision slot.
      const bad = await fetch(`${baseA}/api/models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: { vision: "prov-gateway/mdl-text" } }),
      });
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /not image-capable/);

      // PUT: an image-capable model is saved, applied immediately, persisted.
      const ok = await fetch(`${baseA}/api/models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: { vision: "prov-gateway/mdl-gw" } }),
      });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).assigned.vision, "prov-gateway/mdl-gw");
      assert.equal(configA.review.visionModel, "prov-gateway/mdl-gw", "applied for next reviews");
      assert.equal(readModelAssignments(settingsA).vision, "prov-gateway/mdl-gw", "persisted for next boot");
    } finally {
      await new Promise((r) => serverA.close(r));
    }

    // Companion: with VISION_MODEL set, the env value echoes as assigned.vision.
    process.env.MODEL_SETTINGS_FILE = settingsB;
    process.env.VISION_MODEL = "prov-gateway/mdl-gw";
    const configB = loadConfig({ envFile: tmpFile("nonexistent.env") });
    configB.costs.configPath = modelConfig;
    const { server: serverB, base: baseB } = await spin(configB);
    try {
      const j = await (await fetch(`${baseB}/api/models`)).json();
      assert.equal(j.assigned.vision, "prov-gateway/mdl-gw", "env VISION_MODEL echoes as assigned.vision");
    } finally {
      await new Promise((r) => serverB.close(r));
    }
  } finally {
    for (const k of envKeys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

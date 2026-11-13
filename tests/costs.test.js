import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadModelPrices, loadModelBaseUrls, listAvailableModels, computeCost, fmtMoney, defaultPriceCandidates } from "../src/costs.js";

function tmpConfig(payload) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "costs-test-"));
  const file = path.join(dir, "opencode.json");
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

test("loadModelPrices builds provider/model map from cost metadata", () => {
  const file = tmpConfig({
    provider: {
      myprovider: {
        models: {
          "discretestack-stable-fast": {
            cost: { input: 0.35, output: 1.4, cache_read: 0.07, cache_write: 0.35 },
          },
          "discretestack-stable": {}, // no cost -> skipped
        },
      },
      "aifarm-anthropic": {
        models: {
          "claude-haiku-5-5": { cost: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 } },
        },
      },
    },
  });
  const prices = loadModelPrices([file]);
  assert.deepEqual(prices["myprovider/discretestack-stable-fast"], {
    input: 0.35,
    output: 1.4,
    cacheRead: 0.07,
    cacheWrite: 0.35,
  });
  assert.deepEqual(prices["aifarm-anthropic/claude-haiku-5-5"], {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
  });
  assert.equal(prices["myprovider/discretestack-stable"], undefined);
});

test("loadModelPrices reads native V2 providers map + cache.read/write", () => {
  const file = tmpConfig({
    providers: {
      myprovider: {
        models: {
          "discretestack-stable-fast": {
            cost: { input: 0.35, output: 1.4, cache: { read: 0.07, write: 0.35 } },
          },
        },
      },
      "aifarm-msp": {
        models: {
          "zai-glm-52": {
            cost: { input: 0.418, output: 1.338, cache: { read: 0.078, write: 0.418 } },
          },
          "glm-5-maas": { modelID: "zai-org/glm-5-maas", cost: { input: 0.5, output: 1.5 } },
        },
      },
    },
  });
  const prices = loadModelPrices([file]);
  assert.deepEqual(prices["myprovider/discretestack-stable-fast"], {
    input: 0.35,
    output: 1.4,
    cacheRead: 0.07,
    cacheWrite: 0.35,
  });
  assert.deepEqual(prices["aifarm-msp/zai-glm-52"], {
    input: 0.418,
    output: 1.338,
    cacheRead: 0.078,
    cacheWrite: 0.418,
  });
  // Keyed by the config key (not modelID) so it matches the pipeline's --model ref.
  assert.deepEqual(prices["aifarm-msp/glm-5-maas"], {
    input: 0.5,
    output: 1.5,
    cacheRead: 0,
    cacheWrite: 0,
  });
  // A V2 file with no prices falls through to the next candidate.
  const withFallback = loadModelPrices([file, tmpConfig({ provider: {} })]);
  assert.equal(Object.keys(withFallback).length > 0, true);
});

test("listAvailableModels enumerates provider/model ids (V2 + V1, both shapes)", () => {
  const file = tmpConfig({
    providers: {
      aifarm: { models: { "claude-haiku-5-5": { name: "Claude Haiku 5.5" }, "claude-opus-5-5": {} } },
      "aifarm-msp": { models: { "zai-glm-52": { name: "z.AI GLM-5.2" }, "glm-5-maas": { modelID: "zai-org/glm-5-maas" } } },
    },
  });
  const models = listAvailableModels([file]);
  assert.deepEqual(models, [
    { id: "aifarm-msp/glm-5-maas", name: "glm-5-maas", image: false }, // no explicit name -> key
    { id: "aifarm-msp/zai-glm-52", name: "z.AI GLM-5.2", image: false },
    { id: "aifarm/claude-haiku-5-5", name: "Claude Haiku 5.5", image: false },
    { id: "aifarm/claude-opus-5-5", name: "claude-opus-5-5", image: false },
  ]);
  // Legacy V1 shape + graceful fallback.
  const legacy = tmpConfig({ provider: { p: { models: { m: { cost: {} } } } } });
  assert.equal(listAvailableModels([legacy])[0].id, "p/m");
  assert.deepEqual(listAvailableModels(["/nonexistent/config.json"]), []);
  assert.deepEqual(listAvailableModels([tmpConfig({ provider: "nope" })]), []);
});

test("listAvailableModels flags image input from capabilities", () => {
  const file = tmpConfig({
    providers: {
      aifarm: {
        models: {
          "claude-haiku-5-5": { capabilities: { input: ["text", "image"], output: ["text"] } },
          "claude-opus-5-5": { capabilities: { input: ["text"], output: ["text"] } },
          "bare": {},
        },
      },
    },
  });
  const byId = Object.fromEntries(listAvailableModels([file]).map((m) => [m.id, m]));
  assert.equal(byId["aifarm/claude-haiku-5-5"].image, true);
  assert.equal(byId["aifarm/claude-opus-5-5"].image, false);
  assert.equal(byId["aifarm/bare"].image, false, "no capabilities -> not image-capable");
});

test("loadModelBaseUrls: provider-level base URL, per-model overrides", () => {
  const file = tmpConfig({
    providers: {
      "aifarm-msp": {
        settings: { baseURL: "https://farm/msp/glm-5.2/v1" },
        models: {
          "zai-glm-52": {},
          "Qwen-38-27B": { settings: { baseURL: "https://farm/msp/qwen3.8-27b/v1" } },
        },
      },
      "aifarm-openai": {
        settings: { baseURL: "https://farm/api/openai" },
        models: { "deepseek-v4-pro-2026-04-23": {} },
      },
    },
  });
  assert.deepEqual(loadModelBaseUrls([file]), {
    "aifarm-msp/zai-glm-52": "https://farm/msp/glm-5.2/v1",
    "aifarm-msp/Qwen-38-27B": "https://farm/msp/qwen3.8-27b/v1",
    "aifarm-openai/deepseek-v4-pro-2026-04-23": "https://farm/api/openai",
  });
  assert.deepEqual(loadModelBaseUrls(["/nonexistent/config.json"]), {});
  assert.deepEqual(loadModelBaseUrls([tmpConfig({ providers: { p: { models: { m: {} } } } })]), {}); // no baseURL anywhere
});

test("loadModelPrices skips missing/invalid candidates and returns {}", () => {
  assert.deepEqual(loadModelPrices(["/nonexistent/opencode.json"]), {});
  const file = tmpConfig({ provider: { x: { models: { y: {} } } } }); // nothing with cost
  assert.deepEqual(loadModelPrices([file]), {});
  const bad = tmpConfig({ provider: "not-an-object" });
  assert.deepEqual(loadModelPrices([bad]), {});
});

test("computeCost prices a usage record", () => {
  const prices = loadModelPrices([
    tmpConfig({
      provider: { myprovider: { models: { m: { cost: { input: 0.35, output: 1.4, cache_read: 0.07, cache_write: 0.35 } } } } },
    }),
  ]);
  const c = computeCost(prices, "myprovider/m", {
    input: 20_000,
    output: 2_000,
    cacheRead: 19_000,
    cacheWrite: 0,
  });
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  assert.equal(c.input, round6((20_000 / 1e6) * 0.35));
  assert.equal(c.cache, round6((19_000 / 1e6) * 0.07));
  assert.equal(c.output, round6((2_000 / 1e6) * 1.4));
  assert.equal(c.total, round6(c.input + c.cache + c.output));
});

test("computeCost returns null when model has no price or usage missing", () => {
  const prices = { "p/m": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
  assert.equal(computeCost(prices, "p/other", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(computeCost(prices, "p/m", null), null);
});

test("fmtMoney trims zeros and handles tiny values", () => {
  assert.equal(fmtMoney(0.068), "€0.068");
  assert.equal(fmtMoney(0.014), "€0.014");
  assert.equal(fmtMoney(0.153), "€0.153");
  assert.equal(fmtMoney(0.0003), "€0.0003");
  assert.equal(fmtMoney(12), "€12");
  assert.equal(fmtMoney(null), "—");
});

test("defaultPriceCandidates prefers override then HOME then project", () => {
  const p = defaultPriceCandidates({ projectRoot: "/proj", home: "/home/u", override: "/etc/x.json" });
  assert.deepEqual(p, ["/etc/x.json", "/home/u/.config/opencode/opencode.json", "/proj/docker/opencode.json.template"]);
});

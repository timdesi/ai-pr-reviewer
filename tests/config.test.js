import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig, parseReviewerSkipBranchPairs, parseAutoReviewOffRepos, parsePathPatterns, isTranslationReview } from "../src/config.js";

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("parseAutoReviewOffRepos returns an empty set when unset", () => {
  assert.equal(parseAutoReviewOffRepos("").size, 0);
  assert.equal(parseAutoReviewOffRepos(undefined).size, 0);
  assert.equal(parseAutoReviewOffRepos("  , , ").size, 0);
});

test("parseAutoReviewOffRepos reads comma-separated entries, lowercased", () => {
  const s = parseAutoReviewOffRepos("ACME/acme-app, ACME/acme-gateway-v5,acme/capacity");
  assert.deepEqual([...s], ["acme/acme-app", "acme/acme-gateway-v5", "acme/capacity"]);
});

test("parseAutoReviewOffRepos rejects entries that are not PROJECT/repo-slug", () => {
  assert.throws(() => parseAutoReviewOffRepos("acme-app"), /PROJECT\/repo-slug/);
  assert.throws(() => parseAutoReviewOffRepos("ACME/ppc main"), /PROJECT\/repo-slug/);
  assert.throws(() => parseAutoReviewOffRepos("a/b/c"), /PROJECT\/repo-slug/);
});

test("parseReviewerSkipBranchPairs returns no pairs when unset", () => {
  assert.deepEqual(parseReviewerSkipBranchPairs(""), []);
});

test("parseReviewerSkipBranchPairs reads SOURCE>TARGET pairs", () => {
  assert.deepEqual(parseReviewerSkipBranchPairs("develop>release/*, release/*>develop"), [
    { source: "develop", target: "release/*" },
    { source: "release/*", target: "develop" },
  ]);
});

test("parseReviewerSkipBranchPairs rejects entries that are not SOURCE>TARGET", () => {
  assert.throws(() => parseReviewerSkipBranchPairs("develop"), /SOURCE>TARGET/);
  assert.throws(() => parseReviewerSkipBranchPairs("develop>"), /SOURCE>TARGET/);
  assert.throws(() => parseReviewerSkipBranchPairs("a>b>c"), /SOURCE>TARGET/);
});

test("loadConfig reads the auto-review off list", () => {
  withEnv({ AUTO_REVIEW_OFF_REPOS: "ACME/acme-app,acme/tools" }, () => {
    const config = loadConfig({ envFile: "/nonexistent/none.env" });
    assert.deepEqual([...config.job.autoReviewOffRepos], ["acme/acme-app", "acme/tools"]);
  });
});

test("loadConfig reads the reviewer skip pairs", () => {
  withEnv({ REVIEW_ON_REVIEWER_ADDED_SKIP: "develop>release/*" }, () => {
    const config = loadConfig({ envFile: "/nonexistent/none.env" });
    assert.deepEqual(config.job.reviewOnReviewerAddedSkip, [{ source: "develop", target: "release/*" }]);
  });
});

test("parsePathPatterns defaults to the i18n/gettext patterns when unset", () => {
  const patterns = parsePathPatterns("");
  assert.ok(patterns.length >= 3);
  assert.ok(patterns.some((re) => re.test("src/main/webapp/i18n/cs.json")));
  assert.ok(patterns.some((re) => re.test("i18n/de.json")));
  assert.ok(patterns.some((re) => re.test("locale/messages.po")));
  assert.ok(patterns.some((re) => re.test("locale/messages.pot")));
});

test("parsePathPatterns reads an env override and skips malformed regexes", () => {
  const patterns = parsePathPatterns("i18n/.*\\.json$, (broken");
  assert.equal(patterns.length, 1);
  assert.ok(patterns[0].test("i18n/fr.json"));
  assert.equal(patterns[0].test("app/service.ts"), false);
});

test("isTranslationReview matches when any path hits any pattern", () => {
  const patterns = parsePathPatterns("");
  assert.equal(isTranslationReview(["src/main/webapp/i18n/cs.json"], patterns), true);
  assert.equal(isTranslationReview(["src/main/webapp/i18n/es.json", "app/foo.ts"], patterns), true);
  assert.equal(isTranslationReview(["src/main/webapp/app/foo.ts", "api/bar.java"], patterns), false);
  assert.equal(isTranslationReview([], patterns), false);
  // The reviewer D prompt sample path (PR 4829) must be matched.
  assert.equal(patterns.some((re) => re.test("src/main/webapp/i18n/cs.json")), true);
});

test("loadConfig reads REVIEWER_MODEL_D and defaults translation patterns", () => {
  withEnv({ REVIEWER_MODEL_D: "llmgw-openai/deepseek-v4-pro" }, () => {
    const config = loadConfig({ envFile: "/nonexistent/none.env" });
    assert.equal(config.models.reviewerD, "llmgw-openai/deepseek-v4-pro");
    assert.ok(config.review.translationPathPatterns.length >= 1);
  });
});

test("loadConfig adds reviewer d from persisted model assignments", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-d-"));
  const settings = path.join(dir, ".models.json");
  writeFileSync(settings, JSON.stringify({ d: "myprovider/discretestack-stable" }));
  try {
    withEnv({ MODEL_SETTINGS_FILE: settings }, () => {
      const cfg = loadConfig({ envFile: "/nonexistent/none.env" });
      assert.equal(cfg.models.reviewerD, "myprovider/discretestack-stable");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig refuses to start with an invalid AUTO_REVIEW_OFF_REPOS entry", () => {
  withEnv({ AUTO_REVIEW_OFF_REPOS: "notproject/repo/extra" }, () => {
    assert.throws(() => loadConfig({ envFile: "/nonexistent/none.env" }), /PROJECT\/repo-slug/);
  });
});

test("loadConfig: ui.modelOverrides defaults to the portable example-gateway map", () => {
  withEnv({ MODEL_OVERRIDES_JSON: "" }, () => {
    const config = loadConfig({ envFile: "/nonexistent/none.env" });
    assert.equal(config.ui.modelOverrides["llmgw-gpt/gpt-6-luna"], "GPT-6 Luna");
    assert.ok(Object.keys(config.ui.modelOverrides).length >= 5);
  });
});

test("loadConfig: ui.modelOverrides parses MODEL_OVERRIDES_JSON and ignores malformed JSON", () => {
  withEnv(
    {
      MODEL_OVERRIDES_JSON: JSON.stringify({
        "acme-gpt/gpt-6-luna": "GPT-6 Luna",
        "acme-openai/deepseek-v4-pro": "DeepSeek V4 Pro",
      }),
    },
    () => {
      const config = loadConfig({ envFile: "/nonexistent/none.env" });
      assert.equal(config.ui.modelOverrides["acme-gpt/gpt-6-luna"], "GPT-6 Luna");
      assert.equal(config.ui.modelOverrides["acme-openai/deepseek-v4-pro"], "DeepSeek V4 Pro");
    },
  );
  withEnv({ MODEL_OVERRIDES_JSON: "{not valid json" }, () => {
    // Malformed JSON must not crash startup; falls back to the default map.
    const config = loadConfig({ envFile: "/nonexistent/none.env" });
    assert.equal(config.ui.modelOverrides["llmgw-gpt/gpt-6-luna"], "GPT-6 Luna");
  });
});

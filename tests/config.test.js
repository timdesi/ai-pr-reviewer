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
  withEnv({ REVIEWER_MODEL_D: "prov-gateway/mdl-d" }, () => {
    const config = loadConfig({ envFile: "/nonexistent/none.env" });
    assert.equal(config.models.reviewerD, "prov-gateway/mdl-d");
    assert.ok(config.review.translationPathPatterns.length >= 1);
  });
});

test("vision routing env knobs: parse, defaults are empty, token resolves in candidate order", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cfg-vision-routing-"));
  const settings = path.join(dir, ".models.json");
  writeFileSync(settings, "{}");
  try {
    // A should-be-unset VISION_MODEL (and one explicitly "") both yield "".
    withEnv({ MODEL_SETTINGS_FILE: settings, VISION_MODEL: "" }, () => {
      const saved = process.env.VISION_MODEL;
      delete process.env.VISION_MODEL;
      try {
        const config = loadConfig({ envFile: "/nonexistent/none.env" });
        assert.equal(config.review.visionModel, "");
      } finally {
        if (saved === undefined) delete process.env.VISION_MODEL;
        else process.env.VISION_MODEL = saved;
      }
      assert.equal(loadConfig({ envFile: "/nonexistent/none.env" }).review.visionModel, "");
    });
    // Every knob defaults to an empty value when unset.
    withEnv(
      {
        MODEL_SETTINGS_FILE: settings,
        VISION_GATEWAY_BASE_URL: "",
        VISION_API_VERSION: "",
        VISION_OPENAI_PROVIDERS: "",
        VISION_ANTHROPIC_PROVIDERS: "",
        VISION_BASEURL_PROVIDERS: "",
        VISION_TOKEN_ENV_VARS: "",
      },
      () => {
        const config = loadConfig({ envFile: "/nonexistent/none.env" });
        assert.equal(config.visionRouting.gatewayBaseUrl, "");
        assert.equal(config.visionRouting.apiVersion, "");
        assert.deepEqual(config.visionRouting.providersOpenai, []);
        assert.deepEqual(config.visionRouting.providersAnthropic, []);
        assert.deepEqual(config.visionRouting.providersBaseUrl, []);
        assert.deepEqual(config.visionRouting.tokenEnvVars, []);
        assert.equal(config.visionRouting.token, "");
      },
    );
    // Comma lists parse + trim; the gateway base URL loses its trailing slash.
    withEnv(
      {
        MODEL_SETTINGS_FILE: settings,
        VISION_OPENAI_PROVIDERS: "a,b",
        VISION_ANTHROPIC_PROVIDERS: "x",
        VISION_BASEURL_PROVIDERS: " y , z ",
        VISION_GATEWAY_BASE_URL: "https://gw.example.test/",
        VISION_API_VERSION: "2026-05-01-preview",
      },
      () => {
        const config = loadConfig({ envFile: "/nonexistent/none.env" });
        assert.deepEqual(config.visionRouting.providersOpenai, ["a", "b"]);
        assert.deepEqual(config.visionRouting.providersAnthropic, ["x"]);
        assert.deepEqual(config.visionRouting.providersBaseUrl, ["y", "z"]);
        assert.equal(config.visionRouting.gatewayBaseUrl, "https://gw.example.test");
        assert.equal(config.visionRouting.apiVersion, "2026-05-01-preview");
      },
    );
    // Token: first candidate with a non-empty trimmed value wins.
    withEnv(
      {
        MODEL_SETTINGS_FILE: settings,
        VISION_TOKEN_ENV_VARS: "FIRST_TOK_VAR, SECOND_TOK_VAR",
        FIRST_TOK_VAR: "first-value",
        SECOND_TOK_VAR: "second-value",
      },
      () => {
        const config = loadConfig({ envFile: "/nonexistent/none.env" });
        assert.equal(config.visionRouting.token, "first-value");
      },
    );
    withEnv(
      {
        MODEL_SETTINGS_FILE: settings,
        VISION_TOKEN_ENV_VARS: "FIRST_TOK_VAR, SECOND_TOK_VAR",
        FIRST_TOK_VAR: "   ",
        SECOND_TOK_VAR: "second-value",
      },
      () => {
        const config = loadConfig({ envFile: "/nonexistent/none.env" });
        assert.equal(config.visionRouting.token, "second-value");
      },
    );
    withEnv(
      {
        MODEL_SETTINGS_FILE: settings,
        VISION_TOKEN_ENV_VARS: "FIRST_TOK_VAR, SECOND_TOK_VAR",
      },
      () => {
        const config = loadConfig({ envFile: "/nonexistent/none.env" });
        assert.equal(config.visionRouting.token, "");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

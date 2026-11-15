// Job-name namespacing (src/pipeline.js): GitHub job prefixes must never share
// a namespace with a Bitbucket job directory, even when a Bitbucket project key
// is literally `GITHUB` (or lowercases to `github`). Bitbucket prefixes stay
// byte-for-byte unchanged so existing job dirs remain readable/linked.

import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitize, jobPrefixFor } from "../src/pipeline.js";

test("jobPrefixFor: Bitbucket prefixes stay byte-for-byte unchanged", () => {
  assert.equal(jobPrefixFor({ projectKey: "ACME", repoSlug: "acme-app", prId: 42 }), "ACME-acme-app-PR42-");
  // Bitbucket as-is includes spaces/punctuation only in what sanitize strips.
  assert.equal(jobPrefixFor({ projectKey: "A.CME", repoSlug: "app two", prId: 7 }), "A.CME-app-two-PR7-");
});

test("jobPrefixFor: GitHub is namespaced with github@ (cannot be produced by Bitbucket)", () => {
  assert.equal(
    jobPrefixFor({ projectKey: "acme", repoSlug: "widgets", prId: 3, platform: "github" }),
    "github@acme-widgets-PR3-",
  );
  // Worst collision: a Bitbucket project key literally `GITHUB` folds to the
  // `github-` shape — with the @ separator the GitHub handle stays distinct.
  const bb = jobPrefixFor({ projectKey: "GITHUB", repoSlug: "widgets", prId: 3 });
  const gh = jobPrefixFor({ projectKey: "acme", repoSlug: "widgets", prId: 3, platform: "github" });
  assert.notEqual(bb, gh);
  assert.ok(!gh.startsWith("github-"), "GitHub prefix must not look like a Bitbucket github- prefix");
  // A genuinely lowercase `github` Bitbucket key still cannot match.
  assert.notEqual(jobPrefixFor({ projectKey: "github", repoSlug: "widgets", prId: 3 }), gh);
});

test("sanitize preserves the @ namespace marker and folds the rest", () => {
  assert.equal(sanitize("github@A.CME app_P3"), "github@A.CME-app_P3");
  assert.equal(sanitize("no markers here"), "no-markers-here");
});

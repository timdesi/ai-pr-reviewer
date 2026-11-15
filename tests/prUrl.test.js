// PR reference parsing: Bitbucket forms must stay byte-for-byte compatible
// (default platform "bitbucket") while the GitHub forms (`gh:` prefix, /pull/
// URLs) return platform "github" with owner/repo as projectKey/repoSlug.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePrRef } from "../src/prUrl.js";

test("Bitbucket PR URLs keep platform bitbucket", () => {
  assert.deepEqual(
    parsePrRef("https://bitbucket.example.com/projects/ACME/repos/acme-app/pull-requests/5566/overview"),
    { projectKey: "ACME", repoSlug: "acme-app", prId: 5566, platform: "bitbucket" },
  );
  assert.equal(parsePrRef("https://bitbucket.example.com/projects/ACME/repos/acme-app/pull-requests/3").platform, "bitbucket");
});

test("Bitbucket short refs default to bitbucket", () => {
  assert.deepEqual(parsePrRef("ACME/acme-app#5566"), {
    projectKey: "ACME",
    repoSlug: "acme-app",
    prId: 5566,
    platform: "bitbucket",
  });
  assert.deepEqual(parsePrRef("ACME/acme-app/7"), {
    projectKey: "ACME",
    repoSlug: "acme-app",
    prId: 7,
    platform: "bitbucket",
  });
});

test("GitHub PR URLs parse as platform github with owner/repo", () => {
  assert.deepEqual(parsePrRef("https://github.com/acme/widgets/pull/42"), {
    projectKey: "acme",
    repoSlug: "widgets",
    prId: 42,
    platform: "github",
  });
  // GitHub Enterprise Server host works too.
  assert.deepEqual(parsePrRef("https://ghes.example.com/team/svc/pull/7"), {
    projectKey: "team",
    repoSlug: "svc",
    prId: 7,
    platform: "github",
  });
  // Host-less GitHub-style `owner/repo/pull/N` is unambiguously GitHub.
  assert.equal(parsePrRef("acme/widgets/pull/9").platform, "github");
});

test("gh: prefix forces the GitHub platform", () => {
  assert.deepEqual(parsePrRef("gh:acme/widgets#12"), {
    projectKey: "acme",
    repoSlug: "widgets",
    prId: 12,
    platform: "github",
  });
  assert.equal(parsePrRef("gh:https://github.com/acme/widgets/pull/12").platform, "github");
  assert.equal(parsePrRef("gh:ACME/acme-app#1").platform, "github");
});

test("invalid references throw a readable error", () => {
  assert.throws(() => parsePrRef(""), /Missing pull request reference/);
  assert.throws(() => parsePrRef("not-a-ref"), /Unrecognized pull request reference/);
  assert.throws(() => parsePrRef(null), /Missing pull request reference/);
});

// Platform client factory + publish gate + URL builders (src/clients.js).
// These govern the per-platform contract — a regression here could publish a
// GitHub review while PUBLISH_TO_GITHUB=0, or deep-link to the wrong host.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createReviewClient,
  backendConfig,
  botUsernamesOf,
  prCommentUrl,
  reportBaseUrl,
  shouldPublish,
} from "../src/clients.js";
import { GitHubClient } from "../src/github.js";
import { BitbucketClient } from "../src/bitbucket.js";

const GH_REF = { projectKey: "acme", repoSlug: "widgets", prId: 42, platform: "github" };
const BB_REF = { projectKey: "ACME", repoSlug: "acme-app", prId: 7 };

const config = {
  bitbucket: { baseUrl: "https://bb.example.com", token: "t", username: "mybot-bb" },
  github: { baseUrl: "https://api.github.com", token: "t", username: "mybot-gh" },
  job: { dryRun: true, publishToGithub: false },
};

test("createReviewClient picks the client for the ref's platform", () => {
  assert.ok(createReviewClient(config, GH_REF) instanceof GitHubClient);
  assert.ok(createReviewClient(config, BB_REF) instanceof BitbucketClient);
  // Default (no platform field) is Bitbucket.
  assert.ok(createReviewClient(config, { projectKey: "ACME", repoSlug: "app", prId: 1 }) instanceof BitbucketClient);
});

test("backendConfig returns the config block of the ref's platform", () => {
  assert.equal(backendConfig(config, GH_REF), config.github);
  assert.equal(backendConfig(config, BB_REF), config.bitbucket);
});

test("botUsernamesOf uses the per-platform bot identity", () => {
  assert.deepEqual(botUsernamesOf(config, GH_REF), ["mybot-gh"]);
  assert.deepEqual(botUsernamesOf(config, BB_REF), ["mybot-bb"]);
  // A GitHub-only instance (no bitbucket username) yields an empty list.
  assert.deepEqual(botUsernamesOf({ ...config, bitbucket: {} }, GH_REF), ["mybot-gh"]);
});

test("shouldPublish: GitHub is gated by PUBLISH_TO_GITHUB (independent of dry-run)", () => {
  assert.equal(shouldPublish(config, GH_REF), false, "publishToGithub default off");
  assert.equal(shouldPublish({ ...config, job: { ...config.job, publishToGithub: true } }, GH_REF), true);
  // Even with dry-run on (bitbucket off), the GitHub gate alone wins.
  assert.equal(shouldPublish({ ...config, job: { dryRun: true, publishToGithub: true } }, GH_REF), true);
});

test("shouldPublish: Bitbucket is gated by dry-run (PUBLISH_TO_BITBUCKET)", () => {
  assert.equal(shouldPublish(config, BB_REF), false, "dryRun true → don't publish");
  assert.equal(shouldPublish({ ...config, job: { dryRun: false } }, BB_REF), true);
  // The GitHub flag must not leak to a Bitbucket ref.
  assert.equal(shouldPublish({ ...config, job: { dryRun: true, publishToGithub: true } }, BB_REF), false);
});

test("shouldPublish: PUBLISH_TO_BITBUCKET=1 alone must NOT publish a GitHub ref (CLI regression)", () => {
  // The CLI computed publish from the Bitbucket-only !dryRun flag, so with
  // PUBLISH_TO_BITBUCKET=1 (dryRun false) and PUBLISH_TO_GITHUB=0 a CLI run on
  // a GitHub ref posted the comment anyway. The platform gate must refuse.
  assert.equal(shouldPublish({ ...config, job: { dryRun: false, publishToGithub: false } }, GH_REF), false);
  // Turning the GitHub flag on is the only thing that publishes GitHub refs.
  assert.equal(shouldPublish({ ...config, job: { dryRun: false, publishToGithub: true } }, GH_REF), true);
});

test("prCommentUrl: GitHub anchors the PR's own html_url", () => {
  const url = prCommentUrl({
    ref: GH_REF,
    pullRequest: { htmlUrl: "https://github.com/acme/widgets/pull/42?diff=split" },
    client: null,
    commentId: 9001,
  });
  assert.equal(url, "https://github.com/acme/widgets/pull/42#issuecomment-9001");
});

test("prCommentUrl: GitHub without html_url derives the pull page from the API base", () => {
  // github.com API base -> github.com web root (no Bitbucket-style fallthrough).
  const url = prCommentUrl({
    ref: GH_REF,
    pullRequest: {},
    client: { baseUrl: "https://api.github.com/" },
    commentId: 9001,
  });
  assert.equal(url, "https://github.com/acme/widgets/pull/42#issuecomment-9001");
  // GHES API base -> the GHES web root.
  const ghes = prCommentUrl({
    ref: GH_REF,
    pullRequest: {},
    client: { baseUrl: "https://git.example.com/api/v3" },
    commentId: 9001,
  });
  assert.equal(ghes, "https://git.example.com/acme/widgets/pull/42#issuecomment-9001");
});

test("prCommentUrl: Bitbucket deep-links via the server + ?comment=", () => {
  const url = prCommentUrl({
    ref: BB_REF,
    client: { baseUrl: "https://bb.example.com" },
    commentId: 77,
  });
  assert.equal(url, "https://bb.example.com/projects/ACME/repos/acme-app/pull-requests/7?comment=77");
});

test("reportBaseUrl: GitHub is the repo web root (no /pull/N path)", () => {
  assert.equal(
    reportBaseUrl({
      config,
      ref: GH_REF,
      pullRequest: { htmlUrl: "https://github.com/acme/widgets/pull/42" },
    }),
    "https://github.com/acme/widgets",
  );
  // No html_url (e.g. pre-fetch) — falls back to an empty string.
  assert.equal(reportBaseUrl({ config, ref: GH_REF, pullRequest: {} }), "");
});

test("reportBaseUrl: Bitbucket is the server origin", () => {
  assert.equal(reportBaseUrl({ config, ref: BB_REF, pullRequest: {} }), "https://bb.example.com");
});

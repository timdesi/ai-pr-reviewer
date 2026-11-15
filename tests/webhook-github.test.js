// GitHub webhook parsing (src/webhook-github.js): mirrors the Bitbucket trigger
// semantics so the server's dedup/queue/publish logic works unchanged.
//
//   event ping                           -> accepted (status 200), triggers nothing
//   issue_comment "/ai-review..."         -> manual trigger (ok)
//   pull_request opened/ready/review_requested, non-draft, allowed reviewer -> ok
//   drafts, non-review actions, off-list / skipped pairs -> ignored (status 200)
//   unauthorized actors                   -> 403

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGitHubWebhookRequest } from "../src/webhook-github.js";

/** A minimal GitHub pull_request payload. */
function prPayload({ action = "opened", owner = "acme", repo = "widgets", number = 42, draft = false, headSha = "abc1234", headRef = "feat/x", baseRef = "main", requested = ["timdesi"], sender = "timdesi", state = "open" } = {}) {
  return {
    action,
    sender: { login: sender },
    requested_reviewer: { login: requested[0] || null },
    repository: { full_name: `${owner}/${repo}`, name: repo, owner: { login: owner } },
    pull_request: {
      number,
      title: "Add widgets",
      body: "...",
      draft,
      state,
      head: { sha: headSha, ref: headRef, repo: { name: repo, owner: { login: owner } } },
      base: { sha: "e1e1e1", ref: baseRef, repo: { name: repo, owner: { login: owner } } },
      requested_reviewers: requested.map((login) => ({ login })),
    },
  };
}

/** A minimal issue_comment payload (manual /ai-review triggers). */
function commentPayload({ action = "created", owner = "acme", repo = "widgets", number = 42, body = "/ai-review", sender = "timdesi", commentId = 9001, onPr = true } = {}) {
  return {
    action,
    sender: { login: sender },
    repository: { full_name: `${owner}/${repo}`, name: repo, owner: { login: owner } },
    // For a PR, GitHub fills issue.pull_request; a plain issue omits it.
    issue: onPr ? { number, pull_request: { url: "x", html_url: "y" } } : { number },
    comment: { id: commentId, body, user: { login: sender } },
  };
}

test("ping events are acknowledged and trigger nothing", () => {
  const r = parseGitHubWebhookRequest({ headers: { "x-github-event": "ping" }, payload: { zen: "..." } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.equal(r.ignored, "ping");
});

test("unknown events are ignored with 200 (no GitHub retries)", () => {
  const r = parseGitHubWebhookRequest({ headers: { "x-github-event": "issues" }, payload: { action: "opened" } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /not a review trigger/);
});

test("a created /ai-review comment is a manual trigger", () => {
  const r = parseGitHubWebhookRequest({ headers: { "x-github-event": "issue_comment" }, payload: commentPayload() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ref, { projectKey: "acme", repoSlug: "widgets", prId: 42, platform: "github" });
  assert.equal(r.actor, "timdesi");
  assert.equal(r.text, "/ai-review");
  assert.equal(r.commentId, 9001);
  // issue_comment payloads carry no head SHA.
  assert.equal(r.head, null);
});

test("a comment that is not a trigger is ignored", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "issue_comment" },
    payload: commentPayload({ body: "just chatting" }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /not an \/ai-review trigger/);
});

test("non-created issue_comment actions are ignored", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "issue_comment" },
    payload: commentPayload({ action: "deleted" }),
  });
  assert.equal(r.ok, false);
  assert.match(r.ignored, /action deleted/);
});

test("ALLOWED_REVIEWER_USERS gates manual triggers (403 when set and not allowed)", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "issue_comment" },
    payload: commentPayload({ sender: "intruder" }),
    allowedUsers: ["timdesi"],
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error, /intruder is not authorized/);
});

test("ALLOWED_REVIEWER_USERS admits matching commenters (case-insensitively)", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "issue_comment" },
    payload: commentPayload(),
    allowedUsers: ["TimDesi"],
  });
  assert.equal(r.ok, true);
});

test("an /ai-review comment on a plain issue (not a PR) is ignored, not queued", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "issue_comment" },
    payload: commentPayload({ onPr: false }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /on an issue, not a pull request/);
});

test("pr:opened with an allowed requested reviewer starts a review", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "pull_request" },
    payload: prPayload({ action: "opened" }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, "opened");
  assert.equal(r.reviewer, "timdesi");
  assert.equal(r.head, "abc1234");
  assert.equal(r.ref.platform, "github");
});

test("pr:opened as a draft waits until it is marked ready", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "pull_request" },
    payload: prPayload({ action: "opened", draft: true }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /draft/);
});

test("pr:opened without an allowed requested reviewer is ignored", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "pull_request" },
    payload: prPayload({ requested: ["someone-else"], sender: "someone-else" }),
    allowedUsers: ["timdesi"],
  });
  // Not in the allowlist, so neither opener nor reviewer qualifies.
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /no allowed user is a requested reviewer/);
});

test("pr:ready_for_review is a trigger once a draft is marked ready", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "pull_request" },
    payload: prPayload({ action: "ready_for_review" }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, "marked-ready");
  assert.equal(r.head, "abc1234");
});

test("pr:ready_for_review while still a draft is ignored", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "pull_request" },
    payload: prPayload({ action: "ready_for_review", draft: true }),
  });
  assert.equal(r.ok, false);
  assert.match(r.ignored, /still a draft/);
});

test("pr:review_requested with an allowed reviewer starts a review", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "pull_request" },
    payload: prPayload({ action: "review_requested" }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, "reviewer-added");
  assert.equal(r.reviewer, "timdesi");
});

test("pr:review_requested on a still-open draft is ignored (drafts wait)", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "pull_request" },
    payload: prPayload({ action: "review_requested", draft: true }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /still a draft/);
});

test("pr:review_requested for a TEAM is ignored even when an allowed user is already requested", () => {
  // GitHub sends requested_reviewer=null + requested_team for a team request,
  // while pr.requested_reviewers may still list an allowed user. The old
  // fallback to requested[0] would have let the team request start a review.
  const payload = prPayload({ action: "review_requested", requested: ["timdesi"] });
  payload.requested_reviewer = null;
  payload.requested_team = { id: 7, name: "reviews-team", slug: "reviews-team" };
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "pull_request" },
    payload,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /team was requested/);
  // An empty allowlist must not start a review for a team request either.
  const open = parseGitHubWebhookRequest({
    headers: { "x-github-event": "pull_request" },
    payload,
    allowedUsers: [],
  });
  assert.equal(open.ok, false);
});

test("pr:review_requested with no allowlist triggers for any requested reviewer", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "pull_request" },
    payload: prPayload({ action: "review_requested", requested: ["nobody"] }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.reviewer, "nobody");
});

test("pr:review_requested with an allowlist ignores a reviewer outside it", () => {
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "pull_request" },
    payload: prPayload({ action: "review_requested", requested: ["nobody"], sender: "timdesi" }),
    allowedUsers: ["timdesi"],
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /no allowed user was requested/);
});

test("non-trigger pull_request actions (synchronize, closed, opened-as-review) are ignored", () => {
  for (const action of ["synchronize", "closed", "reopened", "edited"]) {
    const r = parseGitHubWebhookRequest({
      headers: { "x-github-event": "pull_request" },
      payload: prPayload({ action }),
    });
    assert.equal(r.ok, false, `${action} should be ignored`);
    assert.equal(r.status, 200, `${action} should not error`);
    assert.match(r.ignored, /not a review trigger/);
  }
});

test("GITHUB_AUTO_REVIEW_OFF_REPOS switches auto triggers off for matching repos", () => {
  const off = new Set(["acme/widgets"]);
  for (const action of ["opened", "ready_for_review", "review_requested"]) {
    const r = parseGitHubWebhookRequest({
      headers: { "x-github-event": "pull_request" },
      payload: prPayload({ action }),
      autoReviewOffRepos: off,
    });
    assert.equal(r.ok, false, `${action} should be off`);
    assert.equal(r.status, 200);
    assert.match(r.ignored, /auto review is off for acme\/widgets/);
  }
  // Manual /ai-review comments still work on off-list repos.
  const manual = parseGitHubWebhookRequest({
    headers: { "x-github-event": "issue_comment" },
    payload: commentPayload(),
    autoReviewOffRepos: off,
  });
  assert.equal(manual.ok, true);
});

test("REVIEW_ON_REVIEWER_ADDED_SKIP skips matching source -> target pairs", () => {
  const pairs = [{ source: "release/*", target: "main" }];
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "pull_request" },
    payload: prPayload({ action: "opened", headRef: "release/1.2.0", baseRef: "main" }),
    reviewerSkipBranchPairs: pairs,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /release\/1\.2\.0 -> main/);
});

test("branch-pair skip does not match unrelated pairs", () => {
  const pairs = [{ source: "release/*", target: "main" }];
  const r = parseGitHubWebhookRequest({
    headers: { "x-github-event": "pull_request" },
    payload: prPayload({ action: "opened", headRef: "feat/x", baseRef: "main" }),
    reviewerSkipBranchPairs: pairs,
  });
  assert.equal(r.ok, true);
});

test("payloads without a resolvable PR ref are rejected with 400", () => {
  for (const payload of [{}, { repository: { name: "widgets" } }, { repository: { name: "widgets", owner: { login: "acme" } }, issue: {} }]) {
    const r = parseGitHubWebhookRequest({
      headers: { "x-github-event": "pull_request" },
      payload,
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.match(r.error, /no repository\.owner\.login/);
  }
});

test("a payload with no usable event header is ignored", () => {
  const r = parseGitHubWebhookRequest({ payload: prPayload() });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
});

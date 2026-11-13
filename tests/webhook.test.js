import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { isReviewTrigger, isForceReview, verifySignature, parseWebhookRequest, isUnsignedDiagnostic } from "../src/webhook.js";

test("isReviewTrigger", () => {
  assert.ok(isReviewTrigger("/ai-review"));
  assert.ok(isReviewTrigger("/ai-review please"));
  assert.ok(isReviewTrigger("  /ai-review  "));
  assert.ok(isReviewTrigger("/AI-REVIEW"));
  assert.ok(isReviewTrigger("/ai-review\nfollow-up"));
  // leading slash is optional
  assert.ok(isReviewTrigger("ai-review"));
  assert.ok(isReviewTrigger("ai-review thanks"));
  assert.ok(isReviewTrigger("  AI-Review  "));
  assert.ok(!isReviewTrigger("lgtm"));
  assert.ok(!isReviewTrigger(""));
  assert.ok(!isReviewTrigger("ai-reviewer please")); // not the trigger word
  assert.ok(!isReviewTrigger("prefix /ai-review"));
});

test("isForceReview flags only an /ai-review that asks for a forced re-run", () => {
  assert.ok(isForceReview("/ai-review --force"));
  assert.ok(isForceReview("/ai-review -force"));
  assert.ok(isForceReview("/ai-review  --force "));
  assert.ok(isForceReview("ai-review --force please"));
  assert.ok(isForceReview("/ai-review --force\nre-run"));
  assert.ok(!isForceReview("/ai-review"));
  assert.ok(!isForceReview("/ai-review 20 force times"));
  assert.ok(!isForceReview("--force"));
  assert.ok(!isForceReview(""));
  assert.ok(!isForceReview("/ai-review --forced"));
});

test("verifySignature accepts a correct HMAC", () => {
  const secret = "s3cret";
  const body = '{"eventKey":"pr:comment:added"}';
  const good = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.deepEqual(verifySignature(body, good, secret), { ok: true, reason: null });
});

test("verifySignature rejects wrong/tampered/missing signatures", () => {
  const secret = "s3cret";
  const body = '{"eventKey":"pr:comment:added"}';
  assert.equal(verifySignature(body, "sha256=deadbeef", secret).ok, false);
  assert.equal(verifySignature(body, "sha256=deadbeef", secret).reason, "signature mismatch");
  assert.equal(verifySignature(body, null, secret).ok, false);
  assert.equal(verifySignature(body, undefined, secret).ok, false);
  // tampered body vs signature computed for another body
  const other = `sha256=${createHmac("sha256", secret).update('{"eventKey":"x"}').digest("hex")}`;
  assert.equal(verifySignature(body, other, secret).ok, false);
});

test("verifySignature skips the check when no secret is configured", () => {
  assert.deepEqual(verifySignature('{}', null, ""), { ok: true, reason: null });
});

test("isUnsignedDiagnostic flags the Bitbucket test-connection ping only", () => {
  assert.ok(isUnsignedDiagnostic("diagnostics:ping"));
  assert.ok(isUnsignedDiagnostic("DIAGNOSTICS:PING"));
  assert.ok(!isUnsignedDiagnostic("pr:comment:added"));
  assert.ok(!isUnsignedDiagnostic(undefined));
  assert.ok(!isUnsignedDiagnostic(""));
});

const pr = { id: 42, fromRef: { repository: { slug: "my-repo", project: { key: "PROJ" } } } };
const base = { eventKey: "pr:comment:added", actor: { userName: "alice" }, pullRequest: pr, comment: { text: "/ai-review" } };

test("parseWebhookRequest returns the ref for a valid trigger", () => {
  const r = parseWebhookRequest({ payload: base });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ref, { projectKey: "PROJ", repoSlug: "my-repo", prId: 42 });
  assert.equal(r.actor, "alice");
  assert.equal(r.text, "/ai-review");
  // The comment trigger is explicit/manual — no reviewer is attached, and the
  // head is absent from the fixture (no latestCommit / id on fromRef).
  assert.equal(r.reviewer, undefined);
  assert.equal(r.head, null);
});

test("parseWebhookRequest carries the head commit for a comment trigger (for the /ai-review gate)", () => {
  const withHead = {
    ...base,
    pullRequest: {
      ...base.pullRequest,
      fromRef: { ...base.pullRequest.fromRef, latestCommit: "cafebabe1234" },
    },
  };
  const r = parseWebhookRequest({ payload: withHead });
  assert.equal(r.ok, true);
  assert.equal(r.head, "cafebabe1234");
  // Falls back to fromRef.id when latestCommit is absent.
  const noLatest = { ...base, pullRequest: { ...base.pullRequest, fromRef: { id: "refs/heads/feature/x", repository: base.pullRequest.fromRef.repository } } };
  assert.equal(parseWebhookRequest({ payload: noLatest }).head, "refs/heads/feature/x");
});

test("parseWebhookRequest ignores other events", () => {
  const r = parseWebhookRequest({ payload: { ...base, eventKey: "pr:comment:edited" } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /not pr:comment:added/);
});

test("parseWebhookRequest ignores non-trigger comments", () => {
  const r = parseWebhookRequest({ payload: { ...base, comment: { text: "thanks!" } } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /not an \/ai-review/);
});

test("parseWebhookRequest rejects unauthorized commenters", () => {
  const r = parseWebhookRequest({ payload: base, allowedUsers: ["carol"] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("parseWebhookRequest accepts authorized commenters", () => {
  const r = parseWebhookRequest({ payload: base, allowedUsers: ["alice", "carol"] });
  assert.equal(r.ok, true);
});

// Bitbucket Data Center 5.0+ sends `slug` (login) and `name` (display name);
// `userName` is a Bitbucket Cloud field and is absent here.
const dc = {
  eventKey: "pr:comment:added",
  actor: { name: "Example Reviewer (X-DEPT)", displayName: "Example Reviewer (X-DEPT)", slug: "MYBOT", type: "NORMAL" },
  pullRequest: { id: 5566, fromRef: { repository: { slug: "acme-app", project: { key: "ACME" } } } },
  comment: { id: 1, text: "/ai-review", author: { name: "Example Reviewer (X-DEPT)", slug: "MYBOT" } },
};

test("parseWebhookRequest resolves the Data Center actor slug", () => {
  const r = parseWebhookRequest({ payload: dc });
  assert.equal(r.ok, true);
  assert.equal(r.actor, "MYBOT");
  assert.deepEqual(r.ref, { projectKey: "ACME", repoSlug: "acme-app", prId: 5566 });
  // The triggering /ai-review comment id is surfaced so a skipped re-review can
  // reply to it (e.g. teaching --force).
  assert.equal(r.commentId, 1);
  const withOutId = parseWebhookRequest({ payload: { ...dc, comment: { text: "/ai-review" } } });
  assert.equal(withOutId.commentId, null);
});

test("parseWebhookRequest matches the allowlist case-insensitively", () => {
  assert.equal(parseWebhookRequest({ payload: dc, allowedUsers: ["mybot"] }).ok, true);
  assert.equal(parseWebhookRequest({ payload: dc, allowedUsers: ["MYBOT"] }).ok, true);
  assert.equal(parseWebhookRequest({ payload: dc, allowedUsers: ["someoneelse"] }).status, 403);
});

test("parseWebhookRequest falls back to comment.author when actor is absent", () => {
  const payload = { ...dc, actor: undefined };
  const r = parseWebhookRequest({ payload, allowedUsers: ["mybot"] });
  assert.equal(r.ok, true);
  assert.equal(r.actor, "MYBOT");
});

test("parseWebhookRequest reports the candidate usernames when rejecting", () => {
  const r = parseWebhookRequest({ payload: dc, allowedUsers: ["nobody"] });
  assert.equal(r.status, 403);
  assert.match(r.error, /MYBOT/);
});

test("parseWebhookRequest rejects payloads without ref info", () => {
  const r = parseWebhookRequest({ payload: { ...base, pullRequest: {} } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test("parseWebhookRequest rejects empty/invalid payloads", () => {
  assert.equal(parseWebhookRequest({ payload: null }).status, 400);
  assert.equal(parseWebhookRequest({ payload: "nope" }).status, 400);
});

// ---- automatic trigger: pr:reviewer:updated -------------------------------
// Model: auto-review is ON by default for every repo, OFF for the repos listed
// in AUTO_REVIEW_OFF_REPOS. An allowed user among the added reviewers starts
// one; the user who added them must also be allowed.

const reviewerAdded = {
  eventKey: "pr:reviewer:updated",
  actor: { name: "alice", slug: "alice", type: "NORMAL" },
  pullRequest: { id: 5566, fromRef: { repository: { slug: "acme-app", project: { key: "ACME" } } } },
  addedReviewers: [
    { name: "Example Reviewer (X-DEPT)", displayName: "Example Reviewer (X-DEPT)", slug: "MYBOT", type: "NORMAL" },
  ],
  removedReviewers: [],
};
// adder (alice) + added reviewer (MYBOT) both allowed
const ALLOWED_PAIR = ["alice", "MYBOT"];

test("parseWebhookRequest auto-triggers when an allowed user is added as reviewer", () => {
  const r = parseWebhookRequest({ payload: reviewerAdded, allowedUsers: ALLOWED_PAIR });
  assert.equal(r.ok, true);
  assert.equal(r.reviewer, "MYBOT");
  assert.equal(r.actor, "alice");
  assert.deepEqual(r.ref, { projectKey: "ACME", repoSlug: "acme-app", prId: 5566 });
  assert.equal(r.via, "reviewer-added");
});

test("parseWebhookRequest carries the head commit for reviewer triggers", () => {
  const withHead = {
    ...reviewerAdded,
    pullRequest: {
      ...reviewerAdded.pullRequest,
      fromRef: { ...reviewerAdded.pullRequest.fromRef, latestCommit: "abc123def456" },
    },
  };
  const added = parseWebhookRequest({ payload: withHead, allowedUsers: ALLOWED_PAIR });
  assert.equal(added.head, "abc123def456");

  const opened = reviewRequested("pr:opened");
  opened.pullRequest.fromRef.latestCommit = "feedbeefcafe";
  const ro = parseWebhookRequest({ payload: opened, allowedUsers: ALLOWED_PAIR });
  assert.equal(ro.head, "feedbeefcafe");

  // Falls back to fromRef.id when latestCommit is absent.
  const noLatest = { ...reviewerAdded, pullRequest: { ...reviewerAdded.pullRequest, fromRef: { id: "refs/heads/feature/login", repository: reviewerAdded.pullRequest.fromRef.repository } } };
  const fb = parseWebhookRequest({ payload: noLatest, allowedUsers: ALLOWED_PAIR });
  assert.equal(fb.head, "refs/heads/feature/login");
});

test("parseWebhookRequest matches the allowed users case-insensitively", () => {
  assert.equal(parseWebhookRequest({ payload: reviewerAdded, allowedUsers: ["alice", "mybot"] }).ok, true);
});

test("parseWebhookRequest ignores reviewer events that add no allowed user", () => {
  // someoneelse is on no list, so the added reviewer is not allowed
  const r = parseWebhookRequest({ payload: reviewerAdded, allowedUsers: ["alice", "someoneelse"] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /no allowed user was added as reviewer/);
});

test("parseWebhookRequest auto-triggers for any added reviewer when the allowlist is empty (anyone)", () => {
  const r = parseWebhookRequest({ payload: reviewerAdded });
  assert.equal(r.ok, true);
  assert.equal(r.reviewer, "MYBOT");
});

test("parseWebhookRequest ignores removed reviewers", () => {
  const payload = { ...reviewerAdded, addedReviewers: [], removedReviewers: reviewerAdded.addedReviewers };
  const r = parseWebhookRequest({ payload, allowedUsers: ALLOWED_PAIR });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
});

test("parseWebhookRequest requires the user who added the reviewer to be allowed", () => {
  const denied = parseWebhookRequest({ payload: reviewerAdded, allowedUsers: ["carol", "MYBOT"] });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.match(denied.error, /alice/);
  assert.equal(parseWebhookRequest({ payload: reviewerAdded, allowedUsers: ALLOWED_PAIR }).ok, true);
});

test("parseWebhookRequest checks the adder only when an allowed reviewer was added", () => {
  const payload = { ...reviewerAdded, addedReviewers: [] };
  const r = parseWebhookRequest({ payload, allowedUsers: ["carol", "MYBOT"] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
});

const app2 = {
  ...reviewerAdded,
  pullRequest: { id: 77, fromRef: { repository: { slug: "acme-app2", project: { key: "ACME" } } } },
};

test("parseWebhookRequest is OFF for a repository on AUTO_REVIEW_OFF_REPOS", () => {
  const off = new Set(["acme/acme-app2"]);
  const r = parseWebhookRequest({ payload: app2, allowedUsers: ALLOWED_PAIR, autoReviewOffRepos: off });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /auto review is off for ACME\/acme-app2/);
});

test("parseWebhookRequest is ON by default for repositories not on the off list", () => {
  const r = parseWebhookRequest({ payload: app2, allowedUsers: ALLOWED_PAIR });
  assert.equal(r.ok, true);
});

test("parseWebhookRequest keys the off check by the target repository, not the fork", () => {
  const fork = {
    ...reviewerAdded,
    pullRequest: {
      id: 5566,
      fromRef: { repository: { slug: "acme-app", project: { key: "~MYBOT" } } },
      toRef: { repository: { slug: "acme-app", project: { key: "ACME" } } },
    },
  };
  // the fork (~MYBOT) is never matched; the owning (target) repo decides
  const off = parseWebhookRequest({ payload: fork, allowedUsers: ALLOWED_PAIR, autoReviewOffRepos: new Set(["acme/acme-app"]) });
  assert.equal(off.ok, false);
  assert.match(off.ignored, /off for ACME\/acme-app/);
  assert.equal(parseWebhookRequest({ payload: fork, allowedUsers: ALLOWED_PAIR }).ok, true);
});

test("parseWebhookRequest rejects reviewer events without ref info", () => {
  const r = parseWebhookRequest({ payload: { ...reviewerAdded, pullRequest: {} }, allowedUsers: ALLOWED_PAIR });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

const branchPr = (source, target) => ({
  ...reviewerAdded,
  pullRequest: {
    id: 5566,
    fromRef: { id: `refs/heads/${source}`, displayId: source, repository: { slug: "acme-app", project: { key: "ACME" } } },
    toRef: { id: `refs/heads/${target}`, displayId: target, repository: { slug: "acme-app", project: { key: "ACME" } } },
  },
});
const skipPairs = [
  { source: "develop", target: "release/*" },
  { source: "release/*", target: "develop" },
];

test("parseWebhookRequest skips an auto review for a develop to release merge", () => {
  const r = parseWebhookRequest({ payload: branchPr("develop", "release/14.x"), allowedUsers: ALLOWED_PAIR, reviewerSkipBranchPairs: skipPairs });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /skipped for develop -> release\/14\.x/);
});

test("parseWebhookRequest skips the reverse merge from release back to develop", () => {
  const r = parseWebhookRequest({ payload: branchPr("release/14.x", "develop"), allowedUsers: ALLOWED_PAIR, reviewerSkipBranchPairs: skipPairs });
  assert.equal(r.ok, false);
  assert.match(r.ignored, /skipped/);
});

test("parseWebhookRequest still triggers for other branch pairs", () => {
  const r = parseWebhookRequest({ payload: branchPr("feature/login", "develop"), allowedUsers: ALLOWED_PAIR, reviewerSkipBranchPairs: skipPairs });
  assert.equal(r.ok, true);
});

test("parseWebhookRequest matches skipped branch names case-insensitively", () => {
  const r = parseWebhookRequest({ payload: branchPr("Develop", "RELEASE/14.X"), allowedUsers: ALLOWED_PAIR, reviewerSkipBranchPairs: skipPairs });
  assert.equal(r.ok, false);
  assert.match(r.ignored, /skipped/);
});

test("parseWebhookRequest triggers a merge PR when no skip pairs are configured", () => {
  const r = parseWebhookRequest({ payload: branchPr("develop", "release/14.x"), allowedUsers: ALLOWED_PAIR });
  assert.equal(r.ok, true);
});

test("parseWebhookRequest reads the branch from the ref id when displayId is absent", () => {
  const payload = branchPr("develop", "release/14.x");
  payload.pullRequest = { ...payload.pullRequest, fromRef: { id: "refs/heads/develop", repository: payload.pullRequest.fromRef.repository } };
  const r = parseWebhookRequest({ payload, allowedUsers: ALLOWED_PAIR, reviewerSkipBranchPairs: skipPairs });
  assert.equal(r.ok, false);
  assert.match(r.ignored, /skipped/);
});

test("parseWebhookRequest ignores a skipped merge before the adder check", () => {
  const r = parseWebhookRequest({ payload: branchPr("develop", "release/14.x"), allowedUsers: ["carol"], reviewerSkipBranchPairs: skipPairs });
  assert.equal(r.status, 200);
});

test("the release/* wildcard covers every release branch, present and future", () => {
  for (const target of ["release/14.2", "release/14.3", "release/15.0", "release/14.2.1"]) {
    const r = parseWebhookRequest({ payload: branchPr("develop", target), allowedUsers: ALLOWED_PAIR, reviewerSkipBranchPairs: skipPairs });
    assert.equal(r.ok, false, `develop -> ${target} should be skipped`);
    assert.match(r.ignored, /skipped/);
  }
  for (const source of ["release/14.2", "release/15.0"]) {
    const r = parseWebhookRequest({ payload: branchPr(source, "develop"), allowedUsers: ALLOWED_PAIR, reviewerSkipBranchPairs: skipPairs });
    assert.equal(r.ok, false, `${source} -> develop should be skipped`);
  }
  const hotfix = parseWebhookRequest({ payload: branchPr("hotfix/14.2", "develop"), allowedUsers: ALLOWED_PAIR, reviewerSkipBranchPairs: skipPairs });
  assert.equal(hotfix.ok, true, "hotfix/14.2 -> develop is not a release merge and should trigger");
});

test("release/* -> release/* merges are skipped when that pair is configured", () => {
  const pairs = [...skipPairs, { source: "release/*", target: "release/*" }];
  for (const [source, target] of [["release/14.2", "release/14.3"], ["release/14.3", "release/14.2"], ["release/14.2", "release/15.0"]]) {
    const r = parseWebhookRequest({ payload: branchPr(source, target), allowedUsers: ALLOWED_PAIR, reviewerSkipBranchPairs: pairs });
    assert.equal(r.ok, false, `${source} -> ${target} should be skipped`);
    assert.match(r.ignored, /skipped/);
  }
  const fix = parseWebhookRequest({ payload: branchPr("bugfix/login", "release/14.3"), allowedUsers: ALLOWED_PAIR, reviewerSkipBranchPairs: pairs });
  assert.equal(fix.ok, true, "a fix PR into a release branch is still reviewed");
});

// ---- automatic trigger: pr:opened / pr:modified (marked ready) -------------

const reviewRequested = (eventKey, { draft = false, previousDraft, reviewers = ["MYBOT"], author = "alice", actor, source = "feature/login", target = "develop" } = {}) => ({
  eventKey,
  actor: { slug: actor ?? author, name: actor ?? author, type: "NORMAL" },
  pullRequest: {
    id: 4817,
    draft,
    reviewers: reviewers.map((slug) => ({ user: { slug, name: slug, type: "NORMAL" }, role: "REVIEWER", approved: false, status: "UNAPPROVED" })),
    fromRef: { id: `refs/heads/${source}`, displayId: source, repository: { slug: "acme-gateway-v5", project: { key: "ACME" } } },
    toRef: { id: `refs/heads/${target}`, displayId: target, repository: { slug: "acme-gateway-v5", project: { key: "ACME" } } },
  },
  ...(previousDraft === undefined ? {} : { previousDraft }),
});

test("parseWebhookRequest triggers on pr:opened when an allowed reviewer is on the PR and it is not a draft", () => {
  const r = parseWebhookRequest({ payload: reviewRequested("pr:opened"), allowedUsers: ALLOWED_PAIR });
  assert.equal(r.ok, true);
  assert.equal(r.via, "opened");
  assert.equal(r.reviewer, "MYBOT");
  assert.equal(r.ref.prId, 4817);
});

test("parseWebhookRequest does not trigger on pr:opened for a draft", () => {
  const r = parseWebhookRequest({ payload: reviewRequested("pr:opened", { draft: true }), allowedUsers: ALLOWED_PAIR });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.match(r.ignored, /opened as a draft/);
});

test("parseWebhookRequest ignores pr:opened without an allowed reviewer", () => {
  const r = parseWebhookRequest({ payload: reviewRequested("pr:opened", { reviewers: ["tth3hc"] }), allowedUsers: ALLOWED_PAIR });
  assert.equal(r.ok, false);
  assert.match(r.ignored, /no allowed user is a reviewer/);
});

test("parseWebhookRequest triggers on pr:modified when a draft is marked ready", () => {
  const r = parseWebhookRequest({ payload: reviewRequested("pr:modified", { previousDraft: true }), allowedUsers: ALLOWED_PAIR });
  assert.equal(r.ok, true);
  assert.equal(r.via, "marked-ready");
  assert.equal(r.reviewer, "MYBOT");
});

test("parseWebhookRequest ignores pr:modified edits that are not a draft marked ready", () => {
  const edits = [
    reviewRequested("pr:modified", { previousDraft: false }),
    reviewRequested("pr:modified", { previousDraft: true, draft: true }),
    reviewRequested("pr:modified", {}),
  ];
  for (const payload of edits) {
    const r = parseWebhookRequest({ payload, allowedUsers: ALLOWED_PAIR });
    assert.equal(r.ok, false);
    assert.equal(r.status, 200);
    assert.match(r.ignored, /not marked ready/);
  }
});

test("parseWebhookRequest needs an allowed reviewer when a draft is marked ready", () => {
  const r = parseWebhookRequest({ payload: reviewRequested("pr:modified", { previousDraft: true, reviewers: ["tth3hc"] }), allowedUsers: ALLOWED_PAIR });
  assert.equal(r.ok, false);
  assert.match(r.ignored, /no allowed user is a reviewer/);
});

test("parseWebhookRequest applies the skip list to opened and ready PRs", () => {
  const pairs = [{ source: "develop", target: "release/*" }];
  const opened = parseWebhookRequest({ payload: reviewRequested("pr:opened", { source: "develop", target: "release/14.2" }), allowedUsers: ALLOWED_PAIR, reviewerSkipBranchPairs: pairs });
  assert.equal(opened.ok, false);
  assert.match(opened.ignored, /skipped for develop -> release\/14\.2/);
  const ready = parseWebhookRequest({ payload: reviewRequested("pr:modified", { previousDraft: true, source: "develop", target: "release/14.2" }), allowedUsers: ALLOWED_PAIR, reviewerSkipBranchPairs: pairs });
  assert.equal(ready.ok, false);
  assert.match(ready.ignored, /skipped/);
});

test("parseWebhookRequest checks the author of an opened PR against ALLOWED_REVIEWER_USERS", () => {
  const denied = parseWebhookRequest({ payload: reviewRequested("pr:opened", { author: "mallory" }), allowedUsers: ["carol", "MYBOT"] });
  assert.equal(denied.status, 403);
  assert.match(denied.error, /author mallory is not authorized/);
  assert.equal(parseWebhookRequest({ payload: reviewRequested("pr:opened", { author: "carol" }), allowedUsers: ["carol", "MYBOT"] }).ok, true);
});

test("parseWebhookRequest checks who marked a PR ready against ALLOWED_REVIEWER_USERS", () => {
  const denied = parseWebhookRequest({ payload: reviewRequested("pr:modified", { previousDraft: true, actor: "mallory" }), allowedUsers: ["carol", "MYBOT"] });
  assert.equal(denied.status, 403);
  assert.match(denied.error, /user who marked it ready mallory/);
});

test("parseWebhookRequest applies AUTO_REVIEW_OFF_REPOS to opened and ready PRs", () => {
  const off = new Set(["acme/acme-gateway-v5"]);
  const opened = parseWebhookRequest({ payload: reviewRequested("pr:opened"), allowedUsers: ALLOWED_PAIR, autoReviewOffRepos: off });
  assert.equal(opened.ok, false);
  assert.match(opened.ignored, /auto review is off for ACME\/acme-gateway-v5/);

  // a different repo on the off list does not switch this one off (default on)
  const other = new Set(["acme/acme-app"]);
  assert.equal(parseWebhookRequest({ payload: reviewRequested("pr:opened"), allowedUsers: ALLOWED_PAIR, autoReviewOffRepos: other }).ok, true);
});

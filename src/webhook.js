// Bitbucket Data Center webhook handling for POST /webhooks/bitbucket.
//
// Event: `pr:comment:added`. A review is triggered by a PR comment whose
// trimmed text starts with `ai-review` (whitespace-tolerant, leading `/`
// optional, e.g. `ai-review`, `/ai-review`). The commenter must be in
// `ALLOWED_REVIEWER_USERS` when that list is non-empty.
//
// Event: `pr:reviewer:updated`. The automatic review is ON for every repository by
// default and off only for the repositories listed in `AUTO_REVIEW_OFF_REPOS`. A
// review starts when a user on `ALLOWED_REVIEWER_USERS` is among the added reviewers,
// provided the user who added the reviewer is also allowed (when that list is
// non-empty). Pull requests between the branch pairs in
// `REVIEW_ON_REVIEWER_ADDED_SKIP` (e.g. `develop>release/*`) never start one.
//
// Events: `pr:opened` and `pr:modified`. Same per-repo on/off; a review starts when a
// user on `ALLOWED_REVIEWER_USERS` is among the PR's reviewers, once the PR is ready:
// a draft waits until `pr:modified` reports it marked ready (`previousDraft` true,
// `draft` false). The author (`pr:opened`) or the user who marked it ready must be
// allowed. The skip list applies to both.
//
// Bitbucket DC webhooks configured with a secret deliver an `X-Hub-Signature:
// sha256=<hex>` header — an HMAC-SHA256 of the raw request body.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Comment triggers a review when its trimmed text starts with ai-review (leading slash optional). */
export function isReviewTrigger(commentText) {
  return /^\/?ai-review(\s|$)/i.test(String(commentText ?? "").trim());
}

/**
 * True when an `/ai-review` comment requests a forced re-review (`--force`,
 * dash optional). Force bypasses the same-head gate, so the full review runs
 * again even when the PR head was already reviewed at that commit.
 */
export function isForceReview(commentText) {
  return /^\/?ai-review\s+--?force(\s|$)/i.test(String(commentText ?? "").trim());
}

/**
 * Bitbucket's webhook "Test connection" button (and keepalive) delivers an
 * unsigned `diagnostics:ping` event — no `X-Hub-Signature` header even when a
 * secret is configured. It triggers nothing, so it is accepted without an HMAC
 * check; real deliveries still require a valid signature.
 */
export function isUnsignedDiagnostic(eventKey) {
  return String(eventKey ?? "").toLowerCase() === "diagnostics:ping";
}

/**
 * Verify the Bitbucket `X-Hub-Signature` HMAC-SHA256 header against the raw
 * body. When no secret is configured, no check is performed.
 */
export function verifySignature(rawBody, signature, secret) {
  if (!secret) return { ok: true, reason: null };
  if (!signature) return { ok: false, reason: "missing X-Hub-Signature header" };
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody ?? "").digest("hex")}`;
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return { ok, reason: ok ? null : "signature mismatch" };
}

/**
 * Candidate login names for a Bitbucket user object.
 *
 * Bitbucket Data Center 5.0+ changed the user model: `slug` is the login name
 * while `name` now carries the *display name*. Bitbucket Cloud uses `userName`;
 * Server <5.0 used `name` for the login. We collect every plausible value so the
 * allowlist can match whichever the instance actually sends (usernames on this
 * instance are uppercase, e.g. `MYBOT`, and are matched case-insensitively).
 */
function usernamesOf(user) {
  if (!user || typeof user !== "object") return [];
  return [user.slug, user.userName, user.name].filter((v) => typeof v === "string" && v);
}

/** Candidate usernames of whoever acted (top-level actor, then comment author). */
function actingUsers(payload) {
  return [...usernamesOf(payload?.actor), ...usernamesOf(payload?.comment?.author)];
}

/** `{projectKey, repoSlug, prId}` of the pull request in a payload, or null when incomplete. */
function prRefOf(payload) {
  const repo = payload.pullRequest?.fromRef?.repository;
  const projectKey = repo?.project?.key;
  const repoSlug = repo?.slug;
  const prId = payload.pullRequest?.id;
  return projectKey && repoSlug && prId ? { projectKey, repoSlug, prId } : null;
}

const MISSING_REF_ERROR = "payload has no pullRequest.fromRef.repository (project key/slug) or pullRequest.id";

/** `{projectKey, repoSlug}` of the repository that owns the PR (toRef), falling back to fromRef. */
function owningRepoOf(payload) {
  const repos = [payload.pullRequest?.toRef?.repository, payload.pullRequest?.fromRef?.repository];
  const repo = repos.find((r) => r?.project?.key && r?.slug);
  return repo ? { projectKey: repo.project.key, repoSlug: repo.slug } : null;
}

/** Branch name of a pull request ref: `displayId`, else `id` without `refs/heads/`. */
function branchOf(ref) {
  return ref?.displayId || String(ref?.id ?? "").replace(/^refs\/heads\//, "") || null;
}

/** Glob where `*` matches any characters; matched case-insensitively against the whole name. */
function globMatches(pattern, name) {
  const source = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "i").test(name);
}

/** True when `source -> target` matches one of the `REVIEW_ON_REVIEWER_ADDED_SKIP` pairs. */
function isSkippedBranchPair(pairs, source, target) {
  if (!source || !target) return false;
  return pairs.some((p) => globMatches(p.source, source) && globMatches(p.target, target));
}

/**
 * `pr:reviewer:updated`: automatic review is OFF for the repositories on
 * `AUTO_REVIEW_OFF_REPOS`, ON everywhere else. A review starts when a user on
 * `ALLOWED_REVIEWER_USERS` is among the added reviewers. When
 * `ALLOWED_REVIEWER_USERS` is set, the user who added the reviewer must also be
 * on it.
 */
function parseReviewerAdded({
  payload,
  allowedUsers,
  autoReviewOffRepos,
  reviewerSkipBranchPairs,
}) {
  const owner = owningRepoOf(payload);
  const label = owner ? `${owner.projectKey}/${owner.repoSlug}` : "this repository";
  if (owner && autoReviewOffRepos.has(label.toLowerCase())) {
    return { ok: false, status: 200, ignored: `auto review is off for ${label} (AUTO_REVIEW_OFF_REPOS)` };
  }

  const addedNames = (Array.isArray(payload.addedReviewers) ? payload.addedReviewers : []).flatMap(usernamesOf);
  const wanted = new Set(allowedUsers.map((u) => u.toLowerCase()));
  const reviewer = addedNames.find((name) => !wanted.size || wanted.has(name.toLowerCase()));
  if (!reviewer) {
    const seen = addedNames.length ? addedNames.join(" / ") : "none";
    return { ok: false, status: 200, ignored: `no allowed user was added as reviewer for ${label} (added: ${seen})` };
  }

  const ref = prRefOf(payload);
  if (!ref) return { ok: false, status: 400, error: MISSING_REF_ERROR };

  const source = branchOf(payload.pullRequest?.fromRef);
  const target = branchOf(payload.pullRequest?.toRef);
  if (isSkippedBranchPair(reviewerSkipBranchPairs, source, target)) {
    return { ok: false, status: 200, ignored: `auto review skipped for ${source} -> ${target} (REVIEW_ON_REVIEWER_ADDED_SKIP)` };
  }

  const adders = usernamesOf(payload.actor);
  if (allowedUsers.length) {
    const allowed = new Set(allowedUsers.map((u) => u.toLowerCase()));
    if (!adders.some((name) => allowed.has(name.toLowerCase()))) {
      const seen = adders.length ? [...new Set(adders)].join(" / ") : "(unknown)";
      return { ok: false, status: 403, error: `reviewer added by ${seen} is not authorized (ALLOWED_REVIEWER_USERS)` };
    }
  }

  return { ok: true, ref, actor: adders[0] || null, reviewer, via: "reviewer-added", head: payload.pullRequest?.fromRef?.latestCommit || payload.pullRequest?.fromRef?.id || null };
}

/**
 * `pr:opened` and `pr:modified`: start an automatic review when the repository is
 * not on `AUTO_REVIEW_OFF_REPOS` and a user on `ALLOWED_REVIEWER_USERS` is among the
 * PR's reviewers. `pr:opened` qualifies for a PR that is not a draft. `pr:modified`
 * qualifies only when a draft is marked ready (`previousDraft` true, `draft` false),
 * so title and description edits are ignored. Reviewers set at creation arrive with
 * `pr:opened`, not with `pr:reviewer:updated`. The skip list and the allowlist apply
 * as for `pr:reviewer:updated`; the acting user is the author (`pr:opened`) or the
 * user who marked the PR ready (`pr:modified`).
 */
function parseReviewRequested({
  payload,
  allowedUsers,
  autoReviewOffRepos,
  reviewerSkipBranchPairs,
}) {
  const pr = payload.pullRequest;
  const opened = payload.eventKey === "pr:opened";
  if (opened && pr?.draft === true) {
    return { ok: false, status: 200, ignored: "pull request opened as a draft (a review starts when it is marked ready)" };
  }
  if (!opened && !(payload.previousDraft === true && pr?.draft !== true)) {
    return { ok: false, status: 200, ignored: "pull request modified, not marked ready for review" };
  }

  const owner = owningRepoOf(payload);
  const label = owner ? `${owner.projectKey}/${owner.repoSlug}` : "this repository";
  if (owner && autoReviewOffRepos.has(label.toLowerCase())) {
    return { ok: false, status: 200, ignored: `auto review is off for ${label} (AUTO_REVIEW_OFF_REPOS)` };
  }

  const reviewerNames = (Array.isArray(pr?.reviewers) ? pr.reviewers : []).flatMap((r) => usernamesOf(r?.user));
  const wanted = new Set(allowedUsers.map((u) => u.toLowerCase()));
  const reviewer = reviewerNames.find((name) => !wanted.size || wanted.has(name.toLowerCase()));
  if (!reviewer) {
    const seen = reviewerNames.length ? reviewerNames.join(" / ") : "none";
    return { ok: false, status: 200, ignored: `no allowed user is a reviewer of ${label} (reviewers: ${seen})` };
  }

  const ref = prRefOf(payload);
  if (!ref) return { ok: false, status: 400, error: MISSING_REF_ERROR };

  const source = branchOf(pr?.fromRef);
  const target = branchOf(pr?.toRef);
  if (isSkippedBranchPair(reviewerSkipBranchPairs, source, target)) {
    return { ok: false, status: 200, ignored: `auto review skipped for ${source} -> ${target} (REVIEW_ON_REVIEWER_ADDED_SKIP)` };
  }

  const actors = usernamesOf(payload.actor);
  if (allowedUsers.length) {
    const allowed = new Set(allowedUsers.map((u) => u.toLowerCase()));
    if (!actors.some((name) => allowed.has(name.toLowerCase()))) {
      const seen = actors.length ? [...new Set(actors)].join(" / ") : "(unknown)";
      const role = opened ? "author" : "user who marked it ready";
      return { ok: false, status: 403, error: `${role} ${seen} is not authorized (ALLOWED_REVIEWER_USERS)` };
    }
  }

  return { ok: true, ref, actor: actors[0] || null, reviewer, via: opened ? "opened" : "marked-ready", head: pr?.fromRef?.latestCommit || pr?.fromRef?.id || null };
}

/**
 * Validate a delivered webhook payload.
 *
 * Returns `{ok:true, ref, actor, text, head}` for a valid ai-review comment,
 * `{ok:true, ref, actor, reviewer, via, head}` for an auto-review trigger (added, opened, or marked ready),
 * or `{ok:false, status, ignored?|error?}` otherwise. `status 200 + ignored`
 * marks deliveries that are fine but not for us (other events, non-trigger
 * comments) so Bitbucket does not retry them. `head` (the PR's current head
 * commit from the payload) lets the server skip triggers whose head
 * was already reviewed — `/ai-review --force` re-runs anyway.
 */
export function parseWebhookRequest({
  payload,
  allowedUsers = [],
  autoReviewOffRepos = new Set(),
  reviewerSkipBranchPairs = [],
}) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, status: 400, error: "empty or invalid JSON body" };
  }

  if (payload.eventKey === "pr:reviewer:updated") {
    return parseReviewerAdded({ payload, allowedUsers, autoReviewOffRepos, reviewerSkipBranchPairs });
  }

  if (payload.eventKey === "pr:opened" || payload.eventKey === "pr:modified") {
    return parseReviewRequested({ payload, allowedUsers, autoReviewOffRepos, reviewerSkipBranchPairs });
  }

  if (payload.eventKey !== "pr:comment:added") {
    return {
      ok: false,
      status: 200,
      ignored: `event ${payload.eventKey || "(missing)"} is not pr:comment:added`,
    };
  }

  const text = payload.comment?.text;
  if (!isReviewTrigger(text)) {
    return { ok: false, status: 200, ignored: "comment is not an /ai-review trigger" };
  }

  const candidates = actingUsers(payload);
  const actor = candidates[0] || null;
  if (allowedUsers.length) {
    const allowed = new Set(allowedUsers.map((u) => u.toLowerCase()));
    const authorized = candidates.some((name) => allowed.has(name.toLowerCase()));
    if (!authorized) {
      const seen = candidates.length ? candidates.join(" / ") : "(unknown)";
      return { ok: false, status: 403, error: `commenter ${seen} is not authorized` };
    }
  }

  const ref = prRefOf(payload);
  if (!ref) return { ok: false, status: 400, error: MISSING_REF_ERROR };

  return {
    ok: true,
    ref,
    actor,
    text: String(text).trim(),
    // The id of the `/ai-review` comment that triggered this delivery (if any),
    // so a skipped/redundant re-review can reply to it (e.g. teaching --force).
    commentId: payload.comment?.id ?? null,
    // The head commit lets the server skip a comment-triggered review when it
    // was already reviewed at this commit (unless `/ai-review --force`).
    head: payload.pullRequest?.fromRef?.latestCommit || payload.pullRequest?.fromRef?.id || null,
  };
}
// GitHub webhook handling for POST /webhooks/github.
//
// Signature: GitHub delivers `X-Hub-Signature-256: sha256=<hex>` (HMAC-SHA256
// of the raw body with GITHUB_WEBHOOK_SECRET) — verified with the shared
// `verifySignature` from src/webhook.js in the server.
//
// Events (see parseGitHubWebhookRequest below):
//   - `ping`: GitHub's webhook test — accepted unsigned, triggers nothing.
//   - `issue_comment` created whose body starts with `/ai-review`: manual
//     trigger. The commenter must be on ALLOWED_REVIEWER_USERS when set.
//   - `pull_request` opened / ready_for_review / review_requested: automatic
//     triggers, OFF for the repositories on GITHUB_AUTO_REVIEW_OFF_REPOS and
//     honoring the shared REVIEW_ON_REVIEWER_ADDED_SKIP branch pairs. A review
//     starts when an allowed user is among the requested reviewers (and, when
//     the allowlist is set, the acting user is allowed too). Draft PRs wait
//     until they are marked ready.
//
// GitHub does not include the head SHA in `issue_comment` payloads, so the
// same-head dedup only applies to `pull_request` events (head = head.sha).

import { isReviewTrigger } from "./webhook.js";

const MISSING_REF_ERROR = "payload has no repository.owner.login, repository.name, and pull_request/issue number";

/** `{projectKey, repoSlug, prId, platform:"github"}` of the PR in a payload. */
function refOf(payload) {
  const repo = payload?.repository;
  if (!repo) return null;
  const owner = repo?.owner?.login ?? (typeof repo.owner === "string" ? repo.owner : null);
  const repoSlug = repo?.name || (repo?.full_name?.split("/")[1] ?? null);
  const prId = payload?.pull_request?.number ?? payload?.issue?.number;
  if (!owner || !repoSlug || prId == null) return null;
  return { projectKey: owner, repoSlug, prId, platform: "github" };
}

/** Glob where `*` matches any characters; matched case-insensitively. */
function globMatches(pattern, name) {
  const source = String(pattern)
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "i").test(String(name));
}

/** True when `source -> target` matches one of the shared skip branch pairs. */
function isSkippedBranchPair(pairs, source, target) {
  if (!source || !target) return false;
  return pairs.some((p) => globMatches(p.source, source) && globMatches(p.target, target));
}

/**
 * Parse a delivered GitHub webhook payload into the same shape the Bitbucket
 * parser returns, so the server's dedup/queue/publish logic works unchanged.
 *
 * Returns `{ok:true, ref, actor, text, commentId, head}` for an /ai-review
 * comment, `{ok:true, ref, actor, reviewer, via, head}` for an auto-review
 * trigger, or `{ok:false, status, ignored?|error?}`. `status 200 + ignored`
 * marks deliveries that are fine but not for us (so GitHub does not retry).
 */
export function parseGitHubWebhookRequest({
  headers = {},
  payload,
  allowedUsers = [],
  autoReviewOffRepos = new Set(),
  reviewerSkipBranchPairs = [],
}) {
  const event = headers["x-github-event"] || payload?.event || "";
  if (event === "ping") {
    return { ok: false, status: 200, ignored: "ping" };
  }

  const wanted = allowedUsers.map((u) => String(u).toLowerCase());
  const isAllowed = (login) => !wanted.length || wanted.includes(String(login || "").toLowerCase());

  // --- manual /ai-review trigger -----------------------------------------
  if (event === "issue_comment") {
    if (payload?.action !== "created") {
      return { ok: false, status: 200, ignored: `issue_comment action ${payload?.action || "(missing)"} is not a trigger` };
    }
    const text = payload?.comment?.body;
    if (!isReviewTrigger(text)) {
      return { ok: false, status: 200, ignored: "comment is not an /ai-review trigger" };
    }
    const actor = payload?.sender?.login ?? payload?.comment?.user?.login ?? null;
    if (!isAllowed(actor)) {
      const seen = actor || "unknown";
      return { ok: false, status: 403, error: `commenter ${seen} is not authorized (ALLOWED_REVIEWER_USERS)` };
    }
    const ref = refOf(payload);
    if (!ref) return { ok: false, status: 400, error: MISSING_REF_ERROR };
    return {
      ok: true,
      ref,
      actor,
      text: String(text).trim(),
      // The /ai-review comment id, so a skipped/redundant re-review can reply
      // to it (e.g. teaching --force).
      commentId: payload?.comment?.id ?? null,
      // issue_comment payloads carry no head SHA — same-head dedup is skipped
      // (safe: an /ai-review always re-reviews).
      head: null,
    };
  }

  // --- automatic triggers ------------------------------------------------
  if (event === "pull_request") {
    const action = payload?.action;
    const pr = payload?.pull_request || {};
    const ref = refOf(payload);
    if (!ref) return { ok: false, status: 400, error: MISSING_REF_ERROR };

    const label = `${ref.projectKey}/${ref.repoSlug}`.toLowerCase();
    if (autoReviewOffRepos.has(label)) {
      return { ok: false, status: 200, ignored: `auto review is off for ${label} (GITHUB_AUTO_REVIEW_OFF_REPOS)` };
    }

    const source = pr?.head?.ref || null;
    const target = pr?.base?.ref || null;
    if (isSkippedBranchPair(reviewerSkipBranchPairs, source, target)) {
      return { ok: false, status: 200, ignored: `auto review skipped for ${source} -> ${target} (REVIEW_ON_REVIEWER_ADDED_SKIP)` };
    }

    const actor = payload?.sender?.login ?? null;
    const requested = (Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers : [])
      .map((u) => u?.login)
      .filter(Boolean);

    // Someone was asked to review this PR.
    if (action === "review_requested") {
      const reviewer = payload?.requested_reviewer?.login ?? requested[0] ?? null;
      if (!isAllowed(reviewer)) {
        const seen = reviewer || "none";
        return { ok: false, status: 200, ignored: `no allowed user was requested as reviewer for ${label} (requested: ${seen})` };
      }
      if (allowedUsers.length && !isAllowed(actor)) {
        return { ok: false, status: 403, error: `review requested by ${actor || "?"} is not authorized (ALLOWED_REVIEWER_USERS)` };
      }
      return {
        ok: true,
        ref,
        actor,
        reviewer,
        via: "reviewer-added",
        head: pr?.head?.sha || null,
      };
    }

    // PR opened, or a draft marked ready for review.
    if (action === "opened" || action === "ready_for_review") {
      if (pr?.draft === true) {
        return {
          ok: false,
          status: 200,
          ignored:
            action === "opened"
              ? "pull request opened as a draft (a review starts when it is marked ready)"
              : "pull request is still a draft",
        };
      }
      if (!requested.some(isAllowed)) {
        const seen = requested.length ? requested.join(" / ") : "none";
        return { ok: false, status: 200, ignored: `no allowed user is a requested reviewer of ${label} (reviewers: ${seen})` };
      }
      if (allowedUsers.length && !isAllowed(actor)) {
        const role = action === "opened" ? "author" : "user who marked it ready";
        return { ok: false, status: 403, error: `${role} ${actor || "?"} is not authorized (ALLOWED_REVIEWER_USERS)` };
      }
      return {
        ok: true,
        ref,
        actor,
        reviewer: requested[0] || null,
        via: action === "opened" ? "opened" : "marked-ready",
        head: pr?.head?.sha || null,
      };
    }

    return { ok: false, status: 200, ignored: `pull_request action ${action || "(missing)"} is not a review trigger` };
  }

  return { ok: false, status: 200, ignored: `event ${event || "(missing)"} is not a review trigger` };
}

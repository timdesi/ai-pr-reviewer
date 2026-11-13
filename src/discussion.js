// PR discussion context for reviews.
//
// A re-review often hits a head whose author already explained things in PR
// comments/replies (e.g. a reply to our published review comment). Without that
// context the reviewers re-raise findings the author already addressed — the
// "false positives because the AI has no context" complaint.
//
// This module fetches the PR's comments, filters out our own bot comments and
// the review comment we posted, and renders the recent human discussion into a
// compact markdown block that is attached to the reviewer AND consensus
// contexts. Additive and non-fatal: any problem yields "" and the review
// proceeds exactly as before.

import { log } from "./log.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** How many comments (newest first) to include at most. */
export const DEFAULT_MAX_COMMENTS = 25;
/** Per-comment character budget kept in the block. */
export const DEFAULT_MAX_TEXT_LEN = 800;
/** When the bot identity is unknown, comments longer than this are dropped as
 *  auto-generated (our own review report) rather than fed back as "discussion". */
const UNKNOWN_BOT_LEN_GUARD = 1500;

/**
 * Compare a Bitbucket user object against the app's own usernames
 * (BITBUCKET_USERNAME, e.g. an email). Tolerates name/slug/email/displayName
 * and compares case-insensitively; an email boot user also matches its local
 * part (`mybot@example.com` ↔ `mybot` / `MYBOT`).
 */
function isBotUser(author, botUsernames) {
  if (!botUsernames.length || !author || typeof author !== "object") return false;
  const values = [author.slug, author.name, author.emailAddress, author.displayName]
    .filter((v) => typeof v === "string" && v)
    .map((v) => v.toLowerCase());
  for (const bot of botUsernames) {
    const b = String(bot).trim().toLowerCase();
    if (!b) continue;
    if (values.includes(b)) return true;
    // email bot user also matches its local part (login) in any field
    if (b.includes("@") && values.includes(b.split("@")[0])) return true;
  }
  return false;
}

/**
 * True when this comment is (a) a direct reply to our published review comment
 * (`parent.id === reviewCommentId`) — the strongest signal of an author
 * answering the findings — versus (b) an ordinary reply (`parent != null`).
 */
function replyKind(comment, reviewCommentId) {
  const parentId = comment?.parent?.id ?? comment?.parentId ?? null;
  if (parentId == null) return "top";
  if (reviewCommentId != null && Number(parentId) === Number(reviewCommentId)) return "to-review";
  return "reply";
}

function renderText(text, maxLen) {
  const clean = String(text ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return "";
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen).trimEnd()}\n…(truncated)`;
}

/**
 * Flatten a PR activity feed into a flat list of comment-like objects
 * (including nested replies) for `renderDiscussionBlock`.
 *
 * The `activities` endpoint is used because the `comments` endpoint requires a
 * per-file `path`. Each COMMENTED activity carries a comment; replies are
 * nested under `comment.comments[]` (recursively). Deleted/removed activities
 * are dropped.
 */
export function flattenActivitiesToComments(activities = []) {
  const out = [];
  const walk = (c, parentId) => {
    if (!c || typeof c !== "object") return;
    if (c.deleted === true || String(c.state || "").toUpperCase() === "DELETED") return;
    const children = Array.isArray(c.comments) ? c.comments : [];
    out.push({
      id: c.id ?? null,
      text: c.text,
      author: c.author ?? null,
      createdDate: c.createdDate ?? c.updatedDate ?? null,
      parent: parentId != null ? { id: parentId } : null,
      deleted: false,
    });
    for (const child of children) walk(child, c.id);
  };
  for (const a of activities || []) {
    if (String(a?.action || "").toUpperCase() !== "COMMENTED") continue;
    if (String(a?.commentAction || "").toUpperCase() === "REMOVED") continue;
    walk(a.comment, null);
  }
  return out;
}

/**
 * Build the compact "PR discussion" markdown block from raw Bitbucket comment
 * objects. Returns "" when there is nothing useful (no human comments).
 *
 * Bitbucket DC returns replies as separate comment objects with `parent.id`;
 * top-level comments have no parent. Our own published review comment is
 * skipped via `reviewCommentId` and/or the bot-username filter.
 */
export function renderDiscussionBlock({
  comments = [],
  botUsernames = [],
  reviewCommentId = null,
  maxComments = DEFAULT_MAX_COMMENTS,
  maxTextLen = DEFAULT_MAX_TEXT_LEN,
}) {
  const bots = (botUsernames || []).map((b) => String(b).trim()).filter(Boolean);
  const entries = [];

  for (const c of comments || []) {
    if (!c || c.deleted === true) continue;
    if (reviewCommentId != null && Number(c.id) === Number(reviewCommentId)) continue; // our report comment
    if (isBotUser(c.author, bots)) continue;
    const textId = c.id ?? null;
    // Heuristic guard when the bot identity is unknown: drop very long,
    // likely auto-generated comments (the review report) entirely.
    if (!bots.length && String(c.text ?? "").length > UNKNOWN_BOT_LEN_GUARD) continue;
    const text = renderText(c.text, maxTextLen);
    if (!text) continue;
    entries.push({
      id: textId,
      author: c.author?.displayName || c.author?.name || c.author?.slug || "?",
      createdDate: c.createdDate ?? c.updatedDate ?? null,
      kind: replyKind(c, reviewCommentId),
      text,
    });
  }

  // Newest first, then trim to the budget.
  entries.sort((a, b) => (b.createdDate ?? 0) - (a.createdDate ?? 0));
  const picked = entries.slice(0, Math.max(1, Number(maxComments) || DEFAULT_MAX_COMMENTS));
  if (!picked.length) return "";

  const kindLabel = (k) => (k === "to-review" ? " — _reply to the AI review_" : k === "reply" ? " — _reply_" : "");
  const lines = picked.map(
    (e, i) =>
      `${i + 1}. **${e.author}**${kindLabel(e.kind)} · ${new Date(e.createdDate ?? Date.now()).toISOString().slice(0, 16).replace("T", " ")}\n   > ${e.text.split("\n").join("\n   > ")}`,
  );

  return `## PR discussion (author replies & clarifications)

> The recent non-bot comments on this PR (newest first), fetched at review time.
> They are the author/team's clarifications and intent. Take them seriously:
> - A finding a comment already explains or justifies is **not** a finding — do
>   not re-raise it. If it matches a previous-review finding, put its title in
>   \`resolved_previous\`.
> - Only re-raise an issue the current code still contradicts despite the
>   clarification, and say so explicitly with lower confidence.
> - Never comment on, criticise, or restate the discussion itself.

${lines.join("\n\n")}
`;
}

/**
 * Best-effort id of the review comment we published on the previous review of
 * this PR (status.json → publish.commentId), so replies to it can be marked as
 * "reply to the AI review". `previous` is the object returned by
 * `findPreviousReview`; returns null when unknown or unpublished.
 */
export function previousReviewCommentId(previous, { jobsDir } = {}) {
  try {
    if (!previous?.job || !jobsDir) return null;
    const statusPath = path.join(jobsDir, previous.job, "status.json");
    if (!existsSync(statusPath)) return null;
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    return status?.publish?.commentId ?? null;
  } catch {
    return null;
  }
}

/**
 * True when the PR has at least one human comment created strictly after
 * `since` (an ISO string or ms epoch). Used to make the same-head dedup
 * context-aware: an author reply / new discussion on an unchanged head is a
 * real re-review trigger (the context-aware feature), while a PR with truly
 * nothing new is skipped. Non-fatal: any failure (network, absent timestamps)
 * returns false so the strict head-based dedup keeps working as a fallback.
 *
 * `excludeIds` drops comments that must not count — e.g. the `/ai-review`
 * trigger comment itself and our own previously-published review comment.
 */
export async function hasNewHumanDiscussion({
  client,
  ref,
  botUsernames = [],
  since = null,
  excludeIds = new Set(),
}) {
  try {
    if (!client || typeof client.getPullRequestActivities !== "function") return false;
    const sinceMs = since == null ? null : new Date(since).getTime();
    if (!Number.isFinite(sinceMs) || sinceMs <= 0) return false;
    const excluded = new Set([...(excludeIds || [])].map((i) => Number(i)).filter(Number.isFinite));
    const activities = await client.getPullRequestActivities(ref);
    const comments = flattenActivitiesToComments(activities);
    for (const c of comments) {
      if (c.id != null && excluded.has(Number(c.id))) continue;
      const createdMs = c.createdDate == null ? null : new Date(c.createdDate).getTime();
      if (!Number.isFinite(createdMs) || createdMs <= sinceMs) continue;
      if (isBotUser(c.author, botUsernames)) continue;
      return true;
    }
    return false;
  } catch {
    // Keep the conservative behavior (strict head dedup) on any failure.
    return false;
  }
}

/**
 * Fetch the PR discussion and render it as a markdown block. Never throws: any
 * failure (network, missing comments, parse) yields "" and the review proceeds.
 * `activities` may be passed in (e.g. already fetched for the screenshot step);
 * when provided the fetch is skipped.
 */
export async function loadDiscussion({
  client,
  ref,
  botUsernames = [],
  reviewCommentId = null,
  maxComments = DEFAULT_MAX_COMMENTS,
  maxTextLen = DEFAULT_MAX_TEXT_LEN,
  activities,
}) {
  try {
    if (!client) return "";
    const acts = Array.isArray(activities)
      ? activities
      : typeof client.getPullRequestActivities === "function"
        ? await client.getPullRequestActivities(ref)
        : [];
    const comments = flattenActivitiesToComments(acts);
    return renderDiscussionBlock({ comments, botUsernames, reviewCommentId, maxComments, maxTextLen });
  } catch (err) {
    log.warn(`discussion: no PR-comment context for ${ref.projectKey}/${ref.repoSlug}#${ref.prId}: ${err.message}`);
    return "";
  }
}

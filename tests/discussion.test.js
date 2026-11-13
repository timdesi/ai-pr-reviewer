import { test } from "node:test";
import assert from "node:assert/strict";

import { renderDiscussionBlock, loadDiscussion, flattenActivitiesToComments, hasNewHumanDiscussion, DEFAULT_MAX_COMMENTS, DEFAULT_MAX_TEXT_LEN } from "../src/discussion.js";

// --- helpers ----------------------------------------------------------------

function comment({ id, text, author = "Ann", parentId = null, createdDate = 1700000000000, deleted = false }) {
  const c = {
    id,
    text,
    author: typeof author === "string" ? { displayName: author, name: author.toUpperCase(), slug: author.toLowerCase() } : author,
    createdDate,
    deleted,
  };
  if (parentId != null) c.parent = { id: parentId };
  return c;
}

const REVIEW_COMMENT_ID = 5001;

// --- tests ------------------------------------------------------------------

test("empty / no human comments → empty block", () => {
  assert.equal(renderDiscussionBlock({ comments: [] }), "");
  assert.equal(renderDiscussionBlock({ comments: [comment({ id: 1, text: "   " })] }), "");
});

test("skips deleted comments, the previous review comment and bot-authored comments", () => {
  const comments = [
    comment({ id: 5000, text: "something by bot", author: { displayName: "MYBOT", name: "MYBOT", slug: "mybot" } }),
    comment({ id: REVIEW_COMMENT_ID, text: "# AI Review — this is the bot report, long", author: { displayName: "MYBOT", name: "MYBOT", slug: "mybot" } }),
    comment({ id: 6000, text: "deleted comment", deleted: true }),
    comment({ id: 7000, text: "A real clarification from the author", author: "Truong Triet", createdDate: 1700000100000 }),
  ];
  const block = renderDiscussionBlock({ comments, botUsernames: ["MYBOT", "mybot@example.com"], reviewCommentId: REVIEW_COMMENT_ID });
  assert.match(block, /Truong Triet/);
  assert.doesNotMatch(block, /MYBOT/);
  assert.doesNotMatch(block, /deleted comment/);
  assert.doesNotMatch(block, /AI Review/);
  assert.match(block, /author replies & clarifications/);
});

test("bot email matches local part (mybot@example.com ↔ MYBOT/mybot)", () => {
  const comments = [
    comment({ id: 1, text: "auto bot report", author: { displayName: "MYBOT", name: "MYBOT", slug: "mybot" } }),
    comment({ id: 2, text: "human note", author: "Dong" }),
  ];
  const block = renderDiscussionBlock({ comments, botUsernames: ["mybot@example.com"], reviewCommentId: null });
  assert.doesNotMatch(block, /auto bot report/);
  assert.match(block, /human note/);
});

test("replies to the AI review are marked; unknown author → '?' never crashes", () => {
  const comments = [
    comment({ id: 10, text: "top-level", parentId: null, createdDate: 1 }),
    comment({ id: 11, text: "reply to review", parentId: REVIEW_COMMENT_ID, createdDate: 2 }),
    comment({ id: 12, text: "plain reply", parentId: 999, createdDate: 3 }),
    { id: 13, text: "no author at all", createdDate: 4 }, // author undefined
  ];
  const block = renderDiscussionBlock({ comments, botUsernames: [], reviewCommentId: REVIEW_COMMENT_ID });
  // header lines + their quoted text lines
  const items = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[0-9]+\. \*\*/.test(l) || l.startsWith("> "));
  assert.match(block, /reply to the AI review/);
  assert.match(block, /plain reply/);
  assert.match(block, /\*\*\?\*\*/); // unknown author fallback
  // newest first ordering: 13, 12, 11, 10 (author "?" is comment 13)
  assert.ok(items.join("\n").indexOf("?") < items.join("\n").indexOf("plain reply"), "unknown-author comment is newest");
  assert.ok(block.indexOf("plain reply") < block.indexOf("reply to review"), "newest-first ordering");
});

test("respects maxComments and trims long comment text", () => {
  const long = "x".repeat(4000);
  const comments = Array.from({ length: 40 }, (_, i) =>
    comment({ id: 100 + i, text: i === 39 ? long : "short note " + i, createdDate: 1700000000000 + i }),
  );
  const block = renderDiscussionBlock({ comments, botUsernames: ["somebot@x.com"], reviewCommentId: null, maxComments: 5, maxTextLen: 50 });
  const headers = block.split("\n").filter((l) => /^[0-9]+\. \*\*/.test(l));
  assert.equal(headers.length, 5, "capped at maxComments");
  assert.ok(block.includes("(truncated)"), "long text is trimmed and marked");
  assert.ok(!block.includes("x".repeat(100)), "long text is trimmed");
});

test("unknown bot identity drops likely auto-generated long comments", () => {
  const comments = [
    comment({ id: 1, text: "short human answer", author: "Dong" }),
    comment({ id: 2, text: "R".repeat(2000), author: { displayName: "??", name: "??", slug: "??" } }), // likely the bot report
  ];
  const block = renderDiscussionBlock({ comments, botUsernames: [], reviewCommentId: null });
  assert.match(block, /short human answer/);
  assert.doesNotMatch(block, /R{100,}/);
});

test("flattenActivitiesToComments selects COMMENTED + nests replies, skips removed", () => {
  const activities = [
    { id: 1, action: "OPENED", comment: null },
    { id: 2, action: "COMMENTED", comment: { id: 10, text: "top", author: { displayName: "Dong" }, createdDate: 100, comments: [{ id: 11, text: "reply", author: { displayName: "Triet" }, createdDate: 101, comments: [] }] } },
    { id: 3, action: "COMMENTED", commentAction: "REMOVED", comment: { id: 12, text: "gone" } },
    { id: 4, action: "MERGED", comment: null },
    { id: 5, action: "COMMENTED", comment: { id: 13, text: "deleted state", state: "DELETED", comments: [] } },
  ];
  const flat = flattenActivitiesToComments(activities);
  assert.equal(flat.length, 2, "only live COMMENTED threads (top + reply)");
  assert.equal(flat[0].id, 10);
  assert.equal(flat[0].parent, null);
  assert.equal(flat[1].id, 11);
  assert.equal(flat[1].parent.id, 10, "reply is anchored to the root comment");
});

test("loadDiscussion never throws and returns '' when client fails", async () => {
  const bad = { getPullRequestActivities: async () => { throw new Error("network down"); } };
  const ref = { projectKey: "ACME", repoSlug: "acme-app", prId: 1 };
  assert.equal(await loadDiscussion({ client: bad, ref, botUsernames: ["d@x.com"] }), "");
  assert.equal(await loadDiscussion({ client: null, ref }), "");
});

test("loadDiscussion returns rendered block from a real client", async () => {
  const client = {
    getPullRequestActivities: async () => [
      { id: 1, action: "COMMENTED", comment: { id: 1, text: "hello author", author: { displayName: "Dong" }, createdDate: 1700000000000, comments: [] } },
      { id: 2, action: "COMMENTED", comment: { id: 2, text: "# big bot report", author: { displayName: "MYBOT", name: "MYBOT", slug: "mybot" }, createdDate: 1700000000100, comments: [] } },
    ],
  };
  const ref = { projectKey: "ACME", repoSlug: "acme-app", prId: 1 };
  const block = await loadDiscussion({ client, ref, botUsernames: ["mybot@example.com"] });
  assert.match(block, /hello author/);
  assert.match(block, /Dong/);
  assert.doesNotMatch(block, /big bot report/);
});

// --- hasNewHumanDiscussion (context-aware same-head dedup) -------------------

test("hasNewHumanDiscussion: false on missing client / invalid since / failure", async () => {
  const ref = { projectKey: "P", repoSlug: "r", prId: 1 };
  assert.equal(await hasNewHumanDiscussion({ client: null, ref, since: "2026-01-01T00:00:00Z" }), false);
  assert.equal(await hasNewHumanDiscussion({ client: { getPullRequestActivities: async () => [{ action: "COMMENTED", comment: { id: 1, createdDate: 1700000000000, author: { displayName: "D" } } }] }, ref, since: 0 }), false);
  const bad = { getPullRequestActivities: async () => { throw new Error("down"); } };
  assert.equal(await hasNewHumanDiscussion({ client: bad, ref, since: "2026-01-01T00:00:00Z" }), false);
});

test("hasNewHumanDiscussion: true when a non-bot comment is newer than since", async () => {
  const since = 1700000000000; // ms epoch
  const client = {
    getPullRequestActivities: async () => [
      { id: 1, action: "COMMENTED", comment: { id: 1, text: "old", author: { displayName: "Dong" }, createdDate: since - 5000, comments: [] } },
      { id: 2, action: "COMMENTED", comment: { id: 2, text: "new clarification", author: { displayName: "Triet" }, createdDate: since + 5000, comments: [] } },
    ],
  };
  const ref = { projectKey: "P", repoSlug: "r", prId: 1 };
  assert.equal(await hasNewHumanDiscussion({ client, ref, since }), true);
});

test("hasNewHumanDiscussion: false when the only newer comments are the bot's or excluded", async () => {
  const since = 1700000000000;
  const client = {
    getPullRequestActivities: async () => [
      { id: 10, action: "COMMENTED", comment: { id: 10, text: "our bot report", author: { displayName: "MYBOT", name: "MYBOT", slug: "mybot" }, createdDate: since + 100, comments: [] } },
      { id: 11, action: "COMMENTED", comment: { id: 11, text: "/ai-review again", author: { displayName: "Dong" }, createdDate: since + 200, comments: [] } },
    ],
  };
  const ref = { projectKey: "P", repoSlug: "r", prId: 1 };
  const bots = ["mybot@example.com"];
  const excludeIds = new Set([11]); // the trigger /ai-review comment itself
  assert.equal(await hasNewHumanDiscussion({ client, ref, since, botUsernames: bots, excludeIds }), false);
});

test("hasNewHumanDiscussion: an ISO-string since works against ms createdDate", async () => {
  const client = {
    getPullRequestActivities: async () => [
      { id: 1, action: "COMMENTED", comment: { id: 1, createdDate: 1700397999957, author: { displayName: "Dong" }, text: "let me explain", comments: [] } },
    ],
  };
  const ref = { projectKey: "P", repoSlug: "r", prId: 1 };
  const sinceIso = new Date(1700397999000).toISOString();
  assert.equal(await hasNewHumanDiscussion({ client, ref, since: sinceIso }), true);
});

// GitHub adapter client tests. The client must mirror the BitbucketClient
// method surface and return normalized (Bitbucket-shaped) PR / activity /
// change objects so pipeline.js, context.js, discussion.js, prImages.js and
// pulls.js keep working unchanged for GitHub PRs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { GitHubClient } from "../src/github.js";
import { flattenActivitiesToComments } from "../src/discussion.js";

const API = "https://api.github.com";

/** A tiny fetch stub: `responses` is a list of `{ url: RegExp, body?, status?, headers? }`. */
function stubFetch(responses) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const hit = responses.find((r) => r.url.test(String(url)));
    if (!hit) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ message: "not found" }) };
    }
    const body = typeof hit.body === "function" ? hit.body(String(url)) : hit.body;
    return {
      ok: hit.status == null ? true : hit.status < 300,
      status: hit.status ?? 200,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      arrayBuffer: async () => Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
      headers: { get: (k) => hit.headers?.[k] ?? null },
    };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const PR = {
  number: 42,
  title: "Add widgets",
  body: "Fixes #7",
  state: "open",
  draft: false,
  merged: false,
  html_url: "https://github.com/acme/widgets/pull/42",
  user: { login: "alice" },
  head: { ref: "feature/widgets", sha: "abc123def456", repo: { name: "widgets", owner: { login: "acme" } } },
  base: { ref: "main", sha: "000aaa111", repo: { name: "widgets", owner: { login: "acme" } } },
};

test("GitHubClient requires a token", () => {
  assert.throws(() => new GitHubClient({}), /token is required/);
  assert.throws(() => new GitHubClient({ token: "" }), /token is required/);
});

test("getPullRequest normalizes onto the Bitbucket PR shape", async () => {
  const stub = stubFetch([{ url: /^https:\/\/api\.github\.com\/repos\/acme\/widgets\/pulls\/42$/, body: PR }]);
  try {
    const client = new GitHubClient({ token: "t", baseUrl: API });
    const pr = await client.getPullRequest({ projectKey: "acme", repoSlug: "widgets", prId: 42 });
    assert.equal(pr.id, 42);
    assert.equal(pr.title, "Add widgets");
    assert.equal(pr.state, "OPEN");
    assert.equal(pr.draft, false);
    assert.equal(pr.fromRef.latestCommit, "abc123def456");
    assert.equal(pr.fromRef.displayId, "feature/widgets");
    assert.equal(pr.toRef.latestCommit, "000aaa111");
    assert.equal(pr.toRef.displayId, "main");
    assert.equal(pr.author.user.displayName, "alice");
    assert.equal(pr.author.user.slug, "alice");
    assert.equal(pr.htmlUrl, "https://github.com/acme/widgets/pull/42");
    // Authorization must be a Bearer token on the API host.
    const call = stub.calls[0];
    assert.match(call.url, /^https:\/\/api\.github\.com\//);
    assert.equal(call.init.headers.Authorization, "Bearer t");
  } finally {
    stub.restore();
  }
});

test("getPullRequest reports merged PRs as MERGED + closed", async () => {
  const merged = { ...PR, state: "closed", merged: true };
  const stub = stubFetch([{ url: /\/pulls\/42$/, body: merged }]);
  try {
    const client = new GitHubClient({ token: "t" });
    const pr = await client.getPullRequest({ projectKey: "acme", repoSlug: "widgets", prId: 42 });
    assert.equal(pr.state, "MERGED");
    assert.equal(pr.closed, true);
  } finally {
    stub.restore();
  }
});

test("getPullRequestRefs maps the head shape for the dashboard", async () => {
  const stub = stubFetch([{ url: /\/pulls\/42$/, body: PR }]);
  try {
    const client = new GitHubClient({ token: "t" });
    const refs = await client.getPullRequestRefs({ projectKey: "acme", repoSlug: "widgets", prId: 42 });
    assert.deepEqual(refs, {
      headSha: "abc123def456",
      branch: "feature/widgets",
      targetBranch: "main",
      author: { user: { slug: "alice", name: "alice", displayName: "alice", emailAddress: null, login: "alice" } },
      state: "OPEN",
      closed: false,
    });
  } finally {
    stub.restore();
  }
});

test("getPullRequestCommits maps commits and follows Link-header pagination", async () => {
  const p1 = [
    { sha: "sha-newest", commit: { message: "second", committer: { date: "2026-11-02T10:00:00Z" } }, author: { login: "bob" } },
    { sha: "sha-mid", commit: { message: "first", committer: { date: "2026-11-01T10:00:00Z" } }, author: { login: "bob" } },
  ];
  const p2 = [{ sha: "sha-old", commit: { message: "origin", committer: { date: "2026-10-30T10:00:00Z" } }, author: { login: "alice" } }];
  const linkNext = `<${API}/repos/acme/widgets/pulls/42/commits?per_page=100&page=2>; rel="next", <${API}/repos/acme/widgets/pulls/42/commits?per_page=100&page=2>; rel="last"`;
  const stub = stubFetch([
    { url: /\/pulls\/42\/commits\?per_page=100$/, body: p1, headers: { link: linkNext } },
    { url: /page=2/, body: p2 },
  ]);
  try {
    const client = new GitHubClient({ token: "t" });
    const commits = await client.getPullRequestCommits({ projectKey: "acme", repoSlug: "widgets", prId: 42 });
    assert.equal(commits.length, 3);
    assert.deepEqual(commits[0], { id: "sha-newest", message: "second", author: "bob", timestamp: Date.parse("2026-11-02T10:00:00Z") });
    assert.equal(commits[2].id, "sha-old");
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test("pagination refuses an off-host rel=next Link header (no token leak)", async () => {
  const p1 = [
    { sha: "sha-newest", commit: { message: "second", committer: { date: "2026-11-02T10:00:00Z" } }, author: { login: "bob" } },
    { sha: "sha-mid", commit: { message: "first", committer: { date: "2026-11-01T10:00:00Z" } }, author: { login: "bob" } },
  ];
  // GitHub does not link off-host, but a MITM'd / misbehaving GHES could.
  const evilLink = `<https://evil.example/repos/acme/widgets/pulls/42/commits?page=2>; rel="next"`;
  const stub = stubFetch([{ url: /\/pulls\/42\/commits\?per_page=100$/, body: p1, headers: { link: evilLink } }]);
  try {
    const client = new GitHubClient({ token: "t" });
    const commits = await client.getPullRequestCommits({ projectKey: "acme", repoSlug: "widgets", prId: 42 });
    // Pagination stops after page 1; the evil host is never contacted and the
    // bearer token never leaves the API host.
    assert.equal(commits.length, 2);
    assert.equal(stub.calls.length, 1, "only the first page should be fetched");
    assert.ok(stub.calls[0].url.startsWith(API));
    assert.match(stub.calls[0].init.headers.Authorization, /^Bearer /);
  } finally {
    stub.restore();
  }
});

test("request refuses an absolute foreign URL before fetch (no token leak)", async () => {
  const stub = stubFetch([]);
  try {
    const client = new GitHubClient({ token: "t" });
    await assert.rejects(
      () => client.request("https://evil.example/steal"),
      /foreign host "evil\.example"/,
    );
    assert.equal(stub.calls.length, 0, "fetch must never be reached with the token");
  } finally {
    stub.restore();
  }
});

test("request allows an absolute URL on the configured API host", async () => {
  const stub = stubFetch([{ url: /^https:\/\/api\.github\.com\/repos\/acme\/widgets\/pulls\/42$/, body: {} }]);
  try {
    const client = new GitHubClient({ token: "t" });
    await client.request(`${API}/repos/acme/widgets/pulls/42`);
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0].url.startsWith(API));
  } finally {
    stub.restore();
  }
});

test("getUnifiedDiff asks for the .diff media type and returns raw text", async () => {
  const stub = stubFetch([{ url: /\/pulls\/42$/, body: "diff --git a/x b/x\nindex 000..111\n--- a/x\n+++ b/x\n+hello\n" }]);
  try {
    const client = new GitHubClient({ token: "t" });
    const diff = await client.getUnifiedDiff({ projectKey: "acme", repoSlug: "widgets", prId: 42 });
    assert.match(diff, /diff --git/);
    assert.equal(stub.calls[0].init.headers.Accept, "application/vnd.github.v3.diff");
  } finally {
    stub.restore();
  }
});

test("getChangedFiles maps statuses onto Bitbucket /changes shape", async () => {
  const files = [
    { filename: "src/add.js", status: "added" },
    { filename: "src/mod.js", status: "modified" },
    { filename: "src/del.js", status: "removed" },
    { filename: "src/new.js", status: "renamed", previous_filename: "src/old.js" },
  ];
  const stub = stubFetch([{ url: /\/pulls\/42\/files/, body: files }]);
  try {
    const client = new GitHubClient({ token: "t" });
    const changes = await client.getChangedFiles({ projectKey: "acme", repoSlug: "widgets", prId: 42 });
    assert.deepEqual(changes[0], { type: "ADDED", path: { toString: "src/add.js" }, srcPath: null, additions: null, deletions: null });
    assert.equal(changes[2].type, "DELETED");
    assert.equal(changes[3].type, "RENAMED");
    assert.equal(changes[3].path.toString, "src/new.js");
    assert.equal(changes[3].source.toString, "src/old.js");
  } finally {
    stub.restore();
  }
});

test("getPullRequestActivities synthesizes Bitbucket-style COMMENTED activities", async () => {
  const stub = stubFetch([
    { url: /\/issues\/42\/comments/, body: [{ id: 10, body: "Looks good", user: { login: "bob" }, created_at: "2026-11-02T10:00:00Z" }] },
    { url: /\/pulls\/42\/reviews\?/, body: [{ id: 20, body: "", user: { login: "carol" }, submitted_at: "2026-11-03T10:00:00Z" }] },
    { url: /\/pulls\/42\/comments\?/, body: [{ id: 30, body: "inline note", user: { login: "alice" }, created_at: "2026-11-04T10:00:00Z" }] },
  ]);
  try {
    const client = new GitHubClient({ token: "t" });
    const activities = await client.getPullRequestActivities({ projectKey: "acme", repoSlug: "widgets", prId: 42 });
    assert.equal(activities.length, 2, "empty review body is skipped");
    assert.deepEqual(activities[0], {
      action: "COMMENTED",
      commentAction: null,
      comment: {
        id: 10,
        text: "Looks good",
        author: normalizeUserExpect("bob"),
        createdDate: Date.parse("2026-11-02T10:00:00Z"),
        comments: [],
      },
    });
    // The shared discussion module must consume the synthesized feed unchanged.
    const comments = flattenActivitiesToComments(activities);
    assert.equal(comments.length, 2);
    assert.equal(comments[0].text, "Looks good");
    assert.equal(comments[1].text, "inline note");
  } finally {
    stub.restore();
  }
});

function normalizeUserExpect(login) {
  return { slug: login, name: login, displayName: login, emailAddress: null, login };
}

test("getFileRaw fetches contents with the raw media type and nulls on 404", async () => {
  const stub = stubFetch([
    { url: /\/contents\/AGENTS\.md/, body: "# Agents\nrules" },
  ]);
  try {
    const client = new GitHubClient({ token: "t" });
    const raw = await client.getFileRaw({ projectKey: "acme", repoSlug: "widgets", path: "AGENTS.md", at: "abc123" });
    assert.equal(raw, "# Agents\nrules");
    assert.match(stub.calls[0].url, /ref=abc123/);
    assert.equal(stub.calls[0].init.headers.Accept, "application/vnd.github.v3.raw");
  } finally {
    stub.restore();
  }
  const stub404 = stubFetch([{ url: /\/contents\/NOPE/, status: 404 }]);
  try {
    const client = new GitHubClient({ token: "t" });
    const missing = await client.getFileRaw({ projectKey: "acme", repoSlug: "widgets", path: "NOPE.txt", at: "abc" });
    assert.equal(missing, null);
  } finally {
    stub404.restore();
  }
});

test("postPullRequestComment posts {body} to the issue comments endpoint", async () => {
  const stub = stubFetch([{ url: /\/issues\/42\/comments$/, body: { id: 99, html_url: "https://github.com/acme/widgets/pull/42#issuecomment-99" } }]);
  try {
    const client = new GitHubClient({ token: "t" });
    const comment = await client.postPullRequestComment({ projectKey: "acme", repoSlug: "widgets", prId: 42, text: "report" });
    assert.equal(comment.id, 99);
    assert.equal(stub.calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(stub.calls[0].init.body), { body: "report" });
  } finally {
    stub.restore();
  }
});

test("request surfaces GitHub error messages with the HTTP status", async () => {
  const stub = stubFetch([{ url: /^/, status: 401, body: { message: "Bad credentials" } }]);
  try {
    const client = new GitHubClient({ token: "bad" });
    await assert.rejects(() => client.getPullRequest({ projectKey: "acme", repoSlug: "widgets", prId: 42 }), (err) => {
      assert.equal(err.status, 401);
      assert.match(err.message, /Bad credentials/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

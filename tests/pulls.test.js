import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

import { buildPullMap, listPulls, keyOf, clearPullCache } from "../src/pulls.js";

// --- helpers ----------------------------------------------------------------

function makeJobDir(jobsDir, name, { ref, reviewedSha, startedAt, stage = "complete", title }) {
  const dir = path.join(jobsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "job-meta.json"),
    JSON.stringify({ ref, reviewedSha, startedAt, title }),
  );
  writeFileSync(
    path.join(dir, "status.json"),
    JSON.stringify({
      job: name,
      ref,
      reviewedSha,
      startedAt,
      stage,
      consensus: {
        reviewed_sha: reviewedSha,
        findings: [{ severity: "HIGH", title: "f1" }],
      },
    }),
  );
}

function freshCfg() {
  const jobs = mkdtempSync(path.join(os.tmpdir(), "pulls-test-"));
  return { dirs: { jobs }, bitbucket: { baseUrl: "https://bb.example.com" } };
}

function fakeClient({ heads = {}, prCommits = {}, branches = {}, meta = {} }) {
  const calls = { head: [], commits: [] };
  return {
    calls,
    async getPullRequestRefs(ref) {
      calls.head.push({ ...ref });
      const sha = heads[keyOf(ref)];
      // Sentinel "404" mimics Bitbucket reporting the PR is gone (purged after
      // merge/decline): an HTTP 404 with a "does not exist" payload.
      if (sha === "404") {
        throw Object.assign(
          new Error(`Pull request ${ref.prId} does not exist in ${ref.projectKey}/${ref.repoSlug}.`),
          { status: 404 },
        );
      }
      if (sha === "ERR") throw new Error("network down");
      const b = branches[keyOf(ref)] || {};
      const m = meta[keyOf(ref)] || {};
      return {
        headSha: sha ?? null,
        branch: b.branch ?? "feature/local-test",
        targetBranch: b.targetBranch ?? "master",
        author: m.author ?? null,
        state: m.state ?? null,
        closed: m.closed ?? false,
      };
    },
    async getPullRequestCommits(ref) {
      calls.commits.push({ ...ref });
      return (prCommits[keyOf(ref)] || []).map((id) => ({
        id,
        message: `new work ${id}`,
        author: "junior@example.com",
        timestamp: 1700000000000,
      }));
    },
  };
}

// --- tests ------------------------------------------------------------------

test("keyOf namespaces GitHub so it can never collide with a Bitbucket key", () => {
  // Bitbucket keys stay exactly as before.
  assert.equal(keyOf({ projectKey: "ACME", repoSlug: "acme-app", prId: 42 }), "ACME/acme-app#42");
  assert.equal(keyOf({ projectKey: "github", repoSlug: "acme-app", prId: 42 }), "github/acme-app#42");
  // GitHub refs are prefixed — the same owner/repo#N on the other platform is distinct.
  assert.equal(keyOf({ projectKey: "acme", repoSlug: "widgets", prId: 3, platform: "github" }), "github:acme/widgets#3");
  assert.notEqual(
    keyOf({ projectKey: "acme", repoSlug: "widgets", prId: 3, platform: "github" }),
    keyOf({ projectKey: "acme", repoSlug: "widgets", prId: 3 }),
  );
  assert.equal(keyOf(null), null);
});

test("listPulls(offline) groups jobs by PR and keeps per-review history", async () => {
  const cfg = freshCfg();
  const ref = { projectKey: "ACME", repoSlug: "acme-app", prId: 5580 };
  makeJobDir(cfg.dirs.jobs, "ACME-acme-app-PR5580-aaa11111", {
    ref,
    reviewedSha: "aaa11111",
    startedAt: "2026-10-19T13:00:00.000Z",
    title: "Pull request #5580: Bugfix/ACME-42893 CC autobacklog",
  });
  makeJobDir(cfg.dirs.jobs, "ACME-acme-app-PR5580-bbb22222", {
    ref,
    reviewedSha: "bbb22222",
    startedAt: "2026-10-20T09:00:00.000Z",
    title: "Pull request #5580: Bugfix/ACME-42893 CC autobacklog",
  });

  const { pulls, live } = await listPulls(cfg, { live: false });
  assert.equal(live, false);
  assert.equal(pulls.length, 1);
  const p = pulls[0];
  assert.equal(p.prId, 5580);
  assert.equal(p.app, "ACME/acme-app");
  assert.equal(p.title, "Bugfix/ACME-42893 CC autobacklog"); // prefix stripped
  assert.equal(p.reviews.length, 2);
  // Reviews sorted newest first.
  assert.equal(p.reviews[0].reviewedSha, "bbb22222");
  assert.equal(p.reviews[0].findings, 1);
  assert.equal(p.reviews[1].reviewedSha, "aaa11111");
  assert.equal(p.latestReview.job, "ACME-acme-app-PR5580-bbb22222");
  assert.equal(p.stale, null); // not enriched offline
  assert.ok(p.url.startsWith("https://bb.example.com/projects/ACME"));
});

test("listPulls(live) flags stale PRs and lists new commits via the PR commit list", async () => {
  clearPullCache();
  const cfg = freshCfg();
  const ref = { projectKey: "ACME", repoSlug: "acme-app", prId: 5580 };
  makeJobDir(cfg.dirs.jobs, "ACME-acme-app-PR5580-aaa11111", {
    ref,
    reviewedSha: "aaa11111",
    startedAt: "2026-10-20T09:00:00.000Z",
    title: "PR #5580: something",
  });
  const client = fakeClient({
    heads: { "ACME/acme-app#5580": "ccc99999" },
    branches: { "ACME/acme-app#5580": { branch: "bugfix/ACME-42893", targetBranch: "master" } },
    prCommits: { "ACME/acme-app#5580": ["ccc99999", "fff88888", "aaa11111"] }, // newest-first
  });

  const { pulls, live } = await listPulls(cfg, { client, live: true, ttlMs: 600_000 });
  assert.equal(live, true);
  const p = pulls[0];
  assert.equal(p.headSha, "ccc99999");
  assert.equal(p.branch, "bugfix/ACME-42893");
  assert.equal(p.targetBranch, "master");
  assert.equal(p.stale, true);
  // Commits newer than the last-reviewed aaa11111 (newest-first list).
  assert.deepEqual(
    p.newCommits.map((c) => c.id),
    ["ccc99999", "fff88888"],
  );
  assert.equal(p.historyRewritten, false);
  assert.equal(client.calls.head.length, 1);
  assert.equal(client.calls.commits.length, 1);
});

test("live head is cached within TTL and cleared by clearPullCache()", async () => {
  clearPullCache();
  const cfg = freshCfg();
  const ref = { projectKey: "ACME", repoSlug: "acme-app", prId: 5580 };
  makeJobDir(cfg.dirs.jobs, "ACME-acme-app-PR5580-aaa11111", {
    ref,
    reviewedSha: "aaa11111",
    startedAt: "2026-10-20T09:00:00.000Z",
    title: "PR #5580: something",
  });
  const client = fakeClient({ heads: { "ACME/acme-app#5580": "ccc99999" } });

  await listPulls(cfg, { client, live: true, ttlMs: 600_000 });
  const second = await listPulls(cfg, { client, live: true, ttlMs: 600_000 });
  assert.equal(client.calls.head.length, 1, "cache hit should skip refetch");
  assert.equal(second.pulls[0].stale, true);

  clearPullCache();
  await listPulls(cfg, { client, live: true, ttlMs: 600_000 });
  assert.equal(client.calls.head.length, 2, "clearPullCache forces refetch");
});

test("head lookups that fail do not break the pull list; up-to-date PRs are not stale", async () => {
  clearPullCache();
  const cfg = freshCfg();
  const refGood = { projectKey: "ACME", repoSlug: "acme-app", prId: 5580 };
  const refErr = { projectKey: "ACME", repoSlug: "other-app", prId: 12 };
  makeJobDir(cfg.dirs.jobs, "ACME-acme-app-PR5580-aaa11111", {
    ref: refGood,
    reviewedSha: "aaa11111",
    startedAt: "2026-10-20T09:00:00.000Z",
    title: "PR #5580",
  });
  makeJobDir(cfg.dirs.jobs, "ACME-other-app-PR12-bbb22222", {
    ref: refErr,
    reviewedSha: "bbb22222",
    startedAt: "2026-10-20T10:00:00.000Z",
    title: "PR #12",
  });
  const client = fakeClient({
    heads: { "ACME/acme-app#5580": "aaa11111", "ACME/other-app#12": "ERR" },
  });

  const { pulls } = await listPulls(cfg, { client, live: true, ttlMs: 600_000 });
  const byId = Object.fromEntries(pulls.map((p) => [p.prId, p]));
  assert.equal(byId["5580"].stale, false, "head equals last reviewed → up to date");
  assert.equal(byId["5580"].newCommits.length, 0);
  assert.equal(byId["12"].stale, null, "lookup failed → unknown");
  assert.ok(byId["12"].newCommits.length === 0);
  assert.equal(byId["12"].notFound, false, "transient network error is fail-open, not a 404");
  assert.equal(byId["12"].unreviewable, false, "network outage must NOT dim/unblock the PR");
});

test("branch rewritten after the review is detected and surfaced", async () => {
  clearPullCache();
  const cfg = freshCfg();
  const ref = { projectKey: "ACME", repoSlug: "acme-app", prId: 5590 };
  makeJobDir(cfg.dirs.jobs, "ACME-acme-app-PR5590-aaa11111", {
    ref,
    reviewedSha: "aaa11111",
    startedAt: "2026-10-20T09:00:00.000Z",
    title: "PR #5590",
  });
  // The reviewed aaa11111 is gone from the (rebuilt) branch.
  const client = fakeClient({
    heads: { "ACME/acme-app#5590": "zzz77777" },
    prCommits: { "ACME/acme-app#5590": ["zzz77777", "yyy66666"] },
  });

  const { pulls } = await listPulls(cfg, { client, live: true, ttlMs: 600_000 });
  const p = pulls[0];
  assert.equal(p.stale, true);
  assert.equal(p.historyRewritten, true);
  assert.deepEqual(
    p.newCommits.map((c) => c.id),
    ["zzz77777", "yyy66666"],
  );
});

test("live PR author and state are surfaced (owner + merged/declined → closed)", async () => {
  clearPullCache();
  const cfg = freshCfg();
  const mergedRef = { projectKey: "ACME", repoSlug: "acme-app", prId: 5600 };
  const declinedRef = { projectKey: "ACME", repoSlug: "acme-gateway", prId: 300 };
  makeJobDir(cfg.dirs.jobs, "ACME-acme-app-PR5600-aaa11111", {
    ref: mergedRef,
    reviewedSha: "aaa11111",
    startedAt: "2026-10-20T09:00:00.000Z",
    title: "PR #5600",
  });
  makeJobDir(cfg.dirs.jobs, "ACME-acme-gateway-PR300-bbb22222", {
    ref: declinedRef,
    reviewedSha: "bbb22222",
    startedAt: "2026-10-20T10:00:00.000Z",
    title: "PR #300",
  });
  const client = fakeClient({
    heads: { "ACME/acme-app#5600": "aaa11111", "ACME/acme-gateway#300": "bbb22222" },
    meta: {
      "ACME/acme-app#5600": {
        author: { displayName: "Ada Lovelace", name: "ada.lovelace", emailAddress: "ada@example.com" },
        state: "MERGED",
        closed: true,
      },
      "ACME/acme-gateway#300": {
        author: { displayName: "Grace Hopper", name: "grace.hopper" },
        state: "DECLINED",
        closed: true,
      },
    },
  });

  const { pulls } = await listPulls(cfg, { client, live: true, ttlMs: 600_000 });
  const byId = Object.fromEntries(pulls.map((p) => [p.prId, p]));
  const merged = byId["5600"];
  assert.equal(merged.owner, "Ada Lovelace");
  assert.equal(merged.state, "MERGED");
  assert.equal(merged.closed, true);
  const declined = byId["300"];
  assert.equal(declined.owner, "Grace Hopper");
  assert.equal(declined.state, "DECLINED");
  assert.equal(declined.closed, true);
});

test("offline pulls carry no owner/state (unknown until enriched)", async () => {
  clearPullCache();
  const cfg = freshCfg();
  const ref = { projectKey: "ACME", repoSlug: "acme-app", prId: 5610 };
  makeJobDir(cfg.dirs.jobs, "ACME-acme-app-PR5610-aaa11111", {
    ref,
    reviewedSha: "aaa11111",
    startedAt: "2026-10-20T09:00:00.000Z",
    title: "PR #5610",
  });
  const { pulls } = await listPulls(cfg, { live: false });
  const p = pulls[0];
  assert.equal(p.owner, null);
  assert.equal(p.state, null);
  assert.equal(p.closed, false);
  assert.equal(p.notFound, false);
  assert.equal(p.unreviewable, false);
});

test("PRs that 404 in Bitbucket (deleted after merge/decline) are notFound + unreviewable", async () => {
  clearPullCache();
  const cfg = freshCfg();
  const ref = { projectKey: "ACME", repoSlug: "acme-app", prId: 5604 };
  makeJobDir(cfg.dirs.jobs, "ACME-acme-app-PR5604-aaa11111", {
    ref,
    reviewedSha: "aaa11111",
    startedAt: "2026-10-20T09:00:00.000Z",
    title: "PR #5604",
  });
  const client = fakeClient({ heads: { "ACME/acme-app#5604": "404" } });

  const { pulls } = await listPulls(cfg, { client, live: true, ttlMs: 600_000 });
  const p = pulls[0];
  assert.equal(p.prId, 5604);
  assert.equal(p.notFound, true, "404 means Bitbucket no longer has this PR");
  assert.equal(p.unreviewable, true, "a gone PR can never be reviewed again");
  assert.equal(p.closed, false, "notFound is a distinct terminal reason (not a state)");
  assert.equal(p.state, null, "no state was returned for the purged PR");
  assert.equal(p.stale, null, "no head to compare → unknown staleness");
  assert.match(p.headError, /does not exist/i);
});

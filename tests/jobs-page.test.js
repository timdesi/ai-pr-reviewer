// listJobsPage (paginated + slim) and finalizeStaleJobs (boot-time sweep) in
// src/pipeline.js — issue #6: keep the dashboard list cheap and never leave a
// job orphaned as "running" forever after a pod restart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { listJobsPage, finalizeStaleJobs } from "../src/pipeline.js";

function tempJobsDir() {
  return mkdtempSync(path.join(tmpdir(), "pl-jobs-"));
}

function makeConfig(jobsDir) {
  return { dirs: { jobs: jobsDir } };
}

function writeJob(jobsDir, name, status) {
  const dir = path.join(jobsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "job-meta.json"),
    JSON.stringify({ job: name, startedAt: status.startedAt, ref: status.ref }, null, 2),
  );
  writeFileSync(path.join(dir, "status.json"), JSON.stringify(status, null, 2));
}

const ref = (prId) => ({ projectKey: "ACME", repoSlug: "app", prId });

test("listJobsPage returns newest-first slim jobs with total", () => {
  const dir = tempJobsDir();
  const statusOf = (prId, sha, startedAt) => ({
    job: `ACME-app-PR${prId}-${sha}`,
    appVersion: "0.5.2",
    ref: ref(prId),
    title: `PR #${prId}`,
    reviewedSha: sha,
    startedAt,
    stage: "complete",
    completedAt: startedAt.replace("Z", "Z"),
    error: null,
    publish: { published: true, commentId: 1 },
    agents: {
      a: { key: "a", label: "Reviewer A", status: "ok", attempts: [{ ok: true, text: "huge-streaming-text".repeat(100) }] },
    },
    consensus: { findings: [{ title: "x" }] },
  });

  try {
    writeJob(dir, "ACME-app-PR2-bbbbbbbb", statusOf(2, "bbbbbbbb", "2026-11-19T10:00:00Z"));
    writeJob(dir, "ACME-app-PR1-aaaaaaaa", statusOf(1, "aaaaaaaa", "2026-11-19T09:00:00Z"));
    writeJob(dir, "ACME-app-PR3-cccccccc", statusOf(3, "cccccccc", "2026-11-19T11:00:00Z"));

    const config = makeConfig(dir);

    // Default page size 50 → everything on one page, newest first.
    const all = listJobsPage(config);
    assert.equal(all.total, 3);
    assert.equal(all.jobs.length, 3);
    assert.ok(all.jobs[0].reviewedSha.startsWith("cccccccc"), "newest job first");

    // Slim: heavy streaming/consensus text is dropped, list fields survive.
    const first = all.jobs[0];
    assert.equal(first.title, "PR #3");
    assert.equal(first.stage, "complete");
    assert.equal(first.ref.prId, 3);
    assert.equal(first.agents.a.status, "ok");
    assert.ok(!String(first.consensus?.findings).includes("title"), "consensus kept as count, not full findings");
    assert.equal(first.consensus.findings, 1);
    assert.ok(!JSON.stringify(first).includes("huge-streaming-text"), "agent streaming text omitted from slim list");

    // Pagination: limit + offset slice the newest-first order.
    const page1 = listJobsPage(config, { limit: 2, offset: 0 });
    assert.equal(page1.total, 3);
    assert.deepEqual(page1.jobs.map((j) => j.ref.prId), [3, 2]);
    const page2 = listJobsPage(config, { limit: 2, offset: 2 });
    assert.deepEqual(page2.jobs.map((j) => j.ref.prId), [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listJobsPage returns empty for a missing jobs dir", () => {
  const out = listJobsPage(makeConfig(path.join(tempJobsDir(), "nope")));
  assert.deepEqual(out, { jobs: [], total: 0, limit: 50, offset: 0, app: "" });
});

test("finalizeStaleJobs marks orphaned running jobs failed, leaves others alone", () => {
  const dir = tempJobsDir();
  const base = {
    appVersion: "0.5.2",
    ref: ref(1),
    reviewedSha: "aaaaaaaa",
    startedAt: "2026-11-19T22:28:58Z",
    error: null,
    agents: {
      a: { key: "a", label: "Reviewer A", status: "ok" },
      b: { key: "b", label: "Reviewer B", status: "running", attempts: [] },
      c: { key: "c", label: "Reviewer C", status: "pending", attempts: [] },
      consensus: { key: "consensus", label: "Consensus", status: "pending" },
    },
  };

  try {
    // Orphaned: still "review", b/c running — must be finalized.
    writeJob(dir, "ACME-app-PR1-aaaaaaaa", { ...base, job: "ACME-app-PR1-aaaaaaaa", stage: "review" });
    // Another orphaned, in "fetch".
    writeJob(dir, "ACME-app-PR2-bbbbbbbb", {
      ...base,
      job: "ACME-app-PR2-bbbbbbbb",
      ref: ref(2),
      stage: "fetch",
      agents: {
        a: { key: "a", label: "Reviewer A", status: "pending" },
        consensus: { key: "consensus", label: "Consensus", status: "pending" },
      },
    });
    // Healthy/finished — must be untouched.
    writeJob(dir, "ACME-app-PR3-cccccccc", {
      ...base,
      job: "ACME-app-PR3-cccccccc",
      ref: ref(3),
      stage: "complete",
      completedAt: "2026-11-20T00:00:00Z",
    });

    const n = finalizeStaleJobs(makeConfig(dir));
    assert.equal(n, 2);

    const s1 = JSON.parse(readFileSync(path.join(dir, "ACME-app-PR1-aaaaaaaa", "status.json"), "utf8"));
    assert.equal(s1.stage, "failed");
    assert.ok(/startup sweep/i.test(s1.error));
    assert.ok(s1.completedAt, "completedAt set on finalized job");
    assert.equal(s1.agents.b.status, "failed");
    assert.equal(s1.agents.c.status, "failed");
    assert.equal(s1.agents.a.status, "ok", "already-ok agent untouched");
    assert.equal(s1.agents.consensus.status, "failed");

    const s2 = JSON.parse(readFileSync(path.join(dir, "ACME-app-PR2-bbbbbbbb", "status.json"), "utf8"));
    assert.equal(s2.stage, "failed");
    assert.equal(s2.agents.a.status, "failed");

    const s3 = JSON.parse(readFileSync(path.join(dir, "ACME-app-PR3-cccccccc", "status.json"), "utf8"));
    assert.equal(s3.stage, "complete", "finished job untouched");
    assert.equal(s3.completedAt, "2026-11-20T00:00:00Z");

    // Idempotent: running again finalizes nothing.
    assert.equal(finalizeStaleJobs(makeConfig(dir)), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalizeStaleJobs is a no-op on a missing jobs dir", () => {
  assert.equal(finalizeStaleJobs(makeConfig(path.join(tempJobsDir(), "nope"))), 0);
});

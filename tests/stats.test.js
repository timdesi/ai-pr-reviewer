import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

import { computeStats } from "../src/stats.js";

// --- helpers ----------------------------------------------------------------

function makeJobDir(jobsDir, name, { ref, startedAt, stage = "complete", published = false, costs = {} }) {
  const dir = path.join(jobsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "job-meta.json"),
    JSON.stringify({ ref, startedAt, title: `PR #${ref.prId}` }),
  );
  writeFileSync(
    path.join(dir, "status.json"),
    JSON.stringify({
      job: name,
      ref,
      startedAt,
      stage,
      agents: {
        a: { status: "ok", cost: costs.a || null },
        b: { status: "ok", cost: costs.b || null },
        consensus: { status: "ok", cost: costs.consensus || null },
      },
      vision: costs.vision ? { model: "prov-gateway/mdl-gw", cost: costs.vision } : null,
      consensus: stage === "complete" ? { findings: [{ severity: "LOW", title: "f" }] } : null,
      publish: published ? { published: true, commentId: 1 } : { published: false },
    }),
  );
}

function freshCfg(jobsDir) {
  return { dirs: { jobs: jobsDir }, bitbucket: {}, job: { allowedReviewerUsers: [] } };
}

// --- tests ------------------------------------------------------------------

test("stats on an empty jobs dir are all zeros", () => {
  const jobs = mkdtempSync(path.join(os.tmpdir(), "stats-test-empty-"));
  try {
    const s = computeStats(freshCfg(jobs));
    assert.equal(s.totals.jobs, 0);
    assert.equal(s.totals.reviews, 0);
    assert.equal(s.totals.prs, 0);
    assert.equal(s.totals.repos, 0);
    assert.equal(s.totals.cost.total, 0);
    assert.equal(s.totals.firstRun, null);
    assert.equal(s.cadence.all.jobs, 0);
    assert.deepEqual(s.series.day, []);
    assert.equal(s.usersOnboard.count, 0);
  } finally {
    rmSync(jobs, { recursive: true, force: true });
  }
});

test("stats totals aggregate jobs, distinct PRs/repos, cost and published", () => {
  const jobs = mkdtempSync(path.join(os.tmpdir(), "stats-test-"));
  try {
    const ref1 = { projectKey: "ACME", repoSlug: "acme-app", prId: 100 };
    const ref2 = { projectKey: "ACME", repoSlug: "acme-gateway", prId: 50 };
    // Two runs of the SAME PR on the same day (counts as 2 jobs, 1 PR), one published.
    makeJobDir(jobs, "J-1", {
      ref: ref1,
      startedAt: "2026-10-19T09:00:00.000Z",
      published: true,
      costs: { a: { input: 0.001, cache: 0, output: 0, total: 0.001 }, consensus: { input: 0, cache: 0, output: 0, total: 0.002 } },
    });
    makeJobDir(jobs, "J-2", {
      ref: ref1,
      startedAt: "2026-10-19T14:00:00.000Z",
      costs: { b: { input: 0, cache: 0, output: 0, total: 0.01 } },
    });
    // One run of a DIFFERENT repo/PR a week later.
    makeJobDir(jobs, "J-3", {
      ref: ref2,
      startedAt: "2026-10-26T10:00:00.000Z",
      published: true,
      costs: { consensus: { input: 0, cache: 0, output: 0, total: 0.005 } },
    });

    const s = computeStats(freshCfg(jobs));
    const t = s.totals;
    assert.equal(t.jobs, 3);
    assert.equal(t.reviews, 3, "a review run == a job");
    assert.equal(t.prs, 2);
    assert.equal(t.repos, 2);
    assert.equal(t.published, 2);
    assert.equal(t.findings.total, 3, "one finding per complete job");
    assert.equal(t.findings.LOW, 3, "consensus findings are LOW in the test fixtures");
    assert.equal(t.findings.CRITICAL + t.findings.HIGH + t.findings.MEDIUM, 0);
    assert.equal(Math.round(t.cost.total * 1000) / 1000, Math.round((0.001 + 0.002 + 0.01 + 0.005) * 1000) / 1000);
    assert.equal(s.cadence.all.prs, 2);
    assert.equal(s.cadence.all.cost, 0.018);

    // Day series: 2 jobs + 1 PR on Oct 19, 1 job + 1 PR on Oct 26.
    const day = s.series.day;
    assert.equal(day.length >= 8, true, "zero-filled day buckets between runs");
    const oct19 = day.find((d) => d.t.startsWith("2026-10-19"));
    assert.equal(oct19.jobs, 2);
    assert.equal(oct19.prs, 1);
    assert.equal(oct19.published, 1);
    const oct26 = day.find((d) => d.t.startsWith("2026-10-26"));
    assert.equal(oct26.jobs, 1);
    assert.equal(oct26.prs, 1);

    // Week series: the two runs fall in the same ISO week; J-3 in the next.
    const week = s.series.week;
    assert.equal(week.length, 2);
    assert.equal(week.reduce((n, w) => n + w.jobs, 0), 3);
    assert.equal(week.reduce((n, w) => n + w.prs, 0), 2);

    // Monthly series: both in the same month.
    const month = s.series.month;
    assert.equal(month.length, 1);
    assert.equal(month[0].jobs, 3);

    // Cadence averages are finite and > 0.
    for (const gran of ["day", "week", "month"]) {
      assert.ok(Number.isFinite(s.cadence[gran].prs));
      assert.ok(s.cadence[gran].prs > 0);
      assert.ok(s.cadence[gran].cost > 0);
    }
  } finally {
    rmSync(jobs, { recursive: true, force: true });
  }
});

test("stats include vision transcription cost in totals", () => {
  const jobs = mkdtempSync(path.join(os.tmpdir(), "stats-test-vision-"));
  try {
    const ref = { projectKey: "ACME", repoSlug: "acme-app", prId: 55 };
    makeJobDir(jobs, "J-1", {
      ref,
      startedAt: "2026-10-20T09:00:00.000Z",
      published: true,
      costs: {
        a: { input: 0.001, cache: 0, output: 0, total: 0.001 },
        vision: { input: 0.0002, cache: 0, output: 0.0001, total: 0.0003 },
      },
    });
    const s = computeStats(freshCfg(jobs));
    assert.equal(Math.round(s.totals.cost.total * 10000) / 10000, 0.0013, "agent + vision costs summed");
    assert.equal(Math.round(s.totals.cost.input * 10000) / 10000, 0.0012, "input: agent 0.001 + vision 0.0002");
    assert.equal(s.cadence.all.cost, 0.0013);
  } finally {
    rmSync(jobs, { recursive: true, force: true });
  }
});

test("users onboard comes from the ALLOWED_REVIEWER_USERS config list", () => {
  const jobs = mkdtempSync(path.join(os.tmpdir(), "stats-test-"));
  try {
    const ref = { projectKey: "ACME", repoSlug: "acme-app", prId: 1 };
    makeJobDir(jobs, "J-1", { ref, startedAt: "2026-10-19T09:00:00.000Z" });
    const cfg = // freshCfg variant with a populated allowlist
      freshCfg(jobs);
    cfg.job.allowedReviewerUsers = ["ldq1hc", "ttt2", "desi"];
    const s = computeStats(cfg);
    assert.equal(s.usersOnboard.count, 3);
    assert.deepEqual(s.usersOnboard.list, ["ldq1hc", "ttt2", "desi"]);
  } finally {
    rmSync(jobs, { recursive: true, force: true });
  }
});

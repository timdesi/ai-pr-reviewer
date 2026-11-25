// App-filtering of the dashboard Jobs list (src/pipeline.js + src/server.js):
//   - listJobsPage({ app }) filters BEFORE pagination, so totals and pages are
//     correct per app without hiding off-page matches
//   - listJobApps() gives app → job-count for the picker (incl. apps whose PRs
//     are no longer open)
//   - the server routes /api/jobs?app & /api/jobs/apps

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { listJobsPage, listJobApps } from "../src/pipeline.js";
import { loadConfig } from "../src/config.js";

function jobsDir() {
  return mkdtempSync(path.join(tmpdir(), "jobs-app-"));
}

// One job dir with a ref in job-meta.json (+ optional status). `milestone` is a
// call counter so callers can vary startedAt deterministically for ordering.
let jobSeed = 0;
function makeJob(root, { app, prId, startedAgoMin, stage = "complete", title }) {
  jobSeed += 1;
  const name = `job-${app.replace(/[/.]/g, "_")}-PR${prId}-${jobSeed}`;
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const [projectKey, repoSlug] = app.split("/");
  const meta = { ref: { projectKey, repoSlug, prId, platform: "bitbucket" }, startedAt: new Date(Date.now() - startedAgoMin * 60 * 1000).toISOString() };
  if (title) meta.title = title;
  writeFileSync(path.join(dir, "job-meta.json"), JSON.stringify(meta));
  writeFileSync(path.join(dir, "status.json"), JSON.stringify({ stage, startedAt: meta.startedAt }));
  return name;
}

test("listJobsPage: app filter is applied before pagination (per-app total + pages)", () => {
  const root = jobsDir();
  try {
    // 12 ACME + 7 BBM jobs (newest-ish); filter ACME → total 12.
    for (let i = 1; i <= 12; i++) makeJob(root, { app: "ACME/widgets", prId: i, startedAgoMin: i });
    for (let i = 1; i <= 7; i++) makeJob(root, { app: "BBM/core", prId: i, startedAgoMin: 20 + i });

    const all = listJobsPage({ dirs: { jobs: root } }, { limit: 100, offset: 0 });
    assert.equal(all.total, 19, "no filter → every job");
    assert.equal(all.app, "");

    const acme = listJobsPage({ dirs: { jobs: root } }, { limit: 5, offset: 0, app: "ACME/widgets" });
    assert.equal(acme.total, 12, "filtered total counts all ACME jobs, not just the page");
    assert.equal(acme.jobs.length, 5, "page respects the limit on the filtered set");
    assert.equal(acme.app, "ACME/widgets");
    assert.ok(acme.jobs.every((j) => j.ref?.projectKey === "ACME" && j.ref?.repoSlug === "widgets"));

    const acmePage2 = listJobsPage({ dirs: { jobs: root } }, { limit: 5, offset: 5, app: "ACME/widgets" });
    assert.equal(acmePage2.jobs.length, 5);
    const acmeLast = listJobsPage({ dirs: { jobs: root } }, { limit: 5, offset: 10, app: "ACME/widgets" });
    assert.equal(acmeLast.jobs.length, 2, "last partial page of the filtered set");

    // A filter matching nothing is an empty total, not an error.
    const none = listJobsPage({ dirs: { jobs: root } }, { limit: 5, app: "NOBODY/here" });
    assert.equal(none.total, 0);
    assert.deepEqual(none.jobs, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listJobsPage: missing jobs dir → empty, never an error", () => {
  const root = path.join(jobsDir(), "does-not-exist");
  const out = listJobsPage({ dirs: { jobs: root } }, { limit: 5, app: "ACME/x" });
  assert.deepEqual(out, { jobs: [], total: 0, limit: 5, offset: 0, app: "ACME/x" });
});

test("listJobApps: per-app counts, sorted by activity then name, unknown-ref jobs excluded", () => {
  const root = jobsDir();
  try {
    for (let i = 1; i <= 4; i++) makeJob(root, { app: "ACME/widgets", prId: i, startedAgoMin: 1 });
    for (let i = 1; i <= 2; i++) makeJob(root, { app: "ACME/other", prId: i, startedAgoMin: 2 });
    for (let i = 1; i <= 6; i++) makeJob(root, { app: "BBM/core", prId: i, startedAgoMin: 3 });
    // A job directory with no readable ref is ignored (old CLI jobs).
    const noRef = path.join(root, "job-noref");
    mkdirSync(noRef, { recursive: true });
    writeFileSync(path.join(noRef, "status.json"), JSON.stringify({ stage: "complete" }));

    const { apps } = listJobApps({ dirs: { jobs: root } });
    assert.deepEqual(
      apps.map((a) => [a.app, a.count]),
      [
        ["BBM/core", 6],
        ["ACME/widgets", 4],
        ["ACME/other", 2],
      ],
      "count desc, then name; unknown-ref job not counted",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("server GET /api/jobs?app and /api/jobs/apps (createServer harness)", async () => {
  const root = jobsDir();
  for (let i = 1; i <= 3; i++) makeJob(root, { app: "ACME/widgets", prId: i, startedAgoMin: 1 });
  for (let i = 1; i <= 2; i++) makeJob(root, { app: "BBM/core", prId: i, startedAgoMin: 2 });

  const { createServer } = await import("../src/server.js");
  let server = null;
  const prev = {};
  const envKeys = ["BITBUCKET_BASE_URL", "BITBUCKET_API_TOKEN", "JOBS_DIR", "PUBLISH_TO_BITBUCKET"];
  for (const k of envKeys) prev[k] = process.env[k];
  try {
    process.env.BITBUCKET_BASE_URL = "https://bb.example.com";
    process.env.BITBUCKET_API_TOKEN = "tok";
    process.env.JOBS_DIR = root;
    process.env.PUBLISH_TO_BITBUCKET = "0";
    const config = loadConfig({ envFile: path.join(jobsDir(), ".env") });
    const created = createServer({ config, port: 0 });
    server = created.server;
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // filtered page + total
    const acme = await (await fetch(`${base}/api/jobs?limit=2&offset=0&app=${encodeURIComponent("ACME/widgets")}`)).json();
    assert.equal(acme.total, 3, "filtered total before pagination");
    assert.equal(acme.jobs.length, 2);
    assert.equal(acme.app, "ACME/widgets");
    assert.ok(acme.jobs.every((j) => j.ref?.projectKey === "ACME"));

    // unfiltered keeps everything
    const all = await (await fetch(`${base}/api/jobs?limit=100&offset=0`)).json();
    assert.equal(all.total, 5);

    // app → count map
    const apps = await (await fetch(`${base}/api/jobs/apps`)).json();
    assert.deepEqual(
      apps.apps.map((a) => [a.app, a.count]),
      [
        ["ACME/widgets", 3],
        ["BBM/core", 2],
      ],
    );
  } finally {
    if (server) await new Promise((r) => server.close(r));
    for (const k of envKeys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

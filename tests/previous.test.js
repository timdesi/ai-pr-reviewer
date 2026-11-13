import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findPreviousReview, alreadyReviewedAt } from "../src/previous.js";

function makeJob(jobsDir, name, sha) {
  const dir = path.join(jobsDir, name);
  mkdirSync(dir);
  const file = path.join(dir, "consensus.json");
  writeFileSync(file, JSON.stringify({ reviewed_sha: sha, findings: [{ title: "t", severity: "LOW", file: "a.js" }] }));
  return file;
}

test("alreadyReviewedAt returns true only for an exact head match on a real prior review", () => {
  const prev = { sha: "abc123" };
  assert.equal(alreadyReviewedAt(prev, "abc123"), true);
  assert.equal(alreadyReviewedAt(prev, "def456"), false); // new commits → new review
  assert.equal(alreadyReviewedAt(prev, null), false);
  assert.equal(alreadyReviewedAt(prev, ""), false);
  assert.equal(alreadyReviewedAt(null, "abc123"), false); // no prior review → allow
  assert.equal(alreadyReviewedAt({ sha: null }, "abc123"), false);
  assert.equal(alreadyReviewedAt({ sha: "abc1232" }, "abc123"), false); // prefix ≠ exact match
});

test("findPreviousReview finds the most recent completed review of the PR prefix", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prev-"));
  const now = Date.now();
  const older = makeJob(dir, "PROJ-r-PR1-a1111111", "a1111111");
  const newer = makeJob(dir, "PROJ-r-PR1-b2222222", "b2222222");
  utimesSync(older, new Date(now - 60_000), new Date(now - 60_000));
  utimesSync(newer, new Date(now - 5_000), new Date(now - 5_000));

  const prev = findPreviousReview({ jobsDir: dir, jobPrefix: "PROJ-r-PR1-", currentJob: null });
  assert.ok(prev);
  assert.equal(prev.sha, "b2222222");
  assert.equal(prev.findings.length, 1);
});

test("findPreviousReview ignores other PRs, the current job, and missing consensus", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prev-"));
  makeJob(dir, "PROJ-other-PR9-c3333333", "c3333333");
  // a job without consensus.json (review never completed) must not count
  const incomplete = path.join(dir, "PROJ-r-PR1-d4444444");
  mkdirSync(incomplete);

  assert.equal(findPreviousReview({ jobsDir: dir, jobPrefix: "PROJ-r-PR1-", currentJob: null }), null);
  // current job exclusion (mirror of the ./pipeline.js consensus usage)
  makeJob(dir, "PROJ-r-PR1-e5555555", "e5555555");
  const withAll = findPreviousReview({ jobsDir: dir, jobPrefix: "PROJ-r-PR1-", currentJob: "PROJ-r-PR1-e5555555" });
  assert.equal(withAll, null, "the only completed review is excluded as the current job");
  // garbage jobsDir
  assert.equal(findPreviousReview({ jobsDir: path.join(dir, "missing"), jobPrefix: "x-", currentJob: null }), null);
});

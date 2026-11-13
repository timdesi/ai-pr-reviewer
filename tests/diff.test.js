import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { budgetDiff, numberDiff, splitDiffFiles, filePriority } from "../src/diff.js";
import { groundFindings } from "../src/grounding.js";
import { findPreviousReview, renderPreviousReview } from "../src/previous.js";
import { repairMessage } from "../src/pipeline.js";
import { renderComment } from "../src/report.js";
import { validateConsensusReport } from "../src/validate.js";

function fileDiff(p, body) {
  return [`diff --git src://${p} dst://${p}`, `--- src://${p}`, `+++ dst://${p}`, "@@ -1,1 +1,2 @@", body].join("\n");
}

test("splitDiffFiles reads Bitbucket and git style paths", () => {
  const d = fileDiff("app/A.java", "+x") + "\n" + "diff --git a/b.js b/b.js\n+++ b/b.js\n@@ -1 +1 @@\n+y";
  assert.deepEqual(splitDiffFiles(d).map((f) => f.path), ["app/A.java", "b.js"]);
});

test("filePriority ranks source < tests < lockfiles/generated", () => {
  assert.equal(filePriority("app/src/main/Foo.java"), 0);
  assert.equal(filePriority("app/src/test/FooTest.java"), 1);
  assert.equal(filePriority("ui/foo.spec.ts"), 1);
  assert.equal(filePriority("package-lock.json"), 2);
});

test("budgetDiff keeps whole source files, drops lockfiles and tests first, keeps order", () => {
  const big = "+" + "x".repeat(5000);
  const d = [
    fileDiff("package-lock.json", big),
    fileDiff("src/A.java", "+a"),
    fileDiff("src/test/ATest.java", big),
    fileDiff("src/B.java", "+b"),
  ].join("\n");
  const out = budgetDiff(d, 1000);
  assert.equal(out.truncated, true);
  assert.deepEqual(out.omitted, ["package-lock.json", "src/test/ATest.java"]);
  assert.ok(out.diff.indexOf("src/A.java") < out.diff.indexOf("src/B.java"));
  assert.doesNotMatch(out.diff, /package-lock/);
});

test("budgetDiff cuts one oversized file at a line boundary when room is left", () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join("\n");
  const out = budgetDiff(fileDiff("src/Huge.java", lines), 8000);
  assert.deepEqual(out.partial, ["src/Huge.java"]);
  assert.ok(Buffer.byteLength(out.diff) <= 8000);
  assert.match(out.diff, /\+line \d+$/);
});

test("budgetDiff is a no-op under budget", () => {
  const d = fileDiff("a.js", "+a");
  assert.deepEqual(budgetDiff(d, 1e6), { diff: d, truncated: false, omitted: [], partial: [] });
});

test("numberDiff numbers new-file lines and leaves removed lines blank", () => {
  const d = "diff --git a/x b/x\n@@ -10,3 +20,3 @@\n ctx\n-old\n+new\n ctx2";
  const lines = numberDiff(d).split("\n");
  assert.equal(lines[2], "   20│ ctx");
  assert.equal(lines[3], "     │-old");
  assert.equal(lines[4], "   21│+new");
  assert.equal(lines[5], "   22│ ctx2");
});

test("grounding ignores a copied line-number prefix in evidence", () => {
  const diff = "@@ -1 +1 @@\n+  return computeValue(input);";
  const report = { findings: [{ file: "a", confidence: 0.9, evidence: "   12│+  return computeValue(input);" }] };
  groundFindings(report, { diff, changes: [] });
  assert.equal(report.findings[0].grounding.evidence, "found");
});

test("findPreviousReview picks the newest other job of the same PR", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "prev-"));
  const write = (name, report, ageSec) => {
    mkdirSync(path.join(dir, name));
    const f = path.join(dir, name, "consensus.json");
    writeFileSync(f, JSON.stringify(report));
    const t = Date.now() / 1000 - ageSec;
    utimesSync(f, t, t);
  };
  write("P-r-PR5-aaaa1111", { reviewed_sha: "aaaa1111", findings: [{ title: "old", severity: "LOW", file: "x" }] }, 100);
  write("P-r-PR5-bbbb2222", { reviewed_sha: "bbbb2222", findings: [{ title: "newer", severity: "HIGH", file: "y", line_start: 3 }] }, 10);
  write("P-r-PR55-cccc3333", { findings: [{ title: "other PR" }] }, 1);
  const prev = findPreviousReview({ jobsDir: dir, jobPrefix: "P-r-PR5-", currentJob: "P-r-PR5-dddd4444" });
  assert.equal(prev.job, "P-r-PR5-bbbb2222");
  assert.match(renderPreviousReview(prev), /\[HIGH\] newer — `y` L3/);
  assert.equal(findPreviousReview({ jobsDir: dir, jobPrefix: "P-r-PR9-", currentJob: "x" }), null);
});

test("repairMessage lists the validation errors", () => {
  const msg = repairMessage(["findings[0]: finding.evidence should be a non-empty string"]);
  assert.match(msg, /- findings\[0\]: finding\.evidence/);
  assert.match(msg, /ONLY the complete, corrected JSON object/);
});

test("resolved_previous is validated and rendered for the author", () => {
  const report = { reviewed_sha: "abc", summary: "s", findings: [], resolved_previous: ["Fix the race", " ", 3] };
  assert.equal(validateConsensusReport(report).ok, true);
  assert.deepEqual(report.resolved_previous, ["Fix the race"]);
  assert.match(renderComment({ report }), /### Resolved since last review \(1\)\n\n- ✅ Fix the race/);
  assert.equal(validateConsensusReport({ ...report, resolved_previous: "x" }).ok, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { groundFindings, evidenceFragments } from "../src/grounding.js";
import { renderComment, renderFinalReport, partitionFindings } from "../src/report.js";
import { APP_VERSION } from "../src/version.js";

const diff = [
  "diff --git src://app/Foo.java dst://app/Foo.java",
  "--- src://app/Foo.java",
  "+++ dst://app/Foo.java",
  "@@ -1,3 +1,4 @@",
  " class Foo {",
  "-  int x = 1;",
  "+  int x = computeValue(input);",
  "+  return this.save(lot);",
  " }",
].join("\n");
const changes = [{ path: { toString: "app/Foo.java" } }];

function finding(over = {}) {
  return {
    title: "t",
    severity: "MEDIUM",
    verification_status: "verified",
    confidence: 0.8,
    file: "app/Foo.java",
    evidence: "+  int x = computeValue(input);",
    ...over,
  };
}

test("evidence found in the diff keeps confidence", () => {
  const report = { findings: [finding()] };
  const stats = groundFindings(report, { diff, changes });
  assert.equal(stats.notFound, 0);
  assert.equal(report.findings[0].confidence, 0.8);
  assert.deepEqual(report.findings[0].grounding, { evidence: "found", file_in_diff: true });
});

test("elided multi-line evidence matches fragment-wise", () => {
  const report = { findings: [finding({ evidence: "int x = computeValue(input); ... this.save(lot);" })] };
  groundFindings(report, { diff, changes });
  assert.equal(report.findings[0].grounding.evidence, "found");
});

test("fabricated evidence caps confidence and downgrades verified", () => {
  const report = { findings: [finding({ evidence: "repository.deleteAllInBatch(items);" })] };
  const stats = groundFindings(report, { diff, changes });
  assert.equal(stats.notFound, 1);
  assert.equal(report.findings[0].confidence, 0.3);
  assert.equal(report.findings[0].verification_status, "partially_verified");
});

test("finding on a file outside the PR is capped", () => {
  const report = { findings: [finding({ file: "app/Other.java" })] };
  const stats = groundFindings(report, { diff, changes });
  assert.equal(stats.offDiff, 1);
  assert.equal(report.findings[0].confidence, 0.4);
});

test("short evidence is left unchecked", () => {
  assert.deepEqual(evidenceFragments("x = 1"), []);
  const report = { findings: [finding({ evidence: "x = 1" })] };
  groundFindings(report, { diff, changes });
  assert.equal(report.findings[0].grounding.evidence, "unchecked");
  assert.equal(report.findings[0].confidence, 0.8);
});

const report = {
  schema_version: "1.0",
  reviewed_sha: "ff34c305deadbeef",
  summary: "s",
  findings: [
    finding({ title: "Real medium" }),
    finding({ title: "Shaky high", severity: "HIGH", confidence: 0.3 }),
    finding({ title: "Small low", severity: "LOW" }),
  ],
  dropped: [{ title: "Race in cache", source_reviewers: ["b"], reason: "not concurrent" }],
};
const policy = { minSeverity: "MEDIUM", minConfidence: 0.5 };

test("partitionFindings gates on severity and confidence", () => {
  const { main, minor } = partitionFindings(report.findings, policy);
  assert.deepEqual(main.map((f) => f.title), ["Real medium"]);
  assert.deepEqual(minor.map((f) => f.title), ["Shaky high", "Small low"]);
});

test("gated comment: verdict from main findings, minor list, version footer", () => {
  const md = renderComment({ report, policy });
  assert.match(md, /🟡 \*\*Worth addressing before merge\*\*/);
  assert.doesNotMatch(md, /Do not merge/);
  assert.match(md, /### Findings \(1\)/);
  assert.match(md, /### Minor \(2\)/);
  assert.match(md, /2 minor/);
  assert.doesNotMatch(md, /Dropped by consensus/);
  assert.ok(md.includes(`AI PR Reviewer v${APP_VERSION}`));
});

test("final report shows all findings, grounding flags and dropped list", () => {
  const r = structuredClone(report);
  r.findings[0].grounding = { evidence: "not_found", file_in_diff: true };
  const md = renderFinalReport({ report: r });
  assert.match(md, /### Findings \(3\)/);
  assert.match(md, /evidence not found/);
  assert.match(md, /### Dropped by consensus \(1\)/);
  assert.match(md, /Race in cache \[b\] — not concurrent/);
  assert.ok(md.includes(`AI PR Reviewer v${APP_VERSION}`));
});

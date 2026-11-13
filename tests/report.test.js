import { test } from "node:test";
import assert from "node:assert/strict";

import { renderComment, renderFinalReport } from "../src/report.js";
import { validateConsensusReport, validateReviewerReport, repairReportKeys } from "../src/validate.js";

const baseUrl = "https://bitbucket.example.com";
const ref = { projectKey: "ACME", repoSlug: "acme-app", prId: 5569 };

const finding = {
  title: "Honor the inherited distinct flag",
  severity: "LOW",
  verification_status: "verified",
  confidence: 0.55,
  file: "app/src/main/java/com/example/acme/service/query/DeviationCodeQueryService.java",
  line_start: 46,
  line_end: 73,
  description: "The criteria is copied but never read when building the specification.",
  impact: "distinct=true is silently ignored — clients may get duplicate rows.",
  evidence:
    "- builder never reads criteria.getDistinct()\n" +
    "+ if (Boolean.TRUE.equals(criteria.getDistinct())) { ... }",
  suggested_fix: "1. Add the branch after the field filters\n2. Cover it with a test",
};

const report = {
  schema_version: "1.0",
  reviewed_sha: "ff34c305deadbeef1234abcd",
  summary: "Solid change set with good tests; one LOW gap.",
  strengths: [
    "Integration tests cover filtering, JOIN semantics, and pagination.",
    "New services follow the existing JHipster conventions.",
  ],
  findings: [finding],
  reviewed_files: ["app/src/main/java/com/example/acme/service/query/DeviationCodeQueryService.java"],
  notes: ["Reviewer B's collision concern was dropped after verifying the source."],
};

test("comment opens with plain header, linked commit, verdict and severity line", () => {
  const md = renderComment({ report, ref, baseUrl });
  assert.match(md, /^## AI Review - \[ff34c305\]\(https:\/\/bitbucket.example.com\/projects\/ACME\/repos\/acme-app\/commits\/ff34c305deadbeef1234abcd\)\n/);
  assert.match(md, /✅ \*\*Nothing blocks merge\*\*/);
  assert.match(md, /⚪ 1 LOW/);
  assert.doesNotMatch(md, /0 MEDIUM/);
});

test("no funcy icons in the header or the What's good heading", () => {
  const md = renderComment({ report, ref, baseUrl });
  assert.doesNotMatch(md, /## .*🤖/);
  assert.match(md, /### What's good/);
  assert.doesNotMatch(md, /### 🎉 What's good/);
});

test("What's good comes after Summary", () => {
  const md = renderComment({ report, ref, baseUrl });
  assert.ok(md.indexOf("### Summary") !== -1);
  assert.ok(md.indexOf("### What's good") > md.indexOf("### Summary"));
});

test("finding uses blockquote impact, numbered fix and diff evidence", () => {
  const md = renderComment({ report, ref, baseUrl });
  assert.match(md, /> \*\*Impact:\*\*/);
  assert.match(md, /\*\*Suggested fix:\*\*\n\n1\. Add the branch after the field filters/);
  assert.ok(md.includes("```diff\n- builder never reads criteria.getDistinct()"));
});

test("comment drops the internal notes and reviewer meta-talk", () => {
  const md = renderComment({ report, ref, baseUrl });
  assert.doesNotMatch(md, /### Notes/);
  assert.doesNotMatch(md, /Reviewer B/);
});

test("final report keeps the notes", () => {
  const md = renderFinalReport({ report, ref, baseUrl });
  assert.match(md, /### Notes/);
  assert.match(md, /Reviewer B/);
});

test("linked Jira ticket appendix appears in the comment and the final report", () => {
  const jiraTickets = [
    {
      key: "ACME-42893",
      type: "Bug",
      status: "In Review",
      priority: "High",
      summary: "CC autobacklog",
      acceptanceCriteria: "AC1: the lot is kept in backlog\n\nAC2: a PCB lot is created",
    },
    { key: "ACV2-642", error: "HTTP 404" },
  ];
  for (const render of [renderComment, renderFinalReport]) {
    const md = render({ report, ref, baseUrl, jiraTickets });
    assert.match(md, /### Jira coverage/);
    assert.match(md, /\*\*ACME-42893 — CC autobacklog\*\*/);
    assert.match(md, /\| AC1: the lot is kept in backlog \| — \| — \|/);
    assert.doesNotMatch(md, /ACV2-642/); // error-only ticket is not shown
  }
});

test("consensus acceptance_criteria verdicts render in the comment and report AC table", () => {
  const jiraTickets = [
    {
      key: "ACME-42896",
      type: "Story",
      status: "In Progress",
      priority: "Critical",
      summary: "Revision Level config",
      acceptanceCriteria: "*AC0*\n * *Then* the toggles update per mock up\n\n*AC1*\n * *Then* a new toggle is available",
    },
  ];
  const withVerdicts = {
    ...report,
    acceptance_criteria: [
      { ticket: "ACME-42896", id: "AC0", status: "not_verifiable", reason: "UI mock-up is in another repo" },
      { ticket: "ACME-42896", id: "AC1", status: "partial", reason: "property added but no consumer yet" },
    ],
  };
  for (const render of [renderComment, renderFinalReport]) {
    const md = render({ report: withVerdicts, ref, baseUrl, jiraTickets });
    assert.match(md, /\| AC0 \| Not verified \| UI mock-up is in another repo \|/);
    assert.match(md, /\| AC1 \| Partial \| property added but no consumer yet \|/);
    // The AC appendix itself stays icon-free (summary/findings may use emoji).
    assert.doesNotMatch(md.slice(md.indexOf("### Jira coverage")), /✅|⚠️|❌|🔍/);
  }
});

test("no Jira coverage appendix when there are no usable tickets", () => {
  const md = renderComment({ report, ref, baseUrl, jiraTickets: [] });
  assert.doesNotMatch(md, /Jira coverage/);
  const md2 = renderComment({ report, ref, baseUrl, jiraTickets: [{ key: "X", error: "boom" }] });
  assert.doesNotMatch(md2, /Jira coverage/);
  const md3 = renderComment({ report, ref, baseUrl });
  assert.doesNotMatch(md3, /Jira coverage/);
});

test("no What's good section when strengths are absent", () => {
  const md = renderComment({ report: { ...report, strengths: [] }, ref, baseUrl });
  assert.doesNotMatch(md, /What's good/);
});

test("verdict line reacts to severity and to zero findings", () => {
  const medium = renderComment({
    report: { ...report, findings: [{ ...finding, severity: "MEDIUM" }] },
    ref,
    baseUrl,
  });
  assert.match(medium, /🟡 \*\*Worth addressing before merge\*\*/);

  const critical = renderComment({
    report: { ...report, findings: [{ ...finding, severity: "CRITICAL" }] },
    ref,
    baseUrl,
  });
  assert.match(critical, /🔴 \*\*Do not merge\*\*/);

  const clean = renderComment({ report: { ...report, findings: [] }, ref, baseUrl });
  assert.match(clean, /✅ \*\*No issues found — clean change set\*\*/);
  assert.doesNotMatch(clean, /⚪ 1 LOW/);
});

test("single-line suggested fix stays inline", () => {
  const md = renderComment({
    report: { ...report, findings: [{ ...finding, suggested_fix: "Add the branch." }] },
    ref,
    baseUrl,
  });
  assert.match(md, /\*\*Suggested fix:\*\* Add the branch\./);
});

test("prose evidence renders as a plain fence, not a diff", () => {
  const md = renderComment({
    report: { ...report, findings: [{ ...finding, evidence: "The builder has no distinct branch." }] },
    ref,
    baseUrl,
  });
  assert.ok(md.includes("```\nThe builder has no distinct branch."));
  assert.doesNotMatch(md, /```diff/);
});

test("commit sits in the heading as plain text when no base URL is available", () => {
  const md = renderComment({ report, ref });
  assert.match(md, /^## AI Review - ff34c305\n/);
  assert.doesNotMatch(md, /\[ff34c305\]\(/);
});

test("validateConsensusReport accepts a strengths array and rejects bad shapes", () => {
  assert.equal(validateConsensusReport(report).ok, true);
  assert.equal(validateConsensusReport({ ...report, strengths: "nope" }).ok, false);
  assert.ok(
    validateConsensusReport({ ...report, strengths: [""] }).errors.some((e) =>
      e.includes("strengths[0]"),
    ),
  );
});

test("repairReportKeys normalizes a case-typo'd strengths key", () => {
  const obj = { ...report };
  obj.Strengths = obj.strengths;
  delete obj.strengths;
  assert.equal(repairReportKeys(obj), 1);
  assert.ok(Array.isArray(obj.strengths));
});

test("validateConsensusReport accepts/sanitizes acceptance_criteria and repairs the key", () => {
  const good = validateConsensusReport({
    ...report,
    acceptance_criteria: [
      { ticket: "ACME-42896", id: "AC1", status: "partial", reason: "r", short: "toggle defaults OFF" },
    ],
  });
  assert.equal(good.ok, true);
  assert.equal(good.report.acceptance_criteria.length, 1);
  assert.equal(good.report.acceptance_criteria[0].short, "toggle defaults OFF");

  // Unknown status is coerced to not_verifiable; missing id is an error; a long
  // `short` is truncated.
  const bad = validateConsensusReport({
    ...report,
    acceptance_criteria: [
      { ticket: "ACME-1", id: "AC1", status: "UNMET", reason: "r", short: "x".repeat(300) },
      { ticket: "ACME-1", id: "AC2", status: "nonsense" },
      { ticket: "ACME-1", status: "met" },
    ],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /acceptance_criteria\[2\]\.id missing/);
  assert.deepEqual(bad.report.acceptance_criteria, [
    { ticket: "ACME-1", id: "AC1", status: "unmet", reason: "r", short: "x".repeat(160) },
    { ticket: "ACME-1", id: "AC2", status: "not_verifiable", reason: "", short: "" },
  ]);

  // Non-array is a hard error.
  const nonArray = validateConsensusReport({ ...report, acceptance_criteria: "nope" });
  assert.equal(nonArray.ok, false);
  assert.match(nonArray.errors.join(" "), /acceptance_criteria should be an array/);

  // repairReportKeys fixes a case-typo'd top-level key.
  const obj = { ...report, Acceptance_Criteria: [{ id: "AC1", status: "met" }] };
  assert.equal(repairReportKeys(obj), 1);
  assert.equal(obj.acceptance_criteria.length, 1);
});

test("validateReviewerReport accepts verification_status and source_reviewers, rejects bad values", () => {
  const withMeta = {
    ...report,
    findings: [
      {
        ...finding,
        verification_status: "verified",
        source_reviewers: ["a", "b"],
      },
    ],
  };
  assert.equal(validateReviewerReport(withMeta).ok, true);

  const badStatus = validateReviewerReport({
    ...report,
    findings: [{ ...finding, verification_status: "maybe?" }],
  });
  assert.equal(badStatus.ok, false);
  assert.match(badStatus.errors.join(" "), /verification_status missing or invalid/);

  const badScr = validateReviewerReport({
    ...report,
    findings: [{ ...finding, source_reviewers: "a,b" }],
  });
  assert.equal(badScr.ok, false);
  assert.match(badScr.errors.join(" "), /source_reviewers should be an array/);
});

test("finding evidence is required to be a non-empty string", () => {
  const missing = validateConsensusReport({
    ...report,
    findings: [{ ...finding, evidence: undefined }],
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(" "), /evidence should be a non-empty string/);

  const blank = validateConsensusReport({ ...report, findings: [{ ...finding, evidence: "   " }] });
  assert.equal(blank.ok, false);
  assert.match(blank.errors.join(" "), /evidence should be a non-empty string/);
});

test("repairReportKeys normalizes near-miss verification_status and source_reviewers keys", () => {
  const obj = { ...report, findings: [{ ...finding, VerificationStatus: "verified", sourceReviewers: ["c"] }] };
  delete obj.findings[0].verification_status;
  delete obj.findings[0].source_reviewers;
  assert.equal(repairReportKeys(obj), 2);
  assert.equal(obj.findings[0].verification_status, "verified");
  assert.deepEqual(obj.findings[0].source_reviewers, ["c"]);
});

test("verification_status is required on every finding", () => {
  const missing = validateReviewerReport({
    ...report,
    findings: [{ title: "t", severity: "LOW", file: "a.java", evidence: "x" }],
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(" "), /verification_status missing or invalid/);
});

test("line_start / line_end must be integers or null", () => {
  const ok = validateReviewerReport({
    ...report,
    findings: [{ ...finding, line_start: 12, line_end: null }],
  });
  assert.equal(ok.ok, true);

  const bad = validateReviewerReport({ ...report, findings: [{ ...finding, line_start: "12" }] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /line_start should be an integer or null/);
});

// --- Reviewer D: language & content findings -------------------------------

const langFinding = {
  ...finding,
  title: "German value shifts the source meaning",
  category: "translation",
  file: "src/main/webapp/i18n/de.json",
  severity: "MEDIUM",
  evidence: '"warning_not_enough": "Warnung, nicht genug"',
};

const i18nFinding = {
  ...finding,
  title: "Placeholder {{ count }} missing in the French value",
  category: "i18n",
  file: "src/main/webapp/i18n/fr.json",
  severity: "HIGH",
  evidence: '"items_count": "Vous avez des articles"',
};

test("language findings render in their own section and stay visible at LOW/MEDIUM gate", () => {
  const md = renderComment({
    report: { ...report, findings: [langFinding] },
    ref,
    baseUrl,
    policy: { minSeverity: "MEDIUM", minConfidence: 0.5 },
  });
  assert.match(md, /### Language & content \(1\)/);
  assert.match(md, /Translation & content feedback/);
  // Reviewer-slot jargon (Reviewer A/B/C/D) must never leak into the public comment.
  assert.doesNotMatch(md, /Reviewer\s+[a-d]/i);
  assert.match(md, /🈴 1 language/);
  // MEDIUM language findings must not push the merge verdict ("advisory").
  assert.doesNotMatch(md, /🟡 \*\*Worth addressing before merge\*\*/);
  assert.match(md, /✅ \*\*Nothing blocks merge\*\*/);
});

test("HIGH language finding drives the verdict and appears in the header line", () => {
  const md = renderComment({ report: { ...report, findings: [i18nFinding, langFinding] }, ref, baseUrl });
  assert.match(md, /🟠 \*\*Do not merge\*\* — high-severity issues found/);
  assert.match(md, /🟠 1 HIGH/);
  assert.match(md, /### Language & content \(2\)/);
  assert.match(md, /Placeholder \{\{ count \}\} missing in the French value/);
});

test("code findings and language findings are counted separately in the header", () => {
  const md = renderComment({
    report: {
      ...report,
      findings: [
        { ...finding, severity: "HIGH", category: "correctness" },
        { ...langFinding },
      ],
    },
    ref,
    baseUrl,
  });
  // 1 code HIGH (drives verdict) + the language count is separate.
  assert.match(md, /🟠 1 HIGH/);
  assert.match(md, /🈴 1 language/);
  assert.doesNotMatch(md, /🈴 1 language · 1 language/);
});

test("language section appears in the internal final report too", () => {
  const md = renderFinalReport({ report: { ...report, findings: [langFinding] }, ref, baseUrl });
  assert.match(md, /### Language & content \(1\)/);
});

test("validate accepts translation and i18n categories", () => {
  const r = validateReviewerReport({
    ...report,
    findings: [{ ...finding, category: "translation" }, { ...finding, category: "i18n" }, { ...finding, category: "style" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.report.findings[0].category, "translation");
  assert.equal(r.report.findings[1].category, "i18n");
  assert.equal(r.report.findings[2].category, "other");
});

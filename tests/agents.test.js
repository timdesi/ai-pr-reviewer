import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { renderAgents, parseLens, renderReviewer } from "../scripts/build-agents.mjs";
import { validateReviewerReport } from "../src/validate.js";
import { renderComment } from "../src/report.js";
import { buildConsensusContext } from "../src/context.js";

test("generated reviewer agents match the committed files", () => {
  for (const [file, content] of Object.entries(renderAgents())) {
    assert.equal(readFileSync(file, "utf8"), content, `${file} is stale — run npm run build:agents`);
    assert.doesNotMatch(content, /\{\{\w+\}\}/);
  }
});

test("agent prompts stay language-neutral (stack rules live in contexts/)", () => {
  const files = [...Object.keys(renderAgents()), new URL("../.opencode/agents/pr-consensus.md", import.meta.url)];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /Feign|DateTimeFormatter|JLS|ManyToOne|open-in-view/, String(f));
  }
});

test("renderReviewer fails loudly on a missing lens section", () => {
  const lens = parseLens("<!-- @letter -->\nA\n<!-- @focus -->\n- x\n");
  assert.deepEqual(lens, { letter: "A", focus: "- x" });
  assert.throws(() => renderReviewer("{{letter}} {{severity}}", lens), /@severity/);
});

const finding = {
  title: "t",
  severity: "LOW",
  verification_status: "verified",
  confidence: 0.6,
  file: "a.js",
  evidence: "const a = 1;",
};

test("category is normalized, unknown values become other, missing stays absent", () => {
  const report = {
    summary: "s",
    findings: [{ ...finding, category: " Security " }, { ...finding, category: "style" }, { ...finding }],
  };
  assert.equal(validateReviewerReport(report).ok, true);
  assert.equal(report.findings[0].category, "security");
  assert.equal(report.findings[1].category, "other");
  assert.equal("category" in report.findings[2], false);
});

test("comment footer flags a partial review without leaking reviewer slots", () => {
  const report = { reviewed_sha: "abc", summary: "s", findings: [] };
  assert.match(renderComment({ report, degraded: ["Reviewer C", "Reviewer D"] }), /partial review \(2 review passes unavailable\)/);
  assert.doesNotMatch(renderComment({ report, degraded: ["Reviewer C"] }), /Reviewer\s+[a-d]/i);
  assert.doesNotMatch(renderComment({ report }), /partial review/);
});

test("consensus context does not duplicate the Jira heading or leak model names", () => {
  const out = buildConsensusContext({
    ref: { projectKey: "P", repoSlug: "r", prId: 1 },
    pullRequest: { fromRef: {}, toRef: {} },
    changes: [],
    diff: "",
    reports: [{ agent: "a", model: "secret-model", text: "{}" }],
    maxDiffBytes: 1e6,
    jiraBlock: "## Linked Jira tickets\n\n### X-1",
  });
  assert.equal(out.match(/## Linked Jira tickets/g).length, 1);
  assert.doesNotMatch(out, /secret-model/);
});

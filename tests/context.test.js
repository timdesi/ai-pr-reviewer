import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildReviewerContext, buildConsensusContext, loadProjectContext, matchStackContexts, cleanContextText } from "../src/context.js";

const ref = { projectKey: "ACME", repoSlug: "acme-app", prId: 5569 };
const pullRequest = {
  title: "Criteria search endpoints",
  author: { user: { displayName: "A. Dev" } },
  description: "adds search endpoints",
  state: "OPEN",
  fromRef: { displayId: "feature/x", latestCommit: "abc123" },
  toRef: { displayId: "main", latestCommit: "def456" },
};
const changes = [{ type: "MODIFIED", destination: { toString: "app/x.java" } }];
const diff = "@@ -1 +1 @@\n-old\n+new\n";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "ctx-test-"));
}

test("buildReviewerContext includes the project context section when provided", () => {
  const out = buildReviewerContext({
    ref,
    pullRequest,
    changes,
    diff,
    maxDiffBytes: 1e6,
    projectContext: "Java 21.\nsuper() must be first.",
  });
  assert.match(out, /## Project context/);
  assert.match(out, /super\(\) must be first\./);
});

test("buildReviewerContext omits the section when no project context", () => {
  const out = buildReviewerContext({ ref, pullRequest, changes, diff, maxDiffBytes: 1e6, projectContext: "" });
  assert.ok(!out.includes("## Project context"));
});

test("buildConsensusContext includes the project context section", () => {
  const out = buildConsensusContext({
    ref,
    pullRequest,
    changes,
    diff,
    reports: [{ agent: "a", model: "m", text: "[]" }],
    maxDiffBytes: 1e6,
    projectContext: "Java 21.",
  });
  assert.match(out, /## Project context/);
  assert.match(out, /Java 21\./);
});

test("buildConsensusContext includes the linked Jira tickets/AC block when provided", () => {
  const out = buildConsensusContext({
    ref,
    pullRequest,
    changes,
    diff,
    reports: [{ agent: "a", model: "m", text: "[]" }],
    maxDiffBytes: 1e6,
    projectContext: "",
    jiraBlock: "## Linked Jira tickets\n\n### ACME-42896\n- **Acceptance criteria:**\n  - AC1",
  });
  assert.match(out, /## Linked Jira tickets/);
  assert.match(out, /ACME-42896/);
  assert.match(out, /AC1/);
  // The section sits between the changed files and the reviewer reports.
  assert.ok(out.indexOf("## Linked Jira tickets") > out.indexOf("## Changed files"));
  assert.ok(out.indexOf("## Linked Jira tickets") < out.indexOf("## Independent reviewer reports"));
});

test("buildConsensusContext omits the Jira block when none was provided", () => {
  const out = buildConsensusContext({
    ref,
    pullRequest,
    changes,
    diff,
    reports: [{ agent: "a", model: "m", text: "[]" }],
    maxDiffBytes: 1e6,
  });
  assert.ok(!out.includes("## Linked Jira tickets"));
  assert.ok(!out.includes("linked"), "no stray mention of linked tickets");
});

test("loadProjectContext uses the curated <PROJECT>-<repo>.md file", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "ACME-acme-app.md"), "curated: java21");
  const out = await loadProjectContext({ dir, client: null, ref, sha: "abc" });
  assert.match(out, /ACME-acme-app\.md/);
  assert.match(out, /curated: java21/);
  rmSync(dir, { recursive: true, force: true });
});

test("loadProjectContext puts project-wide <PROJECT>.md before the repo file", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "ACME.md"), "project-wide rules");
  writeFileSync(path.join(dir, "ACME-acme-app.md"), "repo rules");
  const out = await loadProjectContext({ dir, client: null, ref, sha: "abc" });
  assert.ok(out.indexOf("project-wide rules") < out.indexOf("repo rules"));
  const only = await loadProjectContext({ dir, client: null, ref: { ...ref, repoSlug: "other" }, sha: "abc" });
  assert.match(only, /project-wide rules/);
  assert.doesNotMatch(only, /repo rules/);
  rmSync(dir, { recursive: true, force: true });
});

test("stack contexts attach only when a changed path matches", async () => {
  const dir = tempDir();
  mkdirSync(path.join(dir, "stacks"));
  writeFileSync(path.join(dir, "stacks", "java.md"), '---\nmatch: ["\\\\.java$", "(^|/)pom\\\\.xml$"]\n---\nJAVA RULES');
  writeFileSync(path.join(dir, "stacks", "angular.md"), '---\nmatch: ["\\\\.component\\\\.ts$"]\n---\nANGULAR RULES');
  writeFileSync(path.join(dir, "stacks", "broken.md"), "---\nmatch: [not json\n---\nBROKEN");
  writeFileSync(path.join(dir, "stacks", "nomatch.md"), "no front matter at all");
  writeFileSync(path.join(dir, "ACME.md"), "ORG RULES");
  writeFileSync(path.join(dir, "ACME-acme-app.md"), "REPO RULES");

  const java = await loadProjectContext({ dir, client: null, ref, sha: "a", changedPaths: ["app/src/Foo.java"] });
  assert.match(java, /JAVA RULES/);
  assert.doesNotMatch(java, /ANGULAR RULES|BROKEN|no front matter/);
  assert.doesNotMatch(java, /match:/);
  assert.ok(java.indexOf("ORG RULES") < java.indexOf("JAVA RULES"));
  assert.ok(java.indexOf("JAVA RULES") < java.indexOf("REPO RULES"));

  const ui = await loadProjectContext({ dir, client: null, ref, sha: "a", changedPaths: ["src/app/x.component.ts"] });
  assert.match(ui, /ANGULAR RULES/);
  assert.doesNotMatch(ui, /JAVA RULES/);

  assert.deepEqual(matchStackContexts(path.join(dir, "missing"), ["a.java"]), []);
  rmSync(dir, { recursive: true, force: true });
});

test("translation rule reaches Angular/i18n PRs only; comment-only ACME.md sends nothing", async () => {
  const dir = new URL("../contexts", import.meta.url).pathname;
  const load = (repoSlug, changedPaths) =>
    loadProjectContext({ dir, client: null, ref: { projectKey: "ACME", repoSlug, prId: 1 }, sha: "a", changedPaths });
  const i18nOnly = await load("any-ui-repo", ["src/main/webapp/i18n/de.json"]);
  assert.match(i18nOnly, /Translations \(i18n\)/);
  assert.match(i18nOnly, /Reviewers A\/B\/C\*\* do \*\*not\*\* report "untranslated"/);
  assert.match(i18nOnly, /Reviewer D\*\* \(language & translation;/);
  assert.doesNotMatch(i18nOnly, /<!--|curated ACME\.md/);
  assert.match(i18nOnly, /## Team conventions\n\n### Translations \(i18n\)/, "parent heading kept for a filled subsection");
  const backend = await load("any-backend", ["src/main/java/Foo.java"]);
  assert.doesNotMatch(backend, /Translations \(i18n\)|untranslated/);
});

test("cleanContextText drops only headings with no content of their own", () => {
  const raw = "# T\n\n## Empty\n<!-- todo -->\n\n## Parent\n### Child\n- rule\n\n## AlsoEmpty\n### EmptyChild\n<!-- x -->\n## Last\ntext";
  assert.equal(cleanContextText(raw), "# T\n\n## Parent\n### Child\n- rule\n\n## Last\ntext");
});

test("the shipped stacks match by file type and strip editor comments", () => {
  const dir = new URL("../contexts", import.meta.url).pathname;
  assert.deepEqual(matchStackContexts(dir, ["app/src/main/java/Foo.java"]).map((s) => s.name), ["java-spring"]);
  const ui = matchStackContexts(dir, ["src/main/webapp/app/x.component.ts", "package.json"]);
  assert.deepEqual(ui.map((s) => s.name), ["angular"]);
  assert.doesNotMatch(ui[0].text, /<!--|TODO\(team\)/);
  assert.match(ui[0].text, /## Team conventions\n\n### Translations/, "kept once a subsection is filled in");
  assert.match(ui[0].text, /## Real problems worth reporting\n/);
  assert.deepEqual(matchStackContexts(dir, ["README.md", "package.json"]), []);
});

test("loadProjectContext falls back to <repo>.md when the PROJECT-repo file is absent", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "acme-app.md"), "fallback context");
  const out = await loadProjectContext({ dir, client: null, ref, sha: "abc" });
  assert.match(out, /fallback context/);
  assert.match(out, /acme-app\.md/);
  rmSync(dir, { recursive: true, force: true });
});

test("loadProjectContext merges the repo's AGENTS.md after the curated file", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "ACME-acme-app.md"), "curated");
  const client = { getFileRaw: async () => "AGENTS text" };
  const out = await loadProjectContext({ dir, client, ref, sha: "abc123" });
  assert.match(out, /AGENTS\.md@abc123/);
  assert.match(out, /AGENTS text/);
  rmSync(dir, { recursive: true, force: true });
});

test("loadProjectContext ignores a missing AGENTS.md (client returns null)", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "ACME-acme-app.md"), "curated");
  const client = { getFileRaw: async () => null };
  const out = await loadProjectContext({ dir, client, ref, sha: "abc" });
  assert.match(out, /curated/);
  assert.ok(!out.includes("AGENTS"));
  rmSync(dir, { recursive: true, force: true });
});

test("loadProjectContext returns empty when nothing is available", async () => {
  const dir = tempDir();
  const out = await loadProjectContext({ dir, client: null, ref, sha: "abc" });
  assert.equal(out, "");
  rmSync(dir, { recursive: true, force: true });
});

test("loadProjectContext keeps curated context even when the repo fetch throws", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "ACME-acme-app.md"), "curated");
  const client = {
    getFileRaw: async () => {
      throw new Error("boom");
    },
  };
  const out = await loadProjectContext({ dir, client, ref, sha: "abc" });
  assert.match(out, /curated/);
  assert.ok(!out.includes("boom"));
  rmSync(dir, { recursive: true, force: true });
});

test("loadProjectContext skips AGENTS.md when fetchRepoContext is false", async () => {
  const dir = tempDir();
  let called = false;
  const client = {
    getFileRaw: async () => {
      called = true;
      return "AGENTS";
    },
  };
  const out = await loadProjectContext({ dir, client, ref, sha: "abc", fetchRepoContext: false });
  assert.equal(out, "");
  assert.equal(called, false);
  rmSync(dir, { recursive: true, force: true });
});

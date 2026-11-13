// Build the context documents handed to the reviewer and consensus agents.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { budgetDiff, numberDiff, LINE_SEP } from "./diff.js";

function describeChange(change) {
  const destPath = change?.destination?.toString;
  const srcPath = change?.source?.toString;
  const path = destPath || srcPath || "(unknown)";
  let type = change?.type || "MODIFIED";
  if (change?.source && !change?.destination) type = "DELETED";
  if (!change?.source && change?.destination) type = "ADDED";
  return `- ${type} ${path}`;
}

function changedFilesBlock(changes) {
  if (!changes.length) return "_(no file changes reported)_";
  return changes.map(describeChange).join("\n");
}

function prepareDiff(diff, maxBytes) {
  const b = budgetDiff(diff, maxBytes);
  let note = "";
  if (b.truncated) {
    const parts = [];
    if (b.partial.length) parts.push(`cut short: ${b.partial.map((p) => `\`${p}\``).join(", ")}`);
    if (b.omitted.length) parts.push(`omitted (${b.omitted.length}): ${b.omitted.map((p) => `\`${p}\``).join(", ")}`);
    note =
      "\n> NOTE: the diff exceeded the context budget; tests and lockfiles/generated files were\n" +
      `> dropped first. ${parts.join("; ")}. Read those files in the checkout if you need\n` +
      "> them, and lower confidence for anything you could not see.\n";
  }
  return { shown: numberDiff(b.diff), note };
}

const LINE_NUMBER_HINT =
  `Each hunk line is prefixed \`NNNNN${LINE_SEP}\` with its line number in the new file (blank for\n` +
  "removed lines). Use it for `line_start`/`line_end`; never include the prefix in `evidence`.";

// HTML comments are notes for editors (e.g. template TODOs), not for agents;
// a heading with no content before the next same-or-higher heading is dropped.
export function cleanContextText(raw) {
  const lines = String(raw).replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const level = (l) => (l.match(/^(#{1,6}) /)?.[1].length ?? 0);
  const keep = lines.map(() => true);
  for (let i = lines.length - 1; i >= 0; i--) {
    const lv = level(lines[i]);
    if (lv < 2) continue;
    let empty = true;
    for (let j = i + 1; j < lines.length; j++) {
      if (!keep[j] || !lines[j].trim()) continue;
      const next = level(lines[j]);
      if (next && next <= lv) break;
      empty = false;
      break;
    }
    if (empty) keep[i] = false;
  }
  return lines
    .filter((_, i) => keep[i])
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Stack rule files `<dir>/stacks/*.md`, each with a front matter line
 * `match: ["<regex>", ...]` (JSON array) tested against the PR's changed
 * paths. Returns `{ name, text, file }` for every stack the PR touches.
 */
export function matchStackContexts(dir, changedPaths = []) {
  const stacksDir = path.join(dir, "stacks");
  let names = [];
  try {
    names = readdirSync(stacksDir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(stacksDir, name);
    try {
      const raw = readFileSync(file, "utf8");
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      const matchLine = fm?.[1].match(/^match:\s*(\[.*\])\s*$/m);
      if (!matchLine) continue;
      const patterns = JSON.parse(matchLine[1]).map((p) => new RegExp(p, "i"));
      if (!changedPaths.some((p) => patterns.some((re) => re.test(p)))) continue;
      const text = cleanContextText(raw.slice(fm[0].length));
      if (text) out.push({ name: name.replace(/\.md$/, ""), text, file });
    } catch {
      /* a broken stack file must never abort a review */
    }
  }
  return out;
}

/**
 * Assemble the "project context" injected into every review, most general first:
 *   1. `<dir>/<PROJECT>.md` — org/project-wide, stack-neutral rules
 *   2. `<dir>/stacks/*.md` whose `match` patterns hit a changed path
 *   3. `<dir>/<PROJECT>-<repo>.md` (fallback `<dir>/<repo>.md`)
 *   4. the repo's own `AGENTS.md` at the reviewed head SHA (silent when absent)
 *
 * Designed to be additive and non-fatal: any problem yields `""` so a missing
 * or unreadable context never aborts a review.
 */
export async function loadProjectContext({ dir, client, ref, sha, fetchRepoContext = true, changedPaths = [] }) {
  const sources = [];

  const readCurated = (file) => {
    try {
      const text = cleanContextText(readFileSync(file, "utf8"));
      if (text) sources.push({ label: `curated ${path.basename(file)}`, text });
    } catch {
      /* keep going without it */
    }
  };

  const projectWide = path.join(dir, `${ref.projectKey}.md`);
  if (existsSync(projectWide)) readCurated(projectWide);

  for (const s of matchStackContexts(dir, changedPaths)) {
    sources.push({ label: `stack ${s.name}`, text: s.text });
  }

  const curatedCandidates = [
    path.join(dir, `${ref.projectKey}-${ref.repoSlug}.md`),
    path.join(dir, `${ref.repoSlug}.md`),
  ];
  const curated = curatedCandidates.find((f) => existsSync(f));
  if (curated) readCurated(curated);

  if (client && fetchRepoContext) {
    try {
      const agentsMd = await client.getFileRaw({
        projectKey: ref.projectKey,
        repoSlug: ref.repoSlug,
        path: "AGENTS.md",
        at: sha,
      });
      if (agentsMd && agentsMd.trim()) {
        sources.push({
          label: `${ref.projectKey}/${ref.repoSlug}:AGENTS.md@${sha ? String(sha).slice(0, 12) : "default"}`,
          text: agentsMd.trim(),
        });
      }
    } catch {
      /* repo context is additive; never fail the review over it */
    }
  }

  if (!sources.length) return "";
  return sources.map((s) => `_Source: ${s.label}._\n\n${s.text}`).join("\n\n---\n\n");
}

function projectContextBlock(projectContext = "") {
  if (!projectContext || !projectContext.trim()) return "";
  return `## Project context

> Curated project knowledge (language, framework, conventions). Treat it as
> authoritative: never contradict it, and check every suggested fix against it.

${projectContext.trim()}

`;
}

// The PR discussion block (author clarifications/replies) lives right after the
// description so reviewers see it before the code. Non-empty only when there is
// human activity to convey. See src/discussion.js.
function discussionBlockSection(discussionBlock = "") {
  if (!discussionBlock || !discussionBlock.trim()) return "";
  return `${discussionBlock.trim()}

`;
}

// The PR screenshots block (transcribed description/comment images) sits right
// after the discussion. See src/prImages.js.
function prImagesBlockSection(prImagesBlock = "") {
  if (!prImagesBlock || !prImagesBlock.trim()) return "";
  return `${prImagesBlock.trim()}

`;
}

export function buildReviewerContext({ ref, pullRequest, changes, diff, maxDiffBytes, projectContext = "", discussionBlock = "", prImagesBlock = "" }) {
  const { shown, note } = prepareDiff(diff, maxDiffBytes);
  const from = pullRequest.fromRef || {};
  const to = pullRequest.toRef || {};
  const reviewSha = from.latestCommit || from.id || "(unknown)";

  return `# AI Pull Request Review Context

## Repository
- Project: ${ref.projectKey}
- Repository: ${ref.repoSlug}
- Pull request: #${ref.prId}
- Title: ${pullRequest.title || "(untitled)"}
- Author: ${pullRequest.author?.user?.displayName || pullRequest.author?.user?.name || "(unknown)"}
- State: ${pullRequest.state || "(unknown)"}${pullRequest.draft ? " (draft)" : ""}

## Revisions
- Source branch: ${from.displayId || from.id || "(unknown)"}
- Reviewed head SHA: ${reviewSha}
- Target branch: ${to.displayId || to.id || "(unknown)"}
- Target SHA: ${to.latestCommit || to.id || "(unknown)"}

## Description
${pullRequest.description?.trim() || "_(no description)_"}

${discussionBlockSection(discussionBlock)}${prImagesBlockSection(prImagesBlock)}${projectContextBlock(projectContext)}## Changed files (${changes.length})
${changedFilesBlock(changes)}

## Unified diff

${LINE_NUMBER_HINT}

\`\`\`diff
${shown}
\`\`\`
${note}
Review the diff above. Use your own tools only to verify specific lines you are
unsure about; the complete change set is already provided above.
`;
}

export function buildConsensusContext({ ref, pullRequest, changes, diff, reports, maxDiffBytes, projectContext = "", jiraBlock = "", previousBlock = "", discussionBlock = "", prImagesBlock = "" }) {
  const { shown, note } = prepareDiff(diff, maxDiffBytes);
  const from = pullRequest.fromRef || {};
  const to = pullRequest.toRef || {};
  const reviewSha = from.latestCommit || from.id || "(unknown)";

  const reportsBlock = reports
    .map((r) => {
      const label = `Reviewer ${(r.agent || "?").toUpperCase()}`;
      return `### ${label}\n${r.text?.trim() || "(no report text)"}`;
    })
    .join("\n\n");

  const jiraSection = jiraBlock
    ? `${/^##\s+Linked Jira tickets/.test(jiraBlock.trim()) ? "" : "## Linked Jira tickets\n\n"}${jiraBlock.trim()}\n`
    : "";

  return `# AI Pull Request Consensus Input

## Repository
- Project: ${ref.projectKey}
- Repository: ${ref.repoSlug}
- Pull request: #${ref.prId}
- Title: ${pullRequest.title || "(untitled)"}
- Author: ${pullRequest.author?.user?.displayName || pullRequest.author?.user?.name || "(unknown)"}

## Revisions
- Reviewed head SHA: ${reviewSha}
- Target branch: ${to.displayId || to.id || "(unknown)"}
- Target SHA: ${to.latestCommit || to.id || "(unknown)"}

${projectContextBlock(projectContext)}
## Changed files (${changes.length})
${changedFilesBlock(changes)}

${jiraSection}${discussionBlockSection(discussionBlock)}${prImagesBlockSection(prImagesBlock)}${previousBlock ? `${previousBlock.trim()}\n\n` : ""}## Independent reviewer reports

${reportsBlock}

## Unified diff

${LINE_NUMBER_HINT}

\`\`\`diff
${shown}
\`\`\`
${note}
Synthesize the reviewer reports above into one final, verified report.
`;
}

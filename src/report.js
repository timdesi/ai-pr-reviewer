// Render the consensus report two ways:
//   - renderComment:      the public Bitbucket PR comment (author-facing only)
//   - renderFinalReport:  the full internal report (adds notes / audit trail)
//
// The public comment deliberately:
//   - opens with a digest + soft verdict (only non-zero severities are shown),
//   - links the reviewed commit,
//   - includes a "What's good" section (consensus `strengths`),
//   - renders impact as a blockquote, suggested fixes as a numbered list and
//     code evidence as `diff` blocks (so additions/removals get colours),
//   - drops the internal `notes` and any reviewer/agent meta-talk.
// Both end with a "Jira coverage" appendix (ticket link + AC verdict table)
// when the review ran with Jira ticket context (see src/jira.js).

import { renderJiraAppendix } from "./jira.js";
import { APP_VERSION } from "./version.js";

const SEVERITY_ICON = { CRITICAL: "🔴", HIGH: "🟠", MEDIUM: "🟡", LOW: "⚪" };
const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
// Renderer default shows everything; the pipeline passes the configured gate.
const OPEN_POLICY = { minSeverity: "LOW", minConfidence: 0 };

// Reviewer D's language findings (translation/i18n) are shown in their own
// section and drive the verdict only at HIGH/CRITICAL (meaning changed/harmful
// or a broken required placeholder) — consistency/style feedback is advisory.
const LANGUAGE_CATEGORIES = new Set(["translation", "i18n"]);
const VERDICT_RANK_MAX = SEVERITY_RANK.HIGH;

/** Split findings into code findings and language/content findings. */
export function splitLanguage(findings) {
  const code = [];
  const language = [];
  for (const f of findings ?? []) {
    const cat = String(f?.category || "").toLowerCase();
    (LANGUAGE_CATEGORIES.has(cat) ? language : code).push(f);
  }
  return { code, language };
}

/** Split findings into the ones shown in full and the compact "Minor" list. */
export function partitionFindings(findings, policy = OPEN_POLICY) {
  const maxRank = SEVERITY_RANK[String(policy?.minSeverity ?? "LOW").toUpperCase()] ?? SEVERITY_RANK.LOW;
  const minConf = typeof policy?.minConfidence === "number" ? policy.minConfidence : 0;
  const main = [];
  const minor = [];
  for (const f of findings ?? []) {
    const rank = SEVERITY_RANK[f?.severity] ?? SEVERITY_RANK.LOW;
    const conf = typeof f?.confidence === "number" ? f.confidence : 1;
    (rank <= maxRank && conf >= minConf ? main : minor).push(f);
  }
  return { main, minor };
}

function shortSha(sha) {
  return sha ? sha.slice(0, 8) : "(unknown)";
}

function fmtLines(f) {
  if (f.line_start == null && f.line_end == null) return "";
  if (f.line_start != null && f.line_end != null && f.line_start === f.line_end) {
    return ` L${f.line_start}`;
  }
  if (f.line_start != null && f.line_end != null) return ` L${f.line_start}-${f.line_end}`;
  return ` L${f.line_start ?? f.line_end}`;
}

function countsBySeverity(findings) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings ?? []) {
    const sev = String(f?.severity ?? "").toUpperCase();
    if (sev in counts) counts[sev]++;
  }
  return counts;
}

function verdictFor(counts) {
  if (counts.CRITICAL > 0) return { icon: "🔴", text: "**Do not merge** — critical issues must be resolved" };
  if (counts.HIGH > 0) return { icon: "🟠", text: "**Do not merge** — high-severity issues found" };
  if (counts.MEDIUM > 0) return { icon: "🟡", text: "**Worth addressing before merge**" };
  if (counts.LOW > 0) return { icon: "✅", text: "**Nothing blocks merge**" };
  return { icon: "✅", text: "**No issues found — clean change set**" };
}

function commitLink(report, ref, baseUrl) {
  const sha = report?.reviewed_sha;
  if (!sha) return null;
  const label = shortSha(sha);
  if (baseUrl && ref?.projectKey && ref?.repoSlug) {
    // GitHub links the commit on the repo's web URL; Bitbucket uses its REST
    // server origin. The branch is additive — Bitbucket PRs never take it.
    if (ref?.platform === "github") {
      return { label, href: `${baseUrl}/commit/${encodeURIComponent(sha)}` };
    }
    const url =
      `${baseUrl}/projects/${encodeURIComponent(ref.projectKey)}` +
      `/repos/${encodeURIComponent(ref.repoSlug)}/commits/${encodeURIComponent(sha)}`;
    return { label, href: url };
  }
  return { label, href: null };
}

function pushHeader(lines, { report, ref, baseUrl, findings, minorCount = 0, languageCount = 0 }) {
  const commit = commitLink(report, ref, baseUrl);
  // Commit sits in the heading: "## AI Review - ff34c305" (linked when we know
  // the base URL). The label is plain text — inline code inside a markdown link
  // label does not render as clickable in Bitbucket DC.
  const heading = commit
    ? `## AI Review - ${commit.href ? `[${commit.label}](${commit.href})` : commit.label}`
    : "## AI Review";
  lines.push(heading);
  lines.push("");
  const counts = countsBySeverity(findings);
  let verdict = verdictFor(counts);
  // Advisory language/content feedback (no blocking findings at all) should
  // read "nothing blocks" rather than "no issues found" — there IS feedback.
  if (
    languageCount > 0 &&
    counts.CRITICAL === 0 && counts.HIGH === 0 && counts.MEDIUM === 0 && counts.LOW === 0
  ) {
    verdict = { icon: "✅", text: "**Nothing blocks merge**" };
  }
  lines.push(`${verdict.icon} ${verdict.text}`);
  lines.push("");
  // Only severities that actually occurred — no noisy "0 MEDIUM · 0 HIGH".
  const parts = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    .filter((sev) => counts[sev] > 0)
    .map((sev) => `${SEVERITY_ICON[sev]} ${counts[sev]} ${sev}`);
  if (minorCount > 0) parts.push(`${minorCount} minor`);
  if (languageCount > 0) parts.push(`🈴 ${languageCount} language`);
  const severityLine = parts.join(" · ");
  if (severityLine) {
    lines.push(severityLine);
    lines.push("");
  }
}

function pushSummary(lines, report) {
  lines.push("### Summary");
  lines.push("");
  lines.push(report?.summary?.trim() || "_(no summary)_");
  lines.push("");
}

function pushStrengths(lines, strengths) {
  const list = Array.isArray(strengths)
    ? strengths.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (!list.length) return;
  lines.push("### What's good");
  lines.push("");
  for (const s of list) lines.push(`- ${s}`);
  lines.push("");
}

function pushEvidence(lines, evidence) {
  const text = String(evidence ?? "").replace(/\n+$/, "");
  if (!text) return;
  // A unified-diff shape (+/-/@@ lines) gets the `diff` language so Bitbucket
  // colours additions green and removals red.
  const looksLikeDiff = /(?:^|\n)\s*[+\-][^+\-]/.test(text) || /(?:^|\n)\s*@@/.test(text);
  lines.push("**Evidence:**");
  lines.push("");
  lines.push("```" + (looksLikeDiff ? "diff" : ""));
  lines.push(text);
  lines.push("```");
  lines.push("");
}

function pushFix(lines, fix) {
  const text = String(fix ?? "").trim();
  if (!text) return;
  const hasFence = text.includes("```");
  const stepLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const looksListed = /(?:^|\n)\s*(?:[-*]|\d+[.)])\s/.test("\n" + text);
  if (!hasFence && looksListed && stepLines.length > 1) {
    lines.push("**Suggested fix:**");
    lines.push("");
    for (const step of stepLines) {
      lines.push(`1. ${step.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")}`);
    }
    lines.push("");
  } else {
    lines.push(`**Suggested fix:** ${text}`);
    lines.push("");
  }
}

function groundingNote(f) {
  const g = f?.grounding;
  if (!g) return "";
  const flags = [];
  if (g.evidence === "not_found") flags.push("evidence not found in diff/checkout");
  if (g.file_in_diff === false) flags.push("file not in PR");
  return flags.length ? ` · ⚠ ${flags.join(", ")}` : "";
}

function pushFinding(lines, idx, f, internal = false) {
  const icon = SEVERITY_ICON[f?.severity] ?? "•";
  lines.push(`#### ${idx + 1}. ${icon} ${f?.severity ?? "LOW"} — ${f?.title ?? "(untitled)"}`);
  lines.push("");
  const loc = `**\`${f?.file ?? "(unknown file)"}\`**` + fmtLines(f ?? {});
  const conf = typeof f?.confidence === "number" ? ` · confidence ${f.confidence.toFixed(2)}` : "";
  const cat = internal && f?.category ? ` · ${f.category}` : "";
  lines.push(loc + conf + cat + (internal ? groundingNote(f) : ""));
  lines.push("");
  if (f?.description) {
    lines.push(`**What:** ${f.description.trim()}`);
    lines.push("");
  }
  if (f?.impact) {
    const impactLines = String(f.impact).trim().split(/\r?\n/);
    lines.push(`> **Impact:** ${impactLines[0]}`);
    for (const extra of impactLines.slice(1)) lines.push(`> ${extra}`);
    lines.push("");
  }
  pushEvidence(lines, f?.evidence);
  pushFix(lines, f?.suggested_fix);
}

function bySeverity(findings) {
  return [...(findings ?? [])].sort(
    (a, b) => (SEVERITY_RANK[a?.severity] ?? 9) - (SEVERITY_RANK[b?.severity] ?? 9),
  );
}

function pushFindings(lines, findings, { internal = false, hasMinor = false, hasLanguage = false } = {}) {
  const sorted = bySeverity(findings);
  lines.push(`### Findings (${sorted.length})`);
  lines.push("");
  if (sorted.length === 0) {
    lines.push(
      hasMinor
        ? "No significant code findings — only the minor points below."
        : hasLanguage
          ? "No code findings — see the **Language & content** section below for the translation review."
          : "No verified findings were reported for this change set.",
    );
    lines.push("");
    return;
  }
  for (const [idx, f] of sorted.entries()) pushFinding(lines, idx, f, internal);
}

// Reviewer D's language/content findings: rendered in full, always visible
// (not gated), advisory below HIGH. Anchor text says so explicitly so
// translators know style feedback won't block their merge.
function pushLanguage(lines, findings) {
  const sorted = bySeverity(findings);
  if (!sorted.length) return;
  lines.push(`### Language & content (${sorted.length})`);
  lines.push("");
  lines.push("_Translation & content feedback. Only **HIGH/CRITICAL** (meaning changed or harmful, or a broken placeholder) blocks merge; MEDIUM/LOW are advisory._");
  lines.push("");
  for (const [idx, f] of sorted.entries()) pushFinding(lines, idx, f, false);
  lines.push("");
}

// Bitbucket DC strips <details>, so minor points are a compact list instead.
function pushMinor(lines, findings) {
  const sorted = bySeverity(findings);
  if (!sorted.length) return;
  lines.push(`### Minor (${sorted.length})`);
  lines.push("");
  lines.push("_Low severity or low confidence — optional, verify before acting._");
  lines.push("");
  for (const f of sorted) {
    const icon = SEVERITY_ICON[f?.severity] ?? "•";
    const conf = typeof f?.confidence === "number" ? ` (confidence ${f.confidence.toFixed(2)})` : "";
    lines.push(`- ${icon} ${f?.title ?? "(untitled)"} — \`${f?.file ?? "(unknown file)"}\`${fmtLines(f ?? {})}${conf}`);
  }
  lines.push("");
}

function pushResolved(lines, resolved) {
  const list = Array.isArray(resolved) ? resolved.map((s) => String(s).trim()).filter(Boolean) : [];
  if (!list.length) return;
  lines.push(`### Resolved since last review (${list.length})`);
  lines.push("");
  for (const t of list) lines.push(`- ✅ ${t}`);
  lines.push("");
}

function pushDropped(lines, dropped) {
  const list = Array.isArray(dropped) ? dropped.filter((d) => d && typeof d === "object") : [];
  if (!list.length) return;
  lines.push(`### Dropped by consensus (${list.length})`);
  lines.push("");
  for (const d of list) {
    const src = Array.isArray(d.source_reviewers) && d.source_reviewers.length ? ` [${d.source_reviewers.join(",")}]` : "";
    lines.push(`- ${d.title ?? "(untitled)"}${src} — ${d.reason ?? "no reason given"}`);
  }
  lines.push("");
}

function pushNotes(lines, notes) {
  const list = Array.isArray(notes) ? notes.map((n) => String(n).trim()).filter(Boolean) : [];
  if (!list.length) return;
  lines.push("### Notes");
  lines.push("");
  for (const note of list) lines.push(`- ${note}`);
  lines.push("");
}

function pushBody(lines, { report, ref, baseUrl, internal, jiraTickets, policy }) {
  // Reviewer D's language findings are pulled out of the code gate: they are
  // always rendered in their own section (visible feedback), and only
  // HIGH/CRITICAL language findings influence the verdict. The internal report
  // shows every code finding in full; only the comment is gated.
  const { code, language } = splitLanguage(report?.findings ?? []);
  const { main, minor } = internal
    ? { main: code, minor: [] }
    : partitionFindings(code, policy);
  const verdictFindings = [
    ...main,
    ...language.filter((f) => (SEVERITY_RANK[f?.severity] ?? SEVERITY_RANK.LOW) <= VERDICT_RANK_MAX),
  ];
  pushHeader(lines, {
    report,
    ref,
    baseUrl,
    findings: verdictFindings,
    minorCount: minor.length,
    languageCount: language.length,
  });
  pushSummary(lines, report);
  pushStrengths(lines, report?.strengths);
  pushResolved(lines, report?.resolved_previous);
  pushFindings(lines, main, { internal, hasMinor: minor.length > 0, hasLanguage: language.length > 0 });
  pushLanguage(lines, language);
  pushMinor(lines, minor);
  if (internal) {
    pushNotes(lines, report?.notes);
    pushDropped(lines, report?.dropped);
  }
  pushJiraApp(lines, jiraTickets, report?.acceptance_criteria);
}

/**
 * Appends the "Jira coverage" appendix (ticket link + per-AC verdict table)
 * when tickets exist.
 */
function pushJiraApp(lines, jiraTickets, verdicts) {
  const text = renderJiraAppendix(jiraTickets, verdicts);
  if (!text) return;
  lines.push(text.replace(/\n+$/, ""));
  lines.push("");
}

/** The public comment: what a PR author sees after a review. */
export function renderComment({ report, ref, pullRequest, baseUrl, jiraTickets, policy, degraded } = {}) {
  const lines = [];
  pushBody(lines, { report, ref, baseUrl, jiraTickets, policy, internal: false });
  lines.push("---");
  const partial = Array.isArray(degraded) && degraded.length
    ? ` · partial review (${degraded.length} review pass${degraded.length > 1 ? "es" : ""} unavailable)`
    : "";
  lines.push(`_AI PR Reviewer v${APP_VERSION} · generated automatically · advisory · read-only${partial}_`);
  return lines.join("\n") + "\n";
}

/** The full internal report: same content plus the notes / audit trail. */
export function renderFinalReport({ report, ref, pullRequest, baseUrl, jiraTickets } = {}) {
  const lines = [];
  pushBody(lines, { report, ref, baseUrl, jiraTickets, internal: true });
  lines.push("---");
  lines.push(
    `_AI PR Reviewer v${APP_VERSION} · internal report — the public comment version is rendered separately (see comment-draft.md)._`,
  );
  return lines.join("\n") + "\n";
}

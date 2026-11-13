// Find the most recent earlier AI review of the same PR (older head SHA) so
// consensus can mark its findings as resolved or still open.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

export const MAX_PREVIOUS_FINDINGS = 15;

export function findPreviousReview({ jobsDir, jobPrefix, currentJob }) {
  let best = null;
  let entries = [];
  try {
    entries = readdirSync(jobsDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name === currentJob || !name.startsWith(jobPrefix)) continue;
    const file = path.join(jobsDir, name, "consensus.json");
    if (!existsSync(file)) continue;
    const mtime = statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { name, file, mtime };
  }
  if (!best) return null;
  try {
    const report = JSON.parse(readFileSync(best.file, "utf8"));
    const findings = (Array.isArray(report.findings) ? report.findings : [])
      .slice(0, MAX_PREVIOUS_FINDINGS)
      .map((f) => ({
        title: String(f?.title ?? "(untitled)"),
        severity: String(f?.severity ?? "LOW"),
        file: String(f?.file ?? ""),
        line_start: Number.isInteger(f?.line_start) ? f.line_start : null,
        line_end: Number.isInteger(f?.line_end) ? f.line_end : null,
      }));
    return { job: best.name, sha: report.reviewed_sha || null, findings };
  } catch {
    return null;
  }
}

/**
 * True when a prior AI review already covered this head commit — used to dedup
 * triggers (reviewer added / opened / marked ready, and an explicit `/ai-review`
 * comment) so the same head is never re-reviewed by accident. `/ai-review
 * --force` bypasses the gate to force a full re-run.
 */
export function alreadyReviewedAt(prev, head) {
  return !!prev && !!prev.sha && !!head && prev.sha === head;
}

export function renderPreviousReview(prev) {
  if (!prev || !prev.findings.length) return "";
  const sha = prev.sha ? String(prev.sha).slice(0, 8) : "an older commit";
  const items = prev.findings.map((f, i) => {
    const loc = f.line_start != null ? ` L${f.line_start}${f.line_end != null && f.line_end !== f.line_start ? `-${f.line_end}` : ""}` : "";
    return `${i + 1}. [${f.severity}] ${f.title} — \`${f.file}\`${loc}`;
  });
  return `## Previous AI review (${sha})

This PR was reviewed before at ${sha}. Its findings are listed below. For each:
if the current diff fixes it, put its exact title in \`resolved_previous\`; if
it is still present, report it again as a normal finding (verified as usual).
Never re-raise an issue the current code no longer has.

${items.join("\n")}
`;
}

// Deterministic post-check of consensus findings: is the quoted `evidence`
// really in the diff (or the checked-out file), and is `file` part of the PR?
// Findings that fail are not dropped — their confidence is capped so the
// public comment's confidence gate demotes them.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const UNGROUNDED_CONFIDENCE_CAP = 0.3;
export const OFF_DIFF_CONFIDENCE_CAP = 0.4;
const MIN_FRAGMENT_CHARS = 12;

// Whitespace-free form: chained calls and re-wrapped lines still match.
function squash(s) {
  return String(s).replace(/\s+/g, "");
}

// Drop unified-diff line markers (and our `NNNNN│` line-number prefix) so
// quotes with or without them both match.
function stripDiffMarkers(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\d*│/, "").replace(/^\s*[+-]/, ""))
    .join("\n");
}

// Full diff plus its new side (context + added) and old side (context +
// removed), so a quote spanning lines split by the other side still matches.
function diffHaystacks(diff) {
  const lines = String(diff).split(/\r?\n/).filter((l) => !/^(?:\+\+\+|---|diff |index |@@)/.test(l));
  const side = (skip) => squash(lines.filter((l) => l[0] !== skip).map((l) => l.slice(1)).join("\n"));
  return [squash(lines.map((l) => l.slice(1)).join("\n")), side("-"), side("+")];
}

function normPath(p) {
  return String(p || "")
    .trim()
    .replace(/^(?:src|dst):\/\//, "")
    .replace(/^[ab]\//, "")
    .replace(/^\.\//, "");
}

export function changedPathSet(changes = []) {
  const set = new Set();
  for (const c of changes) {
    for (const p of [c?.path?.toString, c?.srcPath?.toString, c?.destination?.toString, c?.source?.toString]) {
      if (p) set.add(normPath(p));
    }
  }
  return set;
}

// Models elide with "...", join lines and append "// note" annotations;
// any sizeable fragment matching counts as grounded.
export function evidenceFragments(evidence) {
  return stripDiffMarkers(evidence)
    .split(/\.{3}|…|\r?\n|\s\/\/\s|\s*\d*│/)
    .map((s) => squash(s.replace(/^\s*[+-]/, "")))
    .filter((s) => s.length >= MIN_FRAGMENT_CHARS);
}

function readCheckoutFile(checkoutDir, file) {
  if (!checkoutDir || !file) return "";
  const root = path.resolve(checkoutDir);
  const full = path.resolve(root, normPath(file));
  if (!full.startsWith(root + path.sep) || !existsSync(full)) return "";
  try {
    return readFileSync(full, "utf8");
  } catch {
    return "";
  }
}

/**
 * Annotate findings in place with `grounding` and cap confidence when the
 * evidence cannot be found. Returns counts for status/logging.
 */
export function groundFindings(report, { diff = "", changes = [], checkoutDir = null } = {}) {
  const stats = { checked: 0, notFound: 0, offDiff: 0 };
  if (!report || !Array.isArray(report.findings)) return stats;
  const diffHays = diffHaystacks(diff);
  const changed = changedPathSet(changes);

  for (const f of report.findings) {
    if (!f || typeof f !== "object") continue;
    stats.checked++;
    const fragments = evidenceFragments(f.evidence || "");
    let evidence = "unchecked";
    if (fragments.length) {
      const hays = [...diffHays, squash(readCheckoutFile(checkoutDir, f.file))].filter(Boolean);
      const found = fragments.some((frag) => hays.some((h) => h.includes(frag)));
      evidence = found ? "found" : "not_found";
    }
    const inDiff = changed.size === 0 || changed.has(normPath(f.file));
    f.grounding = { evidence, file_in_diff: inDiff };

    if (evidence === "not_found") {
      stats.notFound++;
      capConfidence(f, UNGROUNDED_CONFIDENCE_CAP);
      if (f.verification_status === "verified") f.verification_status = "partially_verified";
    }
    if (!inDiff) {
      stats.offDiff++;
      capConfidence(f, OFF_DIFF_CONFIDENCE_CAP);
    }
  }
  return stats;
}

function capConfidence(f, cap) {
  f.confidence = typeof f.confidence === "number" ? Math.min(f.confidence, cap) : cap;
}

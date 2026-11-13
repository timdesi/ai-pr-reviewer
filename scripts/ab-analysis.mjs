// A/B analysis for the consensus-model experiment.
// Reads pulled opencode JSONL files (ab-consensus-<tag>.jsonl) and scores each
// with the real production extractor + validator, plus the known regression
// probes (lazy-serialization false-HIGH, dead-null-guard).
//
// Usage: node scripts/ab-analysis.mjs <dir> [<meta file with "sec=" lines>]
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { extractTrailingJson } from "../src/extractJson.js";
import { validateConsensusReport, repairReportKeys } from "../src/validate.js";

const dir = process.argv[2] || ".";
const metaFile = process.argv[3];

// per-tag seconds from the runner output lines like: === fast rc=0 sec=45 ... ===
const seconds = {};
if (metaFile) {
  try {
    for (const line of readFileSync(metaFile, "utf8").split("\n")) {
      const m = line.match(/^=== (\S+) rc=(\d+) sec=(\d+)/);
      if (m) seconds[m[1]] = { rc: m[2], sec: m[3] };
    }
  } catch {}
}

function collectText(jsonl) {
  const parts = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t || t[0] !== "{") continue;
    let evt;
    try {
      evt = JSON.parse(t);
    } catch {
      continue;
    }
    if (evt.type === "text" && evt.part?.type === "text" && typeof evt.part.text === "string") {
      parts.push(evt.part.text);
    }
  }
  return parts.join("\n").trim();
}

// Probe 1: a HIGH/CRITICAL claiming lazy serialization of deviationCategory.
// Correct behaviour = absent, or LOW framed around EAGER / N+1.
function probeLazy(findings) {
  const hits = findings.filter(
    (f) =>
      /lazy|LazyInitializationException|serializ/i.test(f.title + " " + (f.description || "")) ||
      /deviationCategory/i.test(f.title + " " + (f.description || "")),
  );
  const bad = hits.filter((f) => f.severity === "HIGH" || f.severity === "CRITICAL");
  return {
    hits: hits.map((f) => `${f.severity} ${f.title}${/EAGER/i.test((f.description || "") + " " + (f.impact || "")) ? " [EAGER-framed]" : ""}`),
    bad,
  };
}

// Probe 2: dead null-guard / latent NPE around BaseCriteria copy constructor.
function probeNullGuard(findings) {
  return findings.filter((f) => /null-guard|dead null|latent NPE|NPE|super\(\)/i.test(f.title + " " + (f.description || "")));
}

const files = readdirSync(dir)
  .filter((f) => /^ab-consensus-.+\.jsonl$/.test(f))
  .sort();

const rows = [];
for (const f of files) {
  const tag = f.replace(/^ab-consensus-/, "").replace(/\.jsonl$/, "");
  const jsonl = readFileSync(path.join(dir, f), "utf8");
  const text = collectText(jsonl);
  const parsed = extractTrailingJson(text);
  let report = null;
  let valid = false;
  let errors = [];
  if (parsed) {
    repairReportKeys(parsed.json);
    const v = validateConsensusReport(parsed.json);
    valid = v.ok;
    errors = v.errors;
    report = parsed.json;
  }
  const findings = report?.findings ?? [];
  const lazy = probeLazy(findings);
  const rowsEntry = {
    tag,
    meta: seconds[tag] ?? null,
    ok: !!parsed,
    valid,
    errors: errors.length,
    findings: findings.length,
    severities: findings.reduce((a, f) => ((a[f.severity] = (a[f.severity] || 0) + 1), a), {}),
    strengths: Array.isArray(report?.strengths) ? report.strengths.length : 0,
    notes: Array.isArray(report?.notes) ? report.notes.length : 0,
    lazy: lazy,
    nullGuard: probeNullGuard(findings).map((f) => `${f.severity} ${f.title}`),
    summary: (report?.summary || "").slice(0, 140),
  };
  rows.push(rowsEntry);
}

for (const r of rows) {
  const sec = r.meta ? ` | ${r.meta.sec}s rc=${r.meta.rc}` : "";
  console.log(`\n### ${r.tag}${sec}`);
  console.log(`  json=${r.ok} valid=${r.valid} (${r.errors} schema errs) findings=${r.findings} strengths=${r.strengths} notes=${r.notes}`);
  console.log(`  severities=${JSON.stringify(r.severities)}`);
  console.log(`  lazy-probe hits: ${r.lazy.hits.length ? r.lazy.hits.join(" || ") : "none"}`);
  console.log(`  lazy-probe BAD (HIGH/CRITICAL on serialization): ${r.lazy.bad.length ? r.lazy.bad.map((f) => f.title) : "none"}`);
  console.log(`  null-guard hits: ${r.nullGuard.length ? r.nullGuard.join(" || ") : "none"}`);
  console.log(`  summary: ${r.summary}`);
  if (!r.valid) console.log(`  first errors: ${errorsJs(r)}`);
}

function errorsJs(r) {
  // recompute quickly is overkill; keep placeholder
  return "(see raw below)";
}

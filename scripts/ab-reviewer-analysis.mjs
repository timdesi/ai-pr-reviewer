// Reviewer A/B scoring: reads pulled opencode JSONL (ab-rev-<agent>-<tag>.jsonl)
// + baseline reports (baseline-<agent>.json), scores with the real production
// validator + probes + verification depth (tool calls).
//
// Usage: node scripts/ab-reviewer-analysis.mjs <dir> [<meta file with "sec=" lines>]
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { extractTrailingJson } from "../src/extractJson.js";
import { validateReviewerReport, repairReportKeys, SEVERITIES } from "../src/validate.js";

const dir = process.argv[2] || ".";
const metaFile = process.argv[3];

const seconds = {};
if (metaFile) {
  try {
    for (const line of readFileSync(metaFile, "utf8").split("\n")) {
      const m = line.match(/^=== (\S+) rc=(\d+) sec=(\d+)/);
      if (m) seconds[m[1]] = { rc: m[2], sec: m[3] };
    }
  } catch {}
}

function collectEvents(jsonl) {
  const parts = [];
  let toolCalls = 0;
  const toolNames = [];
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
    if (evt.type === "tool_use") {
      toolCalls++;
      if (evt.part?.tool) toolNames.push(evt.part.tool);
    }
  }
  return { text: parts.join("\n").trim(), toolCalls, toolNames };
}

function probeLazy(findings) {
  const hits = [];
  const bad = [];
  for (const f of findings) {
    const hay = `${f.title} ${f.description || ""} ${f.impact || ""}`;
    if (/lazy|LazyInitializationException|serializ/i.test(hay) || /deviationCategory/i.test(hay)) {
      const eager = /EAGER/i.test(hay);
      hits.push(`${f.severity} ${f.title}${eager ? " [EAGER-framed]" : ""}`);
      if (f.severity === "HIGH" || f.severity === "CRITICAL") bad.push(f.title);
    }
  }
  return { hits, bad };
}

function probeNullGuard(findings) {
  return findings
    .filter((f) => /null-guard|dead null|latent NPE|NPE|super\(\)/i.test(`${f.title} ${f.description || ""}`))
    .map((f) => `${f.severity} ${f.title}`);
}

function scoreReport(rawJson) {
  if (!rawJson) return { ok: false, valid: false, errors: ["no JSON extracted"] };
  repairReportKeys(rawJson);
  const v = validateReviewerReport(rawJson);
  return { ok: true, valid: v.ok, errors: v.errors, report: rawJson };
}

function summarize(key, src) {
  const rep = src.report ?? {};
  const findings = rep.findings || [];
  const sev = {};
  for (const f of findings) sev[f.severity] = (sev[f.severity] || 0) + 1;
  const errs = src.errors || [];
  console.log(`  key=${key} valid=${src.valid} (${errs.length} errs) findings=${findings.length}`);
  if (errs.length) console.log(`  errors: ${errs.slice(0, 5).join(" | ")}`);
  if (Object.keys(sev).length) console.log(`  severities=${JSON.stringify(sev)}`);
  console.log(`  findings: ${findings.map((f) => `${f.severity} ${f.title.slice(0, 78)}`).join(" || ") || "(none)"}`);
  if (!errs.length && rep.summary) console.log(`  summary: ${rep.summary.slice(0, 110)}`);
  const lazy = probeLazy(findings);
  console.log(`  lazy-probe: ${lazy.hits.length ? lazy.hits.join(" || ") : "none"} | BAD(HIGH/CRIT): ${lazy.bad.length ? lazy.bad.join(",") : "none"}`);
  const ng = probeNullGuard(findings);
  console.log(`  null-guard: ${ng.length ? ng.join(" || ") : "clean"}`);
}

const files = readdirSync(dir)
  .filter((f) => /^ab-rev-[abc]-(sonnet|opus)\.jsonl$/.test(f))
  .sort();

for (const f of files) {
  const m = f.match(/^ab-rev-([abc])-(sonnet|opus)\.jsonl$/);
  const agent = m[1];
  const tag = m[2];
  const meta = seconds[f.replace(/\.jsonl$/, "")] ?? seconds[`${agent}-${tag}`] ?? null;
  const sec = meta ? ` | ${meta.sec}s rc=${meta.rc}` : "";
  const jsonl = readFileSync(path.join(dir, f), "utf8");
  const { text, toolCalls, toolNames } = collectEvents(jsonl);
  const s = scoreReport(extractTrailingJson(text)?.json ?? null);
  console.log(`\n### pr-reviewer-${agent} + ${tag}${sec} (${toolCalls} tool call(s)${toolNames.length ? ": " + toolNames.join(",") : ""})`);
  summarize(`${agent}-${tag}`, s);
}

// Baselines (actual pipeline output for this PR head)
console.log("\n===== BASELINES (actual pipeline, same pr-context.md) =====");
for (const k of ["a", "b", "c"]) {
  const raw = JSON.parse(readFileSync(path.join(dir, `baseline-${k}.json`), "utf8"));
  const s = scoreReport(raw);
  const lbl = { a: "fast", b: "haiku", c: "gpt-6-luna" }[k];
  console.log(`\n### pr-reviewer-${k} + ${lbl}`);
  summarize(k, s);
}

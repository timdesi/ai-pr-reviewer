// Schema validation for reviewer and consensus JSON reports.

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
export const AC_STATUSES = ["met", "partial", "unmet", "not_verifiable"];
export const VERIFICATION_STATUSES = ["verified", "partially_verified", "unavailable"];
export const CATEGORIES = [
  "correctness",
  "maintainability",
  "concurrency",
  "persistence",
  "performance",
  "compatibility",
  "security",
  "requirements",
  "tests",
  "translation",
  "i18n",
];
export const SCHEMA_VERSION = "1.0";

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

export function validateFinding(f) {
  if (!f || typeof f !== "object") return ["finding is not an object"];
  const errors = [];
  const severity = typeof f.severity === "string" ? f.severity.toUpperCase() : f.severity;
  if (!isNonEmptyString(f.title)) errors.push(`finding.title missing (${f.title ?? "null"})`);
  if (!SEVERITIES.includes(severity)) errors.push(`finding.severity invalid: ${f.severity}`);
  if (f.confidence !== undefined && (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1)) {
    errors.push(`finding.confidence out of range 0..1: ${f.confidence}`);
  }
  if (typeof f.file !== "string") errors.push(`finding.file should be a string (got ${f.file})`);
  for (const ln of ["line_start", "line_end"]) {
    const v = f[ln];
    if (v != null && !Number.isInteger(v)) {
      errors.push(`finding.${ln} should be an integer or null (got ${JSON.stringify(v)})`);
    }
  }
  for (const k of ["description", "impact", "suggested_fix"]) {
    if (f[k] !== undefined && typeof f[k] !== "string") {
      errors.push(`finding.${k} should be a string`);
    }
  }
  // Evidence is required and must be a real, non-empty quote — the prompts
  // mandate it, so a missing/blank value is a hard validation error (the retry
  // loop feeds this message back to the model).
  if (typeof f.evidence !== "string" || f.evidence.trim().length === 0) {
    errors.push(`finding.evidence should be a non-empty string (got ${JSON.stringify(f.evidence)})`);
  }
  // Required so the report's confidence can be judged honestly: how strong the
  // claim actually was verified to be.
  const vs = typeof f.verification_status === "string" ? f.verification_status : "";
  if (!VERIFICATION_STATUSES.includes(vs)) {
    errors.push(
      `finding.verification_status missing or invalid: ${JSON.stringify(f.verification_status)} (expected ${VERIFICATION_STATUSES.join("|")})`,
    );
  }
  if (f.source_reviewers !== undefined) {
    if (!Array.isArray(f.source_reviewers) || f.source_reviewers.some((s) => !isNonEmptyString(s))) {
      errors.push("finding.source_reviewers should be an array of non-empty strings");
    }
  }
  // Optional and repaired rather than failed: an odd category is not worth a retry.
  if (f.category !== undefined) {
    const c = typeof f.category === "string" ? f.category.trim().toLowerCase() : "";
    f.category = CATEGORIES.includes(c) ? c : "other";
  }
  return errors;
}

function baseCheck(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { errors: ["report is not a JSON object"], findings: [] };
  }
  if (obj.schema_version !== undefined && obj.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version mismatch: expected ${SCHEMA_VERSION}, got ${obj.schema_version}`);
  }
  if (isNonEmptyString(obj.reviewed_sha)) {
    // ok
  } else if (obj.reviewed_sha !== null && obj.reviewed_sha !== undefined) {
    errors.push(`reviewed_sha should be a string (got ${obj.reviewed_sha})`);
  }
  if (!isNonEmptyString(obj.summary)) errors.push("summary missing or empty");
  if (!Array.isArray(obj.findings)) errors.push("findings should be an array");
  const findings = Array.isArray(obj.findings) ? obj.findings : [];
  findings.forEach((f, i) => {
    for (const e of validateFinding(f)) errors.push(`findings[${i}]: ${e}`);
  });
  return { errors, findings };
}

export function validateReviewerReport(obj) {
  const { errors, findings } = baseCheck(obj);
  return { ok: errors.length === 0, errors, report: obj, findings };
}

/**
 * Normalize the consensus `acceptance_criteria` array in place: keep only
 * well-formed entries, coerce statuses to the known set, and drop entries
 * without an id. Structural problems (non-array / non-object) are surfaced as
 * validation errors; minor per-entry quirks are repaired rather than failing
 * the whole report.
 */
function sanitizeAcceptanceCriteria(arr, errors) {
  if (!Array.isArray(arr)) return;
  const clean = [];
  arr.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`acceptance_criteria[${i}] should be an object`);
      return;
    }
    const status = typeof entry.status === "string"
      ? entry.status.toLowerCase().replace(/[\s_-]+/g, "")
      : "";
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) {
      errors.push(`acceptance_criteria[${i}].id missing`);
      return;
    }
    clean.push({
      ticket: typeof entry.ticket === "string" ? entry.ticket : "",
      id,
      status: AC_STATUSES.includes(status) ? status : "not_verifiable",
      reason: typeof entry.reason === "string" ? entry.reason : "",
      // Optional one-line summary of what the AC requires (for compact UIs).
      short: typeof entry.short === "string" ? entry.short.trim().slice(0, 160) : "",
    });
  });
  arr.length = 0;
  arr.push(...clean);
}

export function validateConsensusReport(obj) {
  const { errors, findings } = baseCheck(obj);
  if (obj.reviewed_files !== undefined && !Array.isArray(obj.reviewed_files)) {
    errors.push("reviewed_files should be an array");
  }
  if (obj.notes !== undefined && !Array.isArray(obj.notes)) {
    errors.push("notes should be an array");
  }
  if (obj.dropped !== undefined && !Array.isArray(obj.dropped)) {
    errors.push("dropped should be an array");
  }
  if (obj.resolved_previous !== undefined) {
    if (!Array.isArray(obj.resolved_previous)) errors.push("resolved_previous should be an array");
    else obj.resolved_previous = obj.resolved_previous.filter(isNonEmptyString).map((s) => s.trim());
  }
  if (obj.strengths !== undefined && !Array.isArray(obj.strengths)) {
    errors.push("strengths should be an array");
  } else if (Array.isArray(obj.strengths)) {
    obj.strengths.forEach((s, i) => {
      if (!isNonEmptyString(s)) errors.push(`strengths[${i}] should be a non-empty string`);
    });
  }
  if (obj.acceptance_criteria !== undefined && !Array.isArray(obj.acceptance_criteria)) {
    errors.push("acceptance_criteria should be an array");
  } else if (Array.isArray(obj.acceptance_criteria)) {
    sanitizeAcceptanceCriteria(obj.acceptance_criteria, errors);
  }
  return { ok: errors.length === 0, errors, report: obj, findings };
}

// --- near-miss key repair ------------------------------------------------
//
// Models occasionally emit keys with stray whitespace or wrong case, e.g.
// `" "findings"` or `"Summary"`. Repair renames such keys (in place) to the
// canonical schema name when the whitespace/case-normalized form matches
// exactly one known key. Applies to the top level of a report and to the
// fields of every finding object. Returns the number of keys renamed.

const TOP_KEYS = ["schema_version", "reviewed_sha", "summary", "findings", "notes", "reviewed_files", "strengths", "acceptance_criteria", "dropped", "resolved_previous"];
const FINDING_KEYS = [
  "title",
  "severity",
  "category",
  "verification_status",
  "confidence",
  "file",
  "line_start",
  "line_end",
  "description",
  "impact",
  "evidence",
  "suggested_fix",
  "source_reviewers",
];

function normKey(k) {
  return String(k).replace(/[\s_]+/g, "").toLowerCase();
}

function repairObjectKeys(obj, allowed) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return 0;
  const byNorm = new Map(allowed.map((k) => [normKey(k), k]));
  let changed = 0;
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key) || typeof key !== "string") continue;
    const target = byNorm.get(normKey(key));
    if (target && target !== key && obj[target] === undefined) {
      obj[target] = obj[key];
      delete obj[key];
      changed++;
    }
  }
  return changed;
}

export function repairReportKeys(obj) {
  if (!obj || typeof obj !== "object") return 0;
  let changed = repairObjectKeys(obj, TOP_KEYS);
  if (Array.isArray(obj.findings)) {
    for (const f of obj.findings) {
      if (f && typeof f === "object" && !Array.isArray(f)) {
        changed += repairObjectKeys(f, FINDING_KEYS);
      }
    }
  }
  return changed;
}
// Statistics for the dashboard's management-facing KPI page.
//
//   GET /api/stats  ->  { totals, cadence, series, usersOnboard }
//
// Everything here is computed from the local jobs directory (offline) — no
// Bitbucket calls. "Users onboard" is the configured ALLOWED_REVIEWER_USERS
// list; a review run == a job, so totals.reviews == totals.jobs.
//
// Time is bucketed in UTC: days (YYYY-MM-DD), ISO weeks (Monday start) and
// months. `cadence` holds average-per-day/week/month rates plus all-time
// totals; `series` holds the per-bucket counts/costs for the trend charts.

import { listJobs } from "./pipeline.js";

const DAY_MS = 86_400_000;
const AGENT_KEYS = ["a", "b", "c", "d", "consensus"];

function startOfDay(ms) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Monday as the start of the ISO week.
function startOfWeek(ms) {
  const d = startOfDay(ms);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Mon … 6 = Sun
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}

function keyStart(ms, gran) {
  if (gran === "day") return startOfDay(ms);
  if (gran === "week") return startOfWeek(ms);
  const d = startOfDay(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function stepKey(start, gran) {
  if (gran === "day") return new Date(start.getTime() + DAY_MS);
  if (gran === "week") return new Date(start.getTime() + 7 * DAY_MS);
  const d = new Date(start);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

function monthsBetween(aMs, bMs) {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
}

/** Total agent cost for a job (input / cache / output / total). */
function jobCost(job) {
  const out = { total: 0, input: 0, cache: 0, output: 0 };
  for (const k of AGENT_KEYS) {
    const c = job.agents?.[k]?.cost;
    if (!c) continue;
    out.total += c.total || 0;
    out.input += c.input || 0;
    out.cache += c.cache || 0;
    out.output += c.output || 0;
  }
  // Vision transcription (PR screenshots) is priced separately — its own model,
  // own slot — so it never mixes into a reviewer's usage.
  const v = job.vision?.cost;
  if (v) {
    out.total += v.total || 0;
    out.input += v.input || 0;
    out.cache += v.cache || 0;
    out.output += v.output || 0;
  }
  return out;
}

function jobFindings(job) {
  if (job.consensus?.findings?.length) return job.consensus.findings.length;
  let n = 0;
  for (const k of AGENT_KEYS) n += job.agents?.[k]?.findings ?? 0;
  return n;
}

const SEV_KEYS = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

/**
 * Total findings plus a per-severity split. The severity split comes from the
 * consensus report (the only place with a full findings array); jobs without a
 * consensus report only contribute to the total (status.json stores counts).
 */
function jobFindingsBreakdown(job) {
  const out = { total: 0, CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const list = job.consensus?.findings;
  if (Array.isArray(list) && list.length) {
    out.total = list.length;
    for (const f of list) {
      const sev = String(f?.severity || "").toUpperCase();
      if (SEV_KEYS.includes(sev)) out[sev] += 1;
    }
    return out;
  }
  out.total = jobFindings(job); // count-only fallback (no severity split)
  return out;
}

const round1 = (x) => Math.round(x * 10) / 10;

export function computeStats(config) {
  const all = listJobs(config).filter((j) => j.startedAt);
  const totals = { jobs: 0, reviews: 0, prs: 0, repos: 0, published: 0 };
  totals.findings = { total: 0, CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  totals.cost = { total: 0, input: 0, cache: 0, output: 0 };
  let firstRun = null;
  let lastRun = null;

  const prKeys = new Set();
  const repoKeys = new Set();
  const buckets = { day: new Map(), week: new Map(), month: new Map() };

  const touchBucket = (gran, ms, key) => {
    let b = buckets[gran].get(key);
    if (!b) {
      b = { t: keyStart(ms, gran).toISOString(), jobs: 0, prs: 0, cost: 0, published: 0, _prs: new Set() };
      buckets[gran].set(key, b);
    }
    return b;
  };

  for (const job of all) {
    const ms = new Date(job.startedAt).getTime();
    if (firstRun === null || ms < firstRun) firstRun = ms;
    if (lastRun === null || ms > lastRun) lastRun = ms;

    const cost = jobCost(job);
    totals.cost.total += cost.total;
    totals.cost.input += cost.input;
    totals.cost.cache += cost.cache;
    totals.cost.output += cost.output;
    if (job.publish?.published) totals.published += 1;
    const fb = jobFindingsBreakdown(job);
    totals.findings.total += fb.total;
    for (const sev of SEV_KEYS) totals.findings[sev] += fb[sev];

    const ref = job.ref;
    if (ref?.projectKey != null && ref?.repoSlug != null && ref?.prId != null) {
      const key = `${ref.projectKey}/${ref.repoSlug}#${ref.prId}`;
      prKeys.add(key);
      repoKeys.add(`${ref.projectKey}/${ref.repoSlug}`);
      for (const gran of ["day", "week", "month"]) {
        const b = touchBucket(gran, ms, gran === "day" ? startOfDay(ms).toISOString().slice(0, 10) : new Date(keyStart(ms, gran)).toISOString().slice(0, 10));
        b.jobs += 1;
        b.cost += cost.total;
        if (job.publish?.published) b.published += 1;
        b._prs.add(key);
      }
    }
  }

  totals.jobs = all.length;
  totals.reviews = all.length; // a review run == a job
  totals.prs = prKeys.size;
  totals.repos = repoKeys.size;

  const series = buildSeries(buckets, firstRun, lastRun);
  const spanDays = firstRun !== null ? Math.max(1, Math.round((lastRun - firstRun) / DAY_MS) + 1) : 0;
  const spanWeeks = spanDays ? Math.max(1, Math.ceil(spanDays / 7)) : 0;
  const spanMonths = spanDays ? Math.max(1, monthsBetween(firstRun, lastRun)) : 0;

  const rate = (div) => ({
    jobs: round1(totals.jobs / div),
    reviews: round1(totals.jobs / div),
    prs: round1(totals.prs / div),
    published: round1(totals.published / div),
    cost: Math.round((totals.cost.total / div) * 10000) / 10000,
  });

  return {
    totals: {
      ...totals,
      spanDays,
      firstRun: firstRun === null ? null : new Date(firstRun).toISOString(),
      lastRun: lastRun === null ? null : new Date(lastRun).toISOString(),
    },
    cadence: {
      day: rate(spanDays),
      week: rate(spanWeeks),
      month: rate(spanMonths),
      all: {
        jobs: totals.jobs,
        reviews: totals.jobs,
        prs: totals.prs,
        published: totals.published,
        cost: Math.round(totals.cost.total * 10000) / 10000,
      },
    },
    series,
    usersOnboard: {
      count: (config.job?.allowedReviewerUsers || []).length,
      list: config.job?.allowedReviewerUsers || [],
      note: "configured via ALLOWED_REVIEWER_USERS",
    },
  };
}

/** Flatten each bucketed map into a zero-filled, chronological array. */
function buildSeries(buckets, firstRun, lastRun) {
  const out = {};
  for (const gran of ["day", "week", "month"]) {
    const map = buckets[gran];
    const entries = [];
    if (firstRun === null || map.size === 0) {
      out[gran] = [];
      continue;
    }
    const start = keyStart(firstRun, gran);
    const end = keyStart(lastRun, gran);
    let cursor = start;
    let guard = 0;
    while (cursor.getTime() <= end.getTime() && guard++ < 2000) {
      const key = cursor.toISOString().slice(0, 10);
      const b = map.get(key);
      if (b) {
        entries.push({ t: b.t, jobs: b.jobs, prs: b._prs.size, cost: Math.round(b.cost * 100) / 100, published: b.published });
      } else {
        entries.push({ t: cursor.toISOString(), jobs: 0, prs: 0, cost: 0, published: 0 });
      }
      cursor = stepKey(keyStart(cursor.getTime(), gran), gran);
    }
    out[gran] = entries;
  }
  return out;
}

// Per-pull-request view for the dashboard.
//
// Groups review jobs by PR (projectKey/repoSlug#prId) so the UI can show the
// review *history* of a PR (each run's reviewed SHA, time, findings) together
// with its live Bitbucket state: current head SHA and the commits pushed since
// the last review. This answers "colleagues pushed new commits — which PRs still
// need a re-review?".
//
//   GET /api/pulls?live=1   ->  { pulls: [...], live: true }
//
// The Bitbucket head/commits fetches are cached in-memory (HEAD_TTL_MS) so the
// UI can poll cheaply; pass live=0 (or omit the client) to get local-only data.

import { listJobs } from "./pipeline.js";
import { log } from "./log.js";

// Stage names that mean a review is still in flight for this PR.
const RUNNING = new Set(["fetch", "review", "consensus", "render", "publish"]);
const HEAD_TTL_MS = 60_000;

// ref-key -> { ts, res: { headSha, stale, newCommits } }
const headCache = new Map();

export function clearPullCache() {
  headCache.clear();
}

export function keyOf(ref) {
  if (!ref) return null;
  return `${ref.projectKey}/${ref.repoSlug}#${ref.prId}`;
}

function resultFindings(job) {
  if (job.consensus?.findings) return job.consensus.findings.length;
  let n = 0;
  for (const k of ["a", "b", "c", "d"]) n += job.agents?.[k]?.findings ?? 0;
  return n;
}

function stripPrPrefix(title) {
  if (!title) return title;
  // Bitbucket titles come over as "Pull request #1234: <subject>".
  return title.replace(/^Pull request #\d+:\s*/i, "");
}

/** Group summary jobs into per-PR pulls. No network; usable offline. */
export function buildPullMap(jobs, config) {
  const map = new Map();
  const baseUrl = config?.bitbucket?.baseUrl?.replace(/\/+$/, "") || "";
  for (const job of jobs) {
    const ref = job.ref;
    if (!ref || ref.projectKey === undefined || ref.repoSlug === undefined || ref.prId == null) continue;
    const key = keyOf(ref);
    const rev = {
      job: job.job,
      title: stripPrPrefix(job.title) || job.job,
      reviewedSha: job.reviewedSha || null,
      startedAt: job.startedAt || null,
      stage: job.stage || "unknown",
      error: job.error || null,
      findings: resultFindings(job),
      published: !!job.publish?.published,
    };
    let p = map.get(key);
    if (!p) {
      p = {
        key,
        projectKey: ref.projectKey,
        repoSlug: ref.repoSlug,
        prId: ref.prId,
        app: `${ref.projectKey}/${ref.repoSlug}`,
        url: baseUrl ? `${baseUrl}/projects/${encodeURIComponent(ref.projectKey)}/repos/${encodeURIComponent(ref.repoSlug)}/pull-requests/${ref.prId}` : null,
        reviews: [],
        running: false,
        owner: null, // PR author display name, filled by enrich()
        state: null, // Bitbucket PR state: OPEN | MERGED | DECLINED | SUPERSEDED
        closed: false, // merged / declined / superseded → no further reviews
        notFound: false, // Bitbucket says the PR no longer exists (deleted after merge/decline)
        unreviewable: false, // closed || notFound → dimmed, no re-review
      };
      map.set(key, p);
    }
    if (RUNNING.has(rev.stage)) p.running = true;
    p.reviews.push(rev);
  }
  const pulls = [...map.values()];
  for (const p of pulls) {
    p.reviews.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    p.title = p.reviews[0]?.title || `PR #${p.prId}`;
    p.latestReview = p.reviews[0] || null;
    p.stale = null; // filled by enrich()
    p.newCommits = [];
    p.historyRewritten = false;
    p.headError = null;
    p.branch = null; // source branch name, filled by enrich()
    p.targetBranch = null;
  }
  return pulls.sort(
    (a, b) => (b.latestReview?.startedAt || "").localeCompare(a.latestReview?.startedAt || ""),
  );
}

function applyHead(pull, res) {
  pull.headSha = res.headSha ?? null;
  pull.stale = res.stale ?? null;
  pull.newCommits = res.newCommits ?? [];
  pull.historyRewritten = res.historyRewritten ?? false;
  pull.headError = res.headError ?? null;
  pull.branch = res.branch ?? null;
  pull.targetBranch = res.targetBranch ?? null;
  // Author display name (fall back to slug/login, then email) for "who owns this PR".
  // Bitbucket DC nests the user object under `author.user`; older/other shapes put
  // the fields directly on `author`.
  const author = res.author?.user || res.author || {};
  pull.owner = author.displayName || author.name || author.slug || author.emailAddress || null;
  pull.state = res.state ?? null;
  pull.closed =
    !!res.closed || ["MERGED", "DECLINED", "SUPERSEDED"].includes(String(res.state || "").toUpperCase());
  // A PR that Bitbucket no longer has (404, e.g. deleted after being merged or
  // declined) can never be reviewed again — treat it like a closed PR.
  pull.notFound = !!res.notFound;
  pull.unreviewable = pull.closed || pull.notFound;
}

const byNewest = (a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0);

/**
 * Commits newer than the last reviewed SHA, taken from the PR's own commit
 * list (handle order defensively). Returns { newCommits, historyRewritten }.
 * When the reviewed SHA is gone from the list the branch was force-pushed /
 * rebased after the review; we then surface the newest commits and flag it.
 */
async function commitsSince(client, pull, lastReviewed) {
  const list = await client.getPullRequestCommits(pull);
  if (!list.length) return { newCommits: [], historyRewritten: false };
  const newestFirst = (list[0]?.timestamp ?? 0) >= (list[list.length - 1]?.timestamp ?? 0);
  const idx = list.findIndex((c) => c.id === lastReviewed);
  if (idx === -1) {
    return {
      newCommits: [...list].sort(byNewest).slice(0, 10),
      historyRewritten: true,
    };
  }
  const newPart = newestFirst ? list.slice(0, idx) : list.slice(idx + 1);
  return { newCommits: [...newPart].sort(byNewest).slice(0, 25), historyRewritten: false };
}

async function enrichOne(pull, client, { ttlMs }) {
  const now = Date.now();
  const cached = headCache.get(pull.key);
  if (cached && now - cached.ts < ttlMs) {
    applyHead(pull, cached.res);
    return;
  }
  let headSha = null;
  let branch = null;
  let targetBranch = null;
  let author = null;
  let state = null;
  let closed = false;
  let notFound = false;
  let headError = null;
  try {
    if (typeof client.getPullRequestRefs === "function") {
      ({ headSha, branch, targetBranch, author, state, closed } = await client.getPullRequestRefs(pull));
    } else {
      headSha = await client.getPullRequestHead(pull); // older clients
    }
  } catch (err) {
    headError = err.message;
    // HTTP 404 means the PR is gone (Bitbucket purges merged/declined PRs) —
    // it can never be reviewed again.
    notFound = err.status === 404 || /does not exist|not found/i.test(err.message || "");
    log.warn(`pulls: head fetch failed for ${pull.key}: ${err.message}`);
  }
  // null = unknown (head fetch failed); false = head equals last reviewed SHA.
  let stale = headSha ? false : null;
  let newCommits = [];
  let historyRewritten = false;
  const latest = pull.latestReview?.reviewedSha;
  if (headSha && latest && headSha !== latest) {
    stale = true;
    try {
      ({ newCommits, historyRewritten } = await commitsSince(client, pull, latest));
    } catch (err) {
      log.warn(`pulls: new-commits lookup failed for ${pull.key}: ${err.message}`);
    }
  }
  const res = { headSha, stale, newCommits, historyRewritten, headError, branch, targetBranch, author, state, closed, notFound };
  headCache.set(pull.key, { ts: Date.now(), res });
  applyHead(pull, res);
}

/** Fetch live head state for every pull concurrently (bounded). */
async function enrich(pulls, client, { ttlMs, concurrency }) {
  if (!client || !pulls.length) return;
  const workers = Math.min(concurrency, Math.max(1, pulls.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < pulls.length) {
        const p = pulls[cursor++];
        await enrichOne(p, client, { ttlMs });
      }
    }),
  );
}

/**
 * Summary of every pull request the local jobs reference.
 *
 * @param config runtime config (for job dir + bitbucket base URL)
 * @param client optional BitbucketClient; when omitted only local data is returned
 * @param opts.live  fetch live head state (default true when client is given)
 * @param opts.ttlMs cache lifetime for head/res (default HEAD_TTL_MS)
 * @param opts.concurrency max parallel Bitbucket lookups
 */
export async function listPulls(config, { client, live = true, ttlMs = HEAD_TTL_MS, concurrency = 4 } = {}) {
  const pulls = buildPullMap(listJobs(config), config);
  if (live && client && pulls.length) {
    await enrich(pulls, client, { ttlMs, concurrency });
  }
  return { pulls, live: live && !!client };
}

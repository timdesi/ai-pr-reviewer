// Shallow git checkout of the reviewed commit, so reviewer agents can read the
// real tree (base classes, config) instead of reasoning only from the diff.
//
// Design:
//   - one warm *bare* repo per project/repo under WORKSPACE_ROOT (e.g.
//     `<workspace>/acme-acme-app.git`) so repeat reviews on the same repo
//     only fetch the small delta for the new SHA;
//   - per review: shallow-fetch the exact reviewed SHA, then attach a detached
//     worktree at `<workspace>/<proj>-<repo>-<sha8>` and run the agents with
//     that as their cwd;
//   - best-effort: every failure (missing git, network, auth, no such sha)
//     degrades to "no checkout" and never fails the review — the diff and the
//     project context remain the primary input.
//
// Concurrency: a per-repo lock (mkdir) serializes fetch/worktree operations;
// two reviews on different repos use different locks and run in parallel.
//
// Everything is kept inside WORKSPACE_ROOT (the PVC). Worktrees are pruned to
// `CHECKOUT_KEEP` newest per repo after each review (git worktree prune), so a
// large repository cannot fill the 2 GiB volume.

import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { log } from "./log.js";
import { backendConfig } from "./clients.js";

// Default git call timeout (ms) and max captured stdout bytes. Matches the old
// spawnSync(300s) behaviour, but now the child runs on its own process while the
// event loop keeps serving /healthz — a stalled fetch can no longer freeze the
// HTTP server (see issue #6).
const GIT_TIMEOUT_MS = 300000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Run git asynchronously (non-blocking). Resolves with the same result shape as
 * the previous spawnSync helper so callers/throwIf keep behaving identically:
 * `{ status, stdout, stderr, error }`. On timeout the whole process group is
 * SIGKILLed and `error` is set so throwIf still surfaces the failure.
 */
function git(args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const out = { status: null, stdout: "", stderr: "", error: null, timedOut: false };
    let settled = false;
    const child = spawn("git", args, {
      detached: true, // own process group so timeout can kill fetch subprocesses too
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };
    const timer = setTimeout(() => {
      out.timedOut = true;
      out.error = new Error(`git timed out after ${timeoutMs}ms`);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (Buffer.byteLength(out.stdout, "utf8") < GIT_MAX_BUFFER) out.stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (Buffer.byteLength(out.stderr, "utf8") < GIT_MAX_BUFFER) out.stderr += d.toString();
    });
    child.on("error", (err) => {
      out.error = err;
      finish();
    });
    child.on("close", (code) => {
      out.status = code;
      finish();
    });
  });
}

function throwIf(res, what) {
  if (res.error) throw res.error; // e.g. git binary missing (ENOENT)
  if (res.status !== 0) {
    throw new Error(`${what}: git exited ${res.status}: ${(res.stderr || res.stdout || "").trim().slice(0, 500)}`);
  }
  return res;
}

/** The git clone host for a GitHub API base (github.com vs GHES). */
function githubGitHost(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (u.host === "api.github.com") return "github.com";
    // GHES: the API lives at <host>/api/v3; the git clone host is the same
    // origin (no path).
    return u.host;
  } catch {
    return "github.com";
  }
}

/** https://<host>/scm/<projectKey>/<repoSlug>.git — Bitbucket DC layout. */
export function scmUrl({ baseUrl, projectKey, repoSlug, platform }) {
  if (platform === "github") {
    const host = githubGitHost(baseUrl);
    return `https://${host}/${encodeURIComponent(projectKey)}/${encodeURIComponent(repoSlug)}.git`;
  }
  const host = new URL(baseUrl).host;
  return `https://${host}/scm/${String(projectKey).toLowerCase()}/${String(repoSlug).toLowerCase()}.git`;
}

/**
 * An https URL with inline Basic-auth credentials (used only as a throwaway
 * fetch argument — never persisted in the repo config). The username is used
 * as given, byte-for-byte — the GitHub-only `x-token-auth` fallback lives in
 * `checkoutUsername`, never here, so the Bitbucket path is unchanged when
 * BITBUCKET_USERNAME is empty (an empty username maps to an empty username,
 * matching the pre-adapter behaviour).
 */
export function basicAuthUrl(raw, username, token) {
  const u = new URL(raw);
  u.username = username;
  u.password = token;
  return u.toString();
}

/**
 * The git-auth username for a checkout URL. GitHub clones with no bot username
 * use `x-token-auth` (the conventional token-user) as the URL username; every
 * other platform keeps the configured username as-is, so the fallback can never
 * leak into the Bitbucket path.
 */
export function checkoutUsername(platform, username) {
  return platform === "github" ? username || "x-token-auth" : username;
}

function bareRepoDir({ workspaceRoot, ref }) {
  return path.join(workspaceRoot, `${repoNameOf(ref)}.git`);
}

function worktreePath({ workspaceRoot, ref, sha }) {
  return path.join(workspaceRoot, `${repoNameOf(ref)}-${String(sha).slice(0, 8)}`);
}

function lockDir({ workspaceRoot, ref }) {
  return path.join(workspaceRoot, `.lock-${repoNameOf(ref)}`);
}

/**
 * Lowercased `owner-repo` handle for the cache dirs, namespaced & *separated*
 * for GitHub (`github@owner-repo`) so a mirrored GitHub acme/widgets can never
 * share a bare repo / worktree / lock with a Bitbucket repository whose key
 * happens to be `GITHUB` (which would lowercase to the `github-` prefix).
 * `@` cannot appear in a Bitbucket key or repo slug, so the Github handle can
 * never be produced by a Bitbucket one. Bitbucket names are byte-for-byte
 * unchanged (existing caches stay valid).
 */
export function repoNameOf(ref) {
  const slug = `${String(ref?.projectKey).toLowerCase()}-${String(ref?.repoSlug).toLowerCase()}`;
  return ref?.platform === "github" ? `github@${slug}` : slug;
}

async function withLock(lock, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      // A real failure (parent dir missing, EACCES, …) must surface immediately
      // instead of being misread as a held lock and spinning until timeout.
      if (err.code !== "EEXIST") throw err;
      if (Date.now() > deadline) throw new Error("checkout lock timed out");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Ensure the bare cache repo exists, configured for this cluster, and fetch the reviewed SHA. */
async function ensureFetched({ baseUrl, token, username = "x-token-auth", verifyTls, workspaceRoot, ref, sha, branch, origin, platform, lowSpeedLimit, lowSpeedTime }) {
  const bare = bareRepoDir({ workspaceRoot, ref });
  mkdirSync(path.dirname(bare), { recursive: true });

  if (!existsSync(path.join(bare, "HEAD"))) {
    throwIf(await git(["init", "--bare", bare]), "git init");
    const url = origin || scmUrl({ baseUrl, projectKey: ref.projectKey, repoSlug: ref.repoSlug, platform });
    throwIf(await git(["--git-dir", bare, "remote", "add", "origin", url]), "git remote add");
    if (!verifyTls) await git(["--git-dir", bare, "config", "http.sslVerify", "false"]);
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (proxy) await git(["--git-dir", bare, "config", "http.proxy", proxy]);
  }

  const base = ["--git-dir", bare, "fetch", "--no-tags"];
  // Abort a fetch that has stalled: if the transfer rate stays below
  // lowSpeedLimit bytes/s for lowSpeedTime s, git gives up instead of hanging on
  // a dead proxy connection until the 300 s timeout (issue #6).
  if (lowSpeedLimit != null && lowSpeedTime != null) {
    base.unshift("-c", `http.lowSpeedLimit=${lowSpeedLimit}`, "-c", `http.lowSpeedTime=${lowSpeedTime}`);
  }
  const attempts = [];

  // Preferred: Bearer via http.extraHeader — the token never appears in a URL.
  if (token) {
    const bearer = ["-c", `http.extraHeader=Authorization: Bearer ${token}`];
    attempts.push([...bearer, ...base, "--depth=1", "origin", sha]);
    if (branch) attempts.push([...bearer, ...base, "--depth=50", "origin", branch]);
  }

  // Some Bitbucket DC versions accept REST Bearer but not git Bearer; fall back
  // to basic auth with the token as password (credentials in the URL, used
  // inline so they are never persisted in the repo config). GitHub accepts a
  // PAT as the password the same way. Local file remotes (tests) skip this —
  // they need no auth.
  const baseUrl2 = origin || scmUrl({ baseUrl, projectKey: ref.projectKey, repoSlug: ref.repoSlug, platform });
  if (token && /^https?:/i.test(baseUrl2)) {
    attempts.push([...base, "--depth=1", basicAuthUrl(baseUrl2, username, token), sha]);
    if (branch) attempts.push([...base, "--depth=50", basicAuthUrl(baseUrl2, username, token), branch]);
  }

  // A raw-SHA fetch is refused by some DC versions (and by local file remotes);
  // the deeper branch attempts then surface the SHA locally, and we verify it.
  let fetched = false;
  for (const args of attempts) {
    const r = await git(args);
    if (r.error) throw r.error;
    if (r.status === 0) {
      const check = await git(["--git-dir", bare, "cat-file", "-e", `${sha}^{commit}`]);
      if (check.status === 0) {
        fetched = true;
        break;
      }
    }
  }
  if (!fetched) throw new Error(`could not fetch reviewed sha ${sha}`);
  return bare;
}

/** Attach (or reuse) a detached worktree at the deterministic SHA dir. */
async function ensureWorktree({ workspaceRoot, ref, sha, bare }) {
  const wt = worktreePath({ workspaceRoot, ref, sha });

  if (existsSync(path.join(wt, ".git"))) return wt; // already a linked worktree

  rmSync(wt, { recursive: true, force: true });
  throwIf(await git(["--git-dir", bare, "worktree", "add", "--detach", wt, sha]), "git worktree add");
  return wt;
}

/** Keep only the newest `keep` worktrees per repo; let git prune the rest. */
async function pruneWorktrees({ workspaceRoot, ref, keep = 3 }) {
  const bare = bareRepoDir({ workspaceRoot, ref });
  if (!existsSync(path.join(bare, "HEAD"))) return;

  const list = await git(["--git-dir", bare, "worktree", "list", "--porcelain"]);
  const entries = String(list.stdout)
    .split("\n\n")
    // `worktree list` on a *bare* repo also emits the bare repo itself as an
    // entry (marked with a `bare` line) — exclude it so we never prune the
    // shared object store or treat it as one of the CHECKOUT_KEEP slots.
    .filter((b) => b.includes("worktree ") && !/^bare$/m.test(b))
    .map((b) => {
      const dir = b.match(/^worktree (.*)$/m)?.[1];
      let mtime = 0;
      if (dir) {
        try {
          mtime = statSync(dir).mtimeMs;
        } catch {
          mtime = 0;
        }
      }
      return { dir, mtime };
    });

  const stale = entries.filter((e) => !e.dir || !existsSync(e.dir));
  for (const e of stale) {
    if (e.dir) rmSync(e.dir, { recursive: true, force: true });
  }

  const valid = entries.filter((e) => e.dir && existsSync(e.dir)).sort((a, b) => b.mtime - a.mtime);
  for (const e of valid.slice(keep)) {
    try {
      await git(["--git-dir", bare, "worktree", "remove", "--force", e.dir]);
    } catch {
      rmSync(e.dir, { recursive: true, force: true });
      await git(["--git-dir", bare, "worktree", "prune"]);
    }
  }
  await git(["--git-dir", bare, "worktree", "prune"]);
}

// --- workspace disk maintenance (issue #11) ----------------------------------
//
// The warm bare per-repo caches grow *monotonically*: every shallow fetch
// appends a new pack, and nothing consolidated them, so a busy repo (ppc-main)
// reached 113 packs / ~700 MB and filled the 2 GiB PVC until a review died with
// ENOSPC mid-start. Prevention is (a) `git gc` once a repo has too many packs,
// (b) an LRU budget on the whole workspace, and (c) a free-space guard before
// any fetch. All best-effort — a failure only means less caching, never a
// broken review (they degrade to "no checkout" like the rest of this module).

// A full recursive `du` of the workspace on *every* checkout is wasteful while
// nothing is over budget (AI review, PR #12 minor). The byte-budget eviction is
// therefore re-checked at most once per interval on the normal post-checkout
// path; the cheap `statfs` free-space guard and the on-demand ENOSPC/low-space
// reclaim still react immediately when the volume is actually tight.
const EVICTION_CHECK_INTERVAL_MS = 60_000;
let lastEvictionCheckAt = 0;

// Bare repos whose checkout is currently handed to a running review, refcounted
// per repo: added on successful prepareCheckout, released in cleanupCheckout.
// Two reviews of the same repo can overlap (the per-repo lock only covers the
// fetch/worktree phase), so the entry is dropped only when the *last* finisher
// releases — otherwise the first one to finish would unprotect the repo while
// the other review still runs against its worktree (AI review, PR #12 MEDIUM).
// Eviction skips every bare in here.
const activeBares = new Map();

function protectBare(bare) {
  activeBares.set(bare, (activeBares.get(bare) ?? 0) + 1);
}

function releaseBare(bare) {
  const n = (activeBares.get(bare) ?? 0) - 1;
  if (n <= 0) activeBares.delete(bare);
  else activeBares.set(bare, n);
}

/** Number of `.pack` files in a bare repo's object store (0 when absent). */
export function packCount(bare) {
  try {
    return readdirSync(path.join(bare, "objects", "pack")).filter((n) => n.endsWith(".pack")).length;
  } catch {
    return 0;
  }
}

/** Consolidate a bare repo's packs (`git gc --prune=now`). Throws on failure. */
async function gcBare(bare) {
  const r = await git(["--git-dir", bare, "gc", "--prune=now", "--quiet"]);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git gc failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
  }
}

/**
 * Run `git gc` on a bare repo once its pack count reaches `packs` (default from
 * config). Cheap when under the gate — a single readdir. Keeps the object store
 * bounded instead of growing one pack per fetch forever.
 */
export async function maintainBare(bare, { packs = 20 } = {}) {
  if (packCount(bare) >= packs) {
    log.warn(`workspace: ${path.basename(bare)} has ${packCount(bare)} packs; running git gc`);
    await gcBare(bare);
  }
}

/** Total bytes of a path via `du -sk` (portable across BSD/GNU; 0 on failure). */
function duBytes(dir) {
  return new Promise((resolve) => {
    const child = spawn("du", ["-s", "-k", dir], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const kb = out.trim().split(/\s+/)[0];
      resolve(/^\d+$/.test(kb) ? Number(kb) * 1024 : 0);
    });
  });
}

/** Free bytes on the volume hosting `dir`, via fs.statfs (Infinity if unknown). */
async function freeBytes(dir) {
  try {
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity; // statfs unavailable → never preemptively guard
  }
}

/**
 * Remove a bare repo together with *exactly* the worktrees git registers to it,
 * returning the bytes freed (bare + worktrees, measured before removal).
 *
 * Worktree membership comes from `git --git-dir <bare> worktree list
 * --porcelain` — the authoritative registry, exactly as `pruneWorktrees` uses —
 * never from a name prefix. A bare `<repo>-` prefix collides between sibling
 * repos whose slugs extend each other (e.g. `planning` vs `planning-gateway`,
 * sibling repos that both exist in production): prefix-matching
 * would delete the sibling's worktrees — including possibly the active review's
 * checkout — while leaving them registered in the sibling's `worktrees/`
 * metadata so its next `git worktree add` fails (AI review, PR #12).
 *
 * Must be called while the bare dir still exists so git can answer. Only when
 * git reports no worktrees (bare already gone) do we fall back to matching the
 * unambiguous `<repo>-<8 hex sha>` name shape — never a bare prefix.
 */
async function removeBareAndWorktrees(workspaceRoot, bareName) {
  const bare = path.join(workspaceRoot, bareName);
  const handle = bareName.slice(0, -".git".length);

  // git reports real paths (e.g. /private/var/… where os.tmpdir() said
  // /var/…), so compare realpaths — a bare path.startsWith check would wrongly
  // reject on macOS's /var → /private/var alias.
  let rootReal = path.resolve(workspaceRoot);
  try {
    rootReal = realpathSync(workspaceRoot);
  } catch {
    /* root missing — nothing to remove below anyway */
  }
  let bareReal = path.resolve(bare);
  try {
    bareReal = realpathSync(bare);
  } catch {
    /* bare already gone */
  }

  const targets = [];
  try {
    const r = await git(["--git-dir", bare, "worktree", "list", "--porcelain"]);
    for (const block of String(r.stdout).split("\n\n")) {
      const dir = block.match(/^worktree (.*)$/m)?.[1];
      if (!dir) continue;
      let dirReal = path.resolve(dir);
      try {
        dirReal = realpathSync(dir);
      } catch {
        /* stale registry entry → keep the raw path */
      }
      // `worktree list` on a bare repo also emits the bare dir itself — skip it.
      if (dirReal !== bareReal) targets.push(dir);
    }
  } catch {
    /* git unavailable → fall back to exact-name matching below */
  }

  if (targets.length === 0) {
    const prefix = `${handle}-`;
    for (const e of readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith(prefix) && /^[0-9a-f]{8}$/.test(e.name.slice(prefix.length))) {
        targets.push(path.join(workspaceRoot, e.name));
      }
    }
  }

  let bytes = 0;
  for (const dir of targets) {
    // Never touch anything outside the workspace, even if the worktree registry
    // is corrupted. Measure before removal so worktree bytes count toward the
    // eviction `freed` accounting (they are not part of the bare repo's du).
    let dirReal = path.resolve(dir);
    try {
      dirReal = realpathSync(dir);
    } catch {
      continue; // already gone / unreadable — nothing to measure or remove
    }
    const rel = path.relative(rootReal, dirReal);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    bytes += await duBytes(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  bytes += await duBytes(bare);
  try {
    rmSync(bare, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  return bytes;
}

/**
 * Keep WORKSPACE_ROOT under `workspaceMaxBytes`: when the total exceeds the
 * budget, evict the least-recently-used bare repos (oldest first) with exactly
 * their own worktrees. The currently-active repo (`keepBare`) and any repo with
 * a live checkout lock (mid-fetch/mid-checkout by a concurrent review) are never
 * evicted. Bare repos are only a warm cache — the next review re-fetches them.
 * Returns bytes freed (bare + worktrees).
 */
export async function evictWorkspace({ workspaceRoot, workspaceMaxBytes = 0, keepBare = null }) {
  if (!existsSync(workspaceRoot) || !workspaceMaxBytes) return 0;
  const total = await duBytes(workspaceRoot);
  if (total <= workspaceMaxBytes) return 0;

  const repos = readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith(".git"))
    .map((e) => ({ name: e.name, dir: path.join(workspaceRoot, e.name) }))
    .filter((r) => {
      if (r.dir === keepBare) return false;
      if (activeBares.has(r.dir)) return false; // worktree in use by a running review
      // A held checkout lock means another review is mid-checkout on this repo —
      // never evict an object store that is actively being fetched into (AI
      // review, PR #12 minor).
      const handle = r.name.slice(0, -".git".length);
      return !existsSync(path.join(workspaceRoot, `.lock-${handle}`));
    })
    .sort((a, b) => statSync(a.dir).mtimeMs - statSync(b.dir).mtimeMs); // oldest first

  let freed = 0;
  for (const repo of repos) {
    if (total - freed <= workspaceMaxBytes) break;
    const size = await removeBareAndWorktrees(workspaceRoot, repo.name);
    // If the size measurement failed (du gone, dir vanished) we cannot trust the
    // budget accounting — stop here rather than cascade a full cache wipe on a
    // roll of bad measurements (AI review, PR #12 minor).
    if (size === 0) break;
    freed += size;
    log.warn(`workspace: evicted LRU bare repo ${repo.name} (workspace ${total} > ${workspaceMaxBytes} budget, freed ${size} bytes)`);
  }
  return freed;
}

/**
 * Emergency reclaim for the whole workspace (used when the volume is low):
 * gc every bare repo and evict LRU repos down to the budget.
 */
export async function maintainCheckout(config) {
  const root = config.dirs.workspaceRoot;
  if (!config.checkout?.enabled || !existsSync(root)) return { freedBytes: 0 };
  let freedBytes = 0;
  // 1) Free space immediately: evict LRU repos (bare + their worktrees) down to
  //    the workspace budget. This is the cheap big win on a full volume — gc
  //    needs scratch space, which eviction just freed, so gc must come *after*
  //    eviction (AI review, PR #12 MEDIUM). Active reviews' repos are skipped
  //    by evictWorkspace's protected set.
  freedBytes += await evictWorkspace({
    workspaceRoot: root,
    workspaceMaxBytes: config.checkout.workspaceMaxBytes,
    keepBare: null,
  });
  // 2) Then consolidate packs on the survivors, gated at the configured pack
  //    count (not 1 — don't run gc on every repo on every reclaim).
  const gate = config.checkout.gcPacks ?? 20;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.endsWith(".git")) continue;
    try {
      await maintainBare(path.join(root, e.name), { packs: gate });
    } catch (err) {
      log.warn(`workspace: gc failed for ${e.name}: ${err.message}`);
    }
  }
  return { freedBytes };
}

/**
 * Prepare a checkout of `reviewedSha` for one review. Best-effort: returns
 * `{ ok: false, reason }` on any failure instead of throwing.
 */
export async function prepareCheckout({ config, ref, sha, branch, origin }) {
  if (!config.checkout?.enabled) return { ok: false, reason: "disabled" };
  if (!sha) return { ok: false, reason: "no reviewed sha" };
  const workspaceRoot = config.dirs.workspaceRoot;
  const lock = lockDir({ workspaceRoot, ref });

  try {
    // The workspace dir may not exist yet in the pod (only jobs/ is pre-created
    // in the image); the lock + bare repos live under it, so create it first.
    mkdirSync(workspaceRoot, { recursive: true });
    // Platform-selected backend (github vs bitbucket). loadConfig always builds
    // a config.github object, so for GitHub refs we must key on the *token*
    // (absent without GITHUB_TOKEN) rather than on the object — otherwise this
    // clear refusal could never fire in production.
    const backend = backendConfig(config, ref);
    if (ref?.platform === "github" && !backend?.token) {
      return { ok: false, reason: "github backend not configured (GITHUB_TOKEN)" };
    }
    return await withLock(lock, async () => {
      // If the workspace volume is nearly full, reclaim before even trying to
      // fetch — otherwise the fetch (or a later job-dir mkdir) dies with ENOSPC
      // (issue #11). Best-effort: if we still can't free enough, the fetch below
      // simply fails and the review degrades to "no checkout".
      const minFree = config.checkout.diskMinFreeBytes;
      if (typeof minFree === "number" && (await freeBytes(workspaceRoot)) < minFree) {
        log.warn("workspace: free space low; running maintenance before checkout");
        await maintainCheckout(config);
      }
      const bare = await ensureFetched({
        baseUrl: backend.baseUrl,
        token: backend.token,
        // GitHub clones with no bot username default to x-token-auth; Bitbucket
        // keeps its username byte-for-byte (empty stays empty).
        username: checkoutUsername(ref?.platform, backend.username),
        verifyTls: backend.verifyTls,
        workspaceRoot,
        ref,
        sha,
        branch,
        origin,
        platform: ref?.platform,
        lowSpeedLimit: config.checkout?.lowSpeedLimit ?? 1024,
        lowSpeedTime: config.checkout?.lowSpeedTime ?? 30,
      });
      const wt = await ensureWorktree({ workspaceRoot, ref, sha, bare });
      await pruneWorktrees({ workspaceRoot, ref, keep: config.checkout.keep });
      // Disk maintenance (issue #11): consolidate this repo's packs before they
      // accumulate, and evict LRU repos if the workspace grew past its budget.
      // The LRU eviction's full-workspace `du` is throttled (once per interval)
      // — the statfs free-space guard above and the ENOSPC reclaim still react
      // immediately when the volume is tight.
      await maintainBare(bare, { packs: config.checkout.gcPacks ?? 20 });
      const nowEvict = Date.now();
      if (nowEvict - lastEvictionCheckAt >= EVICTION_CHECK_INTERVAL_MS) {
        lastEvictionCheckAt = nowEvict;
        await evictWorkspace({
          workspaceRoot,
          workspaceMaxBytes: config.checkout.workspaceMaxBytes ?? 0,
          keepBare: bare,
        });
      }
      // Mark this repo's checkout as in use so a concurrent/emergency eviction
      // never deletes the worktree while the review agents are running against
      // it (they hold no lock after prepareCheckout returns). Refcounted so
      // overlapping reviews on the same repo stay protected until the last
      // finish.
      protectBare(bare);
      return { ok: true, dir: wt, bare, sha };
    });
  } catch (err) {
    log.warn(`checkout unavailable for ${ref.projectKey}/${ref.repoSlug}@${String(sha).slice(0, 12)}: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

export async function cleanupCheckout({ config, ref }) {
  try {
    if (!config.checkout?.enabled) return;
    releaseBare(bareRepoDir({ workspaceRoot: config.dirs.workspaceRoot, ref }));
    await pruneWorktrees({ workspaceRoot: config.dirs.workspaceRoot, ref, keep: config.checkout.keep });
  } catch (err) {
    log.warn(`checkout cleanup failed: ${err.message}`);
  }
}

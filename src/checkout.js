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

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { log } from "./log.js";
import { backendConfig } from "./clients.js";

function git(args) {
  return spawnSync("git", args, {
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
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
 * fetch argument — never persisted in the repo config). An empty username
 * becomes the conventional `x-token-auth` (Bitbucket DC's magic token-user;
 * an empty web user is invalid). GitHub accepts a PAT as the password either
 * way.
 */
export function basicAuthUrl(raw, username, token) {
  const u = new URL(raw);
  u.username = username || "x-token-auth";
  u.password = token;
  return u.toString();
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
function repoNameOf(ref) {
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
async function ensureFetched({ baseUrl, token, username = "x-token-auth", verifyTls, workspaceRoot, ref, sha, branch, origin, platform }) {
  const bare = bareRepoDir({ workspaceRoot, ref });
  mkdirSync(path.dirname(bare), { recursive: true });

  if (!existsSync(path.join(bare, "HEAD"))) {
    throwIf(git(["init", "--bare", bare]), "git init");
    const url = origin || scmUrl({ baseUrl, projectKey: ref.projectKey, repoSlug: ref.repoSlug, platform });
    throwIf(git(["--git-dir", bare, "remote", "add", "origin", url]), "git remote add");
    if (!verifyTls) git(["--git-dir", bare, "config", "http.sslVerify", "false"]);
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (proxy) git(["--git-dir", bare, "config", "http.proxy", proxy]);
  }

  const base = ["--git-dir", bare, "fetch", "--no-tags"];
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
    const r = git(args);
    if (r.error) throw r.error;
    if (r.status === 0) {
      const check = git(["--git-dir", bare, "cat-file", "-e", `${sha}^{commit}`]);
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
function ensureWorktree({ workspaceRoot, ref, sha, bare }) {
  const wt = worktreePath({ workspaceRoot, ref, sha });

  if (existsSync(path.join(wt, ".git"))) return wt; // already a linked worktree

  rmSync(wt, { recursive: true, force: true });
  throwIf(git(["--git-dir", bare, "worktree", "add", "--detach", wt, sha]), "git worktree add");
  return wt;
}

/** Keep only the newest `keep` worktrees per repo; let git prune the rest. */
async function pruneWorktrees({ workspaceRoot, ref, keep = 3 }) {
  const bare = bareRepoDir({ workspaceRoot, ref });
  if (!existsSync(path.join(bare, "HEAD"))) return;

  const list = git(["--git-dir", bare, "worktree", "list", "--porcelain"]);
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
      git(["--git-dir", bare, "worktree", "remove", "--force", e.dir]);
    } catch {
      rmSync(e.dir, { recursive: true, force: true });
      git(["--git-dir", bare, "worktree", "prune"]);
    }
  }
  git(["--git-dir", bare, "worktree", "prune"]);
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
      const bare = await ensureFetched({
        baseUrl: backend.baseUrl,
        token: backend.token,
        username: backend.username,
        verifyTls: backend.verifyTls,
        workspaceRoot,
        ref,
        sha,
        branch,
        origin,
        platform: ref?.platform,
      });
      const wt = ensureWorktree({ workspaceRoot, ref, sha, bare });
      await pruneWorktrees({ workspaceRoot, ref, keep: config.checkout.keep });
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
    await pruneWorktrees({ workspaceRoot: config.dirs.workspaceRoot, ref, keep: config.checkout.keep });
  } catch (err) {
    log.warn(`checkout cleanup failed: ${err.message}`);
  }
}

// Platform client selection.
//
// Bitbucket and GitHub are independent, optional backends (parallel backends,
// not a mode switch). The platform is decided per review ref:
//   - ref.platform === "github"  -> GitHubClient (config.github)
//   - anything else             -> BitbucketClient (config.bitbucket)
// So the same server/CLI serves whichever backends it has credentials for.

import { BitbucketClient } from "./bitbucket.js";
import { GitHubClient } from "./github.js";

/** The config block for a ref's platform ("github" -> github, else bitbucket). */
export function backendConfig(config, ref) {
  return ref?.platform === "github" ? config.github : config.bitbucket;
}

/**
 * Build the client for a review ref. The bitbucket branch is only taken for
 * non-GitHub refs, so a GitHub-only instance (no BITBUCKET_*) still works.
 */
export function createReviewClient(config, ref) {
  if (ref?.platform === "github") {
    return new GitHubClient(config.github);
  }
  return new BitbucketClient(config.bitbucket);
}

/**
 * The bot identity used to filter our own comments out of the PR discussion /
 * screenshots context: GITHUB_USERNAME for GitHub refs, BITBUCKET_USERNAME
 * otherwise (a GitHub-only instance has an empty list -> unknown bot, the
 * heuristic length guard keeps working).
 */
export function botUsernamesOf(config, ref) {
  const name = ref?.platform === "github" ? config?.github?.username : config?.bitbucket?.username;
  return [name].filter(Boolean);
}

/**
 * The repo web URL (without /pull/N) from a GitHub REST API base, used when a
 * GitHub ref has no html_url. `https://api.github.com` ->
 * `https://github.com`; GHES/GHEC `https://git.example.com/api/v3` ->
 * `https://git.example.com`.
 */
function githubWebRoot(apiBase) {
  let u;
  try {
    u = new URL(String(apiBase || "https://api.github.com"));
  } catch {
    return "";
  }
  if (u.hostname === "api.github.com") return "https://github.com";
  const stripped = /\/api(\/v\d+)?$/.test(u.pathname) ? u.pathname.replace(/\/api(\/v\d+)?$/, "") : u.pathname;
  return `${u.protocol}//${u.host}${stripped}`.replace(/\/+$/, "");
}

/**
 * The public URL for a published comment on a PR.
 *   - GitHub: the PR's html_url plus the `#issuecomment-<id>` anchor (falls
 *     back to the repo's pull page derived from the API base when html_url is
 *     missing, so the link never falls through to a Bitbucket-style URL on the
 *     API host).
 *   - Bitbucket: the server URL plus the `?comment=<id>` deep link.
 */
export function prCommentUrl({ ref, pullRequest, client, commentId }) {
  if (ref?.platform === "github") {
    const hasHtml = Boolean(pullRequest?.htmlUrl);
    let base = String(pullRequest?.htmlUrl || githubWebRoot(client?.baseUrl)).split(/[?#]/)[0].replace(/\/$/, "");
    if (!hasHtml) {
      base = `${base}/${encodeURIComponent(ref.projectKey)}/${encodeURIComponent(
        ref.repoSlug,
      )}/pull/${ref.prId}`;
    }
    return `${base}#issuecomment-${commentId}`;
  }
  const baseUrl = client?.baseUrl || "";
  return `${baseUrl}/projects/${encodeURIComponent(ref.projectKey)}/repos/${encodeURIComponent(
    ref.repoSlug,
  )}/pull-requests/${ref.prId}?comment=${commentId}`;
}

/**
 * The "base URL" handed to report rendering. Bitbucket = the server origin
 * (used to build /projects/.../commits links); GitHub = the repo's web URL
 * (used to build /commit/<sha> links).
 */
export function reportBaseUrl({ config, ref, pullRequest }) {
  if (ref?.platform === "github") {
    return String(pullRequest?.htmlUrl || "").replace(/\/pull\/\d+.*$/i, "");
  }
  return config?.bitbucket?.baseUrl || "";
}

/**
 * Whether a review of `ref` should publish its comment, per platform:
 *   - GitHub: PUBLISH_TO_GITHUB (default off)
 *   - Bitbucket: not dry-run (PUBLISH_TO_BITBUCKET, default off)
 */
export function shouldPublish(config, ref) {
  if (ref?.platform === "github") return !!config?.job?.publishToGithub;
  return !config?.job?.dryRun;
}

/**
 * One live client per *configured* backend (for dashboard lookups). Backends
 * that are not configured are simply absent — a GitHub-only instance never
 * instantiates a BitbucketClient. Never throws.
 */
export function liveClients(config) {
  const out = {};
  try {
    if (config?.bitbucket?.baseUrl && config?.bitbucket?.token) out.bitbucket = new BitbucketClient(config.bitbucket);
  } catch {
    /* not configured — skip */
  }
  try {
    if (config?.github?.token) out.github = new GitHubClient(config.github);
  } catch {
    /* not configured — skip */
  }
  return out;
}

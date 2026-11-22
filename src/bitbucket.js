// Bitbucket Data Center REST API client (server, not Cloud).
//
// Auth: HTTP access token sent as `Authorization: Bearer <token>`.
// TLS:  set BITBUCKET verifyTls=false to accept self-signed/internal CAs.

import { log } from "./log.js";
import { bitbucketGovernor, parseRetryAfterHeader } from "./bitbucket-governor.js";

// Retry policy — internal constants, no config/env surface. Only safe reads
// are retried; the single POST write is never auto-retried (no duplicate
// comments). A 429 pauses every client via the shared governor, so the retry
// waits there rather than in a second local sleep (one window, not two).
const BITBUCKET_MAX_ATTEMPTS = 3; // initial + 2 retries
const BACKOFF_BASE_MS = 200;
const BACKOFF_MAX_MS = 2_000;
const JITTER_RATIO = 0.2;
const DETAIL_MAX_CHARS = 200;
const HTML_TITLE_MAX_CHARS = 160;

function isSafeRead(method) {
  return method === "GET" || method === "HEAD";
}

function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

/** Capped exponential backoff with a +/-20% jitter band. */
function computeBackoffMs(attempt, random = Math.random) {
  const cap = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  return Math.round(cap * (1 - JITTER_RATIO + random() * 2 * JITTER_RATIO));
}

/**
 * Keep raw HTML out of error messages (and therefore out of logs) while
 * preserving the useful title. Everything else keeps the JSON
 * `errors[0].message` extraction and is truncated to a bounded length.
 * Consumers still get the untouched raw text via `err.body`.
 */
function trimErrorDetail(text, contentType) {
  const raw = String(text ?? "");
  const ct = String(contentType ?? "");
  const leading = raw.trimStart();
  if (/\bhtml\b/i.test(ct) || /^<!doctype|^<html|^<title/i.test(leading)) {
    const match = leading.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!match) return "HTML body omitted";
    let title = match[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (!title) return "HTML body omitted";
    if (title.length > HTML_TITLE_MAX_CHARS) title = `${title.slice(0, HTML_TITLE_MAX_CHARS - 1)}…`;
    return title;
  }
  let detail = raw;
  try {
    detail = JSON.parse(raw)?.errors?.[0]?.message || raw;
  } catch {
    /* keep raw text */
  }
  if (detail.length > DETAIL_MAX_CHARS) return `${detail.slice(0, DETAIL_MAX_CHARS - 1)}…`;
  return detail;
}

export class BitbucketClient {
  constructor({ baseUrl, token, username, verifyTls = true, governor = bitbucketGovernor, sleep = governor.sleep } = {}) {
    if (!baseUrl) throw new Error("BitbucketClient: baseUrl is required");
    if (!token) throw new Error("BitbucketClient: token is required");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.username = username || "";
    this.verifyTls = verifyTls !== false;
    // One clock: request/fetchBuffer backoff uses this.sleep, which defaults to
    // the injected governor's sleep. Tests inject a single fake-clock governor
    // and don't pass a second sleep, so spacing, breaker and backoff agree.
    this.governor = governor;
    this.sleep = sleep;
    if (!this.verifyTls) {
      // Global fetch (undici) honors this at TLS connect time.
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      log.warn("TLS verification is DISABLED (VERIFY_TLS=false)");
    }
  }

  url(p) {
    if (/^https?:\/\//i.test(p)) return p;
    return `${this.baseUrl}${p.startsWith("/") ? "" : "/"}${p}`;
  }

  async request(pathname, { accept = "application/json", method = "GET", body, headers = {}, raw = false } = {}) {
    const url = this.url(pathname);
    for (let attempt = 0; attempt < BITBUCKET_MAX_ATTEMPTS; attempt++) {
      let res;
      let networkErr;
      try {
        // Every request (including each retry) is paced and held by the shared
        // process-wide breaker. getAllPages needs no changes: each page calls
        // request(), so pagination is covered here too.
        await this.governor.acquire();
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: accept,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...headers,
          },
          ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
        });
      } catch (err) {
        networkErr = err;
      }
      if (networkErr) {
        if (isSafeRead(method) && attempt < BITBUCKET_MAX_ATTEMPTS - 1) {
          await this.sleep(computeBackoffMs(attempt));
          continue;
        }
        throw networkErr; // rethrow the original error unchanged
      }

      const text = await res.text();
      if (res.ok) {
        this.governor.noteSuccess();
        if (raw) return text;
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }

      const retryAfterMs =
        res.status === 429 ? parseRetryAfterHeader(res.headers.get("retry-after"), this.governor.now()) : null;
      if (res.status === 429) this.governor.noteRateLimited(retryAfterMs); // even non-retried writes open it
      const retryable =
        isSafeRead(method) && isTransientStatus(res.status) && attempt < BITBUCKET_MAX_ATTEMPTS - 1;
      if (retryable) {
        // A 429 waits only via the breaker at the next acquire(); only 5xx
        // uses a local jittered backoff. No stacked/double wait.
        if (res.status !== 429) await this.sleep(computeBackoffMs(attempt));
        continue;
      }

      const err = new Error(
        `Bitbucket ${method} ${pathname} failed: HTTP ${res.status} - ${trimErrorDetail(
          text,
          res.headers.get("content-type"),
        )}`,
      );
      err.status = res.status;
      err.body = text;
      throw err;
    }
  }

  /**
   * Fetch an image/attachment as raw bytes (binary-safe; `request` decodes to
   * text and would corrupt PNG/JPEG payloads). Used to download screenshots
   * pasted into PR descriptions/comments via the REST attachments endpoint.
   * Returns `{ bytes, contentType }` or throws on non-2xx.
   */
  async fetchBuffer(pathname, { accept = "image/png,image/jpeg,image/gif,image/webp,*/*", timeoutMs = 30000 } = {}) {
    const url = this.url(pathname);
    for (let attempt = 0; attempt < BITBUCKET_MAX_ATTEMPTS; attempt++) {
      // A fresh controller per attempt: an aborted attempt must not poison its
      // retries (a reused controller would make every retry abort instantly).
      const controller = new AbortController();
      // Arm the deadline only AFTER the governor grants the request. Under a
      // 429 storm acquire() may sleep for the breaker's Retry-After window
      // (up to 30s); a timer armed before that wait would abort the fetch the
      // moment it is issued, burning a retry for no reason.
      let timer;
      let res;
      let buf;
      let networkErr;
      try {
        await this.governor.acquire();
        timer = setTimeout(() => controller.abort(), timeoutMs);
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: accept },
          signal: controller.signal,
        });
        buf = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        networkErr = err;
      } finally {
        clearTimeout(timer);
      }
      if (networkErr) {
        if (attempt < BITBUCKET_MAX_ATTEMPTS - 1) {
          await this.sleep(computeBackoffMs(attempt));
          continue;
        }
        throw networkErr;
      }

      if (res.ok) {
        this.governor.noteSuccess();
        return { bytes: buf, contentType: res.headers.get("content-type") || "" };
      }
      const retryAfterMs =
        res.status === 429 ? parseRetryAfterHeader(res.headers.get("retry-after"), this.governor.now()) : null;
      if (res.status === 429) this.governor.noteRateLimited(retryAfterMs);
      if (isTransientStatus(res.status) && attempt < BITBUCKET_MAX_ATTEMPTS - 1) {
        if (res.status !== 429) await this.sleep(computeBackoffMs(attempt));
        continue;
      }
      const detail = buf.subarray(0, 200).toString();
      const err = new Error(
        `Bitbucket GET ${pathname} failed: HTTP ${res.status} - ${trimErrorDetail(
          detail,
          res.headers.get("content-type"),
        )}`,
      );
      err.status = res.status;
      err.body = detail;
      throw err;
    }
  }

  /**
   * Follow Bitbucket's `values`/`isLastPage`/`nextPageStart` pagination.
   * No explicit pacing here: every page goes through request(), so each page
   * is individually paced and breaker-aware by the shared governor.
   */
  async getAllPages(pathname, { limit = 100, accept } = {}) {
    const sep = pathname.includes("?") ? "&" : "?";
    let next = `${pathname}${sep}limit=${limit}`;
    const out = [];
    let guard = 0;
    while (next && guard++ < 1000) {
      const page = await this.request(next, { accept });
      if (Array.isArray(page?.values)) out.push(...page.values);
      if (page?.isLastPage === false && page?.nextPageStart !== undefined) {
        next = `${pathname}${sep}limit=${limit}&start=${page.nextPageStart}`;
      } else {
        next = null;
      }
    }
    return out;
  }

  prBase({ projectKey, repoSlug, prId }) {
    return `/rest/api/1.0/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(
      repoSlug,
    )}/pull-requests/${encodeURIComponent(prId)}`;
  }

  getPullRequest({ projectKey, repoSlug, prId }) {
    return this.request(this.prBase({ projectKey, repoSlug, prId }));
  }

  /** Current head commit SHA of a pull request (fromRef.latestCommit → id). */
  async getPullRequestHead({ projectKey, repoSlug, prId }) {
    const pr = await this.getPullRequest({ projectKey, repoSlug, prId });
    return pr?.fromRef?.latestCommit || pr?.fromRef?.id || null;
  }

  /**
   * Head shape of a pull request: current head SHA plus the source and target
   * branch names (fromRef/toRef.displayId). Used by the dashboard header.
   * Also returns the PR author and state so the UI can show who owns the PR and
   * grey out / block re-review of merged or declined PRs.
   */
  async getPullRequestRefs({ projectKey, repoSlug, prId }) {
    const pr = await this.getPullRequest({ projectKey, repoSlug, prId });
    return {
      headSha: pr?.fromRef?.latestCommit || pr?.fromRef?.id || null,
      branch: pr?.fromRef?.displayId || null,
      targetBranch: pr?.toRef?.displayId || null,
      author: pr?.author || null,
      state: pr?.state || null, // "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED"
      closed: !!pr?.closed, // Bitbucket sets closed=true for merged/declined
    };
  }

  /**
   * The PR's own commits, newest-first (Bitbucket DC returns them in this
   * order). This is the reliable way to find "new commits since a review" —
   * compare/commits returns empty when the branch was force-pushed/rebuilt.
   */
  async getPullRequestCommits({ projectKey, repoSlug, prId }) {
    const p = `${this.prBase({ projectKey, repoSlug, prId })}/commits`;
    const values = await this.getAllPages(p, { limit: 100 });
    return values.map((c) => ({
      id: c.id,
      message: c.message || "",
      author: c.author?.emailAddress || c.author?.displayName || c.author?.name || null,
      timestamp: c.committerTimestamp ?? c.authorTimestamp ?? null,
    }));
  }

  /** Commits that landed in `to` but not in `from` (both SHA-1 refs). */
  async getCommitsBetween({ projectKey, repoSlug }, from, to) {
    if (!from || !to || from === to) return [];
    const p = `/rest/api/1.0/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(
      repoSlug,
    )}/compare/commits?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const values = await this.getAllPages(p, { limit: 100 });
    return values.map((c) => ({
      id: c.id,
      message: c.message || "",
      author: c.author?.emailAddress || c.author?.displayName || c.author?.name || null,
      timestamp: c.committerTimestamp ?? c.authorTimestamp ?? null,
    }));
  }

  getUnifiedDiff({ projectKey, repoSlug, prId, contextLines = 3 }) {
    const p = `${this.prBase({ projectKey, repoSlug, prId })}/diff?contextLines=${contextLines}`;
    return this.request(p, { accept: "text/plain", raw: true });
  }

  getChangedFiles({ projectKey, repoSlug, prId }) {
    return this.getAllPages(`${this.prBase({ projectKey, repoSlug, prId })}/changes`, { limit: 100 });
  }

  /** Raw file text from a repo at a ref (`at` = SHA-1 or branch). Returns null on 404. */
  async getFileRaw({ projectKey, repoSlug, path: filePath, at }) {
    const encoded = filePath.split("/").map(encodeURIComponent).join("/");
    const query = at ? `?at=${encodeURIComponent(at)}` : "";
    try {
      return await this.request(
        `/rest/api/1.0/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(
          repoSlug,
        )}/raw/${encoded}${query}`,
        { accept: "text/plain", raw: true },
      );
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  getComments({ projectKey, repoSlug, prId }) {
    return this.getAllPages(
      `/rest/api/1.0/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(
        repoSlug,
      )}/pull-requests/${encodeURIComponent(prId)}/comments?path=`,
      { limit: 100 },
    ).catch(() => []);
  }

  /**
   * Activity feed of a pull request (events like OPENED, COMMENTED, REVERTED,
   * MERGED, ...). This is the reliable way to read a PR's discussion: the
   * `comments` endpoint requires a per-file `path`, whereas the activity feed
   * carries top-level comments plus their replies (nested under
   * `comment.comments`) regardless of path.
   */
  getPullRequestActivities({ projectKey, repoSlug, prId }) {
    return this.getAllPages(`${this.prBase({ projectKey, repoSlug, prId })}/activities`, { limit: 100 });
  }

  async postPullRequestComment({ projectKey, repoSlug, prId, text, parentId }) {
    const body = { text };
    if (parentId !== undefined && parentId !== null) body.parent = { id: parentId };
    const comment = await this.request(`${this.prBase({ projectKey, repoSlug, prId })}/comments`, {
      method: "POST",
      body,
    });
    return comment;
  }
}

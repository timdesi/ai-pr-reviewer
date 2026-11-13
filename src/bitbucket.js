// Bitbucket Data Center REST API client (server, not Cloud).
//
// Auth: HTTP access token sent as `Authorization: Bearer <token>`.
// TLS:  set BITBUCKET verifyTls=false to accept self-signed/internal CAs.

import { log } from "./log.js";

export class BitbucketClient {
  constructor({ baseUrl, token, username, verifyTls = true }) {
    if (!baseUrl) throw new Error("BitbucketClient: baseUrl is required");
    if (!token) throw new Error("BitbucketClient: token is required");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.username = username || "";
    this.verifyTls = verifyTls !== false;
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
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        detail = JSON.parse(text)?.errors?.[0]?.message || text;
      } catch {
        /* keep raw text */
      }
      const err = new Error(`Bitbucket ${method} ${pathname} failed: HTTP ${res.status} - ${detail}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    if (raw) return text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: accept },
        signal: controller.signal,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        const err = new Error(`Bitbucket GET ${pathname} failed: HTTP ${res.status}`);
        err.status = res.status;
        err.body = buf.subarray(0, 200).toString();
        throw err;
      }
      return { bytes: buf, contentType: res.headers.get("content-type") || "" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Follow Bitbucket's `values`/`isLastPage`/`nextPageStart` pagination. */
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

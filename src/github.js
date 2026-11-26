// GitHub REST API client (github.com and GitHub Enterprise Server).
//
// Auth: any token the API accepts sent as `Authorization: Bearer <token>` —
// a classic PAT or a GitHub App installation token. The client is token-
// agnostic, so swapping PAT -> installation token later needs no code change.
//
// The pipeline, dashboard, discussion and screenshots modules consume the same
// normalized PR / activity shapes the Bitbucket client produces, so this client
// maps every GitHub API response into that shape. Bitbucket-specific fields
// that have no GitHub equivalent are null (never thrown away silently).
//
// TLS: `VERIFY_TLS=false` accepts self-signed/internal CAs (GHES).

import { log } from "./log.js";

const USER_AGENT = "ai-pr-reviewer/1.0 (github adapter)";
const API_VERSION = "2022-11-28";

/** AbortError → explicit timeout error (deadline is ours alone; see request()). */
function githubTimeoutError(method, pathname, timeoutMs, cause) {
  const err = new Error(`GitHub ${method} ${pathname} timed out after ${timeoutMs}ms (no response)`);
  err.timedOut = true;
  if (cause) err.cause = cause;
  return err;
}

/** Bitbucket-like user object ({slug,name,displayName,emailAddress} + login). */
function normalizeUser(u = {}) {
  const login = u?.login ?? u?.name ?? u?.slug ?? null;
  return {
    slug: login,
    name: login,
    displayName: login,
    emailAddress: u?.email ?? null,
    login,
  };
}

function normalizeRepo(repo = {}, fallback = {}) {
  const owner = repo?.owner?.login ?? fallback.owner ?? null;
  const name = repo?.name ?? fallback.repo ?? null;
  return {
    slug: name,
    project: { key: owner, name },
    cloneUrl: repo?.clone_url ?? null,
    htmlUrl: repo?.html_url ?? null,
  };
}

/** Map a GitHub pull-request files list entry onto Bitbucket's /changes shape. */
function mapChangeFile(f) {
  const filename = f?.filename ?? "";
  const prev = f?.previous_filename ?? null;
  const status = String(f?.status || "modified").toLowerCase();
  const type =
    { added: "ADDED", removed: "DELETED", modified: "MODIFIED", renamed: "RENAMED", copied: "COPIED", unchanged: "UNCHANGED" }[status] || "MODIFIED";
  const out = { type, path: { toString: filename }, srcPath: null };
  // Renamed/copied files carry the old name exactly like Bitbucket MOVE entries
  // (source/destination), so context.js/grounding.js show pre-renamed paths too.
  if (status === "renamed" || status === "copied") {
    out.srcPath = { toString: prev || filename };
    out.source = { toString: prev || filename };
    out.destination = { toString: filename };
  }
  out.additions = f?.additions ?? null;
  out.deletions = f?.deletions ?? null;
  return out;
}

export class GitHubClient {
  constructor({ baseUrl = "https://api.github.com", token, username, verifyTls = true, requestTimeoutMs = 120_000 } = {}) {
    if (!token) throw new Error("GitHubClient: token is required");
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.token = token;
    this.username = username || "";
    this.verifyTls = verifyTls !== false;
    // Deadline per REST call (fetch + body read), parity with BitbucketClient. A
    // lost/never-returning response must not wedge a review in a running stage.
    this.requestTimeoutMs = requestTimeoutMs;
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

  /** True when an absolute URL belongs to the configured API host (token safe to send). */
  urlBelongs(p) {
    try {
      const host = new URL(this.baseUrl).host;
      return new URL(p).host === host;
    } catch {
      return false;
    }
  }

  async request(pathname, { accept = "application/vnd.github+json", method = "GET", body, headers = {}, raw = false, headersOut = null, timeoutMs = this.requestTimeoutMs } = {}) {
    const url = this.url(pathname);
    // Never send the bearer token to a foreign origin: an absolute URL that is
    // not on the configured API host is refused up front (mirror of the
    // getAllPages Link-header guard). All current callers pass relative paths
    // or already-verified next URLs.
    if (/^https?:\/\//i.test(url) && !this.urlBelongs(url)) {
      let foreign;
      try {
        foreign = new URL(url).host;
      } catch {
        foreign = "<unparseable>";
      }
      throw new Error(`github client refuses a foreign host "${foreign}" (configured API host ${new URL(this.baseUrl).host})`);
    }
    // Deadline covers the fetch AND the body read: a response that never arrives
    // (or stalls mid-stream) must not hang the review forever. No other consumer
    // aborts these requests, so an AbortError means we hit the timeout.
    const controller = new AbortController();
    // timeoutMs <= 0 disables the deadline.
    let timer;
    if (timeoutMs > 0) timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: accept,
          "User-Agent": USER_AGENT,
          "X-GitHub-Api-Version": API_VERSION,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === "AbortError") throw githubTimeoutError(method, pathname, timeoutMs, err);
      throw err;
    }

    if (headersOut && typeof res.headers?.get === "function") {
      const link = res.headers.get("link");
      if (link) headersOut.link = link;
    }

    let text;
    try {
      text = await res.text();
    } catch (err) {
      if (err?.name === "AbortError") throw githubTimeoutError(method, pathname, timeoutMs, err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = text;
      try {
        detail = JSON.parse(text)?.message || text;
      } catch {
        /* keep raw text */
      }
      const err = new Error(`GitHub ${method} ${pathname} failed: HTTP ${res.status} - ${detail}`);
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
   * text and would corrupt PNG/JPEG payloads). Used by the PR-screenshots step
   * for images pasted into descriptions/comments. Returns `{ bytes,
   * contentType }` or throws on non-2xx. The token is only sent to the
   * configured API host; external image CDNs are fetched anonymously.
   */
  async fetchBuffer(pathname, { accept = "image/png,image/jpeg,image/gif,image/webp,*/*", timeoutMs = 30000 } = {}) {
    const url = this.url(pathname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Accept: accept, "User-Agent": USER_AGENT };
      if (this.urlBelongs(url)) headers.Authorization = `Bearer ${this.token}`;
      const res = await fetch(url, { headers, signal: controller.signal });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        const err = new Error(`GitHub GET ${pathname} failed: HTTP ${res.status}`);
        err.status = res.status;
        err.body = buf.subarray(0, 200).toString();
        throw err;
      }
      return { bytes: buf, contentType: res.headers.get("content-type") || "" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Follow GitHub's Link-header pagination (`rel="next"`), collecting a plain array. */
  async getAllPages(pathname, { per_page = 100, accept } = {}) {
    const sep = pathname.includes("?") ? "&" : "?";
    const out = [];
    const headersOut = {};
    let next = `${pathname}${sep}per_page=${per_page}`;
    let guard = 0;
    while (next && guard++ < 1000) {
      // Clear per iteration: a page without a `rel="next"` link must end the
      // loop, not reuse the previous page's captured Link header.
      headersOut.link = null;
      const page = await this.request(next, { accept, headersOut });
      if (Array.isArray(page)) out.push(...page);
      const link = headersOut.link || "";
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      const nextUrl = m ? m[1] : null;
      // Never follow a Link header that points off our API host: request()
      // always sends the bearer token, and it must not reach a foreign origin
      // (a hostile/misbehaving GHES, or a MITM'd Link header). Drop pagination
      // rather than leak credentials.
      next = nextUrl && this.urlBelongs(nextUrl) ? nextUrl : null;
    }
    return out;
  }

  // projectKey === GitHub owner; repoSlug === GitHub repo; prId === PR number.
  prBase({ projectKey, repoSlug, prId }) {
    return `/repos/${encodeURIComponent(projectKey)}/${encodeURIComponent(repoSlug)}/pulls/${encodeURIComponent(prId)}`;
  }

  /** Normalize a GitHub PR payload onto the Bitbucket PR shape the pipeline consumes. */
  normalizePullRequest(pr = {}, { projectKey, repoSlug, prId } = {}) {
    const head = pr?.head || {};
    const base = pr?.base || {};
    const merged = !!pr?.merged;
    const state = merged
      ? "MERGED"
      : String(pr?.state || "").toUpperCase() === "OPEN"
        ? "OPEN"
        : "CLOSED";
    return {
      id: pr?.number ?? prId,
      title: pr?.title ?? "",
      description: pr?.body ?? "",
      state,
      draft: !!pr?.draft,
      // A closed (or merged) GitHub PR can no longer be reviewed fresh.
      closed: state !== "OPEN",
      fromRef: {
        id: head.sha || null,
        latestCommit: head.sha || null,
        displayId: head.ref || null,
        repository: normalizeRepo(head?.repo, { owner: projectKey, repo: repoSlug }),
      },
      toRef: {
        id: base.sha || null,
        latestCommit: base.sha || null,
        displayId: base.ref || null,
        repository: normalizeRepo(base?.repo, { owner: projectKey, repo: repoSlug }),
      },
      author: { user: normalizeUser(pr?.user) },
      htmlUrl: pr?.html_url || null,
      _raw: pr,
    };
  }

  async getPullRequest({ projectKey, repoSlug, prId }) {
    const pr = await this.request(this.prBase({ projectKey, repoSlug, prId }));
    return this.normalizePullRequest(pr, { projectKey, repoSlug, prId });
  }

  /** Current head commit SHA of a pull request (head.sha). */
  async getPullRequestHead({ projectKey, repoSlug, prId }) {
    const pr = await this.getPullRequest({ projectKey, repoSlug, prId });
    return pr?.fromRef?.latestCommit || pr?.fromRef?.id || null;
  }

  /**
   * Head shape of a pull request: current head SHA plus source/target branch
   * names, author, state and closed flag — for the dashboard header.
   */
  async getPullRequestRefs({ projectKey, repoSlug, prId }) {
    const pr = await this.getPullRequest({ projectKey, repoSlug, prId });
    return {
      headSha: pr?.fromRef?.latestCommit || pr?.fromRef?.id || null,
      branch: pr?.fromRef?.displayId || null,
      targetBranch: pr?.toRef?.displayId || null,
      author: pr?.author || null,
      state: pr?.state || null, // "OPEN" | "MERGED" | "CLOSED"
      closed: !!pr?.closed,
    };
  }

  /**
   * The PR's own commits, newest-first. GitHub serves them in commit order
   * (oldest first), so we sort explicitly by committer timestamp — relying on
   * the wire order could invert the "new commits since a review" slice when
   * commits share a timestamp.
   */
  async getPullRequestCommits({ projectKey, repoSlug, prId }) {
    const p = `${this.prBase({ projectKey, repoSlug, prId })}/commits`;
    const values = await this.getAllPages(p, { per_page: 100 });
    return values
      .map((c) => ({
        id: c?.sha ?? null,
        message: c?.commit?.message || "",
        author: c?.author?.login || c?.commit?.author?.name || null,
        timestamp: c?.commit?.committer?.date ? Date.parse(c.commit.committer.date) : null,
      }))
      // Newest first; null timestamps (rare) sort last. Stable, so equal
      // timestamps keep the API's relative order.
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }

  /** Commits that landed in `from` but not in `to` (both SHA refs). */
  async getCommitsBetween({ projectKey, repoSlug }, from, to) {
    if (!from || !to || from === to) return [];
    const p = `/repos/${encodeURIComponent(projectKey)}/${encodeURIComponent(repoSlug)}/compare/${encodeURIComponent(
      from,
    )}...${encodeURIComponent(to)}`;
    const page = await this.request(p);
    const commits = Array.isArray(page?.commits) ? page.commits : [];
    return commits.map((c) => ({
      id: c?.sha ?? null,
      message: c?.commit?.message || "",
      author: c?.author?.login || c?.commit?.author?.name || null,
      timestamp: c?.commit?.committer?.date ? Date.parse(c.commit.committer.date) : null,
    }));
  }

  /**
   * Unified diff text of the PR. GitHub controls the context size (roughly 3
   * context lines) — the `contextLines` option is accepted for interface parity
   * with Bitbucket and otherwise ignored.
   */
  getUnifiedDiff({ projectKey, repoSlug, prId, contextLines = 3 }) {
    void contextLines;
    return this.request(this.prBase({ projectKey, repoSlug, prId }), {
      accept: "application/vnd.github.v3.diff",
      raw: true,
    });
  }

  /** Changed files mapped onto Bitbucket's `/changes` shape. */
  async getChangedFiles({ projectKey, repoSlug, prId }) {
    const p = `${this.prBase({ projectKey, repoSlug, prId })}/files`;
    const values = await this.getAllPages(p, { per_page: 100 });
    return values.map(mapChangeFile);
  }

  /**
   * Raw file text from a repo at a ref (`at` = SHA or branch). Returns null on
   * 404 (used for the repo's AGENTS.md at the reviewed head SHA).
   */
  async getFileRaw({ projectKey, repoSlug, path: filePath, at }) {
    if (typeof filePath !== "string" || !filePath) return null;
    const encoded = filePath.split("/").map(encodeURIComponent).join("/");
    const query = at ? `?ref=${encodeURIComponent(at)}` : "";
    try {
      return await this.request(
        `/repos/${encodeURIComponent(projectKey)}/${encodeURIComponent(repoSlug)}/contents/${encoded}${query}`,
        { accept: "application/vnd.github.v3.raw", raw: true },
      );
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /** Top-level PR comments (issue comments), flattened to comment-like objects. */
  async getComments({ projectKey, repoSlug, prId }) {
    const p = `/repos/${encodeURIComponent(projectKey)}/${encodeURIComponent(repoSlug)}/issues/${encodeURIComponent(prId)}/comments`;
    const comments = await this.getAllPages(p, { per_page: 100 }).catch((err) => {
      // A 5xx / rate-limit must not look like "no comments" — log it so the
      // reason is discoverable. getComments is non-fatal by contract, so we
      // still fall back to an empty list.
      log.warn(`github.getComments failed for ${projectKey}/${repoSlug}#${prId}: ${err?.message || err}`);
      return [];
    });
    return comments.map((c) => ({
      id: c?.id ?? null,
      text: c?.body ?? "",
      author: normalizeUser(c?.user),
      createdDate: c?.created_at ? Date.parse(c.created_at) : null,
      parent: null,
      deleted: false,
    }));
  }

  /**
   * Activity feed of a pull request, synthesized in Bitbucket's shape so the
   * shared discussion module works unchanged: every non-empty issue comment,
   * review, and inline review comment becomes one `COMMENTED` activity carrying
   * a Bitbucket-like `comment` (`{id,text,author,createdDate}`). GitHub has no
   * reply-parenting between issue comments, so `comments` stays empty per item.
   */
  async getPullRequestActivities({ projectKey, repoSlug, prId }) {
    const enc = encodeURIComponent;
    const [issueComments, reviews, reviewComments] = await Promise.all([
      this.getAllPages(`/repos/${enc(projectKey)}/${enc(repoSlug)}/issues/${enc(prId)}/comments`),
      this.getAllPages(`/repos/${enc(projectKey)}/${enc(repoSlug)}/pulls/${enc(prId)}/reviews`),
      this.getAllPages(`/repos/${enc(projectKey)}/${enc(repoSlug)}/pulls/${enc(prId)}/comments`),
    ]);
    const out = [];
    const push = (id, text, user, created) => {
      if (!text || typeof text !== "string" || !text.trim()) return;
      out.push({
        action: "COMMENTED",
        commentAction: null,
        comment: {
          id: id ?? null,
          text,
          author: normalizeUser(user),
          createdDate: created ? Date.parse(created) : null,
          comments: [],
        },
      });
    };
    for (const c of issueComments || []) push(c?.id, c?.body, c?.user, c?.created_at);
    for (const r of reviews || []) push(r?.id, r?.body, r?.user, r?.submitted_at);
    for (const c of reviewComments || []) push(c?.id, c?.body, c?.user, c?.created_at);
    return out;
  }

  /**
   * Post a PR-level comment. On GitHub these are "issue comments" on the PR
   * (`/issues/{n}/comments`). `parentId` is accepted for interface parity with
   * Bitbucket but ignored — GitHub has no threaded replies on issue comments.
   */
  async postPullRequestComment({ projectKey, repoSlug, prId, text, parentId }) {
    void parentId;
    const comment = await this.request(
      `/repos/${encodeURIComponent(projectKey)}/${encodeURIComponent(repoSlug)}/issues/${encodeURIComponent(prId)}/comments`,
      { method: "POST", body: { body: String(text ?? "") } },
    );
    return comment;
  }
}

// Configuration loading and validation.
//
// Values come from process.env. When the CLI is run without `--env-file`,
// we also load `dev/.env` ourselves (without overriding real environment
// variables) so `node src/cli.js` works out of the box.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { readModelAssignments } from "./models.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Minimal dotenv parser: KEY=VALUE, `#` comments, no expansion. */
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function str(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === null ? fallback : String(v).trim();
}

function int(name, fallback) {
  const v = str(name);
  if (v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function num(name, fallback) {
  const v = str(name);
  if (v === "") return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const v = str(name).toLowerCase();
  if (v === "") return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function list(name) {
  return str(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parses a JSON-typed env value; malformed/non-object/empty falls back to
 * `fallback`. Kept object-only: ui.modelOverrides is read as a plain map, so a
 * JSON array or `null` (valid JSON but wrong shape) degrades to the default
 * rather than silently becoming an unusable config value (AI review #18 minor). */
function json(name, fallback) {
  const v = str(name);
  if (v === "") return fallback;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && !Buffer.isBuffer(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

/**
 * AUTO_REVIEW_OFF_REPOS: comma-separated `PROJECT/repo-slug` entries whose
 * automatic review trigger (reviewer added / PR opened with a reviewer / draft
 * marked ready) is disabled. Repositories not listed auto-review by default.
 * Keys are lowercased; throws on badly-shaped entries so a typo can't quietly
 * enable auto-reviews on the wrong repo.
 */
export function parseAutoReviewOffRepos(text) {
  const raw = String(text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = new Set();
  for (const entry of raw) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(entry)) {
      throw new Error(`AUTO_REVIEW_OFF_REPOS entry "${entry}" must be PROJECT/repo-slug, e.g. ACME/acme-app`);
    }
    out.add(entry.toLowerCase());
  }
  return out;
}

/**
 * REVIEW_ON_REVIEWER_ADDED_SKIP: comma-separated `SOURCE>TARGET` branch pairs whose
 * pull requests never start a reviewer-added review, e.g. `develop>release/*`. `*`
 * matches any characters; matching is case-insensitive. Throws on invalid input.
 */
export function parseReviewerSkipBranchPairs(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(">").map((p) => p.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`REVIEW_ON_REVIEWER_ADDED_SKIP entry "${item}" must be SOURCE>TARGET, e.g. develop>release/*`);
      }
      return { source: parts[0], target: parts[1] };
    });
}

/**
 * Reviewer D (language/i18n) activation patterns. Reviewer D runs only when a
 * PR's changed file path matches one of these regexes. Default: Angular/i18n
 * locale JSON (`<dir>/i18n/*.json`) and gettext catalogs (`.po`/`.pot`).
 * Override with TRANSLATION_PATH_PATTERNS (comma-separated regexes); a
 * malformed override regex is skipped, never fatal.
 */
export const DEFAULT_TRANSLATION_PATTERNS = ["(^|/)i18n/.+\\.json$", "\\.po$", "\\.pot$"];

/**
 * Portable model-id → display-name overrides for the dashboard. Values here are
 * the public/example gateway names only; deployment-specific names are injected
 * via MODEL_OVERRIDES_JSON at runtime (see `ui.modelOverrides`), so `ui/app.js`
 * stays byte-identical for every deployment (zero-divergence, issues #14/#16).
 */
export const DEFAULT_MODEL_OVERRIDES = {
  "myprovider/discretestack-stable-fast": "DiscreteStack Stable Fast",
  "myprovider/discretestack-stable": "DiscreteStack Stable",
  "llmgw-anthropic/claude-haiku-5-5": "Claude Haiku 5.5",
  "llmgw/claude-haiku-5-5": "Claude Haiku 5.5",
  "llmgw-gpt/gpt-6-luna": "GPT-6 Luna",
  "llmgw-openai/deepseek-v4-pro": "DeepSeek V4 Pro",
  "llmgw-msp/glm-52": "GLM-5 (MSP)",
  "llmgw-msp/DeepSeek-V4-Flash": "DeepSeek V4 Flash (MSP)",
  "llmgw-msp/Qwen-27B": "Qwen 27B (MSP)",
  "llmgw-deepseek-flash/deepseek-v4-flash": "DeepSeek V4 Flash",
};

export function parsePathPatterns(text, fallback = DEFAULT_TRANSLATION_PATTERNS) {
  const raw = String(text ?? "").trim();
  const list = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [...fallback];
  const out = [];
  for (const p of list) {
    try {
      out.push(new RegExp(p, "i"));
    } catch {
      /* skip a malformed override pattern; never abort a review over it */
    }
  }
  return out;
}

/** True when any changed path matches any translation pattern. */
export function isTranslationReview(changedPaths, patterns) {
  const paths = Array.isArray(changedPaths) ? changedPaths : [];
  const pats = Array.isArray(patterns) ? patterns : [];
  return pats.some((re) => paths.some((p) => re.test(String(p))));
}

export function loadConfig({ envFile } = {}) {
  loadDotEnv(envFile || path.join(projectRoot, ".env"));

  const config = {
    projectRoot,
    bitbucket: {
      baseUrl: str("BITBUCKET_BASE_URL").replace(/\/+$/, ""),
      token: str("BITBUCKET_API_TOKEN"),
      username: str("BITBUCKET_USERNAME"),
      // Webhook signature secret (Bitbucket DC). Empty = signatures not checked.
      webhookSecret: str("BITBUCKET_WEBHOOK_SECRET"),
      verifyTls: bool("VERIFY_TLS", true),
      // HTTP deadline per REST call. A dead/lossy proxy must never wedge a
      // review in a "running" stage forever with a response that never arrives.
      requestTimeoutMs: int("API_REQUEST_TIMEOUT_MS", 120000),
    },
    github: {
      // GitHub REST API base. Defaults to github.com's API; for GitHub
      // Enterprise Server set e.g. https://git.example.com/api/v3 (no slash).
      // An explicitly empty GITHUB_API_BASE_URL= is treated as unset (the
      // github.com default applies) — empty would break every API call.
      baseUrl: (str("GITHUB_API_BASE_URL") || "https://api.github.com").replace(/\/+$/, ""),
      // Auth starts with a classic PAT; GitHub App installation tokens work
      // unchanged (the client only sends `Authorization: Bearer <token>`).
      token: str("GITHUB_TOKEN"),
      // Bot login for this reviewer (used to filter our own comments out of the
      // PR discussion context). Empty = unknown bot identity.
      username: str("GITHUB_USERNAME"),
      // Webhook signature secret (HMAC-SHA256, `X-Hub-Signature-256`). Empty =
      // signatures are not checked.
      webhookSecret: str("GITHUB_WEBHOOK_SECRET"),
      verifyTls: bool("VERIFY_TLS", true),
      // Same per-call deadline as Bitbucket (API_REQUEST_TIMEOUT_MS).
      requestTimeoutMs: int("API_REQUEST_TIMEOUT_MS", 120000),
    },
    job: {
      // Safe default: never post to Bitbucket unless explicitly enabled.
      dryRun: !bool("PUBLISH_TO_BITBUCKET", false),
      // Independent GitHub publish gate: PUBLISH_TO_GITHUB=1 posts to GitHub
      // even on a Bitbucket-only pipeline (and vice versa).
      publishToGithub: bool("PUBLISH_TO_GITHUB", false),
      // Authorization allowlist: who may trigger (and who, being added as a PR
      // reviewer, starts an auto-review). Empty = anyone.
      allowedReviewerUsers: list("ALLOWED_REVIEWER_USERS"),
      // Auto-review opt-out: repositories where the automatic trigger
      // (reviewer added / PR opened with a reviewer / draft marked ready) is
      // disabled. Not listed = ON by default.
      autoReviewOffRepos: parseAutoReviewOffRepos(str("AUTO_REVIEW_OFF_REPOS")),
      // Auto-review opt-out for GitHub PRs (GITHUB_AUTO_REVIEW_OFF_REPOS).
      // Kept separate from AUTO_REVIEW_OFF_REPOS: GitHub `owner/repo` and
      // Bitbucket `PROJECT/repo` share the same string shape, so a shared list
      // could not tell the two platforms apart.
      githubAutoReviewOffRepos: parseAutoReviewOffRepos(str("GITHUB_AUTO_REVIEW_OFF_REPOS")),
      // Branch pairs whose pull requests never start a reviewer-added review (merge PRs).
      reviewOnReviewerAddedSkip: parseReviewerSkipBranchPairs(str("REVIEW_ON_REVIEWER_ADDED_SKIP")),
    },
    models: {
      reviewerA: str("REVIEWER_MODEL_A"),
      reviewerB: str("REVIEWER_MODEL_B"),
      reviewerC: str("REVIEWER_MODEL_C"),
      reviewerD: str("REVIEWER_MODEL_D") || null,
      consensus: str("CONSENSUS_MODEL"),
      // Persisted runtime overrides (UI-switched models), written by the server
      // onto the PVC. Default: next to the jobs dir as a dot-file.
      settingsFile: null,
    },
    contextGen: {
      // Model that drafts/refines curated context files from the dashboard's
      // "Context" page (the `context-gen` agent). The draft lands in the editor
      // as a reviewable revision — never written to disk automatically, because
      // curated context is authoritative to reviewers. Unset/empty falls back to
      // the consensus model, then reviewer A; with none configured the
      // "Generate with AI" action is disabled.
      model: str("CONTEXT_GEN_MODEL"),
      timeoutSeconds: int("CONTEXT_GEN_TIMEOUT_SECONDS", 300),
    },
    opencode: {
      bin: str("OPENCODE_BIN", "opencode"),
      maxRetries: int("AGENT_MAX_RETRIES", 2),
      reviewerTimeoutSeconds: int("REVIEWER_TIMEOUT_SECONDS", 900),
      consensusTimeoutSeconds: int("CONSENSUS_TIMEOUT_SECONDS", 900),
      // Default: normal mode — `opencode run` connects to the shared background
      // service (no per-run server boot, no startup race). Set
      // OPENCODE_STANDALONE=1 to opt back into a private server per run when
      // strict isolation / fresh credentials are needed (historically a stale
      // shared service cached an expired subscription key).
      standalone: bool("OPENCODE_STANDALONE", false),
      // Our agents are loaded from here (OPENCODE_CONFIG_DIR) whatever the cwd;
      // opencode only finds `.opencode/` relative to its own project otherwise.
      agentDir: path.resolve(projectRoot, str("OPENCODE_AGENT_DIR", ".opencode")),
    },
    costs: {
      // Display currency for the dashboard cost columns. The numeric prices are
      // read from the opencode config `cost` metadata (per million tokens).
      currency: str("COST_CURRENCY", "€"),
      // Explicit model-price source (opencode.json). Default: HOME config,
      // then dev/docker/opencode.json.template.
      configPath: str("OPENCODE_CONFIG"),
    },
    jira: {
      // Ticket context for reviews (see src/jira.js). Kept disabled by default:
      // only enabled when a Jira REST base URL is reachable from where the
      // pipeline runs (the pod currently has no route to jira; egress is
      // SSO-walled — see the module header).
      enabled: bool("JIRA_ENABLED", false),
      // e.g. https://jira.example.com/tracker01 (no trailing slash needed)
      baseUrl: str("JIRA_BASE_URL").replace(/\/+$/, ""),
      token: str("JIRA_API_TOKEN"),
      maxTickets: int("JIRA_MAX_TICKETS", 5),
    },
    git: {
      fetchDepth: int("GIT_FETCH_DEPTH", 200),
      maxDiffBytes: int("MAX_DIFF_BYTES", 300_000),
    },
    dirs: {
      jobs: path.resolve(projectRoot, str("JOBS_DIR", "./jobs")),
      workspaceRoot: path.resolve(projectRoot, str("WORKSPACE_ROOT", "./data/workspaces")),
      // Per-repository project-context files, `<PROJECT>-<repo>.md` (fallback `<repo>.md`).
      contexts: path.resolve(projectRoot, str("REVIEW_CONTEXT_DIR", "./contexts")),
      // Scratch root for the vision (screenshot-transcription) working dir. It
      // must stay INSIDE the project root: `opencode run` resolves its session's
      // project by walking up from the child cwd, and a bare /tmp scratch dir
      // can be taken for an agent-less project of its own — making the shared
      // server miss `.opencode/agents/pr-vision.md` and fail every image with
      // "Agent not found: pr-vision" (intermittent all-screenshots-unreadable).
      visionScratch: path.resolve(projectRoot, str("VISION_SCRATCH_DIR", "./data/vision-scratch")),
    },
    review: {
      // Additionally fetch AGENTS.md from the reviewed repo (at the head SHA)
      // and attach it as project context. Silent when the repo has none.
      fetchRepoContext: bool("FETCH_REPO_CONTEXT", true),
      // Attach the PR's recent human comments/replies ("author clarifications")
      // to reviewer + consensus context, so re-reviews don't re-raise findings
      // the author already answered. Additive + non-fatal (see src/discussion.js).
      fetchPrDiscussion: bool("FETCH_PR_DISCUSSION", true),
      // Read screenshots pasted into the PR description/comments (Bitbucket
      // `attachment:` refs or direct image URLs), transcribe each with a
      // vision-capable model, and attach the text to reviewer + consensus
      // context instead of leaving reviewers blind to the images. Additive +
      // non-fatal (see src/prImages.js). Unreadable images become a short
      // "screenshots not viewable — ask the author" note, never an error.
      fetchPrImages: bool("FETCH_PR_IMAGES", true),
      // Vision model used for the screenshot transcription. Must be an
      // image-capable opencode model id (declared `capabilities.input` in the
      // opencode config; the Models dialog enforces it). Routing/auth come from
      // the opencode agent config (docker/opencode.json.template) — never from a
      // literal provider name here. Unset/empty disables screenshot
      // transcription entirely (no downloads, no block, no vision cost row).
      visionModel: str("VISION_MODEL"),
      // Safety caps for the image step: max images transcribed per review, max
      // bytes per download, and per-call timeouts.
      visionMaxImages: num("VISION_MAX_IMAGES", 6),
      visionMaxImageBytes: num("VISION_MAX_IMAGE_BYTES", 10 * 1024 * 1024),
      visionFetchTimeoutMs: num("VISION_FETCH_TIMEOUT_MS", 30000),
      visionCallTimeoutMs: num("VISION_CALL_TIMEOUT_MS", 60000),
      // Age floor for sweeping stale per-image scratch dirs out of
      // `dirs.visionScratch`. A transcription's temp dir lives at most one
      // `visionCallTimeoutMs` window, so a sweep only ever touches dirs far
      // older than a live in-flight call (never a concurrent review's). The
      // default (1 h) is a deliberate safety margin; 0 disables the sweep.
      visionScratchMaxAgeMs: num("VISION_SCRATCH_MAX_AGE_MS", 60 * 60 * 1000),
      // Public-comment gate: findings below either threshold are listed
      // compactly under "Minor" and do not drive the merge verdict.
      commentMinSeverity: str("COMMENT_MIN_SEVERITY", "MEDIUM").toUpperCase(),
      commentMinConfidence: num("COMMENT_MIN_CONFIDENCE", 0.5),
      // Reviewer D (language/i18n) path patterns: which changed files mark a
      // PR as a translation/content PR so reviewer D joins the review. Empty
      // TRANSLATION_PATH_PATTERNS = the default i18n/gettext patterns.
      translationPathPatterns: parsePathPatterns(str("TRANSLATION_PATH_PATTERNS")),
      // Reviewer concurrency knob: 0/unset = run all active reviewers in
      // parallel (the default). 1 = run them one at a time (for small hosts
      // like the Oracle Always-Free VM); N = at most N at a time.
      parallelism: int("REVIEWER_PARALLELISM", 0),
    },
    checkout: {
      // Shallow-checkout the reviewed commit into WORKSPACE_ROOT so reviewers
      // can read the real tree (not just the diff). Best-effort/non-fatal.
      enabled: bool("REVIEW_CHECKOUT", false),
      // Newest worktrees kept per repo after each review (PVC capacity guard).
      keep: int("CHECKOUT_KEEP", 3),
      // Abort a fetch that has stalled on a dead proxy connection instead of
      // blocking the (now async) git child for the full timeout: if the transfer
      // rate stays below `lowSpeedLimit` bytes/s for `lowSpeedTime` seconds git
      // gives up (issue #6).
      lowSpeedLimit: int("CHECKOUT_LOW_SPEED_LIMIT", 1024),
      lowSpeedTime: int("CHECKOUT_LOW_SPEED_TIME", 30),
      // Workspace disk guards (issue #11 — bare-repo git packs accumulated
      // unbounded until the 2 GiB PVC was 100% full and reviews failed ENOSPC):
      //   - gcPacks: once a bare repo reaches this many pack files, `git gc`
      //     consolidates them (each shallow fetch appends a pack otherwise).
      //   - workspaceMaxBytes: when the whole WORKSPACE_ROOT exceeds this, the
      //     least-recently-used bare repos are evicted to stay under budget.
      //   - diskMinFreeBytes: before a fetch, if the volume has less free space
      //     than this, reclaim first (gc + evict) instead of fetcing into a full
      //     disk.
      gcPacks: int("CHECKOUT_GC_PACKS", 20),
      workspaceMaxBytes: int("CHECKOUT_WORKSPACE_MAX_BYTES", 1536 * 1024 * 1024),
      diskMinFreeBytes: int("DISK_MIN_FREE_BYTES", 128 * 1024 * 1024),
    },
    server: {
      host: str("HOST", "127.0.0.1"),
      port: int("PORT", 8123),
    },
    ui: {
      // Model-id → display-name overrides injected into the dashboard at serve
      // time (MODEL_OVERRIDES_JSON env, JSON object). Defaults to the portable
      // example-gateway names; deployments override with their own ids so
      // ui/app.js stays identical across repos (zero-divergence).
      modelOverrides: json("MODEL_OVERRIDES_JSON", DEFAULT_MODEL_OVERRIDES),
    },
  };

  // Persisted runtime model overrides (UI-switched), if the settings file has
  // them. Env-config values remain the fallback for any slot without an override.
  config.models.settingsFile = path.resolve(
    str("MODEL_SETTINGS_FILE", path.join(config.dirs.jobs, ".models.json")),
  );
  const persistedModels = readModelAssignments(config.models.settingsFile);
  if (persistedModels.a) config.models.reviewerA = persistedModels.a;
  if (persistedModels.b) config.models.reviewerB = persistedModels.b;
  if (persistedModels.c) config.models.reviewerC = persistedModels.c;
  if (persistedModels.d) config.models.reviewerD = persistedModels.d;
  if (persistedModels.consensus) config.models.consensus = persistedModels.consensus;
  if (persistedModels.vision) config.review.visionModel = persistedModels.vision;

  return config;
}

/** Throws a readable error when a required setting is missing. */
export function assertBitbucketConfig(config) {
  const problems = [];
  if (!config.bitbucket.baseUrl) problems.push("BITBUCKET_BASE_URL is not set");
  if (!config.bitbucket.token) problems.push("BITBUCKET_API_TOKEN is not set");
  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }
}

/** Throws a readable error when the GitHub backend is missing a required setting. */
export function assertGithubConfig(config) {
  const problems = [];
  if (!config.github.token) problems.push("GITHUB_TOKEN is not set");
  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }
}

/**
 * Boot requires at least one configured backend (Bitbucket and/or GitHub),
 * never a specific one — each backend is independently optional (parallel
 * backends, not a platform switch).
 */
export function assertAnyBackendConfig(config) {
  const bitbucketConfigured = !!(config.bitbucket?.baseUrl && config.bitbucket?.token);
  const githubConfigured = !!(config.github?.token);
  if (!bitbucketConfigured && !githubConfigured) {
    throw new Error(
      "Invalid configuration: neither Bitbucket nor GitHub is configured.\n" +
        "  - Bitbucket: BITBUCKET_BASE_URL and BITBUCKET_API_TOKEN\n" +
        "  - GitHub:    GITHUB_TOKEN (GITHUB_API_BASE_URL for GitHub Enterprise Server)",
    );
  }
}

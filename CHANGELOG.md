# Changelog — AI PR Reviewer

Release notes for the on-demand AI pull-request reviewer for Bitbucket Data
Center and GitHub (GitHub support arrived in v0.5.0).

Versioning note: early container images were tagged `v1.x`; later releases track
the app version (`v0.2.y` → `v0.5.x`). Both series belong to the same project.
Newest entries come first, so the older `v1.x` image tags appear further down,
below the `v0.2.x` entries.

---

## v0.5.9 — 2026-11-25 — Context page: file tree, create stack files, AI draft for stacks

### Context page — folder/file tree in the left pane

- The flat context-file list is now a **collapsible tree**: Project-wide,
  Per-repo (grouped per project), Other files and Stacks, each folder showing
  its count. Leaves show real file names (with the `.md` extension), the
  active file is highlighted, and its ancestor folders auto-expand so it stays
  in view.
- Known repos that don't have a context file yet appear as **grayed "not yet
  created"** entries under their project folder — click to draft, the first
  Save writes the file. This replaces the old `PROJECT/repo` text box.
- A per-repo file with a **lowercase project key** no longer shows twice (a
  grayed entry *and* under Other files): it's matched back to its repo by exact
  `<project>-<repo>.md` name and shown once, under its project folder.

### Create stack rule files from the tree

- The Stacks folder always shows a **＋ New stack** action: it opens a stack
  template with an **editable name in the toolbar** (`stacks/<name>.md`);
  **New** validates the name with the same rule as the server and writes the
  file on save. Typed text is kept while you edit the name.
- New per-repo/stack templates no longer embed a "what to write" comment —
  files on disk are clean, and the guidance moved to the editor hint.

### AI draft for stacks (new + existing)

- The ✨ AI draft button now covers **stack rule files** as well as per-repo
  files; `/api/contexts/generate` dispatches on `kind: stack` and validates the
  stack name (injectable runner, same as the repo draft). The `context-gen`
  agent prompt now documents both per-repo and stack shapes — fresh stacks must
  start with `match:` YAML front matter, refinements keep it intact.
- AI drafting now **refines rather than replaces**: the current content is sent
  as the authoritative base and the agent is told to preserve every still-true
  rule and add/correct per the notes, never rewriting wholesale.
- Drafting a **brand-new** stack asks the agent to propose `match:` patterns
  instead of preserving the empty `match: []` template.

### Fit & finish

- Dropped the 🧠 / 📊 / 💾 / 🗑 emoji for a cleaner look (the ✨ sparkle stays as
  the AI-draft identity).
- The editor uses the full available width (removed the 1100px cap).
- Save toasts are stack-aware; the empty-editor hint no longer shows literal
  tags.

### Deployment image

- Pin the image's `opencode` CLI to `@opencode/cli@2.4.1`: `@latest` had drifted
  to a version that never emits `step_finish`/`tokens` for tool-free agent runs,
  so `pr-vision` screenshot transcription lost its usage/cost (dashboard showed
  `vision.cost: null`).

---

## v0.5.8 — 2026-11-25 — App filter (PRs + Jobs), curated-context editor & AI draft, vision reliability

### Searchable app filter for the PRs and Jobs lists (left sidebar)

- **The "App" filter now works for both the PRs and the Jobs list.** Previously
  it was a native dropdown that only filtered the PRs list (and was hidden in
  Jobs mode). It is now a **searchable combobox** (type to filter `PROJECT/repo`)
  that applies to whichever list is shown, shows a per-mode count on every row
  ("All apps (N)" plus each app), highlights the current selection, has a **✕**
  to clear, and keeps the selection across PRs↔Jobs switches.
- **Jobs are filtered server-side** (`GET /api/jobs?app=PROJECT/repo` filters
  *before* pagination), so filtered totals and pages are correct even though a
  large job store is paged (issue #6 stays intact). A new cheap endpoint
  (`GET /api/jobs/apps`) returns app → job-count from the small meta files, so
  apps whose PRs are merged/gone still appear in the picker. App counts are
  TTL-cached client-side and fetched on demand, never on every poll.

### Jobs list: merged/declined PRs no longer look like active runs

- A job whose PR has been merged/declined/superseded (or deleted) is now shown
  as a **closed story**: the row is dimmed and the badge shows the PR's
  terminal state (`merged` / `declined` / …) instead of the job's stage — so a
  run left "in progress" at merge time stops looking active. The list
  cross-references the PR view (including the `github:` namespace for GitHub),
  so the two lists agree.
- The header "run in progress" pill ignores orphaned running jobs whose PR is
  already closed.

### Curated-context editor (dashboard)

- **The team can now edit review context from the dashboard.** A new **🧠
  Context** page lists every curated context file under `REVIEW_CONTEXT_DIR`
  (`<PROJECT>-<repo>.md` per-repo with the `<repo>.md` fallback, project-wide
  `<PROJECT>.md`, and `stacks/*.md`) and lets you open any of them for
  editing, create a fresh per-repo context (`PROJECT/repo`, suggested from
  repos seen in reviews) and delete one (with confirmation). Saves write
  straight to the contexts dir and apply to the **next** review of that repo
  — no restart, no redeploy, no container rebuild.
- **Safe by construction.** File names are validated strictly server-side
  (`src/contextsEditor.js`): only `.md` under the contexts dir itself or
  `stacks/`, no `..`/absolute paths, so the API can never touch a file outside
  `REVIEW_CONTEXT_DIR`. Writes are atomic (temp file + rename) so a crash
  mid-save can't leave a truncated context file that a concurrent review might
  read, and there is a 512 KB per-file cap.
- **Non-fatal, best-effort.** A missing/unreadable contexts dir yields an empty
  listing; a broken stack front matter is listed without its `match` — nothing
  the editor does can turn a review into a hard failure, matching the project's
  optional-helpers convention. New API: `GET/PUT/DELETE /api/contexts/…`.
- **Review-driven hardening.** Per the Copilot review on the feature PR: the
  containment check is now canonical (`realpathSync`), so a symlinked context
  file or `stacks/` dir pointing outside `REVIEW_CONTEXT_DIR` is rejected
  instead of followed; repo slugs containing `.` (`service.api`, `.github`)
  are accepted, listed and classified (they were already reviewed); a lone
  per-repo file no longer needs its project-wide file to be recognized as such;
  `GET /api/contexts/repo` argument bug fixed (the dashboards "Open / new"
  flow 400'd on every request); AI drafting forwards the repo's platform;
  stale generation/save responses can no longer clobber a different file's
  editor or drop edits typed mid-save; Stats↔Context toggling no longer loses
  the previous PR/Jobs view.
- **“✨ AI draft” writes the file for you.** For any per-repo context, developers
  paste **false positives or what the bot should know** and the new `context-gen`
  opencode agent ([`prompts/context-gen-base.md`](prompts/context-gen-base.md),
  copied verbatim by `build:agents` like `pr-vision`) drafts the whole
  `PROJECT-repo.md` file — grounded on the repo’s own `AGENTS.md` (default
  branch) when readable. The result lands in the editor as a **reviewable
  draft**: nothing is ever written to disk automatically, because curated
  context is authoritative to reviewers. Run via `POST /api/contexts/generate`
  (`src/contextGen.js`); the drafting model is `CONTEXT_GEN_MODEL`, falling back
  to the consensus model then reviewer A, and no model configured disables the
  button.

### Vision transcription reliability & observability

- **Fixes an intermittent "all screenshots unreadable" failure.** The vision
  transcription ran `opencode run --agent pr-vision` with the image in a bare
  OS-temp dir; the shared opencode server could take that dir for an agent-less
  "new project", never load `.opencode/agents/pr-vision.md`, and fail every
  image with `Session.AgentNotFoundError: Agent not found: "pr-vision"` — while
  the app logged only an unhelpful `vision: transcription failed: exit code 1`.
  The scratch dir is now anchored **inside the project root**
  (`dirs.visionScratch`, `VISION_SCRATCH_DIR`, default `./data/vision-scratch`),
  so the server always resolves the session to the app project and finds the
  agent (same path the reviewers use); the image still lands in an isolated
  per-call subdir, never the app/review working dir (Copilot #17 isolation kept).
- **The real failure is now observable.** `transcribeViaAgent` returns a
  structured `{ ok, text, usage, stdout, stderr, error }` envelope and the
  pipeline persists per-image artifacts into the job dir — `vision-<n>.txt`
  (transcription), `vision-<n>.log` (agent stdout/stderr, where the
  `AgentNotFoundError` now lives), and `vision-<n>.json` (usage/cost/metadata) —
  mirroring the reviewer `-attempt-N.*` artifacts and picked up by the dashboard
  automatically.
- **Crash leftovers can't accumulate.** A best-effort `sweepVisionScratch`
  removes `pr-vision-*` subdirs older than `VISION_SCRATCH_MAX_AGE_MS` (default
  1 h, floored at two call timeouts and an absolute 60 s so it never touches a
  concurrent review's live dir), closing the disk-hygiene gap for a SIGKILLed
  transcription.
- Retry on the transient agent-call path was considered and deliberately left
  **out of scope** (see issue #22): the review-level rerun is the retry.

---

## v0.5.7 — 2026-11-22 — Bitbucket 429 storm: process-wide governor (pace + circuit-breaker + retry)

- **429 storms (and the Bitbucket body-read failures they cause) are now handled
  at the process level, not per client.** New `src/bitbucket-governor.js`
  singleton spaces every Bitbucket HTTP request (`MIN_SPACING_MS=200`), opens a
  shared **circuit-breaker** on 429 (2s→30s capped exponential backoff, honoring
  `Retry-After` up to 30s), and `BitbucketClient` retries **safe-read**
  requests on transient status (429 / ≥500) with ±20% jittered backoff and a
  known-status body-read-failure retry path — so `/api/pulls` polling and
  review fetches stop hammering the API during rate-limit windows.
- **Breaker state is deliberately process-wide with no env/config surface**
  (constants only): transient 429s are systemic, not per-request, so throttling
  and blocking belong to one singleton. Tests inject a fake-clock governor.
- **Added `tests/bitbucket.test.js`** (591 lines: pacing, breaker, Retry-After,
  body-read failure, retry policy) + expanded `tests/pulls.test.js` /
  `tests/server-github-webhook.test.js`. Suite now covers the governor
  end-to-end.

### Notable
- The release pipeline harden from 0.5.6 (GNU-tar SIGPIPE guard via `sort -u`)
  is unchanged; `release.yml`/`package.json` are otherwise untouched by this PR.

---

## v0.5.6 — 2026-11-21 — Zero-divergence release + env-driven dashboard model names

- **Vision transcription is now an OpenCode agent (`pr-vision`), not a bespoke
  HTTP client.** The old `src/vision.js` raw-HTTP transcriber (provider/token/
  base-URL surface + baked-in default) is deleted; screenshots are transcribed
  by the compiled `pr-vision` agent (`prompts/vision-base.md`), which receives
  the image via `--file`, runs **deny-all / tool-less**, in an isolated temp
  working directory, with the vision model passed through `VISION_MODEL`. This
  closes the last app-level fork between this repo and deployment packs —
  provider routing/auth now comes entirely from the OpenCode config/env, never
  from source. ([#16], [#17])
- **Zero-divergence rule documented + enforced.** README: "zero-divergence rule"
  (code is never edited in a pack; deployment differences are env + build-config
  only) and "Syncing a deployment pack" (copy-based `rsync` with `--dry-run`,
  required `--exclude`, and a `diff -rq` parity check). ([#14], [#15])
- **Dashboard model names are env-driven.** `ui/app.js` is now byte-identical
  across deployments: the server injects the model-id → display-name map from
  `MODEL_OVERRIDES_JSON` (`config.ui.modelOverrides`) at serve time, over the
  `__MODEL_OVERRIDES__` marker. Defaults to the portable example-gateway names;
  no provider identity lives in the static UI.
- **`tests/models.test.js` is wired into `npm test`** (it existed but was never
  run — now 344 tests, was 327).
- **Pack-sync docs harden `--delete`**: preview with `--dry-run` first, and the
  apply command always carries the pack-local exclude so a sync can never wipe
  local-only build/deploy files.

### Fixes
- Vision agent `cwd` isolated to the screenshot temp dir (was inheriting the
  app/review working directory — author-controlled images could reach source or
  review artifacts); billable tokens from timed-out/failed/empty runs are
  preserved in vision cost; temp-dir cleanup failures are logged, not silent.
- A `fetchPrImages`=on run with `VISION_MODEL` unset now logs a transparent skip
  warning instead of silently producing no screenshot block.

## v0.5.2 — 2026-11-18 — GLM-52 context declared truthfully (large-diff robustness)

- **Corrected model context declaration in the container template.**
  `glm-52` was declared with a **1,048,576**-token context while the model
  provider actually enforces **262,144**. The review tool budgets the prompt
  against the declared limit, so on large PRs it sent prompts far over the
  real window and every reviewer failed instantly with an input-overflow /
  compaction error (reported by the provider as `maximum context length is
  262144`). The declared limit is now **262,144**, matching provider truth, so
  oversized inputs are rejected up front instead of mis-budgeted.
- **Large PRs now degrade gracefully, not fail.** The existing diff-budget
  guard (`MAX_DIFF_BYTES`, default `300_000`) truncates an over-sized diff to
  a representative slice — whole source files first, then tests, then
  lockfiles/generated files — and tells the reviewer (via an inline NOTE) to
  read the truncated files from the checkout. Previously a very large PR (a
  few MB diff) could exceed even the largest declared model window and abort
  the review. Recommended operator guidance: keep `MAX_DIFF_BYTES` within the
  smallest reviewer's effective input budget (~250–400 KB for the current
  model set).

---

## v0.5.1 — 2026-11-18 — Jira acceptance criteria no longer lost

- **Reliable Jira ticket fetching.** The SSO/proxy in front of Jira
  intermittently answers `200 OK` with an HTML login page where the REST API
  should return JSON; there was no retry, so on the first transient hiccup the
  ticket was reported as *"could not be fetched"* and its acceptance criteria
  were never available. Tickets are now fetched in **parallel**, and each
  fetch retries once on JSON-parse failure and on transient HTTP `429`/`5xx`
  (with a short backoff). Permanent errors (`404`, `403`) still fail fast.
- **Consensus now emits acceptance-criteria verdicts.** The consensus prompt
  treated `acceptance_criteria` as optional and tied to a specific heading
  format, so the model sometimes returned `[]` even with criteria visible in
  the raw description. It is now **required** when tickets are linked: the
  model reads each raw description, extracts every criterion it can find
  regardless of heading format, and applies `met`/`partial`/`unmet`/
  `not_verifiable` (with a reason) to each.
- **Parsing hardening.** Truncated `{color` markup (no closing brace, from
  capped descriptions) is stripped; *Definition of Done* / *Test Cases*
  headings are honoured as an AC fallback only with a real heading marker and
  only when no explicit *Acceptance Criteria* heading exists — a DoD heading no
  longer hides or swallows the real acceptance-criteria section.
- **Tests:** +6 (retry on HTML, retry on HTTP 500, no retry on 404, DoD
  before/after an AC section, heading-marked fallback only, truncated
  `{color}`); suite 313 green. Verified live: a previously *"could not be
  fetched"* ticket now renders 4 AC verdicts in a *Jira coverage* table.

## v0.5.0 — 2026-11-15 — GitHub backend (parallel platform support)

- **GitHub is now a first-class, *parallel* backend** alongside Bitbucket Data
  Center — not a mode switch. A review picks its platform from the PR reference:
  `github:owner/repo#N`, a `gh:` prefix, or a GitHub `/pull/N` URL selects
  GitHub; everything else stays on Bitbucket (bare `owner/repo#N` unaffected).
- **New `GitHubClient`** (`src/github.js`) mirrors the Bitbucket client surface
  and returns normalized PR/activity/change shapes, so the pipeline, context,
  discussion and report steps need no platform branches (Link-header
  pagination, `vnd.github.diff`, GHES support via `GITHUB_API_BASE_URL`).
- **GitHub webhooks:** `POST /webhooks/github` verifies `X-Hub-Signature-256`
  (unsigned `ping` always acknowledged) and triggers on `/ai-review` comments,
  `pull_request` opened / ready_for_review / review_requested — with the same
  allowlist (`ALLOWED_REVIEWER_USERS`), per-repo off list
  (`GITHUB_AUTO_REVIEW_OFF_REPOS`) and branch-pair skip
  (`REVIEW_ON_REVIEWER_ADDED_SKIP`) semantics as Bitbucket; drafts wait until
  marked ready.
- **Independent publish gates:** `PUBLISH_TO_GITHUB=1` posts comments to
  GitHub (default 0), independent of `PUBLISH_TO_BITBUCKET`. GitHub publishes
  via the comment's own `html_url`; repo root links are per-platform.
- **Dashboard grouping is platform-aware:** pull keys are namespaced
  (`github:owner/repo#N`) so the platforms never collide, and each PR is
  enriched with its own platform's client (head SHA, new commits, state —
  `MERGED`/`CLOSED` GitHub PRs are dimmed like merged/declined Bitbucket PRs).
- **Operational knobs:** `REVIEWER_PARALLELISM` (0 = parallel default, 1 =
  strictly serial for small hosts) and a GitHub-only `.env` profile for small
  single-host setups.

### Live proof — GitHub backend end-to-end on real infra (2026-11-15)

- **GitHub backend exercised live:** a real repo webhook (`pull_request` +
  `issue_comment`) verified HMAC, allowlist, `/ai-review` trigger, checkout,
  serial reviewers → consensus → draft report in `jobs/` and the dashboard.
  Publishing stayed off (`PUBLISH_TO_GITHUB=0`).
- **Runtime guidance from the proof:** run opencode as a shared background
  service (`OPENCODE_STANDALONE=0`, `opencode serve --service` under a supervisor
  like systemd). Per-run standalone (`=1`) repeatedly hit `provider.no-route` /
  hangs on a small host; the Docker path in `docker/entrypoint.mjs` already
  implements the service mode.
- **`docker/opencode.json.template` is a skeleton, not a ready config:**
  materializing it needs the `llm-gateway.example.com` host replaced **and** the
  `providers/example/msp` path segment replaced with your gateway's own tenant
  path — missing that swap makes every `llmgw-msp/*` model answer HTTP 404
  ("Resource not found").
- **Serial reviewers validated on a 1-vCPU host** (`REVIEWER_PARALLELISM=1`):
  DeepSeek Flash, Qwen and GPT-6 Luna each completed in tens of seconds per stage
  with Claude Haiku consensus.

## v0.4.2 — 2026-11-13 — Public-comment wording + working Jira acceptance-criteria verdicts

- **Public comment no longer exposes internal reviewer slots:** the consensus
  summary is author-facing and never names "Reviewer A/B/C/D" or per-agent
  attribution — plain review language instead. The "Translation & content"
  anchor drops the "reviewer D" wording; a partial review reads
  "partial review (N review passes unavailable)". The dashboard's internal
  report keeps full slot detail.
- **Jira acceptance-criteria verdicts now actually land:**
  - Cap for acceptance-criteria text raised (2400 → 6000 chars) so long AC
    lists reach the consensus whole instead of being cut and hiding the very
    criteria a PR implements.
  - `verdictForAc` is exact-first with a bounded numeric fallback, so
    sub-numbered criteria (`AC3.1`, `AC5.1`) bind to their own bullets and are
    never hijacked by a parent.
  - Consensus must emit **one verdict per AC bullet** (ids verbatim, never an
    empty list when criteria exist), `not_verifiable` instead of omission, and
    the summary closes with an AC-coverage sentence.

## v0.4.1 — 2026-11-13 — Vision cost + model picker truth + model catalog cleanup

- **Fix for Jira coverage on modern tickets:** acceptance-criteria extraction now
  also handles Markdown `##` headings (tracker editor output), not just classic
  `h2.` wiki markup — PR comments on such tickets again show the criteria table.
- **Vision transcription is now tracked and priced:** screenshot token usage is
  parsed and billed at the vision model's own rate, shown as a separate
  **"Vision transcription"** row in the dashboard Costs card. Never mixed into a
  reviewer's usage.
- **Models ▾ dialog gained a Vision (screenshots) slot**, persisted like the
  other defaults. The picker is gated on true image capability, not on the
  HTTP route: image-capable models only (Claude Haiku 5.5, GPT-6 Luna,
  Qwen 27B); text-only models are excluded and rejected.
- **Model catalog shrink:** two disabled models removed from the bundled
  config; the catalog is exactly the reachable set.

## v0.4.0 — 2026-11-12 — Reviewer D: language, i18n & translation quality

- **A fourth reviewer joins on translation/content PRs.** A PR is treated as a
  translation/content PR when any changed file matches a translation path
  pattern (default `TRANSLATION_PATH_PATTERNS`: `(^|/)i18n/.*\.json`, `.po`,
  `.pot`; comma-separated regex override).
- On those PRs **D runs in parallel with A/B/C** (one consensus); on every
  other PR D is skipped and A/B/C behave exactly as before.
- D's lens checks **semantic fidelity** to the source locale (`en.json` via the
  checkout), **terminology/register consistency** across locales, **placeholders**
  (`{{ var }}`, ICU) and **mechanical i18n defects** (missing/duplicated key,
  broken nested JSON), plus **untranslated leftovers on changed lines**.
- New categories `translation`/`i18n`; D's findings render in a dedicated
  **"Language & content"** PR-comment section. Only HIGH/CRITICAL
  (meaning changed/harmful, broken placeholder) affect the merge verdict;
  MEDIUM/LOW are advisory so style feedback can't block a translator.
- Config: `REVIEWER_MODEL_D` (falls back to `REVIEWER_MODEL_A`),
  `TRANSLATION_PATH_PATTERNS`. UI: Reviewer D card + model picker.

## v0.3.9 — 2026-11-11 — Vision transcription of PR screenshots

- Reviews now **read images pasted into the PR description or comments**
  (Bitbucket `attachment:` refs, direct http(s) URLs, or data-URIs) — no longer
  blindly text-only.
- A vision-capable model transcribes each image (`VISION_MODEL`, default
  `llmgw-gpt/gpt-6-luna`) into a `PR screenshots (transcribed)`
  block attached to both reviewer and consensus contexts.
- Works because Bitbucket serves attachments via the REST endpoint with the
  existing bearer token (no extra sign-in).
- Unreadable/oversized images degrade to an explicit "N screenshots not
  viewable — ask the author" note, never an error.
- Flags: `FETCH_PR_IMAGES=1` (default on), `VISION_MODEL`,
  `VISION_MAX_IMAGES` (6), `VISION_MAX_IMAGE_BYTES` (10 MB),
  `VISION_FETCH_TIMEOUT_MS`, `VISION_CALL_TIMEOUT_MS`.
- Comment images are handled like description images — picked up at the next
  review like any other discussion.

## v0.3.8 — 2026-11-09 — Context-aware dedup + "teach `--force`"

- Same-head dedup is no longer purely head-based: a plain `/ai-review` on the
  same commit is skipped **only** when there is also **no new human
  discussion** since the last review. A new author/team comment on an
  unchanged head is a real re-review trigger.
- When dedup *does* fire for an explicit `/ai-review`, the bot posts a short
  threaded reply teaching **`/ai-review --force`** (only with
  `PUBLISH_TO_BITBUCKET=1`, never in dry-run; auto triggers stay silent).

## v0.3.7 — 2026-11-09 — Context-aware re-reviews

- Reviews now attach the PR's **recent discussion** (human comments + replies
  to the bot's own review comment, from the Bitbucket activity feed) to both
  the reviewer and consensus contexts, marked as *author clarifications*.
- A finding a comment already explains or justifies is resolved
  (`resolved_previous`) instead of re-raised; re-raised only when the code
  still contradicts the clarification.
- Control: `FETCH_PR_DISCUSSION=1` (default on).

## v0.3.5 / v0.3.6 — 2026-11-08 — Dashboard polish

- Center the KPI stats; findings severity chips.
- Dim 404/unreviewable PRs like merged.
- Two-decimal cost display; cleaner first-row KPIs.

## v0.3.4 — 2026-11-06 — DeepSeek V4 Flash fix (Reviewer A unblocked)

- Reviewer A (`llmgw-msp/DeepSeek-V4-Flash`) failed every attempt with
  HTTP 400: the template advertised a larger context window than the model's
  real deployment caps at **262 144**, so a near-max output request was rejected
  before any tool call.
- The model limit is now context 262 144 / output 131 072, matching the real
  deployment window. Verified in the container: reviewer A runs to completion.

## v0.3.3 — 2026-11-04 — Release batch

- **Version pin:** review comments/reports now show the image's baked-in
  `APP_VERSION` (build-arg), fixing reviews that reported a stale version.
- **Dedup + deliver:** an automatic trigger whose head was already reviewed is
  skipped; if that review was a held dry-run (UI preview only), it is delivered
  to Bitbucket when the same head later gets a reviewer.
- **Allowlist simplify:** auto-review is now ON for every repository by default,
  off only for repos on `AUTO_REVIEW_OFF_REPOS`. Onboarding a repo is
  just adding the webhook.
- **Model cleanup:** two retired Claude variants removed from the config.

## v0.3.2 — 2026-11-01 — Auth sidecar removed

- The separate UI authentication sidecar was dropped as unnecessary — back to a
  simple single-container deployment; the related `UI_AUTH_*`/`OAUTH2_PROXY_*`
  code was removed.

## v0.3.1 — Severity color fix

- MEDIUM findings are now a true yellow on the dashboard instead of sharing
  HIGH's amber.

## v0.2.4 — 2026-10-28 — Reviews on `pr:opened` and `pr:modified`

- A review also starts when a listed reviewer is on a PR that is **opened as a
  non-draft** (`pr:opened`), or on a **draft when it is marked ready**
  (`pr:modified`, `previousDraft` true → `draft` false). Drafts opened as drafts
  do not start one.

## v0.2.3 — 2026-10-27 — Skip merge PRs between branch pairs

- Reviewer-added triggers skip merges between configured branch pairs
  (`REVIEW_ON_REVIEWER_ADDED_SKIP`), e.g. `develop` ↔ `release/*` and
  `release/*` ↔ `release/*` — sync merges don't spam reviews.

## v0.2.2 — 2026-10-27 — Reviewer-added triggers

- Reviews start when a configured reviewer is added to a PR (webhook
  `pr:reviewer:updated`), with per-repository reviewer lists
  (`REVIEW_ON_REVIEWER_ADDED_BY_REPO`), a default list, and an adder check
  against `ALLOWED_REVIEWER_USERS`.

## v0.2.1 — Fixes after the first live run

- **Comment draft** is always written (not only when unpublished) — it is
  exactly the text posted or to be posted.
- **Artifact caching fixed:** the UI no longer caches a job's artifacts while a
  review is still running; unsaved Draft-tab edits survive background refreshes
  (with "Reset to generated").
- **Jira table noise:** Confluence links, `{}` code-markup leftovers and JSON
  fragments are dropped when parsing the acceptance-criteria block; the comment
  shows only judged criteria, same rule as the overview.
- **Overview/comment parity:** `commentPolicy` is stored in `status.json`; the
  overview splits findings the same way (full cards + collapsible Minor) and
  counts match the comment.

## v0.2.0 — Review-quality overhaul

A review of the reviewer agents (A, B, C, consensus) using the 9 saved
jobs; every issue below was fixed:

- **Shared reviewer template** — prompts were ~70 % duplicated across A/B/C;
  now one template with distinct, non-overlapping lenses:
  - **A** — server rules, business logic, false-positive-sensitive checks.
  - **B** — DTOs, persistence, compatibility.
  - **C** — security (exploit path required), Jira requirements (in-scope ACs
    only), test coverage.
- **Consensus filters, doesn't accumulate** — never more findings than distinct
  reviewer issues; unverified single-reviewer findings capped at LOW; max 3
  LOW; new output fields (`category`, `dropped`, `resolved_previous`).
- **Evidence grounding** — findings cite `evidence`; the consensus re-checks
  that quoted evidence exists in the diff.
- **File-aware diff budget** — over the byte budget, whole files are dropped
  (lockfiles/generated first, then tests, then source), one file may be cut at a
  line boundary; omitted/cut files listed for the agents.
- **Comment gate** — the public comment shows in full only findings ≥
  `COMMENT_MIN_SEVERITY` (default MEDIUM) **and** ≥ `COMMENT_MIN_CONFIDENCE`
  (0.5); the rest go to a compact **Minor** list and don't drive the verdict.
- **Two reports** — `comment-draft.md` (public, author-facing) vs
  `final-report.md` (full internal report incl. notes/audit trail).
- **Version pinning** — `src/version.js`; `APP_VERSION` env overrides
  `package.json`; footer + JSON status metadata.
- **Agents discovered outside `dev/`** — agents now live where opencode finds
  them from any working directory; no silent fallback to a default agent.
- **Contexts shipped** — curated per-repo context files + generic per-stack
  files (Angular, Java/Spring) reach the agents instead of being ignored.

## v1.7 — 2026-10-22 — Per-pull-request dashboard + per-app filter

- **PRs mode** (default): the sidebar groups review runs by pull request, each
  with a live staleness badge (**new commits** ≫ **up to date** ≫
  **not reviewed**), last-reviewed SHA, review time, and a `+N commits` hint.
- **Single job header:** branch → target branch, current head SHA, staleness
  badge, collapsible "New commits since last review", **↻ Review latest**, and a
  review-switcher dropdown (flip between that PR's reviews in place).
- **Per-app filter** above the PR list ("All apps" or `PROJECT/repo`); the
  **Jobs** toggle returns the flat list.
- Force-pushed/rebased branches detected (`historyRewritten`).
- Backing API: `GET /api/pulls?live=1`; head/new-commits resolved from the PR's
  own commit list and cached in-process.

## v1.6 — 2026-10-22 — Jira ticket context

- `src/jira.js` extracts **linked ticket keys** from the PR title/description,
  fetches them from the Jira REST API, and appends a **`## Linked Jira
  tickets`** block (type/status/priority/summary/assignee/description/comments)
  to the reviewer context, so reviewers judge the change against the ticket's
  intent and acceptance criteria.
- Additive and non-fatal: disabled unless `JIRA_ENABLED=1` and a token is
  present; any fetch failure just skips the block.
- Enablement requires network access from the server to the Jira host (and, if
  you use an outbound proxy, adding that host to `NO_PROXY` so Jira is fetched
  directly).

## v1.5 — UI model switcher + persistence

- `GET /api/models` lists the selectable models (from the runtime opencode
  config — same source as the cost dashboard) plus the effective A/B/C/consensus
  assignment; `PUT /api/models` validates and persists; `POST /api/review`
  accepts a per-review `models` override.
- The dashboard header gains a **Models ▾** panel: four dropdowns + **Save as
  defaults** (persisted on the data volume, survive restarts, apply to
  webhook-triggered runs). Resolution: per-review override > persisted settings >
  environment config.

## v1.4 — Native providers + LLM Gateway MSP

- opencode bundled binary updated so the container runs the same **native provider
  packages** as a local install (azure, google-vertex, AI SDK); config template
  migrated to the native V2 provider shape.
- The Anthropic provider moved to the native `llmgw` Google-Vertex path.
- Added the **`llmgw-msp`** provider: GLM-5, DeepSeek-V4-Flash,
  Qwen-27B, authenticated with the existing auth token (no extra key).

## v1.3 — Cost tracking

- The pipeline captures each agent's token usage (input / output / cache read /
  cache write) from opencode's stream and prices it against the cost metadata
  in the opencode config (default EUR; `COST_CURRENCY`).
- Dashboard shows a **Costs (€)** table per reviewer (model, input with cache
  breakdown, output, total) and a bold TOTAL; each agent card gets a cost line.
- **GPT-6 Luna usage fix:** the gateway only returns `usage` in a stream when
  asked via `stream_options.include_usage=true`; the custom provider now
  injects it, so GPT-6 Luna reports real token counts.
- **Mandatory verification probe:** reviewer and consensus prompts require at
  least one `read`/`grep`/`glob` probe against the checkout before finalizing —
  guarantees per-agent usage is measured and tightens verification depth.

## v1.2 — Web UI overhaul

- *Consensus* and *Reviewers* merged into one tab (A/B/C + Consensus cards);
  agent cards keep their expanded state across live re-renders (running agents
  auto-open).
- Human-friendly model names; redundant *Final report* tab removed (covered by
  Overview; file stays under Artifacts).
- *Comment draft* is editable with **Preview** + **Post comment to Bitbucket**
  (publish API accepts an optional edited text body and persists it back).

## v1.1 — Project context + review checkout + v2 comment rendering

- **Project context** — every review carries a context section from (1) a
  curated per-repo file (`contexts/PROJECT-repo.md`) and (2) the repo's own
  `AGENTS.md` fetched at the reviewed head SHA. Marked authoritative and
  injected into reviewer + consensus contexts. Exists because reviewers only
  ever see the diff: baseline code and language rules are invisible, and the AI
  produced false positives without calibration (e.g. flagging a legal
  `super()` call as a dead guard).
- **Review checkout** (`REVIEW_CHECKOUT=1`) — shallow-checkout the **reviewed
  commit** (not the branch tip) into a git worktree so agents read the real
  tree; one warm bare repo per project with delta fetches; worktrees pruned to
  `CHECKOUT_KEEP`. Best-effort and non-fatal.
- **v2 comment rendering** — consensus reports carry a `strengths` array; the
  renderer produces two files: `comment-draft.md` (public: linked commit
  heading, verdict line, severity digest, Summary, "What's good", findings with
  blockquote impact) vs `final-report.md` (full internal incl. notes).
- Verified run on a real PR: all three reviewers + consensus succeeded,
  5 earned strengths, 4 LOW / 0 MEDIUM (vs 1 MEDIUM + 7 LOW on the same PR
  before project context).

## v1.0 — First deployed review pipeline

- On-demand AI PR review as a containerised service: Bitbucket
  webhook → fetch PR + diff → **three reviewers in parallel (A/B/C)** + **one
  consensus agent** → one combined summary comment posted back to the PR.
- Model assignment, diff-only analysis (before project context/checkout),
  dry-run vs publish mode, per-job artifacts and a web dashboard.
- First verified run on a real PR: 0 MEDIUM + 4 LOW.

## v0.8 / v0.9 — First end-to-end runs

- Initial on-demand reviews against a real project PR (diff-only, before the
  quality overhaul): e.g. 1 MEDIUM + 7 LOW on the pilot PR — the baseline that
  motivated project context and grounding.

---

## Concept

Built for **Bitbucket Data Center 9.4.x** and **GitHub**, run as an on-demand
service: anyone on the allowlist triggers a review with an `/ai-review` comment
on a PR; a
reviewer «added» / PR open / draft-marked-ready event can auto-start one as
well. Reviews are advisory and read-only — the service never opens a PR, never
modifies code, only posts one summary comment per review.

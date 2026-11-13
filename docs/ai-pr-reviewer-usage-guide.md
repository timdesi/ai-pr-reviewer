# AI Pull Request Reviewer — Usage Guide

This guide explains how to **use** the AI PR Reviewer: how to start a review,
how to read the report it posts, how to force a re-review, and — for operators —
how the CLI, dashboard, configuration and webhooks work. If you just want the
one-line quick reference, see
[`ai-pr-reviewer-cheatsheet.md`](ai-pr-reviewer-cheatsheet.md).

A printer-friendly one-pager for teams and stakeholders lives in
[`../leaflet/`](../leaflet/).

---

## 1. What it is

The AI PR Reviewer is an **on-demand AI code review for Bitbucket Data Center
pull requests**. You ask (in one of three ways — section 2), and a few minutes
later the PR carries **one verified, prioritized review comment** — nothing
more, nothing less.

How a review is produced:

1. The service fetches the pull request: metadata, changed files, the unified
   diff, recent human discussion, screenshots if any, and — when configured —
   the reviewed commit itself.
2. **Three independent AI reviewers run in parallel** (A = correctness/logic,
   B = runtime, persistence & compatibility, C = security, Jira requirements &
   tests). On translation/content PRs a fourth reviewer **D** (language, i18n &
   translation quality) joins them.
3. A **consensus agent** merges the reports: it verifies every finding against
   the code, deduplicates, drops or downgrades unsupported claims, and writes
   one final report.
4. The report is rendered into a human-readable **PR comment** (public) and a
   **final report** (internal, with audit trail).

The reviewer is **read-only and advisory**: it never approves, merges, declines
or edits code. It posts one comment. Everything else is inside the report.

> Typical review: **~3 minutes** (range 1.5–5 min), **~€0.04** of model cost
> (range €0.01–0.06). Figures tracked per run in the dashboard.

---

## 2. Starting a review — three ways

### 2.1 `/ai-review` comment (manual)

Comment on the pull request with a text starting with `/ai-review`:

```
/ai-review
/ai-review please
```

- Whitespace/case tolerant; a leading `/` is optional (`ai-review` also works).
- Only users on the `ALLOWED_REVIEWER_USERS` allowlist can trigger a review —
  otherwise the delivery is rejected. When the list is empty, anyone can.
- If the PR head was **already reviewed at exactly that commit**, `/ai-review`
  does **not** re-run the models — it delivers the existing review comment
  instead (or tells you it was already published). Append `--force` to force a
  full re-review:
  ```
  /ai-review --force
  ```

### 2.2 Adding the AI reviewer as a PR reviewer (automatic)

Add an AI reviewer user (e.g. `MYBOT`) to the pull request's reviewers. The
review starts automatically.

- Automatic reviews are **ON for every repository by default**; a repository
  listed in `AUTO_REVIEW_OFF_REPOS` opts out.
- The user who adds the reviewer must be on `ALLOWED_REVIEWER_USERS`.
- Pull requests **between merge-branch pairs** configured in
  `REVIEW_ON_REVIEWER_ADDED_SKIP` are **skipped** so release trains stay quiet
  (e.g. `develop` ↔ `release/*`, `release/*` ↔ `release/*`).

### 2.3 Opening a PR or marking a draft ready (automatic)

When a PR that is **not a draft** is opened — or a **draft is marked ready for
review** — and an AI reviewer user is among its reviewers, a review starts
automatically. PRs opened as drafts do not start a review until they are marked
ready.

### What the trigger does not do

- Removals (removing a reviewer) never start a review.
- Duplicates of a PR already queued or running are dropped silently.
- A triggered review whose head was already reviewed is not re-run; the existing
  review is delivered to the PR when it was not yet posted (auto triggers stay
  silent; a plain `/ai-review` teaches `--force` in a short reply).

---

## 3. Reading the review comment

The comment is written so a human can judge the PR in seconds. It starts with
the heading `## AI Review - <sha>` (commit linked) and contains:

### 3.1 The verdict line

One of four, always up front, only severities that actually occurred:

| Icon | Verdict | Meaning |
| --- | --- | --- |
| 🔴 | **Do not merge** — critical issues must be resolved | At least one CRITICAL finding |
| 🟠 | **Do not merge** — high-severity issues found | At least one HIGH finding |
| 🟡 | **Worth addressing before merge** | Only MEDIUM (and below) |
| ✅ | **Nothing blocks merge** | Only LOW, or nothing of note |

Severity counts appear next to the verdict, e.g. `1 HIGH · 3 MEDIUM · 5 LOW` —
only the severities that actually occurred are listed.

### 3.2 Summary and "What's good"

- A short **Summary** of what the PR does and whether it achieves it.
- A **What's good** section — the consensus agent's *verified* strengths, not
  generic flattery. Praise must be earned and grounded in the diff.

### 3.3 Findings

Every finding is self-contained:

- **Title** with file and line range.
- **Impact** — what breaks, and for whom (shown as a blockquote).
- **Evidence** — the code it points at, verbatim (shown as `diff` blocks so
  additions/removals get colours).
- **Suggested fix** — scoped and actionable (numbered list when multi-step).

Severities: `CRITICAL` 🔴 · `HIGH` 🟠 · `MEDIUM` 🟡 · `LOW` ⚪.

Findings below `COMMENT_MIN_SEVERITY` / `COMMENT_MIN_CONFIDENCE` are collapsed
into a compact **"Minor"** list and do **not** drive the verdict. Every finding
is **traced to real code in the diff** — schema, severity, line numbers and
evidence checks run as code, outside the model.

### 3.4 "Language & content" section (translation PRs only)

When a PR changes translation/content files (paths matching
`TRANSLATION_PATH_PATTERNS`, default `i18n/*.json`, `.po`, `.pot`), reviewer D
joins the review and its findings appear in a dedicated section. Only
**HIGH/CRITICAL** (meaning changed/harmful or a broken placeholder) drives the
merge verdict; **MEDIUM/LOW are advisory**, so style feedback never blocks a
translator's merge.

### 3.5 Jira coverage appendix (when a ticket is linked)

- Ticket keys are read from the **PR title and description** (up to
  `JIRA_MAX_TICKETS`).
- A per-ticket table shows one row per acceptance criterion with status
  **Met** / **Partial** / **Unmet** / **Not verified**, plus a short reason.
- A criterion that belongs to another repo (e.g. the UI) or needs runtime
  evidence is marked **Not verified** — never "Unmet", never guessed.
- If Jira is unreachable, the review still runs (just without the appendix).

### 3.6 Publications

- The **comment** is the author-facing, public version (no internal notes, no
  agent attribution).
- Internal notes / audit trail appear only in the **final report**
  (`final-report.md`), never in the comment.
- Publication only happens for the **reviewed revision**: the head SHA is
  re-checked before posting, so a changed PR never gets a stale report.

---

## 4. The dashboard (optional)

The dashboard is a local single-page app that reads the same `jobs/` directory
the CLI writes to, so past runs are fully browsable.

```bash
cd dev
npm run ui          # http://127.0.0.1:8123
```

During a review (from the CLI or the browser) it shows the live pipeline:
stage timeline (fetch → review → consensus → render → publish), per-agent
status/attempts/durations with **streaming reply text** (SSE), the final report
and comment draft rendered as markdown, a **publish** button (posts the public
comment with the same stale-SHA check as the CLI) and a **New review** form.
Costs and model assignments are shown per run. CLI and UI runs share the job
store, so you can start a run in a terminal and watch it in the browser.

---

## 5. The CLI (local usage)

```bash
cd dev
cp .env.example .env    # fill in BITBUCKET_BASE_URL / BITBUCKET_API_TOKEN
```

Trigger a review with a PR URL or `KEY/slug#ID`:

```bash
npm run review -- ACME/acme-app#5566
npm run review -- https://host/projects/ACME/repos/acme-app/pull-requests/5566
```

Post the report as a real PR comment (opt-in per run):

```bash
npm run review -- ACME/acme-app#5566 --publish --yes
```

Options:

| Option | Effect |
| --- | --- |
| `--publish` | Post the final report as a PR comment on Bitbucket |
| `--yes` / `-y` | Skip the confirmation prompt when publishing |
| `--json` | Print the machine-readable result as JSON |
| `--quiet` | Only stderr logs, no fancy summary |
| `--help` | Show help |

By default the CLI is a **dry run**: nothing is posted to Bitbucket; the public
comment version is kept as `comment-draft.md`.

Result artifacts land in `dev/jobs/<project>-<repo>-PR<id>-<sha8>/`:

- `pr-context.md` — reviewer input (metadata + changed files + unified diff)
- `reviewer-{a,b,c,d}.json` — the independent reviewer reports
- `consensus-input.md` / `consensus.json` — consensus input + final report
- `final-report.md` — full internal report (incl. `notes` / audit trail)
- `comment-draft.md` — the public PR-comment version (no internal notes)

---

## 6. Configuration (for operators)

Copy `dev/.env.example` to `dev/.env` and adjust. Key settings:

| Variable | Purpose |
| --- | --- |
| `BITBUCKET_BASE_URL` | Bitbucket Data Center base URL |
| `BITBUCKET_API_TOKEN` | HTTP access token (sent as `Authorization: Bearer`) |
| `BITBUCKET_WEBHOOK_SECRET` | Shared secret for webhook signature verification |
| `VERIFY_TLS` | `false` disables TLS verification (internal CAs) |
| `ALLOWED_REVIEWER_USERS` | Allowlist of who may trigger a review (empty = anyone) |
| `AUTO_REVIEW_OFF_REPOS` | `PROJECT/repo-slug` entries with automatic review disabled |
| `REVIEW_ON_REVIEWER_ADDED_SKIP` | `SOURCE>TARGET` branch pairs that never auto-review (sync merges) |
| `REVIEWER_MODEL_A/B/C/D`, `CONSENSUS_MODEL` | OpenCode provider/model IDs (D = language/i18n; falls back to A) |
| `TRANSLATION_PATH_PATTERNS` | Path regexes that mark a PR as a translation/content PR (default `i18n/*.json`, `.po`, `.pot`) |
| `PUBLISH_TO_BITBUCKET` | `1` = post the report back to the PR (CLI *and* server/webhook); `0`/unset = dry run |
| `COMMENT_MIN_SEVERITY` / `COMMENT_MIN_CONFIDENCE` | Public-comment gate (default `MEDIUM` / `0.5`) |
| `MAX_DIFF_BYTES` | Diff budget for agent context (default `300000`) |
| `REVIEW_CHECKOUT` | `1` = shallow-checkout the reviewed commit so reviewers can read real files |
| `JOBS_DIR` | Where job artifacts are written |
| `HOST` / `PORT` | Dashboard bind address / port (default `127.0.0.1:8123`) |
| `FETCH_PR_DISCUSSION` / `FETCH_PR_IMAGES` | Attach recent PR discussion / transcribed screenshots to the review |

The `REVIEWER_MODEL_*` values are OpenCode provider/model IDs; you can also
switch models per slot from the dashboard UI (persisted overrides).

### 6.1 Webhook setup (server)

The dashboard server (`npm run ui`) also serves `POST /webhooks/bitbucket` on
the same port. Point a repository/project webhook at
`https://<host>:<port>/webhooks/bitbucket` with:

- **Events:** `pr:comment:added`, `pr:reviewer:updated`, `pr:opened`,
  `pr:modified` (a draft marked ready).
- **Secret:** the same `BITBUCKET_WEBHOOK_SECRET` on both sides; deliveries with
  a wrong/missing `X-Hub-Signature` are rejected (401).
- The handler responds immediately (200/202) and enqueues the review; it never
  blocks on model execution.

---

## 7. Tuning the reviewer per repository (no code change)

Curated context is injected into every review as **plain markdown** — no code
change, no rebuild of the agent logic:

| Layer | File | Content |
| --- | --- | --- |
| Project (org-wide) | `REVIEW_CONTEXT_DIR/<PROJECT>.md` | Rules for every repository |
| Stack | `REVIEW_CONTEXT_DIR/stacks/<stack>.md` | Attached when changed files match the file's patterns |
| Repository | `REVIEW_CONTEXT_DIR/<PROJECT>-<repo>.md` | Role, conventions, known false positives |
| Repo notes | `AGENTS.md` | Read from the reviewed commit (head SHA) |

Keep the files short: only what a reviewer gets wrong without help — known
false positives, framework defaults, conventions a bare diff cannot show.
Comments in the files are stripped before the agents see them, and empty
sections cost nothing.

---

## 8. Safety and trust model

- **Read-only, least privilege** — agents cannot approve, merge, decline or
  modify code; only a narrow publisher may post the comment.
- **No stale reviews** — the head SHA is re-checked before publishing.
- **Prompt-injection-aware** — repository content, diffs and comments are
  treated as untrusted data, never as instructions.
- **Deterministic gates outside the model** — schema, severity, line numbers,
  evidence and SHA checks are code, not prompts.
- **Isolated** — sandboxed agents, per-job workspaces, `.env` reads denied.
- A failed or partial review is **never presented as a clean review**; if fewer
  than two reviewers succeed, the run stops before consensus.

---

## 9. FAQ / troubleshooting

**I commented `/ai-review` and nothing happened.**
Check that your user is on `ALLOWED_REVIEWER_USERS` (otherwise 403), that the
repository has an active webhook to the service, and that the PR is not between
configured merge-branch skip pairs. Review log lines via `oc logs`.

**It says "already reviewed".** The head SHA was already reviewed at exactly
this commit, so the models were not re-run — the existing review was delivered
(or was already published). Use `/ai-review --force` to re-review anyway.

**My finding is "Not verified" in the Jira table.** The criterion could not be
judged from this diff — e.g. it belongs to another repository or needs runtime
evidence. It is deliberately never guessed.

**The review did not post a comment.** With `PUBLISH_TO_BITBUCKET=0` (default)
everything is a dry run: the public version stays as `comment-draft.md`. Post
it from the CLI (`--publish`) or the dashboard. If a run *was* published but the
PR head moved during the review, publication was skipped to avoid a stale
report.

**Not all findings are in the comment.** Findings below the severity/confidence
gate are collapsed under "Minor" and don't drive the verdict. The internal
report (`final-report.md`) always shows everything.

**Translation feedback feels nitpicky.** Reviewer D's MEDIUM/LOW findings are
advisory by design and never block a translator's merge; only HIGH/CRITICAL
(changed/harmful, broken placeholder) does.

**Where do I find old reviews?** Every run is stored and browsable in the
dashboard (`dev/jobs/`), including the raw reviewer reports, consensus and
comment draft.

**How much does a review cost?** Typically ~€0.04 (model rates of the
configured providers); the dashboard shows the cost of every review.

**Who is `MYBOT`?** A service account used by the automatic triggers; treat
it as "the AI reviewer" when you add it to a PR.

---

## 10. Related documents

- [Quick reference / cheat sheet](ai-pr-reviewer-cheatsheet.md)
- [Leaflet (printable one-pager)](../leaflet/)
- [Architecture](ai-bitbucket-pr-reviewer-architecture.md)
- [Deployment runbook (OpenShift)](ai-bitbucket-pr-reviewer-openshift-deployment.md)
- [Reviewer trigger design](ai-pr-reviewer-reviewer-trigger.md)
- [v0.2 improvements record](ai-pr-reviewer-improvements-v0.2.md)

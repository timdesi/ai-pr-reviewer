# AI Pull Request Reviewer — local milestone

On-demand AI review for Bitbucket Data Center, built in Node. This is the
**local CLI milestone** from `docs/ai-bitbucket-pr-reviewer-architecture.md`
(Phases 1–3, local workflow): a trigger that fetches a real PR, runs up to
four independent OpenCode reviewers in parallel (A, B, C on every PR; **D —
language, i18n & translation quality — joins when the PR changes translation
content**), runs a consensus agent, and produces one final report.

**Implemented:** CLI trigger, web UI dashboard, Bitbucket webhook listener
(`/ai-review` on a PR comment, or a configured user added as a reviewer),
one-at-a-time in-process queue, publication with a stale-SHA check
(`PUBLISH_TO_BITBUCKET`), and an **OpenShift deployment**
(single pod + PVC + edge Route; see below).

**Not implemented yet (next milestones):** SQLite job persistence + scheduler
with concurrency limit.

## Quick start

```bash
cd dev
cp .env.example .env   # fill in BITBUCKET_BASE_URL / BITBUCKET_API_TOKEN
```

Trigger a review with a PR URL or `KEY/slug#ID`:

```bash
npm run review -- ACME/acme-app#5566
npm run review -- https://bitbucket.example.com/projects/ACME/repos/acme-app/pull-requests/5566
```

Result artifacts land in `jobs/<project>-<repo>-PR<id>-<sha8>/`:

- `pr-context.md` — reviewer input (metadata + changed files + unified diff)
- `reviewer-{a,b,c,d}.json` — the independent reviewer reports
- `consensus-input.md` / `consensus.json` — consensus input + final report
- `final-report.md` — full internal report (incl. `notes` / audit trail)
- `comment-draft.md` — the public PR-comment version (no internal notes, adds a
  digest/verdict + "What's good" strengths), kept when nothing is published

## Web UI (optional dashboard)

```bash
npm run ui          # http://127.0.0.1:8123
```

The dashboard is a local single-page app that reads the same `jobs/` directory
the CLI writes to, so **past runs are fully browsable**: reviewer reports,
consensus, final report, comment draft, and every raw artifact. While a review
runs (either from the CLI or from the browser), the UI shows the live pipeline:

- stage timeline (fetch → review → consensus → render → publish)
- per-agent status, attempts, durations, and **streaming reply text** (SSE)
- the final report / comment draft rendered as markdown
- a publish button (posts the public comment version — `comment-draft.md` — with
  the same stale-SHA check as the CLI) and a "New review" form that starts a run
  in the server process

UI code lives in `ui/`; the server is `src/server.js`. One review runs at a
time; extra requests (from the UI or the webhook) wait in an in-process FIFO
queue. CLI and UI runs share the job store, so you can start a run in a
terminal with `npm run review` and watch it in the browser.

## Webhook (`/ai-review` on a PR comment, or a reviewer being added)

The dashboard server also listens for Bitbucket Data Center webhooks:

```bash
npm run ui          # serves POST /webhooks/bitbucket on the same port
```

Point a repository/project webhook at
`https://<host>:<port>/webhooks/bitbucket` with:

- **Events:** pull-request comment added (`pr:comment:added`) and pull-request
  reviewers updated (`pr:reviewer:updated`, needed for the reviewer trigger). From v0.2.4 also *Pull request opened* (`pr:opened`) and *Pull request modified* (`pr:modified`), for reviews of PRs that are opened or marked ready
- **Secret:** set `BITBUCKET_WEBHOOK_SECRET` in `.env` and the same value in
  the Bitbucket webhook config; deliveries are rejected (401) when the
  `X-Hub-Signature` HMAC-SHA256 does not match. No secret configured = no check.
- **Trigger (comment):** a PR comment whose text starts with `/ai-review`
  (whitespace / case tolerant, e.g. `/ai-review please`). When the PR head was
  already reviewed at exactly that commit, `/ai-review` does **not** re-run the
  models — it delivers the existing review comment instead (or explains that it
  was already published). Append `--force` (`/ai-review --force`) to force a
  full re-review regardless.
- **Trigger (auto):** ON for every repository by default; a user on
  `ALLOWED_REVIEWER_USERS` added as a PR reviewer (`pr:reviewer:updated`), or
  already a reviewer when the PR is opened (`pr:opened`) / marked ready
  (`pr:modified`) starts a review. Repositories on `AUTO_REVIEW_OFF_REPOS`
  (keyed by `PROJECT/repo-slug`) opt out. The `REVIEW_ON_REVIEWER_ADDED_SKIP`
  branch pairs never auto-review (sync merges).
- **Authorization:** when `ALLOWED_REVIEWER_USERS` is non-empty, the commenter (or,
  for reviewer triggers, the user who added the reviewer) must be in the list,
  otherwise the delivery is rejected (403). Matching is case-insensitive, and the
  username is read from `slug` / `userName` / `name` (Bitbucket Data Center 5.0+
  sends the login in `slug`).

Design notes, per-repository lists and open questions:
[`docs/ai-pr-reviewer-reviewer-trigger.md`](../docs/ai-pr-reviewer-reviewer-trigger.md).

The handler validates the event, resolves `projectKey/slug#prId` from
`pullRequest.fromRef.repository`, and enqueues a review — it responds
immediately (200/202), never blocking on model execution. Duplicates for the
same PR already in the queue/running are dropped silently. A trigger (automatic
or `/ai-review`) whose head was already reviewed at that commit is not re-run:
the existing review is delivered to the PR instead when it was not yet posted.
The review posts its comment when `PUBLISH_TO_BITBUCKET=1`; otherwise it is a
dry run.

## Publishing

Publishing is opt-in. The CLI posts the report when `PUBLISH_TO_BITBUCKET=1` is
set or `--publish` is passed, and the server (UI **and** webhook) posts when
`PUBLISH_TO_BITBUCKET=1`. Otherwise the run is a **dry run**: nothing is posted
to Bitbucket and the report is kept as `comment-draft.md`. To post the report as
a real PR comment:

```bash
npm run review -- ACME/acme-app#5566 --publish --yes
```

The `--yes` skips the confirmation prompt. Before publishing, the head SHA is
re-checked; if the PR changed since the review started, publication is skipped
(no stale review is posted).

## How it works

```
CLI trigger (src/cli.js)
  └─ src/pipeline.js  fetch PR + unified diff + changed files (Bitbucket REST)
       ├─ context: pr-context.md
       ├─ reviewers A/B/C run in parallel  (opencode run --agent pr-reviewer-*)
       │    └─ D (language/i18n) additionally joins when a changed path matches
       │       a translation pattern (default: `i18n/*.json`, `.po`, `.pot`)
       │    └─ JSON report validated (src/validate.js); continues with 2 of N
       ├─ consensus agent merges the reports (pr-consensus agent)
       │    └─ JSON report validated, evidence grounded (src/grounding.js) 
       └─ report rendered (src/report.js) → final-report.md + comment-draft.md
            └─ optional publish of the comment version with stale-SHA check
```

- Bitbucket Data Center REST API via `src/bitbucket.js` (Bearer token,
  `Accept: text/plain` for the unified diff).
- Agents live in `.opencode/agents/` (A = correctness/logic, B = runtime,
  persistence & compatibility, C = security, Jira requirements & tests,
  D = language, i18n & translation quality — joins only on translation PRs, plus
  `pr-consensus`). The four reviewer files are **generated** from
  `prompts/reviewer-base.md` + `prompts/lens-<a|b|c|d>.md`: edit those, then run
  `npm run build:agents` (`npm test` fails when the agents are stale).
- Models are configured in `.env` (`REVIEWER_MODEL_A/B/C/D`, `CONSENSUS_MODEL`).
- Reviewer D is activated per PR, not per repo: it joins whenever a changed
  file matches `TRANSLATION_PATH_PATTERNS` (default `i18n/*.json`, gettext
  `.po`/`.pot`). Its findings are rendered in a dedicated **"Language & content"**
  PR comment section; only HIGH/CRITICAL (meaning changed/harmful, broken
  placeholder) drives the merge verdict — MEDIUM/LOW are advisory.
- Per-repo **project context** (`contexts/<PROJECT>-<repo>.md`, plus the repo's
  own `AGENTS.md` when present) is injected into every review so the agents know
  the stack, conventions, and language rules that are invisible in a bare diff.
- The **comment** is author-facing: the heading is `## AI Review - <sha>` with
  the commit linked, then a one-line verdict (`✅ Nothing blocks merge` /
  `🟡 Worth addressing before merge` / …) with only the severities that actually
  occurred, then Summary,
  a **What's good** section (the consensus agent's verified `strengths` —
  rewarded, earned praise), and Findings rendered with impact as a
  blockquote, fixes as a numbered list when multi-step, and evidence as `diff`
  blocks so additions/removals get colours. Internal `notes` and any
  reviewer/agent attribution appear only in `final-report.md`, never in the
  comment.
- With `REVIEW_CHECKOUT=1`, the reviewed commit is shallow-checked out (Git is
  baked into the image) and the agents run with the checkout as their cwd, so
  they can `read`/`grep` base classes and config that are not in the diff. It is
  best-effort: any failure degrades to diff + context and never fails a review.
- A failed/invalid reviewer run is **never** treated as a clean review; the run
  aborts before consensus.

## Configuration

See `.env.example`. Key settings:

| Variable | Purpose |
| --- | --- |
| `BITBUCKET_BASE_URL` | Bitbucket Data Center base URL |
| `BITBUCKET_API_TOKEN` | HTTP access token (sent as `Authorization: Bearer`) |
| `VERIFY_TLS` | `false` disables TLS verification (internal CAs) |
| `REVIEWER_MODEL_A/B/C/D`, `CONSENSUS_MODEL` | OpenCode provider/model IDs (D = language/i18n reviewer; falls back to A when unset) |
| `TRANSLATION_PATH_PATTERNS` | comma-separated path regexes that mark a PR as a translation/content PR and enable reviewer D (default: `i18n/*.json`, `.po`, `.pot`) |
| `OPENCODE_BIN` | path to the opencode CLI |
| `OPENCODE_STANDALONE` | `0` (default) = `opencode run` uses the shared background service; `1` = per-run private opencode server (opt-in isolation / fresh provider keys) |
| `AGENT_MAX_RETRIES` | retries per agent stage |
| `REVIEWER_TIMEOUT_SECONDS` / `CONSENSUS_TIMEOUT_SECONDS` | per-run timeouts |
| `MAX_DIFF_BYTES` | diff budget for the agent context (default `300000`); over it, whole files are dropped — lockfiles/generated, then tests — and listed for the agents |
| `REVIEW_CONTEXT_DIR` | curated context, most general first: `<PROJECT>.md` (org-wide, stack-neutral), `stacks/*.md` (attached only when a changed path matches the file's `match:` regexes), `<PROJECT>-<repo>.md` (fallback `<repo>.md`); shipped in the image |
| `OPENCODE_AGENT_DIR` | dir with the `agents/` opencode loads for every run, passed as `OPENCODE_CONFIG_DIR` (default `.opencode`) — needed because agents run in the checkout or an empty per-job sandbox, never in the app dir |
| `FETCH_REPO_CONTEXT` | `1` (default) also attaches the repo's own `AGENTS.md` (head SHA) |
| `COMMENT_MIN_SEVERITY` / `COMMENT_MIN_CONFIDENCE` | public-comment gate (default `MEDIUM` / `0.5`): findings below either are listed compactly under "Minor" and don't drive the verdict |
| `APP_VERSION` | overrides the version shown in comments/reports (default: `package.json` version) |
| `REVIEW_CHECKOUT` | `1` = shallow-checkout the reviewed commit (git) into `WORKSPACE_ROOT` so reviewers can read real files; best-effort/non-fatal |
| `CHECKOUT_KEEP` | max worktrees kept per repo after pruning (PVC capacity guard), default `3` |
| `PUBLISH_TO_BITBUCKET` | `1` = post the report back to the PR (CLI and server/webhook); `0`/unset = dry run |
| `AUTO_REVIEW_OFF_REPOS` | comma-separated `PROJECT/repo-slug` entries with the automatic review trigger disabled (reviewer added / PR opened with a reviewer / draft marked ready); repositories not listed auto-review by default |
| `REVIEW_ON_REVIEWER_ADDED_SKIP` | comma-separated `SOURCE>TARGET` branch pairs (`*` = any characters, case-insensitive); pull requests between them never start an auto review, e.g. `develop>release/*,release/*>develop,release/*>release/*` |
| `JOBS_DIR` | where job artifacts are written |
| `HOST` / `PORT` | dashboard bind address / port (default `127.0.0.1:8123`) |

## Tests

```bash
npm test            # node --test tests/*.test.js (170 tests)
```

## Deployment (OpenShift)

The same server runs as a single-replica OpenShift Deployment (pod + 2 GiB PVC +
edge Route). The full build/deploy/verify runbook and the cluster-specific
gotchas live in
[`docs/ai-bitbucket-pr-reviewer-openshift-deployment.md`](../docs/ai-bitbucket-pr-reviewer-openshift-deployment.md).

Highlights:

- Container image `dev/Dockerfile`: cluster Node 20 base + bundled `opencode`
  (Bun) + `ripgrep`; no runtime npm registry access needed.
- Manifests in `dev/k8s/` (`deployment`, `service`, `route`, `pvc`,
  `configmap`, `00-trusted-ca`).
- All outbound traffic goes through the cluster egress proxy
  (`proxy.example.com:8080`); the app installs an undici proxy
  dispatcher in `src/proxy.js` so Node's `fetch` honors `HTTP(S)_PROXY`.

## Layout

```
src/
  cli.js        CLI entry point (trigger)
  config.js     .env loading + validation
  bitbucket.js  Bitbucket Data Center REST client
  context.js    reviewer / consensus context documents
  checkout.js   optional shallow git checkout of the reviewed commit (cwd for agents)
  opencode.js   `opencode run` subprocess wrapper (timeout + JSONL parsing)
  extractJson.js  trailing-JSON extraction from agent replies
  validate.js   report schema validation
  grounding.js  evidence check of consensus findings against diff/checkout
  diff.js       file-aware diff budget + new-file line numbers for the agents
  previous.js   previous review of the same PR (resolved / still open)
  version.js    app version shown in comments (package.json / APP_VERSION)
  pipeline.js   orchestration (fetch → reviewers → consensus → publish)
  report.js     comment + internal-report markdown rendering
  webhook.js    Bitbucket webhook parsing + signature verification
  proxy.js      undici proxy dispatcher (container egress; no-op locally)
  ui.js         human-readable console output
  server.js     dashboard server (REST + SSE + webhook + in-process runs)
ui/             dashboard (index.html, app.js, style.css)
contexts/       curated context: `<PROJECT>.md`, `stacks/<stack>.md`, `<PROJECT>-<repo>.md`
.opencode/agents/   the four OpenCode agents (reviewers generated from prompts/)
prompts/        reviewer base template + per-lens sections
Dockerfile      container image (Node 20 + opencode + ripgrep)
docker/         entrypoint, opencode config template, bundled binaries + provider
k8s/            OpenShift manifests
```
# AI PR Reviewer

**On-demand AI code review for Bitbucket Data Center and GitHub.**

Post a comment on a pull request and, a few minutes later, receive one
clear, human-written review in return: what is good, what is worth fixing,
and why — with concrete, code-level evidence.

The reviewer is **advisory and read-only**. It never opens pull requests,
never modifies code, and never auto-approves. It posts exactly one comment
per review and works with the review workflow your team already uses.

---

## Features

- **Four specialist reviewers in parallel.** Each runs with a dedicated
  lens: correctness and logic (A), data, persistence and compatibility (B),
  security, Jira requirements and tests (C), and language, i18n and
  translation quality (D, which joins automatically on translation PRs).
- **One consensus verdict.** A consensus agent weighs each finding, removes
  duplicates and noise, verifies the evidence, and produces a single
  digestible comment.
- **Screenshot transcription.** Images pasted into the PR description or
  comments are transcribed by a vision model, so UI changes are reviewed
  too.
- **Jira ticket context.** Linked tickets are fetched and attached to the
  review, so the reviewer judges the change against the ticket's intent
  and its **acceptance criteria** — with a per-criterion verdict.
- **Context-aware re-reviews.** Findings already explained in the PR
  discussion are marked resolved instead of being re-raised.
- **A real checkout, not just a diff.** Reviewers run against a checkout of
  the commit, plus your curated project context and the repository's own
  `AGENTS.md`.
- **Dashboard.** Live per-agent progress, costs in EUR, review history
  grouped by pull request, and a model switcher.
- **Manual or automatic triggers.** Start a review with an `/ai-review`
  comment, or automatically when a reviewer is added, a PR is opened, or a
  draft is marked ready.
- **Two platforms, parallel.** GitHub (`github:owner/repo#N` refs) and
  Bitbucket Data Center are independent backends on the same server — reviews
  pick their platform per pull request, so a GitHub-only or Bitbucket-only
  instance is just the one block filled in.

## Example review comment

```md
## AI Review - 3f8d1c4

✅ **Nothing blocks merge**

⚪ 1 LOW

**Summary:** Solid change. The criteria copy now respects the inherited
distinct flag via the specification builder, and the new query is covered.

**What's good**
- The builder reads criteria.getDistinct() instead of silently dropping it (QueryService.java)

**Findings**
#### 1. ⚪ LOW — Filtering is applied after pagination
> Results are sliced before the new UPPER(name) filter runs, so page 2
> can include rows the filter should have removed.

**Suggested fix:**
1. Apply filters before offset/limit in the specification.
```

Severity icons in the review are the app's own: `🔴` critical, `🟠` high,
`🟡` medium, `⚪` low — and the verdict line is `✅ Nothing blocks merge`,
`🟡 Worth addressing before merge`, or `🔴 Do not merge`.

## Quick start (local)

```bash
cp .env.example .env      # fill in BITBUCKET_BASE_URL / BITBUCKET_API_TOKEN
npm install
```

Trigger a review on any pull request:

```bash
npm run review -- ACME/acme-app#5566
npm run review -- https://bitbucket.example.com/projects/ACME/repos/acme-app/pull-requests/5566
npm run review -- gh:acme/widgets#42
npm run review -- https://github.com/acme/widgets/pull/42
```

Bare `owner/repo#N` refs default to Bitbucket; a `gh:` prefix (or a
GitHub `/pull/N` URL) reviews the GitHub PR. Set `GITHUB_TOKEN` in `.env` for
the GitHub backend (see `.env.example`).

Open the dashboard to watch it run and browse past reviews:

```bash
npm run ui                # http://127.0.0.1:8123
```

Requirements: Node.js ≥ 22 and the
[`opencode`](https://opencode.ai) CLI.

## Run it as a service

Point a Bitbucket webhook at the server and the team gets reviews without
touching a terminal:

1. Run the container (see `Dockerfile`) or the dashboard server (`npm run ui`).
2. Add a webhook to `POST /webhooks/bitbucket` with the Bitbucket secret
   (events: `pr:comment:added`, `pr:reviewer:updated`, `pr:opened`,
   `pr:modified`) — or `POST /webhooks/github` with `X-Hub-Signature-256`
   (events: `issue_comment`, `pull_request`).
3. Any allowlisted user writes `/ai-review` on a PR — or is added as a
   reviewer — and a review starts automatically.

The full operator guide is in
[`docs/ai-pr-reviewer-usage-guide.md`](docs/ai-pr-reviewer-usage-guide.md),
with a one-page version in
[`docs/ai-pr-reviewer-cheatsheet.md`](docs/ai-pr-reviewer-cheatsheet.md).

## How it works

```
PR + diff  →  build context (diff + project context + ticket + screenshots)
   │
   ├── Reviewer A  ─┐
   ├── Reviewer B  ─┼─→  Consensus agent  ─→  evidence check  ─→  comment
   ├── Reviewer C  ─┘        (weigh, dedupe, verify)
   └── Reviewer D   (only on translation/content PRs)
```

- Reviewers are OpenCode agents, each with its own specialist lens
  (`prompts/lens-*.md`, compiled into `.opencode/agents/`).
- The consensus step filters rather than accumulates: it keeps only
  distinct, relevant findings, re-checks quoted evidence, and caps
  low-confidence claims.
- Grounding is built in. A finding must point at lines that actually
  changed; otherwise it is flagged as unverified.
- Models are fully configurable — A/B/C/D, consensus and vision — per
  repository, and can be switched live from the dashboard.

Architecture and design decisions:
[`docs/ai-bitbucket-pr-reviewer-architecture.md`](docs/ai-bitbucket-pr-reviewer-architecture.md).

## Safety and trust model

- **Read-only, one comment per review.** The reviewer never opens or
  approves PRs.
- **Allowlist.** `ALLOWED_REVIEWER_USERS` gates who can trigger a review.
- **Signed webhooks.** Bitbucket deliveries are verified with an HMAC
  secret; GitHub deliveries (`X-Hub-Signature-256`) are verified per-platform.
- **No stale comments.** A review is published only if the head SHA has not
  moved since the review started.

## Development

```bash
npm test                  # full test suite
npm run build:agents      # regenerate reviewer agents from prompts/
```

## Deployment

A ready-to-build container image ships with the repository:

```bash
docker build --build-arg APP_VERSION=0.4.2 -t ai-pr-reviewer .
```

The image bundles Node 22, opencode, and ripgrep, runs as a non-root user,
and fetches all runtime dependencies during the build. It is configured
entirely through environment variables; see `.env.example`. Point it at
your own Bitbucket, model gateway, and container registry.

## Project layout

```
src/      application logic (platform clients, pipeline, Jira, vision, webhook, server)
ui/       dashboard (single-page app)
prompts/  reviewer lens templates, compiled to .opencode/agents/
contexts/ curated project and stack context fed to every review
scripts/  helper scripts (agent build, analysis, relay proxy)
docker/   container entrypoint and provider configuration template
docs/     architecture, usage guide, cheat sheet
tests/    unit and integration tests
```

## Releases

The full history — from the first diff-only reviews to context-aware
re-reviews, screenshot transcription, Jira acceptance-criteria verdicts,
and Reviewer D — is in
[`CHANGELOG.md`](CHANGELOG.md).

Webhook live test - temporary.

<div align="center">

# AI PR Reviewer

A second pair of eyes on every pull request — in minutes, not days.

Comment `/ai-review` on a pull request and get back one clear,
evidence-backed review: what's good, what's worth fixing, and why.

Works with **Bitbucket Data Center** and **GitHub** · Node.js ≥ 22 ·
Powered by [OpenCode](https://opencode.ai)

</div>

---

## Contents

- [Overview](#overview)
- [Features](#features)
- [Example review](#example-review)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Safety & trust](#safety--trust)
- [Deployment](#deployment)
- [Development](#development)
- [Project layout](#project-layout)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

Code review is the best quality gate we have — and also the biggest queue.
AI PR Reviewer doesn't replace your teammates; it gives them a head start.

It is **advisory and read-only**: one comment per review, never an approval,
merge, decline, or code change.

## Features

| Capability | Description |
|---|---|
| Parallel specialist reviewers | **A** correctness & logic · **B** data, persistence & compatibility · **C** security, Jira requirements & tests · **D** language, i18n & translation quality (joins automatically on translation PRs) |
| Consensus agent | Weighs each finding, drops duplicates and noise, re-checks the evidence, and writes the final comment |
| Jira awareness | Fetches linked tickets and judges the change against the ticket's acceptance criteria, with a per-criterion verdict |
| Screenshot reading | Images pasted into the PR are transcribed by a vision model, so UI changes get reviewed too |
| Smart re-reviews | Findings already explained in the PR discussion are marked resolved instead of re-raised |
| Real checkout | Reviewers run against the actual commit plus your curated project context and the repo's own `AGENTS.md` — not just a diff |
| Dashboard | Live per-agent progress, cost per review, history grouped by pull request, and a model switcher |
| Two platforms | Bitbucket Data Center and GitHub are independent backends on the same server; each PR picks its own |

## Example review

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

Verdicts map to the app's status colors:

| Verdict | Meaning |
|---|---|
| 🔴 **Do not merge** | At least one `CRITICAL` finding |
| 🟠 **Do not merge** | At least one `HIGH` finding |
| 🟡 **Worth addressing before merge** | `MEDIUM` findings only |
| ✅ **Nothing blocks merge** | `LOW` findings or a clean review |

Findings below the configured severity/confidence gate are collapsed into a
compact **Minor** list and don't drive the verdict.

## Quick start

You need **Node.js ≥ 22** and the [`opencode`](https://opencode.ai) CLI, with
access to at least one model provider (see [Configuration](#configuration)).

```bash
git clone <this-repo> && cd ai-pr-reviewer
npm install
cp .env.example .env        # then fill in your Bitbucket and/or GitHub credentials
```

Review a pull request — safe by default, it only writes a draft locally:

```bash
npm run review -- ACME/acme-app#5566                     # Bitbucket
npm run review -- gh:acme/widgets#42                     # GitHub
npm run review -- https://github.com/acme/widgets/pull/42 # GitHub URL
npm run review -- ACME/acme-app#5566 --publish --yes     # actually post it
```

Open the dashboard to watch it run and browse past reviews:

```bash
npm run ui                  # → http://127.0.0.1:8123
```

> **Reference formats.** `PROJECT/repo#N` means Bitbucket. A `gh:` prefix,
> `github:owner/repo#N`, or a GitHub `/pull/N` URL means GitHub.
> CLI options: `--publish` · `--yes` · `--json` · `--quiet` · `--help`.

Each run leaves its artifacts in its own folder under `jobs/` — the full
internal report (`final-report.md`), the public comment draft
(`comment-draft.md`), and every reviewer's raw output.

## Usage

Let people trigger reviews without touching a terminal:

1. **Start the server** — as a container (see [Deployment](#deployment)) or with
   `npm run ui`.
2. **Add a webhook** to your repository:
   - Bitbucket → `POST /webhooks/bitbucket` (events `pr:comment:added`,
     `pr:reviewer:updated`, `pr:opened`, `pr:modified`), signed with
     `BITBUCKET_WEBHOOK_SECRET`
   - GitHub → `POST /webhooks/github` (events `issue_comment`, `pull_request`),
     signed with `GITHUB_WEBHOOK_SECRET` (`X-Hub-Signature-256`)
3. **Trigger a review** any of three ways:

| Trigger | How |
|---|---|
| Comment | Write `/ai-review` on the PR (`--force` re-reviews an unchanged head) |
| Add the reviewer | Add the AI reviewer account as a PR reviewer |
| Open / ready | Open a PR, or mark a draft ready, with the AI reviewer attached |

Branch pairs such as `develop ↔ release/*` can be skipped
(`REVIEW_ON_REVIEWER_ADDED_SKIP`), and auto-review can be turned off per
repository. Full details in the
[usage guide](docs/ai-pr-reviewer-usage-guide.md); a one-page version lives in
the [cheat sheet](docs/ai-pr-reviewer-cheatsheet.md).

## Configuration

Everything is driven by environment variables — copy `.env.example` and edit.
The ones you'll touch first:

| Variable | What it does |
|---|---|
| `BITBUCKET_BASE_URL` · `BITBUCKET_API_TOKEN` | Bitbucket Data Center access |
| `GITHUB_TOKEN` · `GITHUB_API_BASE_URL` | GitHub access (use `GITHUB_API_BASE_URL` for GitHub Enterprise Server) |
| `PUBLISH_TO_BITBUCKET` · `PUBLISH_TO_GITHUB` | `0` = dry run (default), `1` = post the comment |
| `ALLOWED_REVIEWER_USERS` | Who may trigger a review (empty = anyone) |
| `AUTO_REVIEW_OFF_REPOS` · `GITHUB_AUTO_REVIEW_OFF_REPOS` | Repos where automatic triggers are disabled |
| `REVIEWER_MODEL_A/B/C/D` · `CONSENSUS_MODEL` · `VISION_MODEL` | Which model plays which role |
| `COMMENT_MIN_SEVERITY` · `COMMENT_MIN_CONFIDENCE` | Gate for what appears in the public comment |
| `REVIEW_CONTEXT_DIR` · `FETCH_REPO_CONTEXT` | Per-repo curated context and `AGENTS.md` |
| `REVIEWER_PARALLELISM` | `0` = all reviewers in parallel, `1` = one at a time (small hosts) |

> A Bitbucket-only or GitHub-only instance simply fills in one block and leaves
> the other empty.

### Models

Reviewers are [OpenCode](https://opencode.ai) agents, so any model your OpenCode
install can reach works. Model IDs use OpenCode's `provider/model` form, e.g.
`REVIEWER_MODEL_A=llmgw-msp/DeepSeek-V4-Flash`.

[`docker/opencode.json.template`](docker/opencode.json.template) shows a
complete multi-provider setup against an OpenAI/Anthropic-compatible gateway.
Replace the placeholder host (`llm-gateway.example.com`) and credentials with
your own, or point the IDs at providers you already have configured.

Screenshots pasted into a PR are transcribed by a **`pr-vision` OpenCode
agent** (`prompts/vision-base.md`, compiled to `.opencode/agents/pr-vision.md`)
that gets the image attached via `--file`; it never reads the repo, and its
routing/auth come entirely from the OpenCode provider config — application
source carries no provider name, token env-var name, or gateway URL. The only
knob that selects the vision provider/model is `VISION_MODEL`, an image-capable
model id passed to the agent at run time, exactly like the reviewer/consensus
models; the remaining `VISION_*` knobs are safety caps (image count, size, and
timeout limits), never provider or token values.

- `VISION_MODEL` must be **image-capable** (declare `capabilities.input` with
  `image` in the OpenCode config).
- The consensus model reads roughly 60 KB of reviewer reports, so pick one that
  handles long context well.

## How it works

Every review runs through the same pipeline, whether it was triggered from the
CLI, the dashboard, or a webhook:

```text
                    ┌─────────────────────────────┐
   PR opened ──────▶│ 1. Fetch PR                 │
                    │    metadata · diff · files  │
                    └──────────────┬──────────────┘
                                   ▼
                    ┌─────────────────────────────┐
                    │ 2. Build context            │
                    │    diff · project · Jira ·  │
                    │    screenshots (vision)     │
                    └──────────────┬──────────────┘
                                   ▼
        ┌──────────────┬───────────┴───────────┬──────────────┐
        ▼              ▼                       ▼              ╎
 ┌────────────┐ ┌────────────┐         ┌────────────┐        ╎ translation
 │ 3a. A      │ │ 3b. B      │         │ 3c. C      │         ╎ PRs only
 │ correctness│ │ data &     │         │ security · │         ╎
 │ & logic    │ │ compat     │         │ Jira · tests│        ▼
 └──────┬─────┘ └──────┬─────┘         └──────┬─────┘  ┌────────────┐
        │              │                      │        │ 3d. D      │
        │              │                      │        │ language / │
        │              │                      │        │ i18n       │
        │              │                      │        └──────┬─────┘
        └──────────────┴──────────┬───────────┴───────────────┘
                                   ▼
                    ┌─────────────────────────────┐
                    │ 4. Consensus                │
                    │    weigh · dedupe · verify  │
                    └──────────────┬──────────────┘
                                   ▼
                    ┌─────────────────────────────┐
                    │ 5. Publish one comment      │
                    │    (or local draft)         │
                    └─────────────────────────────┘
```

1. **Fetch the PR** — metadata, the diff, and the list of changed files.
2. **Build the context** — the diff, per-repo project context (and the repo's own
   `AGENTS.md`), the linked Jira ticket, and any screenshots transcribed by the
   vision model.
3. **Run the reviewers in parallel** — A (correctness), B (data & compatibility),
   C (security, Jira, tests), and D (language/i18n, only on translation PRs).
4. **Reach consensus** — the consensus agent weighs each finding, drops
   duplicates and noise, re-checks the quoted evidence, and caps low-confidence
   claims.
5. **Publish one comment** — the final, de-duplicated review is posted to the PR
   (or written as a local draft in dry-run mode).

Design principles that shape each stage:

- **Lenses, not clones.** Each reviewer has its own specialist prompt
  (`prompts/lens-*.md`, compiled into `.opencode/agents/`), so they catch
  different things rather than repeating each other.
- **Grounded by design.** A finding must reference lines that actually changed,
  otherwise it's marked unverified.
- **Filter, don't accumulate.** Only distinct, relevant findings reach the final
  comment; low-confidence claims are collapsed into a compact **Minor** list.
- **Resilient.** If a single reviewer fails, the others still run and consensus
  proceeds (at least two reviewers must succeed).
- **Fully configurable models.** Every slot is configurable per repository and
  switchable live from the dashboard.

Deeper dive: [architecture & design decisions](docs/ai-bitbucket-pr-reviewer-architecture.md).

## Safety & trust

- **Read-only.** One advisory comment per review — never approves, merges,
  declines, or modifies code.
- **Allowlist.** `ALLOWED_REVIEWER_USERS` controls who can trigger reviews.
- **Signed webhooks.** Bitbucket and GitHub deliveries are HMAC-verified. The
  GitHub endpoint is disabled (fails closed) until a secret is set.
- **No stale comments.** A review is published only if the head commit hasn't
  moved since the review started.
- **Safe by default.** Publishing is off until you turn it on.

## Deployment

A container image is built from the included `Dockerfile`:

```bash
docker build --build-arg APP_VERSION=0.5.0 -t ai-pr-reviewer .
```

The image bundles Node 22, OpenCode, and ripgrep, runs as a non-root user, and
is configured entirely through environment variables (see `.env.example`). At
start-up the entrypoint renders the OpenCode config from
`docker/opencode.json.template`, substituting your environment values.

Point it at your own Bitbucket/GitHub, model gateway, and container registry.
Remember to replace the template's placeholder gateway host before building for
real use.

### Zero-divergence rule

**Code is never edited in a pack; deployment differences are env + build-config
only.** Application source (`src/`) carries no provider name, token env-var
name, or gateway URL — every deployment-specific value comes from environment
variables and build-config (`docker/`, `.env.example`). A deployed pack that
mirrors the public `src/` therefore behaves identically under the same env, and
never needs a fork or a patch. This holds for screenshots too: the `pr-vision`
agent and its `VISION_MODEL` come from config/env, so no vision-specific
routing lives in source either.

### Syncing a deployment pack

Copy-based, one command — no patch or merge step:

```bash
# NOTE: `--delete` removes anything in the destination that is not in the
# source. Always keep pack-local paths excluded, and preview with --dry-run
# first, so a sync can never silently wipe local-only build/deploy files:
rsync --archive --dry-run --delete <repo>/src/ <pack>/src/ --exclude local-only/   # preview
rsync --archive --delete <repo>/src/ <pack>/src/ --exclude local-only/             # apply
```

Then verify source parity (the diff must be empty):

```bash
diff -rq <repo>/src <pack>/src && echo "in sync"
```

On a release, bump the pack's image tag and rebuild; the app itself is fetched
in full from the public repo, so a pack never accumulates a source fork.

## Development

```bash
npm test                    # build-check agents + run the full test suite
npm run build:agents        # regenerate .opencode/agents/ from prompts/
```

A `pre-push` hook in `.githooks/` guards against committing internal or
corporate strings. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

## Project layout

```
src/        application logic — platform clients, pipeline, Jira, vision, webhooks, server
ui/         single-page dashboard
prompts/    reviewer lens templates (compiled into .opencode/agents/)
contexts/   curated project & stack context fed into every review
scripts/    helper scripts (agent build, analysis, relay proxy)
docker/     container entrypoint and provider config template
docs/       architecture, usage guide, cheat sheet
tests/      unit and integration tests
```

## Documentation

| Resource | Description |
|---|---|
| [Usage guide](docs/ai-pr-reviewer-usage-guide.md) | The full operator guide |
| [Cheat sheet](docs/ai-pr-reviewer-cheatsheet.md) | One page: triggers, verdicts, config, troubleshooting |
| [Architecture](docs/ai-bitbucket-pr-reviewer-architecture.md) | Design and decisions |
| [Changelog](CHANGELOG.md) | Release history |

## Contributing

Ideas, bug reports, and pull requests are very welcome. Before you open one:

1. Run `npm test` — everything should pass.
2. Keep reviewer behaviour changes in `prompts/` and run `npm run build:agents`.
3. Enable the `pre-push` hook (above) so no internal strings slip through.

## License

Released under the [MIT License](LICENSE).
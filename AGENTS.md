# AGENTS.md — AI PR Reviewer

Orientation for humans and AI agents working in this repo. This file is part of
the product itself: reviewers read a repo's own `AGENTS.md` as context when
reviewing its pull requests — so keep it honest and current.

## What this project is

A comment `/ai-review` on a Bitbucket Data Center or GitHub pull request
produces one evidence-backed review comment. Four parallel specialist reviewers
(A/B/C, D joins on translation PRs), one consensus agent, Jira
acceptance-criteria awareness, vision transcription of pasted screenshots, and
a live dashboard. **Advisory and read-only**: one comment per review, never an
approval, merge, decline, or code change.

## Environment & commands

- Node.js ≥ 22, native ESM (`"type": "module"`). There is no bundler or build
  step for application code.
- `.env.example` documents every config knob; `src/config.js` reads it via typed
  getters. No config value should be hard-coded in modules.

```bash
npm test                # agent build-check + full node:test suite (344 tests)
npm run review          # one-shot review via the CLI (src/cli.js)
npm run ui              # run the dashboard server (src/server.js)
npm run build:agents    # regenerate .opencode/agents/ from prompts/ + scripts/build-agents.mjs
```

`npm test` first runs `scripts/build-agents.mjs --check`, which fails if
`.opencode/agents/*` are out of sync with `prompts/`.

## Where things live

| Path | Role |
|---|---|
| `src/bitbucket.js` `src/github.js` | platform clients; PR + diff fetch, comments |
| `src/webhook.js` `src/webhook-github.js` | webhook entry points per platform |
| `src/pipeline.js` | orchestrates fetch → reviewers → consensus → publish |
| `src/context.js` | assembles review context: diff, Jira, repo `AGENTS.md`, curated `contexts/` |
| `src/contextsEditor.js` | dashboard "Context" API: list/read/write/delete the curated context files (`REVIEW_CONTEXT_DIR`), validated + atomic |
| `src/contextGen.js` + `prompts/context-gen-base.md` | dashboard "✨ AI draft": the `context-gen` agent drafts/refines a repo's context file from developer notes (reviewable draft, never auto-saved) |
| `src/jira.js` | linked-ticket acceptance criteria, per-criterion verdicts |
| `src/prImages.js` | screenshot transcription for UI changes (via the `.opencode/agents/pr-vision.md` agent, sourced from `prompts/vision-base.md`) |
| `src/checkout.js` | real-commit checkout: shallow bare fetch into `WORKSPACE_ROOT` + per-repo worktree + disk maintenance |
| `src/server.js` `src/ui.js` `src/pulls.js` | dashboard + stats |
| `src/discussion.js` `src/previous.js` | mark already-explained findings resolved, avoid repeats |
| `prompts/` | reviewer base + lens templates → **compiled** to `.opencode/agents/*` |
| `contexts/` | curated project/stack context fed into every review |
| `docker/` | container entrypoint + provider template (placeholder for the real build) |
| `tests/` | one `node:test` file per module |

## Conventions

- **Reviewer behaviour lives in `prompts/`.** Edit `prompts/` (base + lens-a/b/c/d),
  run `npm run build:agents`. `.opencode/agents/*` are build output — do not
  hand-edit them; keep `npm test`'s sync check green.
- **Best-effort, non-fatal optional work.** Everything can run unattended.
  Optional helpers (checkout, disk reclaim, cache warm) return or log failures
  (`log.warn`) and must never turn a whole review into a hard failure unless
  there is genuinely nothing to review. Preserve that pattern in new code.
- **Concurrency is real.** Reviews on the same repo overlap. Checkout uses
  mkdir-based per-repo locks and refcounted active-worktree protection.
  Re-check state under the lock (no TOCTOU) and never delete something another
  review may still be reading. Disk maintenance (gc / LRU eviction) must skip
  active or locked repos.
- **Disk hygiene is a first-class concern.** Bare-repo pack counts and
  workspace size must stay bounded (`CHECKOUT_GC_PACKS`,
  `CHECKOUT_WORKSPACE_MAX_BYTES`, `DISK_MIN_FREE_BYTES`, graceful ENOSPC
  reclaim). See `src/checkout.js`/`src/pipeline.js` — unbounded growth already
  caused a live outage.
- **Log with context.** Use the `log` module everywhere; background failures
  need enough context to debug from logs alone. Never `console.log` raw.
- **Pre-push hook.** `.githooks/pre-push` blocks internal/corporate strings in
  commit messages, diffs, and the pushed tree. Enable once per clone with
  `git config core.hooksPath .githooks`. Keep the public tree portable: no
  hostnames, tokens, or deployment identifiers.

## Working here

1. Small, focused changes with a regression test for bug fixes.
2. Run `npm test` — all 344 must pass — before pushing.
3. The real deployment is built from a separate local copy; changes here are
   mirrored over at release time. Never check in deployment-specific values.
4. Let the bot's AI review run on a PR before merging — a fresh `ai-review`
   trigger comment costs a few minutes and catches what human review misses.

## Documentation

See README → "Documentation": usage guide, cheatsheet, architecture,
changelog.

# AI PR Reviewer — Cheat Sheet

One-page quick reference. Full details: [`ai-pr-reviewer-usage-guide.md`](ai-pr-reviewer-usage-guide.md).

---

## Start a review — three ways

| Trigger | How |
| --- | --- |
| **Comment** | `/ai-review` on the pull request (also `ai-review`, `/ai-review please`). `--force` re-reviews an unchanged head. |
| **Reviewer** | Add the AI reviewer user (e.g. `MYBOT`) as PR reviewer → review starts automatically. |
| **Opened / ready** | A non-draft PR opened, or a draft marked ready, with the AI reviewer among its reviewers → review starts. |

- Merge-branch PRs (`develop ↔ release/*`, release ↔ release) are **skipped**.
- Only users on `ALLOWED_REVIEWER_USERS` can trigger (empty = anyone).
- Reviews are **read-only** — one advisory comment, never approve/merge/decline.
- Typical: **~3 min**, **~€0.04** per review.

---

## Read the verdict

| Result | When |
| --- | --- |
| 🔴 **Do not merge** — critical issues | ≥ 1 CRITICAL |
| 🟠 **Do not merge** — high-severity issues | ≥ 1 HIGH |
| 🟡 **Worth addressing before merge** | MEDIUM only |
| ✅ **Nothing blocks merge** | LOW or clean |

Severity: `CRITICAL` 🔴 · `HIGH` 🟠 · `MEDIUM` 🟡 · `LOW` ⚪
(severity counts shown next to the verdict; only severities that occurred).

**A finding = title + file:line + impact + evidence (code verbatim) + suggested fix.**
Below-threshold findings are collapsed under **"Minor"** (do not drive the verdict).
Translation PRs get a **"Language & content"** section (D, advisory below HIGH).

---

## CLI

```bash
cd dev
cp .env.example .env                     # set BITBUCKET_BASE_URL / BITBUCKET_API_TOKEN
npm run review -- ACME/acme-app#5566    # dry run by default
npm run review -- ACME/acme-app#5566 --publish --yes   # post the comment
npm run review -- https://host/projects/KEY/repos/slug/pull-requests/ID
```

Options: `--publish` · `--yes` · `--json` · `--quiet` · `--help`

Artifacts → `dev/jobs/<PROJECT>-<repo>-PR<id>-<sha8>/`:
`pr-context.md`, `reviewer-{a,b,c,d}.json`, `consensus.json`,
`final-report.md` (internal, with notes), `comment-draft.md` (public).

---

## Dashboard

```bash
npm run ui      # http://127.0.0.1:8123
```

Live pipeline + streaming agent replies, per-run cost, publish button,
new-review form, browsable history of all runs.

---

## Operators — key config (`.env`)

| Variable | Default / meaning |
| --- | --- |
| `BITBUCKET_BASE_URL`, `BITBUCKET_API_TOKEN` | **required** |
| `PUBLISH_TO_BITBUCKET` | `0` = dry run (default); `1` = post comment |
| `ALLOWED_REVIEWER_USERS` | who may trigger (empty = anyone) |
| `AUTO_REVIEW_OFF_REPOS` | repos with auto-review disabled (all ON by default) |
| `REVIEW_ON_REVIEWER_ADDED_SKIP` | merge pairs that never auto-review, e.g. `develop>release/*` |
| `TRANSLATION_PATH_PATTERNS` | marks a PR as translation/content → reviewer D joins |
| `REVIEWER_MODEL_A/B/C/D`, `CONSENSUS_MODEL` | OpenCode model IDs per slot |
| `BITBUCKET_WEBHOOK_SECRET` | webhook HMAC secret (401 without it) |

Webhook → `POST /webhooks/bitbucket`; events: `pr:comment:added`,
`pr:reviewer:updated`, `pr:opened`, `pr:modified`.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Nothing happens | Check allowlist, webhook, and merge-skip pairs |
| "Already reviewed" | Head already at this SHA → use `/ai-review --force` |
| No comment posted | `PUBLISH_TO_BITBUCKET=0` (dry run) or head moved during review |
| Jira "Not verified" | Criterion not judgeable from this diff — never guessed |
| Some findings only "Minor" | Below severity/confidence gate; full list in `final-report.md` |

---

*Repo docs: `docs/` · printable leaflet: `leaflet/`*

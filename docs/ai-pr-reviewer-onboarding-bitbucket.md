# Onboarding a team — Bitbucket Data Center

Quick start for teams who want AI PR Reviewer on their Bitbucket Data Center
repositories. Two parties are involved:

| Who | Does what |
| --- | --- |
| **Service operator** (runs the reviewer) | Registers your team's Bitbucket users on the allowlist and gives you the webhook URL + secret |
| **Your team** | Adds one webhook to each repository (or project) that should be reviewed |

No code or pipeline changes are needed in your repositories.

---

## 1. Operator: register the team's users

The allowlist is `ALLOWED_REVIEWER_USERS` (comma-separated Bitbucket
usernames, see `.env.example`). It does two things:

- Only listed users can trigger a review (`/ai-review` comment, reviewer added,
  PR opened with a listed user as reviewer).
- A listed user added as a PR reviewer starts an automatic review.

Collect the Bitbucket usernames from the team, add them to the allowlist in the
deployment configuration and roll out the change. Optional per-repo settings:

| Variable | Use |
| --- | --- |
| `AUTO_REVIEW_OFF_REPOS` | `PROJECT/repo-slug` list that opts out of automatic reviews (`/ai-review` still works) |
| `REVIEW_ON_REVIEWER_ADDED_SKIP` | Branch pairs (e.g. `release/*>develop`) that never start an automatic review |

Then send the team the **webhook URL** and **secret** over a private channel.
Do not paste the secret into tickets, wikis or the repository.

---

## 2. Team: add the webhook

In Bitbucket: **Repository settings → Webhooks → Create webhook**
(or **Project settings → Webhooks** to cover every repository in a project).
You need repository (or project) admin permission.

| Field | Value |
| --- | --- |
| Name | `ai-pr-reviewer` |
| URL | `<webhook URL from the operator>` — ends in `/webhooks/bitbucket` |
| Events | Pull request: **Comment added** (`pr:comment:added`), **Reviewers updated** (`pr:reviewer:updated`), **Opened** (`pr:opened`), **Modified** (`pr:modified`) |
| SSL verification | As told by the operator (off when the service uses an internal CA) |
| Secret | `<secret from the operator>` |

Leave every other event unticked. Use **Test connection** to check the URL —
a successful test is acknowledged and starts no review.

---

## 3. Verify

1. Open a pull request in the configured repository.
2. Comment `/ai-review` as a user on the allowlist.
3. After about 3 minutes, one review comment appears on the PR.

Other ways to start a review: add an allowlisted user as PR reviewer (the person
adding must be allowlisted too), or open a (non-draft) PR with an allowlisted user
already among the reviewers. Append
`--force` to `/ai-review` to re-review an unchanged commit. Details:
[usage guide](ai-pr-reviewer-usage-guide.md) and
[cheat sheet](ai-pr-reviewer-cheatsheet.md).

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Nothing happens after `/ai-review` | Commenting user is not on the allowlist, or `pr:comment:added` is not ticked |
| Webhook delivery shows 401 | Secret differs from the service's `BITBUCKET_WEBHOOK_SECRET` |
| Webhook delivery shows 403 | The acting user is not on the allowlist |
| Delivery fails to connect / TLS error | Wrong URL, service not reachable from Bitbucket, or SSL verification needs to be off |
| Auto-review does not start | no allowlisted user is among the PR reviewers, the PR is a draft, the branch pair is in the skip list, or the repo is in `AUTO_REVIEW_OFF_REPOS` |
| Existing review is re-delivered instead of a new one | The commit was already reviewed; use `/ai-review --force` |

Bitbucket's webhook page lists recent deliveries with status codes — start there.

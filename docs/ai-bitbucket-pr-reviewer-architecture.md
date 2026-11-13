# AI-Powered Bitbucket Pull Request Reviewer

**Architecture version:** 2.1\
**Status:** Proposed implementation baseline\
**Bitbucket:** Atlassian Bitbucket Data Center 9.4.26\
**Runtime:** OpenShift / Kubernetes\
**Webhook and orchestration:** Python + FastAPI\
**Persistence:** SQLite on a persistent volume\
**AI execution:** OpenCode CLI\
**Repository access:** Git and shell\
**Bitbucket integration:** Bitbucket Data Center REST API

------------------------------------------------------------------------

## 1. Purpose

Build an on-demand AI pull-request review service for Bitbucket Data
Center. An authorized user triggers a review by adding the comment
`/ai-review` to a pull request.

The service queues the request, checks out the exact pull-request
revision, and runs three independent AI reviewers in parallel. Each
reviewer examines the whole PR. A consensus agent then verifies,
deduplicates, and prioritizes the findings. The service validates the
result and publishes one summary comment, provided the PR has not
changed since the review started.

The initial implementation deliberately avoids unnecessary
infrastructure: no MCP server, PostgreSQL, message broker, or separate
AI orchestration framework.

## 2. Decisions and scope

### 2.1 Confirmed design decisions

-   Trigger: a PR comment containing `/ai-review`.
-   Bitbucket: Data Center 9.4.26.
-   Webhook event: pull-request comment added (`pr:comment:added`);
    verify exact event support and payload against the deployed
    instance.
-   Webhook service and coordinator: Python + FastAPI.
-   Job persistence: SQLite, stored on a persistent volume.
-   AI execution: OpenCode CLI.
-   Repository inspection: Git and shell.
-   Bitbucket reads and publication: Bitbucket REST API.
-   Review strategy: three independent reviewers each review the entire
    PR.
-   Consolidation: one consensus agent after the three reviews finish.
-   Publication: one summary comment per successful review attempt.
-   Initial concurrency: two PR reviews at once.
-   Initial deployment: one active application pod owning the SQLite
    database.
-   No MCP in the first version.

### 2.2 Goals

-   Low setup and operational complexity.
-   Efficient token use and parallel reviewer execution.
-   Durable job tracking and bounded retries.
-   Isolation between concurrently reviewed PRs.
-   No stale review results published against a newer PR revision.
-   Read-only AI review with least-privilege credentials.
-   Observable latency, usage, errors, and review quality.

### 2.3 Non-goals

The first version does not automatically approve, merge, decline, or
modify PRs. It does not automatically fix code. Build/test execution is
optional and must run in a restricted environment because repository
code is untrusted.

## 3. Architecture

``` mermaid
flowchart TD
    A[Bitbucket Data Center 9.4.26] -->|pr:comment:added webhook| B[FastAPI endpoint]
    B --> C[Verify signature, event, trigger and authorization]
    C --> D[(SQLite on persistent volume)]
    D --> E[Scheduler: max 2 concurrent PR reviews]
    E --> F[Isolated PR workspace A]
    E --> G[Isolated PR workspace B]
    F --> A1[Reviewer A]
    F --> A2[Reviewer B]
    F --> A3[Reviewer C]
    G --> B1[Reviewer A]
    G --> B2[Reviewer B]
    G --> B3[Reviewer C]
    A1 --> H[Consensus A]
    A2 --> H
    A3 --> H
    B1 --> I[Consensus B]
    B2 --> I
    B3 --> I
    H --> J[Validate report and current PR SHA]
    I --> K[Validate report and current PR SHA]
    J --> L[Bitbucket REST API: one summary comment]
    K --> L
```

Each PR review has its own workspace, process outputs, logs, and
persisted stage results. The reviewers for a given PR use the same
pinned source snapshot, but do not see one another's reports before
their independent reviews are complete.

## 4. Components

### 4.1 FastAPI service

Responsibilities:

-   Receive Bitbucket webhook POST requests.
-   Verify webhook authenticity using the configured mechanism.
-   Filter for `pr:comment:added`.
-   Accept only an authorized `/ai-review` command.
-   Resolve the repository, PR ID, comment ID, source SHA, and target
    SHA where available.
-   Insert a durable job in SQLite.
-   Return quickly after the job is committed.
-   Schedule work without blocking the HTTP request on model execution.

Do not perform AI review synchronously inside the webhook handler.

### 4.2 SQLite

SQLite stores job metadata, state, retry information, per-agent results,
final reports, and publication status.

Recommended settings and rules:

-   Enable WAL mode.
-   Configure a busy timeout.
-   Keep transactions short.
-   Never hold a write transaction while waiting for Git, OpenCode, or
    Bitbucket.
-   Claim jobs transactionally.
-   Persist stage results before advancing to the next stage.
-   Enable foreign-key enforcement on each connection.
-   Use a persistent volume with SQLite-compatible locking semantics.

SQLite is not a distributed database. The initial deployment uses one
active application pod and one database owner. Do not run multiple
independent replicas against the same SQLite file on arbitrary shared
network storage.

### 4.3 Scheduler and worker orchestration

Initial configuration:

``` env
MAX_CONCURRENT_REVIEWS=2
```

Each active PR review starts three reviewer processes in parallel. When
its reviewers finish successfully, one consensus process starts. With
two active PRs, up to six reviewer processes can run at once, plus
consensus processes for PRs whose reviewers have completed.

Additional requests remain queued in SQLite until a slot is available.
Apply explicit timeouts and resource limits to all subprocesses.

### 4.4 Git and shell

Use Git and bounded shell commands to:

-   Fetch the repository and required refs.
-   Check out the pinned PR source SHA.
-   Resolve the target revision and merge base.
-   Generate the PR diff and changed-file list.
-   Search relevant source, callers, tests, and configuration.
-   Optionally run deterministic checks and collect bounded output.

Use a separate directory per job. Do not construct shell commands by
concatenating untrusted webhook fields. Prefer subprocess argument
arrays, validated identifiers, fixed working directories, and explicit
exit-code checks.

Do not silently truncate a diff while claiming the whole PR was
reviewed. If context limits require partitioning or summarization,
record that limitation in the review result.

### 4.5 OpenCode agents

Configure four agents:

-   `pr-reviewer-a`
-   `pr-reviewer-b`
-   `pr-reviewer-c`
-   `pr-consensus`

All three reviewers independently inspect the complete PR and relevant
surrounding code. They should consider correctness, regressions,
security, reliability, concurrency, API contracts, and test gaps.
Differences in model or prompt may encourage diversity, but no reviewer
is restricted to one defect category.

Each reviewer returns structured JSON. Consensus begins only after all
required reviewer outputs are valid. It verifies claims against the
source, deduplicates findings, and preserves valid findings even if only
one reviewer found them. Consensus is not a majority vote.

Agent model IDs, provider configuration, and timeouts must be
externalized. Reviewer processes must not modify source code or publish
comments.

### 4.6 Bitbucket REST API

Use the REST API for PR metadata and final comment publication.
Implement endpoints and authentication according to Bitbucket Data
Center 9.4.26, not Bitbucket Cloud.

Only the coordinator or a narrowly scoped publisher may write comments.
Review agents receive no Bitbucket write credentials.

Before publication, retrieve the current source SHA and compare it with
the reviewed SHA. If it differs, mark the job `STALE` and do not publish
the old report.

## 5. Webhook setup in Bitbucket

Configure a repository-level webhook, or a project-level webhook if
reviews should be enabled for multiple repositories.

-   **URL:** the externally reachable HTTPS URL for the FastAPI
    endpoint, for example
    `https://ai-review.example.com/webhooks/bitbucket`.
-   **Event:** pull-request comment added, event key `pr:comment:added`.
-   **Authentication:** use the signature/secret mechanism supported by
    the installed Bitbucket configuration.
-   **Connectivity:** Bitbucket must be able to reach the service, and
    TLS certificates must be trusted.

The handler should:

1.  Verify the webhook signature against the raw request body where the
    configured mechanism provides one.
2.  Verify the event key.
3.  Parse the comment and accept `/ai-review` after a documented
    whitespace policy.
4.  Authorize the commenter.
5.  Validate repository and PR identifiers.
6.  Resolve and record the source SHA and target context.
7.  Insert the job durably and respond promptly.

The precise JSON paths and signature behavior must be confirmed against
a real webhook delivery from the deployed 9.4.26 instance. Log a
sanitized sample payload during initial integration testing; do not log
secrets or unnecessary source code.

Polling is not required for normal operation. A small
recovery/reconciliation task may be useful for abandoned jobs or
ambiguous publication outcomes, but it is not a replacement for webhook
delivery.

## 6. Workflow

1.  **Trigger:** an authorized user comments `/ai-review`.
2.  **Validate:** verify webhook authenticity, event, requester, and PR
    identity.
3.  **Deduplicate:** create or find the job for the repository, PR, and
    source SHA.
4.  **Queue:** persist the job in SQLite.
5.  **Schedule:** start it when one of the two concurrency slots is
    available.
6.  **Prepare:** create an isolated workspace and pinned checkout.
7.  **Review:** run all three independent reviewers concurrently.
8.  **Validate reviewer results:** check exit codes and JSON schema; a
    failed reviewer is not an empty/clean review.
9.  **Consensus:** verify and deduplicate the findings.
10. **Validate final report:** check schema, evidence, file references,
    and severity.
11. **Check SHA:** skip publication if the PR head changed.
12. **Publish:** post one summary comment.
13. **Complete:** persist the comment ID, final report, timings, and
    terminal state.

## 7. Data model

A minimal schema can start with these tables:

``` sql
CREATE TABLE ai_pr_review_job (
    id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    repository_slug TEXT NOT NULL,
    pr_id INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    target_sha TEXT,
    requested_by TEXT NOT NULL,
    trigger_comment_id TEXT,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    lease_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    result_json TEXT,
    bitbucket_comment_id TEXT,
    error_message TEXT,
    UNIQUE (project_key, repository_slug, pr_id, head_sha)
);

CREATE INDEX idx_review_job_pending
ON ai_pr_review_job(created_at)
WHERE status IN ('QUEUED', 'RETRY');

CREATE TABLE ai_pr_review_agent_result (
    job_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error_message TEXT,
    started_at TEXT,
    completed_at TEXT,
    PRIMARY KEY (job_id, agent_name),
    FOREIGN KEY (job_id) REFERENCES ai_pr_review_job(id)
);
```

Use UTC timestamps in a consistent representation. Enable foreign-key
enforcement for each SQLite connection. Add a schema migration mechanism
before production deployment.

### 7.1 States

Main lifecycle:

`QUEUED → PREPARING → REVIEWING → CONSOLIDATING → PUBLISHING → COMPLETED`

Other states:

-   `RETRY`
-   `FAILED`
-   `STALE`
-   `CANCELLED`

State transitions must be persisted. A lease or equivalent recovery
mechanism must prevent a crashed worker from leaving a job permanently
stuck.

The unique constraint deduplicates jobs for the same PR revision. If
repeat reviews of the same SHA are needed later, introduce a review
generation/request ID and retain explicit idempotency rules.

## 8. Reviewer output contract

Use versioned JSON schemas for reviewer and consensus outputs. Example
finding:

``` json
{
  "title": "Potential null dereference",
  "severity": "HIGH",
  "confidence": 0.91,
  "file": "src/main/java/example/Service.java",
  "line_start": 42,
  "line_end": 44,
  "description": "The value can be null on this execution path.",
  "impact": "The request can fail with an unexpected exception.",
  "evidence": "The caller does not validate the returned value.",
  "suggested_fix": "Validate the value or handle the null case."
}
```

Validate every report against a schema. Severity should use a fixed
enumeration, such as `CRITICAL`, `HIGH`, `MEDIUM`, and `LOW`; confidence
must be between 0 and 1. Findings should cite specific evidence and
describe a plausible impact.

The final comment should include the reviewed commit SHA, a short
summary, and deduplicated findings. Do not claim the PR is defect-free
if any reviewer failed or the review was incomplete.

## 9. Reliability and idempotency

  -----------------------------------------------------------------------
  Failure                             Required behavior
  ----------------------------------- -----------------------------------
  Duplicate webhook                   Deduplicate using repository, PR,
                                      and SHA

  Invalid/unauthorized trigger        Do not enqueue

  Git fetch or checkout failure       Bounded retry

  Reviewer failure                    Retry that stage or fail the
                                      review; never treat as clean

  Invalid JSON                        Reject and retry within a limit

  Consensus failure                   Retry consensus using persisted
                                      reviewer results

  PR source SHA changed               Mark `STALE`; do not publish

  Bitbucket API unavailable           Retry publication without rerunning
                                      completed reviews

  Ambiguous comment-post result       Reconcile existing comments before
                                      retrying

  Pod restart                         Recover queued/incomplete jobs from
                                      SQLite

  SQLite busy/locked                  Wait within timeout and retry
                                      safely

  Disk or workspace exhaustion        Stop scheduling work, alert, and
                                      clean up safely
  -----------------------------------------------------------------------

Exactly-once delivery across an external REST API and local SQLite
cannot be guaranteed by a local transaction alone. Use an
idempotency/reconciliation strategy and record the resulting Bitbucket
comment ID.

## 10. Security

-   Store secrets in OpenShift Secrets or the approved secret manager.
-   Never embed credentials in images, source code, logs, or prompts.
-   Use read-only Git credentials.
-   Keep reviewer agents read-only.
-   Restrict the publisher to the minimum required comment permission.
-   Do not grant approval, merge, decline, or repository administration
    rights.
-   Treat source files, PR comments, commit messages, and build logs as
    untrusted content and possible prompt injection.
-   Do not provide production credentials or Kubernetes API access to
    agents.
-   Run non-root with CPU, memory, process, and execution-time limits.
-   Restrict network egress.
-   If tests/builds execute repository code, run them in a more strongly
    isolated environment.

## 11. OpenShift deployment

### Initial topology

-   One active application pod running FastAPI and the scheduler.
-   One persistent volume for the SQLite database.
-   Temporary per-job workspace storage.
-   OpenShift Secret(s) for Bitbucket and model credentials.
-   Restricted service account, network policy, and resource limits.
-   HTTPS Route/ingress if Bitbucket must reach the service externally.

This single-owner topology is deliberate: it avoids multi-pod SQLite
coordination. The service is not highly available in this phase. Jobs
persist across pod replacement, but active subprocesses may need to
restart from the last safely persisted stage.

Do not put SQLite on an arbitrary shared network filesystem without
confirming file locking and durability semantics. Back up the database
using a SQLite-safe procedure.

### Future scaling

If high availability, multiple active application replicas, or higher
write concurrency becomes necessary, migrate persistence to PostgreSQL
or another shared transactional database before distributing job
scheduling across replicas. A message broker is also a future option,
not an initial requirement.

## 12. Observability and cost control

Measure:

-   Jobs accepted, queued, completed, failed, and stale.
-   Queue depth and wait time.
-   Active PR reviews and subprocess count.
-   Git preparation, each reviewer, consensus, and publication duration.
-   Provider token usage and estimated cost, when available.
-   Retry counts and provider rate limits.
-   Findings by severity and confidence.
-   Publication success and duplicate prevention.

For efficiency:

-   Generate a bounded diff and relevant source context with Git and
    search tools.
-   Avoid sending the full repository to every model.
-   Use concise prompts and structured output.
-   Run the three reviewers in parallel.
-   Persist successful stage results.
-   Retry only the failed stage when inputs remain valid.
-   Measure model combinations on representative PRs rather than
    assuming a model is cheaper or better.

## 13. Configuration

Externalize at least:

``` env
BITBUCKET_BASE_URL=
BITBUCKET_WEBHOOK_SECRET=
BITBUCKET_API_USERNAME=
BITBUCKET_API_TOKEN=
SQLITE_PATH=/data/ai-review.sqlite3
WORKSPACE_ROOT=/work
MAX_CONCURRENT_REVIEWS=2
REVIEWER_TIMEOUT_SECONDS=
CONSENSUS_TIMEOUT_SECONDS=
MAX_RETRIES=
```

Use the organization's secret mechanism rather than storing secret
values in a checked-in `.env` file. Configure OpenCode model IDs and
provider credentials according to the deployed OpenCode version.

## 14. Implementation plan

### Phase 1 --- Local workflow

-   Create three independent reviewer agents and one consensus agent.
-   Fetch a PR at a pinned SHA.
-   Prepare a bounded diff and relevant source.
-   Run reviewers in parallel.
-   Validate JSON and run consensus.
-   Test two PR jobs in parallel with separate workspaces.

### Phase 2 --- Service and persistence

-   Implement FastAPI webhook endpoint.
-   Add SQLite schema and migrations.
-   Implement job state machine, deduplication, scheduler, and
    concurrency limit.
-   Add process timeouts, retries, and recovery.

### Phase 3 --- Bitbucket integration

-   Configure the `pr:comment:added` webhook in Bitbucket Data Center
    9.4.26.
-   Validate a real event payload and signature.
-   Implement PR metadata and comment REST calls.
-   Add stale-SHA checks and publication reconciliation.

### Phase 4 --- OpenShift

-   Build and deploy the application.
-   Configure persistent database and workspace storage.
-   Configure secrets, networking, health checks, and resource limits.
-   Test pod restart, duplicate webhook, provider timeout, and Bitbucket
    outage scenarios.

### Phase 5 --- Quality tuning

-   Evaluate historical PRs.
-   Measure precision, false positives, useful findings, latency, and
    cost.
-   Tune models and context preparation.
-   Consider optional isolated test execution.

## 15. Acceptance criteria

The first release is ready when:

1.  An authorized `/ai-review` comment creates a durable job.
2.  Duplicate webhook deliveries do not create duplicate active jobs.
3.  Two PRs can be reviewed concurrently with isolated workspaces.
4.  All three reviewers inspect the same pinned revision independently.
5.  Reviewer failure cannot be mistaken for a clean review.
6.  Consensus verifies and deduplicates findings.
7.  Changed PR revisions are never reviewed with stale publication.
8.  A successful job publishes one summary comment.
9.  Publication retries reconcile ambiguous outcomes.
10. Queued jobs survive application pod replacement.
11. Agents cannot modify code, approve, or merge PRs.
12. Usage, latency, failure, and review-quality metrics are available.

## 16. Key trade-off

SQLite and a single active application pod are appropriate for a small
initial deployment with two concurrent PR reviews. The trade-off is
limited high availability and horizontal scaling. Keep job handling
transactional and workspaces isolated, then migrate persistence before
adding multiple active coordinators.

**Implementation principle:** keep orchestration deterministic, source
access read-only, AI tasks isolated, and every review tied to an
immutable commit SHA.

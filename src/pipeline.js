// One end-to-end local review: fetch PR -> prepare context -> run the reviewers
// in parallel -> consensus -> render report -> (optionally) publish comment.
//
// Progress is reported two ways:
//   - `emit(type, payload)` callback (used by the web UI / SSE)
//   - a `status.json` file written into the job dir after every meaningful
//     state change (so jobs started by the CLI can be inspected afterwards).

import { mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, statSync, rmSync } from "node:fs";
import path from "node:path";

import { createReviewClient, botUsernamesOf, prCommentUrl, reportBaseUrl } from "./clients.js";
import { buildReviewerContext, buildConsensusContext, loadProjectContext } from "./context.js";
import { prepareCheckout, cleanupCheckout, maintainCheckout } from "./checkout.js";
import { runAgent } from "./opencode.js";
import { extractTrailingJson } from "./extractJson.js";
import { validateReviewerReport, validateConsensusReport, repairReportKeys } from "./validate.js";
import { renderFinalReport, renderComment } from "./report.js";
import { loadModelPrices, loadModelBaseUrls, defaultPriceCandidates, computeCost } from "./costs.js";
import { loadJiraContext, buildAcView } from "./jira.js";
import { groundFindings, changedPathSet } from "./grounding.js";
import { findPreviousReview, renderPreviousReview } from "./previous.js";
import { loadDiscussion, previousReviewCommentId } from "./discussion.js";
import { loadScreenshotBlock } from "./prImages.js";
import { isTranslationReview } from "./config.js";
import { APP_VERSION } from "./version.js";
import { log } from "./log.js";

const REVIEWER_DEFS = [
  { key: "a", agent: "pr-reviewer-a", field: "reviewerA", label: "Reviewer A" },
  { key: "b", agent: "pr-reviewer-b", field: "reviewerB", label: "Reviewer B" },
  { key: "c", agent: "pr-reviewer-c", field: "reviewerC", label: "Reviewer C" },
  { key: "d", agent: "pr-reviewer-d", field: "reviewerD", label: "Reviewer D" },
];
// A/B/C run on every review; D (language/i18n) runs only on translation PRs.
const CORE_REVIEWER_DEFS = REVIEWER_DEFS.filter((d) => d.key !== "d");
// Consensus still runs when one reviewer fails; fewer than this aborts.
const MIN_REVIEWERS = 2;

export function sanitize(s) {
  // `@` is preserved so a platform-namespace marker (github@…) survives; it
  // cannot appear in a Bitbucket project key or repo slug, so the marker can
  // never be produced by a Bitbucket name.
  return String(s).replace(/[^A-Za-z0-9._@-]+/g, "-");
}

/**
 * Deterministic job-name prefix for a ref (`<proj>-<repo>-PR<N>-`). GitHub is
 * namespaced with `github@…` (mirroring the checkout cache separator) so a
 * GitHub owner/repo never shares a job namespace with a Bitbucket project/repo
 * whose key is literally `GITHUB` (or lowercases to `github`); Bitbucket
 * prefixes are byte-for-byte unchanged (existing job dirs stay readable).
 */
export function jobPrefixFor(ref) {
  const base = `${ref.projectKey}-${ref.repoSlug}-PR${ref.prId}-`;
  return sanitize(ref?.platform === "github" ? `github@${base}` : base);
}

// Attach token usage + computed cost to a finished attempt (from runAgent).
function recordUsageCost(attemptState, res, prices, model) {
  const u = res.usage;
  if (!u) return;
  const has = u.input || u.output || u.cacheRead || u.cacheWrite;
  if (!has) return;
  attemptState.usage = {
    input: u.input || 0,
    output: u.output || 0,
    cacheRead: u.cacheRead || 0,
    cacheWrite: u.cacheWrite || 0,
  };
  const c = computeCost(prices, model, attemptState.usage);
  if (c) attemptState.cost = c;
}

// Sum usage/cost across a job's attempts into the agent-level rollup.
function rollupAgentCost(agentState, attempts) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cost = { input: 0, cache: 0, output: 0, total: 0 };
  let any = false;
  for (const a of attempts) {
    if (!a.usage && !a.cost) continue;
    any = true;
    if (a.usage) {
      usage.input += a.usage.input || 0;
      usage.output += a.usage.output || 0;
      usage.cacheRead += a.usage.cacheRead || 0;
      usage.cacheWrite += a.usage.cacheWrite || 0;
    }
    if (a.cost) {
      cost.input += a.cost.input || 0;
      cost.cache += a.cost.cache || 0;
      cost.output += a.cost.output || 0;
      cost.total += a.cost.total || 0;
    }
  }
  if (any) {
    agentState.usage = usage;
    agentState.cost = cost;
  }
}

function noop() {}

export async function runReview({ ref, config, options = {} }) {
  const client = createReviewClient(config, ref);
  const emit = options.emit || noop;
  const onStage = options.onStage || noop;
  const jobsDir = config.dirs.jobs;
  mkdirSync(jobsDir, { recursive: true });

  // Effective per-slot models: per-review UI override > persisted settings
  // (already merged into config.models at load) > env defaults.
  const overrides = (options.models && typeof options.models === "object") ? options.models : {};
  const effectiveModels = {
    reviewerA: overrides.a || config.models.reviewerA,
    reviewerB: overrides.b || config.models.reviewerB,
    reviewerC: overrides.c || config.models.reviewerC,
    // Reviewer D falls back to A's model when no dedicated one is configured —
    // a translation PR must never be skipped for a missing env var.
    reviewerD: overrides.d || config.models.reviewerD || config.models.reviewerA,
    consensus: overrides.consensus || config.models.consensus,
  };

  // Model prices for the dashboard cost display — read from the opencode
  // config/template `cost` metadata. Missing prices simply show no cost.
  const prices = loadModelPrices(
    defaultPriceCandidates({
      projectRoot: config.projectRoot,
      home: process.env.HOME,
      override: config.costs?.configPath,
    }),
  );

  // `status` mirrors the job state; persisted as status.json after each change.
  const status = {
    job: null,
    appVersion: APP_VERSION,
    ref,
    title: null,
    reviewedSha: null,
    startedAt: new Date().toISOString(),
    stage: "fetch",
    error: null,
    agents: {
      a: { key: "a", label: "Reviewer A", model: effectiveModels.reviewerA, status: "pending", attempts: [] },
      b: { key: "b", label: "Reviewer B", model: effectiveModels.reviewerB, status: "pending", attempts: [] },
      c: { key: "c", label: "Reviewer C", model: effectiveModels.reviewerC, status: "pending", attempts: [] },
      d: { key: "d", label: "Reviewer D", model: effectiveModels.reviewerD, status: "pending", attempts: [] },
      consensus: { key: "consensus", label: "Consensus", model: effectiveModels.consensus, status: "pending", attempts: [] },
    },
    consensus: null,
    publish: null,
    paths: {},
  };
  let statusWrite = noop;

  const fire = (type, payload = {}) => {
    if (type === "stage" && payload.stage) status.stage = payload.stage;
    const evt = { type, job: status.job, timestamp: new Date().toISOString(), ...payload };
    emit(evt);
    // Streaming text chunks would make this write hot; skip them for the file.
    if (type !== "agent-text" && statusWrite) statusWrite();
  };

  onStage("fetch");
  fire("stage", { stage: "fetch" });

  // 1. Fetch PR metadata, diff, changed files.
  const [pullRequest, diff, changes] = await Promise.all([
    client.getPullRequest(ref),
    client.getUnifiedDiff(ref),
    client.getChangedFiles(ref),
  ]);

  const from = pullRequest.fromRef || {};
  const reviewedSha = from.latestCommit || from.id;
  const jobName = `${jobPrefixFor(ref)}${reviewedSha?.slice(0, 8)}`;
  const jobDir = path.join(jobsDir, jobName);
  // ENOSPC guard (issue #11): if the shared PVC is full, reclaim the checkout
  // workspace (gc + LRU eviction) and retry; if that still leaves no room —
  // workspace freed nothing (REVIEW_CHECKOUT=0 / all repos protected) OR freed
  // a little but not enough for this job dir — also drop the oldest *finished*
  // review job dirs (the PVC holds /app/data/jobs too), then retry once more
  // before failing cleanly. Each reclaim is best-effort: a reclaim failure is
  // logged and the next strategy still runs, so the original ENOSPC is never
  // masked by a raw secondary error (PR #12 AI review MEDIUM + minor).
  const mkJobDir = () => mkdirSync(jobDir, { recursive: true });
  try {
    mkJobDir();
  } catch (err) {
    if (err.code !== "ENOSPC") throw err;
    log.warn(`job dir ENOSPC (${err.message}); reclaiming checkout workspace and retrying`);
    try {
      await maintainCheckout(config).catch((re) => log.warn(`workspace reclaim failed: ${re.message}`));
      mkJobDir();
    } catch (err2) {
      if (err2.code !== "ENOSPC") throw err2;
      log.warn(`still ENOSPC (${err2.message}); reclaiming old job dirs and retrying`);
      await reclaimOldJobDirs(config, { skipDir: jobDir });
      try {
        mkJobDir();
      } catch (err3) {
        if (err3.code === "ENOSPC") {
          throw new Error(`no disk space for review job after reclaim (ENOSPC): ${err3.message}`);
        }
        throw err3;
      }
    }
  }

  status.job = jobName;
  status.title = pullRequest.title;
  status.reviewedSha = reviewedSha;
  status.paths.jobDir = jobDir;
  fire("job-ready", { jobName, jobDir, title: pullRequest.title, reviewedSha });
  statusWrite = () => {
    try {
      writeFileSync(path.join(jobDir, "status.json"), JSON.stringify(status, null, 2));
      writeFileSync(
        path.join(jobDir, "job-meta.json"),
        JSON.stringify(
          {
            job: jobName,
            ref,
            title: pullRequest.title,
            reviewedSha,
            startedAt: status.startedAt,
            appVersion: APP_VERSION,
            projectKey: ref.projectKey,
            repoSlug: ref.repoSlug,
            prId: ref.prId,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      log.warn(`status.json write failed: ${err.message}`);
    }
  };

  // Streaming text goes into status.json too, so CLI runs are live in the UI;
  // debounced so we don't rewrite the file per token.
  let liveFlushTimer = null;
  const flushStatus = () => {
    if (liveFlushTimer) return;
    liveFlushTimer = setTimeout(() => {
      liveFlushTimer = null;
      try {
        writeFileSync(path.join(jobDir, "status.json"), JSON.stringify(status, null, 2));
      } catch (err) {
        log.warn(`status.json flush failed: ${err.message}`);
      }
    }, 400);
  };

  writeFileSync(path.join(jobDir, "pull-request.json"), JSON.stringify(pullRequest, null, 2));
  writeFileSync(path.join(jobDir, "diff.patch"), diff);
  writeFileSync(path.join(jobDir, "changes.json"), JSON.stringify(changes, null, 2));
  log.info(`Job dir: ${jobDir}`);

  // 1b. Translation-PR detection — decides whether reviewer D (language/i18n)
  // joins the review. A PR is a translation/content PR when any changed path
  // matches the configured translation patterns (default: `i18n/*.json`,
  // gettext `.po`/`.pot`). On other PRs reviewer D is skipped entirely.
  const changedPaths = [...changedPathSet(changes)];
  const translationPatterns = config.review?.translationPathPatterns || [];
  const enabled = isTranslationReview(changedPaths, translationPatterns);
  if (!enabled) {
    status.agents.d.status = "skipped";
  }
  status.translation = {
    enabled,
    matchedPaths: changedPaths.filter((p) => translationPatterns.some((re) => re.test(p))),
  };
  log.info(
    enabled
      ? `Translation/content PR — reviewer D (language) joins the review`
      : "Not a translation PR — reviewer D skipped",
  );
  const activeDefs = enabled ? REVIEWER_DEFS : CORE_REVIEWER_DEFS;

  // 2. (optional) Project context — a curated per-repo file and/or the repo's
  // own AGENTS.md. Additive and non-fatal: never abort the review over it.
  const projectContext = await loadProjectContext({
    dir: config.dirs.contexts,
    client,
    ref,
    sha: reviewedSha,
    fetchRepoContext: config.review.fetchRepoContext,
    changedPaths: [...changedPathSet(changes)],
  });
  if (projectContext) {
    writeFileSync(path.join(jobDir, "project-context.md"), projectContext);
    log.info(`Project context attached (${Buffer.byteLength(projectContext, "utf8")} bytes)`);
  }

  // 2b. (optional) PR discussion — the author's comments/replies (especially
  // answers to our previous review comment), so reviewers see clarifications
  // instead of re-raising already-addressed findings. Additive + non-fatal.
  // The previous review is looked up early and reused later for the consensus
  // resolved_previous reconciliation.
  const jobPrefix = jobPrefixFor(ref);
  const previous = findPreviousReview({ jobsDir, jobPrefix, currentJob: jobName });
  const reviewCommentId = previousReviewCommentId(previous, { jobsDir });
  // The PR activity feed is shared by the discussion step (text clarifications)
  // and the screenshots step (images pasted into description/comments), so it
  // is fetched at most once per review. Both steps are additive + non-fatal.
  let activities = null;
  if (config.review.fetchPrDiscussion || config.review.fetchPrImages) {
    try {
      activities = await client.getPullRequestActivities(ref);
    } catch (err) {
      log.warn(`could not fetch PR activities for ${ref.projectKey}/${ref.repoSlug}#${ref.prId}: ${err.message}`);
      activities = [];
    }
  }
  let discussionBlock = "";
  if (config.review.fetchPrDiscussion) {
    discussionBlock = await loadDiscussion({
      client,
      ref,
      botUsernames: botUsernamesOf(config, ref),
      reviewCommentId,
      activities: activities ?? undefined,
    });
    if (discussionBlock) log.info(`PR discussion attached (${Buffer.byteLength(discussionBlock, "utf8")} bytes)`);
  }
  let prImagesBlock = "";
  if (config.review.fetchPrImages) {
    // Per-model base URLs (MSP endpoints etc.) so the vision transcriber calls
    // the exact deployment opencode uses — same config source as the prices.
    const visionBaseUrls = loadModelBaseUrls(
      defaultPriceCandidates({
        projectRoot: config.projectRoot,
        home: process.env.HOME,
        override: config.costs?.configPath,
      }),
    );
    const prImages = await loadScreenshotBlock({
      client,
      config,
      ref,
      description: pullRequest.description || "",
      activities: activities ?? [],
      baseUrls: visionBaseUrls,
      vision: config.visionRouting,
    });
    prImagesBlock = prImages?.block || "";
    // The vision transcription is priced separately from the reviewers (its own
    // model — never folded into a reviewer's usage) and shown as its own row.
    status.vision = {
      model: config.review.visionModel,
      usage: prImages?.usage ?? null,
      cost: prImages?.usage
        ? computeCost(prices, config.review.visionModel, prImages.usage)
        : null,
      transcribed: prImages?.transcribed ?? 0,
      unreadable: prImages?.unreadable ?? 0,
    };
  }

  // 2b–3b live inside the try below: cleanupCheckout in the finally must cover
  // everything from the successful prepareCheckout onward, so a throw between
  // checkout and the review body (context build, Jira lookup, context write)
  // can never leak the active-checkout protection (AI review, PR #12 MEDIUM).

  // 4. Run the active reviewers in parallel (with bounded retries). A/B/C run
  // on every review; reviewer D joins when the PR is a translation/content PR.
  // `checkout` is hoisted so the finally can pass its protection token back to
  // cleanupCheckout — it must never be released for a review whose checkout
  // failed (that would unprotect a concurrent review on the same repo).
  let checkout = null;
  try {
    // 2b. (optional) Shallow git checkout of the reviewed commit, so reviewers
    // can read real files beyond the diff. Best-effort: any failure degrades to
    // "no checkout" and the review proceeds on diff + context alone.
    let agentCwd = null;
    checkout = await prepareCheckout({
      config,
      ref,
      sha: reviewedSha,
      branch: (pullRequest.fromRef || {}).displayId || null,
    });
    if (checkout.ok) {
      agentCwd = checkout.dir;
      status.paths.checkout = checkout.dir;
      log.info(`Review checkout: ${checkout.dir} (@${String(reviewedSha).slice(0, 12)})`);
    } else {
      // Never let agents browse the reviewer app itself (source, .env) as "the repo".
      agentCwd = path.join(jobDir, "sandbox");
      mkdirSync(agentCwd, { recursive: true });
    }

    // 3. Reviewer context.
    let contextText = buildReviewerContext({
      ref,
      pullRequest,
      changes,
      diff,
      maxDiffBytes: config.git.maxDiffBytes,
      projectContext,
      discussionBlock,
      prImagesBlock,
    });
    // 3b. (optional) Linked Jira tickets — additive + non-fatal (see src/jira.js).
    const jira = await loadJiraContext({ config, pullRequest });
    if (jira.block) contextText += "\n\n---\n\n" + jira.block;
    const contextFile = path.join(jobDir, "pr-context.md");
    writeFileSync(contextFile, contextText);

    onStage("review");
    fire("stage", { stage: "review" });
    const reviewerOutcomes = await runReviewers({
      activeDefs,
      config,
      effectiveModels,
      contextFile,
      agentCwd,
      jobDir,
      fire,
      status,
      flushStatus,
      prices,
    });

    const failed = reviewerOutcomes.filter((r) => !r.ok);
    for (const f of failed) {
      log.error(`${f.label} failed after ${f.attempts} attempt(s): ${f.error}`);
    }
    const okCount = reviewerOutcomes.length - failed.length;
    if (okCount < MIN_REVIEWERS) {
      throw new Error(
        `Only ${okCount} of ${reviewerOutcomes.length} reviewers succeeded (failed: ${failed.map((f) => f.label).join(", ")}); ` +
          `at least ${MIN_REVIEWERS} are required. A failed reviewer is never treated as a clean review; aborted.`,
      );
    }
    const degraded = failed.map((f) => f.label);
    if (degraded.length) {
      status.degraded = degraded;
      log.warn(`Continuing with ${okCount} of ${reviewerOutcomes.length} reviewers (${degraded.join(", ")} failed)`);
    }
    statusWrite();

    // 5. Consensus over the reports.
    onStage("consensus");
    fire("stage", { stage: "consensus" });
    if (previous?.findings.length) {
      status.previousReview = { job: previous.job, sha: previous.sha, findings: previous.findings.length };
      log.info(`Previous review ${previous.job}: ${previous.findings.length} finding(s) handed to consensus`);
    }
    const consensusInput = buildConsensusContext({
      ref,
      pullRequest,
      changes,
      diff,
      reports: activeDefs.map((def, i) => {
        const outcome = reviewerOutcomes[i];
        return {
          agent: def.key,
          text: outcome?.ok
            ? JSON.stringify(outcome.report, null, 2)
            : `(FAILED — no report: ${outcome?.error ?? "unknown error"}. Its lens was not reviewed; do not read its absence as a clean result.)`,
        };
      }),
      maxDiffBytes: config.git.maxDiffBytes,
      projectContext,
      jiraBlock: jira.block, // Gives consensus the ACs so it can issue per-AC verdicts
      previousBlock: renderPreviousReview(previous),
      discussionBlock,
      prImagesBlock,
    });
    const consensusFile = path.join(jobDir, "consensus-input.md");
    writeFileSync(consensusFile, consensusInput);

    const consensus = await runConsensus(config, consensusFile, jobDir, agentCwd, fire, status, flushStatus, prices, effectiveModels.consensus);
    if (!consensus.ok) {
      throw new Error(`Consensus failed after ${consensus.attempts} attempt(s): ${consensus.error}`);
    }
    const grounding = groundFindings(consensus.report, {
      diff,
      changes,
      checkoutDir: checkout.ok ? checkout.dir : null,
    });
    status.grounding = grounding;
    if (grounding.notFound || grounding.offDiff) {
      log.warn(`Grounding: ${grounding.notFound} finding(s) with unmatched evidence, ${grounding.offDiff} outside the PR's files`);
    }
    writeFileSync(path.join(jobDir, "consensus.json"), JSON.stringify(consensus.report, null, 2));
    if (degraded.length) {
      const notes = Array.isArray(consensus.report.notes) ? consensus.report.notes : (consensus.report.notes = []);
      notes.push(`Partial review: ${degraded.join(", ")} failed; consensus ran on ${okCount} of ${reviewerOutcomes.length} reports.`);
    }
    status.consensus = consensus.report;
    // Structured AC view for the UI Overview tab (markdown appendix is derived
    // from the same source via renderJiraAppendix). Non-fatal: no tickets/ACs
    // yields null, never an error.
    status.jiraAc = buildAcView(jira.tickets, consensus.report?.acceptance_criteria) || null;
    statusWrite();

    // 6. Render the full (internal) report and the public comment. The comment
    //    is what gets posted; the internal report additionally keeps the notes.
    onStage("render");
    fire("stage", { stage: "render" });
    const renderArgs = {
      report: consensus.report,
      ref,
      pullRequest,
      baseUrl: reportBaseUrl({ config, ref, pullRequest }),
      jiraTickets: jira.tickets, // Linked-ticket context (ACs) for the report/comment appendix
      degraded,
      policy: {
        minSeverity: config.review.commentMinSeverity,
        minConfidence: config.review.commentMinConfidence,
      },
    };
    const finalReportMarkdown = renderFinalReport(renderArgs);
    const commentMarkdown = renderComment(renderArgs);
    writeFileSync(path.join(jobDir, "final-report.md"), finalReportMarkdown);
    status.paths.finalReport = path.join(jobDir, "final-report.md");
    // Written whether or not it gets published: the UI Draft tab shows it.
    writeFileSync(path.join(jobDir, "comment-draft.md"), commentMarkdown);
    status.paths.commentDraft = path.join(jobDir, "comment-draft.md");
    status.commentPolicy = renderArgs.policy;
    statusWrite();

    // 7. Publish (or keep a draft).
    onStage("publish");
    fire("stage", { stage: "publish" });
    const publishResult = options.publish
      ? await publishComment({ client, ref, pullRequest, report: consensus.report, reportMarkdown: commentMarkdown })
      : { published: false, stale: false, draft: path.join(jobDir, "comment-draft.md") };
    status.publish = {
      published: publishResult.published,
      stale: !!publishResult.stale,
      commentId: publishResult.commentId ?? null,
      url: publishResult.url ?? null,
      draft: publishResult.draft ?? null,
      reason: publishResult.reason ?? null,
    };
    status.stage = "complete";
    status.completedAt = new Date().toISOString();
    fire("complete", { publish: status.publish });

    return {
      ref,
      pullRequest,
      jobDir,
      jobName,
      reviewedSha,
      reviewers: reviewerOutcomes,
      consensusReport: consensus.report,
      consensusModel: effectiveModels.consensus,
      reportMarkdown: commentMarkdown,
      finalReportMarkdown,
      publish: publishResult,
    };
  } catch (err) {
    status.stage = "failed";
    status.error = err.message;
    status.completedAt = new Date().toISOString();
    fire("error", { message: err.message });
    throw err;
  } finally {
    // `token` is the bare dir only when this review actually got a checkout —
    // cleanupCheckout releases protection exclusively through it.
    await cleanupCheckout({ config, ref, token: checkout?.ok ? checkout.bare : null });
  }
}

// Run the active reviewers with bounded parallelism. REVIEWER_PARALLELISM
// (config.review.parallelism): 0/unset = all at once (the historical default);
// 1 = one at a time (for small hosts); N = at most N at a time. Only the
// scheduling changes — every reviewer-def option stays identical.
async function runReviewers({ activeDefs, config, effectiveModels, contextFile, agentCwd, jobDir, fire, status, flushStatus, prices }) {
  const task = (def) =>
    runReviewerWithRetries(config, {
      ...def,
      model: effectiveModels[def.field],
      contextFile,
      cwd: agentCwd,
      jobDir,
      fire,
      status,
      flushStatus,
      prices,
    });
  const limit = Number(config?.review?.parallelism) || 0;
  if (limit > 0) {
    const outcomes = [];
    for (let i = 0; i < activeDefs.length; i += limit) {
      const batch = activeDefs.slice(i, i + limit);
      outcomes.push(...(await Promise.all(batch.map(task))));
    }
    return outcomes;
  }
  return Promise.all(activeDefs.map(task));
}

async function runReviewerWithRetries(config, { key, agent, label, model, contextFile, cwd, jobDir, fire, status, flushStatus, prices }) {
  const outcome = await runAgentWithRetries(config, {
    key,
    agent,
    label,
    model,
    file: contextFile,
    cwd,
    jobDir,
    artifact: `reviewer-${key}`,
    timeoutSeconds: config.opencode.reviewerTimeoutSeconds,
    message: "Review the attached PR context and return your report as exactly one valid JSON object — nothing before it, nothing after it.",
    validate: validateReviewerReport,
    fire,
    status,
    flushStatus,
    prices,
  });
  return { ...outcome, label, model };
}

export function repairMessage(errors) {
  const list = errors.slice(0, 6).map((e) => `- ${e}`).join("\n");
  return (
    "Your previous reply could not be used by the pipeline:\n" +
    `${list}\n\n` +
    "Reply again with ONLY the complete, corrected JSON object — same findings and content, " +
    "fixed format, nothing before or after it. Do not call any tools."
  );
}

// Shared attempt loop. An attempt that ran fine but produced unusable JSON is
// followed by one cheap repair turn in the same opencode session; anything
// else (timeout, crash, empty reply, failed repair) gets a fresh run.
async function runAgentWithRetries(config, opts) {
  const { key, agent, label, model, file, cwd, jobDir, artifact, timeoutSeconds, message, validate, fire, status, flushStatus, prices } = opts;
  const attempts = [];
  const agentState = status.agents[key];
  agentState.status = "running";
  let repairFrom = null;

  for (let attempt = 0; attempt <= config.opencode.maxRetries; attempt++) {
    const repair = repairFrom;
    repairFrom = null;
    log.info(`${label} (${model}) attempt ${attempt + 1}${repair ? " (repair)" : ""}...`);
    fire("agent-start", { key, label, model, attempt });

    // Pushed up-front (and flushed on every text chunk) so the in-flight
    // attempt — with its growing `text` — is visible live in status.json.
    const attemptState = {
      attempt,
      ok: false,
      error: null,
      findings: null,
      durationMs: null,
      timedOut: false,
      repair: !!repair,
      text: "",
    };
    attempts.push(attemptState);
    agentState.attempts.push(attemptState);

    const res = await runAgent({
      bin: config.opencode.bin,
      agent,
      model,
      cwd,
      file: repair ? null : file,
      sessionId: repair?.sessionId ?? null,
      timeoutSeconds,
      standalone: config.opencode.standalone,
      env: { ...process.env, OPENCODE_CONFIG_DIR: config.opencode.agentDir },
      message: repair ? repairMessage(repair.errors) : message,
      onText: (text) => {
        attemptState.text += text;
        fire("agent-text", { key, label, attempt, text });
        flushStatus();
      },
    });

    attemptState.text = res.text || attemptState.text;
    attemptState.durationMs = res.durationMs;
    attemptState.timedOut = res.timedOut;
    recordUsageCost(attemptState, res, prices, model);
    attemptState.toolCalls = res.toolCalls ?? 0;
    flushStatus();

    writeFileSync(path.join(jobDir, `${artifact}-attempt-${attempt}.txt`), res.text || "");
    if (res.stdout || res.stderr) {
      writeFileSync(path.join(jobDir, `${artifact}-attempt-${attempt}.log`), `${res.stdout}\n--- stderr ---\n${res.stderr}`);
    }

    const fail = (error, repairErrors = null) => {
      attemptState.error = error;
      agentState.error = error;
      agentState.status = "running";
      fire("agent-attempt", { key, label, attempt, ok: false, error });
      log.warn(`${label} attempt ${attempt + 1}: ${error}`);
      if (repairErrors && !repair && res.sessionId) repairFrom = { sessionId: res.sessionId, errors: repairErrors };
    };

    if (!res.ok) {
      fail(res.error);
      continue;
    }
    const parsed = extractTrailingJson(res.text);
    if (!parsed) {
      const error = describeExtractFailure(res.text);
      fail(error, res.text?.trim() ? [error] : null);
      continue;
    }
    const repaired = repairReportKeys(parsed.json);
    if (repaired) log.info(`${label} attempt ${attempt + 1}: repaired ${repaired} near-miss key(s)`);
    const validation = validate(parsed.json);
    if (!validation.ok) {
      fail(`invalid report: ${validation.errors.slice(0, 3).join("; ")}`, validation.errors);
      continue;
    }
    attemptState.ok = true;
    attemptState.findings = parsed.json.findings.length;
    attemptState.unverifiedFindings = (parsed.json.findings || []).filter(
      (f) => f.verification_status === "unavailable",
    ).length;
    attemptState.report = parsed.json;
    agentState.status = "ok";
    agentState.findings = attemptState.findings;
    agentState.durationMs = attemptState.durationMs;
    agentState.attempt = attempt;
    agentState.toolCalls = attemptState.toolCalls;
    agentState.unverifiedFindings = attemptState.unverifiedFindings;
    delete agentState.error;
    writeFileSync(path.join(jobDir, `${artifact}.json`), JSON.stringify(parsed.json, null, 2));
    fire("agent-done", { key, label, attempt, ok: true, findings: attemptState.findings, durationMs: attemptState.durationMs });
    log.info(`${label} OK (${res.durationMs}ms, ${attemptState.findings} findings${repair ? ", after repair" : ""})`);
    rollupAgentCost(agentState, attempts);
    flushStatus();
    return attemptState;
  }

  agentState.status = "failed";
  agentState.error = attempts[attempts.length - 1]?.error ?? "unknown";
  fire("agent-done", { key, label, attempt: attempts.length - 1, ok: false, error: agentState.error });
  rollupAgentCost(agentState, attempts);
  flushStatus();
  return { ...attempts[attempts.length - 1], ok: false, attempts: attempts.length };
}

async function runConsensus(config, inputFile, jobDir, cwd, fire, status, flushStatus, prices, model) {
  return runAgentWithRetries(config, {
    key: "consensus",
    agent: "pr-consensus",
    label: "Consensus",
    model,
    file: inputFile,
    cwd,
    jobDir,
    artifact: "consensus",
    timeoutSeconds: config.opencode.consensusTimeoutSeconds,
    message: "Synthesize the reviewer reports into one final verified report as exactly one valid JSON object — nothing before it, nothing after it.",
    validate: validateConsensusReport,
    fire,
    status,
    flushStatus,
    prices,
  });
}

function describeExtractFailure(text) {
  if (!text || !text.trim()) return "empty reply (agent produced no output)";
  const last = text.trimEnd().at(-1);
  if (last !== "}") return "reply does not end with a JSON object (likely truncated)";
  return "no valid JSON object found in the reply";
}

async function publishComment({ client, ref, pullRequest, report, reportMarkdown }) {
  const reviewedSha = report.reviewed_sha;

  // Re-check that the PR head did not move since the review started.
  const current = await client.getPullRequest(ref);
  const currentSha = current.fromRef?.latestCommit || current.fromRef?.id;
  if (currentSha && reviewedSha && currentSha !== reviewedSha) {
    log.warn(
      `Stale review: PR head moved from ${reviewedSha.slice(0, 8)} to ${currentSha.slice(0, 8)}; not publishing.`,
    );
    return { published: false, stale: true, reason: "PR head changed during review" };
  }

  const comment = await client.postPullRequestComment({
    ...ref,
    text: reportMarkdown,
  });
  const commentId = comment.id;
  log.info(`Published comment #${commentId} on PR #${ref.prId}`);
  return {
    published: true,
    stale: false,
    commentId,
    url: prCommentUrl({ ref, pullRequest, client, commentId }),
  };
}

// --- helpers used by the web UI ---------------------------------------------

/** List job directories (most recent first) with metadata from job-meta.json/status.json. */
export function listJobs(config) {
  const jobsDir = config.dirs.jobs;
  if (!existsSync(jobsDir)) return [];
  const entries = readdirSync(jobsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith("."))
    .sort((a, b) => {
      const ta = statTime(jobsDir, a);
      const tb = statTime(jobsDir, b);
      return tb - ta;
    });
  return entries.map((name) => readJobSummary(config, name));
}

/**
 * Paginated + slim job list for the dashboard (GET /api/jobs). Newest first.
 * Reads only `limit` job summaries and returns lightweight records (no large
 * streaming/consensus text), so a large job store can never stall the event
 * loop by serializing a multi-MB payload (issue #6). Also returns the total job
 * count so the UI can page without knowing the cap.
 */
export function listJobsPage(config, { limit = 50, offset = 0 } = {}) {
  const jobsDir = config.dirs.jobs;
  if (!existsSync(jobsDir)) return { jobs: [], total: 0, limit, offset };
  const names = readdirSync(jobsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith("."))
    .sort((a, b) => {
      const ta = statTime(jobsDir, a);
      const tb = statTime(jobsDir, b);
      return tb - ta;
    });
  const total = names.length;
  const page = names.slice(offset, limit > 0 ? offset + limit : undefined);
  const jobs = page.map((name) => readJobSummary(config, name, { slim: true }));
  return { jobs, total, limit, offset };
}

// Pipeline stages that mean a review is in flight. On boot any job stuck in one
// of these is orphaned — the previous process died without finalizing it (a mid
// review pod restart, issue #6). We mark it failed so the dashboard doesn't show
// a permanent "running" job and re-reviews aren't blocked.
export const RUNNING_STAGES = new Set(["fetch", "review", "consensus", "render", "publish"]);

/**
 * Boot-time sweep: mark jobs left in a running stage as failed. Returns the
 * number of jobs finalized. Called once on server startup — no review is running
 * in this process yet, so every "running" job on disk is stale by definition.
 */
export function finalizeStaleJobs(config) {
  const jobsDir = config.dirs.jobs;
  if (!existsSync(jobsDir)) return 0;
  let finalized = 0;
  let entries = [];
  try {
    entries = readdirSync(jobsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !name.startsWith("."));
  } catch {
    return 0;
  }
  for (const name of entries) {
    const file = path.join(jobsDir, name, "status.json");
    if (!existsSync(file)) continue;
    let status = null;
    try {
      status = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue; // unreadable/corrupt status — leave it alone
    }
    if (!status || !RUNNING_STAGES.has(status.stage)) continue;

    const wasStage = status.stage;
    status.stage = "failed";
    status.error =
      status.error || "Review aborted: the process restarted mid-run and never finished (startup sweep).";
    if (!status.completedAt) status.completedAt = new Date().toISOString();
    for (const [key, agent] of Object.entries(status.agents || {})) {
      if (agent && ["running", "pending"].includes(agent.status)) {
        agent.status = "failed";
        agent.error = agent.error || "aborted by process restart (startup sweep)";
      }
    }
    try {
      writeFileSync(file, JSON.stringify(status, null, 2));
      finalized += 1;
      log.warn(`startup sweep: marked stale job ${name} (was stage ${wasStage}) as failed`);
    } catch (err) {
      log.warn(`startup sweep: could not finalize ${name}: ${err.message}`);
    }
  }
  return finalized;
}

// A finished review job dir must be at least this old before the ENOSPC reclaim
// may delete it — conservative, so a job that just started (or whose metadata is
// still being written) can never be mistaken for garbage.
const JOB_RECLAIM_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Emergency job-dir reclaim for the ENOSPC path (issue #11 / PR #12 AI review):
 * when the checkout-workspace reclaim freed nothing (REVIEW_CHECKOUT=0, or every
 * repo is protected/in-use), drop the oldest *finished* review job dirs — the
 * PVC also holds /app/data/jobs. Conservative: a dir is touched only when its
 * status.json is NOT a running stage AND its job-meta.json startedAt is at least
 * an hour old (a missing/undeterminable start is left alone). Returns the number
 * of job dirs removed.
 */
export function reclaimOldJobDirs(config, { skipDir = null } = {}) {
  const jobsDir = config.dirs.jobs;
  if (!existsSync(jobsDir)) return 0;
  let entries = [];
  try {
    entries = readdirSync(jobsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !name.startsWith("."));
  } catch {
    return 0;
  }
  const now = Date.now();
  const candidates = [];
  for (const name of entries) {
    const dir = path.join(jobsDir, name);
    if (skipDir && path.resolve(dir) === path.resolve(skipDir)) continue;
    const status = readFileJson(path.join(dir, "status.json")) || {};
    if (RUNNING_STAGES.has(status.stage)) continue; // in-flight — never touch
    const started = new Date(readFileJson(path.join(dir, "job-meta.json"))?.startedAt || 0).getTime();
    if (!started || started <= 0 || now - started < JOB_RECLAIM_MIN_AGE_MS) continue;
    candidates.push({ dir, started });
  }
  candidates.sort((a, b) => a.started - b.started); // oldest first
  let removed = 0;
  for (const c of candidates) {
    try {
      rmSync(c.dir, { recursive: true, force: true });
      removed += 1;
      log.warn(`jobs: ENOSPC reclaim removed finished job ${path.basename(c.dir)} (started ${new Date(c.started).toISOString()})`);
    } catch (err) {
      log.warn(`jobs: ENOSPC reclaim failed for ${path.basename(c.dir)}: ${err.message}`);
    }
  }
  return removed;
}

function statTime(jobsDir, name) {
  try {
    return new Date(readFileJson(path.join(jobsDir, name, "job-meta.json"))?.startedAt || 0).getTime();
  } catch {
    return 0;
  }
}

export function readJobSummary(config, jobName, { slim = false } = {}) {
  const jobDir = path.join(config.dirs.jobs, jobName);
  const meta = readFileJson(path.join(jobDir, "job-meta.json")) || {};
  const status = readFileJson(path.join(jobDir, "status.json")) || {};

  // Slim summaries (dashboard list mode) drop the heavy streaming/findings text
  // so a large job store never builds a multi-MB JSON payload that stalls the
  // single-threaded event loop (issue #6). The list view only needs the fields
  // it keeps; the full detail (agents/consensus text) is served by
  // `/api/jobs/:name`.
  if (slim) {
    const agents = {};
    for (const k of ["a", "b", "c", "d", "consensus"]) {
      const a = status?.agents?.[k];
      if (!a) continue;
      agents[k] = {
        key: a.key ?? k,
        label: a.label ?? k,
        model: a.model ?? null,
        status: a.status ?? "unknown",
        findings:
          a.findings ?? (Array.isArray(a?.report?.findings) ? a.report.findings.length : null) ?? null,
        error: a.error ?? null,
        attempts: Array.isArray(a.attempts) ? a.attempts.length : 0,
      };
    }
    return {
      job: jobName,
      dir: jobDir,
      ref: meta.ref || status.ref || null,
      title: meta.title || status.title || jobName,
      reviewedSha: meta.reviewedSha || status.reviewedSha || fromReportHead(jobDir) || null,
      startedAt: meta.startedAt || status.startedAt || null,
      completedAt: status.completedAt || null,
      stage: status.stage || "unknown",
      error: status.error || null,
      agents,
      consensus: status.consensus
        ? { findings: Array.isArray(status.consensus.findings) ? status.consensus.findings.length : null }
        : null,
      degraded: status.degraded || null,
      publish: status.publish || null,
      jiraAc: status.jiraAc || null,
      vision: status.vision || null,
      paths: {
        jobDir,
        finalReport: existsSync(path.join(jobDir, "final-report.md")) ? path.join(jobDir, "final-report.md") : (status.paths?.finalReport || null),
        commentDraft: existsSync(path.join(jobDir, "comment-draft.md")) ? path.join(jobDir, "comment-draft.md") : (status.paths?.commentDraft || null),
      },
    };
  }

  // Fallback for jobs created by the CLI before status.json existed:
  // reconstruct the summary from on-disk artifacts.
  const reviewerFiles = ["a", "b", "c"].filter((k) => existsSync(path.join(jobDir, `reviewer-${k}.json`)));
  const consensus = status.consensus || readFileJson(path.join(jobDir, "consensus.json"));
  const hasReport = existsSync(path.join(jobDir, "final-report.md"));
  const hasConsensus = !!consensus;
  const fallback = !status.job && (hasReport || reviewerFiles.length || hasConsensus);
  let agents = status.agents || null;
  if (fallback) {
    agents = {};
    for (const k of ["a", "b", "c", "d"]) {
      const r = readFileJson(path.join(jobDir, `reviewer-${k}.json`));
      // Reviewer D is optional (language PRs only): do not show it as failed on
      // older/non-translation jobs that never ran it.
      if (!r && k === "d") continue;
      agents[k] = {
        key: k,
        label: { a: "Reviewer A", b: "Reviewer B", c: "Reviewer C", d: "Reviewer D" }[k],
        model: null,
        status: r ? "ok" : "failed",
        findings: r?.findings?.length ?? null,
        attempts: r ? [{ attempt: 0, ok: true, findings: r.findings.length, text: JSON.stringify(r, null, 2) }] : [],
        error: r ? null : "no valid report on disk",
      };
    }
    agents.consensus = {
      key: "consensus",
      label: "Consensus",
      status: consensus ? "ok" : "failed",
      findings: consensus?.findings?.length ?? null,
      attempts: consensus ? [{ attempt: 0, ok: true, findings: consensus.findings.length, text: JSON.stringify(consensus, null, 2) }] : [],
      error: consensus ? null : "no consensus report on disk",
    };
  }

  const paths = status.paths || {};
  return {
    job: jobName,
    dir: jobDir,
    ref: meta.ref || status.ref || null,
    title: meta.title || status.title || jobName,
    reviewedSha: meta.reviewedSha || status.reviewedSha || fromReportHead(jobDir) || null,
    startedAt: meta.startedAt || status.startedAt || null,
    completedAt: status.completedAt || null,
    stage: status.stage || (fallback ? (hasReport ? "complete" : hasConsensus ? "complete" : "failed") : "unknown"),
    error: status.error || (fallback && !hasReport ? "no final report on disk" : null),
    agents,
    consensus,
    jiraAc: status.jiraAc || null,
    vision: status.vision || null,
    commentPolicy: status.commentPolicy || null,
    publish: status.publish || null,
    paths: {
      jobDir,
      finalReport: existsSync(path.join(jobDir, "final-report.md")) ? path.join(jobDir, "final-report.md") : paths.finalReport || null,
      commentDraft: existsSync(path.join(jobDir, "comment-draft.md")) ? path.join(jobDir, "comment-draft.md") : paths.commentDraft || null,
    },
  };
}

function fromReportHead(jobDir) {
  try {
    const t = readFileSync(path.join(jobDir, "final-report.md"), "utf8");
    const m = t.match(/reviewed commit `([0-9a-f]{8})/);
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  return null;
}

export function readJobDetail(config, jobName) {
  return readJobSummary(config, jobName);
}

/** Map of artifact name -> content for a job dir (bounded sizes). */
export function readJobArtifacts(config, jobName, { maxBytes = 2_000_000 } = {}) {
  const jobDir = path.join(config.dirs.jobs, jobName);
  if (!existsSync(jobDir)) return {};
  const out = {};
  for (const f of readdirSync(jobDir)) {
    const full = path.join(jobDir, f);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const size = st.size;
    const kind = path.extname(f).slice(1) || "txt";
    const isText = ["json", "md", "txt", "patch", "log"].includes(kind);
    out[f] = {
      name: f,
      size,
      kind,
      truncated: size > maxBytes,
      content: isText ? readFileSync(full, "utf8").slice(0, maxBytes) : null,
    };
  }
  return out;
}

function readFileJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
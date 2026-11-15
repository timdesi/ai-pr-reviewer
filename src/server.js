// Optional local web dashboard + Bitbucket webhook front door.
//
//   npm run ui
//
// Serves the static UI from `ui/` (the project root of the `dev` folder) and
// exposes:
//   GET  /api/jobs                list past/active jobs
//   GET  /api/jobs/:name          job detail (status.json)
//   GET  /api/jobs/:name/artifacts  all artifact files (bounded content)
//   GET  /api/events              Server-Sent Events stream (live run updates)
//   GET  /api/pulls?live=1        per-PR view: grouped reviews + live head/new
//                                 commits since the last review (src/pulls.js)
//   GET  /api/stats               management KPIs: cost, runs, PRs, repos,
//                                 cadence & trend series (src/stats.js)
//   GET  /api/models              available models + current A/B/C/D/consensus/
//                                 vision assignments (vision picks marked image-capable)
//   PUT  /api/models              persist A/B/C/D/consensus/vision defaults
//                                 {models: {...}} — vision rejects non-image models
//   POST /api/review              start a review in-process  {pr, publish?, models?}
//   POST /api/jobs/:name/publish  publish a finished job's report as a comment
//   POST /webhooks/bitbucket      Bitbucket DC `pr:comment:added` and
//                                 `pr:reviewer:updated` webhooks; a comment
//                                 starting with `/ai-review`, or a configured
//                                 user being added as reviewer, triggers a
//                                 review (see src/webhook.js). The result is
//                                 posted back to the PR only when
//                                 PUBLISH_TO_BITBUCKET is enabled; otherwise the
//                                 run stops at a draft (dry-run).
//   GET  /healthz                 liveness/readiness probe
//
// One review runs at a time; extra requests (webhook or UI) wait in an
// in-process FIFO queue. CLI runs and UI runs share `jobs/`.

import http from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

import { loadConfig, assertAnyBackendConfig } from "./config.js";
import { parsePrRef } from "./prUrl.js";
import { runReview, listJobs, readJobSummary, readJobArtifacts, jobPrefixFor } from "./pipeline.js";
import { listPulls, clearPullCache } from "./pulls.js";
import { computeStats } from "./stats.js";
import { parseWebhookRequest, verifySignature, isUnsignedDiagnostic, isForceReview } from "./webhook.js";
import { parseGitHubWebhookRequest } from "./webhook-github.js";
import { findPreviousReview, alreadyReviewedAt } from "./previous.js";
import { hasNewHumanDiscussion, previousReviewCommentId } from "./discussion.js";
import { initProxy } from "./proxy.js";
import { BitbucketClient } from "./bitbucket.js";
import { createReviewClient, botUsernamesOf, shouldPublish, prCommentUrl, liveClients } from "./clients.js";
import { defaultPriceCandidates, listAvailableModels } from "./costs.js";
import { writeModelAssignments } from "./models.js";
import { log } from "./log.js";

const UI_DIR = path.join(import.meta.dirname, "..", "ui");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Deliver a finished review's public comment to Bitbucket, guarding against a
// changed head. Used by the manual "post saved draft" button (with optional
// edited text) and by the webhook dedup path (an already-reviewed head is
// delivered rather than silently dropped). Returns `{ published:true,
// commentId, url }` on success, or `{ published:false, stale?, error? }`.
async function publishReview(config, jobName, { customText, client } = {}) {
  const detail = readJobSummary(config, jobName);
  const draftPath =
    detail.paths?.commentDraft && existsSync(detail.paths.commentDraft)
      ? detail.paths.commentDraft
      : null;
  // Fall back to the full report for legacy jobs that predate the split.
  const reportPath =
    detail.paths?.finalReport && existsSync(detail.paths.finalReport)
      ? detail.paths.finalReport
      : null;
  if (!draftPath && !reportPath && !customText) {
    return { published: false, error: "job has no report to publish" };
  }
  const markdown = customText || readFileSync(draftPath ?? reportPath, "utf8");
  const consensus = detail.consensus ?? {};
  const ref = detail.ref;
  // Platform-selected client (defaults to the bitbucket one via the ref).
  const bk = client || createReviewClient(config, ref);
  const current = await bk.getPullRequest(ref);
  const currentSha = current.fromRef?.latestCommit || current.fromRef?.id;
  const reviewedSha = consensus.reviewed_sha || detail.reviewedSha;
  if (currentSha && reviewedSha && currentSha !== reviewedSha) {
    return { published: false, stale: true, error: `PR head changed (${currentSha.slice(0, 8)} != ${reviewedSha.slice(0, 8)}); not publishing` };
  }
  const comment = await bk.postPullRequestComment({ ...ref, text: markdown });
  // GitHub returns the comment's real URL; Bitbucket deep-links via ?comment=.
  const url = comment?.html_url || prCommentUrl({ ref, client: bk, commentId: comment.id });
  // Persist the publication in status.json so the UI shows it as posted.
  try {
    const statusPath = path.join(config.dirs.jobs, jobName, "status.json");
    const status = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) : {};
    status.publish = { published: true, stale: false, commentId: comment.id, url, draft: null, reason: null };
    status.stage = "complete";
    writeFileSync(statusPath, JSON.stringify(status, null, 2));
  } catch (e) {
    log.warn(`could not persist publish state: ${e.message}`);
  }
  // Persist an edited draft back to comment-draft.md so the artifact and the
  // Overview "post saved draft" button always reflect the published text.
  if (customText) {
    try {
      writeFileSync(draftPath ?? path.join(config.dirs.jobs, jobName, "comment-draft.md"), markdown);
    } catch (e) {
      log.warn(`could not persist edited draft: ${e.message}`);
    }
  }
  return { published: true, commentId: comment.id, url };
}

// Outcome message when an automatic trigger hits an already-reviewed head:
// deliver the held comment when publishing is enabled, otherwise explain why
// nothing is posted. Never throws (webhook ack must not depend on delivery).
async function existingReviewOutcome(config, previous, { platform = "bitbucket" } = {}) {
  const short = previous.sha ? String(previous.sha).slice(0, 8) : "an earlier commit";
  const publishOn = platform === "github" ? config.job.publishToGithub : !config.job.dryRun;
  let status = {};
  try {
    const p = path.join(config.dirs.jobs, previous.job, "status.json");
    status = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  } catch {
    // unreadable status — fall through to the publish attempt
  }
  if (status.publish?.published) {
    return `already reviewed and published at ${short}; nothing to do (comment ${status.publish.commentId})`;
  }
  if (!publishOn) {
    return platform === "github"
      ? `already reviewed at ${short}; auto-publishing is off (PUBLISH_TO_GITHUB=0), nothing posted to GitHub`
      : `already reviewed at ${short}; auto-publishing is off (PUBLISH_TO_BITBUCKET=0), nothing posted to Bitbucket`;
  }
  try {
    const r = await publishReview(config, previous.job);
    if (r.published) {
      return platform === "github"
        ? `delivered the existing review of ${short} to GitHub (comment ${r.commentId})`
        : `delivered the existing review of ${short} to Bitbucket (comment ${r.commentId})`;
    }
    if (r.stale) return `already reviewed at ${short} but the PR head moved since; existing review not published`;
    return `already reviewed at ${short}; existing review not published (${r.error || "unknown"})`;
  } catch (err) {
    log.warn(`delivering existing review failed: ${err.message}`);
    return `already reviewed at ${short}; existing review could not be published (${err.message})`;
  }
}

// When the same-head dedup fires we treat the previous review as the baseline:
// anything the author/team commented AFTER it finished is "new discussion". The
// previous review's publish/completion time is the boundary (comments before it
// were already consumed). Returns an epoch-ms number, or null when unknown.
function previousReviewTimeMs(config, previous) {
  try {
    const p = path.join(config.dirs.jobs, previous.job, "status.json");
    if (!existsSync(p)) return null;
    const status = JSON.parse(readFileSync(p, "utf8"));
    const t = new Date(status.completedAt || status.startedAt).getTime();
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch {
    return null;
  }
}

// Short reply, threaded under the user's `/ai-review` comment, for the case
// where everything is unchanged (same commit, no new discussion): teaches them
// `/ai-review --force`. Only posted when publishing is enabled (never in
// dry-run) and never throws — the webhook ack must not depend on it.
const TEACH_FORCE_REPLY = (short) =>
  `No changes since the last review (same commit \`${short}\`, no new comments), so there was nothing new to check and I skipped a redundant re-review.\n\nTo force a fresh review anyway, comment: \`/ai-review --force\``;

async function replyTeachForce(config, ref, triggerCommentId, previous) {
  // Only reply when publishing is enabled for the *ref's own platform* — the
  // per-platform contract (PUBLISH_TO_BITBUCKET / PUBLISH_TO_GITHUB) must not
  // be bypassed by a GitHub ref while its gate is off.
  if (!shouldPublish(config, ref)) return;
  const short = previous?.sha ? String(previous.sha).slice(0, 8) : "…";
  try {
    const client = createReviewClient(config, ref);
    const comment = await client.postPullRequestComment({
      projectKey: ref.projectKey,
      repoSlug: ref.repoSlug,
      prId: ref.prId,
      text: TEACH_FORCE_REPLY(short),
      parentId: triggerCommentId,
    });
    log.info(`webhook: taught /ai-review --force (comment #${comment.id}) on ${ref.projectKey}/${ref.repoSlug}#${ref.prId}`);
  } catch (err) {
    log.warn(`webhook: could not post --force hint: ${err.message}`);
  }
}

export function createServer({ config, port = config.server.port, host = config.server.host, runReview: reviewRunner = runReview } = {}) {
  assertAnyBackendConfig(config);
  const clients = new Set();
  // One review runs at a time; extra requests (webhook or UI) wait in the queue.
  const state = { runningJob: null, activeRef: null, queue: [] };

  // Where the server enumerates selectable models (same source as the cost
  // dashboard). Cached per-request-ish: recomputed on each model API call.
  const modelCandidates = defaultPriceCandidates({
    projectRoot: config.projectRoot,
    home: process.env.HOME,
    override: config.costs?.configPath,
  });
  const availableById = () => {
    const out = new Map();
    for (const m of listAvailableModels(modelCandidates)) out.set(m.id, m);
    return out;
  };
  // A model is image-capable when the opencode config declares image input in
  // its `capabilities` (`listAvailableModels` -> `image`). That is the source
  // of truth for the vision slot in the Models dialog — not the transcriber's
  // route (a capable model still degrades gracefully if routing is unavailable).
  const MODEL_SLOT_KEYS = ["a", "b", "c", "d", "consensus", "vision"];
  const assignedModels = () => ({
    a: config.models.reviewerA,
    b: config.models.reviewerB,
    c: config.models.reviewerC,
    d: config.models.reviewerD,
    consensus: config.models.consensus,
    vision: config.review.visionModel,
  });

  // Keep only provided slots that name a model known to the runtime config;
  // the vision slot additionally requires an image-capable model.
  const normalizeModelSlots = (wanted) => {
    const out = {};
    const bad = [];
    const byId = availableById();
    const ids = new Set(byId.keys());
    for (const slot of MODEL_SLOT_KEYS) {
      const v = wanted && wanted[slot];
      if (typeof v !== "string" || !v.trim()) continue;
      const t = v.trim();
      if (!ids.has(t)) {
        bad.push(`${slot}=${t}`);
        continue;
      }
      if (slot === "vision" && !byId.get(t).image) {
        bad.push(`${slot}=${t} (not image-capable)`);
        continue;
      }
      out[slot] = t;
    }
    return { out, bad };
  };

  const sameRef = (a, b) =>
    !!a && !!b &&
    (a.platform || "bitbucket") === (b.platform || "bitbucket") &&
    a.projectKey === b.projectKey && a.repoSlug === b.repoSlug && a.prId === b.prId;

  const startNext = () => {
    if (state.runningJob || state.queue.length === 0) return false;
    const next = state.queue.shift();
    state.runningJob = "starting";
    state.activeRef = next.ref;
    reviewRunner({
      ref: next.ref,
      config,
      options: {
        publish: next.publish,
        models: next.models,
        emit: (evt) => {
          if (evt.type === "job-ready") state.runningJob = evt.jobName;
          if (evt.type === "complete" || evt.type === "error") {
            const done = { ...evt };
            // A review finished → force a fresh head/new-commits lookup for that
            // PR (the remembered reviewed SHA may now be behind the head).
            clearPullCache();
            setTimeout(() => {
              if (state.runningJob === done.job || state.runningJob === "starting") {
                state.runningJob = null;
                state.activeRef = null;
              }
              broadcast({ type: "jobs-changed", job: done.job });
              startNext();
            }, 500);
          }
          broadcast(evt);
        },
      },
    }).catch((err) => {
      broadcast({ type: "error", message: err.message, job: state.runningJob });
      state.runningJob = null;
      state.activeRef = null;
      broadcast({ type: "jobs-changed", job: state.runningJob });
      log.error(`review failed: ${err.message}`);
      startNext();
    });
    return true;
  };

  const enqueue = ({ ref, publish, models }) => {
    if (sameRef(ref, state.activeRef) || state.queue.some((q) => sameRef(q.ref, ref))) {
      return { queued: false, duplicate: true, position: 0 };
    }
    state.queue.push({ ref, publish, models });
    startNext();
    return { queued: true, duplicate: false, position: state.queue.length };
  };

  const broadcast = (evt) => {
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of clients) {
      try {
        res.write(line);
      } catch {
        clients.delete(res);
      }
    }
  };

  const sendJson = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (d) => (data += d));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error("invalid JSON body"));
        }
      });
      req.on("error", reject);
    });

  // Raw body variant — the webhook signature is an HMAC over the raw bytes.
  const readRawBody = (req) =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (d) => (data += d));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  const jobNameFromPath = (url) => {
    const m = url.match(/^\/api\/jobs\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };

  const server = http.createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    const method = req.method || "GET";
    try {
      // --- health ----------------------------------------------------------
      if (url === "/healthz") {
        return sendJson(res, 200, { ok: true });
      }

      // --- webhook ---------------------------------------------------------
      if (url === "/webhooks/bitbucket" && method === "POST") {
        const raw = await readRawBody(req);
        // Bitbucket's "Test connection" / keepalive event is not signed; the
        // event header identifies it and the body is never parsed as a review
        // request, so accepting it early is safe and keeps the UI test green.
        if (isUnsignedDiagnostic(req.headers["x-event-key"])) {
          log.info("webhook: diagnostics:ping accepted (unsigned test event)");
          return sendJson(res, 200, { ok: true, ignored: "diagnostics:ping" });
        }
        const sigCheck = verifySignature(raw, req.headers["x-hub-signature"], config.bitbucket.webhookSecret);
        if (!sigCheck.ok) {
          log.warn(`webhook rejected: ${sigCheck.reason}`);
          return sendJson(res, 401, { error: sigCheck.reason });
        }
        let payload = null;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          return sendJson(res, 400, { error: "invalid JSON body" });
        }
        const parsed = parseWebhookRequest({
          payload,
          allowedUsers: config.job.allowedReviewerUsers,
          autoReviewOffRepos: config.job.autoReviewOffRepos,
          reviewerSkipBranchPairs: config.job.reviewOnReviewerAddedSkip,
        });
        if (!parsed.ok) {
          if (parsed.status === 200) {
            log.info(`webhook: ${parsed.ignored}`);
            return sendJson(res, 200, { ok: true, ignored: parsed.ignored });
          }
          log.warn(`webhook ignored: ${parsed.error}`);
          return sendJson(res, parsed.status, { error: parsed.error });
        }
        // Same-head dedup: skip when the PR head was already reviewed at this
        // commit AND nothing new happened since — no new commits and no new
        // human discussion (v0.3.8). A NEW author/team comment on an unchanged
        // head (e.g. a reply to our findings, or an inline note) is a real
        // re-review trigger: the context-aware feature consumes it, so we run
        // instead of skip. With publishing enabled the held review is delivered
        // to Bitbucket instead of silently dropped. Applies to automatic
        // triggers (reviewer added / opened / marked ready) and to the explicit
        // /ai-review comment; "/ai-review --force" (or "-force") always runs a
        // fresh review.
        const forced = parsed.text ? isForceReview(parsed.text) : false;
        if (parsed.head && !forced) {
          const prefix = jobPrefixFor(parsed.ref);
          const previous = findPreviousReview({ jobsDir: config.dirs.jobs, jobPrefix: prefix, currentJob: null });
          if (alreadyReviewedAt(previous, parsed.head)) {
            let newDiscussion = false;
            if (config.review.fetchPrDiscussion) {
              const since = previousReviewTimeMs(config, previous);
              const excludeIds = new Set();
              const prevCommentId = previousReviewCommentId(previous, { jobsDir: config.dirs.jobs });
              if (prevCommentId != null) excludeIds.add(Number(prevCommentId));
              if (parsed.commentId != null) excludeIds.add(Number(parsed.commentId));
              newDiscussion = await hasNewHumanDiscussion({
                client: new BitbucketClient(config.bitbucket),
                ref: parsed.ref,
                botUsernames: [config.bitbucket.username].filter(Boolean),
                since,
                excludeIds,
              });
            }
            if (!newDiscussion) {
              const outcome = await existingReviewOutcome(config, previous);
              const who = parsed.reviewer ? `auto ${parsed.via} ${parsed.reviewer}` : `/ai-review by ${parsed.actor || "?"}`;
              log.info(`webhook ${who} ${parsed.ref.projectKey}/${parsed.ref.repoSlug}#${parsed.ref.prId}: ${outcome}`);
              // v0.3.8: an explicit /ai-review on a fully unchanged head gets a
              // short threaded reply teaching --force (auto triggers stay silent).
              if (!parsed.reviewer && parsed.commentId != null) {
                await replyTeachForce(config, parsed.ref, parsed.commentId, previous);
              }
              return sendJson(res, 200, { ok: true, ignored: outcome });
            }
            log.info(
              `webhook /ai-review ${parsed.ref.projectKey}/${parsed.ref.repoSlug}#${parsed.ref.prId}: same head but new discussion since the last review — re-reviewing`,
            );
          }
        }
        // Publish only when explicitly enabled (PUBLISH_TO_BITBUCKET=1); the
        // default is a dry-run that stops at a draft comment.
        const publish = !config.job.dryRun;
        const { queued, duplicate, position } = enqueue({ ref: parsed.ref, publish });
        const via = parsed.reviewer ? `${parsed.via} ${parsed.reviewer}` : "/ai-review";
        log.info(
          `webhook ${via} ${parsed.ref.projectKey}/${parsed.ref.repoSlug}#${parsed.ref.prId} by ${parsed.actor} queued=${queued} duplicate=${duplicate} publish=${publish}`,
        );
        return sendJson(res, 200, { ok: true, accepted: true, queued, duplicate, position, ref: parsed.ref });
      }

      // --- GitHub webhook --------------------------------------------------
      if (url === "/webhooks/github" && method === "POST") {
        if (!config.github?.webhookSecret) {
          log.warn("webhook rejected: github backend not configured (GITHUB_WEBHOOK_SECRET)");
          return sendJson(res, 403, { error: "GitHub webhook not configured" });
        }
        const raw = await readRawBody(req);
        // GitHub's webhook test button delivers an unsigned `ping` event. It
        // triggers nothing, so it is accepted without an HMAC check (the
        // empty-secret guard above has already ruled out a disabled endpoint);
        // real deliveries still require a valid X-Hub-Signature-256.
        if (String(req.headers["x-github-event"] || "").toLowerCase() === "ping") {
          log.info("webhook: github ping accepted (unsigned test event)");
          return sendJson(res, 200, { ok: true, ignored: "ping" });
        }
        const sigCheck = verifySignature(raw, req.headers["x-hub-signature-256"], config.github.webhookSecret);
        if (!sigCheck.ok) {
          log.warn(`webhook rejected: ${sigCheck.reason}`);
          return sendJson(res, 401, { error: sigCheck.reason });
        }
        let payload = null;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          return sendJson(res, 400, { error: "invalid JSON body" });
        }
        const parsed = parseGitHubWebhookRequest({
          headers: req.headers,
          payload,
          allowedUsers: config.job.allowedReviewerUsers,
          autoReviewOffRepos: config.job.githubAutoReviewOffRepos,
          reviewerSkipBranchPairs: config.job.reviewOnReviewerAddedSkip,
        });
        if (!parsed.ok) {
          if (parsed.status === 200) {
            log.info(`webhook: ${parsed.ignored}`);
            return sendJson(res, 200, { ok: true, ignored: parsed.ignored });
          }
          log.warn(`webhook ignored: ${parsed.error}`);
          return sendJson(res, parsed.status, { error: parsed.error });
        }
        // Same-head dedup (GitHub only includes the head SHA on pull_request
        // events — an /ai-review comment always re-reviews). "/ai-review
        // --force" (or "-force") always runs a fresh review.
        const forced = parsed.text ? isForceReview(parsed.text) : false;
        if (parsed.head && !forced) {
          const prefix = jobPrefixFor(parsed.ref);
          const previous = findPreviousReview({ jobsDir: config.dirs.jobs, jobPrefix: prefix, currentJob: null });
          if (alreadyReviewedAt(previous, parsed.head)) {
            let newDiscussion = false;
            if (config.review.fetchPrDiscussion) {
              const since = previousReviewTimeMs(config, previous);
              const excludeIds = new Set();
              const prevCommentId = previousReviewCommentId(previous, { jobsDir: config.dirs.jobs });
              if (prevCommentId != null) excludeIds.add(Number(prevCommentId));
              if (parsed.commentId != null) excludeIds.add(Number(parsed.commentId));
              newDiscussion = await hasNewHumanDiscussion({
                client: createReviewClient(config, parsed.ref),
                ref: parsed.ref,
                botUsernames: botUsernamesOf(config, parsed.ref),
                since,
                excludeIds,
              });
            }
            if (!newDiscussion) {
              const outcome = await existingReviewOutcome(config, previous, { platform: "github" });
              const who = parsed.reviewer ? `auto ${parsed.via} ${parsed.reviewer}` : `/ai-review by ${parsed.actor || "?"}`;
              log.info(`webhook ${who} ${parsed.ref.projectKey}/${parsed.ref.repoSlug}#${parsed.ref.prId}: ${outcome}`);
              return sendJson(res, 200, { ok: true, ignored: outcome });
            }
            log.info(
              `webhook /ai-review ${parsed.ref.projectKey}/${parsed.ref.repoSlug}#${parsed.ref.prId}: same head but new discussion since the last review — re-reviewing`,
            );
          }
        }
        const publish = shouldPublish(config, parsed.ref);
        const { queued, duplicate, position } = enqueue({ ref: parsed.ref, publish });
        const via = parsed.reviewer ? `${parsed.via} ${parsed.reviewer}` : "/ai-review";
        log.info(
          `webhook ${via} ${parsed.ref.projectKey}/${parsed.ref.repoSlug}#${parsed.ref.prId} by ${parsed.actor} queued=${queued} duplicate=${duplicate} publish=${publish}`,
        );
        return sendJson(res, 200, { ok: true, accepted: true, queued, duplicate, position, ref: parsed.ref });
      }

      // --- SSE -------------------------------------------------------------
      if (url === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        res.write(`event: hello\ndata: {"ok":true}\n\n`);
        clients.add(res);
        const heartbeat = setInterval(() => {
          res.write(`: hb\n\n`);
        }, 15000);
        req.on("close", () => {
          clearInterval(heartbeat);
          clients.delete(res);
        });
        return;
      }

      // --- API -------------------------------------------------------------
      if (url === "/api/models" && method === "GET") {
        const available = listAvailableModels(modelCandidates).map((m) => ({
          ...m,
          // `vision: true` = the model can be picked for the screenshots step.
          vision: m.image,
        }));
        return sendJson(res, 200, { available, assigned: assignedModels() });
      }

      if (url === "/api/models" && method === "PUT") {
        const body = await readBody(req);
        const { out, bad } = normalizeModelSlots(body && body.models);
        if (bad.length) return sendJson(res, 400, { error: `unknown model(s): ${bad.join(", ")}` });
        if (!Object.keys(out).length) return sendJson(res, 400, { error: "no model slots provided" });
        const saved = writeModelAssignments(config.models.settingsFile, out);
        // Apply immediately so queued/next reviews (UI + webhook) use the choice.
        config.models.reviewerA = saved.a || config.models.reviewerA;
        config.models.reviewerB = saved.b || config.models.reviewerB;
        config.models.reviewerC = saved.c || config.models.reviewerC;
        config.models.reviewerD = saved.d || config.models.reviewerD;
        config.models.consensus = saved.consensus || config.models.consensus;
        if (saved.vision) config.review.visionModel = saved.vision;
        return sendJson(res, 200, { ok: true, assigned: assignedModels() });
      }

      if (url === "/api/jobs") {
        return sendJson(res, 200, { jobs: listJobs(config) });
      }

      // --- per-PR view ------------------------------------------------------
      // `live=0` skips the platform head/commit lookups (local jobs only).
      if (url === "/api/pulls") {
        const q = new URL(req.url, "http://localhost").searchParams;
        const live = q.get("live") !== "0";
        const out = await listPulls(config, {
          live,
          clients: live ? liveClients(config) : {},
        });
        return sendJson(res, 200, out);
      }

      // --- management statistics (offline, computed from the jobs dir) -------
      if (url === "/api/stats") {
        return sendJson(res, 200, computeStats(config));
      }

      const jobName = jobNameFromPath(url);
      if (url.startsWith("/api/jobs/") && url.endsWith("/artifacts")) {
        return sendJson(res, 200, { job: jobName, artifacts: readJobArtifacts(config, jobName) });
      }
      if (url.startsWith("/api/jobs/") && !url.endsWith("/publish")) {
        if (!existsSync(path.join(config.dirs.jobs, jobName))) return sendJson(res, 404, { error: "job not found" });
        const detail = readJobSummary(config, jobName);
        return sendJson(res, 200, { job: detail });
      }

      if (jobName && url.endsWith("/publish")) {
        if (!existsSync(path.join(config.dirs.jobs, jobName))) return sendJson(res, 404, { error: "job not found" });
        // Optional edited text submitted from the UI's Comment draft tab; when
        // absent we publish the saved draft file (legacy/full-report fallback).
        const body = await readBody(req);
        const customText = typeof body.text === "string" && body.text.trim();
        const result = await publishReview(config, jobName, { customText });
        if (!result.published) {
          const statusCode = result.stale ? 409 : 400;
          return sendJson(res, statusCode, { error: result.error });
        }
        return sendJson(res, 200, { ok: true, commentId: result.commentId, url: result.url });
      }

      // --- start a review --------------------------------------------------
      if (url === "/api/review") {
        const body = await readBody(req);
        let ref;
        try {
          ref = parsePrRef(body.pr);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
        // Merged / declined / superseded PRs can no longer be reviewed — and
        // neither can PRs the platform no longer has (404: purged after merge
        // or decline). Fail open on other errors (network etc.) so a lookup
        // outage never blocks the dashboard; the run itself would surface the
        // error. The platform branch is exclusive: a GitHub ref is only ever
        // looked up on GitHub (a missing GITHUB_TOKEN skips the gate instead of
        // leaking the GitHub ref into the Bitbucket lookup).
        if (ref.platform === "github") {
          if (config.github?.token) {
            try {
              const client = createReviewClient(config, ref);
              const pr = await client.getPullRequest(ref);
              const st = String(pr?.state || "").toUpperCase();
              if (["MERGED", "CLOSED"].includes(st)) {
                return sendJson(res, 409, {
                  error: `PR ${ref.projectKey}/${ref.repoSlug}#${ref.prId} is ${st.toLowerCase()} and can no longer be reviewed`,
                });
              }
            } catch (err) {
              if (err?.status === 404 || /does not exist|not found/i.test(err?.message || "")) {
                return sendJson(res, 409, {
                  error: `PR ${ref.projectKey}/${ref.repoSlug}#${ref.prId} no longer exists in GitHub and can no longer be reviewed`,
                });
              }
              /* other lookup failures are allowed through */
            }
          }
        } else if (config.bitbucket?.baseUrl && config.bitbucket?.token) {
          try {
            const client = new BitbucketClient(config.bitbucket);
            const pr = await client.getPullRequest(ref);
            const st = String(pr?.state || "").toUpperCase();
            if (["MERGED", "DECLINED", "SUPERSEDED"].includes(st)) {
              return sendJson(res, 409, {
                error: `PR ${ref.projectKey}/${ref.repoSlug}#${ref.prId} is ${st.toLowerCase()} and can no longer be reviewed`,
              });
            }
          } catch (err) {
            if (err?.status === 404 || /does not exist|not found/i.test(err?.message || "")) {
              return sendJson(res, 409, {
                error: `PR ${ref.projectKey}/${ref.repoSlug}#${ref.prId} no longer exists in Bitbucket and can no longer be reviewed`,
              });
            }
            /* other lookup failures are allowed through */
          }
        }
        const { out, bad } = normalizeModelSlots(body.models);
        if (bad.length) return sendJson(res, 400, { error: `unknown model(s): ${bad.join(", ")}` });
        const models = Object.keys(out).length ? out : undefined;
        const { queued, duplicate, position } = enqueue({ ref, publish: !!body.publish, models });
        return sendJson(res, 202, {
          accepted: true,
          queued,
          duplicate,
          position,
          ref,
          error: duplicate ? "a review for this PR is already queued or running" : undefined,
        });
      }

      // --- static UI -------------------------------------------------------
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(readFileSync(path.join(UI_DIR, "index.html")));
      }
      const filePath = path.normalize(path.join(UI_DIR, path.basename(url)));
      if (filePath.startsWith(UI_DIR) && existsSync(filePath)) {
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        return res.end(readFileSync(filePath));
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      log.error(`request error: ${err.message}`);
      try {
        sendJson(res, 500, { error: err.message });
      } catch {
        /* response already sent */
      }
    }
  });

  return { server, broadcast, get running() { return state.runningJob; }, get queue() { return state.queue.length; } };
}

export async function main() {
  const config = loadConfig();
  await initProxy();
  const { server } = createServer({ config });
  server.listen(config.server.port, config.server.host, () => {
    log.info(`AI PR Reviewer UI: http://${config.server.host}:${config.server.port}`);
    log.info(`Jobs dir: ${config.dirs.jobs}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
// PR screenshots: images pasted into the PR description and/or comments
// (Bitbucket `attachment:` refs, direct http(s) URLs, or data-URIs) instead of
// prose. The text-only reviewers cannot see images, so this module downloads
// them and asks a vision-capable model to transcribe each image into a compact
// text block that is attached to the reviewer + consensus context — the same
// non-fatal, additive pattern as the discussion block (src/discussion.js).
//
// Anything that cannot be fetched or read becomes a short "screenshots not
// viewable — ask the author" note rather than a silent gap or an error.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { log } from "./log.js";
import { flattenActivitiesToComments } from "./discussion.js";
import { runAgent } from "./opencode.js";

const IMAGE_MIME = /^image\//i;

// The transcription contract is authored once in prompts/vision-base.md (the
// `pr-vision` agent); this short message only points the agent at the task.
const VISION_TRANSCRIBE_MESSAGE = "Transcribe the attached screenshot. Output only the transcription text.";

const IMAGE_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Find markdown image refs (`![alt](src)`) in a piece of PR text. A ref is
 * kept only when it names something fetchable: a Bitbucket `attachment:a/b`
 * ref, an http(s) URL, or a `data:image/...` URI.
 */
export function extractImageRefs(text) {
  const out = [];
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(String(text ?? "")))) {
    const alt = (m[1] || "").trim();
    const target = (m[2] || "").trim();
    const am = target.match(/^attachment:(\d+)\/(\d+)$/i);
    if (am) {
      out.push({ type: "attachment", attachmentId: am[2], alt });
    } else if (/^https?:\/\//i.test(target)) {
      out.push({ type: "url", url: target, alt });
    } else if (/^data:image\//i.test(target)) {
      out.push({ type: "data", url: target, alt });
    }
    // anything else (relative plugin links, audio, etc.) is skipped silently
  }
  return out;
}

const attachmentUrl = (config, ref, attachmentId) =>
  `${config.bitbucket.baseUrl}/rest/api/1.0/projects/${encodeURIComponent(
    ref.projectKey,
  )}/repos/${encodeURIComponent(ref.repoSlug)}/attachments/${encodeURIComponent(attachmentId)}`;

async function downloadImage({ client, config, ref, img, timeoutMs, maxBytes }) {
  try {
    let res;
    let mimeType = "image/png";
    if (img.type === "data") {
      const comma = img.url.indexOf(",");
      mimeType = img.url.match(/^data:([^;,]+)(?:;[^,]*)?,\s*/)?.[1] || "image/png";
      const b64 = comma >= 0 ? img.url.slice(comma + 1) : img.url;
      res = { bytes: Buffer.from(b64, "base64"), contentType: mimeType };
    } else {
      const url = img.type === "attachment" ? attachmentUrl(config, ref, img.attachmentId) : img.url;
      res = await client.fetchBuffer(url, { timeoutMs });
      mimeType = res.contentType || "image/png";
    }
    if (!IMAGE_MIME.test(mimeType)) {
      log.warn(`vision: attachment ${img.attachmentId || img.url} is not an image (${mimeType})`);
      return null;
    }
    if (res.bytes.length === 0 || res.bytes.length > maxBytes) {
      log.warn(`vision: attachment ${img.attachmentId || img.url} is ${res.bytes.length} bytes (cap ${maxBytes})`);
      return null;
    }
    return res;
  } catch (err) {
    log.warn(`vision: could not fetch ${img.attachmentId ? `attachment #${img.attachmentId}` : img.url}: ${err.message}`);
    return null;
  }
}

/**
 * Collect the image refs that matter, deduplicated:
 *  - every ref in the PR description;
 *  - every ref in a non-bot comment's text (author/team clarifications also
 *    carry screenshots — handled at the next review exactly like the text).
 */
export function collectImageRefs({ description = "", comments = [], botUsernames = [] }) {
  const seen = new Set();
  const out = [];
  const bots = (botUsernames || []).map((b) => String(b).trim().toLowerCase()).filter(Boolean);
  const isBot = (author) =>
    !author || typeof author !== "object"
      ? false
      : [author.slug, author.name, author.emailAddress, author.displayName]
          .filter((v) => typeof v === "string" && v)
          .some((v) => bots.includes(v.toLowerCase()) || bots.some((b) => b.includes("@") && v.toLowerCase() === b.split("@")[0]));

  const push = (ref, sourceLabel) => {
    const key = ref.type === "attachment" ? `a:${ref.attachmentId}` : ref.type === "url" ? `u:${ref.url}` : `d:${String(ref.url).slice(0, 64)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ref, sourceLabel });
  };

  for (const ref of extractImageRefs(description)) push(ref, "description");
  for (const c of comments || []) {
    if (!c || c.deleted === true) continue;
    if (isBot(c.author)) continue;
    const who = c.author?.displayName || c.author?.name || c.author?.slug || "comment";
    for (const ref of extractImageRefs(c.text)) push(ref, `comment by ${who}`);
  }
  return out;
}

/**
 * Transcribe one screenshot through the shared opencode agent runtime: write the
 * image to a temp file, call the `pr-vision` agent with `--file`, and return a
 * plain `{ ok, text, usage, stdout, stderr, error }` envelope the caller can
 * both price (`usage`) and persist as an artifact (`.log` = stdout/stderr).
 *
 * `usage` is the standard 4-field agent shape `{ input, output, cacheRead,
 * cacheWrite }` (or `null` when the stream carried no token data) — the upgrade
 * from the old 2-field HTTP shape, so cache tokens are priced, not dropped.
 * Never throws: any failure degrades to a resolved envelope with `ok: false`
 * (the caller counts it as unreadable). Pre-flight skips (no bytes / invalid
 * model) return `null` — nothing was attempted.
 */
export async function transcribeViaAgent({
  config,
  model,
  imageBytes,
  mimeType = "image/png",
  timeoutMs = 60000,
  runner = runAgent,
}) {
  let tempDir = null;
  try {
    if (!imageBytes) {
      log.warn("vision: no image bytes — skipping transcription");
      return null;
    }
    // Validate the model id before delegating (the old visionRoute refused
    // unroutable ids without spawning anything): reject empty/whitespace,
    // control chars, and path-shaped values so a misconfigured VISION_MODEL
    // degrades to a log + skip instead of a doomed opencode run (AI review,
    // #17 minor 3).
    const m = String(model ?? "").trim();
    if (!m || !/^[A-Za-z0-9][A-Za-z0-9._/#:-]*$/.test(m)) {
      log.warn(`vision: no valid image-capable model configured (${model ?? "unset"}) — skipping transcription`);
      return null;
    }
    const ext = IMAGE_EXT[String(mimeType).toLowerCase()] || "png";
    // Anchor the scratch dir inside the project root (config.dirs.visionScratch)
    // instead of the OS temp dir: `opencode run` resolves its session's project
    // by walking up from the child cwd, and a bare /tmp dir can be taken for an
    // agent-less "new project" of its own — so the shared server never loads
    // `.opencode/agents/pr-vision.md` and every image fails with
    // "Agent not found: pr-vision" — the intermittent all-screenshots-unreadable
    // failure). The configured scratch root sits
    // under the project root, so opencode resolves the session to the app
    // project and finds the agent like the reviewers do — while the image still
    // lands in an isolated dir, never the app/review working directory.
    const scratchRoot = config.dirs?.visionScratch || os.tmpdir();
    await fs.mkdir(scratchRoot, { recursive: true });
    tempDir = await fs.mkdtemp(path.join(scratchRoot, "pr-vision-"));
    const tempImagePath = path.join(tempDir, `image.${ext}`);
    await fs.writeFile(tempImagePath, imageBytes);
    const res = await runner({
      bin: config.opencode.bin,
      agent: "pr-vision",
      model,
      file: tempImagePath,
      // Isolate the agent's workspace to the screenshot directory: it processes
      // author-controlled images, so its cwd must not be the app/review working
      // directory (which holds source + review artifacts). OPENCODE_CONFIG_DIR
      // still loads the configured agent/providers regardless (Copilot #17 HIGH).
      cwd: tempDir,
      timeoutSeconds: Math.max(1, Math.ceil(Number(timeoutMs) / 1000)),
      standalone: config.opencode.standalone,
      env: { ...process.env, OPENCODE_CONFIG_DIR: config.opencode.agentDir },
      message: VISION_TRANSCRIBE_MESSAGE,
    });
    // runAgent *resolves* (never rejects) on timeout / non-zero exit / spawn
    // failure with `ok: false` — that run is not authoritative context, but it
    // may still have consumed billable tokens, so surface `usage` even when the
    // caption is unusable: the caller prices it before marking the image
    // unreadable (Copilot #17 MEDIUM 2). The real stderr/stdout is carried back
    // so the pipeline can persist a `vision-N.log` artifact (the "exit code 1"
    // alone hid an `AgentNotFoundError` — that diagnosis must survive to the
    // job dir, not just the log line).
    if (res?.ok === false) {
      log.warn(
        `vision: transcription failed: ${res.error || "agent call failed"}` +
          (res.stderr ? ` — stderr: ${res.stderr.split("\n").slice(-4).join(" | ").slice(-400)}` : ""),
      );
      return {
        ok: false,
        text: null,
        usage: res.usage ?? null,
        stdout: res.stdout || "",
        stderr: res.stderr || "",
        error: res.error || "agent call failed",
      };
    }
    const text = res?.text?.trim();
    if (!text) {
      log.warn("vision: transcription returned no text");
      return {
        ok: false,
        text: null,
        usage: res?.usage ?? null,
        stdout: res?.stdout || "",
        stderr: res?.stderr || "",
        error: "transcription returned no text",
      };
    }
    return { ok: true, text, usage: res.usage ?? null, stdout: res.stdout || "", stderr: res.stderr || "", error: null };
  } catch (err) {
    log.warn(`vision: transcription failed: ${err.message}`);
    return { ok: false, text: null, usage: null, stdout: "", stderr: `${err.stack || err.message}\n`, error: err.message };
  } finally {
    if (tempDir) {
      // Cleanup is guaranteed even when the runner throws or times out; a
      // failed rm must never turn the (non-fatal) step into an error — but log
      // the leftover directory and the reason so repeated failures do not
      // accumulate silently (Copilot #17 MEDIUM 3).
      await fs.rm(tempDir, { recursive: true, force: true }).catch((err) => {
        log.warn(`vision: could not remove screenshot temp dir ${tempDir}: ${err.message}`);
      });
    }
  }
}

/**
 * Sweep stale per-image scratch dirs out of `dirs.visionScratch` (best-effort,
 * never throws). Each transcription's temp dir lives at most one call-timeout
 * window, so a sweep only ever removes dirs older than the configured
 * `review.visionScratchMaxAgeMs` — floored at two call timeouts so a
 * misconfigured tiny value can never delete a concurrent review's live dir.
 * Returns the number of dirs removed. `maxAgeMs` <= 0 disables the sweep.
 */
export async function sweepVisionScratch(config) {
  const scratchRoot = config.dirs?.visionScratch || os.tmpdir();
  const maxAge = Number(config.review?.visionScratchMaxAgeMs) || 0;
  if (!(maxAge > 0)) return 0;
  const callTimeout = Number(config.review?.visionCallTimeoutMs) || 60000;
  const age = Math.max(maxAge, 2 * callTimeout);
  let entries = [];
  try {
    entries = await fs.readdir(scratchRoot, { withFileTypes: true });
  } catch {
    return 0; // root may not exist yet — nothing to sweep
  }
  const now = Date.now();
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !String(e.name).startsWith("pr-vision-")) continue;
    const full = path.join(scratchRoot, e.name);
    try {
      const st = await fs.stat(full);
      if (now - st.mtimeMs >= age) {
        await fs.rm(full, { recursive: true, force: true });
        removed += 1;
        log.warn(`vision: swept stale screenshot scratch ${full} (mtime ${new Date(st.mtimeMs).toISOString()})`);
      }
    } catch (err) {
      log.warn(`vision: could not sweep ${full}: ${err.message}`);
    }
  }
  if (removed) log.info(`vision: swept ${removed} stale screenshot scratch dir(s) from ${scratchRoot}`);
  return removed;
}

/**
 * Build the "PR screenshots (transcribed)" context block. Returns
 * `{ block, usage, transcribed, unreadable }`:
 *   - `block`: the markdown block, or "" when there are no images, none could
 *     be read (callers then attach nothing — additive, non-fatal), or no vision
 *     model is configured (`review.visionModel` empty disables the whole step);
 *   - `usage`: `{ input, output, cacheRead, cacheWrite }` token counts summed
 *     across every successful transcription (null when no image yielded usage),
 *     so the vision model's cost can be priced separately (see src/pipeline.js);
 *   - `transcribed` / `unreadable`: image counts for the dashboard row;
 *   - `images`: per-image records (one per picked image, in `index` order:
 *     `{ index, sourceLabel, alt, ok, text, usage, stdout, stderr, error }`) so
 *     the pipeline can persist a `vision-<index>.txt/.log/.json` artifact per
 *     image like the reviewer attempts — including the failed ones, whose real
 *     stderr (e.g. `AgentNotFoundError`) must reach the job dir, not just the
 *     log line (see src/pipeline.js).
 * Never throws.
 */
export async function loadScreenshotBlock({
  client,
  config,
  ref,
  description = "",
  activities = [],
  transcribe = transcribeViaAgent,
}) {
  try {
    const { review } = config;
    if (!client || !review.fetchPrImages || !review.visionModel) return EMPTY_RESULT;
    const botUsernames = [config.bitbucket.username].filter(Boolean);
    const comments = flattenActivitiesToComments(activities);
    const items = collectImageRefs({ description, comments, botUsernames });
    if (!items.length) return EMPTY_RESULT;
    const picked = items.slice(0, Math.max(1, Number(review.visionMaxImages) || 6));

    // Best-effort: sweep stale per-image scratch dirs left over from earlier
    // (possibly killed) runs, before this review writes new ones. Never fatal.
    await sweepVisionScratch(config);

    const entries = [];
    const images = [];
    let unreadable = 0;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let index = 0;
    for (const { ref: img, sourceLabel } of picked) {
      index += 1;
      const alt = img.alt || `image #${index}`;
      const downloaded = await downloadImage({
        client,
        config,
        ref,
        img,
        timeoutMs: Number(review.visionFetchTimeoutMs) || 30000,
        maxBytes: Number(review.visionMaxImageBytes) || 10 * 1024 * 1024,
      });
      if (!downloaded) {
        unreadable += 1;
        images.push({ index, sourceLabel, alt, ok: false, text: "", usage: null, stdout: "", stderr: "", error: "image could not be fetched" });
        continue;
      }
      const res = await transcribe({
        config,
        model: review.visionModel,
        imageBytes: downloaded.bytes,
        mimeType: downloaded.contentType || "image/png",
        timeoutMs: Number(review.visionCallTimeoutMs) || 60000,
      });
      // Price the agent run's tokens even when the caption is unusable (failed,
      // timed out, or empty text): the run was billed, so record usage before
      // the unreadable-path `continue` below (Copilot #17 MEDIUM 2).
      const structured = res && typeof res === "object" && !Array.isArray(res);
      const u = structured ? res.usage : null;
      if (u) {
        usage.input += u.input || 0;
        usage.output += u.output || 0;
        usage.cacheRead += u.cacheRead || 0;
        usage.cacheWrite += u.cacheWrite || 0;
      }
      // Accept both the structured envelope `{ ok, text, usage, stdout, stderr,
      // error }` (from transcribeViaAgent) and a plain string caption (tests).
      const caption = structured ? res.text : res;
      const record = {
        index,
        sourceLabel,
        alt,
        ok: structured ? !!(res.ok !== false && caption) : !!caption,
        text: caption || "",
        usage: u,
        stdout: structured && res.stdout ? res.stdout : "",
        stderr: structured && res.stderr ? res.stderr : "",
        error: structured && res.error ? res.error : null,
      };
      images.push(record);
      if (!record.ok) {
        unreadable += 1;
        continue;
      }
      entries.push({ sourceLabel, alt, caption });
    }
    if (!entries.length && !unreadable) return EMPTY_RESULT;

    const lines = [`## PR screenshots (transcribed)`, ``];
    lines.push(
      `> Automated reading of the images pasted into this PR (description/comments) instead of `,
      `> prose. They state what the author expects to see or verify. Treat the transcription as`,
      `> authoritative context for expected behavior — verify the code against it, and never`,
      `> claim an image shows something the transcription does not.`,
      ``,
    );
    entries.forEach((e, i) => {
      lines.push(`${i + 1}. **${e.sourceLabel}** — _${e.alt}_`);
      lines.push(`   > ${String(e.caption).split("\n").join("\n   > ")}`);
      lines.push(``);
    });
    if (unreadable) {
      lines.push(`- ${unreadable} other screenshot${unreadable > 1 ? "s" : ""} could not be fetched/read — they are not reviewable; if they matter, ask the author to describe them.`);
      lines.push(``);
    }
    const block = lines.join("\n");
    log.info(`PR screenshots attached (${entries.length} transcribed, ${unreadable} unreadable)`);
    return {
      block,
      usage: usage.input || usage.output || usage.cacheRead || usage.cacheWrite ? usage : null,
      transcribed: entries.length,
      unreadable,
      images,
    };
  } catch (err) {
    log.warn(`vision: PR screenshots step degraded: ${err.message}`);
    return EMPTY_RESULT;
  }
}

const EMPTY_RESULT = Object.freeze({ block: "", usage: null, transcribed: 0, unreadable: 0, images: [] });

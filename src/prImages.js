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
 * image to a temp file, call the `pr-vision` agent with `--file`, and map the
 * agent's usage back onto the `{ text, usage }` envelope the image step expects.
 *
 * `usage` is the standard 4-field agent shape `{ input, output, cacheRead,
 * cacheWrite }` (or `null` when the stream carried no token data) — the upgrade
 * from the old 2-field HTTP shape, so cache tokens are priced, not dropped.
 * Never throws: any failure degrades to `null` (the caller counts it as
 * unreadable). One agent call per image — no retry loop.
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-vision-"));
    const tempImagePath = path.join(tempDir, `image.${ext}`);
    await fs.writeFile(tempImagePath, imageBytes);
    const res = await runner({
      bin: config.opencode.bin,
      agent: "pr-vision",
      model,
      file: tempImagePath,
      timeoutSeconds: Math.max(1, Math.ceil(Number(timeoutMs) / 1000)),
      standalone: config.opencode.standalone,
      env: { ...process.env, OPENCODE_CONFIG_DIR: config.opencode.agentDir },
      message: VISION_TRANSCRIBE_MESSAGE,
    });
    // runAgent *resolves* (never rejects) on timeout / non-zero exit / spawn
    // failure with `ok: false` — treat that as a failed transcription so a
    // truncated partial stream never becomes authoritative review context.
    if (res?.ok === false) {
      log.warn(`vision: transcription failed: ${res.error || "agent call failed"}`);
      return null;
    }
    const text = res?.text?.trim();
    if (!text) {
      log.warn("vision: transcription returned no text");
      return null;
    }
    return { text, usage: res.usage ?? null };
  } catch (err) {
    log.warn(`vision: transcription failed: ${err.message}`);
    return null;
  } finally {
    if (tempDir) {
      // Cleanup is guaranteed even when the runner throws or times out; a
      // failed rm must never turn the (non-fatal) step into an error.
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
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
 *   - `transcribed` / `unreadable`: image counts for the dashboard row.
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

    const entries = [];
    let unreadable = 0;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const { ref: img, sourceLabel } of picked) {
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
        continue;
      }
      const res = await transcribe({
        config,
        model: review.visionModel,
        imageBytes: downloaded.bytes,
        mimeType: downloaded.contentType || "image/png",
        timeoutMs: Number(review.visionCallTimeoutMs) || 60000,
      });
      // Accept both the structured `{ text, usage }` and a plain string caption.
      const caption = res ? (typeof res === "string" ? res : res.text) : null;
      if (!caption) {
        unreadable += 1;
        continue;
      }
      const u = res && typeof res === "object" ? res.usage : null;
      if (u) {
        usage.input += u.input || 0;
        usage.output += u.output || 0;
        usage.cacheRead += u.cacheRead || 0;
        usage.cacheWrite += u.cacheWrite || 0;
      }
      entries.push({ sourceLabel, alt: img.alt || `image #${img.attachmentId || picked.indexOf({ ref: img }) + 1}`, caption });
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
    return { block, usage: usage.input || usage.output || usage.cacheRead || usage.cacheWrite ? usage : null, transcribed: entries.length, unreadable };
  } catch (err) {
    log.warn(`vision: PR screenshots step degraded: ${err.message}`);
    return EMPTY_RESULT;
  }
}

const EMPTY_RESULT = Object.freeze({ block: "", usage: null, transcribed: 0, unreadable: 0 });

// AI-assisted drafting of curated context files (the dashboard "✨ Generate
// with AI" action).
//
// A developer on the dashboard's Context page picks a file (usually a per-repo
// `<PROJECT>-<repo>.md` that is missing, or an existing one to refine), may
// paste notes — false positives the bot keeps re-raising, conventions the
// reviewer gets wrong, anything the team wants it to know — and the dedicated
// `context-gen` opencode agent drafts the whole Markdown file. Best-effort we
// also hand it the repo's own `AGENTS.md` (default branch) as ground truth.
//
// The result is returned to the browser and placed in the editor as a REVISED
// DRAFT: curated context is authoritative to reviewers ("never contradict it"),
// so nothing is ever written to disk automatically — a human reviews and then
// hits Save. The generated file is not evidence on its own; the agent is
// instructed to attribute every claim and to put anything unverified in HTML
// comments (stripped before reviewers see it).

import { log } from "./log.js";
import { liveClients } from "./clients.js";
import { runAgent } from "./opencode.js";
import { ContextEditorError, validProjectRepo } from "./contextsEditor.js";

const MAX_NOTES_BYTES = 32 * 1024;
const MAX_EXISTING_BYTES = 256 * 1024;
const MAX_AGENTS_BYTES = 128 * 1024;

/** The model used for context drafting: CONTEXT_GEN_MODEL → consensus → A. */
export function pickContextGenModel(config) {
  return (
    String(config?.contextGen?.model || "").trim() ||
    String(config?.models?.consensus || "").trim() ||
    String(config?.models?.reviewerA || "").trim() ||
    ""
  );
}

// Best-effort: the combined platform clients that actually have credentials
// (bitbucket), so AGENTS.md fetching never constructs an unconfigured client.
function configuredClients(config) {
  try {
    return liveClients(config);
  } catch {
    return {};
  }
}

/**
 * Resolve the platform used to fetch the repo's AGENTS.md. An absent (or
 * unknown) platform picks whichever backend is actually configured — bitbucket
 * first (backward compatible), then github — so a GitHub-only instance still
 * gets its AGENTS.md grounding without the dashboard sending a platform.
 */
export function normalizeContextGenPlatform(platform, clients = {}) {
  if (platform === "github" || platform === "bitbucket") return platform;
  if (clients.bitbucket) return "bitbucket";
  if (clients.github) return "github";
  return "bitbucket";
}

// The repo's own AGENTS.md at the default branch — the exact file context.js
// attaches to every review there. Non-fatal: any failure → null.
async function fetchRepoAgentsMd(config, { platform, projectKey, repoSlug }) {
  const clients = configuredClients(config);
  const client = platform === "github" ? clients.github : clients.bitbucket;
  if (!client) return null;
  try {
    const raw = await client.getFileRaw({ projectKey, repoSlug, path: "AGENTS.md" });
    if (typeof raw !== "string" || !raw.trim()) return null;
    if (Buffer.byteLength(raw, "utf8") > MAX_AGENTS_BYTES) {
      log.warn(`context gen: ${projectKey}/${repoSlug} AGENTS.md too large — including it without a cap would bloat the prompt; skipped`);
      return raw.slice(0, MAX_AGENTS_BYTES);
    }
    return raw;
  } catch (err) {
    log.warn(`context gen: could not fetch ${projectKey}/${repoSlug} AGENTS.md: ${err.message}`);
    return null;
  }
}

export function buildContextGenMessage({ project, repo, notes = "", existing = "", agentsMd = null }) {
  const parts = [`Repository: \`${project}/${repo}\`.`];
  if (notes && notes.trim()) {
    parts.push(
      "Developer notes / false positives to encode (their words — rephrase them into concrete review rules, do not simply quote):\n" +
        notes.trim(),
    );
  }
  if (agentsMd && agentsMd.trim()) {
    parts.push(
      "The repo's own AGENTS.md (read at the default branch; ground truth — reference it, never restate it as your own invention):\n" +
        agentsMd.trim(),
    );
  }
  if (existing && existing.trim()) {
    parts.push(
      "Current content of this file. It is already curated — treat it as the authoritative base and PRESERVE it: keep every existing rule and false-positive entry that is still true (never drop or rewrite the file wholesale), fix only what the notes say is wrong, add what they ask for, and remove only what a note explicitly supersedes:\n" +
        existing.trim(),
    );
  }
  parts.push(
    "Write the complete curated context Markdown file. If existing content was provided, this is a REFINEMENT of it — every still-true existing rule must survive, verbatim or better-phrased, never silently lost.",
  );
  return parts.join("\n\n");
}

export function buildStackContextGenMessage({ name, notes = "", existing = "" }) {
  const parts = [
    `Stack: \`${name}\` — review rules applied to files matching the stack's \`match:\` patterns.`,
  ];
  if (notes && notes.trim()) {
    parts.push(
      "Developer notes / false positives to encode (their words — rephrase them into concrete review rules, do not simply quote):\n" +
        notes.trim(),
    );
  }
  if (existing && existing.trim()) {
    parts.push(
      "Current content of this file. It is already curated — PRESERVE it: keep the YAML front matter and its match: patterns unchanged unless the notes ask for new patterns, keep every existing rule that is still true, add per the notes, and remove only what a note explicitly supersedes:\n" +
        existing.trim(),
    );
  } else {
    parts.push(
      "The file must start with YAML front matter of the form:\n---\nmatch: [\"...\"]\n---\n\nwith one or more regex file-path patterns. Write review rules for files matching those patterns below the front matter.",
    );
  }
  parts.push(
    "Write the complete stack rules Markdown file. If existing content was provided, this is a refinement — every still-true existing rule must survive, never silently lost.",
  );
  return parts.join("\n\n");
}

// Undress a stray ```…``` wrapper the model sometimes adds around the file.
export function extractContextMarkdown(raw) {
  let t = String(raw ?? "").trim();
  const wrapped = t.match(/^```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (wrapped) t = wrapped[1].trim();
  return t;
}

// The shared validation + agent-run tail of both repo and stack drafting.
function assertGenModel(config) {
  const model = pickContextGenModel(config);
  if (!model) {
    throw new ContextEditorError(
      400,
      "no model configured for AI context generation — set CONTEXT_GEN_MODEL (or CONSENSUS_MODEL / REVIEWER_MODEL_A)",
    );
  }
  return model;
}

function assertNoteSizes(notes, existing) {
  const notesSize = Buffer.byteLength(String(notes ?? ""), "utf8");
  if (notesSize > MAX_NOTES_BYTES) {
    throw new ContextEditorError(413, `notes too large (${notesSize} bytes; max ${MAX_NOTES_BYTES})`);
  }
  const existingSize = Buffer.byteLength(String(existing ?? ""), "utf8");
  if (existingSize > MAX_EXISTING_BYTES) {
    throw new ContextEditorError(413, `existing content too large (${existingSize} bytes; max ${MAX_EXISTING_BYTES})`);
  }
}

async function runContextGen(config, model, message, runner) {
  const res = await runner({
    bin: config.opencode.bin,
    agent: "context-gen",
    model,
    cwd: config.projectRoot,
    timeoutSeconds: Number(config?.contextGen?.timeoutSeconds) || 300,
    standalone: config.opencode.standalone,
    env: { ...process.env, OPENCODE_CONFIG_DIR: config.opencode.agentDir },
    message,
  });

  if (res?.ok === false) {
    log.warn(
      `context gen: agent failed: ${res.error || "agent call failed"}` +
        (res.stderr ? ` — stderr: ${res.stderr.split("\n").slice(-4).join(" | ").slice(-400)}` : ""),
    );
    throw new ContextEditorError(502, `context generation failed: ${res.error || "agent call failed"}`);
  }
  const text = extractContextMarkdown(res?.text);
  if (!text) throw new ContextEditorError(502, "context generation returned no content");
  return {
    ok: true,
    text,
    model,
    usage: res.usage ?? null,
    durationMs: res.durationMs ?? null,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

/**
 * Draft (or refine) the curated context file for PROJECT/repo.
 * Never writes anything to disk: returns `{ ok, text, model, usage,
 * durationMs }` and the caller (dashboard) shows it as an editable draft.
 * `runner` and `agentsMd` are injectable for tests (defaults: real runAgent,
 * best-effort AGENTS.md fetch). `platform` is "bitbucket"/"github", or absent
 * to resolve from whichever backend is configured. Throws ContextEditorError
 * on validation / agent failure so the API can map it to a clean HTTP status.
 */
export async function generateContextDraft({ config, project, repo, notes = "", existing = "", platform, runner = runAgent, agentsMd }) {
  if (!validProjectRepo(project, repo)) {
    throw new ContextEditorError(400, "project and repo must be letters, digits, `-`, `_` or `.`");
  }
  const model = assertGenModel(config);
  assertNoteSizes(notes, existing);

  const repoAgents = agentsMd === undefined
    ? await fetchRepoAgentsMd(config, { platform: normalizeContextGenPlatform(platform, configuredClients(config)), projectKey: project, repoSlug: repo })
    : agentsMd;
  const message = buildContextGenMessage({ project, repo, notes, existing, agentsMd: repoAgents });

  return runContextGen(config, model, message, runner);
}

/**
 * Is `name` a valid stack file stub — the exact rule `safeContextFile`
 * enforces for `stacks/<name>.md` (letters/digits/`-`/`_`/`.`, no leading dot)?
 */
export function validStackName(name) {
  return typeof name === "string" && /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith(".");
}

/**
 * Draft (or refine) a stack rules file — `stacks/<name>.md` — the cross-repo
 * rules applied to any file whose path matches one of the stack's `match:`
 * patterns. Same never-writes contract and injectable `runner` as
 * generateContextDraft, but there is no single repo to ground on (no AGENTS.md
 * fetch): the agent works purely from the developer's notes plus the existing
 * content and the required `match:` front matter. Throws ContextEditorError on
 * validation / agent failure.
 */
export async function generateStackContextDraft({ config, name, notes = "", existing = "", runner = runAgent }) {
  if (!validStackName(name)) {
    throw new ContextEditorError(400, "stack name must be letters, digits, `-`, `_` or `.` (no leading dot)");
  }
  const model = assertGenModel(config);
  assertNoteSizes(notes, existing);
  const message = buildStackContextGenMessage({ name, notes, existing });
  return runContextGen(config, model, message, runner);
}

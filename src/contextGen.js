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
    parts.push("Current content of the file to refine (keep what is still true, fix what drifted, extend per the notes):\n" + existing.trim());
  }
  parts.push("Write the complete curated context Markdown file for this repository now.");
  return parts.join("\n\n");
}

// Undress a stray ```…``` wrapper the model sometimes adds around the file.
export function extractContextMarkdown(raw) {
  let t = String(raw ?? "").trim();
  const wrapped = t.match(/^```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (wrapped) t = wrapped[1].trim();
  return t;
}

/**
 * Draft (or refine) the curated context file for PROJECT/repo.
 * Never writes anything to disk: returns `{ ok, text, model, usage,
 * durationMs }` and the caller (dashboard) shows it as an editable draft.
 * `runner` and `agentsMd` are injectable for tests (defaults: real runAgent,
 * best-effort AGENTS.md fetch). Throws ContextEditorError on validation /
 * agent failure so the API can map it to a clean HTTP status.
 */
export async function generateContextDraft({ config, project, repo, notes = "", existing = "", platform = "bitbucket", runner = runAgent, agentsMd }) {
  if (!validProjectRepo(project, repo)) {
    throw new ContextEditorError(400, "project and repo must be alphanumeric, `-` or `_`");
  }
  const model = pickContextGenModel(config);
  if (!model) {
    throw new ContextEditorError(
      400,
      "no model configured for AI context generation — set CONTEXT_GEN_MODEL (or CONSENSUS_MODEL / REVIEWER_MODEL_A)",
    );
  }
  const notesSize = Buffer.byteLength(String(notes ?? ""), "utf8");
  if (notesSize > MAX_NOTES_BYTES) throw new ContextEditorError(413, `notes too large (${notesSize} bytes; max ${MAX_NOTES_BYTES})`);
  const existingSize = Buffer.byteLength(String(existing ?? ""), "utf8");
  if (existingSize > MAX_EXISTING_BYTES) {
    throw new ContextEditorError(413, `existing content too large (${existingSize} bytes; max ${MAX_EXISTING_BYTES})`);
  }

  const repoAgents = agentsMd === undefined
    ? await fetchRepoAgentsMd(config, { platform, projectKey: project, repoSlug: repo })
    : agentsMd;
  const message = buildContextGenMessage({ project, repo, notes, existing, agentsMd: repoAgents });

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

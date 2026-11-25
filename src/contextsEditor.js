// Curated-context editor backend.
//
// Backs the dashboard "Context" page, where the team views and edits the exact
// curated context that every review consumes (see src/context.js):
//   - per-repo files `<PROJECT>-<repo>.md` (fallback `<repo>.md`)
//   - project-wide files `<PROJECT>.md`
//   - stack rules under `stacks/*.md`
// All live under `dirs.contexts` (REVIEW_CONTEXT_DIR). Edits are written
// directly to the disk the server runs on and take effect on the next review
// of that repo — no restart and no redeploy needed.
//
// Local filesystem only: no platform calls. Every path is validated strictly
// (only `.md` under a safe basename, optional `stacks/` subdir, no `..`), so
// the editor can never read or write outside the contexts dir. Writes are
// atomic (temp file + rename) so a crash mid-save never leaves a truncated
// file that a concurrent review could read. Reads return the RAW file bytes —
// HTML comments and empty headings are stripped later by cleanContextText()
// when the field is built, so what the editor shows is exactly what is saved.

import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync, unlinkSync, realpathSync } from "node:fs";
import path from "node:path";

import { log } from "./log.js";

// Project keys / repo slugs on both platforms allow word characters plus `-`,
// `_` and `.` (repo slugs like `service.api` or `.github` are legal on both
// platforms and parsePrRef already accepts them — the editor must too).
const NAME_RE = /^[A-Za-z0-9._-]+$/;
// Hard size cap so a misbehaving client cannot fill the pod's disk.
const MAX_CONTEXT_BYTES = 512 * 1024;

/** Error carrying an HTTP status for the API layer (defaults to 500). */
export class ContextEditorError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ContextEditorError";
    this.status = status;
  }
}

export const MAX_CONTEXT_BYTES_EXPORT = MAX_CONTEXT_BYTES;

/** Is this a valid project key / repo slug (or the word part of a file)? */
export function validName(name) {
  return typeof name === "string" && NAME_RE.test(name);
}

/** Validate the PROJECT/repo pair that a per-repo file is keyed by. */
export function validProjectRepo(project, repo) {
  return validName(project) && validName(repo);
}

/**
 * Resolve a user-supplied relative file name to a safe absolute path inside
 * `dir`, or `null` when it is not acceptable. Allowed shapes:
 *   `<name>.md`            (top-level, project-wide / per-repo)
 *   `stacks/<name>.md`     (stack rules)
 * where `<name>` is `[A-Za-z0-9._-]+` (no leading `.`, so hidden files stay
 * out). `..`, absolute paths, hidden files and anything but `.md` are
 * rejected — and, because `path.resolve` is lexical only, so is any path whose
 * *canonical* location (after following symlinks) escapes the contexts dir.
 */
export function safeContextFile(dir, file) {
  if (typeof file !== "string" || !file) return null;
  if (file.includes("\0")) return null;
  const rel = file.replace(/\\/g, "/");
  if (rel.startsWith("/") || rel.includes("..")) return null;
  const m = rel.match(/^(stacks\/)?([A-Za-z0-9._-]+)\.md$/);
  if (!m) return null;
  if (m[2].startsWith(".")) return null; // hidden file
  const abs = path.resolve(dir, rel);
  const base = path.resolve(dir);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  if (!containedInContextDir(dir, abs)) return null;
  return abs;
}

/**
 * Is `abs` (a resolved path under `dir`) inside the *canonical* contexts root?
 * `path.resolve` checks containment lexically and does not follow symlinks: a
 * Markdown file that is a symlink, or a symlinked `stacks/` directory, could
 * otherwise let reads/writes/deletes operate outside `REVIEW_CONTEXT_DIR` —
 * defeating the API's filesystem safety boundary. Resolve symlinks with
 * `realpathSync` on the file itself when present, else on its nearest existing
 * ancestor, and require the canonical result to stay under the canonical root
 * (a not-yet-existing root can contain nothing, so the lexical check alone is
 * enough there). The caller re-checks under the same invariants and only
 * touches `abs` afterwards, so the boundary holds across read/write/delete.
 */
function containedInContextDir(dir, abs) {
  const root = path.resolve(dir);
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch {
    return true; // root doesn't exist yet — no symlink can hide under it
  }
  let target;
  try {
    if (existsSync(abs)) {
      target = realpathSync(abs); // resolves a symlinked file itself
    } else if (existsSync(path.dirname(abs))) {
      target = realpathSync(path.dirname(abs)); // resolves a symlinked parent (e.g. stacks/)
    } else {
      // deepest existing ancestor (the file's parent-dir chain not created yet)
      let a = path.dirname(abs);
      while (!existsSync(a)) {
        const p = path.dirname(a);
        if (p === a) return false;
        a = p;
      }
      target = realpathSync(a);
    }
  } catch {
    return false; // vanished between the check and the realpath — treat as unsafe
  }
  return target === rootReal || target.startsWith(rootReal + path.sep);
}

/**
 * The file name a per-repo context resolves to: the exact `<PROJECT>-<repo>.md`
 * when it (or the `<repo>.md` fallback) exists, otherwise the name that WOULD
 * be created (`<PROJECT>-<repo>.md`). Same precedence as src/context.js.
 */
export function resolveRepoContextFile(dir, project, repo) {
  if (!validProjectRepo(project, repo)) return null;
  for (const c of [`${project}-${repo}.md`, `${repo}.md`]) {
    if (existsSync(path.join(dir, c))) return c;
  }
  return `${project}-${repo}.md`;
}

/**
 * Read one context file as raw text. Never throws on a missing file — returns
 * `{ exists:false, file, text:"" }` so the UI can offer to create it.
 */
export function readContextDoc(dir, file) {
  const abs = safeContextFile(dir, file);
  if (!abs) throw new ContextEditorError(400, `invalid context file name: ${file}`);
  if (!existsSync(abs)) return { exists: false, file, text: "" };
  return { exists: true, file, text: readFileSync(abs, "utf8") };
}

/** Read the resolved per-repo context for PROJECT/repo (create-target on miss). */
export function getRepoContext(dir, project, repo) {
  if (!validProjectRepo(project, repo)) {
    throw new ContextEditorError(400, "project and repo must be letters, digits, `-`, `_` or `.`");
  }
  const file = resolveRepoContextFile(dir, project, repo);
  return readContextDoc(dir, file);
}

/**
 * Create or overwrite one context file (atomic: temp file + rename, so a crash
 * mid-save never leaves a truncated file a concurrent review might read).
 * Missing parent dirs (e.g. `stacks/` on first use) are created.
 */
export function writeContextDoc(dir, { file, text }) {
  const abs = safeContextFile(dir, file);
  if (!abs) throw new ContextEditorError(400, `invalid context file name: ${file}`);
  const body = String(text ?? "");
  const size = Buffer.byteLength(body, "utf8");
  if (size > MAX_CONTEXT_BYTES) {
    throw new ContextEditorError(413, `context file too large (${size} bytes; max ${MAX_CONTEXT_BYTES})`);
  }
  const targetDir = path.dirname(abs);
  mkdirSync(targetDir, { recursive: true });
  const tmp = path.join(
    targetDir,
    `.${path.basename(abs)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, abs);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp never created — nothing to clean */
    }
    throw new ContextEditorError(500, `could not write ${file}: ${err.message}`);
  }
  log.info(`context editor: wrote ${file} (${size} bytes)`);
  return { ok: true, file };
}

/** Create or update the per-repo context for PROJECT/repo (fallback-aware). */
export function writeRepoContext(dir, { project, repo, text }) {
  if (!validProjectRepo(project, repo)) {
    throw new ContextEditorError(400, "project and repo must be letters, digits, `-`, `_` or `.`");
  }
  const file = resolveRepoContextFile(dir, project, repo);
  return writeContextDoc(dir, { file, text });
}

/** Delete a context file. 404 when it is not there, 400 for unsafe names. */
export function deleteContextDoc(dir, file) {
  const abs = safeContextFile(dir, file);
  if (!abs) throw new ContextEditorError(400, `invalid context file name: ${file}`);
  if (!existsSync(abs)) throw new ContextEditorError(404, `context file not found: ${file}`);
  try {
    unlinkSync(abs);
  } catch (err) {
    throw new ContextEditorError(500, `could not delete ${file}: ${err.message}`);
  }
  log.info(`context editor: deleted ${file}`);
  return { ok: true, file };
}

/**
 * Enumerate every curated context file under `dir`, classified for the UI:
 *   - `stacks`: `<name>` + parsed `match:` patterns (null when absent/broken)
 *   - `top`: each other `.md` file with a `kind` — `"project"` when its name
 *     prefixes other files (`ACME.md` + `ACME-<repo>.md`), `"repo"` when it is
 *     `<PROJECT>-<repo>.md` (split via the project-wide file when one exists,
 *     else on the first `-` — project-wide context is optional, so a lone
 *     per-repo file is still recognized), else `"file"`.
 * A missing/unreadable dir yields an empty listing (never an error), matching
 * the project's non-fatal, best-effort convention. A symlinked `stacks/` that
 * escapes the contexts dir is not enumerated (containment boundary).
 */
export function listContextDocs(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { dir, stacks: [], top: [] };
  }
  const top = entries
    .filter((n) => !n.startsWith(".") && /^[A-Za-z0-9._-]+\.md$/.test(n))
    .sort()
    .map((n) => ({ file: n, name: n.replace(/\.md$/, "") }));

  const stacks = [];
  try {
    if (containedInContextDir(dir, path.join(dir, "stacks"))) {
      for (const n of readdirSync(path.join(dir, "stacks")).sort()) {
        if (n.startsWith(".") || !/^[A-Za-z0-9._-]+\.md$/.test(n)) continue;
        const file = `stacks/${n}`;
        let match = null;
        try {
          const raw = readFileSync(path.join(dir, file), "utf8");
          const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
          const line = fm?.[1].match(/^match:\s*(\[.*\])\s*$/m);
          if (line) match = JSON.parse(line[1]);
        } catch {
          /* broken stack front matter — still listed, match left null */
        }
        stacks.push({ file, name: n.replace(/\.md$/, ""), match });
      }
    }
  } catch {
    /* no stacks dir yet */
  }

  // A file is project-wide when its name prefixes another top-level file.
  const projects = top.filter((t) => top.some((o) => o.name.startsWith(`${t.name}-`))).map((t) => t.name);
  const classified = top.map((t) => {
    const project = projects.find((p) => t.name === p || t.name.startsWith(`${p}-`));
    if (project) {
      if (t.name === project) return { ...t, kind: "project", project };
      return { ...t, kind: "repo", project, repo: t.name.slice(project.length + 1) };
    }
    // No project-wide file: a lone `<PROJECT>-<repo>.md` may still be a
    // per-repo context (loadProjectContext reads it for PROJECT/repo). Split
    // only when the project segment looks like a real project key — Bitbucket
    // keys are uppercase (ACME). A lowercase first segment is a
    // `<repo>.md` fallback or a project-wide file that happens to contain a
    // dash, so it stays generic (still openable via the PROJECT/repo box).
    const lone = t.name.match(/^([A-Z][A-Z0-9]*)-(.+)$/);
    if (lone) return { ...t, kind: "repo", project: lone[1], repo: lone[2] };
    return { ...t, kind: "file" };
  });
  return { dir, stacks, top: classified };
}

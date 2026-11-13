// Persisted reviewer/consensus/vision model assignments.
//
// The UI can switch models at runtime; the chosen models are stored as a small
// JSON file on the pod's persistent volume so they survive restarts and apply
// to both UI- and webhook-triggered reviews. The file lives in the jobs dir
// (dot-file, skipped by listJobs) by default but can be moved with
// `MODEL_SETTINGS_FILE`.
//
// File shape: `{ "a": "<model id>", "b": "<model id>", "c": "<model id>",
// "consensus": "<model id>", "vision": "<image-capable model id>" }`. Missing
// slots are ignored (the env-config default for that slot is kept).

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

export const MODEL_SLOTS = ["a", "b", "c", "d", "consensus", "vision"];

/** Read persisted assignments; returns `{ a?, b?, c?, consensus?, vision? }`. */
export function readModelAssignments(file) {
  if (!file || !existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const out = {};
    for (const slot of MODEL_SLOTS) {
      const v = data && data[slot];
      if (typeof v === "string" && v.trim()) out[slot] = v.trim();
    }
    return out;
  } catch {
    // Corrupt/unreadable settings — fall back to env defaults.
    return {};
  }
}

/** Persist assignments (atomic write). Returns the clean subset that was saved. */
export function writeModelAssignments(file, assignments) {
  const clean = {};
  for (const slot of MODEL_SLOTS) {
    const v = assignments && assignments[slot];
    if (typeof v === "string" && v.trim()) clean[slot] = v.trim();
  }
  // Shared with CLI runs and restarts, so always write the full current state.
  const merged = { ...readModelAssignments(file), ...clean };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
  return merged;
}

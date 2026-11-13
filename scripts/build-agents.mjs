// Generate .opencode/agents/pr-reviewer-{a,b,c}.md from prompts/reviewer-base.md
// plus one prompts/lens-<x>.md per reviewer. Edit the sources, then run
// `npm run build:agents`; `--check` exits 1 when the agents are stale.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const promptsDir = path.join(root, "prompts");
const agentsDir = path.join(root, ".opencode", "agents");
export const LENSES = ["a", "b", "c", "d"];

export function parseLens(text) {
  const sections = {};
  const re = /<!--\s*@(\w+)\s*-->\n([\s\S]*?)(?=\n<!--\s*@\w+\s*-->|\s*$)/g;
  for (const m of text.matchAll(re)) sections[m[1]] = m[2].trim();
  return sections;
}

export function renderReviewer(base, lens) {
  return base.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in lens)) throw new Error(`lens is missing section @${key}`);
    return lens[key];
  });
}

export function renderAgents() {
  const base = readFileSync(path.join(promptsDir, "reviewer-base.md"), "utf8");
  const out = {};
  for (const key of LENSES) {
    const lens = parseLens(readFileSync(path.join(promptsDir, `lens-${key}.md`), "utf8"));
    out[path.join(agentsDir, `pr-reviewer-${key}.md`)] = renderReviewer(base, lens);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [file, content] of Object.entries(renderAgents())) {
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (current === content) continue;
    stale++;
    if (check) console.error(`stale: ${path.relative(root, file)}`);
    else {
      writeFileSync(file, content);
      console.log(`wrote ${path.relative(root, file)}`);
    }
  }
  if (check && stale) {
    console.error("Run `npm run build:agents` to regenerate.");
    process.exit(1);
  }
  if (!stale) console.log("agents up to date");
}

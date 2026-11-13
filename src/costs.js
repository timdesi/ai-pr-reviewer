// Per-model pricing for the dashboard cost display.
//
// Prices come from the opencode config `cost` metadata — the same numbers
// opencode itself uses — so the dashboard and opencode always agree:
//
//   docker/opencode.json.template      (dev: source of truth)
//   ~/.config/opencode/opencode.json   (pod: materialized by the entrypoint)
//
// Each `providers.<id>.models.<mid>.cost` is `{ input, output, cache: { read,
// write } }` (native V2) or the legacy V1 `{ input, output, cache_read,
// cache_write }`, in `<currency>` per million tokens. Both `providers` (V2) and
// `provider` (V1) top-level keys are accepted. We read whichever file is
// present (first match wins) and build a `"provider/model" -> price` map.

import { readFileSync, existsSync } from "node:fs";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Candidate opencode config files to read pricing from (first with prices wins). */
export function defaultPriceCandidates({ projectRoot, home, override } = {}) {
  const candidates = [];
  if (override) candidates.push(override);
  if (home) candidates.push(`${home}/.config/opencode/opencode.json`);
  if (projectRoot) candidates.push(`${projectRoot}/docker/opencode.json.template`);
  return candidates;
}

/** `{ "provider/model": { input, output, cacheRead, cacheWrite } }` per MTok. */
export function loadModelPrices(candidatePaths = []) {
  for (const p of candidatePaths) {
    if (!p || !existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      const prices = {};
      // Native V2 config uses a plural `providers` map; legacy V1 uses `provider`.
      const providers = cfg && (cfg.providers || cfg.provider);
      if (!providers || typeof providers !== "object" || Array.isArray(providers)) continue;
      for (const [prov, def] of Object.entries(providers)) {
        const models = def && def.models;
        if (!models || typeof models !== "object") continue;
        for (const [mid, mdef] of Object.entries(models)) {
          const cost = mdef && mdef.cost;
          if (!cost || typeof cost !== "object") continue;
          const input = num(cost.input);
          const output = num(cost.output);
          if (input == null && output == null) continue;
          // Native V2 nests cache under `cache.read`/`cache.write`; legacy V1
          // used flat `cache_read`/`cache_write`. Accept both.
          const cache = cost.cache && typeof cost.cache === "object" ? cost.cache : {};
          prices[`${prov}/${mid}`] = {
            input: input ?? 0,
            output: output ?? 0,
            cacheRead: num(cost.cache_read) ?? num(cache.read) ?? 0,
            cacheWrite: num(cost.cache_write) ?? num(cache.write) ?? 0,
          };
        }
      }
      if (Object.keys(prices).length) return prices;
    } catch {
      // unreadable/invalid candidate — try the next one
    }
  }
  return {};
}

/**
 * Per-model base URLs from the config, `{ "provider/model": baseURL }` — the
 * provider-level `settings.baseURL` unless a model overrides it. Used for
 * providers that are served from per-model endpoints (the AI-farm MSP models),
 * so the vision transcriber can call exactly the deployment opencode uses.
 */
export function loadModelBaseUrls(candidatePaths = []) {
  for (const p of candidatePaths) {
    if (!p || !existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      const providers = cfg && (cfg.providers || cfg.provider);
      if (!providers || typeof providers !== "object" || Array.isArray(providers)) continue;
      const out = {};
      for (const [prov, def] of Object.entries(providers)) {
        if (!def || typeof def !== "object") continue;
        const provBase = def.settings && typeof def.settings === "object" ? def.settings.baseURL : undefined;
        const models = def.models && typeof def.models === "object" ? def.models : {};
        for (const [mid, mdef] of Object.entries(models)) {
          const override = mdef && typeof mdef === "object" && mdef.settings ? mdef.settings.baseURL : undefined;
          const base = typeof override === "string" && override ? override : provBase;
          if (typeof base === "string" && base) out[`${prov}/${mid}`] = base;
        }
      }
      if (Object.keys(out).length) return out;
    } catch {
      // unreadable/invalid candidate — try the next one
    }
  }
  return {};
}

/** All selectable `"provider/model"` ids from the config, `[{ id, name, image }]`. */export function listAvailableModels(candidatePaths = []) {
  for (const p of candidatePaths) {
    if (!p || !existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      const providers = cfg && (cfg.providers || cfg.provider);
      if (!providers || typeof providers !== "object" || Array.isArray(providers)) continue;
      const models = [];
      for (const [prov, def] of Object.entries(providers)) {
        const defs = def && def.models;
        if (!defs || typeof defs !== "object") continue;
        for (const [mid, mdef] of Object.entries(defs)) {
          const name = mdef && typeof mdef === "object" && mdef.name ? String(mdef.name) : mid;
          // `image: true` when the model declares image input (openai-style
          // `capabilities.input`), the source of truth for the vision picker.
          const input = Array.isArray(mdef?.capabilities?.input) ? mdef.capabilities.input.map(String) : [];
          // `modelID` may differ from the config key, but the pipeline routes by
          // `--model <provider>/<config key>` — that is what users should pick.
          models.push({ id: `${prov}/${mid}`, name, image: input.includes("image") });
        }
      }
      if (models.length) {
        models.sort((x, y) => x.id.localeCompare(y.id));
        return models;
      }
    } catch {
      // unreadable/invalid candidate — try the next one
    }
  }
  return [];
}

/** Price a usage record for a model id. Returns rounded euro-style amounts. */
export function computeCost(prices, model, usage) {
  const p = prices[model];
  if (!p || !usage) return null;
  const round = (n) => Math.round(n * 1e6) / 1e6;
  const input = round(((usage.input || 0) / 1e6) * p.input);
  const cache = round(((usage.cacheRead || 0) / 1e6) * p.cacheRead + ((usage.cacheWrite || 0) / 1e6) * p.cacheWrite);
  const output = round(((usage.output || 0) / 1e6) * p.output);
  return { input, cache, output, total: round(input + cache + output) };
}

/** "€0.068" — trims trailing zeros, right-sizes for tiny amounts. */
export function fmtMoney(n, currency = "€") {
  if (n == null || !Number.isFinite(n)) return "—";
  let s = n.toFixed(4).replace(/\.?0+$/, "");
  return `${currency}${s}`;
}

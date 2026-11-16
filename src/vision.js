// Minimal OpenAI-compatible chat call used to transcribe screenshots pasted
// into a PR (description or comments) into text the reviewers can read.
//
// Mirrors the farm routes used by the bundled OpenCode providers: the
// Azure-style deployment route (docker/providers/llmgw-openai) sends an OpenAI
// messages payload whose user turn carries an `image_url` data URI; the
// `llmgw` provider (docker/providers/llmgw-anthropic) speaks the Anthropic
// Messages API over Vertex `:rawPredict`; the MSP models (docker providers /
// `llmgw-msp`) are served from their own per-model base URLs, declared in the
// opencode config and handed in as `baseUrls`. All accept a static farm bearer
// token. The model + endpoint are swappable via VISION_MODEL (src/config.js);
//
// gpt-* deployments on the farm reject `max_tokens` and want
// `max_completion_tokens`; on the chat-completions route reasoning must be
// pinned off, and streaming is not used here so usage is returned with the
// response. Callers should treat a null result as "could not transcribe" and
// degrade gracefully — the review must never depend on this step.

import { log } from "./log.js";

const AI_FARM_BASE = "https://llm-gateway.example.com";
const API_VERSION = "2025-04-01-preview";

const VISION_PROMPT =
  "You are looking at a screenshot from a Bitbucket pull request (description " +
  "or comment), pasted in place of prose. Transcribe exactly what it shows: " +
  "every visible text string, value, UI element label, menu/table row, diagram " +
  "and any statement of expected behavior. Be literal and exhaustive; never " +
  "invent content; keep it under ~200 words.";

/**
 * Which AI-farm deployment route serves a model id, plus the token to use.
 * `baseUrls` is the `{ "provider/model": baseURL }` map from the opencode
 * config (src/costs.js `loadModelBaseUrls`); it is only needed for the MSP
 * models, which are served from per-model endpoints rather than the shared
 * Azure deployments gateway.
 * Returns `{ url, token, model, kind }` or null when the model is not routable
 * for images here. `kind` is `"openai"` (chat-completions body) or
 * `"anthropic"` (Vertex `:rawPredict` + Anthropic Messages format, the `llmgw`
 * provider). Callers marshal the body/parse the response per kind.
 */
export function visionRoute(model, baseUrls = {}) {
  const m = String(model || "").trim();
  if (!m) return null;
  const [provider, key] = m.includes("/") ? m.split("/") : ["llmgw-gpt", m];
  if (!key) return null;
  const azureRoutes = new Set([
    "llmgw-gpt",
    "llmgw-openai",
    "llmgw-deepseek-flash",
  ]);
  if (azureRoutes.has(provider)) {
    return {
      url: `${AI_FARM_BASE}/api/openai/deployments/${encodeURIComponent(key)}/chat/completions?api-version=${API_VERSION}`,
      token: process.env.ANTHROPIC_AUTH_TOKEN || process.env.LLM_GATEWAY_API_KEY || "",
      model: key,
      kind: "openai",
    };
  }
  // Anthropic-style models on the farm (`llmgw/claude-*`) speak the Messages
  // API over Vertex `:rawPredict` — the same static farm token used above.
  if (provider === "llmgw") {
    return {
      url: `${AI_FARM_BASE}/api/google/v1/publishers/anthropic/models/${encodeURIComponent(key)}:rawPredict`,
      token: process.env.ANTHROPIC_AUTH_TOKEN || "",
      model: key,
      kind: "anthropic",
    };
  }
  // MSP models (e.g. llmgw-msp/Qwen-27B) are served from their own base URL
  // declared in the opencode config — e.g.
  // …/api/providers/example/msp/qwen-27b/v1 — with the usual chat/completions
  // path. Without the map there is no correct endpoint, so treat as unroutable.
  if (provider === "llmgw-msp") {
    const base = baseUrls && baseUrls[m] ? String(baseUrls[m]).replace(/\/+$/, "") : "";
    if (!base) return null;
    return {
      url: `${base}/chat/completions`,
      token: process.env.ANTHROPIC_AUTH_TOKEN || "",
      model: key,
      kind: "openai",
    };
  }
  return null;
}

/**
 * Ask the vision model to transcribe one image.
 *
 * @returns `{ text, usage }` where `usage` is `{ input, output }` token counts
 *   parsed from the chat-completions response (so the vision cost can be priced
 *   and shown separately, see src/prImages.js / src/pipeline.js). Returns null
 *   when the model is not configured/routable, the call fails, or the response
 *   has no text. Never throws.
 */
export async function transcribeImage({
  model,
  imageBytes,
  mimeType = "image/png",
  timeoutMs = 60000,
  prompt = VISION_PROMPT,
  baseUrls,
}) {
  const route = visionRoute(model, baseUrls);
  if (!route) {
    log.warn(`vision: no routable image-capable model configured (${model || "unset"})`);
    return null;
  }
  if (!route.token) {
    log.warn("vision: no farm token (ANTHROPIC_AUTH_TOKEN) set — skipping transcription");
    return null;
  }
  const b64 = Buffer.from(imageBytes).toString("base64");
  const dataUri = `data:${mimeType};base64,${b64}`;
  const imageBlock =
    route.kind === "anthropic"
      ? { type: "image", source: { type: "base64", media_type: mimeType, data: b64 } }
      : { type: "image_url", image_url: { url: dataUri } };
  const body =
    route.kind === "anthropic"
      ? {
          anthropic_version: "vertex-2023-10-16",
          max_tokens: 700,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }, imageBlock] }],
        }
      : {
          model: route.model,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }, imageBlock] }],
          max_completion_tokens: 700,
          reasoning_effort: "none",
        };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${route.token}` };
    // The farm routes Claude calls on a sticky session instance (same hint the
    // bundled llmgw-anthropic provider sends).
    if (route.kind === "anthropic") headers["x-sticky-session-instance"] = "01";
    const res = await fetch(route.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      log.warn(`vision: transcription HTTP ${res.status}: ${raw.slice(0, 200)}`);
      return null;
    }
    const data = JSON.parse(raw);
    // OpenAI chat-completions: choices[0].message.content. Anthropic messages:
    // top-level `content` (array of blocks). Both collapse to string text.
    const content = data?.choices?.[0]?.message?.content ?? data?.content;
    const text = Array.isArray(content)
      ? content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("")
      : String(content ?? "");
    const trimmed = text.trim();
    if (!trimmed) return null;
    const u = data?.usage;
    const usage =
      u && (u.prompt_tokens || u.completion_tokens || u.input_tokens || u.output_tokens)
        ? {
            input: Number(u.prompt_tokens ?? u.input_tokens) || 0,
            output: Number(u.completion_tokens ?? u.output_tokens) || 0,
          }
        : null;
    return { text: trimmed, usage };
  } catch (err) {
    log.warn(`vision: transcription failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

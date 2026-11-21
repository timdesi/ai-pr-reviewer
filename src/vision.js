// Minimal OpenAI-compatible chat call used to transcribe screenshots pasted
// into a PR (description or comments) into text the reviewers can read.
//
// Routing is provider-agnostic: `config.visionRouting` (src/config.js —
// entirely env-driven) classifies each provider into one of three route
// classes, so no provider name or deployment identity appears in this source:
//
//   - shared-gateway OpenAI-compatible: the configured gateway base URL serves
//     an OpenAI messages payload whose user turn carries an `image_url` data
//     URI, at `/api/openai/deployments/<model>/chat/completions` with an
//     optional `?api-version=` query;
//   - Anthropic-Messages over `:rawPredict`: the configured gateway base URL
//     serves the Anthropic Messages API at
//     `/api/google/v1/publishers/anthropic/models/<model>:rawPredict`;
//   - per-model base-URL OpenAI-compatible: models served from their own base
//     URLs, declared in the opencode config and handed in as `baseUrls`
//     (`<baseUrl>/chat/completions`).
//
// All three classes share the gateway's auth token, which is resolved at
// config-load time from the `VISION_TOKEN_ENV_VARS` candidate list and handed
// in as `vision.token` — this module never reads `process.env` itself. The
// model + endpoint are swappable via environment config (VISION_MODEL +
// VISION_*_PROVIDERS). On the chat-completions route streaming is not used,
// so usage is returned with the response. Callers should treat a null result
// as "could not transcribe" and degrade gracefully — the review must never
// depend on this step.

import { log } from "./log.js";

const VISION_PROMPT =
  "You are looking at a screenshot from a Bitbucket pull request (description " +
  "or comment), pasted in place of prose. Transcribe exactly what it shows: " +
  "every visible text string, value, UI element label, menu/table row, diagram " +
  "and any statement of expected behavior. Be literal and exhaustive; never " +
  "invent content; keep it under ~200 words.";

/**
 * Which route class serves a model id, plus the token to use.
 * `baseUrls` is the `{ "provider/model": baseURL }` map from the opencode
 * config (src/costs.js `loadModelBaseUrls`); it is only needed for the
 * per-model base-URL class, which is served from per-model endpoints rather
 * than the shared gateway.
 * `vision` is the `config.visionRouting` group: the gateway base URL, api
 * version, the three provider *class* lists and the resolved auth token.
 * Returns `{ url, token, model, kind }` or null when the model is not routable
 * for images here. `kind` is `"openai"` (chat-completions body) or
 * `"anthropic"` (Vertex `:rawPredict` + Anthropic Messages format). Callers
 * marshal the body/parse the response per kind. Synchronous and pure — no env
 * or IO — with safe defaults, so an unconfigured `vision` is a graceful null.
 */
export function visionRoute(model, { baseUrls, vision } = {}) {
  const m = String(model ?? "").trim();
  if (!m) return null;
  const {
    gatewayBaseUrl = "",
    apiVersion = "",
    providersOpenai = [],
    providersAnthropic = [],
    providersBaseUrl = [],
    token = "",
  } = vision ?? {};
  // Bare model ids route under the FIRST configured OpenAI-compatible provider;
  // with no such provider they stay unroutable.
  const [provider, key] = m.includes("/") ? m.split("/") : [providersOpenai[0], m];
  if (!key) return null;
  if (providersAnthropic.includes(provider)) {
    if (!gatewayBaseUrl) return null;
    return {
      url: `${gatewayBaseUrl}/api/google/v1/publishers/anthropic/models/${encodeURIComponent(key)}:rawPredict`,
      token,
      model: key,
      kind: "anthropic",
    };
  }
  if (providersBaseUrl.includes(provider)) {
    const base = String(baseUrls?.[m] ?? "").replace(/\/+$/, "");
    if (!base) return null;
    return { url: `${base}/chat/completions`, token, model: key, kind: "openai" };
  }
  if (providersOpenai.includes(provider)) {
    if (!gatewayBaseUrl) return null;
    const qs = apiVersion ? `?api-version=${apiVersion}` : "";
    return {
      url: `${gatewayBaseUrl}/api/openai/deployments/${encodeURIComponent(key)}/chat/completions${qs}`,
      token,
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
  vision = {},
}) {
  const route = visionRoute(model, { baseUrls, vision });
  if (!route) {
    log.warn(`vision: no routable image-capable model configured (${model || "unset"})`);
    return null;
  }
  if (!route.token) {
    log.warn("vision: no token configured (see VISION_TOKEN_ENV_VARS) — skipping transcription");
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
    // Models on the Anthropic route run on a sticky session instance (the same
    // hint the bundled anthropic-class provider sends).
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

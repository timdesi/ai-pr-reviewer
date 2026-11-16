import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// Example Model Farm OpenAI-compatible endpoint.
//
// Two route styles are served:
//   - Azure-style            /api/openai/deployments/<name>/chat/completions
//     REQUIRES `?api-version=` on the chat completions call.
//   - Vertex openapi-style   /api/google/v1/endpoints/<name>/openapi/chat/completions
//     does NOT take `api-version`.
// We inject `api-version` only for the Azure deployments route.
const API_VERSION = "2025-04-01-preview";

const DEPLOYMENTS_ROUTE = "/api/openai/deployments/";

const DEFAULT_BASE_URL =
  "https://llm-gateway.example.com/api/openai/deployments/deepseek-v4-pro";

// gpt-* models on the farm need body adaptations on the chat-completions route:
//   1. `max_tokens` is rejected — they require `max_completion_tokens` (the AI SDK's
//      openai-compatible provider always sends `max_tokens`).
//   2. Function tools combined with reasoning are only supported on /v1/responses;
//      on /v1/chat/completions the request must carry `reasoning_effort: "none"`.
//      Agents always run with tools, so pin it when tools are present.
//   3. The farm gateway only returns `usage` in a stream when the client asks for
//      it via `stream_options.include_usage` — without it every `tokens` count
//      comes back zero. Pin it for streams so per-agent cost can be measured.
// All are applied only to gpt-* model ids, leaving the other farm deployments alone.
function translateGptBody(init) {
  const body = init && init.body;
  if (typeof body !== "string") return init;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed.model !== "string" || !parsed.model.startsWith("gpt-")) {
      return init;
    }
    let changed = false;
    if (parsed.max_tokens != null) {
      parsed.max_completion_tokens = parsed.max_tokens;
      delete parsed.max_tokens;
      changed = true;
    }
    if (Array.isArray(parsed.tools) && parsed.tools.length > 0 && parsed.reasoning_effort == null) {
      parsed.reasoning_effort = "none";
      changed = true;
    }
    if (parsed.stream === true && !parsed.stream_options) {
      parsed.stream_options = { include_usage: true };
      changed = true;
    }
    return changed ? { ...init, body: JSON.stringify(parsed) } : init;
  } catch {
    // not JSON or malformed; leave body untouched
  }
  return init;
}

function build(options = {}) {
  const inner = options.fetch;
  const fetcher = async (url, init) => {
    const target = String(url);
    if (
      target.startsWith("https://") &&
      target.includes(DEPLOYMENTS_ROUTE) &&
      target.includes("/chat/completions") &&
      !target.includes("api-version=")
    ) {
      url = `${target}${target.includes("?") ? "&" : "?"}api-version=${API_VERSION}`;
    }
    init = translateGptBody(init);
    return inner ? inner(url, init) : fetch(url, init);
  };

  return createOpenAICompatible({
    ...options,
    fetch: fetcher,
    baseURL: options.baseURL ?? DEFAULT_BASE_URL,
    apiKey: options.apiKey ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.LLM_GATEWAY_API_KEY,
  });
}

export const llmgwOpenAI = build();
export const createLlmgwOpenAI = build;
export default build;

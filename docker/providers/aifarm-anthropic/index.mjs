import { createGoogleVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";

// OpenCode v2 only stamps cache breakpoints for its native routes
// ("anthropic-messages", "google-vertex-messages", "bedrock-converse", "openrouter").
// This provider loads through the AI SDK, so its route id is "aisdk:*" and no
// breakpoints are ever added, meaning every request re-sends the full context
// uncached. We add them here instead.
const MAX_BREAKPOINTS = 4;
const EPHEMERAL = { type: "ephemeral" };

function countMarkers(node) {
  let n = 0;
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const item of x) walk(item);
      return;
    }
    if (x.cache_control) n++;
    for (const value of Object.values(x)) walk(value);
  };
  walk(node);
  return n;
}

// Anthropic only accepts cache_control on content blocks, so a bare string has
// to be lifted into a single-block array first.
function asBlocks(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [{ type: "text", text: value }];
  return undefined;
}

function applyCacheHints(body) {
  if (!body || typeof body !== "object") return body;
  if (!Array.isArray(body.messages)) return body;

  let budget = MAX_BREAKPOINTS - countMarkers(body);
  if (budget <= 0) return body;

  const mark = (block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return false;
    if (block.cache_control || budget <= 0) return false;
    block.cache_control = { ...EPHEMERAL };
    budget -= 1;
    return true;
  };

  // Tools: the trailing tool definition, so the tool schema stays cached.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    mark(body.tools[body.tools.length - 1]);
  }

  // System prompt: the trailing system block.
  const system = asBlocks(body.system);
  if (system) {
    body.system = system;
    mark(system[system.length - 1]);
  }

  // Conversation: the last user turn. This is the rolling prefix that turns
  // into a cache read on the following request.
  for (let i = body.messages.length - 1; i >= 0 && budget > 0; i--) {
    const message = body.messages[i];
    if (!message || message.role !== "user") continue;
    const content = asBlocks(message.content);
    if (!content) continue;
    message.content = content;
    mark(content[content.length - 1]);
    break;
  }

  return body;
}

function decodeBody(body) {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body && typeof body === "object") return JSON.stringify(body);
  return undefined;
}

function build(options = {}) {
  const base = process.env.ANTHROPIC_VERTEX_BASE_URL;
  const sticky = process.env.ANTHROPIC_BMF_STICKY ?? "01";
  const inner = options.fetch;

  const cachingFetch = async (url, init) => {
    const raw = decodeBody(init?.body);
    if (raw === undefined) return inner ? inner(url, init) : fetch(url, init);

    let body;
    try {
      body = applyCacheHints(JSON.parse(raw));
    } catch {
      return inner ? inner(url, init) : fetch(url, init);
    }

    const patched = { ...init, body: JSON.stringify(body) };
    const headers = new Headers(init?.headers);
    headers.set("content-length", String(Buffer.byteLength(patched.body)));
    patched.headers = headers;

    return inner ? inner(url, patched) : fetch(url, patched);
  };

  return createGoogleVertexAnthropic({
    ...options,
    fetch: cachingFetch,
    baseURL: options.baseURL ?? `${base}/publishers/anthropic/models`,
    // Skip real GCP OAuth entirely — inject the static farm bearer token instead.
    generateAuthToken: async () => process.env.ANTHROPIC_AUTH_TOKEN,
    headers: async () => ({
      "x-bmf-sticky-session-instance": sticky,
    }),
  });
}

export const aifarmAnthropic = build();
export const createAifarmAnthropic = build;
export const createGoogleVertexAnthropic_ = build;
export default build;
// Extract the final JSON object from an agent's message.
//
// Agents are instructed to end their final message with a single JSON object;
// any text after it must be ignored. In practice models sometimes wrap the
// object in a markdown fence, add a trailing sentence, emit object-like prose
// (e.g. `neverAsked={}`), or even produce raw newlines inside string values.
// Strategy:
//   1. strip trailing whitespace and an optional markdown code fence,
//   2. among all balanced objects, prefer the OUTERMOST one that closes at the
//      very end of the text (that is the "final report"),
//   3. otherwise take the largest balanced object that parses (outermost wins,
//      ties prefer later text),
//   4. parsing is lenient: raw control characters inside strings are escaped
//      before JSON.parse.

function lastNonWsIndex(text) {
  for (let i = text.length - 1; i >= 0; i--) {
    if (!/\s/.test(text[i])) return i;
  }
  return -1;
}

/** Index of the `}` matching the `{` at `start`, or -1. */
function matchClose(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stripTrailingFence(text) {
  let t = text.replace(/\s+$/, "");
  t = t.replace(/```[a-zA-Z0-9_-]*$/, "");
  t = t.replace(/\s+$/, "");
  return t;
}

/** Lenient parse: escape raw newlines / control chars inside string values. */
function parseLenient(raw) {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) {
        out += ch;
        escape = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += code === 0x0a ? "\\n" : `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

function tryParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return parseLenient(raw);
  }
}

export function extractTrailingJson(text) {
  if (!text) return null;

  const clean = stripTrailingFence(text);
  const endIdx = lastNonWsIndex(clean);

  const candidates = [];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== "{") continue;
    const close = matchClose(clean, i);
    if (close === -1) continue;
    candidates.push({ start: i, close });
  }
  if (!candidates.length) return null;

  // Preferred: outermost object closing at the very end (the "final report").
  const atEnd = candidates
    .filter((c) => c.close === endIdx)
    .sort((a, b) => a.start - b.start);
  for (const c of atEnd) {
    const raw = clean.slice(c.start, c.close + 1);
    const json = tryParse(raw);
    if (json !== undefined) return { json, raw };
  }

  // Fallback: largest balanced object that parses (outermost, later preferred).
  const sorted = candidates
    .slice()
    .sort((a, b) => b.close - b.start - (a.close - a.start) || b.start - a.start);
  for (const c of sorted) {
    const raw = clean.slice(c.start, c.close + 1);
    const json = tryParse(raw);
    if (json !== undefined) return { json, raw };
  }
  return null;
}
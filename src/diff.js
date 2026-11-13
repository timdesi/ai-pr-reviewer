// Diff shaping for the agent context: a file-aware size budget (whole files,
// source before tests before lockfiles/generated) and new-file line numbers.

export const LINE_SEP = "│";
const NUM_WIDTH = 5;
const MIN_PARTIAL_BYTES = 4096;

function bytes(s) {
  return Buffer.byteLength(s, "utf8");
}

function headerPath(header) {
  const m = header.match(/ (?:dst:\/\/|b\/)(\S+)\s*$/) || header.match(/^diff --git \S+ (\S+)/);
  return m ? m[1].replace(/^(?:dst:\/\/|b\/)/, "") : "(unknown)";
}

/** Split a unified diff into per-file chunks (a preamble sticks to the first file). */
export function splitDiffFiles(diff) {
  const lines = String(diff).split("\n");
  const files = [];
  let cur = null;
  let preamble = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      cur = { path: headerPath(line), lines: [...preamble, line] };
      preamble = [];
      files.push(cur);
    } else if (cur) cur.lines.push(line);
    else preamble.push(line);
  }
  if (!files.length) return [{ path: "(diff)", text: String(diff) }];
  return files.map((f) => ({ path: f.path, text: f.lines.join("\n") }));
}

const LOW_VALUE_RE =
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|[^/]+\.lock|[^/]+\.min\.(?:js|css)|[^/]+\.map|[^/]+\.snap)$|(?:^|\/)(?:dist|build|generated|target)\//i;
const TEST_RE = /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\.[jt]sx?$|(?:Test|Tests|IT|IntTest)\.java$/;

export function filePriority(p) {
  if (LOW_VALUE_RE.test(p)) return 2;
  if (TEST_RE.test(p)) return 1;
  return 0;
}

function cutAtLine(text, maxBytes) {
  const head = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  const nl = head.lastIndexOf("\n");
  return nl > 0 ? head.slice(0, nl) : head;
}

/**
 * Fit the diff into `maxBytes` by whole files in priority order; one file that
 * no longer fits may be cut at a line boundary. Original file order is kept.
 */
export function budgetDiff(diff, maxBytes) {
  const text = String(diff ?? "");
  if (bytes(text) <= maxBytes) return { diff: text, truncated: false, omitted: [], partial: [] };
  const files = splitDiffFiles(text).map((f, i) => ({ ...f, i, size: bytes(f.text) + 1 }));
  const order = [...files].sort((a, b) => filePriority(a.path) - filePriority(b.path) || a.i - b.i);
  let left = maxBytes;
  const kept = new Map();
  const partial = [];
  for (const f of order) {
    if (f.size <= left) {
      kept.set(f.i, f.text);
      left -= f.size;
    } else if (left >= MIN_PARTIAL_BYTES && !partial.length) {
      kept.set(f.i, cutAtLine(f.text, left - 1));
      partial.push(f.path);
      left = 0;
    }
  }
  const out = files.filter((f) => kept.has(f.i)).map((f) => kept.get(f.i));
  const omitted = files.filter((f) => !kept.has(f.i)).map((f) => f.path);
  return { diff: out.join("\n"), truncated: true, omitted, partial };
}

/** Prefix each hunk line with its new-file line number (blank for removed lines). */
export function numberDiff(diff) {
  const pad = (n) => String(n ?? "").padStart(NUM_WIDTH, " ");
  let inHunk = false;
  let next = 0;
  return String(diff)
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        inHunk = false;
        return line;
      }
      const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) {
        inHunk = true;
        next = Number(h[1]);
        return line;
      }
      if (!inHunk || line.startsWith("\\")) return line;
      if (line.startsWith("-")) return `${pad("")}${LINE_SEP}${line}`;
      if (line.startsWith("+") || line.startsWith(" ") || line === "") return `${pad(next++)}${LINE_SEP}${line}`;
      return line;
    })
    .join("\n");
}

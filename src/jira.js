// Jira ticket context for reviews.
//
// Extracts linked ticket keys from the PR (title + description), fetches them
// from Jira's REST API via the app's global `fetch` (proxy dispatcher installed
// by src/proxy.js; VERIFY_TLS=false honored globally), and renders a
// "## Linked Jira tickets" block into the reviewer context so reviewers can
// judge the change against the ticket's intent / acceptance criteria.
//
// Deliberately additive and non-fatal:
//   - disabled unless JIRA_ENABLED=1 AND JIRA_BASE_URL + JIRA_API_TOKEN are set
//   - any fetch/parse failure yields "" so a review never aborts over Jira
//
// Note (Oct 2026): from the OpenShift pod, jira.example.com is reachable
// via direct egress — the tracker + its IP (10.0.0.1) are listed in NO_PROXY
// so the request bypasses the SSO-fronting egress proxy and the PAT works as it
// does from a workstation. Enablement is controlled purely by JIRA_ENABLED.

import { log } from "./log.js";

const KEY_RE = /\b([A-Z][A-Z0-9_]{1,19}-\d{1,6})\b/g;
// Keep the payload bounded: a ticket's description can be huge.
const DESC_CAP = 4000;
const COMMENT_CAP = 800;
// Acceptance-criteria handling: a matching custom field is discovered once
// (cached) and its text is capped per ticket. ACs often live in a dedicated
// field (here: "Acceptance Criteria" -> customfield_34622), sometimes in a
// description section ("Acceptance Criteria:"/"Akzeptanzkriterien:").
// Ticket AC lists can be long (ACME-42898-style tickets carry AC1..AC8 with
// full Given/When/Then blocks — the whole section is ~5.2 kB) and truncating
// them hides the very ACs a PR implements (the consensus then cannot judge
// them, and the comment's Jira table shows "—" for every row). The overall
// cap is therefore generous; long single lines are still trimmed per item.
const AC_TEXT_CAP = 6000; // per-ticket acceptance criteria overall cap
const AC_ITEM_CAP = 240; // per bullet
const AC_NAME_RE = /(?:acceptance|akzeptanz|abnahme).{0,12}(?:criteri|kriteri|test)/i;
const AC_FIELD_TTL_MS = 60 * 60 * 1000; // AC custom-field discovery cache TTL
// baseUrl -> { ts, ids } (ticket fields that hold acceptance criteria)
const acFieldCache = new Map();

/** Unique Jira keys (`PROJ-123`) across the given texts, in first-seen order. */
export function extractTicketKeys(...texts) {
  const keys = [];
  const seen = new Set();
  for (const t of texts) {
    if (!t) continue;
    for (const m of String(t).matchAll(KEY_RE)) {
      const k = m[1];
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  return keys;
}

function cap(s, n) {
  const str = (s ?? "").replace(/\r/g, "").trim();
  if (str.length <= n) return str;
  return `${str.slice(0, n)} …(truncated)`;
}

function quote(s) {
  return s.split("\n").map((l) => `> ${l}`).join("\n");
}

function commentsBlock(comment) {
  if (!comment || !Array.isArray(comment.comments) || !comment.comments.length) return "";
  const items = comment.comments.slice(0, 5).map((c) => {
    const who = c.author?.displayName || c.author?.name || "unknown";
    const body = cap(c.body, COMMENT_CAP)
      .replace(/\{code(?::[^}]*)?\}/g, "`…`")
      .replace(/\{quote\}/g, "")
      .replace(/h[1-6]\./g, "");
    return `> ${who}: ${body.split("\n").join("\n> ")}`;
  });
  return `Recent comments:\n${items.join("\n")}`;
}

// ----- acceptance criteria ----------------------------------------------------
//
// ACs usually live in a "Acceptance Criteria" section of the ticket description
// (Jira wiki markup, e.g. "h2. Acceptance Criteria" + *AC1:* / *Given*/*When*)
// and sometimes in a dedicated custom field (this tracker: customfield_34622).
// We extract the description section first, then merge any matching custom field
// value — both normalized to plain text and capped per ticket.

/** Strip Jira wiki markup from a single line/fragment. */
function stripJiraMarkup(s) {
  return String(s || "")
    .replace(/\{color:[^}]*\}/g, "")
    .replace(/\{color\}/g, "")
    .replace(/\{panel(?::[^}]*)?\}|\{panel\}/g, "\n\n")
    .replace(/\{code(?::[^}]*)?\}|\{code\}/g, "`…`")
    .replace(/\{quote\}|\{noformat\}/g, "")
    .replace(/\[([^|\]]+)\|([^\]]+)\]/g, "$1") // [text|url] -> text
    .replace(/\[([^\]|]+)\]/g, "$1") // [text] -> text
    .replace(/!([^!|\n]+?)(?:\|[^!\n]*)?!/g, "") // !attachment.png|width=..! image macros
    .replace(/^(?:#{1,6}(?:[ \t]+|$)|h[1-6][.-][ \t]*)/i, "") // "## Title" / "h2. Title" -> Title
    .replace(/^\s*[*+#-]\s+/, "") // leading bullet marker (requires a space after)
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, "$1") // *bold* -> text
    .replace(/_{1,2}([^_\n]+)_{1,2}/g, "$1") // _emphasis_ -> text
    .replace(/\+([A-Za-z][A-Za-z ]*[A-Za-z])\+/g, "$1") // +AND+ -> AND
    .trim();
}

/**
 * True for AC-section blocks that are not criteria: a bare link, or text that
 * is mostly symbols (pasted JSON payloads, `{{code}}` wiki markup fragments).
 */
function isNoiseBlock(lines) {
  const text = lines.join(" ").trim();
  if (!text) return true;
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(text)) return true;
  // An empty `{}` is left over from Jira `{{code}}` markup around a payload, never prose.
  if (/\{\s*\}/.test(text)) return true;
  const letters = (text.match(/\p{L}/gu) || []).length;
  return letters < 3 || letters / text.length < 0.4;
}

/**
 * Bullets for an AC blob: blank-line-separated blocks (when the description or
 * custom field uses them) become one item each; the Given/When/Then lines stay
 * as sub-lines of that item so the ACs read naturally.
 */
function acItems(s) {
  const seen = new Set();
  const items = [];
  for (const raw of String(s || "").split(/\r?\n\s*\r?\n+/)) {
    const lines = raw
      .split(/\r?\n/)
      .map(stripJiraMarkup)
      .filter(Boolean)
      .filter((ln) => !/^(?:acceptance criteria|akzeptanzkriterien|abnahmekriterien)[.\s]*$/i.test(ln));
    if (!lines.length || isNoiseBlock(lines)) continue;
    const key = lines.join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(lines.map((ln) => (ln.length > AC_ITEM_CAP ? `${ln.slice(0, AC_ITEM_CAP)}…` : ln)));
  }
  return items;
}

// "h2. Acceptance Criteria" (classic wiki markup, also German variants) OR a
// Markdown heading "## Acceptance Criteria" (modern Jira editors render the
// description this way). The heading prefix is optional — a bare
// "Acceptance Criteria:" line must match too.
const AC_HEAD_RE =
  /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+|h[1-6]?[.:][ \t]*)?(?:Acceptance Criteria|Akzeptanzkriterien|Abnahmekriterien)\s*:?/i;
// Stop at the next section heading (Markdown `#..` or wiki `h..`) that is not
// the AC heading itself.
const AC_STOP_RE =
  /\n[ \t]*(?:#{1,6}[ \t]+|h[1-6]?[.:][ \t]*)(?!Acceptance Criteria|Akzeptanzkriterien|Abnahmekriterien)/i;

/** Text of the "Acceptance Criteria" section inside a Jira description. */
function acSection(description) {
  const desc = String(description || "");
  const m = desc.match(AC_HEAD_RE);
  if (!m) return "";
  const start = m.index + m[0].length;
  const rest = desc.slice(start);
  const stop = rest.search(AC_STOP_RE);
  const section = (stop === -1 ? rest : rest.slice(0, stop)).replace(/\r/g, "").trim();
  return section.length > AC_TEXT_CAP ? section.slice(0, AC_TEXT_CAP) : section;
}

/** Discover ticket custom fields whose names look like acceptance criteria. */
async function discoverAcFields({ baseUrl, token }) {
  const hit = acFieldCache.get(baseUrl);
  if (hit && Date.now() - hit.ts < AC_FIELD_TTL_MS) return hit.ids;
  try {
    const res = await fetch(`${baseUrl}/rest/api/2/field`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) return [];
    const all = await res.json();
    if (!Array.isArray(all)) return [];
    const ids = all.filter((f) => f && f.custom && AC_NAME_RE.test(f.name || "")).map((f) => f.id);
    acFieldCache.set(baseUrl, { ts: Date.now(), ids });
    return ids;
  } catch {
    return [];
  }
}

/** Normalized acceptance criteria for one issue's fields (description first). */
function extractAcceptanceCriteria(fields, acIds) {
  const parts = [];
  const descAc = acSection(fields?.description);
  if (descAc) parts.push(descAc);
  for (const id of acIds || []) {
    const v = fields?.[id];
    if (v == null) continue;
    const str = Array.isArray(v)
      ? v.map((x) => (typeof x === "string" ? x : x?.text ?? x?.value ?? JSON.stringify(x))).filter(Boolean).join("\n\n")
      : typeof v === "string"
        ? v
        : JSON.stringify(v);
    if (str) parts.push(str);
  }
  const merged = parts.join("\n\n").replace(/\r/g, "").trim();
  return merged ? merged.slice(0, AC_TEXT_CAP) : "";
}

/**
 * Fetch up to `maxTickets` issues. Each entry is either a ticket summary or
 * `{ key, error }`. Never throws for a single bad ticket (that becomes an
 * error entry).
 */
export async function fetchJiraTickets({ baseUrl, token, keys, maxTickets = 5 }) {
  const base = (baseUrl || "").replace(/\/+$/, "");
  const picked = (keys || []).slice(0, Math.max(1, maxTickets || 1));
  const out = [];
  const acIds = await discoverAcFields({ baseUrl: base, token });
  const fields = encodeURIComponent(
    "summary,status,priority,issuetype,labels,assignee,reporter,description,comment" +
      (acIds.length ? "," + acIds.join(",") : ""),
  );
  for (const key of picked) {
    try {
      const url = `${base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${fields}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!res.ok) {
        out.push({ key, error: `HTTP ${res.status}` });
        continue;
      }
      const data = await res.json();
      const f = data.fields || {};
      out.push({
        key,
        url: `${base}/browse/${key}`,
        summary: f.summary || "",
        type: f.issuetype?.name || "",
        status: f.status?.name || "",
        priority: f.priority?.name || "",
        labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
        assignee: f.assignee?.displayName || f.assignee?.name || "",
        reporter: f.reporter?.displayName || f.reporter?.name || "",
        description: cap(f.description, DESC_CAP),
        comments: commentsBlock(f.comment),
        acceptanceCriteria: extractAcceptanceCriteria(f, acIds),
      });
    } catch (err) {
      out.push({ key, error: err.message });
    }
  }
  return out;
}

/** Render `## Linked Jira tickets` markdown block; "" when nothing to render. */
export function renderJiraContext(tickets) {
  if (!Array.isArray(tickets) || !tickets.length) return "";
  const lines = [];
  for (const t of tickets) {
    if (!t || t.error) {
      lines.push(`### ${t?.key || "?"} — *could not be fetched (${t?.error || "unknown"})*`);
      continue;
    }
    const meta = [t.type, t.status, t.priority].filter(Boolean).join(" · ");
    lines.push(`### ${t.key}${meta ? ` — ${meta}` : ""}`);
    if (t.summary) lines.push(`- **Summary:** ${t.summary}`);
    const extras = [];
    if (t.assignee) extras.push(`Assignee: ${t.assignee}`);
    if (t.reporter) extras.push(`Reporter: ${t.reporter}`);
    if (t.labels && t.labels.length) extras.push(`Labels: ${t.labels.join(", ")}`);
    if (extras.length) lines.push(`- ${extras.join("  ")}`);
    const acs = acItems(t.acceptanceCriteria);
    if (acs.length) {
      lines.push("- **Acceptance criteria:**");
      for (const item of acs) {
        lines.push(`  - ${item[0]}`);
        for (const sub of item.slice(1)) lines.push(`    - ${sub}`);
      }
    }
    if (t.description) lines.push(`\n${quote(t.description)}`);
    if (t.comments) lines.push(`\n${t.comments}`);
  }
  return (
    "## Linked Jira tickets\n\n" +
    "> Requirements / context for the linked ticket(s). Judge whether this change implements the\n" +
    "> intended behavior and the acceptance criteria (ACs below), and stays in scope.\n" +
    "> ACs describe end-to-end behavior spanning several repos; the project context states this\n" +
    "> repo's role (e.g. backend vs. UI). This PR covers only this repo's part — do NOT call an AC\n" +
    "> \"unmet\" just because a UI/frontend outcome is not in this diff. Say which ACs are verifiable\n" +
    "> here and which belong to another repo; do flag ACs this change genuinely fails to address,\n" +
    "> even if it compiles.\n\n" +
    lines.join("\n\n") +
    "\n"
  );
}

// Consensus verdict -> display label for the comment/report AC table (mirrors
// the UI Overview card wording; the card adds color via CSS — markdown
// comments can't reliably render inline colors).
const AC_STATUS_LABELS = {
  met: "Met",
  partial: "Partial",
  unmet: "Unmet",
  not_verifiable: "Not verified",
};

/** Verdict status -> capitalized label ("—" when absent/unknown). */
function acStatusLabel(status) {
  return AC_STATUS_LABELS[String(status || "").toLowerCase()] || "—";
}

/** Escape `|` and newlines in a markdown table cell (backticks/markup kept). */
function cellText(s) {
  return String(s ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim() || "—";
}

/** First-line prefix match between a rendered AC bullet and a verdict id. */
function acMarkerInt(s) {
  const m = String(s || "").match(/(\d+)(?:[.,]\d+)?/);
  return m ? Number(m[1]) : null;
}

function verdictForAc(item, verdicts) {
  const head = (item?.[0] || "").toLowerCase().trim();
  if (!head) return null;
  const idMatches = (v) => {
    const id = String(v?.id || "").toLowerCase().trim();
    return (
      !!id &&
      (head === id || head.startsWith(`${id}:`) || head.startsWith(`${id} `) || head.startsWith(`${id}-`))
    );
  };
  // Preferred: an exact bullet-id match. This is what sub-numbered bullets
  // need — "AC3.1 - …" must bind to verdict "AC3.1", never to its parent
  // "AC3" (list order must not decide).
  const exact = verdicts.find(idMatches);
  if (exact) return exact;
  // Fallback for ids the model invents without the bullet's own label
  // ("AC 3", "3", "ac3"): bind to a verdict whose leading ordinal equals the
  // bullet's. Sub-numbered verdict ids ("AC3.1") are excluded here so they are
  // never collapsed onto a parent "AC3" row — they keep their exact binding.
  const headInt = acMarkerInt(head);
  if (headInt == null) return null;
  return (
    verdicts.find((v) => {
      const idText = String(v?.id || "").toLowerCase().trim();
      if (!idText || /\.\d/.test(String(v?.id))) return false; // keep sub-ids exact
      const idInt = acMarkerInt(idText);
      return idInt != null && idInt === headInt;
    }) || null
  );
}

/**
 * One-line description of what an AC requires, for compact views. Prefers the
 * consensus `short` label; otherwise falls back to the AC bullet heading with a
 * leading "ACx:" id-prefix stripped (the id is shown separately in the UI).
 */
function acShort(id, headBody, verdictShort) {
  if (typeof verdictShort === "string" && verdictShort.trim()) return verdictShort.trim().slice(0, 160);
  let s = headBody || "";
  const i = String(id || "").toLowerCase();
  if (i && s.toLowerCase().startsWith(i)) s = s.slice(i.length).replace(/^\s*[:.\-–—]?\s*/, "");
  return s.trim().slice(0, 160);
}

/**
 * Build a structured, render-ready acceptance-criteria view for the linked
 * tickets and the consensus `acceptance_criteria` verdicts. Single source of
 * truth used by both the markdown appendix (`renderJiraAppendix`) and the UI
 * Overview tab (`status.jiraAc`). Pure + non-fatal: errors yield `[]`.
 *
 * Cards: `{ key, url, meta, summary, counts, items }` where `items` are
 * `{ id, status, headLine, subs, reason, short }` (id/status null when no
 * verdict).
 */
export function buildAcView(tickets, verdicts = []) {
  const list = (tickets || []).filter((t) => t && !t.error && (t.summary || t.acceptanceCriteria));
  if (!list.length) return [];
  const byTicket = new Map();
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    const key = String(v?.ticket || "").toUpperCase();
    if (!v || typeof v !== "object" || !key) continue;
    if (!byTicket.has(key)) byTicket.set(key, []);
    byTicket.get(key).push(v);
  }
  const cards = [];
  for (const t of list) {
    const key = String(t.key || "").toUpperCase();
    const verdictsFor = (byTicket.get(key) || []).filter((v) => v && typeof v.id === "string" && typeof v.status === "string");
    const counts = {};
    let matched = 0;
    const items = acItems(t.acceptanceCriteria).map((item) => {
      const v = verdictForAc(item, verdictsFor);
      if (!v) return { id: null, status: null, reason: "", headLine: item[0] || "", subs: item.slice(1) };
      counts[v.status] = (counts[v.status] || 0) + 1;
      matched++;
      const head = item[0] || "";
      // Don't echo the id when the bullet's own heading line is just the id.
      const headLine = head.toLowerCase() === String(v.id).toLowerCase() ? "" : head;
      return {
        id: String(v.id),
        status: String(v.status),
        reason: v.reason || "",
        headLine,
        short: acShort(v.id, headLine, v.short),
        subs: item.slice(1),
      };
    });
    cards.push({
      key: t.key,
      url: t.url || "",
      meta: [t.type, t.status, t.priority].filter(Boolean).join(" · "),
      summary: t.summary || "",
      counts: matched ? counts : null,
      items,
    });
  }
  return cards;
}

/**
 * `### Jira coverage` section for the final report / public comment: one
 * markdown table per ticket with `Acceptance criterion | Status | Notes`.
 * The ticket heading is a bold link to the Jira browse page (key + summary);
 * the criterion cell is `AC<id> — <consensus short one-liner>` (AC-heading
 * fallback; plain heading when no verdict matched), Status is the capitalized
 * consensus verdict (Met / Partial / Unmet / Not verified), Notes the
 * consensus reason when present. Returns "" when there is nothing to show
 * (incl. error-only tickets).
 */
export function renderJiraAppendix(tickets, verdicts = []) {
  const cards = buildAcView(tickets, verdicts);
  if (!cards.length) return "";
  const lines = ["### Jira coverage", ""];
  for (const card of cards) {
    const title = `${card.key}${card.summary ? ` — ${card.summary}` : ""}`;
    lines.push(card.url ? `**[${title}](${card.url})**` : `**${title}**`);
    if (card.items.length) {
      // With verdicts, show only judged rows (same as the UI); stray AC-section
      // text (links, notes, pasted payloads) is context, not a criterion.
      const rows = card.counts ? card.items.filter((it) => it.id) : card.items;
      lines.push("", "| Acceptance criterion | Status | Notes |", "|---|---|---|");
      for (const it of rows) {
        const label = String(it.short || it.headLine || "").trim();
        const criterion = it.id
          ? (label ? `${it.id} — ${cellText(label)}` : `${it.id}`)
          : cellText(label);
        lines.push(`| ${criterion} | ${acStatusLabel(it.status)} | ${cellText(it.reason)} |`);
      }
    }
    lines.push("");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}

/**
 * One-shot used by the pipeline: extract ticket keys from the PR and return the
 * rendered markdown block plus the structured tickets.
 *
 * @returns {{ block: string, tickets: Array }} `block` is "" when disabled, no
 *   tickets, or any failure; `tickets` is the (partial) ticket data for the
 *   final report/comment appendix (ACs) — never a reason to abort the review.
 */
export async function loadJiraContext({ config, pullRequest }) {
  const jira = config && config.jira;
  if (!jira || !jira.enabled) return { block: "", tickets: [] };
  if (!jira.baseUrl || !jira.token) {
    log.warn("Jira context enabled but JIRA_BASE_URL/JIRA_API_TOKEN is missing; skipping");
    return { block: "", tickets: [] };
  }
  const keys = extractTicketKeys(pullRequest?.title, pullRequest?.description);
  if (!keys.length) return { block: "", tickets: [] };
  try {
    const tickets = await fetchJiraTickets({
      baseUrl: jira.baseUrl,
      token: jira.token,
      keys,
      maxTickets: jira.maxTickets ?? 5,
    });
    const block = renderJiraContext(tickets);
    const ok = tickets.filter((t) => !t.error).length;
    log.info(`Jira context: attached ${ok}/${tickets.length} ticket(s) (${keys.join(", ")})`);
    return { block, tickets };
  } catch (err) {
    log.warn(`Jira context fetch failed: ${err.message}`);
    return { block: "", tickets: [] };
  }
}

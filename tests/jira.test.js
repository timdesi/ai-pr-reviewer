import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  buildAcView,
  extractTicketKeys,
  renderJiraContext,
  renderJiraAppendix,
  fetchJiraTickets,
  loadJiraContext,
} from "../src/jira.js";

test("extractTicketKeys finds unique linked keys in first-seen order", () => {
  const keys = extractTicketKeys(
    "Bugfix/ACME-42893 CC autobacklog",
    "Fixes ACME-42893 and ACME-42893 (dup). See ACV2-642.",
    "no tickets here",
  );
  assert.deepEqual(keys, ["ACME-42893", "ACV2-642"]);
  assert.deepEqual(extractTicketKeys(null, undefined, ""), []);
  // Not matched: lowercase keys, numbers-only, words with digits in odd places.
  assert.deepEqual(extractTicketKeys("acme-42893 123 foo42-bar-7"), []);
});

test("renderJiraContext renders a ticket block, AC bullets, and error entries", () => {
  const block = renderJiraContext([
    {
      key: "ACME-42893",
      summary: "CC autobacklog",
      type: "Bug",
      status: "In Review",
      priority: "High",
      labels: ["backlog"],
      assignee: "John Doe",
      reporter: "Jane Roe",
      description: "When the automatic backlog trigger fires\na PCB lot must be created.",
      comments: "",
      acceptanceCriteria: "AC1: create the lot automatically\n\nAC2: keep the lot in backlog",
    },
    { key: "ACV2-642", error: "HTTP 404" },
  ]);
  assert.match(block, /## Linked Jira tickets/);
  assert.match(block, /### ACME-42893 — Bug · In Review · High/);
  assert.match(block, /\*\*Summary:\*\* CC autobacklog/);
  assert.match(block, /When the automatic backlog trigger fires/);
  assert.match(block, /### ACV2-642 — \*could not be fetched \(HTTP 404\)\*/);
  // AC bullets + the stronger "unmet / not verifiable" instruction.
  assert.match(block, /\*\*Acceptance criteria \(parsed\):\*\*/);
  assert.match(block, /  - AC1: create the lot automatically/);
  assert.match(block, /  - AC2: keep the lot in backlog/);
  assert.match(block, /do NOT call an AC/);
  assert.match(block, /end-to-end behavior/);
  assert.equal(renderJiraContext([]), "");
  assert.equal(renderJiraContext(null), "");
});

test("loadJiraContext is a no-op when disabled or without a token", async () => {
  assert.deepEqual(await loadJiraContext({ config: { jira: { enabled: false } }, pullRequest: {} }), {
    block: "",
    tickets: [],
  });
  assert.deepEqual(
    await loadJiraContext({ config: { jira: { enabled: true, baseUrl: "x", token: "" } }, pullRequest: { title: "ACME-1" } }),
    { block: "", tickets: [] },
  );
});

test("fetchJiraTickets hits the REST API with Bearer token and parses fields", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (req.url.includes("ACME-999")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errorMessages: ["issue does not exist"] }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          key: "ACME-42893",
          fields: {
            summary: "CC autobacklog",
            status: { name: "In Review" },
            priority: { name: "High" },
            issuetype: { name: "Bug" },
            labels: ["backlog"],
            assignee: { name: "jdoe" },
            description: "When the automatic backlog trigger fires\na PCB lot must be created.",
            comment: {
              comments: [{ author: { name: "jroe" }, body: "Remember: prepend the header." }],
            },
          },
        }),
      );
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/tracker01`;
  try {
    const tickets = await fetchJiraTickets({
      baseUrl,
      token: "PAT-123",
      keys: ["ACME-42893", "ACME-999"],
    });
    assert.equal(tickets.length, 2);
    const ok = tickets.find((t) => !t.error);
    assert.equal(ok.summary, "CC autobacklog");
    assert.match(ok.description, /a PCB lot must be created/);
    assert.match(ok.comments, /Remember: prepend the header/);
    const bad = tickets.find((t) => t.key === "ACME-999");
    assert.match(bad.error, /HTTP 404/);

    // Got through the right path with a Bearer token.
    assert.ok(seen.some((s) => s.url.includes("/tracker01/rest/api/2/issue/ACME-42893")));
    assert.ok(seen.every((s) => s.auth === "Bearer PAT-123"));
  } finally {
    server.close();
  }
});

test("loadJiraContext end-to-end against a local Jira stub", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        key: "ACME-42893",
        fields: {
          summary: "CC autobacklog",
          status: { name: "In Review" },
          issuetype: { name: "Bug" },
          description: "Automatic backlog trigger must create a PCB lot.",
        },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const r = await loadJiraContext({
      config: { jira: { enabled: true, baseUrl: `http://127.0.0.1:${port}/tracker01`, token: "PAT", maxTickets: 5 } },
      pullRequest: { title: "Bugfix/ACME-42893", description: "Fixes ACME-42893." },
    });
    assert.match(r.block, /## Linked Jira tickets/);
    assert.match(r.block, /Automatic backlog trigger must create a PCB lot/);
    assert.equal(r.tickets.length, 1);
    assert.match(r.tickets[0].key, /ACME-42893/);
    assert.equal(r.tickets[0].acceptanceCriteria, "");
    // No ticket references -> no block (and no fetch).
    const empty = await loadJiraContext({
      config: { jira: { enabled: true, baseUrl: `http://127.0.0.1:${port}/tracker01`, token: "PAT" } },
      pullRequest: { title: "No tickets here" },
    });
    assert.deepEqual(empty, { block: "", tickets: [] });
  } finally {
    server.close();
  }
});

test("fetchJiraTickets extracts ACs from the description section and a custom field", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.includes("/rest/api/2/field")) {
      res.end(
        JSON.stringify([
          { id: "customfield_34622", name: "Acceptance Criteria", custom: true },
          { id: "customfield_99", name: "Reviewers", custom: true },
          { id: "summary", name: "Summary", custom: false },
        ]),
      );
      return;
    }
    res.end(
      JSON.stringify({
        key: "ACME-42",
        fields: {
          summary: "Add revision level",
          status: { name: "In Review" },
          issuetype: { name: "Story" },
          priority: { name: "Major" },
          description:
            "h2. Acceptance Criteria\r\n" +
            "*AC1: send the revision level*\r\n * *Given* the lot has a revision level\r\n" +
            " * *When* the user starts preparation\r\n\r\n" +
            "h2. Out of scope\r\nNothing else.",
          customfield_34622: "AC9: from the custom field\r\n\r\nAC10: second cf item",
        },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/tracker01`;
  try {
    const tickets = await fetchJiraTickets({ baseUrl, token: "T", keys: ["ACME-42"] });
    const t = tickets[0];
    assert.equal(t.key, "ACME-42");
    assert.match(t.acceptanceCriteria, /AC1: send the revision level/);
    assert.match(t.acceptanceCriteria, /starts preparation/);
    assert.match(t.acceptanceCriteria, /AC9: from the custom field/);
    assert.doesNotMatch(t.acceptanceCriteria, /Out of scope/);
    // The custom field id is appended to the issue request's fields param.
    assert.ok(seen.some((u) => u.includes("customfield_34622")));
    // Cache: second call must not re-hit /rest/api/2/field.
    const before = seen.filter((u) => u.includes("/rest/api/2/field")).length;
    await fetchJiraTickets({ baseUrl, token: "T", keys: ["ACME-42"] });
    const after = seen.filter((u) => u.includes("/rest/api/2/field")).length;
    assert.equal(after, before);
  } finally {
    server.close();
  }
});

test("AC extraction handles Markdown '##' headings (modern Jira editor) and stops at the next '##' section", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    // Any request (incl. the /rest/api/2/field AC-discovery probe) resolves to
    // the issue; the non-array payload keeps discoverAcFields from matching.
    res.end(
      JSON.stringify({
        key: "ACME-43144",
        fields: {
          summary: "Default Packaging Instruction",
          status: { name: "In Progress" },
          issuetype: { name: "Improvement" },
          priority: { name: "Critical" },
          description:
            "## Description: nothing useful here\n\n" +
            "## Acceptance Criteria:\n" +
            "**AC1 - default PI on**\n * *Given* ATP ON\n * *Then* PN+AAR for <=10 digits, PN+PV1 for >10\n\n" +
            "**AC2 - default PI off**\n * *Given* ATP OFF\n * *Then* PN+AAR for <=10 digits, PN+PV1 for >10\n\n" +
            "## Q&A - What\n" +
            "Q1: this is not part of the criteria",
        },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/tracker01`;
  try {
    const tickets = await fetchJiraTickets({ baseUrl, token: "T", keys: ["ACME-43144"] });
    const t = tickets[0];
    assert.ok(t.acceptanceCriteria, "ACs must be extracted from a '## Acceptance Criteria' section");
    assert.match(t.acceptanceCriteria, /AC1 - default PI on/);
    assert.match(t.acceptanceCriteria, /AC2 - default PI off/);
    assert.match(t.acceptanceCriteria, /\*Given\* ATP ON/);
    // The section must not bleed into the previous or the following '##' section.
    assert.doesNotMatch(t.acceptanceCriteria, /Description: nothing/);
    assert.doesNotMatch(t.acceptanceCriteria, /Q&A|Q1:/);
    const app = renderJiraAppendix([t], [
      { ticket: "ACME-43144", id: "AC1", status: "met" },
      { ticket: "ACME-43144", id: "AC2", status: "unmet", reason: "ATP OFF path missing" },
    ]);
    assert.match(app, /\| AC1 — default PI on \| Met \| — \|/);
    assert.match(app, /\| AC2 — default PI off \| Unmet \| ATP OFF path missing \|/);
  } finally {
    server.close();
  }
});

test("AC extraction keeps a longer multi-AC section (no truncation at the old 1200 cap)", async () => {
  // ACME-43144-style: three long Given/When/Then ACs (~1.5 kB total) under a
  // Markdown heading, separated by blank lines, must all survive extraction.
  const longAc =
    "**AC1 - default packaging instruction with ATP ON**\n" +
    " * *Given* an user of SfB AND Production Feedback of given Line is configured as Nexeed OrderManagement AND ATP Check is ON\n" +
    " * *When* the OnCreatedUpdate Event is sent to Nexeed OM\n" +
    " * *Then* a default packagingInstruction PN+AAR is sent for 10 digits and less than 10 digits PN\n" +
    " * *And* a default packagingInstruction PN+PV1 is sent for all other digit sizes, e.g. 13 digits\n\n" +
    "**AC2 - default packaging instruction with ATP OFF**\n" +
    " * *Given* an user of SfB AND Production Feedback of given Line is configured as Nexeed OrderManagement AND ATP Check is OFF\n" +
    " * *When* the OnCreatedUpdate Event is sent to Nexeed OM\n" +
    " * *Then* a default packagingInstruction PN+AAR is sent for 10 digits and less than 10 digits PN\n" +
    " * *And* a default packagingInstruction PN+PV1 is sent for all other digit sizes, e.g. 13 digits\n\n" +
    "**AC3 - show only the selected packaging instruction in ATP check**\n" +
    " * *Given* an user of SfB AND ATP Check for Packaging Instruction is ON AND plant in R3\n" +
    " * *When* the user runs the ATP Check\n" +
    " * *Then* only the selected packaging instruction is visible in the ATP Check modal";
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        key: "ACME-43144",
        fields: { summary: "Default Packaging Instruction", description: `## Acceptance Criteria:\n${longAc}\n## Q&A` },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/tracker01`;
  try {
    const tickets = await fetchJiraTickets({ baseUrl, token: "T", keys: ["ACME-43144"] });
    const view = buildAcView(tickets, [
      { ticket: "ACME-43144", id: "AC1", status: "met" },
      { ticket: "ACME-43144", id: "AC2", status: "met" },
      { ticket: "ACME-43144", id: "AC3", status: "not_verifiable", reason: "UI modal in another repo" },
    ]);
    assert.equal(view[0].items.length, 3);
    assert.deepEqual(view[0].counts, { met: 2, not_verifiable: 1 });
  } finally {
    server.close();
  }
});

test("long AC sections (AC1..AC8 Given/When/Then) are not cut at the old 2400 cap", async () => {
  // ACME-42898 shape: the AC section is ~5.2 kB; the old AC_TEXT_CAP=2400 cut
  // the list at AC4 and hid AC6..AC8, so consensus could not judge the ACs a PR
  // actually implements. Every AC must survive extraction and retrieval.
  const ac = (n) =>
    `*AC${n} - criterion ${n}*\n` +
    " * *Given* check of SAP release table is done (only if the \"Revision Level visible in SfB\" toggle is ON, Line configuration, available for R3)\n" +
    " * *When* the user triggers the ATP check for a lot with status parked/upcoming/planned (button \"run ATP check\" is clicked)\n" +
    " * *Then* the released Revision Level should automatically be prefilled in the lot without a drop down and assigned to the lot (without Deviation)";
  const full = [...Array(8).keys()]
    .map((i) => (i === 7 ? ac(8).replace("criterion 8", "clear revision level on backlog move") : ac(i + 1)))
    .join("\n\n");
  assert.ok(full.length > 2400, "fixture must exceed the old cap to prove the raise");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        key: "ACME-42898",
        fields: {
          summary: "Check and assign RevLevel during ATP Check",
          description: `## Acceptance Criteria\n${full}\n## Q&A`,
        },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/tracker01`;
  try {
    const [t] = await fetchJiraTickets({ baseUrl, token: "T", keys: ["ACME-42898"] });
    assert.ok(t.acceptanceCriteria.length > 2400, "AC section must no longer be cut at 2400");
    assert.match(t.acceptanceCriteria, /AC8 - clear revision level on backlog move/);
    const app = renderJiraAppendix([t], [
      { ticket: "ACME-42898", id: "AC8", status: "met", reason: "backend clears revision level on backlog" },
    ]);
    assert.match(app, /\| AC8 — clear revision level on backlog move \| Met \| backend clears revision level on backlog \|/);
  } finally {
    server.close();
  }
});

test("renderJiraAppendix renders key + AC bullets, skips error/empty tickets", () => {
  const app = renderJiraAppendix([
    {
      key: "ACME-42893",
      type: "Bug",
      status: "Closed",
      priority: "Major",
      summary: "CC autobacklog",
      acceptanceCriteria: "AC1: a\n\nAC2: b",
    },
    { key: "ACV2-642", error: "HTTP 404" },
  ]);
  assert.match(app, /### Jira coverage/);
  assert.match(app, /\*\*ACME-42893 — CC autobacklog\*\*/);
  assert.match(app, /\| Acceptance criterion \| Status \| Notes \|/);
  assert.match(app, /\| AC1: a \| — \| — \|/);
  assert.match(app, /\| AC2: b \| — \| — \|/);
  assert.doesNotMatch(app, /✅|⚠️|❌|🔍/); // no verdicts -> no status icons
  assert.equal(renderJiraAppendix([]), "");
  assert.equal(renderJiraAppendix([{ key: "X", error: "nope" }]), "");
  assert.equal(
    renderJiraAppendix([{ key: "Y", type: "Bug", status: "Open", summary: "", acceptanceCriteria: "" }]),
    "",
  );
});

test("renderJiraAppendix annotates each AC with the consensus verdict status + reason", () => {
  const ticket = {
    key: "ACME-42896",
    summary: "Revision Level config",
    type: "Story",
    status: "In Progress",
    priority: "Critical",
    acceptanceCriteria:
      "*AC0*\n * *Given* a Key User\n * *Then* the toggles and header are updated per mock up\n\n" +
      "*AC1*\n * *Then* a new toggle is available, default OFF",
  };
  const verdicts = [
    { ticket: "ACME-42896", id: "AC0", status: "not_verifiable", reason: "UI mock-up is in another repo" },
    { ticket: "ACME-42896", id: "AC1", status: "partial", reason: "property added but nothing reads it" },
    { ticket: "OTHER-99", id: "AC9", status: "unmet", reason: "not this ticket" },
  ];
  const app = renderJiraAppendix([ticket], verdicts);
  assert.match(app, /\| AC0 \| Not verified \| UI mock-up is in another repo \|/); // lone id not duplicated
  assert.match(app, /\| AC1 \| Partial \| property added but nothing reads it \|/);
  assert.doesNotMatch(app, /OTHER-99/);
  assert.doesNotMatch(app, /✅|⚠️|❌|🔍/); // no emoji
});

test("renderJiraAppendix merges verdicts only for the matching ticket and keeps unmatched ACs plain", () => {
  const ticket = { key: "ACME-1", summary: "s", acceptanceCriteria: "AC1: full detail\n\nAC2: b" };
  const app = renderJiraAppendix(
    [ticket],
    [
      { ticket: "ACME-1", id: "AC1", status: "met" },
      { ticket: "ACME-1", id: "AC2", status: "unmet", reason: "missing handler" },
    ],
  );
  assert.match(app, /\| AC1 — full detail \| Met \| — \|/); // met: no note
  assert.match(app, /\| AC2 — b \| Unmet \| missing handler \|/);
  assert.doesNotMatch(app, /✅|⚠️|❌|🔍/);
  // Verdict for an unknown ticket/id leaves the row plain.
  const app2 = renderJiraAppendix(
    [ticket],
    [
      { ticket: "OTHER-1", id: "AC1", status: "unmet" },
      { ticket: "ACME-1", id: "AC3", status: "unmet" },
    ],
  );
  assert.doesNotMatch(app2, /✅|⚠️|❌|🔍/);
  assert.match(app2, /\| AC1: full detail \| — \| — \|/);
});

test("sub-numbered verdict ids bind to their own sub-AC, never the parent AC3", () => {
  const ticket = {
    key: "ACME-42898",
    summary: "Check and assign RevLevel during ATP Check",
    acceptanceCriteria:
      "AC3 - Revision Level-managed, more than one Revision Level is released\n\n" +
      "AC3.1 - Revision Level-managed, no Revision Level is released",
  };
  // Parent AC3 listed FIRST on purpose: the old numeric fallback let it hijack
  // the AC3.1 bullet. The AC3.1 verdict must bind to the AC3.1 bullet exactly.
  const view = buildAcView([ticket], [
    { ticket: "ACME-42898", id: "AC3", status: "met", reason: "selection logic added", short: "multiple released RLs require selection" },
    { ticket: "ACME-42898", id: "AC3.1", status: "met", reason: "no released RL warns the planner", short: "no released RL shows warning" },
  ]);
  assert.equal(view[0].items.length, 2);
  assert.deepEqual(view[0].counts, { met: 2 });
  const ac3 = view[0].items.find((it) => it.headLine.startsWith("AC3 -"));
  const ac31 = view[0].items.find((it) => it.headLine.startsWith("AC3.1 -"));
  assert.equal(ac3.id, "AC3");
  assert.equal(ac3.reason, "selection logic added");
  assert.equal(ac31.id, "AC3.1");
  assert.equal(ac31.reason, "no released RL warns the planner", "AC3.1 must keep its own verdict, not AC3's");
  const app = renderJiraAppendix([ticket], [
    { ticket: "ACME-42898", id: "AC3", status: "met", reason: "selection logic added", short: "multiple released RLs require selection" },
    { ticket: "ACME-42898", id: "AC3.1", status: "met", reason: "no released RL warns the planner", short: "no released RL shows warning" },
  ]);
  assert.match(app, /\| AC3 — multiple released RLs require selection \| Met \| selection logic added \|/);
  assert.match(app, /\| AC3.1 — no released RL shows warning \| Met \| no released RL warns the planner \|/);
});

test("non-labelled consensus ids (AC 3 / 3) fall back onto the AC bullet numerically", () => {
  const ticket = {
    key: "ACME-42898",
    summary: "Check and assign RevLevel during ATP Check",
    acceptanceCriteria: "AC1 - Revision Level selection drop down in ATP Check\n\nAC3 - Revision Level-managed, more than one Revision Level is released",
  };
  const view = buildAcView([ticket], [
    { ticket: "ACME-42898", id: "AC 3", status: "unmet", reason: "r", short: "more than one released RL" },
  ]);
  assert.equal(view[0].counts?.unmet, 1);
  const matched = view[0].items.find((it) => it.status);
  assert.equal(matched.id, "AC 3");
  assert.match(matched.headLine, /^AC3 - Revision/);
});

test("numeric fallback stays unambiguous: AC2 must not match an AC20 bullet", () => {
  const ticket = {
    key: "ACME-99",
    summary: "s",
    acceptanceCriteria: "AC2: second\n\nAC20: twentieth",
  };
  const view = buildAcView([ticket], [{ ticket: "ACME-99", id: "AC2", status: "unmet", reason: "r" }]);
  assert.equal(view[0].items.length, 2);
  assert.equal(view[0].counts?.unmet, 1);
  const met = view[0].items.find((it) => it.status === "unmet");
  assert.match(met.headLine, /^AC2/);
  assert.equal(view[0].items[1].status, null, "AC20 must NOT match the AC2 verdict");
});

test("buildAcView returns a structured, render-ready view consumed by renderJiraAppendix", () => {
  const ticket = {
    key: "ACME-42896",
    summary: "Revision Level config",
    type: "Story",
    status: "In Progress",
    priority: "Critical",
    acceptanceCriteria:
      "*AC0*\n * *Given* a Key User\n * *Then* the toggles are updated per mock up\n\n" +
      "*AC1*: add the toggle",
  };
  const verdicts = [
    {
      ticket: "acme-42896",
      id: "AC0",
      status: "not_verifiable",
      reason: "UI mock-up is in another repo",
      short: "toggle ordering and R3 header",
    },
    {
      ticket: "ACME-42896",
      id: "AC1",
      status: "partial",
      reason: "property added but nothing reads it",
      short: "   \n ",
    },
    { ticket: "OTHER-99", id: "AC9", status: "unmet", reason: "not this ticket" },
    { ticket: "ACME-42896" }, // no id/status -> dropped by the view
  ];
  const view = buildAcView([ticket, { key: "ACV2-642", error: "HTTP 404" }, { key: "X", summary: "" }], verdicts);

  assert.equal(view.length, 1);
  const card = view[0];
  assert.equal(card.key, "ACME-42896");
  assert.equal(card.meta, "Story · In Progress · Critical");
  assert.equal(card.summary, "Revision Level config");
  assert.deepEqual(card.counts, { not_verifiable: 1, partial: 1 });
  assert.equal(card.items.length, 2);

  const ac0 = card.items[0];
  assert.equal(ac0.status, "not_verifiable");
  assert.equal(ac0.headLine, ""); // lone *AC0* heading not echoed next to the id
  assert.equal(ac0.short, "toggle ordering and R3 header"); // consensus `short` wins
  assert.deepEqual(ac0.subs, ["Given a Key User", "Then the toggles are updated per mock up"]);
  assert.equal(ac0.reason, "UI mock-up is in another repo");

  const ac1 = card.items[1];
  assert.equal(ac1.status, "partial");
  assert.equal(ac1.headLine, "AC1: add the toggle"); // "*AC1: add the toggle*" -> id AC1 matches, body differs
  assert.equal(ac1.short, "add the toggle"); // whitespace-only `short` falls back to heading, "AC1:" prefix stripped
  assert.equal(ac1.reason, "property added but nothing reads it");

  // Error-only and empty tickets never form cards; no tickets -> [].
  assert.deepEqual(buildAcView([{ key: "ACV2-642", error: "HTTP 404" }], verdicts), []);
  assert.deepEqual(buildAcView([]), []);
  assert.deepEqual(buildAcView([{ key: "X", summary: "" }]), []);

  // The markdown appendix derives from the same verdicts/matching.
  const same = renderJiraAppendix([ticket], verdicts);
  assert.match(same, /\| AC0 — toggle ordering and R3 header \| Not verified \| UI mock-up is in another repo \|/);
  assert.match(same, /\| AC1 — add the toggle \| Partial \| property added but nothing reads it \|/);
});

test("AC parsing drops Jira image macros; with verdicts only judged ACs are rows", () => {
  const ticket = {
    key: "ACME-42896",
    summary: "s",
    acceptanceCriteria:
      "*AC1*\n * *Given* a user\n\n" +
      "!image-2026-10-20-09-25-23-342.png|width=401,height=240!\n\n" +
      "Note: keep Confirmation Service as a separate setting\n\n" +
      "*AC2*: second one !inline-shot.png!",
  };
  const app = renderJiraAppendix([ticket], [
    { ticket: "ACME-42896", id: "AC1", status: "met" },
    { ticket: "ACME-42896", id: "AC2", status: "partial", reason: "r" },
  ]);
  // The pure-image block never becomes a bullet.
  assert.doesNotMatch(app, /image-png|image-2026|inline-shot|width=/);
  // The prose note is context for the agents, not a criterion row.
  assert.doesNotMatch(app, /Note: keep Confirmation Service/);
  assert.match(app, /\| AC1 \| Met \| — \|/);
  assert.match(app, /\| AC2 — second one \| Partial \| r \|/);
});

test("AC parsing drops bare links and pasted payload fragments (live ACME-42667 shape)", () => {
  const ticket = {
    key: "ACME-42667",
    summary: "Send Packaging Instruction",
    acceptanceCriteria:
      "*AC1* send active packaging instruction when ATP ON\n\n" +
      "*AC2* packaging instruction empty when ATP OFF\n\n" +
      "https://inside-docupedia.example.com/confluence/pages/viewpage.action?pageId=2887428050\n\n" +
      "{}EventType{}: OnCreatedUpdated\n\n" +
      '{{    }}{{"$type"}}         {{: }}{{{}"urn:example:acme:BusinessEvent:v1"{}}}{{{},{}}}',
  };
  const noVerdicts = renderJiraAppendix([ticket]);
  assert.doesNotMatch(noVerdicts, /docupedia|\$type|urn:example/);
  const withVerdicts = renderJiraAppendix([ticket], [
    { ticket: "ACME-42667", id: "AC1", status: "met" },
    { ticket: "ACME-42667", id: "AC2", status: "met" },
  ]);
  assert.equal((withVerdicts.match(/^\| AC\d/gm) || []).length, 2);
  assert.doesNotMatch(withVerdicts, /EventType|docupedia|\| — \| — \|/);
});

test("fetchJiraTickets retries once when the first response is not valid JSON (HTML SSO page)", async () => {
  const issueCalls = [];
  const server = http.createServer((req, res) => {
    if (req.url.includes("/rest/api/2/field")) {
      // Field-discovery probe: return an empty list (no custom AC fields).
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
      return;
    }
    issueCalls.push(req.url);
    if (issueCalls.length === 1) {
      // First attempt: SSO/proxy returns an HTML login page instead of JSON.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><head><title>Sign in</title></head></html>");
    } else {
      // Retry: real JSON response.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          key: "ACME-42897",
          fields: { summary: "Prepare BE for Revision Level", status: { name: "Open" } },
        }),
      );
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const [t] = await fetchJiraTickets({ baseUrl: `http://127.0.0.1:${port}/tracker01`, token: "T", keys: ["ACME-42897"] });
    assert.equal(issueCalls.length, 2, "should have retried exactly once");
    assert.equal(t.key, "ACME-42897");
    assert.equal(t.error, undefined);
    assert.equal(t.summary, "Prepare BE for Revision Level");
  } finally {
    server.close();
  }
});

test("fetchJiraTickets reports an error when JSON parsing fails on both attempts", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!DOCTYPE html><html><body>SSO wall</body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const [t] = await fetchJiraTickets({ baseUrl: `http://127.0.0.1:${port}/tracker01`, token: "T", keys: ["ACME-42898"] });
    assert.ok(t.error, "expected an error entry after both attempts failed");
    assert.match(t.error, /Unexpected token/i);
  } finally {
    server.close();
  }
});

test("a Definition of Done heading before the real AC section does not steal the criteria", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        key: "ACME-42",
        fields: {
          summary: "DoD first",
          description:
            "## Definition of Done\n" +
            " - code reviewed, tests green, changelog updated\n\n" +
            "## Acceptance Criteria:\n" +
            "**AC1 - real criterion**\n" +
            "**AC2 - another real criterion**\n",
        },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/tracker01`;
  try {
    const [t] = await fetchJiraTickets({ baseUrl, token: "T", keys: ["ACME-42"] });
    assert.match(t.acceptanceCriteria, /AC1 - real criterion/);
    assert.match(t.acceptanceCriteria, /AC2 - another real criterion/);
    // The DoD checklist must NOT be treated as acceptance criteria.
    assert.doesNotMatch(t.acceptanceCriteria, /code reviewed|changelog|tests green/);
  } finally {
    server.close();
  }
});

test("a Definition of Done heading after the real AC section terminates it", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        key: "ACME-42",
        fields: {
          summary: "DoD after",
          description:
            "## Acceptance Criteria:\n" +
            "**AC1 - real criterion**\n\n" +
            "## Definition of Done\n" +
            " - generic DoD checklist item that must not become a criterion\n",
        },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/tracker01`;
  try {
    const [t] = await fetchJiraTickets({ baseUrl, token: "T", keys: ["ACME-42"] });
    assert.match(t.acceptanceCriteria, /AC1 - real criterion/);
    assert.doesNotMatch(t.acceptanceCriteria, /generic DoD checklist/);
  } finally {
    server.close();
  }
});

test("Definition of Done / Test Cases are a fallback only with a real heading marker", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        key: "ACME-42",
        fields: {
          summary: "Fallback",
          description:
            "## Test Cases\n" +
            " - T1: verify the toggle is off by default\n" +
            " - T2: verify the toggle persists",
        },
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/tracker01`;
  try {
    const [t] = await fetchJiraTickets({ baseUrl, token: "T", keys: ["ACME-42"] });
    assert.match(t.acceptanceCriteria, /T1: verify the toggle is off by default/);

    // A bare prose line "Definition of done ..." with no heading marker must
    // NOT be treated as an AC section at all.
    const server2 = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          key: "ACME-43",
          fields: {
            summary: "Prose",
            description: "Definition of done by the team before Friday.",
          },
        }),
      );
    });
    await new Promise((r) => server2.listen(0, "127.0.0.1", r));
    try {
      const [p] = await fetchJiraTickets({
        baseUrl: `http://127.0.0.1:${server2.address().port}/tracker01`,
        token: "T",
        keys: ["ACME-43"],
      });
      assert.equal(p.acceptanceCriteria, "");
    } finally {
      server2.close();
    }
  } finally {
    server.close();
  }
});

test("stripJiraMarkup removes a truncated {color:#hex macro without a closing brace", () => {
  // Example: a stored description truncated at a fixed byte cap can end with
  // "{color:#172b4d" (no closing brace). It must not leak into the text.
  const dirty = "{color:#172b4d}*AC1*{color} done{color:#172b4d";
  const cleaned = dirty
    .replace(/\{color[^}]*\}/g, "")
    .replace(/\{color(?::[^\s}]*)?(?=\s|$)/gi, "");
  assert.equal(cleaned, "*AC1* done");
  assert.doesNotMatch(cleaned, /\{color/);
});

test("fetchJiraTickets retries once on a transient HTTP 500 response", async () => {
  const issueCalls = [];
  const server = http.createServer((req, res) => {
    if (req.url.includes("/rest/api/2/field")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
      return;
    }
    issueCalls.push(req.url);
    if (issueCalls.length === 1) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errorMessages: ["boom"] }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ key: "ACME-42897", fields: { summary: "OK now" } }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const [t] = await fetchJiraTickets({ baseUrl: `http://127.0.0.1:${port}/tracker01`, token: "T", keys: ["ACME-42897"] });
    assert.equal(issueCalls.length, 2, "should have retried exactly once on HTTP 500");
    assert.equal(t.error, undefined);
    assert.equal(t.summary, "OK now");
  } finally {
    server.close();
  }
});

test("fetchJiraTickets does NOT retry on HTTP 404 (permanent)", async () => {
  const issueCalls = [];
  const server = http.createServer((req, res) => {
    if (req.url.includes("/rest/api/2/field")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
      return;
    }
    issueCalls.push(req.url);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errorMessages: ["does not exist"] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const [t] = await fetchJiraTickets({ baseUrl: `http://127.0.0.1:${port}/tracker01`, token: "T", keys: ["ACME-999"] });
    assert.equal(issueCalls.length, 1, "404 is permanent — no retry");
    assert.match(t.error, /HTTP 404/);
  } finally {
    server.close();
  }
});

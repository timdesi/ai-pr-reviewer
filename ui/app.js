// AI PR Reviewer — dashboard client.
// Fetches jobs from the local API, listens to the SSE stream for live runs,
// and renders job details (agents, reports, artifacts) in tabs.

const state = {
  jobs: [],
  selected: null, // job name
  mode: "pulls", // "pulls" | "jobs"
  pulls: [], // grouped per-PR view from /api/pulls
  appFilter: "", // "" = all apps, else "PROJECT/repo"
  prContext: null, // pull key whose review(s) are shown in the job view
  pullReviewOpen: false, // header review-switcher menu open?
  tab: "overview",
  detail: null,
  artifacts: {}, // job name -> artifacts map
  draftEdits: {}, // job name -> unsaved Draft-tab text (null = untouched)
  liveText: {}, // job -> agentKey -> { attempt, text } (SSE stream buffer)
  running: false,
  notices: [],
  pullPage: 1, // left-list pagination (PRs view)
  jobPage: 1, // left-list pagination (Jobs view)
  jobTotal: 0, // total jobs known to the server (for the list pager)
  stats: null, // latest /api/stats response
  statsGran: "week", // trend-chart granularity: "day" | "week" | "month"
  prevMode: null, // mode to return to when closing the stats page (pulls|jobs)
};

// Items shown per page in the left PR/job lists.
const PAGE_SIZE = 30;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const noop = () => {};

// ---------- small utilities -------------------------------------------------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const sha = (s) => (s ? esc(s.slice(0, 8)) : "–");

function fmtTime(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDateTime(isoOrMs) {
  if (isoOrMs == null) return "–";
  const d = new Date(typeof isoOrMs === "number" ? isoOrMs : isoOrMs);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtDur(ms) {
  if (ms == null) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// "€0.068" — trims trailing zeros and right-sizes tiny amounts.
function fmtEuro(n) {
  if (n == null || !Number.isFinite(n)) return "–";
  return `€${n.toFixed(4).replace(/\.?0+$/, "")}`;
}

// "€2.03" — exactly two decimals; used on the stats page (management-facing).
function fmtEuro2(n) {
  if (n == null || !Number.isFinite(n)) return "–";
  return `€${n.toFixed(2)}`;
}

function stageLabel(stage) {
  return ({ fetch: "Fetching", review: "Reviewing", consensus: "Consensus", render: "Rendering", publish: "Publishing", complete: "Complete", failed: "Failed", unknown: "Unknown" })[stage] || stage;
}

function notice(msg, kind = "error") {
  const box = $("#tab-content").querySelector(".notice");
  const n = el("div", `notice ${kind}`, msg);
  $("#tab-content").prepend(n);
  setTimeout(() => n.remove(), 8000);
}

// ---------- tiny markdown renderer (our report subset) -----------------------

function md(text) {
  if (!text) return "";
  const safe = esc(text);
  const fences = [];
  let out = safe.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, body) => {
    fences.push(body.replace(/\n$/, ""));
    return `\u0000F${fences.length - 1}\u0000`;
  });
  const lines = out.split("\n");
  const html = [];
  let inList = false;
  const closeList = () => { if (inList) { html.push("</ul>"); inList = false; } };
  for (const raw of lines) {
    const line = raw;
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      closeList();
      const lvl = m[1].length;
      html.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if (/^\s*---+\s*$/.test(line)) {
      closeList();
      html.push("<hr/>");
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (!inList) { html.push("<ul>"); inList = true; }
      html.push(`<li>${inline(m[1])}</li>`);
    } else if (/^\s*$/.test(line)) {
      closeList();
    } else if (line.includes("\u0000F")) {
      closeList();
      // Inline the text segments around a code-fence placeholder so a label
      // like `**Evidence:**` right before a fence still renders as bold.
      const htmlParts = line.split(/(\u0000F\d+\u0000)/g).map((part) =>
        part.startsWith("\u0000F") ? `<pre>${fences[+part.slice(1, -1)]}</pre>` : inline(part),
      );
      html.push(htmlParts.join(""));
    } else {
      closeList();
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return html.join("\n");
}

function inline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/_([^_]+)_/g, "<em>$1</em>");
}

// ---------- jobs list --------------------------------------------------------

async function fetchJobs() {
  try {
    // Server-side pagination keeps the payload small (no huge status blobs) and
    // keeps the list cheap even with a large job store (issue #6).
    const offset = (state.jobPage - 1) * PAGE_SIZE;
    const r = await fetch(`/api/jobs?limit=${PAGE_SIZE}&offset=${offset}`);
    const j = await r.json();
    state.jobs = j.jobs || [];
    state.jobTotal = typeof j.total === "number" ? j.total : state.jobs.length;
    renderJobList();
    // Clear the selection only when the store is truly empty — the job list is
    // now paginated, so an off-page selection stays valid (detail loads by name).
    if (state.selected && state.jobTotal === 0) {
      state.selected = null;
      showEmptyOrPull();
    }
  } catch (e) {
    console.warn("fetch jobs failed", e);
  }
}

// Shows the empty state when the current selection no longer exists.
function showEmptyOrPull() {
  $("#job-view").hidden = true;
  $("#empty-state").hidden = false;
}

// Shared Prev/Next pagination footer for the left PR/Job lists, with a
// "showing X–Y of Z" counter. Pass the <ul> so the pager stays hidden while the
// list itself is hidden (mode toggle) or everything fits on one page.
function renderListPager({ listEl, pagerEl, page, total, onNav }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cur = Math.min(page, pages);
  pagerEl.innerHTML = "";
  const hidden = listEl.hidden || pages <= 1;
  pagerEl.hidden = hidden;
  if (hidden) return;
  const from = (cur - 1) * PAGE_SIZE + 1;
  const to = Math.min(cur * PAGE_SIZE, total);
  const prev = el("button", "pager-btn", "‹ Prev");
  prev.disabled = cur <= 1;
  prev.onclick = () => onNav(cur - 1);
  const info = el("span", "pager-info");
  info.innerHTML = `Showing <b>${from}</b>–<b>${to}</b> of <b>${total}</b> · Page <b>${cur}/${pages}</b>`;
  const next = el("button", "pager-btn", "Next ›");
  next.disabled = cur >= pages;
  next.onclick = () => onNav(cur + 1);
  pagerEl.appendChild(prev);
  pagerEl.appendChild(info);
  pagerEl.appendChild(next);
}

function renderJobList() {
  const ul = $("#job-list");
  ul.innerHTML = "";
  if (!state.jobs.length) {
    ul.appendChild(el("li", "dim", "No jobs yet."));
    renderListPager({ listEl: ul, pagerEl: $("#job-pager"), page: state.jobPage, total: 0, onNav: noop });
    return;
  }
  const running = state.jobs.some((j) => ["fetch", "review", "consensus", "render", "publish"].includes(j.stage));
  state.running = running;
  $("#backend-state").textContent = running ? "run in progress" : "idle";
  $("#backend-state").className = "pill" + (running ? " live" : "");
  // Server returns one page (PAGE_SIZE) at a time; `jobTotal` is the real count.
  const total = state.jobTotal || state.jobs.length;
  const page = Math.min(state.jobPage, Math.max(1, Math.ceil(total / PAGE_SIZE)));
  state.jobPage = page;
  for (const job of state.jobs) {
    const li = el("li");
    if (job.job === state.selected) li.classList.add("active");
    li.appendChild(el("span", "job-title", job.title || job.job));
    const sub = el("span", "job-sub");
    if (job.reviewedSha) sub.appendChild(el("span", "sha", sha(job.reviewedSha)));
    const badge = el("span", `badge ${job.stage === "complete" ? "ok" : job.stage === "failed" ? "failed" : "running"}`, stageLabel(job.stage));
    sub.appendChild(badge);
    sub.appendChild(el("span", "", fmtTime(job.startedAt)));
    li.appendChild(sub);
    li.onclick = () => {
      state.prContext = null; // flat job list: no PR context
      selectJob(job.job);
    };
    ul.appendChild(li);
  }
  renderListPager({
    listEl: ul,
    pagerEl: $("#job-pager"),
    page,
    total,
    onNav: (pg) => {
      state.jobPage = pg;
      fetchJobs(); // server-side page: fetch the new offset
    },
  });
}

// ---------- per-PR view + per-app filter --------------------------------------

function switchMode(mode) {
  state.mode = mode;
  const isStats = mode === "stats";
  // While stats is open the sidebar keeps showing the list that was active
  // before (prevMode), so users keep their context and can still navigate.
  const listMode = isStats ? state.prevMode || "pulls" : mode;
  for (const b of document.querySelectorAll("#mode-toggle button")) {
    b.classList.toggle("active", b.dataset.mode === listMode);
  }
  // The stats page renders in the center panel; the header button toggles it
  // and always stays reachable.
  const statsNav = $("#stats-nav");
  if (statsNav) {
    statsNav.classList.toggle("active", isStats);
    statsNav.textContent = isStats ? "← Close stats" : "📊 Stats";
    statsNav.title = isStats ? "Close statistics and go back" : "Management statistics";
  }
  // Left sidebar stays visible in every mode.
  $("#pulls-list").hidden = listMode !== "pulls";
  $("#job-list").hidden = listMode !== "jobs";
  $("#app-filter-row").hidden = listMode !== "pulls";
  $("#pulls-pager").hidden = true;
  $("#job-pager").hidden = true;
  if (listMode === "pulls") renderPulls();
  else if (listMode === "jobs") renderJobList();

  if (isStats) {
    $("#job-view").hidden = true;
    $("#empty-state").hidden = true;
    $("#stats-view").hidden = false;
    renderStats();
  } else {
    $("#stats-view").hidden = true;
    if (state.selected) {
      $("#empty-state").hidden = true;
      $("#job-view").hidden = false;
    } else {
      showEmptyOrPull();
    }
  }
}

async function fetchPulls(opts) {
  const quiet = opts?.quiet;
  try {
    const r = await fetch("/api/pulls?live=1");
    if (!r.ok) throw new Error(`/api/pulls HTTP ${r.status}`);
    const j = await r.json();
    state.pulls = j.pulls || [];
    renderPulls();
    if (state.prContext) {
      const p = state.pulls.find((x) => x.key === state.prContext);
      if (p && state.selected) refreshDetail().then(renderTabs);
      else if (!p) {
        state.prContext = null;
        showEmptyOrPull();
      }
    }
  } catch (e) {
    if (!quiet) console.warn("fetch pulls failed", e);
  }
}

function renderAppFilter() {
  const sel = $("#app-filter");
  const current = sel.value || state.appFilter;
  const apps = [...new Set(state.pulls.map((p) => p.app))].sort();
  sel.innerHTML = "";
  sel.appendChild(new Option("All apps", ""));
  for (const app of apps) {
    const n = state.pulls.filter((p) => p.app === app).length;
    sel.appendChild(new Option(`${app} (${n})`, app));
  }
  if (apps.includes(current)) sel.value = current;
  state.appFilter = sel.value;
}

function pullBadge(p) {
  // Merged / declined / superseded — and PRs Bitbucket no longer has (deleted
  // after merge) — show their terminal state on a dimmed row.
  if (p.unreviewable) return { cls: (p.state || "closed").toLowerCase(), label: (p.state || "closed").toLowerCase() };
  if (p.running) return { cls: "running", label: "running" };
  if (!p.reviews.length) return { cls: "none", label: "not reviewed" };
  if (p.stale === true) return { cls: "stale", label: "new commits" };
  if (p.stale === false) return { cls: "ok", label: "up to date" };
  return { cls: p.latestReview?.stage === "failed" ? "failed" : "", label: stageLabel(p.latestReview?.stage) };
}

function renderPulls() {
  const list = $("#pulls-list");
  list.innerHTML = "";
  renderAppFilter();
  const filtered = state.appFilter ? state.pulls.filter((p) => p.app === state.appFilter) : state.pulls;
  if (!filtered.length) {
    list.appendChild(
      el("li", "dim", state.pulls.length ? "No PRs match this app filter." : "No PR reviews yet."),
    );
    renderListPager({ listEl: list, pagerEl: $("#pulls-pager"), page: state.pullPage, total: 0, onNav: noop });
    return;
  }
  const total = filtered.length;
  const page = Math.min(state.pullPage, Math.max(1, Math.ceil(total / PAGE_SIZE)));
  state.pullPage = page;
  const from = (page - 1) * PAGE_SIZE;
  for (const p of filtered.slice(from, from + PAGE_SIZE)) {
    const li = el("li");
    if (p.unreviewable) li.classList.add("closed"); // merged/declined/gone → dimmed row
    if (p.key === state.prContext) li.classList.add("active");
    li.appendChild(el("span", "job-title", `#${p.prId} · ${p.title || ""}`));
    const sub = el("span", "job-sub");
    const badge = pullBadge(p);
    sub.appendChild(el("span", `badge ${badge.cls}`, badge.label));
    if (p.owner) sub.appendChild(el("span", "owner", `👤 ${p.owner}`));
    if (p.latestReview) sub.appendChild(el("span", "sha", sha(p.latestReview.reviewedSha)));
    sub.appendChild(el("span", "", fmtTime(p.latestReview?.startedAt)));
    if (p.newCommits?.length) {
      sub.appendChild(el("span", "count", `+${p.newCommits.length} commit${p.newCommits.length === 1 ? "" : "s"}`));
    }
    li.appendChild(sub);
    li.onclick = () => openPullLatest(p);
    list.appendChild(li);
  }
  renderListPager({
    listEl: list,
    pagerEl: $("#pulls-pager"),
    page,
    total,
    onNav: (pg) => {
      state.pullPage = pg;
      renderPulls();
    },
  });
}

// Selecting a PR opens its newest review in the ORIGINAL job view (tabs); the
// PR-context strip on top carries the staleness info + the review switcher.
async function openPullLatest(p) {
  if (state.mode === "stats") switchMode(state.prevMode || "pulls"); // selecting something closes stats
  state.prContext = p.key;
  state.pullReviewOpen = false;
  renderPulls(); // move the active highlight to this PR immediately (no waiting for a poll)
  if (!p.reviews.length) {
    notice(`No review yet for ${p.app}#${p.prId} — a review will appear here once one runs or is triggered.`);
    state.prContext = null;
    renderPulls();
    showEmptyOrPull();
    return;
  }
  await selectJob(p.reviews[0].job); // newest review
}

// Custom review-switcher for the PR header — a styled pill that opens a small
// menu listing every review of the PR (newest first). Full DOM rebuilt on each
// render, so clicks are handled by a delegated listener on #pull-head.

function stageDot(rev) {
  const cls =
    rev.stage === "complete" ? "dot-ok" : rev.stage === "failed" ? "dot-fail" : "dot-run";
  const dot = el("span", `dot ${cls}`);
  dot.title = `${rev.stage} · head ${rev.reviewedSha || "?"}`;
  return dot;
}

function revBadgeText(rev) {
  if (rev.stage === "complete") return `${rev.findings ?? 0} findings`;
  if (rev.stage === "failed") return "failed";
  if (rev.findings != null) return `${rev.findings} findings`;
  return stageLabel(rev.stage);
}

function renderReviewSwitcher(p) {
  const wrap = el("div", "review-switcher");
  const cur = p.reviews.find((r) => r.job === state.selected) || p.reviews[0];

  const toggle = el("button");
  toggle.type = "button";
  toggle.id = "pull-review-toggle";
  toggle.title = "Switch review of this PR";
  toggle.appendChild(stageDot(cur));
  const curLabel = el("span", "cur", `Review · ${fmtTime(cur.startedAt)} · ${sha(cur.reviewedSha)} · ${revBadgeText(cur)}`);
  toggle.appendChild(curLabel);
  toggle.appendChild(el("span", "chev", state.pullReviewOpen ? "▲" : "▼"));
  wrap.appendChild(toggle);

  const menu = el("div", "review-menu");
  menu.hidden = !state.pullReviewOpen;
  for (const rev of p.reviews) {
    const opt = el("div", "review-option" + (rev.job === cur.job ? " active" : ""));
    opt.dataset.job = rev.job;
    opt.appendChild(stageDot(rev));
    opt.appendChild(el("span", "info", `${fmtTime(rev.startedAt)} · ${sha(rev.reviewedSha)}`));
    const right = el("span", "meta-r", rev.published ? `${revBadgeText(rev)} · ✔ posted` : revBadgeText(rev));
    opt.appendChild(right);
    menu.appendChild(opt);
  }
  wrap.appendChild(menu);
  return wrap;
}

// The PR-context (staleness + new commits + review switcher) now lives INSIDE
// renderJobHead — one single header, not a second strip.

async function reviewPull(p) {
  if (p.running || p.unreviewable) return; // merged/declined/gone PRs are not re-reviewed
  const publish = !!$("#publish-check").checked;
  const ref = `${p.projectKey}/${p.repoSlug}#${p.prId}`;
  try {
    const r = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pr: ref, publish }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "failed to start review");
    notice(`Review queued for ${ref}${publish ? " (will publish)" : ""}.`, "ok");
    await fetchPulls();
    if (state.selected) refreshDetail(); // PR-context strip picks up "running"
  } catch (err) {
    notice(err.message);
  }
}

// ---------- statistics dashboard --------------------------------------------

const fmtCount = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

// Severity order + labels for the Findings breakdown chips.
const SEV_UI = [
  ["CRITICAL", "Critical"],
  ["HIGH", "High"],
  ["MEDIUM", "Medium"],
  ["LOW", "Low"],
];

async function renderStats() {
  if (!state.stats) {
    const view = $("#stats-view");
    view.innerHTML = "";
    view.appendChild(el("p", "dim", "Loading statistics…"));
    fetchStats();
    return;
  }
  buildStatsView($("#stats-view"), state.stats);
}

async function fetchStats(opts) {
  try {
    const r = await fetch("/api/stats");
    if (!r.ok) throw new Error(`/api/stats HTTP ${r.status}`);
    state.stats = await r.json();
    if (state.mode === "stats") renderStats();
  } catch (e) {
    if (!opts?.quiet) console.warn("fetch stats failed", e);
  }
}

function buildStatsView(view, s) {
  const t = s.totals;
  const u = s.usersOnboard;
  view.innerHTML = "";

  const bar = el("div", "toolbar");
  const hint = el("span", "dim stats-hint");
  hint.textContent = t.firstRun
    ? `From the local job store · first run ${fmtDateTime(t.firstRun)} → last ${fmtDateTime(t.lastRun)}`
    : "No review runs yet.";
  bar.appendChild(hint);
  bar.appendChild(el("span", "spacer"));
  const refresh = el("button", "", "⟳ Refresh");
  refresh.onclick = () => fetchStats();
  bar.appendChild(refresh);
  view.appendChild(bar);

  // ---- headline KPIs (since beginning) ----
  const kpis = el("div", "kpis");
  const kpi = (label, value, sub, title) => {
    const c = el("div", "kpi");
    if (title) c.title = title;
    c.appendChild(el("span", "stat-label", label));
    c.appendChild(el("span", "stat-value", value));
    if (sub) c.appendChild(el("span", "stat-sub", sub));
    kpis.appendChild(c);
  };
  kpi(
    "Total cost",
    fmtEuro2(t.cost.total),
    "",
    "All reviewer + consensus agent token costs across every run",
  );
  kpi(
    "Review runs",
    fmtCount(t.jobs),
    "",
    "Every job is one review run",
  );
  kpi(
    "PRs reviewed",
    fmtCount(t.prs),
    "",
    "Distinct pull requests that received at least one review",
  );
  kpi("Repos", fmtCount(t.repos), "", "Distinct apps (PROJECT/repo) that were reviewed");
  kpi("Users onboard", fmtCount(u.count), "", u.note);

  // Findings — full-width card so it fills the second grid row, with a
  // per-severity breakdown using the finding colors (red/yellow/soft-yellow/dim).
  const fk = el("div", "kpi findings-kpi");
  const fkLeft = el("div", "findings-left");
  fkLeft.appendChild(el("span", "stat-label", "Findings"));
  fkLeft.appendChild(el("span", "stat-value", fmtCount(t.findings.total)));
  fk.appendChild(fkLeft);
  const chips = el("div", "sev-chips");
  for (const [sev, label] of SEV_UI) {
    const chip = el("span", `sev-chip sev-${sev}`, "");
    chip.appendChild(el("span", "dot"));
    chip.appendChild(document.createTextNode(`${label} ${t.findings[sev] || 0}`));
    chips.appendChild(chip);
  }
  fk.appendChild(chips);
  fk.title = "Total findings from consensus reports, split by severity";
  kpis.appendChild(fk);
  view.appendChild(kpis);

  // ---- cadence: per day / week / month / since beginning ----
  const card = el("div", "card");
  card.appendChild(el("h3", "", "Cadence"));
  const table = el("table", "cadence");
  const thead = el("tr");
  for (const h of ["Period", "Review runs", "PRs reviewed", "Published", "Cost"]) thead.appendChild(el("th", "", h));
  table.appendChild(thead);
  const c = s.cadence;
  const rows = [
    ["Per day (avg)", c.day],
    ["Per week (avg)", c.week],
    ["Per month (avg)", c.month],
    ["Since beginning", c.all],
  ];
  rows.forEach(([label, v], i) => {
    const tr = el("tr", i === rows.length - 1 ? "total" : "");
    tr.appendChild(el("td", "period", label));
    tr.appendChild(el("td", "", fmtCount(v.jobs)));
    tr.appendChild(el("td", "", fmtCount(v.prs)));
    tr.appendChild(el("td", "", fmtCount(v.published)));
    tr.appendChild(el("td", "", fmtEuro2(v.cost)));
    table.appendChild(tr);
  });
  card.appendChild(table);
  card.appendChild(
    el(
      "p",
      "dim hint",
      "Each job counts as one review run; “PRs reviewed” counts distinct PRs. The day/week/month rows are averages over the active span since the first run; “Since beginning” is the total.",
    ),
  );
  view.appendChild(card);

  // ---- trend charts ----
  const charts = el("div");
  const head = el("div", "chart-head");
  head.appendChild(el("h3", "", "Trends"));
  const seg = el("div", "seg");
  for (const [key, label] of [["day", "Day"], ["week", "Week"], ["month", "Month"]]) {
    const b = el("button", key === state.statsGran ? "active" : "", label);
    b.onclick = () => {
      state.statsGran = key;
      buildStatsView(view, s); // re-render with the new granularity
    };
    seg.appendChild(b);
  }
  head.appendChild(seg);
  charts.appendChild(head);

  const series = s.series[state.statsGran] || [];
  const act = el("div", "chart");
  act.appendChild(el("div", "chart-title", `Reviews & PRs · ${state.statsGran}`));
  if (series.length) {
    act.appendChild(chartSVG(series, { bars: "jobs", line: "prs" }));
    const legend = el("div", "legend");
    legend.innerHTML =
      `<span><span class="sw" style="background:#5b9dff"></span>review runs</span>` +
      `<span><span class="sw" style="background:#4ade80"></span>PRs reviewed</span>`;
    act.appendChild(legend);
  } else {
    act.appendChild(el("p", "dim", "No activity in this period."));
  }
  charts.appendChild(act);

  const costC = el("div", "chart");
  costC.appendChild(el("div", "chart-title", `Cost · ${state.statsGran}`));
  if (series.length) {
    costC.appendChild(chartSVG(series, { bars: "cost", money: true }));
  } else {
    costC.appendChild(el("p", "dim", "No activity in this period."));
  }
  charts.appendChild(costC);

  view.appendChild(charts);
}

// ---- tiny hand-rolled SVG charts (no external chart library) ----------------

const svgNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, text) {
  const n = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

// Round maxUp to a nice "1/2/5×10^n" ceiling so gridlines land on round values.
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

function axisLabel(iso, gran) {
  const d = new Date(iso);
  if (gran === "month") return d.toLocaleDateString([], { month: "short", year: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function chartSVG(buckets, { bars, line, money = false }) {
  const W = 940, H = 250, padL = 60, padR = 14, padT = 10, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = buckets.length;
  const maxVal = Math.max(
    1,
    ...buckets.map((b) => b[bars] ?? 0),
    ...(line ? buckets.map((b) => b[line] ?? 0) : []),
  );
  const yMax = niceCeil(maxVal);
  const yAt = (v) => padT + plotH - (v / yMax) * plotH;
  const xAt = (i) => padL + (i + 0.5) * (plotW / n);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet" });

  // gridlines + y labels
  for (let s = 0; s <= 4; s++) {
    const v = (yMax / 4) * s;
    const y = yAt(v);
    svg.appendChild(
      svgEl("line", {
        x1: padL, y1: y, x2: W - padR, y2: y, stroke: "#263352", "stroke-width": 1,
        "stroke-dasharray": s === 0 ? "" : "3 4",
      }),
    );
    const label = money ? fmtEuro2(v) : v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
    svg.appendChild(svgEl("text", { x: padL - 8, y: y + 4, fill: "#8a97b4", "font-size": 11, "text-anchor": "end" }, label));
  }

  // bars (review runs / cost)
  const barColor = money ? "#67e8f9" : "#5b9dff";
  const bw = Math.max(3, Math.min(30, (plotW / n) * 0.62));
  buckets.forEach((b, i) => {
    const v = b[bars] ?? 0;
    if (!v) return;
    const x = xAt(i) - bw / 2;
    const y = yAt(v);
    const h = yAt(0) - y;
    svg.appendChild(svgEl("rect", { x, y, width: bw, height: Math.max(1, h), rx: 3, fill: barColor, opacity: money ? 0.85 : 0.7 }));
  });

  // line (PRs reviewed)
  if (line) {
    const pts = buckets.map((b, i) => [xAt(i), yAt(b[line] ?? 0)]);
    const poly = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    svg.appendChild(svgEl("polyline", { points: poly, fill: "none", stroke: "#4ade80", "stroke-width": 2 }));
    for (const [x, y] of pts) {
      svg.appendChild(svgEl("circle", { cx: x, cy: y, r: 3.2, fill: "#4ade80" }));
    }
  }

  // x labels (≤ ~10 across the axis)
  const labelStep = Math.max(1, Math.ceil(n / 10));
  buckets.forEach((b, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return;
    svg.appendChild(
      svgEl("text", { x: xAt(i), y: H - 10, fill: "#8a97b4", "font-size": 11, "text-anchor": "middle" }, axisLabel(b.t, state.statsGran)),
    );
  });

  return svg;
}

// ---------- job detail -------------------------------------------------------

async function selectJob(name) {
  if (state.mode === "stats") switchMode(state.prevMode || "pulls"); // selecting something closes stats
  state.selected = name;
  state.tab = "overview";
  $("#empty-state").hidden = true;
  $("#job-view").hidden = false;
  renderJobList();
  await refreshDetail();
  renderTabs();
}

async function refreshDetail() {
  if (!state.selected) return;
  try {
    const r = await fetch(`/api/jobs/${encodeURIComponent(state.selected)}`);
    const j = await r.json();
    state.detail = j.job;
    renderJobHead();
  } catch (e) {
    console.warn("refresh detail failed", e);
  }
}

async function fetchArtifacts(name) {
  if (state.artifacts[name]) return state.artifacts[name];
  try {
    const r = await fetch(`/api/jobs/${encodeURIComponent(name)}/artifacts`);
    const j = await r.json();
    const arts = j.artifacts || {};
    // A running job still gains files (comment-draft.md last); cache only finished ones.
    const finished = state.detail?.job === name && ["complete", "failed"].includes(state.detail.stage);
    if (finished) state.artifacts[name] = arts;
    return arts;
  } catch (e) {
    console.warn("fetch artifacts failed", e);
    return {};
  }
}

function pullForJob(job) {
  const ref = job?.ref;
  if (!ref || ref.projectKey == null || ref.repoSlug == null || ref.prId == null) return null;
  const key = `${ref.projectKey}/${ref.repoSlug}#${ref.prId}`;
  return state.pulls.find((x) => x.key === key) || null;
}

function renderJobHead() {
  const job = state.detail;
  if (!job) return;
  const p = state.prContext ? state.pulls.find((x) => x.key === state.prContext) : null;
  const pull = p || pullForJob(job);

  const head = $("#job-head");
  head.innerHTML = "";
  head.appendChild(el("h2", "", job.title || job.job));
  const meta = el("div", "meta");
  meta.appendChild(el("span", "", `PR ${esc(job.ref?.projectKey)}/${esc(job.ref?.repoSlug)} #${job.ref?.prId}`));
  if (pull?.owner) meta.appendChild(el("span", "owner", `👤 ${esc(pull.owner)}`));
  if (p?.branch) {
    const branchSpan = el("span", "", "branch ");
    branchSpan.appendChild(el("b", "", esc(p.branch)));
    meta.appendChild(branchSpan);
    if (p.targetBranch) meta.appendChild(el("span", "dim", `→ ${esc(p.targetBranch)}`));
  }
  const shaSpan = el("span", "", "head ");
  shaSpan.appendChild(el("b", "", sha(job.reviewedSha)));
  meta.appendChild(shaSpan);
  meta.appendChild(el("span", "", `started ${fmtTime(job.startedAt)}`));
  const dirSpan = el("span", "", "dir ");
  dirSpan.appendChild(el("b", "", esc(job.dir)));
  meta.appendChild(dirSpan);
  head.appendChild(meta);

  // The PR context lives inside this same header (no second strip): staleness
  // badge, new-commit counts/list, re-review, and the review switcher.
  if (p && p.reviews.length) {
    const tools = el("div", "pr-tools");
    const badge = pullBadge(p);
    tools.appendChild(el("span", `badge ${badge.cls}`, badge.label));
    if (p.newCommits?.length) {
      tools.appendChild(el("span", "count", `+${p.newCommits.length} new commit${p.newCommits.length === 1 ? "" : "s"}`));
    }
    if (p.stale === true) {
      const det = el("details", "commits-details");
      const sum = el("summary", "", `New commits since last review (${p.newCommits?.length || 0})`);
      det.appendChild(sum);
      if (p.newCommits?.length) {
        const ul = el("ul", "commits");
        for (const c of p.newCommits) {
          const li = el("li", "commit");
          li.appendChild(el("code", "sha", sha(c.id)));
          li.appendChild(el("span", "msg", (c.message || "").split("\n")[0] || "(no message)"));
          li.appendChild(el("span", "who", `${c.author || ""} · ${fmtDateTime(c.timestamp)}`));
          ul.appendChild(li);
        }
        det.appendChild(ul);
      } else {
        det.appendChild(el("p", "dim", "Head moved; the commit list could not be fetched from Bitbucket."));
      }
      tools.appendChild(det);
    }
    if (p.historyRewritten) {
      tools.appendChild(el("span", "dim note", "force-pushed since last review"));
    }
    if (!p.running) {
      if (p.unreviewable) {
        tools.appendChild(
          el("span", "dim note", `${(p.state || "closed").toLowerCase()} — no further reviews`),
        );
      } else {
        const btn = el("button", "mini", "↻ Review latest");
        btn.title = "Re-review the current head of this PR";
        btn.onclick = () => reviewPull(p);
        tools.appendChild(btn);
      }
    }
    tools.appendChild(renderReviewSwitcher(p));
    head.appendChild(tools);
  }
}

function renderTabs() {
  const tabs = $("#tabs");
  for (const b of tabs.children) b.classList.toggle("active", b.dataset.tab === state.tab);
  const job = state.detail;
  if (!job) return;
  // Background refreshes must not wipe a draft the user is editing.
  if (state.tab === "draft" && state.draftEdits[state.selected] != null && document.querySelector("textarea.draft")) return;
  const content = $("#tab-content");
  content.innerHTML = "";

  switch (state.tab) {
    case "overview": renderOverview(content, job); break;
    case "reviewers": renderAgents(content, job); break;
    case "draft": renderDraftTab(content, job); break;
    case "artifacts": renderArtifactsTab(content, job); break;
  }
}

$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  state.tab = b.dataset.tab;
  renderTabs();
});

// Shared severity-ordered findings list, reused by the job Overview and the
// new inline per-PR review report.
function buildFindingsList(findings) {
  const wrap = el("div", "findings");
  const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const ordered = [...(findings || [])].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  const labeled = (label, htmlText) => {
    const p = document.createElement("p");
    p.innerHTML = `<span class="label">${label}</span><br>${htmlText}`;
    return p;
  };
  ordered.forEach((f, i) => {
    const card = el("div", "finding");
    const head = el("div", "");
    head.appendChild(el("span", `sev sev-${f.severity}`, `#${i + 1} · ${f.severity} · conf ${f.confidence ?? "?"}`));
    card.appendChild(head);
    card.appendChild(el("div", "title", f.title || "–"));
    card.appendChild(el("div", "loc", `${f.file || "?"}${f.line_start ? `:${f.line_start}` : ""}`));
    if (f.description) card.appendChild(labeled("What", inline(esc(f.description))));
    if (f.impact) card.appendChild(labeled("Impact", inline(esc(f.impact))));
    if (f.evidence) card.appendChild(el("code", "evidence", f.evidence));
    if (f.suggested_fix) card.appendChild(labeled("Suggested fix", inline(esc(f.suggested_fix))));
    wrap.appendChild(card);
  });
  if (!ordered.length) wrap.appendChild(el("p", "dim", "No findings in the final report."));
  return wrap;
}

// ---------- overview ---------------------------------------------------------

// Colored status labels for the consensus acceptance-criteria verdicts — same
// wording as the comment/report table (src/jira.js AC_STATUS_LABELS).
const AC_STATUS = {
  met: { label: "Met", cls: "ac-met" },
  partial: { label: "Partial", cls: "ac-partial" },
  unmet: { label: "Unmet", cls: "ac-unmet" },
  not_verifiable: { label: "Not verified", cls: "ac-not-verifiable" },
};

/** DOM card for the Overview "Jira coverage" (null when no verdicts); mirrors the comment table. */
function buildAcCard(jiraAc) {
  const cards = (Array.isArray(jiraAc) ? jiraAc : []).filter(
    (c) => c && Array.isArray(c.items) && c.items.some((it) => it && it.id && AC_STATUS[it.status]),
  );
  if (!cards.length) return null;
  const card = el("div", "card");
  card.appendChild(el("h3", "", "Jira coverage"));
  for (const c of cards) {
    const title = `${c.key}${c.summary ? ` — ${c.summary}` : ""}`;
    const head = el("div", "ac-head");
    if (c.url) {
      const a = el("a", "", title);
      a.href = c.url;
      a.target = "_blank";
      head.appendChild(a);
    } else head.textContent = title;
    card.appendChild(head);
    const table = el("table", "acs");
    for (const it of c.items) {
      const st = AC_STATUS[it.status];
      if (!(it && it.id && st)) continue;
      const tr = el("tr");
      tr.appendChild(el("td", "ac-id", it.id));
      tr.appendChild(el("td", "", it.short || it.headLine || ""));
      tr.appendChild(el("td", `ac-status ${st.cls}`, st.label));
      tr.appendChild(el("td", "dim", it.reason || "—"));
      table.appendChild(tr);
    }
    card.appendChild(table);
  }
  return card;
}

// Same split as the public comment (src/report.js partitionFindings), driven by
// the policy the pipeline stored; older jobs without one show everything in full.
const SEV_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
function partitionFindings(findings, policy) {
  if (!policy) return { main: findings || [], minor: [] };
  const maxRank = SEV_RANK[String(policy.minSeverity || "LOW").toUpperCase()] ?? 3;
  const minConf = typeof policy.minConfidence === "number" ? policy.minConfidence : 0;
  const main = [];
  const minor = [];
  for (const f of findings || []) {
    const conf = typeof f.confidence === "number" ? f.confidence : 1;
    ((SEV_RANK[f.severity] ?? 3) <= maxRank && conf >= minConf ? main : minor).push(f);
  }
  return { main, minor };
}

function renderOverview(content, job) {
  const badge = el("span", `big-badge ${job.stage === "complete" ? "complete" : job.stage === "failed" ? "failed" : "running"}`, stageLabel(job.stage));
  const bar = el("div", "toolbar");
  bar.appendChild(badge);
  if (job.ref?.prId) {
    const pull = pullForJob(job);
    const closed = !!pull?.unreviewable; // merged/declined/gone → no re-review
    const again = el("button", "", "↻ Review again");
    again.disabled = closed || ["fetch", "review", "consensus", "render", "publish"].includes(job.stage);
    again.title = closed
      ? `This PR is ${(pull.state || "closed").toLowerCase()} and can no longer be reviewed.`
      : "Re-run this PR through the reviewers (dry run; nothing is published).";
    again.onclick = () => restartReview(job);
    bar.appendChild(again);
    if (closed) bar.appendChild(el("span", "dim", `${(pull.state || "closed").toLowerCase()} — no further reviews`));
  }
  bar.appendChild(el("span", "spacer"));
  if (job.error) bar.appendChild(el("span", "dim", esc(job.error)));
  content.appendChild(bar);
  if (job.error) content.appendChild(el("div", "notice error", esc(job.error)));

  const cons = job.consensus;
  if (!cons) {
    const card = el("div", "card");
    card.appendChild(el("h3", "", "Status"));
    card.appendChild(el("p", "", job.stage === "complete" ? "Job finished." : `Pipeline stage: ${stageLabel(job.stage)}…`));
    content.appendChild(card);
    return;
  }

  const { main, minor } = partitionFindings(cons.findings, job.commentPolicy);
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of main) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  const summaryCard = el("div", "card");
  summaryCard.appendChild(el("h3", "", "Summary"));
  summaryCard.appendChild(el("p", "", cons.summary || "–"));
  const countsLine = el("div", "meta");
  for (const sev of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
    if (!counts[sev]) continue;
    const span = el("span", `sev-${sev}`, `${sev}: ${counts[sev]}`);
    span.style.fontWeight = "700";
    countsLine.appendChild(span);
  }
  if (minor.length) countsLine.appendChild(el("span", "dim", `${minor.length} minor`));
  if (!countsLine.children.length) countsLine.appendChild(el("span", "dim", "no findings"));
  summaryCard.appendChild(countsLine);
  content.appendChild(summaryCard);

  const pub = el("div", "card");
  pub.appendChild(el("h3", "", "Publication"));
  if (job.publish?.published) {
    const a = el("a", "", `✔ Published as comment #${job.publish.commentId}`);
    a.href = job.publish.url;
    a.target = "_blank";
    pub.appendChild(a);
  } else if (job.publish?.stale) {
    pub.appendChild(el("p", "notice error", `Skipped: ${job.publish.reason || "stale"}`));
  } else if (job.stage === "complete" && (job.paths?.finalReport || job.paths?.commentDraft)) {
    const kept = el("p", "", "Dry run — report kept at ");
    kept.appendChild(el("code", "", job.publish?.draft || job.paths?.commentDraft || "comment-draft.md"));
    kept.appendChild(el("span", "", " (head-SHA check runs before posting)."));
    pub.appendChild(kept);
    const btn = el("button", "", "Post comment to Bitbucket");
    btn.onclick = publishJob;
    pub.appendChild(btn);
  }
  content.appendChild(pub);

  const fcard = el("div", "card");
  fcard.appendChild(el("h3", "", `Findings (${main.length})`));
  if (main.length || !minor.length) fcard.appendChild(buildFindingsList(main));
  else fcard.appendChild(el("p", "dim", "No significant findings — only the minor points below."));
  content.appendChild(fcard);

  if (minor.length) {
    // Collapsed like the comment's one-line list; full details on expand.
    const mcard = el("div", "card");
    const det = document.createElement("details");
    det.appendChild(el("summary", "", `Minor (${minor.length}) — low severity or low confidence; shown as one line each in the PR comment`));
    det.appendChild(buildFindingsList(minor));
    mcard.appendChild(det);
    content.appendChild(mcard);
  }

  // Acceptance criteria (linked Jira tickets, with consensus verdicts). Fed by
  // status.jiraAc — the same structured view the report appendix is derived from.
  const acCard = buildAcCard(job.jiraAc);
  if (acCard) content.appendChild(acCard);

  if ((cons.notes || []).length) {
    const notes = el("div", "card");
    notes.appendChild(el("h3", "", "Notes"));
    const ul = el("ul");
    for (const n of cons.notes) {
      const li = document.createElement("li");
      li.innerHTML = inline(esc(n));
      ul.appendChild(li);
    }
    notes.appendChild(ul);
    content.appendChild(notes);
  }

  // Cost + run time — totals up front, per-agent detail hidden behind a
  // <details> so it stays readable. The total execute time is the job's wall
  // clock (startedAt → completedAt); runs recorded before completedAt existed
  // fall back to the sum of the agents' durations.
  const costCard = el("div", "card");
  costCard.appendChild(el("h3", "", "Costs & run time"));
  const grand = { input: 0, cache: 0, output: 0, total: 0 };
  let costRows = 0;
  const noUsage = [];
  const detailRows = [];
  for (const key of AGENT_KEYS) {
    const ag = job.agents?.[key];
    if (!ag) continue;
    if (ag.cost) {
      grand.input += ag.cost.input;
      grand.cache += ag.cost.cache;
      grand.output += ag.cost.output;
      grand.total += ag.cost.total;
      costRows++;
    } else if (ag.status === "ok") {
      // Finished agent whose provider reported no token usage (e.g. GPT-6 Luna).
      noUsage.push(`${AGENT_LABELS[key] || key} (${friendlyModel(ag.model)})`);
    }
    detailRows.push({ label: `${AGENT_LABELS[key] || key} · ${friendlyModel(ag.model)}`, cost: ag.cost, durationMs: ag.durationMs });
  }

  // Vision transcription (PR screenshots) is a separate cost row — priced at its
  // own model (gpt-6-luna), so it never mixes into a reviewer's usage.
  const vision = job.vision;
  if (vision) {
    if (vision.cost) {
      grand.input += vision.cost.input;
      grand.cache += vision.cost.cache;
      grand.output += vision.cost.output;
      grand.total += vision.cost.total;
      costRows++;
    }
    const imgLabel = vision.transcribed
      ? ` · ${vision.transcribed} image${vision.transcribed === 1 ? "" : "s"}${vision.unreadable ? `, ${vision.unreadable} unreadable` : ""}`
      : vision.unreadable
        ? ` · ${vision.unreadable} unreadable`
        : "";
    detailRows.push({
      label: `Vision transcription${vision.model ? ` · ${friendlyModel(vision.model)}` : ""}${imgLabel}`,
      cost: vision.cost || null,
      durationMs: 0,
    });
  }

  let runMs = null;
  if (job.startedAt && job.completedAt) {
    runMs = new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime();
  } else {
    const d = detailRows.reduce((s, r) => s + (r.durationMs || 0), 0);
    if (d > 0) runMs = d;
  }

  const stats = el("div", "stats-grid");
  const addStat = (label, value, title) => {
    const s = el("div", "stat");
    if (title) s.title = title;
    s.appendChild(el("span", "stat-label", label));
    s.appendChild(el("span", "stat-value", value));
    stats.appendChild(s);
  };
  addStat(
    "Total cost",
    costRows ? fmtEuro(grand.total) : "–",
    costRows ? `in ${fmtEuro(grand.input)} (cache ${fmtEuro(grand.cache)}) · out ${fmtEuro(grand.output)}` : "",
  );
  addStat(
    "Total execute time",
    runMs ? fmtDur(runMs) : "–",
    job.startedAt && job.completedAt ? `ran ${fmtDateTime(job.startedAt)} → ${fmtDateTime(job.completedAt)}` : "wall-clock time not recorded — showing the sum of agent durations",
  );
  costCard.appendChild(stats);

  const det = el("details", "");
  det.appendChild(el("summary", "", "Details · per agent"));
  const costTable = el("table", "costs");
  const thead = el("tr", "");
  for (const h of ["Reviewer", "Input (cache)", "Output", "Total", "Time"]) thead.appendChild(el("th", "", h));
  costTable.appendChild(thead);
  for (const r of detailRows) {
    const tr = el("tr", "");
    tr.appendChild(el("td", "", r.label));
    if (r.cost) {
      tr.appendChild(el("td", "", `${fmtEuro(r.cost.input)}${r.cost.cache ? ` (${fmtEuro(r.cost.cache)})` : ""}`));
      tr.appendChild(el("td", "", fmtEuro(r.cost.output)));
      tr.appendChild(el("td", "", fmtEuro(r.cost.total)));
    } else {
      tr.appendChild(el("td", "", "–"));
      tr.appendChild(el("td", "", "–"));
      tr.appendChild(el("td", "", "–"));
    }
    tr.appendChild(el("td", "", r.durationMs ? fmtDur(r.durationMs) : "–"));
    costTable.appendChild(tr);
  }
  if (costRows) {
    const tr = el("tr", "total");
    tr.appendChild(el("td", "", "TOTAL"));
    tr.appendChild(el("td", "", `${fmtEuro(grand.input)}${grand.cache ? ` (${fmtEuro(grand.cache)})` : ""}`));
    tr.appendChild(el("td", "", fmtEuro(grand.output)));
    tr.appendChild(el("td", "", fmtEuro(grand.total)));
    tr.appendChild(el("td", "", runMs ? fmtDur(runMs) : "–"));
    costTable.appendChild(tr);
  }
  det.appendChild(costTable);
  costCard.appendChild(det);

  if (!costRows) {
    costCard.appendChild(
      el("p", "dim", "No cost data yet — token usage is captured for runs started after the upgrade that added pricing."),
    );
  }
  if (noUsage.length) {
    costCard.appendChild(el("p", "dim", `${noUsage.join(", ")}: no token usage is reported by this provider.`));
  }
  content.appendChild(costCard);
}

async function restartReview(job) {
  const base = `${job.ref.projectKey}/${job.ref.repoSlug}#${job.ref.prId}`;
  // A GitHub job must go back in platform-explicit form — the bare
  // owner/repo#N short ref would default to Bitbucket and restart the review
  // against the wrong backend.
  const ref = job.ref?.platform === "github" ? `gh:${base}` : base;
  if (!window.confirm(`Re-run the review for ${ref}?\n\nModels will be invoked again (dry run — nothing is published).`)) return;
  try {
    const r = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pr: ref, publish: false }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "failed to start review");
    notice("Review restarted — watch the agents below.", "ok");
  } catch (err) {
    notice(err.message);
  }
}

async function publishJob(evt) {
  const name = state.selected;
  const btn = evt?.target?.closest?.("button");
  if (btn) { btn.disabled = true; btn.textContent = "Posting…"; }
  try {
    const r = await fetch(`/api/jobs/${encodeURIComponent(name)}/publish`, { method: "POST" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "publish failed");
    notice(`Published comment #${j.commentId}`, "ok");
    await refreshDetail();
    renderTabs();
  } catch (e) {
    notice(e.message);
    if (btn) { btn.disabled = false; btn.textContent = "Post comment to Bitbucket"; }
  }
}

// ---------- agents -----------------------------------------------------------

const AGENT_LABELS = { a: "Reviewer A", b: "Reviewer B", c: "Reviewer C", d: "Reviewer D", consensus: "Consensus" };
const AGENT_KEYS = ["a", "b", "c", "d", "consensus"];

// Model IDs used by the pipeline -> human-friendly names (kept tidy even where
// the raw provider/model id changes, e.g. myprovider/discretestack-stable-fast).
// The server injects the deployment's map at serve time over the marker below
// (from ui.modelOverrides / MODEL_OVERRIDES_JSON), so this file stays
// byte-identical across deployments (zero-divergence). The marker is replaced
// by a JSON object literal, e.g. {"id":"Name",...}. Raw (unserved) the empty
// object stands in and friendlyModel() humanises ids.
const MODEL_OVERRIDES = /*__MODEL_OVERRIDES__*/ {};

function friendlyModel(id) {
  if (!id) return "?";
  if (MODEL_OVERRIDES[id]) return MODEL_OVERRIDES[id];
  // Fallback: last id segment, `-5-5` -> `.5.5`, kebab/underscores -> "Title Case".
  return String(id)
    .split("/")
    .pop()
    .replace(/(\d+)-(\d+)/g, "$1.$2")
    .replace(/[-_]+/g, " ")
    .replace(/^[a-z]|\s[a-z]/g, (c) => c.toUpperCase());
}

// Persistent "expanded" state for agent cards, keyed `jobName|agentKey`, so the
// cards stay open across the frequent live re-renders (instead of collapsing a
// second after you expand them).
const openAgents = new Set();

function agentIsOpen(jobName, key, ag) {
  if (ag.status === "running") return true; // keep the running agent visible
  if (openAgents.has(`${jobName}|${key}`)) return true;
  if (key === "consensus") return true; // consensus open by default
  return false;
}

function renderAgents(content, job) {
  if (!job.agents) {
    content.appendChild(el("p", "dim", "No agent data yet."));
    return;
  }
  const liveForJob = state.liveText[job.job] || {};
  for (const key of AGENT_KEYS) {
    const ag = job.agents[key];
    if (!ag) continue;
    const card = el("div", "agent" + (agentIsOpen(job.job, key, ag) ? " open" : ""));
    const head = el("div", "agent-head");
    head.appendChild(el("span", "name", AGENT_LABELS[key] || key));
    const modelSpan = el("span", "model", friendlyModel(ag.model));
    modelSpan.title = ag.model || "";
    head.appendChild(modelSpan);
    head.appendChild(el("span", `status ${ag.status}`, ag.status === "ok" ? `✔ ${ag.findings ?? 0} findings` : ag.status === "failed" ? "✘ failed" : ag.status === "running" ? "running…" : ag.status === "skipped" ? "⏭ skipped (not a translation PR)" : "pending"));
    if (ag.durationMs) head.appendChild(el("span", "dur", fmtDur(ag.durationMs)));
    head.appendChild(el("span", "chev", "▸"));
    head.onclick = () => {
      if (ag.status !== "running") {
        const k = `${job.job}|${key}`;
        if (openAgents.has(k)) openAgents.delete(k);
        else openAgents.add(k);
      }
      card.classList.toggle("open");
    };
    card.appendChild(head);

    const body = el("div", "agent-body");
    if (ag.error) body.appendChild(el("div", "notice error", esc(ag.error)));
    if (ag.cost) {
      const costLine = el("div", "costline");
      costLine.appendChild(
        el(
          "span",
          "dim",
          `Input ${fmtEuro(ag.cost.input)} (cache ${fmtEuro(ag.cost.cache)}) · Output ${fmtEuro(ag.cost.output)} · Total ${fmtEuro(ag.cost.total)}`,
        ),
      );
      if (ag.usage) costLine.title = `${ag.usage.input} in / ${ag.usage.cacheRead + ag.usage.cacheWrite} cache / ${ag.usage.output} out tokens`;
      body.appendChild(costLine);
    }
    const attempts = ag.attempts || [];
    const live = liveForJob[key];
    // The in-flight attempt is part of `attempts` (pushed when it starts and
    // streamed into status.json), so the number shown is always i+1 — the same
    // numbering the finished attempts use. No separate "live" block needed.
    attempts.forEach((att, i) => {
      const streaming = ag.status === "running" && i === attempts.length - 1 && !att.ok;
      const attempt = el("div", "attempt");
      const ah = el("div", "attempt-head");
      ah.appendChild(el("span", "", `attempt ${i + 1}`));
      ah.appendChild(
        el(
          "span",
          `status ${streaming ? "running" : att.ok ? "ok" : "failed"}`,
          streaming ? "streaming…" : att.ok ? `✔ valid (${att.findings} findings)` : `✘ ${att.error || "failed"}`,
        ),
      );
      attempt.appendChild(ah);
      const text = streaming && live?.text ? live.text : att.text || "";
      if (text || streaming) {
        // Empty `text` during a running attempt still shows the streaming box.
        const pre = el("pre", "preview" + (streaming || !att.ok ? " stream" : ""), text);
        if (streaming) pre.dataset.liveAgent = key;
        attempt.appendChild(pre);
      }
      body.appendChild(attempt);
    });
    if (!attempts.length) body.appendChild(el("p", "dim", "not started yet"));
    card.appendChild(body);
    content.appendChild(card);
  }
}

// ---------- comment draft (editable) -----------------------------------------

async function renderDraftTab(content, job) {
  const arts = await fetchArtifacts(state.selected);
  const art = arts["comment-draft.md"];

  const bar = el("div", "toolbar");
  bar.appendChild(el("span", "dim", "comment-draft.md"));
  const editedTag = el("span", "dim", " · edited (not saved until posted)");
  bar.appendChild(editedTag);
  bar.appendChild(el("span", "spacer"));
  const resetBtn = el("button", "", "Reset to generated");
  const previewBtn = el("button", "", "Preview");
  const postBtn = el("button", "", "Post comment to Bitbucket");
  bar.appendChild(resetBtn);
  bar.appendChild(previewBtn);
  bar.appendChild(postBtn);
  content.appendChild(bar);

  const generated = art?.content ? art.content.replace(/\n$/, "") : "";
  const ta = el("textarea", "artifact draft", "");
  ta.value = state.draftEdits[state.selected] ?? generated;
  ta.placeholder =
    job.stage === "complete" || job.stage === "failed"
      ? "(no draft for this job — write a comment and post it)"
      : "(the draft appears here when the review finishes)";
  ta.spellcheck = false;
  content.appendChild(ta);

  const syncEdited = () => {
    const edited = state.draftEdits[state.selected] != null;
    editedTag.hidden = !edited;
    resetBtn.hidden = !edited;
  };
  ta.addEventListener("input", () => {
    state.draftEdits[state.selected] = ta.value === generated ? null : ta.value;
    syncEdited();
  });
  resetBtn.onclick = () => {
    state.draftEdits[state.selected] = null;
    ta.value = generated;
    syncEdited();
  };
  syncEdited();

  const preview = el("div", "md");
  preview.hidden = true;
  content.appendChild(preview);

  previewBtn.onclick = () => {
    preview.hidden = !preview.hidden;
    previewBtn.textContent = preview.hidden ? "Preview" : "Hide preview";
    if (!preview.hidden) preview.innerHTML = md(ta.value || "(empty draft)");
  };

  postBtn.onclick = async () => {
    if (!ta.value.trim()) return notice("Draft is empty — nothing to post.");
    postBtn.disabled = true;
    postBtn.textContent = "Posting…";
    try {
      const r = await fetch(`/api/jobs/${encodeURIComponent(state.selected)}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: ta.value }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "publish failed");
      notice(`Published comment #${j.commentId}`, "ok");
      state.artifacts[state.selected] = null; // refetch, the draft was rewritten
      state.draftEdits[state.selected] = null;
      await refreshDetail();
      renderTabs();
    } catch (e) {
      notice(e.message);
      postBtn.disabled = false;
      postBtn.textContent = "Post comment to Bitbucket";
    }
  };
}

// ---------- artifacts --------------------------------------------------------

async function renderArtifactsTab(content, job) {
  const arts = await fetchArtifacts(state.selected);
  const table = el("table", "artifacts");
  table.appendChild(el("tr", "", null));
  const thead = table.querySelector("tr");
  for (const h of ["File", "Size", "Kind"]) thead.appendChild(el("th", "", h));
  const names = Object.keys(arts).sort();
  if (!names.length) content.appendChild(el("p", "dim", "No artifacts."));
  for (const name of names) {
    const a = arts[name];
    const tr = el("tr", "file-row");
    tr.appendChild(el("td", "", a.name));
    tr.appendChild(el("td", "", a.size >= 1024 ? `${(a.size / 1024).toFixed(1)} KB` : `${a.size} B`));
    tr.appendChild(el("td", "", a.kind));
    tr.onclick = () => openModal(a.name, a.content ?? "(binary — not shown)");
    table.appendChild(tr);
  }
  content.appendChild(table);
}

function openModal(title, body) {
  $("#modal-title").textContent = title;
  $("#modal-body").textContent = body;
  $("#modal").hidden = false;
}
$("#modal-close").onclick = () => ($("#modal").hidden = true);
$("#modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") $("#modal").hidden = true;
});

// ---------- model settings (UI-switchable reviewer/consensus/vision models) ---------

// A/B/C/D/consensus are picked per review; `vision` is a default only (saved in
// the Models dialog, applied to every review — never sent with the per-review
// POST, because the transcribe step reads config.review.visionModel).
const MODEL_SLOT_KEYS = ["a", "b", "c", "d", "consensus"];
const DIALOG_SLOT_KEYS = [...MODEL_SLOT_KEYS, "vision"];
let modelOptions = []; // [{ id, name, vision }] from /api/models

async function loadModelPicker() {
  try {
    const r = await fetch("/api/models");
    if (!r.ok) throw new Error(`/api/models HTTP ${r.status}`);
    const j = await r.json();
    modelOptions = Array.isArray(j.available) ? j.available : [];
    const assigned = j.assigned || {};
    for (const slot of DIALOG_SLOT_KEYS) {
      const sel = $(`[data-model-slot="${slot}"]`);
      if (!sel) continue;
      sel.textContent = "";
      // The vision slot is restricted to image-capable models.
      const opts = slot === "vision" ? modelOptions.filter((m) => m.vision) : modelOptions;
      for (const m of opts) {
        const opt = el("option");
        opt.value = m.id;
        opt.textContent = MODEL_OVERRIDES[m.id] || m.name || m.id;
        sel.appendChild(opt);
      }
      const cur = assigned[slot];
      // Keep a stale persisted choice visible (e.g. model removed from config).
      if (cur && !opts.some((m) => m.id === cur)) {
        const opt = el("option");
        opt.value = cur;
        opt.textContent = `${MODEL_OVERRIDES[cur] || cur} (not in runtime config)`;
        sel.appendChild(opt);
      }
      if (cur) sel.value = cur;
    }
  } catch {
    // Non-fatal: reviews still run with configMap defaults.
    const btn = $("#models-toggle");
    btn.disabled = true;
    btn.textContent = "Models (unavailable)";
  }
}

function currentModelSelection() {
  const out = {};
  for (const slot of MODEL_SLOT_KEYS) {
    const sel = $(`[data-model-slot="${slot}"]`);
    if (sel && sel.value) out[slot] = sel.value;
  }
  return out;
}

// Everything in the Models dialog (incl. the vision slot) — for saving defaults.
function currentDialogSelection() {
  const out = {};
  for (const slot of DIALOG_SLOT_KEYS) {
    const sel = $(`[data-model-slot="${slot}"]`);
    if (sel && sel.value) out[slot] = sel.value;
  }
  return out;
}

$("#models-toggle").addEventListener("click", () => {
  const p = $("#models-panel");
  p.hidden = !p.hidden;
  $("#models-toggle").textContent = p.hidden ? "Models ▾" : "Models ▴";
});

$("#save-models").addEventListener("click", async () => {
  const btn = $("#save-models");
  const status = $("#models-status");
  btn.disabled = true;
  try {
    const r = await fetch("/api/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: currentDialogSelection() }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "save failed");
    status.textContent = "Saved ✓ (defaults for future reviews)";
  } catch (err) {
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
    setTimeout(() => {
      if (status.textContent && status.textContent !== "Saved ✓ (defaults for future reviews)") return;
      status.textContent = "";
    }, 4000);
  }
});

// ---------- new review + SSE -------------------------------------------------

$("#new-review").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pr = $("#pr-input").value.trim();
  if (!pr) return;
  const btn = $("#start-btn");
  btn.disabled = true;
  btn.textContent = "Starting…";
  try {
    const r = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pr, publish: $("#publish-check").checked, models: currentModelSelection() }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "failed to start");
    notice("Review queued — watch the agents below.", "ok");
    $("#pr-input").value = "";
  } catch (err) {
    notice(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "▶ Review";
  }
});

function connectSSE() {
  const es = new EventSource("/api/events");
  es.onmessage = (evt) => {
    let e;
    try { e = JSON.parse(evt.data); } catch { return; }
    handleEvent(e);
  };
  es.onerror = () => {
    $("#backend-state").textContent = "reconnecting…";
    $("#backend-state").className = "pill";
    setTimeout(() => es.close(), 1000);
    setTimeout(connectSSE, 2000);
  };
}

let refreshTimer = null;
function handleEvent(e) {
  if (e.type === "job-ready" && e.jobName) {
    state.artifacts[e.jobName] = null;
    state.liveText[e.jobName] = {};
    selectJob(e.jobName);
    schedulePullRefresh();
  } else if (e.type === "complete" || e.type === "error" || e.type === "jobs-changed") {
    if (e.job) {
      delete state.liveText[e.job];
      state.artifacts[e.job] = null; // comment-draft.md / final-report.md were just written
    }
    fetchJobs();
    if (state.selected) refreshDetail().then(renderTabs);
    schedulePullRefresh();
  } else if (["stage", "agent-start", "agent-attempt", "agent-done"].includes(e.type)) {
    if (e.type === "agent-start") {
      const b = (state.liveText[e.job] = state.liveText[e.job] || {});
      b[e.key] = { attempt: e.attempt, text: "" };
    } else if (e.type === "agent-attempt" || e.type === "agent-done") {
      const b = state.liveText[e.job];
      if (b) delete b[e.key];
    }
    if (state.selected === e.job) refreshDetail().then(() => renderTabs());
  } else if (e.type === "agent-text") {
    // live streaming: accumulate into the buffer + patch the DOM preview
    if (state.selected === e.job) {
      const b = (state.liveText[e.job] = state.liveText[e.job] || {});
      const cur = b[e.key];
      if (!cur || cur.attempt !== e.attempt) b[e.key] = { attempt: e.attempt, text: e.text || "" };
      else if (e.text) cur.text += e.text;
      streamText(e);
      if (!refreshTimer) {
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          refreshDetail().then(renderTabs);
        }, 1200);
      }
    }
  }
}

function streamText(e) {
  if (!e.text) return;
  document.querySelectorAll(`pre[data-live-agent="${e.key}"]`).forEach((pre) => {
    pre.textContent += e.text;
  });
}

// initial load + periodic refresh (list always; detail while the job is running,
// so CLI-started runs also update without an SSE feed)
fetchJobs().then(() => {
  const params = new URLSearchParams(location.search);
  if (params.get("job")) selectJob(params.get("job"));
});
fetchPulls().then(() => {
  const params = new URLSearchParams(location.search);
  const key = params.get("pull");
  if (key) {
    const p = state.pulls.find((x) => x.key === key);
    if (p) openPullLatest(p);
  }
});
loadModelPicker();
connectSSE();
setInterval(() => {
  fetchJobs();
  const j = state.detail;
  if (j && j.stage && !["complete", "failed", "unknown"].includes(j.stage)) {
    refreshDetail().then(renderTabs);
  }
}, 5000);
// Head/commit state is cached server-side for 60s, so a 30s poll stays cheap.
// The stats page refreshes itself while it's the active view.
//
// Rate care (issue #9): a burst of /api/pulls?live=1 calls trips Bitbucket's
// 429 limiter, so the PR poll must not fire in lockstep across tabs or from
// hidden/background tabs. We therefore jitter the delay (so open tabs drift
// out of phase), skip the fetch while the tab is hidden, and debounce the
// SSE-driven refreshes (below) so one review event ≠ one full refetch.
const PULL_POLL_MS = 30000;
const PULL_POLL_JITTER_MS = 5000;
const SSE_REFRESH_DEBOUNCE_MS = 2000;
let pullPollTimer = null;
let pullRefreshTimer = null;

function pollPullsTick() {
  if (document.visibilityState !== "hidden") {
    fetchPulls({ quiet: true });
    if (state.mode === "stats") fetchStats({ quiet: true });
  }
  const jitter = Math.round(Math.random() * PULL_POLL_JITTER_MS);
  pullPollTimer = setTimeout(pollPullsTick, PULL_POLL_MS + jitter);
}

// SSE-driven refreshes: one review finishing does not mean every PR changed,
// so coalesce the flood of "job-ready"/"complete" events (several arrive per
// review) into a single refresh shortly after — not one full live fetch per
// event per open tab.
function schedulePullRefresh(delayMs = SSE_REFRESH_DEBOUNCE_MS) {
  if (document.visibilityState === "hidden") return;
  if (pullRefreshTimer) return; // one refresh already queued
  pullRefreshTimer = setTimeout(() => {
    pullRefreshTimer = null;
    // Re-check on fire: the tab may have gone hidden while the timer waited.
    if (document.visibilityState === "hidden") return;
    fetchPulls({ quiet: true });
  }, delayMs);
}

// Returning to a tab catches up immediately instead of waiting for the next
// poll tick (the hidden tab skipped its fetches while away).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    fetchPulls({ quiet: true });
    fetchJobs();
  }
});

// Start the first tick after a full cycle (+jitter) — the boot fetchPulls()
// above already covered page load, so firing pollPullsTick() immediately would
// send a second redundant live-fetch burst right away.
pullPollTimer = setTimeout(pollPullsTick, PULL_POLL_MS + Math.round(Math.random() * PULL_POLL_JITTER_MS));

// ---- mode toggle / app filter / refresh ------------------------------------

$("#mode-toggle").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (b) switchMode(b.dataset.mode);
});

// The header Stats button toggles the (full-width) statistics page on/off,
// returning to the PR or Jobs mode that was active before it was opened.
$("#stats-nav").addEventListener("click", () => {
  if (state.mode === "stats") switchMode(state.prevMode || "pulls");
  else {
    state.prevMode = state.mode;
    switchMode("stats");
  }
});

$("#app-filter").addEventListener("change", (e) => {
  state.appFilter = e.target.value;
  renderPulls();
});

// Review-switcher (custom dropdown) inside the job header — rebuilt on every
// render, so clicks are handled by a delegated listener on the header.
$("#job-head").addEventListener("click", (e) => {
  const toggle = e.target.closest("#pull-review-toggle");
  if (toggle) {
    state.pullReviewOpen = !state.pullReviewOpen;
    renderJobHead();
    return;
  }
  const opt = e.target.closest(".review-option");
  if (opt && opt.dataset.job) {
    state.pullReviewOpen = false;
    selectJob(opt.dataset.job); // switch review, same PR context
  }
});

$("#refresh-jobs").addEventListener("click", () => {
  fetchJobs();
  fetchPulls();
});
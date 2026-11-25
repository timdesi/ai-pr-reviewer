import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  pickContextGenModel,
  extractContextMarkdown,
  buildContextGenMessage,
  generateContextDraft,
} from "../src/contextGen.js";
import { ContextEditorError } from "../src/contextsEditor.js";
import { renderAgents } from "../scripts/build-agents.mjs";

function baseConfig(overrides = {}) {
  return {
    projectRoot: "/tmp",
    contextGen: { model: "", timeoutSeconds: 60 },
    models: { consensus: "", reviewerA: "" },
    opencode: { bin: "opencode", standalone: false, agentDir: "/tmp/.opencode" },
    ...overrides,
  };
}

const fakeRunner = (text = "# PROJ / repo — context\n\nbody\n") => async (opts) => ({
  ok: true,
  text,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  durationMs: 123,
  stdout: "",
  stderr: "",
  error: null,
  lastOpts: opts, // inspectable by the test
});

test("pickContextGenModel: CONTEXT_GEN_MODEL → consensus → reviewerA → empty", () => {
  assert.equal(pickContextGenModel(baseConfig({ contextGen: { model: "m/gpt" } })), "m/gpt");
  assert.equal(pickContextGenModel(baseConfig({ models: { consensus: "m/cons", reviewerA: "m/a" } })), "m/cons");
  assert.equal(pickContextGenModel(baseConfig({ models: { consensus: "  ", reviewerA: "m/a" } })), "m/a");
  assert.equal(pickContextGenModel(baseConfig()), "");
});

test("extractContextMarkdown undresses a stray fence but keeps plain text", () => {
  assert.equal(extractContextMarkdown("```md\n# h\n\ntext\n```"), "# h\n\ntext");
  assert.equal(extractContextMarkdown("# h\n\ntext"), "# h\n\ntext");
  assert.equal(extractContextMarkdown("  \n# h\n  \n"), "# h");
  assert.equal(extractContextMarkdown("```\n{x}\n```"), "{x}");
});

test("buildContextGenMessage includes identity, notes, existing, AGENTS.md", () => {
  const msg = buildContextGenMessage({
    project: "PROCON",
    repo: "ppc-main",
    notes: "don't flag the BEN reuse",
    existing: "# old",
    agentsMd: "## AGENTS",
  });
  assert.match(msg, /PROCON\/ppc-main/);
  assert.match(msg, /don't flag the BEN reuse/);
  assert.match(msg, /# old/);
  assert.match(msg, /## AGENTS/);
});

test("generateContextDraft: runs the context-gen agent with repo + notes and returns a cleaned draft", async () => {
  let captured = null;
  const runner = async (opts) => {
    captured = opts;
    return { ok: true, text: "```markdown\n# fresh\n\nfrom the notes\n```", usage: { input: 5 }, durationMs: 50, stdout: "", stderr: "", error: null };
  };
  const config = { ...baseConfig({ models: { consensus: "m/cons", reviewerA: "m/a" } }) };
  const out = await generateContextDraft({ config, project: "ACME", repo: "widgets", notes: "flag X is fine", agentsMd: null, runner });
  assert.equal(out.ok, true);
  assert.equal(out.text, "# fresh\n\nfrom the notes");
  assert.equal(out.model, "m/cons");
  assert.deepEqual(out.usage, { input: 5 });
  // runner contract
  assert.equal(captured.agent, "context-gen");
  assert.equal(captured.model, "m/cons");
  assert.equal(captured.cwd, config.projectRoot);
  assert.equal(captured.timeoutSeconds, 60);
  assert.equal(captured.env.OPENCODE_CONFIG_DIR, config.opencode.agentDir);
  assert.match(captured.message, /ACME\/widgets/);
  assert.match(captured.message, /flag X is fine/);
});

test("generateContextDraft: validation and error mapping", async () => {
  const config = baseConfig({ models: { consensus: "m/cons" } });
  // invalid project/repo → 400
  await assert.rejects(
    generateContextDraft({ config, project: "bad/name", repo: "x", runner: fakeRunner() }),
    (e) => e instanceof ContextEditorError && e.status === 400,
  );
  // no model → 400
  await assert.rejects(
    generateContextDraft({ config: baseConfig(), project: "A", repo: "b", runner: fakeRunner() }),
    (e) => e instanceof ContextEditorError && e.status === 400 && /CONTEXT_GEN_MODEL/.test(e.message),
  );
  // oversized notes → 413
  await assert.rejects(
    generateContextDraft({ config, project: "A", repo: "b", notes: "x".repeat(33 * 1024), runner: fakeRunner() }),
    (e) => e instanceof ContextEditorError && e.status === 413,
  );
  // runner failure → 502
  await assert.rejects(
    generateContextDraft({ config, project: "A", repo: "b", agentsMd: null, runner: async () => ({ ok: false, error: "boom" }) }),
    (e) => e instanceof ContextEditorError && e.status === 502,
  );
  // runner returns empty → 502
  await assert.rejects(
    generateContextDraft({ config, project: "A", repo: "b", agentsMd: null, runner: async () => ({ ok: true, text: "   " }) }),
    (e) => e instanceof ContextEditorError && e.status === 502,
  );
});

test("context-gen agent is built with the deny-all, no-tools posture", () => {
  const agents = renderAgents();
  const file = Object.keys(agents).find((f) => f.endsWith("context-gen.md"));
  assert.ok(file, "context-gen.md is generated");
  const text = agents[file];
  assert.match(text, /^  - action: "\*"[\s\S]*?effect: deny/m, "deny-all rule present");
  assert.doesNotMatch(text, /effect: allow/, "no permission line allows any tool action");
});

// ---- server route integration -----------------------------------------------

import { loadConfig } from "../src/config.js";

test("server POST /api/contexts/generate returns the AI draft (injectable runner)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ctx-gen-srv-"));
  const { createServer } = await import("../src/server.js");
  let server = null;
  let draftArgs = null;
  const prev = {};
  const envKeys = ["BITBUCKET_BASE_URL", "BITBUCKET_API_TOKEN", "REVIEW_CONTEXT_DIR", "PUBLISH_TO_BITBUCKET"];
  for (const k of envKeys) prev[k] = process.env[k];
  try {
    process.env.BITBUCKET_BASE_URL = "https://bb.example.com";
    process.env.BITBUCKET_API_TOKEN = "tok";
    process.env.REVIEW_CONTEXT_DIR = dir;
    process.env.PUBLISH_TO_BITBUCKET = "0";
    const config = loadConfig({ envFile: path.join(dir, ".env") });
    config.contextGen.model = "m/cons"; // deterministic; avoids consensus fallback confusion
    const fakeDraft = async (args) => {
      draftArgs = args;
      return { ok: true, text: "# drafted\n", model: "m/cons", usage: null };
    };
    const created = createServer({ config, port: 0, generateDraft: fakeDraft });
    server = created.server;
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const ok = await fetch(`${base}/api/contexts/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "ACME", repo: "widgets", notes: "false positive: BEN reuse", existing: "" }),
    });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.text, "# drafted\n");
    assert.equal(draftArgs.project, "ACME");
    assert.equal(draftArgs.repo, "widgets");
    assert.equal(draftArgs.notes, "false positive: BEN reuse");
    assert.equal(draftArgs.platform, "bitbucket");

    // The route never saves: the config's contexts dir must remain empty.
    assert.deepEqual(listDir(dir), []);

    // A fake that raises a ContextEditorError maps to its status.
    const created2 = createServer({
      config,
      port: 0,
      generateDraft: async () => {
        throw new ContextEditorError(400, "no model configured");
      },
    });
    const server2 = created2.server;
    await new Promise((r) => server2.listen(0, "127.0.0.1", r));
    const base2 = `http://127.0.0.1:${server2.address().port}`;
    const bad = await fetch(`${base2}/api/contexts/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "ACME", repo: "widgets" }),
    });
    assert.equal(bad.status, 400);
    await new Promise((r) => server2.close(r));
  } finally {
    if (server) await new Promise((r) => server.close(r));
    for (const k of envKeys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// small helper: list a directory
function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

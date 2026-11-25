import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  listContextDocs,
  readContextDoc,
  getRepoContext,
  writeContextDoc,
  writeRepoContext,
  deleteContextDoc,
  safeContextFile,
  validName,
  validProjectRepo,
  resolveRepoContextFile,
  ContextEditorError,
} from "../src/contextsEditor.js";

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "ctx-editor-"));
}

function seed(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text, "utf8");
  }
}

test("safeContextFile: accepts only .md inside the contexts dir", () => {
  const dir = tmpDir();
  assert.equal(safeContextFile(dir, "ACME.md"), path.join(dir, "ACME.md"));
  assert.equal(safeContextFile(dir, "ACME-acme-app.md"), path.join(dir, "ACME-acme-app.md"));
  assert.equal(safeContextFile(dir, "stacks/java-spring.md"), path.join(dir, "stacks/java-spring.md"));
  // rejections
  for (const bad of [
    "../ACME.md",
    "stacks/../ACME.md",
    "/abs/ACME.md",
    "a/b.md", // unknown subdir
    "ACME.txt",
    ".hidden.md",
    "ACME",
    "",
    "stacks/..",
    "ACME.md\0",
  ]) {
    assert.equal(safeContextFile(dir, bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("validName / validProjectRepo: strict slug shapes", () => {
  assert.equal(validName("ACME"), true);
  assert.equal(validName("acme-app"), true);
  assert.equal(validName("repo_2"), true);
  assert.equal(validName("bad/name"), false);
  assert.equal(validName("has space"), false);
  assert.equal(validName(""), false);
  assert.equal(validName(null), false);
  assert.equal(validProjectRepo("ACME", "acme-app"), true);
  assert.equal(validProjectRepo("ACME", "../acme-app"), false);
});

test("readContextDoc: raw text, and exists=false for a missing file", () => {
  const dir = tmpDir();
  writeFileSync(path.join(dir, "ACME.md"), "# header\n\nbody\n", "utf8");
  const got = readContextDoc(dir, "ACME.md");
  assert.equal(got.exists, true);
  assert.equal(got.text, "# header\n\nbody\n");
  const missing = readContextDoc(dir, "ACME-nope.md");
  assert.equal(missing.exists, false);
  assert.equal(missing.text, "");
  assert.equal(missing.file, "ACME-nope.md");
  assert.throws(() => readContextDoc(dir, "../ACME.md"), (e) => e instanceof ContextEditorError && e.status === 400);
});

test("resolveRepoContextFile: <PROJECT>-<repo>.md wins, <repo>.md fallback, create-target on miss", () => {
  const dir = tmpDir();
  seed(dir, { "acme-app.md": "# fallback" });
  assert.equal(resolveRepoContextFile(dir, "ACME", "acme-app"), "acme-app.md");
  seed(dir, { "ACME-acme-app.md": "# specific" });
  assert.equal(resolveRepoContextFile(dir, "ACME", "acme-app"), "ACME-acme-app.md");
  assert.equal(resolveRepoContextFile(dir, "ACME", "widgets"), "ACME-widgets.md");
  assert.equal(resolveRepoContextFile(dir, "bad/name", "x"), null);
});

test("getRepoContext: reads per-repo context with fallback handling", () => {
  const dir = tmpDir();
  seed(dir, { "ACME-acme-app.md": "# specific\n" });
  const specific = getRepoContext(dir, "ACME", "acme-app");
  assert.deepEqual({ file: specific.file, exists: specific.exists }, { file: "ACME-acme-app.md", exists: true });
  assert.equal(specific.text, "# specific\n");
  // fallback: a different project whose <repo>.md fallback exists and whose
  // <PROJECT>-<repo>.md does NOT (the specific file above is for ACME only)
  seed(dir, { "acme-app.md": "# fallback\n" });
  const fb = getRepoContext(dir, "GAIA", "acme-app");
  assert.deepEqual({ file: fb.file, exists: fb.exists }, { file: "acme-app.md", exists: true });
  assert.equal(fb.text, "# fallback\n");
  // missing → create-target name, exists=false
  const missing = getRepoContext(dir, "ACME", "widgets");
  assert.deepEqual({ file: missing.file, exists: missing.exists, text: missing.text }, { file: "ACME-widgets.md", exists: false, text: "" });
  // invalid names → 400
  assert.throws(() => getRepoContext(dir, "bad name", "x"), (e) => e instanceof ContextEditorError && e.status === 400);
});

test("writeContextDoc: atomic create/overwrite, creates stacks/ on demand", () => {
  const dir = tmpDir();
  const r = writeContextDoc(dir, { file: "ACME-acme-app.md", text: "# v1\n" });
  assert.deepEqual(r, { ok: true, file: "ACME-acme-app.md" });
  assert.equal(readFileSync(path.join(dir, "ACME-acme-app.md"), "utf8"), "# v1\n");
  // overwrite
  writeContextDoc(dir, { file: "ACME-acme-app.md", text: "# v2\n" });
  assert.equal(readFileSync(path.join(dir, "ACME-acme-app.md"), "utf8"), "# v2\n");
  // nested stacks dir is created
  writeContextDoc(dir, { file: "stacks/java-spring.md", text: "---\nmatch: [\"*/.java\"]\n---\n" });
  assert.equal(readFileSync(path.join(dir, "stacks/java-spring.md"), "utf8"), "---\nmatch: [\"*/.java\"]\n---\n");
  // no temp files left behind (atomic write cleans up after itself)
  const entries = readdirSync(dir).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(entries, []);
  // invalid names rejected
  assert.throws(() => writeContextDoc(dir, { file: "../x.md", text: "nope" }), (e) => e instanceof ContextEditorError && e.status === 400);
});

test("writeRepoContext: resolve-or-create keeps the fallback file when present", () => {
  const dir = tmpDir();
  seed(dir, { "acme-app.md": "# old\n" });
  writeRepoContext(dir, { project: "ACME", repo: "acme-app", text: "# updated\n" });
  assert.equal(readFileSync(path.join(dir, "acme-app.md"), "utf8"), "# updated\n", "updates the existing fallback file");
  assert.equal(existsSync(path.join(dir, "ACME-acme-app.md")), false, "no duplicate created");
  // absent → creates <PROJECT>-<repo>.md
  writeRepoContext(dir, { project: "ACME", repo: "widgets", text: "# new\n" });
  assert.equal(readFileSync(path.join(dir, "ACME-widgets.md"), "utf8"), "# new\n");
  assert.throws(() => writeRepoContext(dir, { project: "bad name", repo: "x", text: "nope" }), (e) => e.status === 400);
});

test("writeContextDoc: caps oversized files (413)", () => {
  const dir = tmpDir();
  const big = "x".repeat(600 * 1024);
  assert.throws(() => writeContextDoc(dir, { file: "ACME.md", text: big }), (e) => e instanceof ContextEditorError && e.status === 413);
});

test("deleteContextDoc: removes the file, 404 when missing, 400 on unsafe name", () => {
  const dir = tmpDir();
  writeFileSync(path.join(dir, "ACME.md"), "x", "utf8");
  assert.deepEqual(deleteContextDoc(dir, "ACME.md"), { ok: true, file: "ACME.md" });
  assert.equal(existsSync(path.join(dir, "ACME.md")), false);
  assert.throws(() => deleteContextDoc(dir, "ACME.md"), (e) => e instanceof ContextEditorError && e.status === 404);
  assert.throws(() => deleteContextDoc(dir, "../ACME.md"), (e) => e instanceof ContextEditorError && e.status === 400);
});

test("listContextDocs: classifies project-wide, per-repo and stacks", () => {
  const dir = tmpDir();
  seed(dir, {
    "ACME.md": "# project\n",
    "ACME-acme-app.md": "# repo\n",
    "ACME-acme-api-performance-tests.md": "# repo2\n",
    "acme-app.md": "# fallback-only repo\n",
    "stacks/java-spring.md": "---\nmatch: [\"**/*.java\"]\n---\n# java\n",
    "stacks/angular.md": "# no front matter yet\n",
  });
  const l = listContextDocs(dir);
  assert.equal(l.dir, dir);
  const byName = Object.fromEntries(l.top.map((t) => [t.name, t]));
  assert.equal(byName["ACME"].kind, "project");
  assert.equal(byName["ACME"].project, "ACME");
  assert.deepEqual(byName["ACME-acme-app"].kind, "repo");
  assert.deepEqual(byName["ACME-acme-app"].project, "ACME");
  assert.deepEqual(byName["ACME-acme-app"].repo, "acme-app");
  assert.deepEqual(byName["ACME-acme-api-performance-tests"].repo, "acme-api-performance-tests");
  assert.equal(byName["acme-app"].kind, "file", "fallback-only repo file stays generic");
  assert.deepEqual(
    l.stacks.map((s) => [s.name, s.match]),
    [
      ["angular", null],
      ["java-spring", ["**/*.java"]],
    ],
    "stacks sorted with parsed match front matter",
  );
});

test("listContextDocs: missing dir → empty listing, never an error", () => {
  const dir = path.join(tmpDir(), "does-not-exist");
  const l = listContextDocs(dir);
  assert.deepEqual(l, { dir, stacks: [], top: [] });
});

// ---- server API integration -------------------------------------------------

import { loadConfig } from "../src/config.js";

function tmpEnvFile() {
  return path.join(tmpDir(), ".env");
}

test("server /api/contexts*: list, read, create, update, delete with strict validation", async () => {
  const dir = tmpDir();
  seed(dir, {
    "ACME.md": "# project\n",
    "ACME-acme-app.md": "# existing\n",
  });
  const { createServer } = await import("../src/server.js");
  let server = null;
  const prev = {};
  const envKeys = ["BITBUCKET_BASE_URL", "BITBUCKET_API_TOKEN", "REVIEW_CONTEXT_DIR", "PUBLISH_TO_BITBUCKET"];
  for (const k of envKeys) prev[k] = process.env[k];
  try {
    process.env.BITBUCKET_BASE_URL = "https://bb.example.com";
    process.env.BITBUCKET_API_TOKEN = "tok";
    process.env.REVIEW_CONTEXT_DIR = dir;
    process.env.PUBLISH_TO_BITBUCKET = "0";
    const config = loadConfig({ envFile: tmpEnvFile() });
    assert.equal(config.dirs.contexts, dir);
    const created = createServer({ config, port: 0 });
    server = created.server;
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // list
    const list = await (await fetch(`${base}/api/contexts`)).json();
    assert.equal(list.dir, dir);
    assert.deepEqual(list.top.map((t) => [t.name, t.kind]), [
      ["ACME-acme-app", "repo"],
      ["ACME", "project"],
    ]);

    // read a doc
    const got = await (await fetch(`${base}/api/contexts/doc?file=${encodeURIComponent("ACME.md")}`)).json();
    assert.equal(got.exists, true);
    assert.equal(got.text, "# project\n");

    // read missing doc → exists:false, not an error
    const miss = await (await fetch(`${base}/api/contexts/doc?file=${encodeURIComponent("ACME-widgets.md")}`)).json();
    assert.equal(miss.exists, false);

    // traversal → 400
    const trav = await fetch(`${base}/api/contexts/doc?file=${encodeURIComponent("../secret.md")}`);
    assert.equal(trav.status, 400);

    // create a new per-repo via the repo endpoint
    const creat = await fetch(`${base}/api/contexts/repo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "ACME", repo: "widgets", text: "# fresh\n" }),
    });
    assert.equal(creat.status, 200);
    assert.equal(readFileSync(path.join(dir, "ACME-widgets.md"), "utf8"), "# fresh\n");

    // update an existing doc via the file endpoint
    const upd = await fetch(`${base}/api/contexts/doc`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "ACME-acme-app.md", text: "# updated\n" }),
    });
    assert.equal(upd.status, 200);
    assert.equal(readFileSync(path.join(dir, "ACME-acme-app.md"), "utf8"), "# updated\n");

    // invalid project/repo → 400
    const bad = await fetch(`${base}/api/contexts/repo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "bad name", repo: "x", text: "nope" }),
    });
    assert.equal(bad.status, 400);

    // delete → file is gone; deleting again → 404
    const del = await fetch(`${base}/api/contexts/doc?file=${encodeURIComponent("ACME-widgets.md")}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal(existsSync(path.join(dir, "ACME-widgets.md")), false);
    const del2 = await fetch(`${base}/api/contexts/doc?file=${encodeURIComponent("ACME-widgets.md")}`, { method: "DELETE" });
    assert.equal(del2.status, 404);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    for (const k of envKeys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

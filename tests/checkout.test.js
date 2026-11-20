import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { scmUrl, prepareCheckout, cleanupCheckout, maintainBare, evictWorkspace, packCount } from "../src/checkout.js";

const ref = { projectKey: "ACME", repoSlug: "acme-app", prId: 1 };

function tempDir(prefix = "ckx-test-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${r.status}: ${(r.stderr || "").trim().slice(0, 300)}`);
  }
  return r.stdout.trim();
}

/** Build a tiny source repo pushed into a local bare "remote". */
function makeRemote() {
  const src = tempDir();
  git(src, ["init", "-b", "main"]);
  writeFileSync(path.join(src, "a.txt"), "v1");
  git(src, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
  git(src, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c1"]);
  const sha1 = git(src, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(src, "a.txt"), "v2");
  git(src, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
  git(src, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c2"]);
  const sha2 = git(src, ["rev-parse", "HEAD"]);
  const remote = tempDir("ckx-remote-");
  rmSync(remote, { recursive: true });
  gitIn(tmpdir(), ["clone", "--bare", src, remote]);
  rmSync(src, { recursive: true, force: true });
  return { remote, sha1, sha2 };
}

function gitIn(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${r.status}: ${(r.stderr || "").trim().slice(0, 300)}`);
  }
  return r.stdout.trim();
}

function baseConfig(overrides = {}) {
  const workspaceRoot = tempDir();
  return {
    checkout: { enabled: true, keep: 2 },
    bitbucket: { baseUrl: "https://example.com", token: "tok", verifyTls: false },
    dirs: { workspaceRoot },
    ...overrides,
  };
}

test("scmUrl builds the Bitbucket DC git URL (lowercased)", () => {
  assert.equal(
    scmUrl({ baseUrl: "https://bitbucket.example.com", projectKey: "ACME", repoSlug: "acme-app" }),
    "https://bitbucket.example.com/scm/acme/acme-app.git",
  );
});

test("prepareCheckout is a no-op when disabled", async () => {
  const config = baseConfig({ checkout: { enabled: false, keep: 2 } });
  const res = await prepareCheckout({ config, ref, sha: "abc", branch: "main", origin: "/x" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "disabled");
});

test("prepareCheckout checks out the exact reviewed SHA (v2) into the worktree", async () => {
  const { remote, sha2 } = makeRemote();
  const config = baseConfig();
  const res = await prepareCheckout({ config, ref, sha: sha2, branch: "main", origin: remote });
  assert.equal(res.ok, true, res.reason);
  assert.ok(path.basename(res.dir).includes(sha2.slice(0, 8)), `dir ${res.dir} should be named by sha8`);
  assert.equal(readFileSync(path.join(res.dir, "a.txt"), "utf8"), "v2");
});

test("prepareCheckout reuses an existing worktree for the same SHA", async () => {
  const { remote, sha2 } = makeRemote();
  const config = baseConfig();
  const r1 = await prepareCheckout({ config, ref, sha: sha2, branch: "main", origin: remote });
  const r2 = await prepareCheckout({ config, ref, sha: sha2, branch: "main", origin: remote });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r2.dir, r1.dir);
  assert.equal(readFileSync(path.join(r2.dir, "a.txt"), "utf8"), "v2");
});

test("prepareCheckout fails non-fatally for an unknown SHA", async () => {
  const { remote } = makeRemote();
  const config = baseConfig();
  const res = await prepareCheckout({
    config,
    ref,
    sha: "0000000000000000000000000000000000000000",
    branch: "main",
    origin: remote,
  });
  assert.equal(res.ok, false);
  assert.ok(typeof res.reason === "string" && res.reason.length > 0);
});

test("prepareCheckout creates the workspace root when it does not yet exist (pod scenario)", async () => {
  const { remote, sha2 } = makeRemote();
  const workspaceRoot = path.join(tempDir(), "data", "workspaces"); // NOT created
  const config = { checkout: { enabled: true, keep: 2 }, bitbucket: { baseUrl: "https://example.com", token: "tok", verifyTls: false }, dirs: { workspaceRoot } };
  const res = await prepareCheckout({ config, ref, sha: sha2, branch: "main", origin: remote });
  assert.equal(res.ok, true, res.reason);
  assert.ok(existsSync(workspaceRoot), "workspace root must be created");
  assert.ok(existsSync(res.dir), "worktree must exist");
  assert.equal(readFileSync(path.join(res.dir, "a.txt"), "utf8"), "v2");
});

test("worktrees are pruned to CHECKOUT_KEEP (older SHA removed)", async () => {
  const { remote, sha1, sha2 } = makeRemote();
  const config = baseConfig({ checkout: { enabled: true, keep: 1 } });
  const r1 = await prepareCheckout({ config, ref, sha: sha1, branch: "main", origin: remote });
  const r2 = await prepareCheckout({ config, ref, sha: sha2, branch: "main", origin: remote });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.ok(existsSync(r2.dir), "newest worktree must survive pruning");
  assert.ok(!existsSync(r1.dir), "oldest worktree must be pruned with keep=1");
});

test("workspace disk maintenance: git gc packs loose objects and keeps the SHA reachable (issue #11)", async () => {
  const { remote, sha1 } = makeRemote();
  const config = baseConfig();
  const res = await prepareCheckout({ config, ref, sha: sha1, branch: "main", origin: remote });
  assert.equal(res.ok, true, res.reason);
  // A tiny local remote arrives as *loose* objects (under git's unpack limit).
  const looseBefore = countLoose(res.bare);
  assert.ok(looseBefore > 0, `expect loose objects before gc (got ${looseBefore})`);
  // packs:0 = every call maintains. Production gates this at CHECKOUT_GC_PACKS.
  await maintainBare(res.bare, { packs: 0 });
  assert.ok(countLoose(res.bare) < looseBefore, "gc packed the loose objects");
  const chk = spawnSync("git", ["--git-dir", res.bare, "cat-file", "-e", `${sha1}^{commit}`], { encoding: "utf8" });
  assert.equal(chk.status, 0, "reviewed SHA still resolvable after gc");
});

function countLoose(bare) {
  const r = spawnSync("git", ["--git-dir", bare, "count-objects", "-v"], { encoding: "utf8" });
  const m = /^\s*count:\s*(\d+)$/m.exec(r.stdout || "");
  return m ? Number(m[1]) : 0;
}

test("workspace disk maintenance: LRU eviction frees space but keeps the active repo (issue #11)", async () => {
  const { remote, sha1 } = makeRemote();
  const config = baseConfig();
  const res = await prepareCheckout({ config, ref, sha: sha1, branch: "main", origin: remote });
  assert.equal(res.ok, true, res.reason);

  // Two additional bare repos that should be evicted first (the active one is
  // protected by keepBare).
  const otherA = path.join(config.dirs.workspaceRoot, "acme-other-a.git");
  const otherB = path.join(config.dirs.workspaceRoot, "acme-other-b.git");
  for (const d of [otherA, otherB]) gitIn(config.dirs.workspaceRoot, ["init", "--bare", d]);
  // Age A and B so LRU picks them (not the just-fetched active repo).
  for (const d of [otherA, otherB]) {
    const past = new Date(Date.now() - 600_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(d, past, past);
  }

  const freed = await evictWorkspace({
    workspaceRoot: config.dirs.workspaceRoot,
    workspaceMaxBytes: 1, // absurdly small budget → evict everything evictable
    keepBare: res.bare,
  });
  assert.ok(freed > 0, "budget eviction freed bytes");
  assert.ok(!existsSync(otherA), "oldest dummy bare repo evicted");
  assert.ok(!existsSync(otherB), "second dummy bare repo evicted");
  assert.ok(existsSync(res.bare), "active bare repo NOT evicted");
  assert.ok(existsSync(res.dir), "active worktree NOT evicted");
});

test("eviction removes only the evicted repo's worktree: name-prefix sibling survives (PR #12 HIGH)", async () => {
  // Two repos in the same workspace where one slug is a prefix of the other —
  // the exact shape prefix-based eviction got wrong (sibling repos such as
  // `planning` vs `planning-gateway`, which both live in production). Evicting
  // `acme-app` must not remove `acme-app-toolkit`'s worktree, or its bare.
  const shortRemote = makeRemote();
  const longRemote = makeRemote();
  const config = baseConfig({ dirs: { workspaceRoot: tempDir() } });
  const refShort = { projectKey: "ACME", repoSlug: "acme-app", prId: 1 };
  const refLong = { projectKey: "ACME", repoSlug: "acme-app-toolkit", prId: 2 };

  const rShort = await prepareCheckout({ config, ref: refShort, sha: shortRemote.sha1, branch: "main", origin: shortRemote.remote });
  const rLong = await prepareCheckout({ config, ref: refLong, sha: longRemote.sha1, branch: "main", origin: longRemote.remote });
  assert.equal(rShort.ok, true, rShort.reason);
  assert.equal(rLong.ok, true, rLong.reason);
  assert.ok(existsSync(rShort.dir), "short repo worktree present before eviction");
  assert.ok(existsSync(rLong.dir), "long (prefix-extension) repo worktree present before eviction");

  // Simulate both reviews having finished (the real finally calls cleanupCheckout)
  // so neither is in the active-protection set and eviction may reclaim the old one.
  await cleanupCheckout({ config, ref: refShort });
  await cleanupCheckout({ config, ref: refLong });

  // Age the short repo so LRU evicts it first; keepBare protects the long one.
  const { utimesSync } = await import("node:fs");
  const past = new Date(Date.now() - 600_000);
  utimesSync(rShort.bare, past, past);

  const freed = await evictWorkspace({
    workspaceRoot: config.dirs.workspaceRoot,
    workspaceMaxBytes: 1,
    keepBare: rLong.bare,
  });
  assert.ok(freed > 0, "eviction freed bytes");
  assert.ok(!existsSync(rShort.bare), "evicted repo's bare removed");
  assert.ok(!existsSync(rShort.dir), "evicted repo's own worktree removed");
  assert.ok(existsSync(rLong.bare), "prefix-extension sibling's bare NOT evicted");
  assert.ok(existsSync(rLong.dir), "prefix-extension sibling's worktree NOT evicted");
});

test("active review checkout is protected from eviction until cleanup (PR #12 MEDIUM)", async () => {
  const { remote, sha1 } = makeRemote();
  const config = baseConfig();
  const res = await prepareCheckout({ config, ref, sha: sha1, branch: "main", origin: remote });
  assert.equal(res.ok, true, res.reason);

  // Age it so plain LRU would pick it first — but the checkout is in the active
  // set, so even an emergency reclaim that doesn't pass keepBare must skip it.
  const { utimesSync } = await import("node:fs");
  const past = new Date(Date.now() - 600_000);
  utimesSync(res.bare, past, past);

  const freed = await evictWorkspace({
    workspaceRoot: config.dirs.workspaceRoot,
    workspaceMaxBytes: 1,
    keepBare: null, // no active repo hint — protection comes from the set
  });
  assert.equal(freed, 0, "active review repo must not be evicted");
  assert.ok(existsSync(res.bare), "active bare protected while review runs");
  assert.ok(existsSync(res.dir), "active worktree protected while review runs");

  // Once the review finishes (finally → cleanupCheckout), eviction may reclaim.
  await cleanupCheckout({ config, ref });
  const freedAfter = await evictWorkspace({
    workspaceRoot: config.dirs.workspaceRoot,
    workspaceMaxBytes: 1,
    keepBare: null,
  });
  assert.ok(freedAfter > 0, "repo becomes evictable after cleanupCheckout");
  assert.ok(!existsSync(res.bare), "bare reclaimed after review done");
});

test("overlapping reviews on the same repo stay protected until the last one finishes (PR #12 MEDIUM)", async () => {
  const { remote, sha1, sha2 } = makeRemote();
  const config = baseConfig();
  // Two concurrent reviews of the same repo — the lock is per-repo but only
  // covers the fetch/worktree phase, so both checkouts can be live at once.
  const r1 = await prepareCheckout({ config, ref, sha: sha1, branch: "main", origin: remote });
  const r2 = await prepareCheckout({ config, ref, sha: sha2, branch: "main", origin: remote });
  assert.equal(r1.ok, true, r1.reason);
  assert.equal(r2.ok, true, r2.reason);
  assert.notEqual(r1.dir, r2.dir, "each review gets its own worktree");

  // First review finishes — the shared repo must stay protected for the second.
  await cleanupCheckout({ config, ref });
  const freed = await evictWorkspace({
    workspaceRoot: config.dirs.workspaceRoot,
    workspaceMaxBytes: 1,
    keepBare: null,
  });
  assert.equal(freed, 0, "repo stays protected while the second review runs");
  assert.ok(existsSync(r2.dir), "second review's worktree intact");

  // Second review finishes — with the last ref released, eviction may reclaim.
  await cleanupCheckout({ config, ref });
  const freedAfter = await evictWorkspace({
    workspaceRoot: config.dirs.workspaceRoot,
    workspaceMaxBytes: 1,
    keepBare: null,
  });
  assert.ok(freedAfter > 0, "repo evictable once the last review finished");
});

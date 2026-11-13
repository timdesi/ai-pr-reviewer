import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { scmUrl, prepareCheckout } from "../src/checkout.js";

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

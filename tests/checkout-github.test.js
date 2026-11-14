// Checkout for GitHub refs (src/checkout.js): the clone URL is the GitHub
// host (github.com or GHES), and prepareCheckout routes to the `github:` config
// block without touching the Bitbucket path (which its own tests cover).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { scmUrl, prepareCheckout } from "../src/checkout.js";

const ghRef = { projectKey: "acme", repoSlug: "widgets", prId: 42, platform: "github" };

function tempDir(prefix = "ckxgh-test-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${r.status}: ${(r.stderr || "").trim().slice(0, 300)}`);
  }
  return r.stdout.trim();
}

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
  const remote = tempDir("ckxgh-remote-");
  rmSync(remote, { recursive: true });
  git(tmpdir(), ["clone", "--bare", src, remote]);
  rmSync(src, { recursive: true, force: true });
  return { remote, sha1, sha2 };
}

function baseConfig(overrides = {}) {
  const workspaceRoot = tempDir();
  return {
    checkout: { enabled: true, keep: 2 },
    github: { baseUrl: "https://api.github.com", token: "tok", verifyTls: false },
    dirs: { workspaceRoot },
    ...overrides,
  };
}

test("scmUrl builds the github.com clone URL (owner/repo preserved)", () => {
  assert.equal(
    scmUrl({ baseUrl: "https://api.github.com", projectKey: "acme", repoSlug: "widgets", platform: "github" }),
    "https://github.com/acme/widgets.git",
  );
});

test("scmUrl builds a GitHub Enterprise Server clone URL from its API base", () => {
  assert.equal(
    scmUrl({ baseUrl: "https://ghe.example.com/api/v3", projectKey: "acme", repoSlug: "widgets", platform: "github" }),
    "https://ghe.example.com/acme/widgets.git",
  );
});

test("scmUrl keeps the Bitbucket layout when platform is not github", () => {
  assert.equal(
    scmUrl({ baseUrl: "https://bitbucket.example.com", projectKey: "ACME", repoSlug: "acme-app" }),
    "https://bitbucket.example.com/scm/acme/acme-app.git",
  );
});

test("prepareCheckout fetches a GitHub ref through the github config into a worktree", async () => {
  const { remote, sha2 } = makeRemote();
  const config = baseConfig();
  const res = await prepareCheckout({ config, ref: ghRef, sha: sha2, branch: "main", origin: remote });
  assert.equal(res.ok, true, res.reason);
  assert.ok(path.basename(res.dir).includes(sha2.slice(0, 8)), `dir ${res.dir} should be named by sha8`);
  // The worked tree holds the reviewed commit (v2); `.git` is a gitlink to the
  // bare repo (a linked worktree), so no direct HEAD read here.
  assert.equal(readFileSync(path.join(res.dir, "a.txt"), "utf8"), "v2");
  assert.ok(existsSync(path.join(res.dir, ".git")), "linked worktree has a .git gitlink");
});

test("prepareCheckout refuses a GitHub ref when no github backend is configured", async () => {
  const { remote, sha2 } = makeRemote();
  // Bitbucket-only config: a github ref must not silently clone from Bitbucket.
  const config = { checkout: { enabled: true, keep: 2 }, bitbucket: { baseUrl: "https://bb.example.com", token: "t", verifyTls: false }, dirs: { workspaceRoot: tempDir() } };
  const res = await prepareCheckout({ config, ref: ghRef, sha: sha2, branch: "main", origin: remote });
  assert.equal(res.ok, false);
  assert.match(res.reason, /github backend not configured/);
});

test("prepareCheckout is hermetic: the bare repo and lock are keyed by owner/repo", async () => {
  const { remote, sha2 } = makeRemote();
  const config = baseConfig();
  const res = await prepareCheckout({ config, ref: ghRef, sha: sha2, branch: "main", origin: remote });
  assert.equal(res.ok, true, res.reason);
  const bare = path.join(config.dirs.workspaceRoot, "acme-widgets.git");
  assert.ok(existsSync(path.join(bare, "HEAD")), `bare repo should exist at ${bare}`);
});

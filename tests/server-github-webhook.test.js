// HTTP-level tests for the GitHub webhook endpoint security gates in
// server.js: the empty-secret guard (403), the unsigned ping short-circuit
// (200), signature rejection (401), and a valid signature (200). These sit
// *in front of* parseGitHubWebhookRequest, so the unit tests cannot cover
// them — a regression here would open an unauthenticated review trigger.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createServer } from "../src/server.js";

const API = "https://api.github.com";
const SECRET = "s3cret";

const GH = {
  baseUrl: API,
  token: "t",
  username: "",
  webhookSecret: SECRET,
};

function baseConfig(overrides = {}) {
  return {
    projectRoot: process.cwd(),
    server: { host: "127.0.0.1", port: 0 },
    costs: {},
    models: {},
    review: { fetchPrDiscussion: false, visionModel: null },
    job: {
      dryRun: true,
      publishToGithub: false,
      allowedReviewerUsers: [],
      githubAutoReviewOffRepos: new Set(),
      reviewOnReviewerAddedSkip: [],
    },
    dirs: { jobs: mkdtempSync(path.join(tmpdir(), "gh-webhook-")) },
    github: { ...GH },
    // Bitbucket left unconfigured: assertAnyBackendConfig passes via github.
    ...overrides,
  };
}

const hmac = (raw) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

/** Boot an ephemeral server for one test; runs `fn(port)` and closes it. */
async function withServer(config, fn) {
  const { server } = createServer({ config });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const pingBody = JSON.stringify({ zen: "…", hook_id: 1 });
const benignBody = JSON.stringify({
  action: "closed",
  sender: { login: "alice" },
  repository: { name: "widgets", full_name: "acme/widgets", owner: { login: "acme" } },
  pull_request: { number: 42 },
});

test("an empty GITHUB_WEBHOOK_SECRET disables the endpoint (403, fail closed)", async () => {
  const config = baseConfig({ github: { ...GH, webhookSecret: "" } });
  await withServer(config, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: { "x-github-event": "ping", "content-type": "application/json" },
      body: pingBody,
    });
    assert.equal(res.status, 403);
  });
});

test("unsigned ping is acknowledged without a signature (200)", async () => {
  await withServer(baseConfig(), async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: { "x-github-event": "ping", "content-type": "application/json" },
      body: pingBody,
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ignored, "ping");
  });
});

test("a non-ping delivery without a signature is rejected (401)", async () => {
  await withServer(baseConfig(), async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: { "x-github-event": "pull_request", "content-type": "application/json" },
      body: benignBody,
    });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /missing X-Hub-Signature/i);
  });
});

test("a wrong signature is rejected (401)", async () => {
  await withServer(baseConfig(), async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": hmac(pingBody).replace(/^sha256/, "sha256x"), // not the body's hash
        "content-type": "application/json",
      },
      body: benignBody,
    });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /signature mismatch/i);
  });
});

test("a valid signature on a non-trigger event is accepted (200) and ignored", async () => {
  await withServer(baseConfig(), async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": hmac(benignBody),
        "content-type": "application/json",
      },
      body: benignBody,
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.match(j.ignored || "", /closed|not a review trigger/i);
  });
});

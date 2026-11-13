// Container entrypoint.
//
// 1. Materializes $HOME/.config/opencode/opencode.json from
//    /app/docker/opencode.json.template, substituting {{ENV_VAR}} placeholders
//    so secrets never end up in the image. Fails loudly on unset required
//    vars.
// 2. Unless OPENCODE_STANDALONE=1, starts the opencode background service
//    (`opencode serve --service`) and waits for it to listen. Reviewer runs in
//    non-standalone mode (`opencode run` without --standalone) attach to this
//    service; without it every run fails with `provider.no-route` because no
//    server has the configured providers/models registered.
// 3. Hands over to src/server.js (same process, stdio inherited).
//
// `node /app/docker/entrypoint.mjs --seed-only` only writes the config and
// exits (used to pre-warm a build-time cache if ever needed).

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const home = process.env.HOME || "/app";
const configDir = path.join(home, ".config", "opencode");
const outPath = path.join(configDir, "opencode.json");
const templatePath = "/app/docker/opencode.json.template";

// DiscreteStack (`myprovider`) was retired and removed from the template, so
// there are no secret-bearing placeholders left to require. Keep the loop for
// any future required envs.
const required = [];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`entrypoint: missing required env ${name}`);
    process.exit(1);
  }
}

mkdirSync(configDir, { recursive: true });
const template = readFileSync(templatePath, "utf8");
const config = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name) => {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`entrypoint: template references undefined env ${name}`);
  }
  return value;
});
writeFileSync(outPath, config);
console.log(`entrypoint: wrote ${outPath}`);

if (process.argv.includes("--seed-only")) process.exit(0);

// ---------------------------------------------------------------------------
// opencode background service (needed when running non-standalone)
// ---------------------------------------------------------------------------
const standalone = process.env.OPENCODE_STANDALONE === "1";

function defaultServePort() {
  // The CLI's default background-service port when none is configured
  // (matches the ``opencode service status`` output).
  return 49374;
}

function waitForListen(port, timeoutMs = 120_000, host = "127.0.0.1") {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      if (Date.now() > deadline) return reject(new Error(`opencode serve did not listen on ${host}:${port} within ${timeoutMs}ms`));
      const sock = net.connect({ host, port });
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        setTimeout(probe, 500);
      });
    };
    probe();
  });
}

async function startOpenCodeService() {
  const bin = process.env.OPENCODE_BIN || "opencode";
  let earlyExit = false;
  const child = spawn(bin, ["serve", "--service"], {
    cwd: "/app",
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.once("exit", (code) => {
    earlyExit = true;
    console.error(`entrypoint: ${bin} serve --service exited early (code ${code})`);
  });
  child.unref();
  console.log(`entrypoint: started ${bin} serve --service (pid ${child.pid})`);
  // Fail fast if the service crashes before listening; otherwise wait (up to
  // 120s) for the port to come up.
  const deadline = Date.now() + 120_000;
  while (!earlyExit) {
    const listening = await waitForListen(defaultServePort(), 1500).then(
      () => true,
      () => false,
    );
    if (listening) {
      console.log("entrypoint: opencode service is listening");
      return;
    }
    if (Date.now() > deadline) break;
  }
  if (earlyExit) throw new Error(`${bin} serve --service exited before listening`);
  throw new Error(`${bin} serve --service did not listen on 127.0.0.1:${defaultServePort()} within 120s`);
}

if (!standalone) {
  try {
    await startOpenCodeService();
  } catch (err) {
    console.error(`entrypoint: failed to start opencode service: ${err.message}`);
    console.error("entrypoint: reviewer runs in non-standalone mode will fail with provider.no-route");
    // Do not crash the app server — but surface loudly in logs.
  }
} else {
  console.log("entrypoint: OPENCODE_STANDALONE=1, no background service needed");
}

const child = spawn(process.execPath, ["src/server.js"], {
  cwd: "/app",
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
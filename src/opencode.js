// Run an OpenCode agent non-interactively and return its final text.
//
// We use `opencode run --format json`, which streams JSONL events. We collect
// every assistant `text` part in order and join them; the reviewer/consensus
// agents are instructed to end their final message with a single JSON object.

import { spawn } from "node:child_process";

// Standalone `opencode run` boots a private server per process. When several
// such boots happen at the exact same instant (e.g. the reviewer agents start
// in parallel), the loser can lose a startup race and exit before reporting
// readiness — the retry then masks it. We dephase the boots with a fixed short
// stagger: each standalone run waits until the one before it has had its
// STAGGER to boot, then starts. This is time-based only — later runs never wait
// on the current run's first output (which could take minutes on a slow model).
// If a run's server dies during boot, its slot is released immediately so the
// successors are not delayed. The long model-call phase still runs fully
// parallel after the initial ~STAGGER spacing.
const STANDALONE_BOOT_STAGGER_MS = 2000;
let standaloneBootTail = Promise.resolve();

// Resolves once it is this run's turn to boot; the returned function releases
// the slot (idempotent) and lets the next queued run start.
export async function acquireStandaloneBootSlot() {
  const prev = standaloneBootTail;
  let release;
  const gate = new Promise((r) => (release = r));
  standaloneBootTail = gate;
  await prev;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

export function parseJsonl(stdout) {
  const texts = [];
  let sessionId = null;
  let toolCalls = 0;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (evt.sessionID) sessionId = evt.sessionID;
    if (evt.type === "text" && evt.part?.type === "text" && typeof evt.part.text === "string") {
      texts.push(evt.part.text);
    }
    // Tool-call accounting. opencode's JSON stream marks each agent tool step
    // with a `step_finish` event whose part says `reason: "tool-calls"` (the
    // shape seen on the pod), and may also emit bare `type: "tool"` parts.
    // Best-effort: count what we recognize, never fail on an unfamiliar shape.
    if (
      (evt.type === "step_finish" && evt.part?.type === "step-finish" && evt.part.reason === "tool-calls") ||
      evt.part?.type === "tool"
    ) {
      toolCalls++;
    }
    // Token usage rides on assistant parts. opencode versions differ in where
    // they put it: some emit a top-level `tokens`, others nest it inside the
    // step-finish `part` (and a few inside `step`). `tokens` is per-request
    // (input = fresh tokens, cache separately broken out), so summing the
    // deltas gives the whole-session usage — including every cache re-read,
    // which is what providers actually bill.
    const toks = evt.tokens || (evt.part && evt.part.tokens) || (evt.step && evt.step.tokens);
    if (toks && typeof toks === "object") {
      usage.input += Number(toks.input) || 0;
      usage.output += Number(toks.output) || 0;
      usage.cacheRead += Number(toks.cache?.read) || 0;
      usage.cacheWrite += Number(toks.cache?.write) || 0;
    }
  }
  const hasUsage = usage.input || usage.output || usage.cacheRead || usage.cacheWrite;
  return { text: texts.join("\n").trim(), sessionId, usage: hasUsage ? usage : null, toolCalls };
}

export async function runAgent({
  bin = "opencode",
  agent,
  model,
  cwd,
  file,
  sessionId: continueSession = null,
  message = "Review the attached context and return your report.",
  timeoutSeconds = 900,
  standalone = false,
  onText,
  env = process.env,
}) {
  // Wait for the standalone boot turnstile so concurrent server boots cannot
  // collide on the same instant. Only the first caller spawns immediately; the
  // rest wait STAGGER_MS each, purely time-based — never on the current run's
  // output (a slow first token must not delay the successors).
  let releaseStandaloneBoot = null;
  if (standalone) releaseStandaloneBoot = await acquireStandaloneBootSlot();

  const args = ["run", "--agent", agent, "--format", "json"];
  if (standalone) args.push("--standalone");
  if (model) args.push("--model", model);
  if (continueSession) args.push("--session", continueSession);
  if (file) args.push("--file", file);
  args.push(message);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(bin, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Hand the boot slot over STAGGER_MS after spawn (pure time stagger), or
    // immediately when the process exits/errors during boot so a crashed server
    // never stalls the queued runs.
    let bootReleased = false;
    const releaseBoot = () => {
      if (bootReleased || !releaseStandaloneBoot) return;
      bootReleased = true;
      releaseStandaloneBoot();
    };
    if (releaseStandaloneBoot) {
      setTimeout(releaseBoot, STANDALONE_BOOT_STAGGER_MS).unref?.();
    }

    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    let timedOut = false;
    let settled = false;

    const collectLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") return;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (evt.sessionID) sessionId = evt.sessionID;
      if (
        evt.type === "text" &&
        evt.part?.type === "text" &&
        typeof evt.part.text === "string"
      ) {
        onText?.(evt.part.text);
      }
    };

    let sessionId = null;

    const killTree = (signal) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* already gone */
      }
    };

    const timer =
      timeoutSeconds > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree("SIGTERM");
            setTimeout(() => killTree("SIGKILL"), 5000).unref?.();
          }, timeoutSeconds * 1000)
        : null;
    timer?.unref?.();

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      lineBuf += d.toString();
      let idx;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        collectLine(line);
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (settled) return;
      releaseBoot();
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        text: "",
        stdout,
        stderr: `${stderr}\nspawn error: ${err.message}`,
        sessionId: null,
        usage: null,
        toolCalls: 0,
        durationMs: Date.now() - startedAt,
        timedOut,
        error: err.message,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      releaseBoot();
      settled = true;
      if (timer) clearTimeout(timer);
      const { text, sessionId, usage, toolCalls } = parseJsonl(stdout);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        text,
        stdout,
        stderr,
        sessionId,
        usage,
        toolCalls,
        durationMs: Date.now() - startedAt,
        timedOut,
        error: timedOut ? `timed out after ${timeoutSeconds}s` : code === 0 ? null : `exit code ${code}`,
      });
    });
  });
}

// Tiny leveled logger that writes to stderr so stdout stays machine-readable.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function emit(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = `${ts()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stderr;
  if (extra !== undefined) {
    stream.write(`${line} ${typeof extra === "string" ? extra : JSON.stringify(extra)}\n`);
  } else {
    stream.write(`${line}\n`);
  }
}

export const log = {
  debug: (m, e) => emit("debug", m, e),
  info: (m, e) => emit("info", m, e),
  warn: (m, e) => emit("warn", m, e),
  error: (m, e) => emit("error", m, e),
};

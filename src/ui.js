// Human-friendly console output helpers, with optional ANSI colors on TTYs.

const useColor =
  process.stdout.isTTY &&
  !process.env.NO_COLOR &&
  !process.env.TERM?.toLowerCase().includes("dumb");

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

export function paint(code, text) {
  return useColor ? `${c[code] ?? ""}${text}${c.reset}` : text;
}

export const ui = {
  bold: (t) => paint("bold", t),
  dim: (t) => paint("dim", t),
  red: (t) => paint("red", t),
  green: (t) => paint("green", t),
  yellow: (t) => paint("yellow", t),
  blue: (t) => paint("blue", t),
  cyan: (t) => paint("cyan", t),
  magenta: (t) => paint("magenta", t),
};

const RULE_WIDTH = 60;

export function rule(char = "─") {
  return char.repeat(RULE_WIDTH);
}

export function heading(title) {
  return `\n${ui.bold(title)}\n${rule()}`;
}

export function okBadge() {
  return ui.green("✔");
}

export function failBadge() {
  return ui.red("✘");
}

export function severityBadge(severity) {
  const icon = { CRITICAL: "🔴", HIGH: "🟠", MEDIUM: "🟡", LOW: "⚪" }[severity] ?? "•";
  const col = { CRITICAL: "red", HIGH: "yellow", MEDIUM: "yellow", LOW: "dim" }[severity] ?? "reset";
  return `${icon} ${paint(col, severity.padEnd(8))}`;
}

export function padRight(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
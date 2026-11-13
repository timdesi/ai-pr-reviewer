// App version shown in PR comments, reports and status.json.
// APP_VERSION (e.g. set at image build time) wins over package.json.

import { readFileSync } from "node:fs";

function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

export const APP_VERSION = (process.env.APP_VERSION || "").trim() || packageVersion() || "unknown";

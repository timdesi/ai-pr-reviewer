#!/usr/bin/env bash
# Local AI PR Reviewer dashboard — launches src/server.js (from this folder).
#
# Usage:
#   ./run-ui.sh                        # http://127.0.0.1:8123 (opens browser)
#   ./run-ui.sh --port 9999            # custom port
#   ./run-ui.sh --host 0.0.0.0         # bind all interfaces (be careful)
#   ./run-ui.sh --no-open              # don't auto-open the browser
#   PORT=9000 HOST=127.0.0.1 ./run-ui.sh   # or via env vars
#   ./run-ui.sh --help
#
# Ctrl+C (SIGINT) stops the server. One review runs at a time; see
# src/server.js for the endpoints it exposes (dashboard + webhook front door).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-8123}"
HOST="${HOST:-127.0.0.1}"
OPEN_BROWSER=1

show_help() {
  sed -n '3,12p' "$0"
  exit 0
}

# --- parse args ----------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --host) HOST="${2:?--host needs a value}"; shift 2 ;;
    --host=*) HOST="${1#*=}"; shift ;;
    --no-open) OPEN_BROWSER=0; shift ;;
    --help|-h) show_help ;;
    *) echo "Unknown option: $1" >&2; echo; show_help ;;
  esac
done

# --- sanity checks -------------------------------------------------------
command -v node >/dev/null 2>&1 || { echo "node not found on PATH" >&2; exit 1; }
[[ -f src/server.js ]] || { echo "must run from the dev/ folder (src/server.js missing)" >&2; exit 1; }

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use — is the UI already running?" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2
  exit 1
fi

# --- go ------------------------------------------------------------------
URL="http://$HOST:$PORT"
echo "──────────────────────────────────────────────────────────────"
echo "  AI PR Reviewer dashboard"
echo "  URL      $URL"
echo "  Serving  $(pwd)/jobs"
echo "  Stop     Ctrl+C"
echo "──────────────────────────────────────────────────────────────"

if [[ "$OPEN_BROWSER" == "1" ]]; then
  if command -v open >/dev/null 2>&1; then
    ( sleep 1; open "$URL" >/dev/null 2>&1 || true ) &
  fi
fi

exec node --env-file-if-exists=.env src/server.js

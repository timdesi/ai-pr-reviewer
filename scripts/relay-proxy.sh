#!/usr/bin/env bash
#
# Stable on-demand relay from the `container` build VM to the host proxy.
#
# Why this exists:
#   - All external HTTPS on this machine goes through a loopback-only proxy
#     (`PreproxyS` on 127.0.0.1:3128).
#   - The `container` tool builds inside a Kata guest (vmnet NAT,
#     192.168.64.0/24). The guest cannot reach host loopback and has no DNS
#     for e.g. cdn-ubi.redhat.com, so build steps like `microdnf install git`
#     fail with "Couldn't resolve host".
#   - Binding socat to the host-gateway address (192.168.64.1) exposes the
#     loopback proxy to the guest, making those build steps work.
#     NOTE: it must be bound to that exact address; a plain 0.0.0.0 bind is
#     NOT reachable from the guest on this platform.
#
# Add it only when needed, i.e. around a build:
#
#   scripts/relay-proxy.sh start     # bring the relay up (idempotent)
#   container build --build-arg https_proxy=http://192.168.64.1:3129 ...
#   scripts/relay-proxy.sh stop      # take it back down
#
# Or use the build wrapper, which does start -> build -> stop automatically:
#   scripts/container-build.sh [TAG]
#
# Subcommands: start | stop | status | restart | verify
#
# Config (env overrides):
#   RELAY_BIND   address the guest uses to reach the host (default 192.168.64.1)
#   RELAY_PORT   host/listen port            (default 3129)
#   UPSTREAM     the real proxy to forward to (default 127.0.0.1:3128)
#   PIDFILE / LOGFILE
set -uo pipefail

RELAY_BIND="${RELAY_BIND:-192.168.64.1}"
RELAY_PORT="${RELAY_PORT:-3129}"
UPSTREAM="${UPSTREAM:-127.0.0.1:3128}"
PIDFILE="${PIDFILE:-${TMPDIR:-/tmp}/container-relay-proxy.pid}"
LOGFILE="${LOGFILE:-${TMPDIR:-/tmp}/container-relay-proxy.log}"
UPSTREAM_PORT="${UPSTREAM##*:}"

# socat is installed as `socat1` on some machines (Homebrew rename).
SOCAT=""
for c in socat socat1; do
  if command -v "$c" >/dev/null 2>&1; then SOCAT="$(command -v "$c")"; break; fi
done

PATTERN="TCP-LISTEN:${RELAY_PORT},bind=${RELAY_BIND}"

log() { echo "relay: $*"; }

relay_pid() { [[ -f "$PIDFILE" ]] && cat "$PIDFILE" 2>/dev/null || true; }

is_running() {
  local pid
  pid="$(relay_pid)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# A socat for exactly our bind:port is already up (even if our pidfile is gone).
existing_socat() {
  pgrep -f "$PATTERN" 2>/dev/null | head -1 || true
}

bind_address_present() {
  ifconfig 2>/dev/null | grep -qF "inet ${RELAY_BIND} "
}

upstream_up() {
  nc -z -w 2 127.0.0.1 "$UPSTREAM_PORT" 2>/dev/null
}

start() {
  if is_running; then
    log "already running (pid $(relay_pid))"
    return 0
  fi
  local existing
  existing="$(existing_socat)"
  if [[ -n "$existing" ]]; then
    echo "$existing" >"$PIDFILE"
    log "adopting existing listener (pid $existing) on ${RELAY_BIND}:${RELAY_PORT}"
    return 0
  fi
  if [[ -z "$SOCAT" ]]; then
    log "ERROR: socat not found — run: brew install socat" >&2
    return 1
  fi
  if ! bind_address_present; then
    log "ERROR: bind address ${RELAY_BIND} is not on any interface." >&2
    log "       Start the 'container' service first (it creates the vmnet bridge)." >&2
    return 1
  fi
  if ! upstream_up; then
    log "WARNING: upstream proxy ${UPSTREAM} is not listening;" >&2
    log "         the relay will forward nothing until it is." >&2
  fi

  rm -f "$PIDFILE"
  nohup "$SOCAT" "TCP-LISTEN:${RELAY_PORT},bind=${RELAY_BIND},fork,reuseaddr" "TCP:${UPSTREAM}" >>"$LOGFILE" 2>&1 &
  echo "$!" >"$PIDFILE"

  # reap a possible immediate failure
  sleep 1
  if ! is_running; then
    log "ERROR: relay failed to start (see $LOGFILE)"
    return 1
  fi
  log "up ${RELAY_BIND}:${RELAY_PORT} -> ${UPSTREAM} (pid $(relay_pid), log $LOGFILE)"
}

stop() {
  local pid
  pid="$(relay_pid)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
  # also take down any stray socat for our bind:port
  pkill -f "$PATTERN" 2>/dev/null || true
  rm -f "$PIDFILE"
  log "stopped"
}

status() {
  local pid
  pid="$(relay_pid)"
  if is_running; then
    echo "state: running (pid $pid)"
  elif [[ -n "$(existing_socat)" ]]; then
    echo "state: running but untracked — pidfile stale (fix with: $(basename "$0") start)"
  else
    echo "state: stopped"
  fi
  echo "listener: ${RELAY_BIND}:${RELAY_PORT}"
  echo "upstream: ${UPSTREAM} ($(upstream_up && echo listening || echo NOT listening))"
  echo "socat:    ${SOCAT:-not found}"
  echo "pidfile:  $PIDFILE"
  echo "logfile:  $LOGFILE"
}

# Best-effort proof that the build guest can actually reach the relay.
verify() {
  if ! container builder status >/dev/null 2>&1; then
    log "verify: no running builder — skipping guest probe" >&2
    return 0
  fi
  if container exec buildkit sh -c 'command -v nc >/dev/null 2>&1' 2>/dev/null; then
    if container exec buildkit nc -z -w 4 "${RELAY_BIND}" "${RELAY_PORT}" 2>/dev/null; then
      log "verify: guest -> ${RELAY_BIND}:${RELAY_PORT} OPEN"
      return 0
    fi
    log "verify: FAILED — guest cannot reach ${RELAY_BIND}:${RELAY_PORT}" >&2
    return 1
  fi
  log "verify: nc missing in builder; skipping guest probe" >&2
  return 0
}

restart() { stop; start; }

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  status)  status ;;
  restart) restart ;;
  verify)  verify ;;
  *)
    echo "usage: $0 {start|stop|status|restart|verify}" >&2
    exit 2
    ;;
esac

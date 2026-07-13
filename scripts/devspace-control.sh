#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
OPTION="${2:-}"
CONFIG_DIR="${DEVSPACE_CONFIG_DIR:-$HOME/.devspace}"
CONFIG_PATH="$CONFIG_DIR/config.json"
PID_PATH="$CONFIG_DIR/devspace.pid"
LOG_PATH="$CONFIG_DIR/devspace.log"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

read_config() {
  local key="$1"
  [[ -f "$CONFIG_PATH" ]] || fail "Config not found: $CONFIG_PATH. Run devspace init or quickstart first."
  CONFIG_PATH="$CONFIG_PATH" KEY="$key" node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf8"));
    const value = config[process.env.KEY];
    if (value === undefined || value === null) process.exit(1);
    process.stdout.write(String(value));
  '
}

find_tailscale() {
  if command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
    return
  fi
  if [[ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]]; then
    printf '%s\n' "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    return
  fi
  return 1
}

port_is_open() {
  local port="$1"
  node -e '
    const net = require("node:net");
    const port = Number(process.argv[1]);
    const socket = net.createConnection({host:"127.0.0.1", port});
    socket.setTimeout(700);
    socket.once("connect", () => { socket.destroy(); process.exit(0); });
    socket.once("timeout", () => { socket.destroy(); process.exit(1); });
    socket.once("error", () => process.exit(1));
  ' "$port" >/dev/null 2>&1
}

public_mcp_url() {
  local base
  base="$(read_config publicBaseUrl)" || fail "publicBaseUrl is missing from $CONFIG_PATH"
  printf '%s/mcp' "${base%/}"
}

copy_or_print() {
  local value="$1"
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$value" | pbcopy
    printf 'Copied to clipboard.\n'
  else
    printf '%s\n' "$value"
  fi
}

start_runtime() {
  local port devspace_bin
  port="$(read_config port)" || port="7676"
  devspace_bin="$(command -v devspace || true)"
  [[ -n "$devspace_bin" ]] || fail "devspace command not found. Run npm link in the repository."

  if port_is_open "$port"; then
    printf 'DevSpace is already ONLINE on 127.0.0.1:%s.\n' "$port"
    return
  fi

  mkdir -p "$CONFIG_DIR"
  nohup env DEVSPACE_TOOL_MODE=full "$devspace_bin" serve >"$LOG_PATH" 2>&1 &
  printf '%s\n' "$!" >"$PID_PATH"

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if port_is_open "$port"; then
      printf 'DevSpace started: http://127.0.0.1:%s/mcp\n' "$port"
      return
    fi
    sleep 1
  done

  [[ -f "$LOG_PATH" ]] && tail -n 40 "$LOG_PATH" >&2
  fail "DevSpace failed to start. Log: $LOG_PATH"
}

stop_runtime() {
  local port pid process_command
  port="$(read_config port)" || port="7676"

  if [[ -f "$PID_PATH" ]]; then
    pid="$(cat "$PID_PATH")"
    [[ "$pid" =~ ^[0-9]+$ ]] || fail "Invalid PID file: $PID_PATH"

    if kill -0 "$pid" 2>/dev/null; then
      process_command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      [[ "$process_command" == *devspace*serve* ]] || fail "PID $pid is not a DevSpace serve process. Refusing to terminate it."

      kill "$pid"
      for _ in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$pid" 2>/dev/null; then
        fail "Runtime did not exit after SIGTERM. PID: $pid"
      fi
    fi
    rm -f "$PID_PATH"
  fi

  if port_is_open "$port"; then
    fail "Port $port is still open, but no verified DevSpace PID is available. Stop the owning process manually; this script will not kill an unknown process."
  fi

  printf 'DevSpace stopped.\n'

  if [[ "$OPTION" == "--with-funnel" ]]; then
    local ts_bin
    ts_bin="$(find_tailscale || true)"
    [[ -n "$ts_bin" ]] || fail "Tailscale CLI not found; DevSpace is stopped but Funnel was not reset."
    "$ts_bin" funnel reset
    printf 'Tailscale Funnel reset.\n'
  fi
}

show_status() {
  local port url ts_bin
  port="$(read_config port)" || port="7676"
  url="$(public_mcp_url || true)"

  if port_is_open "$port"; then
    printf 'DevSpace runtime: ONLINE\n'
  else
    printf 'DevSpace runtime: OFFLINE\n'
  fi
  printf 'Local MCP:       http://127.0.0.1:%s/mcp\n' "$port"
  [[ -n "$url" ]] && printf 'Public MCP:      %s\n' "$url"
  printf 'Config:          %s\n' "$CONFIG_PATH"
  printf 'Log:             %s\n' "$LOG_PATH"

  if command -v devspace >/dev/null 2>&1; then
    printf '\n--- devspace doctor ---\n'
    devspace doctor || true
  else
    printf '\ndevspace command not found. Run npm link in the repository.\n'
  fi

  ts_bin="$(find_tailscale || true)"
  if [[ -n "$ts_bin" ]]; then
    printf '\n--- tailscale funnel status ---\n'
    "$ts_bin" funnel status || true
  fi
}

OWNER_COMMAND="python3 -c 'import json,pathlib; print(json.loads((pathlib.Path.home()/\".devspace/auth.json\").read_text())[\"ownerToken\"], end=\"\")' | pbcopy"

case "$ACTION" in
  start)
    start_runtime
    ;;
  stop)
    stop_runtime
    ;;
  restart)
    stop_runtime
    start_runtime
    ;;
  status)
    show_status
    ;;
  logs)
    [[ -f "$LOG_PATH" ]] || fail "Log not found: $LOG_PATH"
    tail -n 100 "$LOG_PATH"
    ;;
  url)
    copy_or_print "$(public_mcp_url)"
    ;;
  owner-cmd)
    copy_or_print "$OWNER_COMMAND"
    ;;
  doctor)
    command -v devspace >/dev/null 2>&1 || fail "devspace command not found."
    devspace doctor
    ;;
  *)
    cat <<'USAGE'
Usage:
  bash scripts/devspace-control.sh start
  bash scripts/devspace-control.sh stop [--with-funnel]
  bash scripts/devspace-control.sh restart
  bash scripts/devspace-control.sh status
  bash scripts/devspace-control.sh logs
  bash scripts/devspace-control.sh url
  bash scripts/devspace-control.sh owner-cmd
  bash scripts/devspace-control.sh doctor
USAGE
    exit 2
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DROPIN_SOURCE="$ROOT/deploy/systemd/zzzz-gpt-agent4ec2.conf"
DROPIN_DIR="/etc/systemd/system/gpt-agent-ec2.service.d"
DROPIN_TARGET="$DROPIN_DIR/zzzz-gpt-agent4ec2.conf"
RUNTIME_SERVICE="gpt-agent-ec2.service"
TUNNEL_SERVICE="gae-tunnel.service"
STARTED_AT="$(date --iso-8601=seconds)"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[ "$(id -un)" = "ubuntu" ] || fail "Run as ubuntu."
[ -f "$DROPIN_SOURCE" ] || fail "Missing drop-in: $DROPIN_SOURCE"
[ -f "$ROOT/dist/cli.js" ] || fail "Missing build: $ROOT/dist/cli.js"

sudo install -d -o root -g root -m 0755 "$DROPIN_DIR"
sudo install -o root -g root -m 0644 "$DROPIN_SOURCE" "$DROPIN_TARGET"
sudo systemctl daemon-reload
sudo systemd-analyze verify "$RUNTIME_SERVICE"

sudo systemctl stop "$TUNNEL_SERVICE" 2>/dev/null || true
sudo systemctl stop gae-tunnel-recovery.service 2>/dev/null || true
sudo systemctl stop gae-recovery.service 2>/dev/null || true
sudo systemctl restart "$RUNTIME_SERVICE"

health="000"
for _ in $(seq 1 30); do
  health="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:7676/healthz || true)"
  [ "$health" = "200" ] && break
  sleep 1
done
[ "$health" = "200" ] || fail "GAE health check failed: HTTP $health"

sudo systemctl restart "$TUNNEL_SERVICE"
for _ in $(seq 1 20); do
  systemctl is-active --quiet "$TUNNEL_SERVICE" && break
  sleep 1
done
systemctl is-active --quiet "$TUNNEL_SERVICE" || fail "$TUNNEL_SERVICE is not active"

exec_start="$(systemctl show "$RUNTIME_SERVICE" -p ExecStart --value)"
working_directory="$(systemctl show "$RUNTIME_SERVICE" -p WorkingDirectory --value)"
printf '%s' "$exec_start" | grep -Fq '/home/ubuntu/GPT-Agent4EC2/dist/cli.js serve' \
  || fail "Effective ExecStart does not use GPT-Agent4EC2"
[ "$working_directory" = '/home/ubuntu/GPT-Agent4EC2' ] \
  || fail "Effective WorkingDirectory is unexpected: $working_directory"

initialized="no"
for _ in $(seq 1 20); do
  if journalctl -u "$TUNNEL_SERVICE" --since "$STARTED_AT" --no-pager \
      | grep -Fq 'mcp session initialized'; then
    initialized="yes"
    break
  fi
  sleep 1
done
[ "$initialized" = "yes" ] || fail "Tunnel did not initialize an MCP session"

printf 'runtime=active\n'
printf 'runtime_path=/home/ubuntu/GPT-Agent4EC2/dist/cli.js\n'
printf 'health=200\n'
printf 'tunnel=active\n'
printf 'mcp_session=initialized\n'
printf 'dropin=%s\n' "$DROPIN_TARGET"

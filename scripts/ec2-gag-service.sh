#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-install}"
SERVICE_NAME="gpt-agent-ec2.service"
SERVICE_SOURCE="/home/ubuntu/GPT-Agent/deploy/systemd/gpt-agent-ec2.service"
SERVICE_TARGET="/etc/systemd/system/${SERVICE_NAME}"
NODE="/home/ubuntu/.local/bin/node"
CONFIGURE="/home/ubuntu/GPT-Agent/scripts/ec2-gag-configure.mjs"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '[gag-ec2-service] %s\n' "$*"; }

[ "$(id -un)" = "ubuntu" ] || fail "Run as ubuntu."
[ -x "$NODE" ] || fail "Node is missing: $NODE"
[ -f "$SERVICE_SOURCE" ] || fail "Service template is missing: $SERVICE_SOURCE"
[ -f "$CONFIGURE" ] || fail "Configure script is missing: $CONFIGURE"

minecraft_state() {
  printf '%s:%s' \
    "$(systemctl is-active minecraft.service 2>/dev/null || true)" \
    "$(systemctl show -p MainPID --value minecraft.service 2>/dev/null || true)"
}

verify_runtime() {
  local tailscale_ip tailscale_dns health serve_status
  tailscale_ip="$(tailscale ip -4 | awk '/^100\./ { print; exit }')"
  [ -n "$tailscale_ip" ] || fail "Tailscale IPv4 is unavailable."
  tailscale_dns="$(tailscale status --json | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).Self.DNSName||"").replace(/\.$/,"")))')"
  [ -n "$tailscale_dns" ] || fail "Tailscale MagicDNS name is unavailable."
  systemctl is-active --quiet "$SERVICE_NAME" || fail "$SERVICE_NAME is not active."
  systemctl is-enabled --quiet "$SERVICE_NAME" || fail "$SERVICE_NAME is not enabled."
  health="$(curl --fail --silent --show-error --max-time 8 --resolve "${tailscale_dns}:443:${tailscale_ip}" "https://${tailscale_dns}/healthz")"
  [ "$health" = '{"ok":true,"name":"devspace"}' ] || fail "Unexpected health response."
  ss -ltn | grep -Fq "127.0.0.1:7676" || fail "GAG is not bound to loopback."
  if ss -ltn | grep -Eq '(^|[[:space:]])(0\.0\.0\.0|\[::\]):7676([[:space:]]|$)'; then
    fail "GAG unexpectedly listens on a wildcard address."
  fi
  serve_status="$(tailscale serve status)"
  printf '%s\n' "$serve_status" | grep -Fq "https://${tailscale_dns}" || fail "Tailscale Serve HTTPS endpoint is missing."
  printf '%s\n' "$serve_status" | grep -Fq "http://127.0.0.1:7676" || fail "Tailscale Serve proxy target is incorrect."
  printf 'service=active enabled=yes bind=127.0.0.1:7676 tailnet=https://%s health=ok\n' "$tailscale_dns"
}

case "$MODE" in
  install)
    minecraft_before="$(minecraft_state)"
    [ "${minecraft_before%%:*}" = "active" ] || fail "minecraft.service is not active before installation."
    "$NODE" "$CONFIGURE"
    sudo systemd-analyze verify "$SERVICE_SOURCE"
    sudo install -o root -g root -m 0644 "$SERVICE_SOURCE" "$SERVICE_TARGET"
    sudo systemctl daemon-reload
    sudo systemctl enable --now "$SERVICE_NAME"
    sudo tailscale serve --bg --yes --https=443 http://127.0.0.1:7676
    for _ in $(seq 1 20); do
      if systemctl is-active --quiet "$SERVICE_NAME" && curl --fail --silent --max-time 2 "http://127.0.0.1:7676/healthz" >/dev/null; then
        break
      fi
      sleep 1
    done
    verify_runtime
    minecraft_after="$(minecraft_state)"
    [ "$minecraft_after" = "$minecraft_before" ] || fail "Minecraft state changed: before=$minecraft_before after=$minecraft_after"
    info "Installed without changing Minecraft: $minecraft_after"
    ;;
  verify)
    verify_runtime
    printf 'minecraft=%s\n' "$(minecraft_state)"
    systemctl show "$SERVICE_NAME" \
      -p MemoryHigh -p MemoryMax -p CPUWeight -p IOWeight -p OOMScoreAdjust \
      --no-pager
    ;;
  disable)
    sudo systemctl disable --now "$SERVICE_NAME"
    sudo tailscale serve reset
    info "Disabled $SERVICE_NAME and removed its Tailscale Serve configuration. Unit file remains for rollback inspection."
    ;;
  *)
    fail "Usage: $0 [install|verify|disable]"
    ;;
esac

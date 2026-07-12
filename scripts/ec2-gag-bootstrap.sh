#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

MODE="${1:-prepare}"
GAG_ROOT="${GAG_ROOT:-/home/ubuntu/GPT-Agent}"
CORE_ROOT="${CORE_ROOT:-/home/ubuntu/AI-Agent-Core}"
COPY_PATH="${COPY_PATH:-/home/ubuntu/copy.txt}"
CONFIG_DIR="${DEVSPACE_CONFIG_DIR:-/home/ubuntu/.devspace}"
STATE_DIR="${DEVSPACE_STATE_DIR:-/home/ubuntu/.local/share/devspace}"
NODE_MIN_MAJOR=22

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '[gag-ec2] %s\n' "$*"; }

[ "$(id -u)" -ne 0 ] || fail "Run as ubuntu, not root."
[ "$(id -un)" = "ubuntu" ] || fail "Expected user ubuntu; got $(id -un)."
command -v git >/dev/null 2>&1 || fail "git is required."
command -v node >/dev/null 2>&1 || fail "Node.js >=22.19 is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge "$NODE_MIN_MAJOR" ] || fail "Node.js >=22.19 is required; found $(node -v)."
[ -d "$CORE_ROOT/.git" ] || fail "AI-Agent-Core clone is missing: $CORE_ROOT"
[ -d "$GAG_ROOT/.git" ] || fail "GPT-Agent clone is missing: $GAG_ROOT"

mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$(dirname "$COPY_PATH")"
touch "$COPY_PATH"
chmod 600 "$COPY_PATH"

case "$MODE" in
  prepare)
    info "Validating repositories and installing dependencies."
    git -C "$CORE_ROOT" status --short --branch
    git -C "$GAG_ROOT" status --short --branch
    npm --prefix "$GAG_ROOT" ci
    npm --prefix "$GAG_ROOT" run build
    info "Prepared EC2 GAG runtime. No listener or service was started."
    ;;
  verify)
    info "Running offline verification only."
    npm --prefix "$GAG_ROOT" run typecheck
    npm --prefix "$GAG_ROOT" test
    info "Verification complete."
    ;;
  print-env)
    cat <<EOF
HOST=127.0.0.1
PORT=7676
DEVSPACE_ALLOWED_ROOTS=$CORE_ROOT,$GAG_ROOT,/home/ubuntu
DEVSPACE_STATE_DIR=$STATE_DIR
DEVSPACE_TOOL_MODE=full
DEVSPACE_OPEN_WORKSPACE_PAYLOAD=compact
DEVSPACE_WIDGETS=off
DEVSPACE_USAGE_CONTENT=compact
DEVSPACE_NODE_ROLE=ec2
DEVSPACE_COPY_PATH=$COPY_PATH
EOF
    ;;
  *)
    fail "Usage: $0 [prepare|verify|print-env]"
    ;;
esac

#!/usr/bin/env bash
set -u

export PATH="$HOME/.local/bin:$PATH"

GAG_ROOT="${GAG_ROOT:-/home/ubuntu/GPT-Agent}"
CORE_ROOT="${CORE_ROOT:-/home/ubuntu/AI-Agent-Core}"
COPY_PATH="${COPY_PATH:-/home/ubuntu/copy.txt}"
FAILURES=0

check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'OK\t%s\n' "$label"
  else
    printf 'NG\t%s\n' "$label"
    FAILURES=$((FAILURES + 1))
  fi
}

printf 'role\tec2\n'
printf 'host\t%s\n' "$(hostname 2>/dev/null || echo unknown)"
printf 'user\t%s\n' "$(id -un 2>/dev/null || echo unknown)"
printf 'node\t%s\n' "$(node -v 2>/dev/null || echo missing)"
printf 'gag_root\t%s\n' "$GAG_ROOT"
printf 'core_root\t%s\n' "$CORE_ROOT"
printf 'copy_path\t%s\n' "$COPY_PATH"

check 'ubuntu user' test "$(id -un 2>/dev/null)" = ubuntu
check 'git available' command -v git
check 'node available' command -v node
check 'npm available' command -v npm
check 'Node >=22' bash -c '[ "$(node -p '\''Number(process.versions.node.split(".")[0])'\'' 2>/dev/null)" -ge 22 ]'
check 'AI-Agent-Core clone' test -d "$CORE_ROOT/.git"
check 'GPT-Agent clone' test -d "$GAG_ROOT/.git"
check 'GAG build output' test -f "$GAG_ROOT/dist/cli.js"
check 'copy.txt writable' test -w "$COPY_PATH"
check 'config directory private' bash -c '[ "$(stat -c %a "$1" 2>/dev/null)" = 700 ]' _ "/home/ubuntu/.devspace"

if command -v tailscale >/dev/null 2>&1; then
  if tailscale status --json >/dev/null 2>&1; then
    printf 'OK\tTailscale available\n'
  else
    printf 'NG\tTailscale unavailable\n'
    FAILURES=$((FAILURES + 1))
  fi
else
  printf 'NG\tTailscale missing\n'
  FAILURES=$((FAILURES + 1))
fi

printf 'failures\t%d\n' "$FAILURES"
exit "$FAILURES"

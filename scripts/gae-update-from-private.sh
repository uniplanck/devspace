#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-check}"
GAG_ROOT="${GAG_ROOT:-/home/ubuntu/GPT-Agent}"
REMOTE_NAME="${GAG_PRIVATE_REMOTE_NAME:-private}"
REMOTE_URL="${GAG_PRIVATE_REPO:-git@github.com:uniplanck/gpt-agent.git}"
TARGET_BRANCH="${GAG_TARGET_BRANCH:-gae}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '[gae-update] %s\n' "$*"
}

case "$MODE" in
  check|apply) ;;
  *) fail "Usage: $0 [check|apply]" ;;
esac

[ "$(id -u)" -ne 0 ] || fail "Run as the runtime user, not root."
[ -d "$GAG_ROOT/.git" ] || fail "GPT-Agent clone is missing: $GAG_ROOT"
command -v git >/dev/null 2>&1 || fail "git is required."
command -v node >/dev/null 2>&1 || fail "node is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."

current_branch="$(git -C "$GAG_ROOT" branch --show-current)"
status="$(git -C "$GAG_ROOT" status --short)"

if ! git -C "$GAG_ROOT" remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  if [[ "$MODE" == "check" ]]; then
    info "Private remote is missing: $REMOTE_NAME"
    info "Expected URL: $REMOTE_URL"
    exit 2
  fi
  git -C "$GAG_ROOT" remote add "$REMOTE_NAME" "$REMOTE_URL"
  info "Added private remote: $REMOTE_NAME"
fi

git -C "$GAG_ROOT" fetch "$REMOTE_NAME" "$TARGET_BRANCH"
remote_ref="$REMOTE_NAME/$TARGET_BRANCH"
local_head="$(git -C "$GAG_ROOT" rev-parse HEAD)"
remote_head="$(git -C "$GAG_ROOT" rev-parse "$remote_ref")"
counts="$(git -C "$GAG_ROOT" rev-list --left-right --count HEAD..."$remote_ref")"
ahead="${counts%%$'\t'*}"
behind="${counts##*$'\t'}"

info "Root: $GAG_ROOT"
info "Branch: ${current_branch:-detached}"
info "Local: ${local_head:0:12}"
info "GAE release: ${remote_head:0:12}"
info "Ahead: $ahead / Behind: $behind"

if [[ -n "$status" ]]; then
  info "Working tree is not clean."
  printf '%s\n' "$status"
fi

if [[ "$MODE" == "check" ]]; then
  [[ "$current_branch" == "$TARGET_BRANCH" ]] || exit 3
  [[ -z "$status" ]] || exit 4
  [[ "$ahead" == "0" ]] || exit 5
  exit 0
fi

[[ "$current_branch" == "$TARGET_BRANCH" ]] || fail "Switch to $TARGET_BRANCH before applying an update."
[[ -z "$status" ]] || fail "Commit or move GAE-specific changes out of the repository before updating."
[[ "$ahead" == "0" ]] || fail "Local GAE contains commits not present in private/$TARGET_BRANCH. Reconcile them into the GAE release branch first."

if [[ "$behind" == "0" ]]; then
  info "Already current. No update applied."
  exit 0
fi

candidate_root="$(mktemp -d /tmp/gae-update.XXXXXX)"
cleanup() {
  git -C "$GAG_ROOT" worktree remove --force "$candidate_root" >/dev/null 2>&1 || true
  rm -rf "$candidate_root"
}
trap cleanup EXIT

git -C "$GAG_ROOT" worktree add --detach "$candidate_root" "$remote_ref"
info "Validating candidate ${remote_head:0:12}."
npm --prefix "$candidate_root" ci
npm --prefix "$candidate_root" run typecheck
npm --prefix "$candidate_root" test
npm --prefix "$candidate_root" run build

cleanup
trap - EXIT

git -C "$GAG_ROOT" merge --ff-only "$remote_ref"
npm --prefix "$GAG_ROOT" ci
npm --prefix "$GAG_ROOT" run build

info "Source and build updated to ${remote_head:0:12}."
info "Service was not restarted. Verify the runtime, then restart gpt-agent-ec2.service explicitly."

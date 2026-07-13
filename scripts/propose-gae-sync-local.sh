#!/bin/zsh
set -euo pipefail

REPO="${GAG_GITHUB_REPO:-uniplanck/gpt-agent}"
BASE_BRANCH="${GAG_GAE_BRANCH:-gae}"
HEAD_BRANCH="${GAG_MAIN_BRANCH:-main}"

info() {
  printf '[gae-promotion] %s\n' "$*"
}

if ! command -v gh >/dev/null 2>&1; then
  info "gh is unavailable; GAE promotion PR was not checked."
  exit 0
fi

if ! gh auth status >/dev/null 2>&1; then
  info "gh is not authenticated; GAE promotion PR was not checked."
  exit 0
fi

ahead="$(gh api "repos/$REPO/compare/$BASE_BRANCH...$HEAD_BRANCH" --jq '.ahead_by')"
if [[ "$ahead" == "0" ]]; then
  info "$BASE_BRANCH already contains $HEAD_BRANCH."
  exit 0
fi

existing="$(gh pr list \
  --repo "$REPO" \
  --base "$BASE_BRANCH" \
  --head "$HEAD_BRANCH" \
  --state open \
  --json number \
  --jq '.[0].number // empty')"

if [[ -n "$existing" ]]; then
  info "Promotion PR #$existing is already open and includes the latest $HEAD_BRANCH commits."
  exit 0
fi

url="$(gh pr create \
  --repo "$REPO" \
  --base "$BASE_BRANCH" \
  --head "$HEAD_BRANCH" \
  --title "sync: promote GAG main to GAE" \
  --body $'GAG `main` has changes not yet reviewed for the GAE release channel.\n\nThis pull request does **not** update EC2, restart services, or merge automatically. Review GAE-specific runtime behavior and CI before merging.')"
info "Created promotion PR: $url"

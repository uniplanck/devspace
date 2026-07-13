#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
for variable in $(git -C "$ROOT" rev-parse --local-env-vars); do
  unset "$variable"
done
PUBLIC_REPO="git@github.com:uniplanck/devspace.git"
SYNC_KEY="${DEVSPACE_SYNC_KEY:-$HOME/.devspace/sync-key/id_ed25519}"
STAMP="$(date +%Y%m%d-%H%M%S)"
CURRENT_BRANCH="$(git -C "$ROOT" branch --show-current)"

if [[ -z "$CURRENT_BRANCH" ]]; then
  echo "auto-publish: detached HEAD is not supported" >&2
  exit 1
fi

if [[ ! -d "$ROOT/node_modules" ]]; then
  npm --prefix "$ROOT" ci
fi
npm --prefix "$ROOT" run typecheck
npm --prefix "$ROOT" test
npm --prefix "$ROOT" run build

if [[ "$CURRENT_BRANCH" == "main" ]]; then
  AUDIT_BRANCH="auto/gpt-agent-$STAMP"
  git -C "$ROOT" branch "$AUDIT_BRANCH" HEAD
  git -C "$ROOT" push private "$AUDIT_BRANCH"
  git -C "$ROOT" push private main
else
  git -C "$ROOT" push -u private "$CURRENT_BRANCH"
  git -C "$ROOT" fetch private main
  if git -C "$ROOT" merge-base --is-ancestor private/main HEAD; then
    git -C "$ROOT" push private HEAD:main
  else
    echo "auto-publish: private main diverged; branch pushed but main was not changed" >&2
    exit 1
  fi
fi

zsh "$ROOT/scripts/propose-gae-sync-local.sh" || \
  echo "auto-publish: GAE promotion PR check failed; private main remains updated" >&2

if [[ ! -f "$SYNC_KEY" ]]; then
  echo "auto-publish: private repo updated; public sync key is missing at $SYNC_KEY" >&2
  exit 0
fi

TEMP_ROOT="$(mktemp -d /tmp/gpt-agent-sync.XXXXXX)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
export GIT_SSH_COMMAND="/usr/bin/ssh -i $SYNC_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

git clone "$PUBLIC_REPO" "$TEMP_ROOT/devspace"
zsh "$ROOT/scripts/export-public-core.sh" "$TEMP_ROOT/devspace" >/dev/null

npm --prefix "$TEMP_ROOT/devspace" ci
npm --prefix "$TEMP_ROOT/devspace" run typecheck
npm --prefix "$TEMP_ROOT/devspace" test
npm --prefix "$TEMP_ROOT/devspace" run build
/usr/bin/swiftc -parse-as-library -typecheck -framework SwiftUI -framework AppKit \
  "$TEMP_ROOT/devspace/extensions/devspace-tool/UsageCore.swift" \
  "$TEMP_ROOT/devspace/extensions/devspace-tool/DevSpaceToolView.swift" \
  "$TEMP_ROOT/devspace/extensions/devspace-tool/DevSpaceTool.swift"

git -C "$TEMP_ROOT/devspace" config user.name "devspace-sync[local]"
git -C "$TEMP_ROOT/devspace" config user.email "devspace-sync@users.noreply.github.com"
SYNC_BRANCH="sync/devspace-core-$STAMP"
git -C "$TEMP_ROOT/devspace" switch -c "$SYNC_BRANCH"
git -C "$TEMP_ROOT/devspace" add \
  .env.example \
  AGENTS.md \
  LICENSE \
  package.json \
  package-lock.json \
  tsconfig.json \
  tsconfig.build.json \
  vite.config.ts \
  src \
  skills \
  examples \
  scripts/build-app.mjs \
  scripts/clean-dist.mjs \
  scripts/dev-server.mjs \
  scripts/fix-node-pty-permissions.mjs \
  extensions/devspace-tool

if git -C "$TEMP_ROOT/devspace" diff --cached --quiet; then
  echo "auto-publish: public DevSpace core already current"
  exit 0
fi

git -C "$TEMP_ROOT/devspace" commit -m "chore: sync generic DevSpace core $(git -C "$ROOT" rev-parse --short=12 HEAD)"
git -C "$TEMP_ROOT/devspace" push origin "$SYNC_BRANCH"
git -C "$TEMP_ROOT/devspace" push origin "$SYNC_BRANCH:main"
echo "auto-publish: private and public repositories updated"

#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
TARGET_ROOT="${1:-}"

if [[ -z "$TARGET_ROOT" || ! -e "$TARGET_ROOT/.git" ]]; then
  echo "usage: $0 /path/to/devspace-checkout" >&2
  exit 2
fi

for directory in src skills examples; do
  mkdir -p "$TARGET_ROOT/$directory"
  /usr/bin/rsync -a --delete \
    --exclude '.DS_Store' \
    "$ROOT/$directory/" "$TARGET_ROOT/$directory/"
done

for file in \
  .env.example \
  AGENTS.md \
  LICENSE \
  package.json \
  package-lock.json \
  tsconfig.json \
  tsconfig.build.json \
  vite.config.ts; do
  /bin/cp "$ROOT/$file" "$TARGET_ROOT/$file"
done

for file in \
  scripts/build-app.mjs \
  scripts/clean-dist.mjs \
  scripts/dev-server.mjs \
  scripts/fix-node-pty-permissions.mjs; do
  mkdir -p "$TARGET_ROOT/${file:h}"
  /bin/cp "$ROOT/$file" "$TARGET_ROOT/$file"
done

if /usr/bin/grep -RInE \
  '/Users/naomac|tail9d68b1|planckworld@gmail.com|naoyamao\.world' \
  "$TARGET_ROOT/src" \
  "$TARGET_ROOT/skills" \
  "$TARGET_ROOT/examples" \
  "$TARGET_ROOT/package.json" \
  "$TARGET_ROOT/package-lock.json" \
  "$TARGET_ROOT/.env.example"; then
  echo "public export contains a private environment marker" >&2
  exit 1
fi

printf '%s\n' "$TARGET_ROOT"

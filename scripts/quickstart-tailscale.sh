#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${DEVSPACE_PORT:-7676}"
CONFIG_DIR="${DEVSPACE_CONFIG_DIR:-$HOME/.devspace}"
PROJECT_ROOT="${1:-}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '\n==> %s\n' "$*"
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
  node -e '
    const net = require("node:net");
    const port = Number(process.argv[1]);
    const socket = net.createConnection({host:"127.0.0.1", port});
    socket.setTimeout(700);
    socket.once("connect", () => { socket.destroy(); process.exit(0); });
    socket.once("timeout", () => { socket.destroy(); process.exit(1); });
    socket.once("error", () => process.exit(1));
  ' "$PORT" >/dev/null 2>&1
}

[[ -n "$PROJECT_ROOT" ]] || {
  if [[ -t 0 ]]; then
    printf 'ChatGPTに許可するプロジェクトフォルダの絶対パス: '
    read -r PROJECT_ROOT
  else
    fail "Usage: $0 /absolute/path/to/projects"
  fi
}

PROJECT_ROOT="$(cd "$PROJECT_ROOT" 2>/dev/null && pwd)" || fail "Project root does not exist: ${1:-}"
[[ -d "$PROJECT_ROOT" ]] || fail "Project root is not a directory: $PROJECT_ROOT"

command -v git >/dev/null 2>&1 || fail "Git is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v node >/dev/null 2>&1 || fail "Node.js is required. Install Node.js 22.19 or later."

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = (major > 22 && major < 27) || (major === 22 && minor >= 19);
  if (!ok) {
    console.error(`Node.js ${process.versions.node} is unsupported. Required: >=22.19 <27.`);
    process.exit(1);
  }
'

TS_BIN="$(find_tailscale)" || fail "Tailscale CLI was not found. Install Tailscale, sign in, and ensure the tailscale command is available."

info "Tailscale connection"
if ! "$TS_BIN" status >/dev/null 2>&1; then
  "$TS_BIN" up
fi
"$TS_BIN" status >/dev/null 2>&1 || fail "Tailscale is not connected. Complete sign-in and run this script again."

TAILSCALE_HOST="$("$TS_BIN" status --json | node -e '
  let raw="";
  process.stdin.on("data", chunk => raw += chunk);
  process.stdin.on("end", () => {
    const data = JSON.parse(raw);
    const dns = String(data?.Self?.DNSName || "").replace(/\.$/, "");
    if (!dns) process.exit(1);
    process.stdout.write(dns);
  });
')" || fail "Could not determine the Tailscale DNS name. Check MagicDNS and tailscale status --json."

PUBLIC_BASE_URL="https://${TAILSCALE_HOST}"
PUBLIC_MCP_URL="${PUBLIC_BASE_URL}/mcp"

info "Install and validate DevSpace"
cd "$ROOT"
npm ci
npm run typecheck
npm test
npm run build
npm link

DEVSPACE_BIN="$(command -v devspace)" || fail "npm link completed but the devspace command is not on PATH."

info "Configure Tailscale Funnel"
if ! "$TS_BIN" funnel --bg "$PORT"; then
  fail "Tailscale Funnel could not be enabled. Approve Funnel in the browser/admin console, then rerun this script."
fi
"$TS_BIN" funnel status || fail "Tailscale Funnel was requested but its status could not be verified."

info "Create DevSpace configuration"
mkdir -p "$CONFIG_DIR"
CONFIG_PATH="$CONFIG_DIR/config.json"
AUTH_PATH="$CONFIG_DIR/auth.json"
TOOL_PATH="$CONFIG_DIR/tool.json"

PROJECT_ROOT="$PROJECT_ROOT" PORT="$PORT" PUBLIC_BASE_URL="$PUBLIC_BASE_URL" CONFIG_PATH="$CONFIG_PATH" AUTH_PATH="$AUTH_PATH" TOOL_PATH="$TOOL_PATH" node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const path = require("node:path");

  const configPath = process.env.CONFIG_PATH;
  const authPath = process.env.AUTH_PATH;
  const toolPath = process.env.TOOL_PATH;
  const projectRoot = path.resolve(process.env.PROJECT_ROOT);
  const port = Number(process.env.PORT);
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;

  const readJson = (filePath) => {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch { return {}; }
  };

  const existingConfig = readJson(configPath);
  const existingAuth = readJson(authPath);
  const existingTool = readJson(toolPath);
  const ownerToken = typeof existingAuth.ownerToken === "string" && existingAuth.ownerToken.length >= 16
    ? existingAuth.ownerToken
    : crypto.randomBytes(32).toString("base64url");

  const config = {
    ...existingConfig,
    host: "127.0.0.1",
    port,
    allowedRoots: [projectRoot],
    publicBaseUrl,
    subagents: existingConfig.subagents === true
  };
  const tool = {
    ...existingTool,
    host: "127.0.0.1",
    port,
    runtimeCommand: "DEVSPACE_TOOL_MODE=full devspace serve",
    runtimeProcessMatch: "devspace.*serve",
    usdJpyRate: Number(existingTool.usdJpyRate) > 0 ? Number(existingTool.usdJpyRate) : 160
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {mode: 0o600});
  fs.writeFileSync(authPath, JSON.stringify({...existingAuth, ownerToken}, null, 2) + "\n", {mode: 0o600});
  fs.writeFileSync(toolPath, JSON.stringify(tool, null, 2) + "\n", {mode: 0o600});
  fs.chmodSync(configPath, 0o600);
  fs.chmodSync(authPath, 0o600);
  fs.chmodSync(toolPath, 0o600);
'

info "Start DevSpace"
PID_PATH="$CONFIG_DIR/devspace.pid"
LOG_PATH="$CONFIG_DIR/devspace.log"

if port_is_open; then
  printf 'DevSpace is already listening on port %s.\n' "$PORT"
else
  nohup env DEVSPACE_TOOL_MODE=full "$DEVSPACE_BIN" serve >"$LOG_PATH" 2>&1 &
  printf '%s\n' "$!" >"$PID_PATH"

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    port_is_open && break
    sleep 1
  done
fi

port_is_open || {
  printf 'DevSpace did not start. Log: %s\n' "$LOG_PATH" >&2
  [[ -f "$LOG_PATH" ]] && tail -n 40 "$LOG_PATH" >&2
  exit 1
}

info "Diagnostics"
"$DEVSPACE_BIN" doctor

if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$PUBLIC_MCP_URL" | pbcopy
  CLIPBOARD_NOTE="MCP URL copied to the clipboard."
else
  CLIPBOARD_NOTE="Copy the MCP URL below."
fi

OWNER_COMMAND="python3 -c 'import json,pathlib; print(json.loads((pathlib.Path.home()/\".devspace/auth.json\").read_text())[\"ownerToken\"], end=\"\")' | pbcopy"

printf '\nSetup complete.\n'
printf 'Allowed root: %s\n' "$PROJECT_ROOT"
printf 'Local MCP:   http://127.0.0.1:%s/mcp\n' "$PORT"
printf 'Public MCP:  %s\n' "$PUBLIC_MCP_URL"
printf 'Log:         %s\n' "$LOG_PATH"
printf '%s\n' "$CLIPBOARD_NOTE"
printf '\nOwner PasswordをmacOSのclipboardへ入れる安全なコマンド:\n%s\n' "$OWNER_COMMAND"
printf '\nNext: ChatGPT Settings -> Security and login -> Developer mode, then add a developer-mode App with the Public MCP URL.\n'

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${NAOBRAIN_SERVICE_NAME:-gpt-agent-ec2.service}"
CREDENTIAL_DIR="/etc/gae-naobrain"
DROPIN_DIR="/etc/systemd/system/${SERVICE_NAME}.d"
DATA_DIR="/home/ubuntu/.local/share/devspace/naobrain-today"
DRIVE_REMOTE="${DEVSPACE_NAOBRAIN_DRIVE_REMOTE:-grive:}"
DRIVE_BASE_PATH="${DEVSPACE_NAOBRAIN_DRIVE_BASE_PATH:-NaoBrain/Today}"
DEFAULT_MODEL="${DEVSPACE_NAOBRAIN_GEMINI_MODEL:-gemini-3.1-flash-lite}"

for command in node npm curl openssl rclone sudo systemctl tailscale; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing command: $command" >&2; exit 1; }
done

printf 'Gemini API key: '
IFS= read -r -s GEMINI_API_KEY
printf '\n'
if [[ ${#GEMINI_API_KEY} -lt 32 ]]; then
  echo "Gemini API key is too short." >&2
  exit 1
fi

read -r -p "Gemini model ID [${DEFAULT_MODEL}]: " GEMINI_MODEL
GEMINI_MODEL="${GEMINI_MODEL:-$DEFAULT_MODEL}"

printf 'Validating Gemini key and model... '
GEMINI_API_KEY="$GEMINI_API_KEY" GEMINI_MODEL="$GEMINI_MODEL" node <<'NODE'
const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL;
const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
      generationConfig: { maxOutputTokens: 8, temperature: 0 },
    }),
    signal: AbortSignal.timeout(20000),
  },
);
if (!response.ok) {
  const body = await response.text();
  console.error(`\nGemini validation failed: HTTP ${response.status} ${body.slice(0, 320)}`);
  process.exit(1);
}
console.log("ok");
NODE

BRIDGE_TOKEN="$(openssl rand -hex 32)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
umask 077
printf '%s' "$GEMINI_API_KEY" >"$TMP_DIR/gemini-api-key"
printf '%s' "$BRIDGE_TOKEN" >"$TMP_DIR/bridge-token"

cat >"$TMP_DIR/50-naobrain-today.conf" <<EOF
[Service]
LoadCredential=naobrain-gemini-api-key:${CREDENTIAL_DIR}/gemini-api-key
LoadCredential=naobrain-bridge-token:${CREDENTIAL_DIR}/bridge-token
Environment=DEVSPACE_NAOBRAIN_GEMINI_API_KEY_FILE=%d/naobrain-gemini-api-key
Environment=DEVSPACE_NAOBRAIN_BRIDGE_TOKEN_FILE=%d/naobrain-bridge-token
Environment=DEVSPACE_NAOBRAIN_GEMINI_MODEL=${GEMINI_MODEL}
Environment=DEVSPACE_NAOBRAIN_TODAY_DIR=${DATA_DIR}
Environment=DEVSPACE_NAOBRAIN_TODAY_PROMPT_FILE=${DATA_DIR}/config/prompt.md
Environment=DEVSPACE_NAOBRAIN_DRIVE_REMOTE=${DRIVE_REMOTE}
Environment=DEVSPACE_NAOBRAIN_DRIVE_BASE_PATH=${DRIVE_BASE_PATH}
EOF

sudo install -d -m 700 "$CREDENTIAL_DIR" "$DROPIN_DIR"
sudo install -m 600 "$TMP_DIR/gemini-api-key" "$CREDENTIAL_DIR/gemini-api-key"
sudo install -m 600 "$TMP_DIR/bridge-token" "$CREDENTIAL_DIR/bridge-token"
sudo install -m 644 "$TMP_DIR/50-naobrain-today.conf" "$DROPIN_DIR/50-naobrain-today.conf"
install -d -m 700 "$DATA_DIR"

cd "$ROOT_DIR"
NODE_OPTIONS=--max-old-space-size=1024 npm run build
sudo systemctl daemon-reload
sudo systemctl restart "$SERVICE_NAME"

printf 'Checking local bridge... '
for _ in {1..20}; do
  if curl -fsS \
    -H "x-naobrain-bridge-token: ${BRIDGE_TOKEN}" \
    "http://127.0.0.1:7676/naobrain-today/health" \
    >"$TMP_DIR/health.json"; then
    break
  fi
  sleep 1
done
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!j.ok)process.exit(1);console.log(`ok (${j.model}, Drive=${j.driveConfigured})`)' "$TMP_DIR/health.json"

DNS_NAME="$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.Self?.DNSName||"").replace(/\.$/,""))})')"
PUBLIC_BASE="https://${DNS_NAME}/naobrain-api"

echo
echo "Local storage: ${DATA_DIR}"
echo "Google Drive: ${DRIVE_REMOTE}${DRIVE_BASE_PATH}"
echo "Prompt file: ${DATA_DIR}/config/prompt.md"
echo
echo "The public bridge is not enabled automatically. To expose only this API path, run:"
echo "  sudo tailscale funnel --bg --yes --set-path=/naobrain-api http://127.0.0.1:7676/naobrain-today"
echo
echo "Then configure Cloudflare Pages secrets without displaying the token:"
echo "  NAOBRAIN_GAE_URL=${PUBLIC_BASE}"
echo "  NAOBRAIN_GAE_TOKEN=(contents of ${CREDENTIAL_DIR}/bridge-token)"
echo
echo "Do not paste the key or bridge token into chat, copy.txt, Git, or source files."

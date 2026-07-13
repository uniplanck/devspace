<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-logo-light.png" alt="DevSpace logo" width="140">
  </picture>
</p>

<h1 align="center">DevSpace</h1>

<p align="center">A self-hosted MCP server that lets ChatGPT work with approved development folders on your Mac or Linux machine.</p>

<p align="center">
  <a href="README.md">日本語</a> ｜ <strong>English</strong>
</p>

> [!IMPORTANT]
> DevSpace can read, edit, search, and run Terminal commands inside approved local folders. Start with one specific project folder. Do not allow your entire home directory or folders containing credentials.

## What it does

After connecting DevSpace, ChatGPT can:

- read, create, and edit files
- search source code and inspect directories
- run tests, builds, Git inspection, and package scripts
- create isolated Git worktrees for parallel tasks
- follow project rules in `AGENTS.md` and `CLAUDE.md`
- discover local skills and optional subagents
- show token usage, estimated API cost, and workspace analytics

The optional macOS **DevSpace Tool** provides:

- Automatic / English / Japanese UI switching
- Overview, Analytics, Runtime, Folders, and Settings screens
- runtime status plus optional start/stop controls
- approved-root visibility
- token, call, and estimated API-cost analytics
- Aurora, Monochrome, and Minimal themes
- safe copy actions for the MCP URL, diagnostics command, and Owner Password retrieval command

## Fastest setup: macOS + Tailscale Funnel

DevSpace listens only on `127.0.0.1:7676`. Tailscale Funnel publishes that local endpoint through HTTPS.

ChatGPT Web must reach the MCP server from the internet. Use **Tailscale Funnel**, not tailnet-only Tailscale Serve. The Funnel URL is public, but DevSpace still requires Owner Password approval before access is granted.

### Requirements

- macOS 14+ or Linux
- Git
- Node.js `>=22.19 <27`
- npm
- a Tailscale account
- a ChatGPT environment that supports Developer mode and custom Apps

Check your tools:

```bash
node -v && npm -v && git --version
```

macOS Node.js example:

```bash
brew install node@22 && brew link --overwrite --force node@22
```

### 1. Install and sign in to Tailscale

On macOS, use a Tailscale build that provides CLI access and supports Funnel.

Homebrew example:

```bash
brew install --cask tailscale-app && open -a Tailscale
```

After signing in:

```bash
tailscale status
```

### 2. Clone and run the guided setup

Replace `~/Projects` with the folder ChatGPT is allowed to access.

```bash
git clone https://github.com/uniplanck/devspace.git ~/devspace && cd ~/devspace && ./scripts/quickstart-tailscale.sh ~/Projects
```

The script:

1. validates Node.js, Git, npm, and Tailscale
2. runs `npm ci`, typecheck, tests, and build
3. registers the `devspace` command with `npm link`
4. maps Tailscale Funnel to port `7676`
5. creates `~/.devspace/config.json` and `auth.json` with mode `600`
6. starts DevSpace in Full tool mode in the background
7. prints the public `https://<device>.<tailnet>.ts.net/mcp` URL
8. copies the MCP URL on macOS

The first Funnel command may open a browser approval page.

### 3. Verify the runtime

```bash
cd ~/devspace && ./scripts/devspace-control.sh status
```

Expected state:

- DevSpace runtime: `ONLINE`
- Local MCP: `http://127.0.0.1:7676/mcp`
- Public MCP: `https://xxxx.ts.net/mcp`
- no critical failure from `devspace doctor`

### 4. Connect ChatGPT

Current OpenAI setup flow:

1. Open **Settings → Security and login**.
2. Enable **Developer mode**.
3. Open **Settings → Plugins** or the Plugins page.
4. Select `+` and create a developer-mode App.
5. Enter the MCP server URL printed by the script:

```text
https://<device>.<tailnet>.ts.net/mcp
```

6. Complete the DevSpace approval page using the Owner Password.

Do not paste the Owner Password into a README, issue, or chat. On macOS, copy it directly from the local auth file:

```bash
python3 -c 'import json,pathlib; print(json.loads((pathlib.Path.home()/".devspace/auth.json").read_text())["ownerToken"], end="")' | pbcopy
```

Linux display command:

```bash
python3 -c 'import json,pathlib; print(json.loads((pathlib.Path.home()/".devspace/auth.json").read_text())["ownerToken"])'
```

### 5. Test the connection safely

Ask ChatGPT:

```text
Use DevSpace to list only the approved workspace candidates. Do not modify files or run Terminal commands.
```

Then test a repository in read-only mode:

```text
Open <absolute-project-path> as a workspace and report git branch, git status --short, and the latest commit. Do not modify, commit, push, or deploy anything.
```

## Daily commands

Start:

```bash
cd ~/devspace && ./scripts/devspace-control.sh start
```

Stop DevSpace:

```bash
cd ~/devspace && ./scripts/devspace-control.sh stop
```

Stop DevSpace and reset Funnel:

```bash
cd ~/devspace && ./scripts/devspace-control.sh stop --with-funnel
```

Status:

```bash
cd ~/devspace && ./scripts/devspace-control.sh status
```

Logs:

```bash
cd ~/devspace && ./scripts/devspace-control.sh logs
```

Copy the MCP URL:

```bash
cd ~/devspace && ./scripts/devspace-control.sh url
```

Copy the safe Owner Password retrieval command:

```bash
cd ~/devspace && ./scripts/devspace-control.sh owner-cmd
```

## DevSpace Tool for macOS

```bash
cd ~/devspace/extensions/devspace-tool && ./build-macos.sh && open ".build/DevSpace Tool.app"
```

Use **Settings → Language** to switch between `Automatic / English / 日本語` immediately.

Optional runtime configuration in `~/.devspace/tool.json`:

```json
{
  "host": "127.0.0.1",
  "port": 7676,
  "runtimeCommand": "DEVSPACE_TOOL_MODE=full devspace serve",
  "runtimeProcessMatch": "devspace.*serve",
  "usdJpyRate": 160
}
```

## Manual setup

```bash
git clone https://github.com/uniplanck/devspace.git ~/devspace
cd ~/devspace
npm ci
npm run typecheck
npm test
npm run build
npm link
devspace init
tailscale funnel --bg 7676
DEVSPACE_TOOL_MODE=full devspace serve
```

During `devspace init`, enter:

- the project folder(s) ChatGPT may access
- port `7676`
- the public origin `https://xxxx.ts.net` without `/mcp`

Register the same URL with `/mcp` appended in ChatGPT.

## Update

```bash
cd ~/devspace && git pull --ff-only && npm ci && npm run typecheck && npm test && npm run build && npm link
./scripts/devspace-control.sh stop && ./scripts/devspace-control.sh start
```

## Security rules

- keep `allowedRoots` narrow
- never commit `~/.devspace/auth.json`
- never paste Owner Passwords, tokens, cookies, or private keys into chat
- begin with read-only connection tests
- use `AGENTS.md` to require approval for main pushes, production deploys, billing actions, destructive database operations, and external messages
- stop DevSpace and Funnel when they are not needed
- connect only to MCP servers you have reviewed and trust

## Troubleshooting

Connection failure:

```bash
./scripts/devspace-control.sh status
tailscale funnel status
devspace doctor
```

Check that:

- DevSpace is listening on `127.0.0.1:7676`
- the public URL uses HTTPS
- the ChatGPT URL ends with `/mcp`
- Tailscale Funnel is active
- MagicDNS, HTTPS, and Funnel permissions are enabled
- initial public DNS propagation has completed

A `401` before Owner Password approval is expected.

Native dependency error:

```bash
cd ~/devspace && npm rebuild better-sqlite3 && npm run build && devspace doctor
```

Reconfigure:

```bash
devspace init --force
```

## Main CLI commands

```text
devspace serve
devspace init
devspace init --force
devspace doctor
devspace config get
devspace config set publicBaseUrl <url|null>
devspace agents ls
devspace jobs ls
devspace computer doctor
```

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run start
```

## Credits

This repository is a fork of [Waishnav/devspace](https://github.com/Waishnav/devspace). Thanks to the original author and contributors.

License: MIT

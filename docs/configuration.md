# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Experimental. Exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation and shell tools are hidden. |

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `DEVSPACE_TOOL_MODE` and always uses
its fixed short tool names regardless of `DEVSPACE_TOOL_NAMING`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Opt-in diagnostic mode. Widget UI is attached to exposed workspace, file, edit, and shell tools, which uses substantially more vertical space. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI only to `open_workspace` and `show_changes`. This is the default when full workspace payloads are selected. |
| `off` | Disables widget UI. This is the default in compact mode. |

## Compact payloads and execution-cost estimates

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_OPEN_WORKSPACE_PAYLOAD` | `compact` | Use `compact` for bounded instruction excerpts and smaller skill metadata, or `full` for the v1.0 payload. |
| `DEVSPACE_OPEN_WORKSPACE_INSTRUCTION_CHARS` | `6000` | Maximum characters returned per instruction excerpt; minimum `256`. |
| `DEVSPACE_USAGE_CONTENT` | `compact` | Append `compact` or `full` execution-cost summaries to tool output, or use `off` to hide them. |
| `DEVSPACE_USAGE_HISTORY` | `~/.local/share/devspace/usage-history.jsonl` | Local JSONL destination for non-blocking execution diagnostics. |

Execution diagnostics record observed server duration, Tool call count, error count, retry count,
input/output character volume, and text-token estimates. Token counts are estimates from text handled
by GPT-Agent, not ChatGPT model billing or actual model usage. Run `devspace-runtime costs` through
the existing Bash Tool for the current server-process aggregate.

## GPT-Agent v1.1 feature flags

All v1.1 feature flags default to `0`, so the existing compact Tool catalog and Fast Path remain unchanged.

| Variable | Enables |
| --- | --- |
| `DEVSPACE_SKILL_MATCHER` | `match_skills`, which ranks bounded Skill metadata without loading bodies. |
| `DEVSPACE_COMPOUND_TOOLS` | `project_snapshot`, `focused_context`, and read-only `review_changes`. |
| `DEVSPACE_BUILTIN_PROFILES` | Built-in `explore`, `implement`, `review`, and `design` profiles when Subagents are enabled. |
| `DEVSPACE_DESIGN_AUDIT` | The guarded `design_audit` adapter and three bundled Design Skills. |
| `DEVSPACE_DESIGN_AUDIT_ALLOWED_HOSTS` | Comma-separated exact hosts/origins; defaults to loopback hosts only. |

Feature flag values are strict: `1/0`, `true/false`, `yes/no`, and `on/off` are accepted.
New Tool results include `serverDurationMs`, `payloadCharacters`, `returnedItems`, and `truncated`.

## Runtime reliability commands

Runtime diagnostics are integrated into the existing Bash Tool instead of increasing the model-facing
MCP Tool catalog. These exact commands are intercepted by DevSpace and do not start a login shell:

| Bash command | Purpose |
| --- | --- |
| `devspace-runtime diagnose [--github] [command ...]` | Classifies workspace access, Git detection, executable discovery, safe PATH fallbacks, and optional GitHub CLI authentication without returning credentials. |
| `devspace-runtime smoke` | Runs bounded read-only checks for list/read/search, shell PATH resolution, Git, and MCP App resources. |
| `devspace-runtime costs` | Returns observed duration, calls, errors, retries, character volume, and estimated text tokens from the current server process. |
| `devspace-runtime jobs start <preset> [--title <title>]` | Starts a persistent background verification job using `typecheck`, `test`, `build`, `git-status`, or `runtime-smoke`. |
| `devspace-runtime jobs start browser-loop --goal <goal> [--max-steps <1-60>] [--provider <provider>] [--model <model>] [--download-group <group>]` | Starts a bounded Browser Computer loop. Every step is re-grounded from a screenshot and DOM inspection; sensitive actions stop in `waiting_approval`. Downloads are grouped under the policy download root. |
| `devspace-runtime jobs list` | Lists recent jobs for the open workspace. |
| `devspace-runtime jobs show <id> [--events]` | Returns current progress and optionally the latest bounded event log. |
| `devspace-runtime jobs cancel <id>` | Requests cancellation of an active job in the same workspace. Cancelling an approval-waiting browser job also cancels its unresolved approval request. |
| `devspace-runtime jobs resume <id>` | Resumes an interrupted job or an approval-waiting browser job after the local approval has been executed. |
| `devspace-runtime computer doctor` | Reports Browser/Desktop Computer Use readiness without starting automation. |
| `devspace-runtime computer policy` | Returns the non-secret Computer Use allowlist and confirmation policy. |
| `devspace-runtime computer browser login [url]` | Opens the isolated browser profile without CDP for one-time manual sign-in. Close this window before starting automation. |
| `devspace-runtime computer browser start\|status\|stop` | Controls the isolated Brave/Chrome CDP session after policy enablement. |
| `devspace-runtime computer browser open <url>` | Navigates only to an HTTPS or loopback URL whose hostname matches the policy allowlist. |
| `devspace-runtime computer browser inspect\|screenshot` | Returns bounded interactive-element metadata or a current PNG screenshot. |
| `devspace-runtime computer browser click <x> <y>` | Clicks a safe element or creates a local human-approval request for sensitive actions. |
| `devspace-runtime computer browser type <text>` | Types into a focused non-credential field; password and credential-like fields are rejected. |
| `devspace-runtime computer browser key <key>` | Sends a bounded navigation key; Enter is approval-gated when form submission confirmation is enabled. |
| `devspace-runtime computer browser scroll <dx> <dy>` | Scrolls the active page using bounded deltas. |
| `devspace-runtime computer browser approvals` | Lists pending local approval requests without executing them. |
| `devspace-runtime finder <path>` | On macOS, opens a validated workspace directory or reveals a validated file in Finder after an explicit request. |

Shell execution augments the inherited PATH with existing standard locations such as
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, and system binary directories. It does not
source `.zshrc`, `.zprofile`, or another login-shell configuration, avoiding startup side effects.

When Widgets are enabled and the host advertises server-Tool support, Tool cards with a workspace
path display a link-style **Finderで表示** action. The App calls the app-only `open_in_finder` Tool;
it is hidden from the model-facing catalog. If the host cannot execute the action, the control is
removed instead of leaving a non-functional button. The server validates the path against the workspace
before invoking macOS Finder. Paths outside the approved workspace are rejected by the normal root guard.

Parallel jobs are persisted in the local SQLite state database. The default concurrency is three
jobs and may be changed from one to eight with `DEVSPACE_JOB_CONCURRENCY`. Jobs survive server
restarts because the worker process is detached; stale running records are marked `interrupted`
when their process is no longer present. Arbitrary shell text is not accepted by the job API.
Browser-loop goals and bounded step histories are stored as private JSON in the same database.
The planner defaults to Hermes' configured provider and model; `DEVSPACE_BROWSER_PLANNER_PROVIDER`
and `DEVSPACE_BROWSER_PLANNER_MODEL`, or per-job `--provider` and `--model`, may override routing.

For a quick regression check after a host-model rollout, run `devspace-runtime smoke` through Bash or:

```bash
npm run test:runtime
```

## Computer Use safety foundation

Computer Use remains disabled until a policy is explicitly enabled. For a safe ChatGPT-only preset:

```bash
devspace computer enable-chatgpt
devspace computer doctor
devspace computer policy
```

This preset allows only `chatgpt.com`, disables Desktop Computer Use, enables downloads, and keeps
login, submit, upload, download, purchase, delete, and external communication behind local approval.

The default policy requires confirmation for login, submission, upload, download, purchase,
delete, and external communication; stores no raw credentials; uses a separate persistent browser profile;
and has empty browser-domain and desktop-application allowlists. Run `devspace computer browser login`
for the initial manual sign-in without remote debugging; cookies remain in the isolated profile and are
reused by later automation sessions. Browser Computer uses the
Node.js native WebSocket/fetch implementation and Chrome DevTools Protocol directly, so it does
not download another browser or require Playwright. The isolated browser profile may retain its
own cookies after the user logs in manually; GPT-Agent refuses to type password or credential-like
fields and does not return input values in inspection results.

Sensitive clicks and Enter-based submissions create a short-lived approval request. ChatGPT can
list the request but cannot execute it through the built-in runtime command. Approval is performed
from the local GPT-Agent Tool app and is followed by a native macOS confirmation dialog. A browser-loop
job then remains in `waiting_approval` until explicitly resumed; it does not poll through or bypass the
approval boundary. Screenshot artifacts, session state, approvals, and bounded step history are stored
with private permissions under `~/.devspace`. Browser downloads default to
`~/Downloads/GPT-Agent/<group>/<YYYY-MM-DD>/<job>/`; `--download-group` controls the group portion.
Top-level navigation is revalidated after redirects and is reset to `about:blank` if it leaves the
allowlist.

Design Audit remains a separate adapter: the Browser Computer CDP session is not silently reused
for design auditing, axe analysis, or authenticated page inspection.

Skills may optionally declare bounded `short-description`, `triggers`, and `required-tools`
frontmatter for matching. Existing `name` and `description` metadata remains fully compatible;
only a selected Skill is activated by reading its `SKILL.md`.

## Approved shell aliases

`DEVSPACE_APPROVED_SHELL_COMMANDS_FILE` may point to a local JSON file. The
default is `~/.devspace/approved-shell-commands.json`. An alias is invoked as
`devspace-approved <alias>` and is accepted only when its configured
`workspaceRoot` exactly matches the open workspace. Its optional
`workingDirectory` must remain inside that root.

```json
{
  "commands": [
    {
      "alias": "verify",
      "workspaceRoot": "/absolute/project/path",
      "workingDirectory": ".",
      "command": "npm test"
    }
  ]
}
```

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_SUBAGENTS` | Set to `1` to expose configured agent profiles as Subagents. Experimental and disabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/thinking levels so the host model can choose an
agent without reading provider-specific launch details. `devspace agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagent-delegation`
skill teaches the model to use only the minimal `devspace agents ls`,
`devspace agents run`, and `devspace agents show` workflow.

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @waishnav/devspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.

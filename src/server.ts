import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { applyPatch } from "./apply-patch.js";
import { formatChatProgressResult, updateChatProgress } from "./chat-progress.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  sessionIdPrefix,
} from "./logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import {
  appendUsageToContent,
  editInputChars,
  estimateFileChars,
  recordObservedToolUsage,
  runWithUsageSession,
  textContentChars,
} from "./usage-meter.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { summarizeLocalAgentProfile } from "./local-agent-profiles.js";
import {
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
  type LocalAgentProviderAvailability,
} from "./local-agent-availability.js";
import { registerV11Tools } from "./register-v11-tools.js";

type Transport = StreamableHTTPServerTransport;
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const INTERNAL_MCP_PATH = "/mcp-internal";
const INTERNAL_MCP_HEADER = "x-devspace-internal-key";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderAvailability[];
  close(): void;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace" || kind === "show_changes";
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
    },
  };
}

const toolNames = {
  reportProgress: "report_progress",
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
} as const;

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

function serverInstructions(config: ServerConfig): string {
  const progressInstruction = ` For any task expected to use two or more workspace tools or take more than thirty seconds, call ${toolNames.reportProgress} before the first substantive workspace action with a short chatLabel, overallProgress 0, the current task, and an initial estimateMinutes. Update it at meaningful milestones and call it again with status completed or failed before the final response. The ${toolNames.reportProgress} result is the canonical fixed-format progress update: do not paraphrase it, rename its fields, reorder its rows, or replace it with free-form progress narration. Keep raw tool narration out of the user-facing response. After the completion progress call, the final user-facing response must always use exactly these headings in this order: \"## 完了結果\", \"## 変更\", \"## 検証\", \"## 残り\", and \"## 実行情報\". Never rename or omit a heading; write \"なし\" when a section has no content. Under \"## 実行情報\", report overall progress, elapsed time, estimated input/output tokens, and the GPT-5.6 API-conversion yen estimate using the latest returned values, and explicitly state that the estimate covers GAG/GAE MCP tool traffic rather than the full Chat or ChatGPT billing.`;
  const showChangesInstruction =
    config.widgets === "changes"
      ? " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs."
      : "";

  if (config.toolMode === "codex") {
    return `Use DevSpace as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree and reuse its workspaceId. Use ${toolNames.read} for direct file reads, apply_patch for all file modifications, exec_command for inspection, tests, builds, and other commands, and write_stdin to poll or interact with running processes. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${progressInstruction}${showChangesInstruction}`;
  }

  const inspection = config.toolMode !== "full"
    ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
    : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";

  const agentsMd = config.openWorkspacePayload === "compact"
    ? `Follow instructions returned by ${toolNames.openWorkspace}. It returns bounded instruction excerpts to keep the initial result small; use ${toolNames.read} to read every path listed in agentsFiles before other project work, and read applicable paths in availableAgentsFiles before working in their scope. `
    : `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;

  return `Use DevSpace as a local coding workspace. Call ${toolNames.openWorkspace} once per project folder or worktree to obtain a workspaceId. Reuse that same workspaceId for all later file, search, edit, write, show-changes, and shell tools in that folder; do not call ${toolNames.openWorkspace} again unless switching folders/worktrees, changing checkout/worktree mode, the workspaceId is rejected as unknown, or the user explicitly asks to reopen. ${agentsMd}${skills}${inspection}Prefer ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not create or modify files with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files.${progressInstruction}${showChangesInstruction}`;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerAvailable?: boolean;
  providerUnavailableReason?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const thinking = agent.thinking ? `, thinking ${agent.thinking}` : "";
  const availability = agent.providerAvailable === false
    ? `, unavailable: ${agent.providerUnavailableReason ?? "provider unavailable"}`
    : "";
  return `${agent.name} (${agent.provider}${model}${thinking}${availability})`;
}

function formatUnavailableAgentProvider(provider: LocalAgentProviderAvailability): string {
  return `${provider.name} (${provider.reason ?? "unavailable"})`;
}

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string().optional(),
  characters: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  writeMode: z.enum(["read_only", "allowed"]).optional(),
  providerAvailable: z.boolean().optional(),
  providerUnavailableReason: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function isAuthorizedInternalMcpRequest(req: Request, configuredSecret: string | null): boolean {
  if (!configuredSecret) return false;

  const hostHeader = req.header("host") ?? "";
  const host = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : hostHeader.split(":", 1)[0];
  if (!host || !["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase())) {
    return false;
  }

  const suppliedSecret = req.header(INTERNAL_MCP_HEADER) ?? "";
  const expected = Buffer.from(configuredSecret);
  const supplied = Buffer.from(suppliedSecret);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  const durationMs = Math.round(performance.now() - startedAt);
  const outputChars = textContentChars(content);
  recordObservedToolUsage({
    tool: fields.tool,
    workspaceId: fields.workspaceId,
    path: fields.path,
    observedChars: outputChars,
    savedChars: 0,
    outputChars,
    durationMs,
    error: true,
  });
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs,
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function compactInstructionContent(content: string, limit: number): {
  content: string;
  truncated: boolean;
} {
  if (content.length <= limit) return { content, truncated: false };

  const marker = "\n\n[... instruction file truncated by GPT-5.6 compact mode; use read with this path for the full file ...]\n\n";
  const available = Math.max(0, limit - marker.length);
  const headLength = Math.ceil(available * 0.7);
  const tailLength = available - headLength;

  return {
    content: `${content.slice(0, headLength)}${marker}${content.slice(content.length - tailLength)}`,
    truncated: true,
  };
}

function redactSensitiveShellCommand(command: string): string {
  const typePrefix = "devspace-runtime computer browser type ";
  if (command.startsWith(typePrefix)) {
    return `${typePrefix}[REDACTED ${Math.max(0, command.length - typePrefix.length)} chars]`;
  }
  const openPrefix = "devspace-runtime computer browser open ";
  if (command.startsWith(openPrefix)) {
    const raw = command.slice(openPrefix.length).trim().replace(/^(["'])|(["'])$/gu, "");
    try {
      const url = new URL(raw);
      url.search = "";
      url.hash = "";
      return `${openPrefix}${url.toString()}`;
    } catch {
      return `${openPrefix}[REDACTED URL]`;
    }
  }
  return command;
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppFallbackHtml(): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GPT-Agent</title>
    <style>
      html,body{margin:0;padding:0;background:transparent;color:inherit;font:13px/1.45 system-ui,sans-serif}
      .fallback{padding:10px 12px;border:1px solid rgba(127,127,127,.25);border-radius:10px;opacity:.75}
    </style>
  </head>
  <body><div class="fallback">UI更新中です。ツール処理自体は完了しています。</div></body>
</html>`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.number().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

function processToolResponse(
  tool: "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: { ...summary, ...outputSummary },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
    },
  };
}

function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
): void {
  registerAppTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a command inside an open workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes. Call open_workspace first and pass workspaceId.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const snapshot = await processSessions.start({
        workspaceId,
        command: cmd,
        cwd,
        workspaceRoot: workspace.root,
        tty,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: cmd,
        commandLength: cmd.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("exec_command", workspaceId, snapshot, {
        command: cmd,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  registerAppTool(
    server,
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait for process output or completion. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const snapshot = await processSessions.write({
        workspaceId,
        sessionId,
        chars,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "write_stdin",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("write_stdin", workspaceId, snapshot, {
        sessionId,
        charactersWritten: chars?.length ?? 0,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );
}

function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  localAgentProviders: LocalAgentProviderAvailability[],
): McpServer {
  const server = new McpServer(
    {
      name: "devspace",
      title: "GPT-Agent",
      version: "1.1.0",
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: serverInstructions(config),
    },
  );

  registerAppResource(
    server,
    "DevSpace Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing DevSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      let template: string;
      try {
        await assertWorkspaceAppAssets();
        template = workspaceAppHtml(config);
      } catch {
        template = workspaceAppFallbackHtml();
      }
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: template,
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  server.registerTool(
    toolNames.reportProgress,
    {
      title: "Report progress",
      description:
        "Persist user-facing progress for a long GPT-Agent task so GPT-Agent Tool can show the chat/task label, percentage, current step, elapsed time, ETA, risks, and GPT-5.6 API-conversion cost estimate. Call at task start, meaningful milestones, and completion.",
      inputSchema: {
        chatLabel: z.string().min(1).max(160).describe("Short human-readable chat or task label."),
        workspaceId: z.string().optional().describe("Workspace identifier when one is already open."),
        overallProgress: z.number().min(0).max(100).describe("Overall task progress percentage."),
        currentProgress: z.number().min(0).max(100).optional().describe("Current subtask progress percentage."),
        currentTask: z.string().min(1).max(240).describe("Current user-relevant task."),
        completed: z.string().max(500).optional().describe("Short summary of what is complete."),
        next: z.string().max(500).optional().describe("Short summary of the next action."),
        risk: z.string().max(500).optional().describe("Current blocker or risk, if any."),
        status: z.enum(["running", "paused", "completed", "failed"]).optional(),
        estimateMinutes: z.number().min(1).max(1440).optional().describe("Initial completion estimate in minutes."),
      },
      outputSchema: {
        result: z.string(),
        id: z.string(),
        overallProgress: z.number(),
        currentProgress: z.number(),
        elapsedSeconds: z.number(),
        remainingSeconds: z.number().optional(),
        estimatedJpy: z.number(),
        estimatedJpyMax: z.number(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, extra) => {
      const workspace = input.workspaceId
        ? workspaces.getWorkspace(input.workspaceId)
        : undefined;
      const record = updateChatProgress({
        sessionId: extra.sessionId,
        chatLabel: input.chatLabel,
        workspaceId: input.workspaceId,
        workspaceRoot: workspace?.root,
        overallProgress: input.overallProgress,
        currentProgress: input.currentProgress,
        currentTask: input.currentTask,
        completed: input.completed,
        next: input.next,
        risk: input.risk,
        status: input.status,
        estimateMinutes: input.estimateMinutes,
      });
      const result = formatChatProgressResult(record);
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          id: record.id,
          overallProgress: record.overallProgress,
          currentProgress: record.currentProgress,
          elapsedSeconds: record.elapsedSeconds,
          remainingSeconds: record.remainingSeconds,
          estimatedJpy: record.sessionEstimatedJpy,
          estimatedJpyMax: record.sessionEstimatedJpyMax ?? record.sessionEstimatedJpy,
        },
      };
    },
  );

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a local project directory as a coding workspace. Call this once per project folder or worktree before reading, editing, searching, writing, showing changes, or running commands. Reuse the returned workspaceId for later calls in the same folder. In compact mode, instruction files are returned as bounded excerpts and can be read in full through the read tool.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a local project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout. Use checkout to work in the actual directory. Use worktree to create an isolated managed Git worktree for parallel work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
        availableAgentsFilesTotal: z.number().int().nonnegative(),
        availableAgentsFilesTruncated: z.boolean(),
        skills: z.array(workspaceSkillOutputSchema),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema),
        agents: z.array(workspaceLocalAgentOutputSchema),
        skillDiagnostics: z.array(z.unknown()),
        instruction: z.string(),
        metrics: z.object({
          compact: z.boolean(),
          serverDurationMs: z.number().int().nonnegative(),
          payloadCharacters: z.number().int().nonnegative(),
          fullInstructionCharacters: z.number().int().nonnegative(),
          returnedInstructionCharacters: z.number().int().nonnegative(),
        }),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }) => {
      const startedAt = performance.now();
      const compact = config.openWorkspacePayload === "compact";
      const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.openWorkspace({ path, mode, baseRef });

      if (config.widgets === "changes") {
        void reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        });
      }

      const visibleSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => compact
          ? {
              name: skill.name,
              path: formatPathForPrompt(skill.filePath),
            }
          : {
              name: skill.name,
              description: skill.description,
              path: formatPathForPrompt(skill.filePath),
            });

      const visibleAgentProviders = config.subagents ? localAgentProviders : [];
      const visibleAgents = workspace.agentProfiles.map((profile) => {
        const summary = summarizeLocalAgentProfile(profile);
        const availability = visibleAgentProviders.find((provider) => provider.name === summary.provider);
        return {
          ...summary,
          providerAvailable: availability?.available,
          providerUnavailableReason: availability?.reason,
        };
      });

      const loadedAgentsFiles = agentsFiles.map((file) => {
        const formattedPath = formatAgentsPath(file.path, workspace.root);
        if (!compact) {
          return {
            path: formattedPath,
            content: file.content,
          };
        }

        const excerpt = compactInstructionContent(
          file.content,
          config.openWorkspaceInstructionChars,
        );
        return {
          path: formattedPath,
          content: excerpt.content,
          characters: file.content.length,
          truncated: excerpt.truncated,
        };
      });

      const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));

      const instruction = compact
        ? "Use this workspaceId for later calls in this project. Treat agentsFiles content as excerpts and read every listed path in full before other project work. Read applicable availableAgentsFiles before working in their nested scope. Read a skill only when the task matches it."
        : config.skillsEnabled
          ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
          : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";

      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            `Opened workspace ${workspace.id}`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            compact ? "Payload: compact" : "Payload: full",
            loadedAgentsFiles.length > 0
              ? compact
                ? `Instruction files: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
                : `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? compact
                ? `Nested instruction files: ${availableAgentsFileOutputs.length}`
                : `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `${compact ? "Skills" : "Available skills"}: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            !compact && visibleAgentProviders.some((provider) => provider.available)
              ? `Available subagent providers: ${visibleAgentProviders.filter((provider) => provider.available).map((provider) => provider.name).join(", ")}`
              : undefined,
            !compact && visibleAgentProviders.some((provider) => !provider.available)
              ? `Unavailable subagent providers: ${visibleAgentProviders.filter((provider) => !provider.available).map(formatUnavailableAgentProvider).join(", ")}`
              : undefined,
            !compact && visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];

      const fullInstructionCharacters = agentsFiles.reduce(
        (total, file) => total + file.content.length,
        0,
      );
      const returnedInstructionCharacters = loadedAgentsFiles.reduce(
        (total, file) => total + (file.content?.length ?? 0),
        0,
      );
      const serverDurationMs = Math.round(performance.now() - startedAt);
      const structuredContent = {
        workspaceId: workspace.id,
        root: workspace.root,
        mode: workspace.mode,
        sourceRoot: workspace.sourceRoot,
        worktree: workspace.worktree,
        agentsFiles: loadedAgentsFiles,
        availableAgentsFiles: availableAgentsFileOutputs,
        availableAgentsFilesTotal: availableAgentsFiles.length,
        availableAgentsFilesTruncated: availableAgentsFileOutputs.length < availableAgentsFiles.length,
        skills: visibleSkills,
        agentProviders: visibleAgentProviders,
        agents: visibleAgents,
        skillDiagnostics: compact ? [] : workspace.skillDiagnostics,
        instruction,
        metrics: {
          compact,
          serverDurationMs,
          payloadCharacters: 0,
          fullInstructionCharacters,
          returnedInstructionCharacters,
        },
      };
      structuredContent.metrics.payloadCharacters = JSON.stringify(structuredContent).length;

      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: serverDurationMs,
      });

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            summary: {
              compact,
              payloadCharacters: structuredContent.metrics.payloadCharacters,
              fullInstructionCharacters,
              returnedInstructionCharacters,
              agentsFiles: loadedAgentsFiles.length,
              availableAgentsFiles: availableAgentsFileOutputs.length,
              availableAgentsFilesTotal: availableAgentsFiles.length,
              skills: visibleSkills.length,
              agentProviders: visibleAgentProviders.length,
              agents: visibleAgents.length,
              skillDiagnostics: compact ? 0 : workspace.skillDiagnostics.length,
            },
          },
        },
        structuredContent,
      };
    },
  );

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read a file inside an open workspace. Use this for file inspection instead of shell commands like cat or sed. Call open_workspace first and pass workspaceId.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      const observedChars = textContentChars(response.content);
      const savedChars = input.offset !== undefined || input.limit !== undefined
        ? Math.max(0, estimateFileChars(readPath.absolutePath) - observedChars)
        : 0;
      const usage = recordObservedToolUsage({
        tool: toolNames.read,
        workspaceId,
        workspaceRoot: workspace.root,
        path: input.path,
        observedChars,
        savedChars,
        inputChars: String(input.path).length,
        outputChars: observedChars,
        durationMs: Math.round(performance.now() - startedAt),
      });
      const content = appendUsageToContent(response.content, usage, config.usageContent);
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        content,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content },
          },
        },
        structuredContent: {
          result: contentText(content),
        },
      };
    },
  );

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Create or completely overwrite a file inside an open workspace. Prefer ${toolNames.edit} for targeted changes to existing files. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      const usage = recordObservedToolUsage({
        tool: toolNames.write,
        workspaceId,
        workspaceRoot: workspace.root,
        path: input.path,
        observedChars: input.content.length + textContentChars(response.content),
        savedChars: 0,
        inputChars: input.content.length,
        outputChars: textContentChars(response.content),
        durationMs: Math.round(performance.now() - startedAt),
      });
      const content = appendUsageToContent(response.content, usage, config.usageContent);
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        content,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit one file inside an open workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique. Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      const observedChars = editInputChars(input.edits) + textContentChars(editContent);
      const savedChars = Math.max(0, estimateFileChars(targetPath) * 2 - observedChars);
      const usage = recordObservedToolUsage({
        tool: toolNames.edit,
        workspaceId,
        workspaceRoot: workspace.root,
        path: input.path,
        observedChars,
        savedChars,
        inputChars: editInputChars(input.edits),
        outputChars: textContentChars(editContent),
        durationMs: Math.round(performance.now() - startedAt),
      });
      const content = appendUsageToContent(editContent, usage, config.usageContent);
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(content),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerAppTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description:
          "Apply one Codex-style patch inside an open workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
        },
        outputSchema: resultOutputSchema({
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, patch }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const applied = await applyPatch(workspace.root, patch);
        const paths = applied.files.map((file) => file.path).join(", ");
        const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
        const content = [textBlock(result)];
        const displayPath = applied.files.length === 1
          ? applied.files[0]?.path
          : `${applied.files.length} files`;

        logToolCall(config, {
          tool: "apply_patch",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "apply_patch",
            card: {
              workspaceId,
              path: displayPath,
              summary: {
                files: applied.files.length,
                additions: applied.additions,
                removals: applied.removals,
              },
              payload: { patch: applied.patch },
            },
          },
          structuredContent: {
            result,
            additions: applied.additions,
            removals: applied.removals,
            files: applied.files,
          },
        };
      },
    );
  }

  if (config.widgets === "changes") {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show aggregate file changes for an open workspace. If the current turn successfully modified files, call this exactly once after the final related file change and before your final response so the user can inspect the combined diff for the turn. Do not call it after every individual file change, and do not skip it because prior file-change tools already displayed per-tool diffs.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          since: "last_shown",
          markReviewed: true,
        });

        const content = [textBlock(review.result)];
        logToolCall(config, {
          tool: "show_changes",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "show_changes",
            card: {
              workspaceId,
              summary: review.summary,
              files: review.files,
              payload: {
                patch: review.patch,
              },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );
  }

  if (config.toolMode === "full") {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description:
          "Search file contents inside an open workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        const usage = recordObservedToolUsage({
          tool: toolNames.grep,
          workspaceId,
          workspaceRoot: workspace.root,
          path: input.path,
          observedChars:
            String(input.pattern ?? "").length
            + String(input.path ?? "").length
            + String(input.include ?? "").length
            + textContentChars(response.content),
          savedChars: 0,
          inputChars:
            String(input.pattern ?? "").length
            + String(input.path ?? "").length
            + String(input.include ?? "").length,
          outputChars: textContentChars(response.content),
          durationMs: Math.round(performance.now() - startedAt),
        });
        const content = appendUsageToContent(response.content, usage, config.usageContent);
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          content,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: "Glob",
        description:
          "Find files by glob pattern inside an open workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        const usage = recordObservedToolUsage({
          tool: toolNames.glob,
          workspaceId,
          workspaceRoot: workspace.root,
          path: input.path,
          observedChars:
            String(input.pattern ?? "").length
            + String(input.path ?? "").length
            + textContentChars(response.content),
          savedChars: 0,
          inputChars: String(input.pattern ?? "").length + String(input.path ?? "").length,
          outputChars: textContentChars(response.content),
          durationMs: Math.round(performance.now() - startedAt),
        });
        const content = appendUsageToContent(response.content, usage, config.usageContent);
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          content,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description:
          "List a directory inside an open workspace. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        const usage = recordObservedToolUsage({
          tool: toolNames.ls,
          workspaceId,
          workspaceRoot: workspace.root,
          path: input.path,
          observedChars: String(input.path ?? "").length + textContentChars(response.content),
          savedChars: 0,
          inputChars: String(input.path ?? "").length,
          outputChars: textContentChars(response.content),
          durationMs: Math.round(performance.now() - startedAt),
        });
        const content = appendUsageToContent(response.content, usage, config.usageContent);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          content,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );
  }

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.shell,
    {
      title: "Bash",
      description: config.toolMode !== "full"
        ? `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Built-in commands are available without adding more MCP Tools: devspace-runtime diagnose [--github] [command ...], devspace-runtime smoke, devspace-runtime costs, devspace-runtime jobs start/list/show/cancel/resume, and devspace-runtime finder <path> for an explicit user request. Verification jobs use fixed presets: typecheck, test, build, git-status, and runtime-smoke. The browser-loop preset accepts a bounded goal and must stop for configured local approvals. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`
        : `Run a shell command inside an open workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Built-in commands are available without adding more MCP Tools: devspace-runtime diagnose [--github] [command ...], devspace-runtime smoke, devspace-runtime costs, devspace-runtime jobs start/list/show/cancel/resume, and devspace-runtime finder <path> for an explicit user request. Verification jobs use fixed presets: typecheck, test, build, git-status, and runtime-smoke. The browser-loop preset accepts a bounded goal and must stop for configured local approvals. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. Call open_workspace first and pass workspaceId. This is powerful local execution and should only be exposed behind strong authentication.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        command: z
          .string()
          .describe(
            `Shell command to run. Use devspace-runtime diagnose, smoke, costs, or jobs start/list/show/cancel/resume for built-in diagnostics and bounded jobs; use devspace-runtime finder <path> only on explicit request. Must not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`,
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
        workspaceId,
      });

      const loggedCommand = redactSensitiveShellCommand(input.command);
      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: loggedCommand,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        command: loggedCommand,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      const usage = recordObservedToolUsage({
        tool: toolNames.shell,
        workspaceId,
        workspaceRoot: workspace.root,
        path: workingDirectory ?? ".",
        observedChars: input.command.length + textContentChars(response.content),
        savedChars: 0,
        inputChars: input.command.length,
        outputChars: textContentChars(response.content),
        durationMs: Math.round(performance.now() - startedAt),
      });
      const content = appendUsageToContent(response.content, usage, config.usageContent);
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: loggedCommand,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        content,
        _meta: {
          tool: toolNames.shell,
          card: {
            workspaceId,
            path: workingDirectory,
            summary,
            payload: { content },
          },
        },
        structuredContent: {
          result: contentText(content),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerCodexProcessTools(server, config, workspaces, processSessions);
  }

  registerV11Tools(server, { config, workspaces, localAgentProviders });

  return server;
}

function privateUsageSessionKey(
  req: Request,
  workspaces: WorkspaceRegistry,
  fallback?: string,
): string | undefined {
  const meta = req.body?.params?._meta as Record<string, unknown> | undefined;
  const args = req.body?.params?.arguments as Record<string, unknown> | undefined;
  const conversationCandidates = [
    meta?.["openai/conversation_id"],
    meta?.["openai/conversationId"],
    meta?.["openai/chat_id"],
    meta?.["openai/chatId"],
    meta?.conversation_id,
    meta?.conversationId,
    meta?.chat_id,
    meta?.chatId,
  ];
  const conversationId = conversationCandidates.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );

  let workspaceRoot: string | undefined;
  const workspaceId = typeof args?.workspaceId === "string" ? args.workspaceId.trim() : "";
  if (workspaceId) {
    try {
      workspaceRoot = workspaces.getWorkspace(workspaceId).root;
    } catch {
      workspaceRoot = undefined;
    }
  } else if (
    req.body?.params?.name === "open_workspace"
    && typeof args?.path === "string"
    && args.path.trim()
  ) {
    workspaceRoot = args.path.trim();
  }

  const privateValue = conversationId
    ? `conversation:${conversationId.trim()}`
    : req.auth?.token
      ? `oauth:${req.auth.token}`
      : workspaceRoot
        ? `workspace:${workspaceRoot}`
        : fallback
          ? `transport:${fallback}`
          : undefined;
  return privateValue
    ? createHash("sha256").update(privateValue).digest("hex").slice(0, 32)
    : undefined;
}

export function createServer(config = loadConfig()): RunningServer {
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new Map<string, Transport>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const localAgentProviders = config.subagents
    ? getLocalAgentProviderAvailabilitySnapshot()
    : [];

  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "devspace" });
  });

  const handleMcpRequest = async (req: Request, res: Response): Promise<void> => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.set(newSessionId, transport);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            transports.delete(closedSessionId);
            logEvent(config.logging, "info", "mcp_session_closed", {
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          localAgentProviders,
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await runWithUsageSession(
        privateUsageSessionKey(req, workspaces, sessionId ?? transport.sessionId),
        () => transport.handleRequest(req, res, req.body),
      );
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  };

  app.all(INTERNAL_MCP_PATH, async (req, res) => {
    if (!isAuthorizedInternalMcpRequest(req, config.internalMcpSecret)) {
      res.sendStatus(404);
      return;
    }
    await handleMcpRequest(req, res);
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    await handleMcpRequest(req, res);
  });

  let closed = false;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      if (closed) return;
      closed = true;
      processSessions.shutdown();
      oauthProvider.close();
      workspaceStore.close?.();
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    if (config.subagents) {
      console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
    }
  });

  const shutdown = () => {
    httpServer.close(() => {
      close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

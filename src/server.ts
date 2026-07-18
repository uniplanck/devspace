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
import {
  formatEc2ControlSummary,
  invokeEc2Control,
} from "./ec2-control.js";
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
// PRIVATE_GEX_START
import { GexLearningStore, type GexLearningSyncPayload } from "./gex-learning-store.js";
// PRIVATE_GEX_END
import {
  NaoBrainTodayStore,
  type TodayAnalysisInput,
  type TodayEntryInput,
  type TodayEntryUpdateInput,
} from "./naobrain-today-store.js";
import {
  NaoBrainQuizStore,
  type QuizAnswerInput,
  type QuizSessionMode,
} from "./naobrain-quiz-store.js";

type Transport = StreamableHTTPServerTransport;
const INTERNAL_MCP_PATH = "/mcp-internal";
const INTERNAL_MCP_HEADER = "x-devspace-internal-key";
// PRIVATE_GEX_START
const GEX_LEARNING_BRIDGE_HEADER = "gex-learning-v1";
// PRIVATE_GEX_END
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
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
      return kind === "show_changes";
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
  const progressInstruction = ` MCP cards and raw tool results are implementation details and must never be the only place where user-facing status appears. Before the first substantive GAG/GAE workspace action in every multi-step or file-changing task, send a normal visible commentary message containing an initial time estimate and progress 0%. When ${toolNames.reportProgress} is available, call it at start, meaningful milestones, and completion, then copy its returned Markdown verbatim into a normal visible commentary message; do not rely on the tool card being visible. When ${toolNames.reportProgress} is unavailable, provide the same visible status fields manually and continue rather than omitting progress. Send another visible progress update after roughly two to three workspace calls or fifteen seconds when work continues. Before the final response, call ${toolNames.reportProgress} with status completed or failed when available. The final user-facing response must always use exactly these headings in this order: \"## 完了結果\", \"## 変更\", \"## 検証\", \"## 残り\", and \"## 実行情報\". Never rename or omit a heading; write \"なし\" when a section has no content. Under \"## 実行情報\", paste the completed progress result's final execution table verbatim. If the progress tool is unavailable, reproduce the latest GAG/GAE usage values in a table with task elapsed time, MCP processing time, estimated input/output tokens for this task and this Chat, GPT-5.6 API-conversion yen estimate, tool calls, and errors. Explicitly state that GAG/GAE use is free under the user's current route and that the price is only an API-equivalent estimate, not ChatGPT billing.`;
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
  usageContext: { usageSessionId?: string; workspaceRoot?: string } = {},
): ToolContent[] {
  const durationMs = Math.round(performance.now() - startedAt);
  const outputChars = textContentChars(content);
  const usage = recordObservedToolUsage({
    tool: fields.tool,
    usageSessionId: usageContext.usageSessionId,
    workspaceId: fields.workspaceId,
    workspaceRoot: usageContext.workspaceRoot,
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
  return appendUsageToContent(content, usage, config.usageContent);
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
  todayStore: NaoBrainTodayStore,
  quizStore: NaoBrainQuizStore,
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

  server.registerTool(
    "naobrain_today_append",
    {
      title: "Append NaoBrain Today entry",
      description: "Record a journal, today movement, progress, result, blockage, or plan in NaoBrain Today. Use when the user reports what they did today or asks to save the current movement.",
      inputSchema: {
        title: z.string().min(1).max(140),
        body: z.string().min(1).max(8_000),
        status: z.enum(["done", "doing", "blocked", "planned", "note"]).optional(),
        kind: z.enum(["progress", "result", "plan", "journal", "note"]).optional(),
        project: z.string().max(120).optional(),
        projectId: z.string().max(80).optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
        occurredAt: z.string().optional(),
        startAt: z.string().optional(),
        endAt: z.string().optional(),
        startApproximate: z.boolean().optional(),
        endApproximate: z.boolean().optional(),
        runAi: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const result = await todayStore.append({ ...input, source: "gae" } as TodayEntryInput);
      return {
        content: [textBlock(`NaoBrain Todayへ記録しました: ${result.entry.title}`)],
        structuredContent: { ...result },
      };
    },
  );

  server.registerTool(
    "naobrain_today_update",
    {
      title: "Update NaoBrain Today entry",
      description: "Create a new revision of an existing Today entry while preserving every previous version. Use when the user corrects a journal, project, status, date, time range, tags, or result.",
      inputSchema: {
        id: z.string().min(1).max(80),
        title: z.string().min(1).max(140).optional(),
        body: z.string().min(1).max(8_000).optional(),
        status: z.enum(["done", "doing", "blocked", "planned", "note"]).optional(),
        kind: z.enum(["progress", "result", "plan", "journal", "note"]).optional(),
        project: z.string().max(120).optional(),
        projectId: z.string().max(80).optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
        occurredAt: z.string().optional(),
        startAt: z.string().optional(),
        endAt: z.string().optional(),
        startApproximate: z.boolean().optional(),
        endApproximate: z.boolean().optional(),
        revisionNote: z.string().max(240).optional(),
        runAi: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const result = await todayStore.update({ ...input, source: "gae" } as TodayEntryUpdateInput);
      return {
        content: [textBlock(`NaoBrain Todayをv${result.entry.version}へ修正し、旧版を履歴へ保存しました: ${result.entry.title}`)],
        structuredContent: { ...result },
      };
    },
  );

  server.registerTool(
    "naobrain_today_delete",
    {
      title: "Delete NaoBrain Today entry",
      description: "Hide a Today entry from timelines and analyses while preserving all versions, including the deletion revision, in history.",
      inputSchema: {
        id: z.string().min(1).max(80),
        revisionNote: z.string().max(240).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, revisionNote }) => {
      const result = await todayStore.delete(id, revisionNote);
      return {
        content: [textBlock(`NaoBrain Todayから非表示にし、削除履歴を保存しました: ${result.entry.title}`)],
        structuredContent: { ...result },
      };
    },
  );

  server.registerTool(
    "naobrain_today_restore",
    {
      title: "Restore NaoBrain Today entry",
      description: "Restore a deleted Today entry or revert an active entry to a selected preserved revision. The restore itself is appended as a new version.",
      inputSchema: {
        id: z.string().min(1).max(80),
        revisionId: z.string().max(80).optional(),
        revisionNote: z.string().max(240).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, revisionId, revisionNote }) => {
      const result = await todayStore.restore(id, revisionId, revisionNote);
      return {
        content: [textBlock(`NaoBrain Todayへ履歴から復元しました: ${result.entry.title} (v${result.entry.version})`)],
        structuredContent: { ...result },
      };
    },
  );

  server.registerTool(
    "naobrain_today_history",
    {
      title: "Read NaoBrain Today version history",
      description: "Read every preserved version of a Today entry before correcting it or when the user asks what changed.",
      inputSchema: { id: z.string().min(1).max(80) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const history = await todayStore.history(id);
      return {
        content: [textBlock(history.length
          ? history.map((entry) => `v${entry.version} · ${entry.updatedAt} · ${entry.title}${entry.revisionNote ? `\n修正メモ: ${entry.revisionNote}` : ""}`).join("\n\n")
          : "指定されたToday記録の履歴はありません。")],
        structuredContent: { id, history },
      };
    },
  );

  server.registerTool(
    "naobrain_today_projects",
    {
      title: "Manage NaoBrain Today projects",
      description: "List, create, rename, or remove Today Project dropdown items. Removing a Project never deletes historical journal entries.",
      inputSchema: {
        action: z.enum(["list", "create", "update", "delete"]).optional(),
        id: z.string().max(80).optional(),
        name: z.string().max(120).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ action = "list", id, name }) => {
      if (action === "create") await todayStore.createProject(name || "");
      if (action === "update") await todayStore.updateProject(id || "", name || "");
      if (action === "delete") await todayStore.deleteProject(id || "");
      const projects = await todayStore.listProjects();
      return {
        content: [textBlock(projects.length ? projects.map((project) => `- ${project.name} (${project.id})`).join("\n") : "Projectはまだありません。")],
        structuredContent: { action, projects },
      };
    },
  );

  server.registerTool(
    "naobrain_today_tags",
    {
      title: "Manage NaoBrain Today tags",
      description: "List, create, rename, categorize, mark as a person tag, or remove Today tag suggestions. Removing a tag never deletes it from historical entries.",
      inputSchema: {
        action: z.enum(["list", "create", "update", "delete"]).optional(),
        id: z.string().max(80).optional(),
        name: z.string().max(40).optional(),
        category: z.string().max(40).optional(),
        kind: z.enum(["general", "person"]).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ action = "list", id, name, category, kind }) => {
      if (action === "create") await todayStore.createTag(name || "", category, kind);
      if (action === "update") await todayStore.updateTag(id || "", { name: name || "", category, kind });
      if (action === "delete") await todayStore.deleteTag(id || "");
      const tags = await todayStore.listTags();
      return {
        content: [textBlock(tags.length
          ? tags.map((tag) => `- ${tag.kind === "person" ? "@" : "#"}${tag.name} / ${tag.category} / ${tag.usageCount}件`).join("\n")
          : "タグはまだありません。")],
        structuredContent: { action, tags },
      };
    },
  );

  server.registerTool(
    "naobrain_today_digest",
    {
      title: "Read NaoBrain Today digest",
      description: "Read a NaoBrain Today daily digest. Use when the user asks to sync progress, review today, wall-bounce, or decide tomorrow's actions.",
      inputSchema: { date: z.string().optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ date }) => {
      const digest = await todayStore.digest(date);
      return { content: [textBlock(digest)], structuredContent: { digest, date: date || null } };
    },
  );

  server.registerTool(
    "naobrain_today_analyze",
    {
      title: "Analyze NaoBrain Today records",
      description: "Analyze accumulated Today records by day, project, tag, kind, status, or a date range using Gemini. Use for progress reviews, pattern analysis, wall-bouncing, and deciding next actions.",
      inputSchema: {
        scope: z.enum(["all", "day", "project", "tag", "kind", "status"]).optional(),
        value: z.string().max(140).optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const analysis = await todayStore.analyzeScope(input as TodayAnalysisInput);
      return {
        content: [textBlock([
          "# NaoBrain Today Analysis",
          `- Scope: ${analysis.scope}${analysis.value ? ` / ${analysis.value}` : ""}`,
          `- Period: ${analysis.dateFrom} — ${analysis.dateTo}`,
          `- Entries: ${analysis.entryCount}`,
          "",
          analysis.summary,
          "",
          ...analysis.nextActions.map((action) => `- ${action}`),
        ].join("\n"))],
        structuredContent: { analysis },
      };
    },
  );

  server.registerTool(
    "naobrain_today_sync",
    {
      title: "Sync NaoBrain Today",
      description: "Rebuild and sync a NaoBrain Today day to Google Drive.",
      inputSchema: { date: z.string().optional() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ date }) => {
      const result = await todayStore.sync(date);
      return {
        content: [textBlock(result.synced ? "NaoBrain Todayを同期しました。" : `同期結果: ${result.error || "未設定"}`)],
        structuredContent: { ...result },
      };
    },
  );

  server.registerTool(
    "naobrain_quiz_digest",
    {
      title: "Read NaoBrain Quiz digest",
      description: "Read quiz progress, wrong answers, due reviews, and the recommended memory-retention action.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const digest = await quizStore.digest();
      return { content: [textBlock(digest)], structuredContent: { digest } };
    },
  );

  server.registerTool(
    "naobrain_quiz_generate",
    {
      title: "Generate NaoBrain Quiz questions",
      description: "Generate new questions from NaoBrain knowledge, journals, Today logs, and weak-answer history using Gemini.",
      inputSchema: { reason: z.string().max(240).optional(), force: z.boolean().optional() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ reason, force }) => {
      const result = await quizStore.queueGeneration(reason || "GAE requested question refresh", force === true);
      return {
        content: [textBlock(result.queued
          ? "NaoBrain Quizの問題生成をバックグラウンドで開始しました。"
          : result.generated
            ? `NaoBrain Quizへ${result.added || 0}問追加しました。`
            : `問題生成は実行されませんでした: ${result.error || result.reason}`)],
        structuredContent: { ...result },
      };
    },
  );

  server.registerTool(
    "naobrain_quiz_sync",
    {
      title: "Sync NaoBrain Quiz to Drive",
      description: "Synchronize the question bank, answer history, session state, and spaced-repetition statistics to Google Drive.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const result = await quizStore.sync();
      return {
        content: [textBlock(result.synced ? `NaoBrain QuizをGoogle Driveへ同期しました。${result.destination || ""}` : result.configured ? `Google Drive同期に失敗しました: ${result.error || "unknown error"}` : "Google Drive同期先が未設定です。")],
        structuredContent: { ...result },
      };
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
        taskInputTokens: z.number(),
        taskOutputTokens: z.number(),
        sessionInputTokens: z.number(),
        sessionOutputTokens: z.number(),
        taskToolDurationMs: z.number(),
        sessionToolDurationMs: z.number(),
        taskCalls: z.number(),
        sessionCalls: z.number(),
        taskErrors: z.number(),
        sessionErrors: z.number(),
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
      const conversation = chatConversationContext(
        extra._meta as Record<string, unknown> | undefined,
      );
      const record = updateChatProgress({
        sessionId: extra.sessionId,
        conversationId: conversation.id,
        conversationUrl: conversation.url,
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
          taskInputTokens: record.taskInputTokens,
          taskOutputTokens: record.taskOutputTokens,
          sessionInputTokens: record.sessionInputTokens,
          sessionOutputTokens: record.sessionOutputTokens,
          taskToolDurationMs: record.taskToolDurationMs,
          sessionToolDurationMs: record.sessionToolDurationMs,
          taskCalls: record.taskCalls,
          sessionCalls: record.sessionCalls,
          taskErrors: record.taskErrors,
          sessionErrors: record.sessionErrors,
          estimatedJpy: record.sessionEstimatedJpy,
          estimatedJpyMax: record.sessionEstimatedJpyMax ?? record.sessionEstimatedJpy,
        },
      };
    },
  );

  registerAppTool(
    server,
    "ec2_status",
    {
      title: "EC2 status and AWS credits",
      description:
        "Read the current Uniplanck EC2, GAE, Minecraft, EC2 schedule queue, AWS credit balance, and estimated remaining operating days. This is IAM-authenticated and does not require an open workspace. Use this before and after EC2 control operations.",
      inputSchema: {},
      outputSchema: {
        result: z.string(),
        data: z.unknown(),
      },
      _meta: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const startedAt = performance.now();
      try {
        const data = await invokeEc2Control({ action: "status" });
        const result = formatEc2ControlSummary(data);
        logToolCall(config, {
          tool: "ec2_status",
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          structuredContent: { result, data },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall(config, {
          tool: "ec2_status",
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        throw error;
      }
    },
  );

  registerAppTool(
    server,
    "ec2_control",
    {
      title: "Control and schedule EC2",
      description:
        "Control the fixed Uniplanck EC2 through an IAM-authenticated Lambda. Supports immediate start/stop, one-time or daily start/stop schedules, schedule cancellation, and billing refresh. Start/stop and schedule mutations are real production operations: call only when the user explicitly requests them. Every successful response automatically includes EC2/GAE/Minecraft state, AWS credits, estimated operating days, and the current schedule queue.",
      inputSchema: {
        action: z.enum([
          "ec2_start",
          "ec2_stop",
          "schedule_create",
          "schedule_delete",
          "billing_refresh",
        ]),
        scheduleAction: z.enum(["ec2_start", "ec2_stop"]).optional(),
        scheduleType: z.enum(["once", "daily"]).optional(),
        runAt: z
          .string()
          .optional()
          .describe("One-time execution in Asia/Tokyo, formatted YYYY-MM-DDTHH:mm."),
        dailyTime: z
          .string()
          .optional()
          .describe("Daily execution time in Asia/Tokyo, formatted HH:mm."),
        scheduleName: z
          .string()
          .optional()
          .describe("Existing schedule name returned by ec2_status."),
      },
      outputSchema: {
        result: z.string(),
        data: z.unknown(),
      },
      _meta: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ action, scheduleAction, scheduleType, runAt, dailyTime, scheduleName }) => {
      const startedAt = performance.now();
      try {
        const data = await invokeEc2Control({
          action,
          scheduleAction,
          scheduleType,
          runAt,
          dailyTime,
          scheduleName,
        });
        const result = formatEc2ControlSummary(data);
        logToolCall(config, {
          tool: "ec2_control",
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          structuredContent: { result, data },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logToolCall(config, {
          tool: "ec2_control",
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });
        throw error;
      }
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
    async ({ path, mode, baseRef }, extra) => {
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
      const usage = recordObservedToolUsage({
        tool: "open_workspace",
        usageSessionId: extra.sessionId,
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        path: workspace.root,
        observedChars: structuredContent.metrics.payloadCharacters + textContentChars(resultContent),
        savedChars: Math.max(0, fullInstructionCharacters - returnedInstructionCharacters),
        inputChars: String(path).length + String(mode ?? "checkout").length + String(baseRef ?? "").length,
        outputChars: structuredContent.metrics.payloadCharacters + textContentChars(resultContent),
        payloadChars: structuredContent.metrics.payloadCharacters,
        durationMs: serverDurationMs,
      });
      const content = appendUsageToContent(resultContent, usage, config.usageContent);

      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: serverDurationMs,
      });

      return {
        content,
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
    async ({ workspaceId, ...input }, extra) => {
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
        const content = logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt, {
          usageSessionId: extra.sessionId,
          workspaceRoot: workspace.root,
        });
        return { ...response, content };
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
        usageSessionId: extra.sessionId,
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
    async ({ workspaceId, ...input }, extra) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        const content = logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt, {
          usageSessionId: extra.sessionId,
          workspaceRoot: workspace.root,
        });
        return { ...response, content };
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
        usageSessionId: extra.sessionId,
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
    async ({ workspaceId, ...input }, extra) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const targetPath = workspaces.resolvePath(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        const content = logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt, {
          usageSessionId: extra.sessionId,
          workspaceRoot: workspace.root,
        });
        return { ...response, content };
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
        usageSessionId: extra.sessionId,
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
      async ({ workspaceId, ...input }, extra) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          const content = logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt, {
            usageSessionId: extra.sessionId,
            workspaceRoot: workspace.root,
          });
          return { ...response, content };
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        const usage = recordObservedToolUsage({
          tool: toolNames.grep,
          usageSessionId: extra.sessionId,
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
      async ({ workspaceId, ...input }, extra) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          const content = logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt, {
            usageSessionId: extra.sessionId,
            workspaceRoot: workspace.root,
          });
          return { ...response, content };
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        const usage = recordObservedToolUsage({
          tool: toolNames.glob,
          usageSessionId: extra.sessionId,
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
      async ({ workspaceId, ...input }, extra) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          const content = logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt, {
            usageSessionId: extra.sessionId,
            workspaceRoot: workspace.root,
          });
          return { ...response, content };
        }

        const summary = textSummary(response.content);
        const usage = recordObservedToolUsage({
          tool: toolNames.ls,
          usageSessionId: extra.sessionId,
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
    async ({ workspaceId, workingDirectory, ...input }, extra) => {
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
        const content = logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: loggedCommand,
          commandLength: input.command.length,
        }, response.content, startedAt, {
          usageSessionId: extra.sessionId,
          workspaceRoot: workspace.root,
        });
        return { ...response, content };
      }

      const summary = {
        command: loggedCommand,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      const usage = recordObservedToolUsage({
        tool: toolNames.shell,
        usageSessionId: extra.sessionId,
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

function firstMetaString(
  meta: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = meta?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function safeChatGptUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (hostname !== "chatgpt.com" && hostname !== "www.chatgpt.com")) {
      return undefined;
    }
    url.hostname = "chatgpt.com";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function chatConversationContext(
  meta: Record<string, unknown> | undefined,
): { id?: string; url?: string } {
  const id = firstMetaString(meta, [
    "openai/conversation_id",
    "openai/conversationId",
    "openai/chat_id",
    "openai/chatId",
    "conversation_id",
    "conversationId",
    "chat_id",
    "chatId",
  ]);
  const directUrl = safeChatGptUrl(firstMetaString(meta, [
    "openai/conversation_url",
    "openai/conversationUrl",
    "openai/chat_url",
    "openai/chatUrl",
    "conversation_url",
    "conversationUrl",
    "chat_url",
    "chatUrl",
  ]));
  if (directUrl) return { id, url: directUrl };
  if (!id) return {};

  const projectId = firstMetaString(meta, [
    "openai/project_id",
    "openai/projectId",
    "openai/gizmo_id",
    "openai/gizmoId",
    "project_id",
    "projectId",
    "gizmo_id",
    "gizmoId",
  ]);
  const encodedConversation = encodeURIComponent(id);
  const url = projectId
    ? `https://chatgpt.com/g/${encodeURIComponent(projectId)}/c/${encodedConversation}`
    : `https://chatgpt.com/c/${encodedConversation}`;
  return { id, url };
}

function privateUsageSessionKey(req: Request, fallback?: string): string | undefined {
  const meta = req.body?.params?._meta as Record<string, unknown> | undefined;
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
  const privateValue = conversationId
    ? `conversation:${conversationId.trim()}`
    : req.auth?.token
      ? `oauth:${req.auth.token}`
      : fallback
        ? `transport:${fallback}`
        : undefined;
  return privateValue
    ? createHash("sha256").update(privateValue).digest("hex").slice(0, 32)
    : undefined;
}

// PRIVATE_GEX_START
function rawRequestHostname(req: Request): string {
  const host = String(req.headers.host || "").trim();
  if (!host) return "";
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

function isAuthorizedGexLearningRequest(req: Request): boolean {
  const hostname = rawRequestHostname(req);
  const loopbackHost = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  return loopbackHost && req.header("x-gex-bridge") === GEX_LEARNING_BRIDGE_HEADER;
}

function denyGexLearningRequest(res: Response): void {
  res.status(403).json({ ok: false, error: "GEX learning bridge is local-only." });
}
// PRIVATE_GEX_END

function isAuthorizedNaoBrainRequest(req: Request, configuredSecret: string | null): boolean {
  if (!configuredSecret) return false;
  const suppliedSecret = req.header("x-naobrain-bridge-token") ?? "";
  const expected = Buffer.from(configuredSecret);
  const supplied = Buffer.from(suppliedSecret);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
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
  // PRIVATE_GEX_START
  const gexLearningStore = new GexLearningStore(config.gexLearningDir);
  // PRIVATE_GEX_END
  const todayStore = new NaoBrainTodayStore({
    dataDir: config.naobrainTodayDir,
    promptFile: config.naobrainTodayPromptFile,
    geminiApiKey: config.naobrainGeminiApiKey || undefined,
    geminiModel: config.naobrainGeminiModel,
    geminiFallbackKeysFile: config.naobrainGeminiFallbackKeysFile,
    driveRemote: config.naobrainDriveRemote || undefined,
    driveBasePath: config.naobrainDriveBasePath,
  });
  const quizStore = new NaoBrainQuizStore({
    dataDir: config.naobrainQuizDir,
    promptFile: config.naobrainQuizPromptFile,
    geminiApiKey: config.naobrainGeminiApiKey || undefined,
    geminiModel: config.naobrainGeminiModel,
    geminiFallbackKeysFile: config.naobrainGeminiFallbackKeysFile,
    driveRemote: config.naobrainDriveRemote || undefined,
    driveBasePath: config.naobrainQuizDriveBasePath,
    sourceRoots: config.naobrainQuizSourceRoots,
  });
  const runTodayDailyAnalysis = () => {
    todayStore.runScheduledDailyAnalyses().catch((error) => {
      logEvent(config.logging, "warn", "naobrain_today_daily_analysis_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  const todayDailyAnalysisInitialTimer = setTimeout(runTodayDailyAnalysis, 20_000);
  const todayDailyAnalysisTimer = setInterval(runTodayDailyAnalysis, 30 * 60 * 1000);
  todayDailyAnalysisInitialTimer.unref?.();
  todayDailyAnalysisTimer.unref?.();

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

  // PRIVATE_GEX_START
  app.get("/gex-learning/health", (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (!isAuthorizedGexLearningRequest(req)) {
      denyGexLearningRequest(res);
      return;
    }
    res.json({ ok: true, name: "gex-learning-bridge" });
  });

  app.post(
    "/gex-learning/sync",
    express.json({ limit: "2mb" }),
    async (req, res) => {
      res.setHeader("cache-control", "no-store");
      if (!isAuthorizedGexLearningRequest(req)) {
        denyGexLearningRequest(res);
        return;
      }
      try {
        const result = await gexLearningStore.sync((req.body || {}) as GexLearningSyncPayload);
        res.json({ ok: true, ...result });
      } catch (error) {
        logEvent(config.logging, "error", "gex_learning_sync_error", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ ok: false, error: "GEX learning data could not be saved." });
      }
    },
  );
  // PRIVATE_GEX_END

  const authorizeToday = (req: Request, res: Response): boolean => {
    res.setHeader("cache-control", "no-store");
    if (!isAuthorizedNaoBrainRequest(req, config.naobrainBridgeToken)) {
      res.sendStatus(404);
      return false;
    }
    return true;
  };

  app.get("/naobrain-today/health", async (req, res) => {
    if (!authorizeToday(req, res)) return;
    res.json(await todayStore.health());
  });

  app.get("/naobrain-today/entries", async (req, res) => {
    if (!authorizeToday(req, res)) return;
    try {
      const date = typeof req.query.date === "string" ? req.query.date : undefined;
      res.json({ ok: true, snapshot: await todayStore.list(date) });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
    }
  });

  app.get("/naobrain-today/entries/history", async (req, res) => {
    if (!authorizeToday(req, res)) return;
    try {
      const id = typeof req.query.id === "string" ? req.query.id : "";
      res.json({ ok: true, history: await todayStore.history(id) });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
    }
  });

  app.get("/naobrain-today/entries/deleted", async (req, res) => {
    if (!authorizeToday(req, res)) return;
    try {
      const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
      res.json({ ok: true, entries: await todayStore.listDeleted(limit) });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
    }
  });

  app.post(
    "/naobrain-today/entries",
    express.json({ limit: "256kb" }),
    async (req, res) => {
      if (!authorizeToday(req, res)) return;
      try {
        const result = await todayStore.append({
          ...(req.body || {}) as TodayEntryInput,
          source: (req.body?.source || "web") as TodayEntryInput["source"],
        });
        res.status(201).json({ ok: true, ...result });
      } catch (error) {
        logEvent(config.logging, "error", "naobrain_today_append_error", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

  app.post(
    "/naobrain-today/entries/update",
    express.json({ limit: "256kb" }),
    async (req, res) => {
      if (!authorizeToday(req, res)) return;
      try {
        const result = await todayStore.update({
          ...(req.body || {}) as TodayEntryUpdateInput,
          source: (req.body?.source || "web") as TodayEntryInput["source"],
        });
        res.json({ ok: true, ...result });
      } catch (error) {
        logEvent(config.logging, "error", "naobrain_today_update_error", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

  app.post(
    "/naobrain-today/entries/delete",
    express.json({ limit: "32kb" }),
    async (req, res) => {
      if (!authorizeToday(req, res)) return;
      try {
        const result = await todayStore.delete(String(req.body?.id || ""), String(req.body?.revisionNote || ""));
        res.json({ ok: true, ...result });
      } catch (error) {
        logEvent(config.logging, "error", "naobrain_today_delete_error", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

  app.post(
    "/naobrain-today/entries/restore",
    express.json({ limit: "32kb" }),
    async (req, res) => {
      if (!authorizeToday(req, res)) return;
      try {
        const result = await todayStore.restore(
          String(req.body?.id || ""),
          req.body?.revisionId ? String(req.body.revisionId) : undefined,
          req.body?.revisionNote ? String(req.body.revisionNote) : undefined,
        );
        res.json({ ok: true, ...result });
      } catch (error) {
        logEvent(config.logging, "error", "naobrain_today_restore_error", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

  app.get("/naobrain-today/projects", async (req, res) => {
    if (!authorizeToday(req, res)) return;
    try {
      res.json({ ok: true, projects: await todayStore.listProjects(req.query.includeDeleted === "1") });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
    }
  });

  app.post(
    "/naobrain-today/projects",
    express.json({ limit: "32kb" }),
    async (req, res) => {
      if (!authorizeToday(req, res)) return;
      try {
        const action = String(req.body?.action || "create");
        const project = action === "update"
          ? await todayStore.updateProject(String(req.body?.id || ""), String(req.body?.name || ""))
          : action === "delete"
            ? await todayStore.deleteProject(String(req.body?.id || ""))
            : await todayStore.createProject(String(req.body?.name || ""));
        res.json({ ok: true, project, projects: await todayStore.listProjects() });
      } catch (error) {
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

  app.get("/naobrain-today/tags", async (req, res) => {
    if (!authorizeToday(req, res)) return;
    try {
      res.json({ ok: true, tags: await todayStore.listTags(req.query.includeDeleted === "1") });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
    }
  });

  app.post(
    "/naobrain-today/tags",
    express.json({ limit: "32kb" }),
    async (req, res) => {
      if (!authorizeToday(req, res)) return;
      try {
        const action = String(req.body?.action || "create");
        if (action === "save-all") {
          const rawTags = Array.isArray(req.body?.tags) ? req.body.tags : [];
          const tags = await todayStore.saveTags(rawTags.map((rawTag: Record<string, unknown>) => ({
            id: rawTag.id ? String(rawTag.id) : undefined,
            name: String(rawTag.name || ""),
            category: String(rawTag.category || ""),
            kind: rawTag.kind === "person" ? "person" : "general",
          })));
          res.json({ ok: true, tags, savedCount: tags.length });
          return;
        }
        const kind = req.body?.kind === "person" ? "person" : "general";
        const tag = action === "update"
          ? await todayStore.updateTag(String(req.body?.id || ""), {
            name: String(req.body?.name || ""),
            category: String(req.body?.category || ""),
            kind,
          })
          : action === "delete"
            ? await todayStore.deleteTag(String(req.body?.id || ""))
            : await todayStore.createTag(String(req.body?.name || ""), String(req.body?.category || ""), kind);
        res.json({ ok: true, tag, tags: await todayStore.listTags() });
      } catch (error) {
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

  app.get("/naobrain-today/analyses", async (req, res) => {
    if (!authorizeToday(req, res)) return;
    try {
      const limit = Number(req.query.limit || 20);
      res.json({ ok: true, analyses: await todayStore.listAnalyses(limit) });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
    }
  });

  app.post(
    "/naobrain-today/analyses",
    express.json({ limit: "256kb" }),
    async (req, res) => {
      if (!authorizeToday(req, res)) return;
      try {
        const analysis = await todayStore.analyzeScope((req.body || {}) as TodayAnalysisInput);
        res.json({ ok: true, analysis });
      } catch (error) {
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

  app.get("/naobrain-today/ai-settings", async (req, res) => {
    if (!authorizeToday(req, res)) return;
    try {
      res.json({ ok: true, settings: await todayStore.aiSettings() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
    }
  });

  app.post(
    "/naobrain-today/ai-settings",
    express.json({ limit: "16kb" }),
    async (req, res) => {
      if (!authorizeToday(req, res)) return;
      try {
        const settings = await todayStore.updateAiSettings({
          fallback2: typeof req.body?.fallback2 === "string" ? req.body.fallback2 : undefined,
          fallback3: typeof req.body?.fallback3 === "string" ? req.body.fallback3 : undefined,
          clearFallback2: req.body?.clearFallback2 === true,
          clearFallback3: req.body?.clearFallback3 === true,
        });
        res.json({ ok: true, settings });
      } catch (error) {
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

  app.post(
    "/naobrain-today/daily-analysis",
    express.json({ limit: "16kb" }),
    async (req, res) => {
      if (!authorizeToday(req, res)) return;
      try {
        res.json({ ok: true, results: await todayStore.runScheduledDailyAnalyses() });
      } catch (error) {
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

  app.post(
    "/naobrain-today/sync",
    express.json({ limit: "32kb" }),
    async (req, res) => {
      if (!authorizeToday(req, res)) return;
      try {
        const result = await todayStore.sync(req.body?.date);
        res.json({ ok: true, ...result });
      } catch (error) {
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

  app.get("/naobrain-today/quiz/health", async (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (!isAuthorizedNaoBrainRequest(req, config.naobrainBridgeToken)) {
      res.sendStatus(404);
      return;
    }
    res.json(quizStore.health());
  });

  app.get("/naobrain-today/quiz/state", async (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (!isAuthorizedNaoBrainRequest(req, config.naobrainBridgeToken)) {
      res.sendStatus(404);
      return;
    }
    try {
      res.json(await quizStore.getState());
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
    }
  });

  app.post(
    "/naobrain-today/quiz/session/start",
    express.json({ limit: "32kb" }),
    async (req, res) => {
      res.setHeader("cache-control", "no-store");
      if (!isAuthorizedNaoBrainRequest(req, config.naobrainBridgeToken)) {
        res.sendStatus(404);
        return;
      }
      try {
        const allowedModes = new Set<QuizSessionMode>(["resume", "restart", "wrong", "due", "recommended"]);
        const mode = allowedModes.has(req.body?.mode) ? req.body.mode as QuizSessionMode : "recommended";
        const limit = Number.isInteger(req.body?.limit) ? req.body.limit : undefined;
        res.json(await quizStore.start(mode, limit));
      } catch (error) {
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

  app.post(
    "/naobrain-today/quiz/answer",
    express.json({ limit: "32kb" }),
    async (req, res) => {
      res.setHeader("cache-control", "no-store");
      if (!isAuthorizedNaoBrainRequest(req, config.naobrainBridgeToken)) {
        res.sendStatus(404);
        return;
      }
      try {
        res.json(await quizStore.answer(req.body as QuizAnswerInput));
      } catch (error) {
        logEvent(config.logging, "error", "naobrain_quiz_answer_error", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

  app.post(
    "/naobrain-today/quiz/generate",
    express.json({ limit: "32kb" }),
    async (req, res) => {
      res.setHeader("cache-control", "no-store");
      if (!isAuthorizedNaoBrainRequest(req, config.naobrainBridgeToken)) {
        res.sendStatus(404);
        return;
      }
      try {
        res.json({ ok: true, ...(await quizStore.queueGeneration(String(req.body?.reason || "web requested question refresh"), req.body?.force === true)) });
      } catch (error) {
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

  app.post(
    "/naobrain-today/quiz/sync",
    express.json({ limit: "16kb" }),
    async (req, res) => {
      res.setHeader("cache-control", "no-store");
      if (!isAuthorizedNaoBrainRequest(req, config.naobrainBridgeToken)) {
        res.sendStatus(404);
        return;
      }
      try {
        res.json({ ok: true, ...(await quizStore.sync()) });
      } catch (error) {
        res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "request failed" });
      }
    },
  );

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
          todayStore,
          quizStore,
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await runWithUsageSession(
        privateUsageSessionKey(req, sessionId ?? transport.sessionId),
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
      clearTimeout(todayDailyAnalysisInitialTimer);
      clearInterval(todayDailyAnalysisTimer);
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

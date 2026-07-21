import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { batchEditWorkspace } from "./batch-edit.js";
import type { ServerConfig } from "./config.js";
import {
  focusedContext,
  projectSnapshot,
  reviewChanges,
  workspaceDigest,
  type WorkspaceInspectionContext,
} from "./compound-tools.js";
import { runDesignAudit } from "./design-audit.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { matchWorkspaceSkills } from "./skill-matcher.js";
import { openPathInFinder } from "./runtime-operations.js";
import type { Workspace, WorkspaceRegistry } from "./workspaces.js";

const metricsSchema = z.object({
  serverDurationMs: z.number().int().nonnegative(),
  payloadCharacters: z.number().int().nonnegative(),
  returnedItems: z.number().int().nonnegative(),
  truncated: z.boolean(),
  cacheHit: z.boolean().optional(),
});

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const batchWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export function registerV11Tools(
  server: McpServer,
  input: {
    config: ServerConfig;
    workspaces: WorkspaceRegistry;
    localAgentProviders: LocalAgentProviderAvailability[];
  },
): void {
  registerFinderAppTool(server, input);
  const enabledTools = new Set(enabledV11ToolNames(input.config));
  if (enabledTools.has("match_skills")) {
    registerAppTool(
      server,
      "match_skills",
      {
        title: "Match skills",
        description: "Rank a small set of relevant Skill metadata without loading Skill bodies.",
        inputSchema: {
          workspaceId: z.string(),
          task: z.string().min(1).max(4_000),
          limit: z.number().int().min(1).max(10).optional(),
          includeGlobal: z.boolean().optional(),
        },
        outputSchema: {
          matches: z.array(z.object({
            name: z.string(),
            shortDescription: z.string(),
            path: z.string(),
            matchReason: z.string(),
            confidence: z.number().min(0).max(1),
            requiredTools: z.array(z.string()).optional(),
          })),
          metrics: metricsSchema,
        },
        _meta: {},
        annotations: readOnlyAnnotations,
      },
      async ({ workspaceId, task, limit, includeGlobal }) => {
        const workspace = input.workspaces.getWorkspace(workspaceId);
        const result = await matchWorkspaceSkills({
          skills: workspace.skills,
          workspaceRoot: workspace.root,
          task,
          limit,
          includeGlobal,
        });
        return toolResult(
          result,
          result.matches.length === 0
            ? "No relevant skills found."
            : `Matched skills: ${result.matches.map((match) => match.name).join(", ")}`,
        );
      },
    );
  }

  if (enabledTools.has("project_snapshot")) {
    registerProjectSnapshot(server, input);
    registerFocusedContext(server, input);
    registerWorkspaceDigest(server, input);
    registerReviewChanges(server, input);
    if (input.config.toolMode !== "codex") registerBatchEdit(server, input);
  }

  if (enabledTools.has("design_audit")) {
    registerAppTool(
      server,
      "design_audit",
      {
        title: "Design audit",
        description: "Run a guarded rendered UI audit through the configured browser adapter.",
        inputSchema: {
          workspaceId: z.string(),
          url: z.string().min(1).max(2_000),
          desktopViewport: viewportSchema.optional(),
          mobileViewport: viewportSchema.optional(),
          routes: z.array(z.string().max(500)).max(20).optional(),
          checks: z.array(z.string().max(100)).max(20).optional(),
          outputDirectory: z.string().max(1_000).optional(),
        },
        outputSchema: {
          status: z.enum(["disabled", "unavailable", "completed"]),
          adapter: z.string(),
          validatedUrl: z.string().optional(),
          artifacts: z.array(z.object({
            kind: z.enum(["desktop-screenshot", "mobile-screenshot", "report"]),
            path: z.string(),
          })),
          diagnostics: z.array(z.string()),
          consoleErrors: z.number().int().nonnegative().optional(),
          overflowIssues: z.number().int().nonnegative().optional(),
          accessibilityIssues: z.number().int().nonnegative().optional(),
          headingIssues: z.number().int().nonnegative().optional(),
          metrics: metricsSchema,
        },
        _meta: {},
        annotations: { ...readOnlyAnnotations, openWorldHint: true },
      },
      async ({ workspaceId, ...toolInput }) => {
        const workspace = input.workspaces.getWorkspace(workspaceId);
        const result = await runDesignAudit(input.config, {
          workspaceRoot: workspace.root,
          ...toolInput,
        });
        return {
          ...toolResult(result, result.diagnostics.join(" ")),
          isError: result.status !== "completed",
        };
      },
    );
  }
}

function registerFinderAppTool(
  server: McpServer,
  input: {
    config: ServerConfig;
    workspaces: WorkspaceRegistry;
    localAgentProviders: LocalAgentProviderAvailability[];
  },
): void {
  registerAppTool(
    server,
    "open_in_finder",
    {
      title: "Open in Finder",
      description: "Open a workspace-scoped local path in macOS Finder after validating that it remains inside the open workspace. Files are revealed; directories are opened. This Tool is callable only by the MCP App UI.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().min(1).max(4_000),
      },
      outputSchema: {
        status: z.enum(["opened", "unsupported"]),
        path: z.string(),
        kind: z.enum(["file", "directory"]),
      },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, path }) => {
      const workspace = input.workspaces.getWorkspace(workspaceId);
      const absolutePath = input.workspaces.resolvePath(workspace, path);
      const result = await openPathInFinder(absolutePath);
      return toolResult(
        result,
        result.status === "opened"
          ? `Opened ${result.kind} in Finder.`
          : "Finder integration is only available on macOS.",
      );
    },
  );
}

export function enabledV11ToolNames(config: ServerConfig): string[] {
  return [
    config.skillMatcher && config.skillsEnabled ? "match_skills" : undefined,
    ...(config.compoundTools
      ? [
          "project_snapshot",
          "focused_context",
          "workspace_digest",
          "review_changes",
          ...(config.toolMode === "codex" ? [] : ["batch_edit"]),
        ]
      : []),
    config.designAudit ? "design_audit" : undefined,
  ].filter((name): name is string => name !== undefined);
}

function registerProjectSnapshot(
  server: McpServer,
  input: {
    config: ServerConfig;
    workspaces: WorkspaceRegistry;
    localAgentProviders: LocalAgentProviderAvailability[];
  },
): void {
  registerAppTool(
    server,
    "project_snapshot",
    {
      title: "Project snapshot",
      description: "Return a bounded project and Git digest without diff bodies or secret contents.",
      inputSchema: {
        workspaceId: z.string(),
        maxCharacters: z.number().int().min(2_000).max(50_000).optional(),
      },
      outputSchema: {
        branch: z.string().nullable(),
        dirty: z.boolean(),
        changedFiles: z.array(z.string()),
        diffStat: z.string(),
        package: z.object({
          name: z.string().optional(),
          version: z.string().optional(),
          scripts: z.array(z.string()),
        }),
        applicableInstructions: z.array(z.string()),
        skills: z.array(z.object({ name: z.string(), description: z.string().optional() })),
        agentProviders: z.array(agentSummarySchema),
        agentProfiles: z.array(agentSummarySchema),
        codeGraph: z.object({
          detected: z.boolean(),
          available: z.literal(false),
          reason: z.enum(["not_initialized", "adapter_unavailable"]),
        }),
        recommendedTestCommand: z.string().optional(),
        recommendedBuildCommand: z.string().optional(),
        metrics: metricsSchema,
      },
      _meta: {},
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, maxCharacters }) => {
      const workspace = input.workspaces.getWorkspace(workspaceId);
      const result = await projectSnapshot(
        inspectionContext(workspace, input.localAgentProviders),
        { maxCharacters },
      );
      return toolResult(
        result,
        `Project snapshot: ${result.changedFiles.length} changed file(s), branch ${result.branch ?? "unknown"}.`,
      );
    },
  );
}

function registerFocusedContext(
  server: McpServer,
  input: {
    workspaces: WorkspaceRegistry;
    localAgentProviders: LocalAgentProviderAvailability[];
  },
): void {
  registerAppTool(
    server,
    "focused_context",
    {
      title: "Focused context",
      description: "Find bounded files, symbols, and match locations for one focus area.",
      inputSchema: {
        workspaceId: z.string(),
        focus: z.string().min(1).max(4_000),
        paths: z.array(z.string().max(1_000)).max(25).optional(),
        maxFiles: z.number().int().min(1).max(25).optional(),
        maxCharacters: z.number().int().min(2_000).max(50_000).optional(),
      },
      outputSchema: {
        relevantFiles: z.array(z.string()),
        relevantSymbols: z.array(z.object({ name: z.string(), path: z.string(), line: z.number().int().positive() })),
        searchMatches: z.array(z.object({ path: z.string(), line: z.number().int().positive() })),
        applicableInstructions: z.array(z.string()),
        impactCandidates: z.array(z.string()),
        recommendedReads: z.array(z.string()),
        detectionMethod: z.enum(["bounded_text_fallback", "codegraph_adapter_unavailable_fallback"]),
        metrics: metricsSchema,
      },
      _meta: {},
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, ...toolInput }) => {
      const workspace = input.workspaces.getWorkspace(workspaceId);
      const result = await focusedContext(
        inspectionContext(workspace, input.localAgentProviders),
        toolInput,
      );
      return toolResult(result, `Focused context: ${result.relevantFiles.length} relevant file(s).`);
    },
  );
}

function registerWorkspaceDigest(
  server: McpServer,
  input: {
    workspaces: WorkspaceRegistry;
    localAgentProviders: LocalAgentProviderAvailability[];
  },
): void {
  registerAppTool(
    server,
    "workspace_digest",
    {
      title: "Workspace digest",
      description: "Combine Git/project state, focused search, and bounded relevant file excerpts in one read-only call. Prefer this over separate status, grep, and repeated read calls when the next decision depends on the combined context.",
      inputSchema: {
        workspaceId: z.string(),
        focus: z.string().min(1).max(4_000),
        paths: z.array(z.string().max(1_000)).max(25).optional(),
        maxFiles: z.number().int().min(1).max(12).optional(),
        contextLines: z.number().int().min(10).max(240).optional(),
        maxCharacters: z.number().int().min(4_000).max(60_000).optional(),
      },
      outputSchema: {
        project: z.object({
          branch: z.string().nullable(),
          dirty: z.boolean(),
          changedFiles: z.array(z.string()),
          diffStat: z.string(),
          package: z.object({
            name: z.string().optional(),
            version: z.string().optional(),
            scripts: z.array(z.string()),
          }),
          applicableInstructions: z.array(z.string()),
          recommendedTestCommand: z.string().optional(),
          recommendedBuildCommand: z.string().optional(),
        }),
        focus: z.object({
          relevantFiles: z.array(z.string()),
          relevantSymbols: z.array(z.object({ name: z.string(), path: z.string(), line: z.number().int().positive() })),
          searchMatches: z.array(z.object({ path: z.string(), line: z.number().int().positive() })),
          impactCandidates: z.array(z.string()),
          detectionMethod: z.enum(["bounded_text_fallback", "codegraph_adapter_unavailable_fallback"]),
        }),
        excerpts: z.array(z.object({
          path: z.string(),
          startLine: z.number().int().positive(),
          endLine: z.number().int().positive(),
          content: z.string(),
          truncated: z.boolean(),
        })),
        metrics: metricsSchema,
      },
      _meta: {},
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, ...toolInput }) => {
      const workspace = input.workspaces.getWorkspace(workspaceId);
      const result = await workspaceDigest(
        inspectionContext(workspace, input.localAgentProviders),
        toolInput,
      );
      return toolResult(
        result,
        `Workspace digest: ${result.focus.relevantFiles.length} relevant file(s), ${result.excerpts.length} excerpt(s).`,
      );
    },
  );
}

function registerBatchEdit(
  server: McpServer,
  input: { workspaces: WorkspaceRegistry },
): void {
  registerAppTool(
    server,
    "batch_edit",
    {
      title: "Batch edit files",
      description: "Apply pre-determined exact replacements to up to 12 independent files in one call. Use only after the required changes are known; do not use when one file's result must be inspected before deciding the next edit.",
      inputSchema: {
        workspaceId: z.string(),
        files: z.array(z.object({
          path: z.string().min(1).max(4_000),
          edits: z.array(z.object({
            oldText: z.string().min(1),
            newText: z.string(),
          })).min(1).max(30),
        })).min(1).max(12),
      },
      outputSchema: {
        status: z.literal("applied"),
        files: z.array(z.object({
          path: z.string(),
          replacements: z.number().int().positive(),
          charactersBefore: z.number().int().nonnegative(),
          charactersAfter: z.number().int().nonnegative(),
        })),
        totalFiles: z.number().int().positive(),
        totalReplacements: z.number().int().positive(),
      },
      _meta: {},
      annotations: batchWriteAnnotations,
    },
    async ({ workspaceId, files }) => {
      const workspace = input.workspaces.getWorkspace(workspaceId);
      const result = await batchEditWorkspace(workspace.root, files);
      return toolResult(
        result,
        `Batch edit applied ${result.totalReplacements} replacement(s) across ${result.totalFiles} file(s).`,
      );
    },
  );
}

function registerReviewChanges(
  server: McpServer,
  input: {
    workspaces: WorkspaceRegistry;
    localAgentProviders: LocalAgentProviderAvailability[];
  },
): void {
  registerAppTool(
    server,
    "review_changes",
    {
      title: "Review changes",
      description: "Analyze a bounded Git diff without changing files, index, refs, or staging.",
      inputSchema: {
        workspaceId: z.string(),
        scope: z.string().max(1_000).optional(),
        baseRef: z.string().max(200).optional(),
        maxCharacters: z.number().int().min(2_000).max(50_000).optional(),
      },
      outputSchema: {
        changedFiles: z.array(z.object({ path: z.string(), status: z.string() })),
        diffStat: z.string(),
        summary: z.string(),
        riskCandidates: z.array(z.string()),
        suspiciousChanges: z.array(z.object({ rule: z.string(), file: z.string(), line: z.number().int().positive().optional() })),
        testRecommendations: z.array(z.string()),
        truncated: z.boolean(),
        metrics: metricsSchema,
      },
      _meta: {},
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, ...toolInput }) => {
      const workspace = input.workspaces.getWorkspace(workspaceId);
      const result = await reviewChanges(
        inspectionContext(workspace, input.localAgentProviders),
        toolInput,
      );
      return toolResult(result, result.summary);
    },
  );
}

const viewportSchema = z.object({
  width: z.number().int().min(320).max(8_000),
  height: z.number().int().min(320).max(8_000),
});

const agentSummarySchema = z.object({
  name: z.string(),
  provider: z.string(),
  available: z.boolean().optional(),
  writeMode: z.string().optional(),
});

function inspectionContext(
  workspace: Workspace,
  providers: LocalAgentProviderAvailability[],
): WorkspaceInspectionContext {
  return {
    root: workspace.root,
    instructionPaths: Array.from(workspace.advertisedInstructionPaths).sort(),
    skills: workspace.skills
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => ({ name: skill.name, description: skill.description })),
    agentProviders: providers.map((provider) => ({
      name: provider.name,
      provider: provider.name,
      available: provider.available,
    })),
    agentProfiles: workspace.agentProfiles.map((profile) => ({
      name: profile.name,
      provider: profile.provider,
      writeMode: profile.writeMode,
    })),
  };
}

function toolResult<T extends object>(structuredContent: T, summary: string) {
  return {
    content: [{ type: "text" as const, text: summary.slice(0, 1_000) }],
    structuredContent: structuredContent as Record<string, unknown>,
  };
}

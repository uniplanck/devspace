import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import {
  focusedContext,
  projectSnapshot,
  reviewChanges,
  type WorkspaceInspectionContext,
} from "./compound-tools.js";
import { runDesignAudit } from "./design-audit.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { matchWorkspaceSkills } from "./skill-matcher.js";
import {
  diagnoseRuntime,
  openPathInFinder,
  runCompatibilitySmoke,
} from "./runtime-operations.js";
import { getExecutionCostSnapshot } from "./usage-meter.js";
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

export function registerV11Tools(
  server: McpServer,
  input: {
    config: ServerConfig;
    workspaces: WorkspaceRegistry;
    localAgentProviders: LocalAgentProviderAvailability[];
  },
): void {
  registerRuntimeTools(server, input);
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
    registerReviewChanges(server, input);
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

function registerRuntimeTools(
  server: McpServer,
  input: {
    config: ServerConfig;
    workspaces: WorkspaceRegistry;
    localAgentProviders: LocalAgentProviderAvailability[];
  },
): void {
  registerAppTool(
    server,
    "diagnose_runtime",
    {
      title: "Diagnose runtime",
      description: "Diagnose workspace access, safe shell PATH fallbacks, executable discovery, Git state, and optional GitHub CLI authentication without returning credentials or token contents.",
      inputSchema: {
        workspaceId: z.string(),
        commands: z.array(z.string().regex(/^[A-Za-z0-9._+-]+$/u)).max(20).optional(),
        checkGitHubAuth: z.boolean().optional(),
      },
      outputSchema: {
        platform: z.string(),
        nodeVersion: z.string(),
        workspace: z.object({
          root: z.string(),
          name: z.string(),
          accessible: z.boolean(),
          gitRepository: z.boolean(),
        }),
        shellPath: z.object({
          entryCount: z.number().int().nonnegative(),
          addedEntries: z.array(z.string()),
        }),
        executables: z.array(z.object({
          command: z.string(),
          found: z.boolean(),
          path: z.string().optional(),
        })),
        githubAuthentication: z.enum(["not_checked", "authenticated", "unauthenticated", "gh_unavailable"]),
        diagnostics: z.array(z.string()),
        metrics: metricsSchema,
      },
      _meta: {},
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, commands, checkGitHubAuth }) => {
      const workspace = input.workspaces.getWorkspace(workspaceId);
      const result = await diagnoseRuntime({
        workspaceRoot: workspace.root,
        commands,
        checkGitHubAuth,
      });
      return toolResult(
        result,
        `Runtime diagnosis: ${result.executables.filter((entry) => entry.found).length}/${result.executables.length} executables available; GitHub auth ${result.githubAuthentication}.`,
      );
    },
  );

  registerAppTool(
    server,
    "compatibility_smoke_test",
    {
      title: "Compatibility smoke test",
      description: "Run a bounded read-only compatibility smoke test for workspace access, listing, reading, text search, augmented shell PATH, Git, and MCP App resources.",
      inputSchema: {
        workspaceId: z.string(),
      },
      outputSchema: {
        status: z.enum(["passed", "failed"]),
        steps: z.array(z.object({
          name: z.string(),
          status: z.enum(["passed", "failed", "skipped"]),
          detail: z.string(),
          durationMs: z.number().int().nonnegative(),
        })),
        summary: z.object({
          passed: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          skipped: z.number().int().nonnegative(),
        }),
        metrics: metricsSchema,
      },
      _meta: {},
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId }) => {
      const workspace = input.workspaces.getWorkspace(workspaceId);
      const result = await runCompatibilitySmoke(workspace.root);
      return {
        ...toolResult(
          result,
          `Compatibility smoke test ${result.status}: ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped.`,
        ),
        isError: result.status === "failed",
      };
    },
  );

  registerAppTool(
    server,
    "execution_costs",
    {
      title: "Execution costs",
      description: "Return observed DevSpace execution duration, tool calls, errors, retries, character volume, and estimated text tokens for the current server process.",
      inputSchema: {},
      outputSchema: {
        observedTokens: z.number().int().nonnegative(),
        savedTokens: z.number().int().nonnegative(),
        totalDurationMs: z.number().int().nonnegative(),
        calls: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        retries: z.number().int().nonnegative(),
        byTool: z.record(z.string(), z.object({
          observedTokens: z.number().int().nonnegative(),
          savedTokens: z.number().int().nonnegative(),
          calls: z.number().int().nonnegative(),
          inputChars: z.number().int().nonnegative(),
          outputChars: z.number().int().nonnegative(),
          payloadChars: z.number().int().nonnegative(),
          totalDurationMs: z.number().int().nonnegative(),
          errorCalls: z.number().int().nonnegative(),
          retries: z.number().int().nonnegative(),
        })),
        note: z.string(),
      },
      _meta: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      const result = getExecutionCostSnapshot();
      return toolResult(
        result,
        `Execution costs: ${result.calls} calls, ${result.totalDurationMs}ms, ${result.errors} errors, ~${result.observedTokens} observed tokens.`,
      );
    },
  );

  registerAppTool(
    server,
    "open_in_finder",
    {
      title: "Open in Finder",
      description: "Open a workspace-scoped local path in macOS Finder after validating that it remains inside the open workspace. Files are revealed; directories are opened. This is intended for an explicit user click or request.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().min(1).max(4_000),
      },
      outputSchema: {
        status: z.enum(["opened", "unsupported"]),
        path: z.string(),
        kind: z.enum(["file", "directory"]),
      },
      _meta: {},
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
      ? ["project_snapshot", "focused_context", "review_changes"]
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

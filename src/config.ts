import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";

export type ToolMode = "minimal" | "full" | "codex";
export type WidgetMode = "off" | "changes" | "full";
export type OpenWorkspacePayloadMode = "compact" | "full";
export type UsageContentMode = "off" | "compact" | "full";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  internalMcpSecret: string | null;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  widgets: WidgetMode;
  openWorkspacePayload: OpenWorkspacePayloadMode;
  openWorkspaceInstructionChars: number;
  usageContent: UsageContentMode;
  skillMatcher: boolean;
  compoundTools: boolean;
  builtinProfiles: boolean;
  designAudit: boolean;
  designAuditAllowedHosts: string[];
  stateDir: string;
  // PRIVATE_GEX_START
  gexLearningDir: string;
  // PRIVATE_GEX_END
  naobrainTodayDir: string;
  naobrainTodayPromptFile: string;
  naobrainGeminiFallbackKeysFile: string;
  naobrainQuizDir: string;
  naobrainQuizPromptFile: string;
  naobrainQuizSourceRoots: string[];
  naobrainQuizDriveBasePath: string;
  naobrainBridgeToken: string | null;
  naobrainGeminiApiKey: string | null;
  naobrainGeminiModel: string;
  naobrainGeminiFallbackModel: string;
  naobrainGeminiTertiaryModel: string;
  naobrainDriveRemote: string | null;
  naobrainDriveBasePath: string;
  worktreeRoot: string;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  subagents: boolean;
  agentDir: string;
  logging: LoggingConfig;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function parseFeatureFlag(value: string | undefined, name: string, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid ${name}: ${value}`);
}

function parseToolMode(env: NodeJS.ProcessEnv): ToolMode {
  const mode = env.DEVSPACE_TOOL_MODE;
  if (mode === "minimal" || mode === "full" || mode === "codex") return mode;
  if (mode) throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${mode}`);

  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) {
    return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS) ? "minimal" : "full";
  }
  return "minimal";
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseIntegerAtLeast(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
): number {
  const parsed = parsePositiveInteger(value, fallback, name);
  if (parsed < minimum) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
    trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
  };
}

function parseOpenWorkspacePayloadMode(value: string | undefined): OpenWorkspacePayloadMode {
  if (!value || value === "compact") return "compact";
  if (value === "full") return value;

  throw new Error(`Invalid DEVSPACE_OPEN_WORKSPACE_PAYLOAD: ${value}`);
}

function parseUsageContentMode(value: string | undefined): UsageContentMode {
  if (!value || value === "off") return "off";
  if (value === "compact" || value === "full") return value;

  throw new Error(`Invalid DEVSPACE_USAGE_CONTENT: ${value}`);
}

function parseWidgetMode(value: string | undefined, fallback: WidgetMode): WidgetMode {
  if (!value) return fallback;
  if (value === "full") return "full";
  if (value === "off" || value === "changes") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for DevSpace OAuth. Run: devspace init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOptionalSecret(value: string | undefined, name: string): string | null {
  const secret = value?.trim();
  if (!secret) return null;
  if (secret.length < 32) {
    throw new Error(`${name} must be at least 32 characters long.`);
  }
  return secret;
}

function loadOptionalSecret(
  env: NodeJS.ProcessEnv,
  valueName: string,
  fileName: string,
): string | null {
  const direct = parseOptionalSecret(env[valueName], valueName);
  if (direct) return direct;

  const filePath = env[fileName]?.trim();
  if (!filePath) return null;
  let value: string;
  try {
    value = readFileSync(resolve(expandHomePath(filePath)), "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${fileName}: ${reason}`);
  }
  return parseOptionalSecret(value, fileName);
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace"]),
    allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const openWorkspacePayload = parseOpenWorkspacePayloadMode(env.DEVSPACE_OPEN_WORKSPACE_PAYLOAD);
  const stateDir = resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir()));
  // PRIVATE_GEX_START
  const gexLearningDir = resolve(expandHomePath(
    env.DEVSPACE_GEX_LEARNING_DIR
      ?? files.config.gexLearningDir
      ?? join(stateDir, "gex-learning"),
  ));
  // PRIVATE_GEX_END
  const naobrainTodayDir = resolve(expandHomePath(
    env.DEVSPACE_NAOBRAIN_TODAY_DIR ?? join(stateDir, "naobrain-today"),
  ));
  const naobrainTodayPromptFile = resolve(expandHomePath(
    env.DEVSPACE_NAOBRAIN_TODAY_PROMPT_FILE ?? join(naobrainTodayDir, "config", "prompt.md"),
  ));
  const naobrainGeminiFallbackKeysFile = resolve(expandHomePath(
    env.DEVSPACE_NAOBRAIN_GEMINI_FALLBACK_KEYS_FILE ?? join(stateDir, "naobrain-secrets", "gemini-fallback-keys.json"),
  ));
  const naobrainQuizDir = resolve(expandHomePath(
    env.DEVSPACE_NAOBRAIN_QUIZ_DIR ?? join(stateDir, "naobrain-quiz"),
  ));
  const naobrainQuizPromptFile = resolve(expandHomePath(
    env.DEVSPACE_NAOBRAIN_QUIZ_PROMPT_FILE ?? join(naobrainQuizDir, "config", "prompt.md"),
  ));
  const defaultBrainRoot = join(homedir(), "GPT-Agent", "workspaces", "world-home-fusion", "admin", "brain");
  const naobrainQuizSourceRoots = parsePathList(env.DEVSPACE_NAOBRAIN_QUIZ_SOURCE_ROOTS);
  const legacyGeminiFallbackModel = env.DEVSPACE_NAOBRAIN_GEMINI_FALLBACK_MODEL?.trim() || "";
  const legacyFallbackIsLite = legacyGeminiFallbackModel === "gemini-3.5-flash-lite";
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];

  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    internalMcpSecret: loadOptionalSecret(
      env,
      "DEVSPACE_INTERNAL_MCP_SECRET",
      "DEVSPACE_INTERNAL_MCP_SECRET_FILE",
    ),
    allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    toolMode: parseToolMode(env),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS, "changes"),
    openWorkspacePayload,
    openWorkspaceInstructionChars: parseIntegerAtLeast(
      env.DEVSPACE_OPEN_WORKSPACE_INSTRUCTION_CHARS,
      6_000,
      "DEVSPACE_OPEN_WORKSPACE_INSTRUCTION_CHARS",
      256,
    ),
    usageContent: parseUsageContentMode(env.DEVSPACE_USAGE_CONTENT),
    skillMatcher: parseFeatureFlag(env.DEVSPACE_SKILL_MATCHER, "DEVSPACE_SKILL_MATCHER"),
    compoundTools: parseFeatureFlag(env.DEVSPACE_COMPOUND_TOOLS, "DEVSPACE_COMPOUND_TOOLS", true),
    builtinProfiles: parseFeatureFlag(env.DEVSPACE_BUILTIN_PROFILES, "DEVSPACE_BUILTIN_PROFILES"),
    designAudit: parseFeatureFlag(env.DEVSPACE_DESIGN_AUDIT, "DEVSPACE_DESIGN_AUDIT"),
    designAuditAllowedHosts: parseStringList(
      env.DEVSPACE_DESIGN_AUDIT_ALLOWED_HOSTS,
      ["localhost", "127.0.0.1", "::1"],
    ),
    stateDir,
    // PRIVATE_GEX_START
    gexLearningDir,
    // PRIVATE_GEX_END
    naobrainTodayDir,
    naobrainTodayPromptFile,
    naobrainGeminiFallbackKeysFile,
    naobrainQuizDir,
    naobrainQuizPromptFile,
    naobrainQuizSourceRoots: (naobrainQuizSourceRoots.length > 0
      ? naobrainQuizSourceRoots
      : [join(defaultBrainRoot, "知"), join(defaultBrainRoot, "人生"), naobrainTodayDir])
      .map((root) => resolve(expandHomePath(root))),
    naobrainQuizDriveBasePath: env.DEVSPACE_NAOBRAIN_QUIZ_DRIVE_BASE_PATH?.trim() || "NaoBrain/Quiz",
    naobrainBridgeToken: loadOptionalSecret(
      env,
      "DEVSPACE_NAOBRAIN_BRIDGE_TOKEN",
      "DEVSPACE_NAOBRAIN_BRIDGE_TOKEN_FILE",
    ),
    naobrainGeminiApiKey: loadOptionalSecret(
      env,
      "DEVSPACE_NAOBRAIN_GEMINI_API_KEY",
      "DEVSPACE_NAOBRAIN_GEMINI_API_KEY_FILE",
    ),
    naobrainGeminiModel: env.DEVSPACE_NAOBRAIN_GEMINI_MODEL?.trim() || "gemini-3.6-flash",
    naobrainGeminiFallbackModel: legacyFallbackIsLite
      ? "gemini-3.5-flash"
      : legacyGeminiFallbackModel || "gemini-3.5-flash",
    naobrainGeminiTertiaryModel: env.DEVSPACE_NAOBRAIN_GEMINI_TERTIARY_MODEL?.trim()
      || (legacyFallbackIsLite ? legacyGeminiFallbackModel : "gemini-3.5-flash-lite"),
    naobrainDriveRemote: env.DEVSPACE_NAOBRAIN_DRIVE_REMOTE?.trim() || null,
    naobrainDriveBasePath: env.DEVSPACE_NAOBRAIN_DRIVE_BASE_PATH?.trim() || "NaoBrain/Today",
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    skillsEnabled: env.DEVSPACE_SKILLS === undefined ? true : parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents:
      env.DEVSPACE_SUBAGENTS === undefined
        ? files.config.subagents === true
        : parseBoolean(env.DEVSPACE_SUBAGENTS),
    agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    logging: parseLoggingConfig(env),
  };
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}

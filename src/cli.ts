#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { loadConfig } from "./config.js";
import { runLocalAgentProvider } from "./local-agent-adapters.js";
import {
  assertLocalAgentProfileBoundary,
  isLocalAgentProvider,
  loadLocalAgentProfiles,
  type LocalAgentProfile,
} from "./local-agent-profiles.js";
import {
  assertLocalAgentProviderAvailable,
  formatLocalAgentProviderAvailabilitySummary,
} from "./local-agent-availability.js";
import {
  formatAvailableLocalAgentTargets,
  parseLocalAgentRunArgs,
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import { createLocalAgentStore, type LocalAgentRecord } from "./local-agent-store.js";
import type { LocalAgentRunResult } from "./local-agent-runtime.js";
import { cancelJob, runJobWorker, startJob } from "./job-runner.js";
import { createJobStore, isJobPreset, JOB_PRESETS, type JobRecord } from "./job-store.js";
import {
  computerUsePolicyPath,
  diagnoseComputerUse,
  initializeComputerUsePolicy,
  loadComputerUsePolicy,
} from "./computer-use.js";
import {
  approveBrowserAction,
  browserStatus,
  cancelBrowserApproval,
  captureBrowserScreenshot,
  clickBrowserPoint,
  inspectBrowserPage,
  listBrowserApprovals,
  openBrowserUrl,
  pressBrowserKey,
  scrollBrowserPage,
  startBrowserSession,
  stopBrowserSession,
  typeBrowserText,
} from "./browser-computer.js";
import {
  ensureDevspaceDefaultSkills,
  generateOwnerToken,
  loadDevspaceFiles,
  resolveSubagentsFlag,
  writeDevspaceAuth,
  writeDevspaceConfig,
  type DevspaceUserConfig,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";

type Command = "serve" | "init" | "doctor" | "config" | "agents" | "jobs" | "computer" | "help" | "version";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=20.12 <27";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor();
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "agents":
      await runAgentsCommand(args);
      return;
    case "jobs":
      await runJobsCommand(args);
      return;
    case "computer":
      await runComputerCommand(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "init" || command === "doctor" || command === "config" || command === "agents" || command === "jobs" || command === "computer") return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.configExists && files.authExists) return;
  if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "DevSpace is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  devspace init",
        "",
        "Or provide DEVSPACE_OAUTH_OWNER_TOKEN and DEVSPACE_ALLOWED_ROOTS.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadDevspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`DevSpace is already configured at ${files.dir}`);
    prompts.log.info("Run `devspace init --force` to update it.");
    return;
  }

  try {
    prompts.intro("DevSpace setup");

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsAnswer = await textPrompt({
      message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
      placeholder: defaultRoots,
      defaultValue: defaultRoots,
      validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
    });
    const allowedRoots = rootsAnswer
      .split(",")
      .map((root) => resolve(expandHomePath(root.trim())))
      .filter(Boolean);

    const defaultPort = String(files.config.port ?? 7676);
    const portAnswer = await textPrompt({
      message: `Which local port should DevSpace use? Press Enter to use ${defaultPort}`,
      placeholder: defaultPort,
      defaultValue: defaultPort,
      validate: validatePort,
    });
    const port = Number(portAnswer);

    prompts.note(
      [
        "DevSpace needs a public base URL so ChatGPT or Claude can reach this MCP server.",
        "Create a tunnel or reverse proxy with Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own HTTPS proxy.",
        "Paste the public origin here, without /mcp.",
        "",
        "Example: https://your-tunnel-host.example.com",
      ].join("\n"),
      "Public URL required",
    );
    const publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
      message: files.config.publicBaseUrl
        ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
        : "What is the public base URL?",
      placeholder: files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
      defaultValue: files.config.publicBaseUrl ?? "",
      validate: validateRequiredPublicBaseUrl,
    }));

    const config: DevspaceUserConfig = {
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
      subagents: resolveSubagentsFlag(files.config),
    };
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    const configPath = writeDevspaceConfig(config);
    const authPath = writeDevspaceAuth(auth);
    const seededSkillPaths = config.subagents ? ensureDevspaceDefaultSkills() : [];

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      ...seededSkillPaths.map((path) => `Default skill: ${path}`),
      `Local MCP URL: http://${config.host}:${config.port}/mcp`,
      ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "DevSpace configured");
    prompts.note(
      [
        `Owner password: ${auth.ownerToken}`,
        "Use this when ChatGPT or Claude asks you to approve DevSpace access.",
        `Stored at: ${authPath}`,
      ].join("\n"),
      "Owner password",
    );
    prompts.outro("Run `devspace serve` to start the MCP server.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  const { app, close, localAgentProviders } = createServer(config);
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=*");
    }
    console.log("auth: Owner password approval required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
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

async function runDoctor(): Promise<void> {
  const files = loadDevspaceFiles();
  console.log(`Config dir: ${files.dir}`);
  console.log(`Config file: ${files.configExists ? files.configPath : "missing"}`);
  console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
  console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
  console.log(`Node ABI: ${process.versions.modules}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Git: ${checkGitAvailable()}`);
  console.log(`Bash shell: ${checkBashShell()}`);
  console.log(`SQLite native dependency: ${checkSqliteNative()}`);

  try {
    const config = loadConfig();
    console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
    console.log(`Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
    console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
  } catch (error) {
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error("Only `devspace config set publicBaseUrl <url|null>` is supported right now.");
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error("Missing publicBaseUrl value.");
  }

  writeDevspaceConfig({
    ...files.config,
    publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
  });
  console.log(`Updated ${files.configPath}`);
}

function printHelp(): void {
  console.log(
    [
      "DevSpace",
      "",
      "Usage:",
      "  devspace                 Run first-time setup if needed, then start the server",
      "  devspace serve           Start the server",
      "  devspace init            Create or update ~/.devspace/config.json and auth.json",
      "  devspace doctor          Show config, runtime, and native dependency status",
      "  devspace config get      Print persisted config",
      "  devspace config set publicBaseUrl <url|null>",
      "  devspace agents ls       List subagent sessions",
      "  devspace agents run <profile-or-provider-or-id> [--model <model>] <prompt>",
      "  devspace agents show <id>",
      "  devspace jobs start <preset> [--title <title>]",
      "  devspace jobs ls [--json]",
      "  devspace jobs show <id> [--events] [--json]",
      "  devspace jobs cancel <id>",
      "  devspace computer doctor [--json]",
      "  devspace computer init",
      "  devspace computer policy [--json]",
      "  devspace computer browser <command>",
      "  devspace -v, --version   Print the installed version",
      "",
      "For temporary tunnels:",
      "  DEVSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com devspace serve",
    ].join("\n"),
  );
}

async function runComputerCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "doctor": {
      const result = diagnoseComputerUse();
      if (rest.includes("--json")) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log([
        `Computer Use: ${result.enabled ? "enabled" : "disabled"}`,
        `Policy: ${result.policyExists ? (result.policyValid ? "valid" : "invalid") : "not initialized"} (${result.policyPath})`,
        `Browser: ${result.browser.ready ? "ready" : "not ready"}${result.browser.name ? ` — ${result.browser.name}` : ""}`,
        `Browser adapter: ${result.browser.adapter} (${result.browser.nativeCdpAvailable ? "available" : "missing"})`,
        `Desktop: ${result.desktop.ready ? "ready" : "not ready"}`,
        `Confirmations: ${result.safety.confirmationsRequired.join(", ") || "none"}`,
        ...result.missingRequirements.map((item) => `Missing: ${item}`),
        ...result.diagnostics.map((item) => `Note: ${item}`),
      ].join("\n"));
      return;
    }
    case "init": {
      const initialized = initializeComputerUsePolicy();
      console.log(`${initialized.created ? "Created" : "Existing"} disabled-by-default policy: ${initialized.path}`);
      return;
    }
    case "policy": {
      const path = computerUsePolicyPath();
      const loaded = loadComputerUsePolicy(path);
      if (!loaded.valid) throw new Error(`Computer Use policy is invalid: ${loaded.error}`);
      if (rest.includes("--json")) {
        console.log(JSON.stringify({ path, exists: loaded.exists, policy: loaded.policy }, null, 2));
        return;
      }
      console.log([
        `Policy: ${path}`,
        `Exists: ${loaded.exists}`,
        `Enabled: ${loaded.policy.enabled}`,
        `Browser enabled: ${loaded.policy.browser.enabled}`,
        `Allowed domains: ${loaded.policy.browser.allowedDomains.length}`,
        `Desktop enabled: ${loaded.policy.desktop.enabled}`,
        `Allowed applications: ${loaded.policy.desktop.allowedApplications.length}`,
      ].join("\n"));
      return;
    }
    case "browser":
      await runBrowserComputerCommand(rest);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printComputerHelp();
      return;
    default:
      throw new Error(`Unknown computer command: ${subcommand}`);
  }
}

async function runBrowserComputerCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "start":
      console.log(JSON.stringify(await startBrowserSession(), null, 2));
      return;
    case "status":
      console.log(JSON.stringify(await browserStatus(), null, 2));
      return;
    case "stop":
      console.log(JSON.stringify(await stopBrowserSession(), null, 2));
      return;
    case "open": {
      const url = rest[0];
      if (!url) throw new Error("Usage: devspace computer browser open <url>");
      console.log(JSON.stringify(await openBrowserUrl(url), null, 2));
      return;
    }
    case "inspect":
      console.log(JSON.stringify(await inspectBrowserPage(), null, 2));
      return;
    case "screenshot": {
      const screenshot = await captureBrowserScreenshot();
      const { base64: _base64, ...safe } = screenshot;
      console.log(JSON.stringify(safe, null, 2));
      return;
    }
    case "click": {
      const x = Number(rest[0]);
      const y = Number(rest[1]);
      console.log(JSON.stringify(await clickBrowserPoint(x, y), null, 2));
      return;
    }
    case "type": {
      const text = rest.join(" ");
      if (!text) throw new Error("Usage: devspace computer browser type <text>");
      console.log(JSON.stringify(await typeBrowserText(text), null, 2));
      return;
    }
    case "key": {
      const key = rest[0];
      if (!key) throw new Error("Usage: devspace computer browser key <key>");
      console.log(JSON.stringify(await pressBrowserKey(key), null, 2));
      return;
    }
    case "scroll": {
      const deltaX = Number(rest[0]);
      const deltaY = Number(rest[1]);
      console.log(JSON.stringify(await scrollBrowserPage(deltaX, deltaY), null, 2));
      return;
    }
    case "approvals":
      console.log(JSON.stringify({ approvals: listBrowserApprovals() }, null, 2));
      return;
    case "approve": {
      const id = rest[0];
      if (!id) throw new Error("Usage: devspace computer browser approve <approval-id>");
      const localApproval = process.env.DEVSPACE_LOCAL_APPROVAL_UI === "1";
      if (localApproval) confirmBrowserApprovalWithMacOS(id);
      console.log(JSON.stringify(await approveBrowserAction(id, { localApproval }), null, 2));
      return;
    }
    case "reject": {
      const id = rest[0];
      if (!id) throw new Error("Usage: devspace computer browser reject <approval-id>");
      if (process.env.DEVSPACE_LOCAL_APPROVAL_UI !== "1") {
        throw new Error("Browser approval rejection requires the local GPT-Agent Tool app.");
      }
      console.log(JSON.stringify(cancelBrowserApproval(id), null, 2));
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printComputerHelp();
      return;
    default:
      throw new Error(`Unknown browser computer command: ${subcommand}`);
  }
}

function confirmBrowserApprovalWithMacOS(id: string): void {
  if (process.platform !== "darwin") {
    throw new Error("Local Browser Computer approval currently requires macOS.");
  }
  const approval = listBrowserApprovals().find((candidate) => candidate.id === id);
  if (!approval || approval.status !== "pending") {
    throw new Error(`Pending browser approval was not found: ${id}`);
  }
  const label = approval.element?.text || approval.element?.ariaLabel || approval.category;
  const safeLabel = label.replace(/[\\"\n\r]/gu, " ").slice(0, 120);
  const safeReason = approval.reason.replace(/[\\"\n\r]/gu, " ").slice(0, 180);
  const script = [
    `display dialog "GPT-Agent Browser Computer\\n\\n${safeLabel}\\n${safeReason}\\n\\nExecute this action?"`,
    `buttons {"Cancel", "Approve"}`,
    `default button "Approve"`,
    `cancel button "Cancel"`,
    `with icon caution`,
  ].join(" ");
  const result = spawnSync("/usr/bin/osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0 || !String(result.stdout).includes("Approve")) {
    throw new Error("Browser approval was cancelled locally.");
  }
}

function printComputerHelp(): void {
  console.log([
    "GPT-Agent Computer Use",
    "",
    "Usage:",
    "  devspace computer doctor [--json]",
    "  devspace computer init",
    "  devspace computer policy [--json]",
    "  devspace computer browser start|status|stop",
    "  devspace computer browser open <url>",
    "  devspace computer browser inspect",
    "  devspace computer browser screenshot",
    "  devspace computer browser click <x> <y>",
    "  devspace computer browser type <text>",
    "  devspace computer browser key <Tab|Escape|Backspace|Arrow...|Enter>",
    "  devspace computer browser scroll <delta-x> <delta-y>",
    "  devspace computer browser approvals",
    "",
    "Approval execution is restricted to the local GPT-Agent Tool app.",
    "Credentials must be entered manually in the isolated browser.",
  ].join("\n"));
}

async function runJobsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "start":
      await runJobsStart(rest);
      return;
    case "ls":
    case "list":
      runJobsList(rest);
      return;
    case "show":
      runJobsShow(rest);
      return;
    case "cancel":
      runJobsCancel(rest);
      return;
    case "__worker":
      await runJobsWorker(rest);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printJobsHelp();
      return;
    default:
      throw new Error(`Unknown jobs command: ${subcommand}`);
  }
}

async function runJobsStart(args: string[]): Promise<void> {
  const [presetValue] = args;
  if (!presetValue || !isJobPreset(presetValue)) {
    throw new Error(`Usage: devspace jobs start <preset>. Presets: ${JOB_PRESETS.join(", ")}`);
  }
  const titleIndex = args.indexOf("--title");
  const title = titleIndex >= 0 ? args[titleIndex + 1] : undefined;
  if (titleIndex >= 0 && !title) throw new Error("--title requires a value.");
  const config = loadConfig();
  const record = startJob(config, {
    workspaceId: process.env.DEVSPACE_WORKSPACE_ID || undefined,
    workspaceRoot: resolveCurrentWorkspaceRoot(),
    preset: presetValue,
    title,
  });
  console.log(formatJobLine(record));
}

function runJobsList(args: string[]): void {
  const config = loadConfig();
  const store = createJobStore(config);
  try {
    store.recoverStaleJobs();
    const all = args.includes("--all");
    const json = args.includes("--json");
    const scope = all ? {} : resolveCurrentWorkspaceScope();
    const jobs = store.list({ ...scope, limit: 100 });
    if (json) {
      console.log(JSON.stringify({ jobs }, null, 2));
      return;
    }
    if (jobs.length === 0) {
      console.log(all ? "No GPT-Agent jobs found." : "No GPT-Agent jobs found for this workspace.");
      return;
    }
    for (const job of jobs) console.log(formatJobLine(job));
  } finally {
    store.close();
  }
}

function runJobsShow(args: string[]): void {
  const [id] = args;
  if (!id) throw new Error("Usage: devspace jobs show <id> [--events] [--json]");
  const config = loadConfig();
  const store = createJobStore(config);
  try {
    store.recoverStaleJobs();
    const job = store.get(id);
    if (!job) throw new Error(`Unknown or ambiguous job id: ${id}`);
    const includeEvents = args.includes("--events");
    const events = includeEvents ? store.events(job.id, 200) : undefined;
    if (args.includes("--json")) {
      console.log(JSON.stringify({ job, ...(events ? { events } : {}) }, null, 2));
      return;
    }
    console.log(formatJobLine(job));
    if (job.error) console.log(`error: ${job.error}`);
    for (const event of events ?? []) {
      console.log(`${event.timestamp} ${event.level.padEnd(7)} ${event.message}`);
    }
  } finally {
    store.close();
  }
}

function runJobsCancel(args: string[]): void {
  const [id] = args;
  if (!id) throw new Error("Usage: devspace jobs cancel <id>");
  const record = cancelJob(loadConfig(), id);
  console.log(formatJobLine(record));
}

async function runJobsWorker(args: string[]): Promise<void> {
  const [id] = args;
  if (!id) throw new Error("Usage: devspace jobs __worker <id>");
  await runJobWorker(loadConfig(), id);
}

function formatJobLine(job: JobRecord): string {
  return `${job.id} ${job.status.padEnd(11)} ${String(job.progress).padStart(3)}% ${job.preset.padEnd(13)} ${job.title} — ${job.currentStep}`;
}

function printJobsHelp(): void {
  console.log([
    "GPT-Agent jobs",
    "",
    "Safe parallel presets:",
    `  ${JOB_PRESETS.join(", ")}`,
    "",
    "Usage:",
    "  devspace jobs start <preset> [--title <title>]",
    "  devspace jobs ls [--all] [--json]",
    "  devspace jobs show <id> [--events] [--json]",
    "  devspace jobs cancel <id>",
  ].join("\n"));
}

async function runAgentsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "ls":
    case "list":
      await runAgentsList();
      return;
    case "run":
      await runAgentsRun(rest);
      return;
    case "show":
      await runAgentsShow(rest);
      return;
    case "__worker":
      await runAgentsWorker(rest);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printAgentsHelp();
      return;
    default:
      throw new Error(`Unknown agents command: ${subcommand}`);
  }
}

async function runAgentsList(): Promise<void> {
  const config = loadConfig();
  const store = createLocalAgentStore(config);
  const agents = store.list(resolveCurrentWorkspaceScope());

  if (agents.length === 0) {
    console.log("No subagent sessions found for this workspace.");
    return;
  }

  for (const agent of agents) {
    console.log(formatAgentLine(agent));
  }
}

async function runAgentsRun(args: string[]): Promise<void> {
  const parsed = parseLocalAgentRunArgs(args);

  const config = loadConfig();
  const workspaceRoot = resolveCurrentWorkspaceRoot();
  const store = createLocalAgentStore(config);
  const existing = store.get(parsed.target);

  if (existing) {
    if (!isLocalAgentProvider(existing.provider)) {
      throw new Error(`Unknown subagent provider for existing session: ${existing.provider}`);
    }
    assertLocalAgentProviderAvailable(existing.provider);
    const promptFile = writeAgentPromptFile(parsed.prompt);
    store.update(existing.id, {
      status: "starting",
      model: parsed.model ?? existing.model,
      thinking: parsed.thinking ?? existing.thinking,
      latestResponse: undefined,
      error: undefined,
    });
    spawnAgentWorker(existing.id, promptFile);
    console.log(formatAgentLine({
      ...existing,
      status: "running",
      model: parsed.model ?? existing.model,
      thinking: parsed.thinking ?? existing.thinking,
    }));
    return;
  }

  const profiles = await loadLocalAgentProfiles(config, workspaceRoot);
  const target = resolveLocalAgentTarget(parsed.target, profiles, parsed.model, parsed.thinking);
  if (!target) {
    throw new Error(
      `Unknown subagent profile, provider, or id: ${parsed.target}. Available ${formatAvailableLocalAgentTargets(profiles)}`,
    );
  }
  if (target.kind === "profile") assertLocalAgentProfileBoundary(target.profile);
  assertLocalAgentProviderAvailable(target.provider);

  const promptFile = writeAgentPromptFile(parsed.prompt);
  const record = store.create({
    workspaceId: process.env.DEVSPACE_WORKSPACE_ID,
    workspaceRoot,
    profileName: target.name,
    provider: target.provider,
    model: target.model,
    thinking: target.thinking,
  });

  spawnAgentWorker(record.id, promptFile);
  console.log(formatAgentLine({ ...record, status: "running" }));
}

async function runAgentsShow(args: string[]): Promise<void> {
  const [id] = args;
  if (!id) throw new Error("Usage: devspace agents show <id>");

  const config = loadConfig();
  const store = createLocalAgentStore(config);
  let record = store.get(id);
  if (!record) throw new Error(`Unknown subagent id: ${id}`);

  const deadline = Date.now() + 15_000;
  while ((record.status === "starting" || record.status === "running") && Date.now() < deadline) {
    await sleep(500);
    record = store.get(id) ?? record;
  }

  console.log(formatAgentLine(record));
  if (record.latestResponse) {
    console.log(record.latestResponse);
    return;
  }
  if (record.error) {
    console.log(record.error);
    return;
  }
  if (record.status === "starting" || record.status === "running") {
    console.log(`No final response yet. Call \`devspace agents show ${record.id}\` again later.`);
  }
}

async function runAgentsWorker(args: string[]): Promise<void> {
  const [id, promptFileFlag, promptFile] = args;
  if (!id || promptFileFlag !== "--prompt-file" || !promptFile) {
    throw new Error("Usage: devspace agents __worker <id> --prompt-file <path>");
  }

  const config = loadConfig();
  const store = createLocalAgentStore(config);
  const record = store.get(id);
  if (!record) throw new Error(`Unknown subagent id: ${id}`);

  store.update(record.id, { status: "running", error: undefined });
  try {
    const profiles = await loadLocalAgentProfiles(config, record.workspaceRoot);
    const profile = profiles.find((candidate) => candidate.name === record.profileName);
    const prompt = await readFile(promptFile, "utf8");
    const result = profile
      ? await runLocalAgentProfile(profile, record, prompt)
      : await runRawLocalAgentProvider(record, prompt);
    store.update(record.id, {
      providerSessionId: result.providerSessionId ?? undefined,
      status: "idle",
      latestResponse: result.finalResponse,
      error: undefined,
    });
  } catch (error) {
    store.update(record.id, {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runLocalAgentProfile(
  profile: LocalAgentProfile,
  record: LocalAgentRecord,
  prompt: string,
): Promise<LocalAgentRunResult> {
  assertLocalAgentProfileBoundary(profile);
  const body = profile.body.trim();
  const fullPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
  return runLocalAgentProvider(profile.provider, {
    prompt: fullPrompt,
    workspace: record.workspaceRoot,
    providerSessionId: record.providerSessionId,
    writeMode: profile.writeMode,
    model: record.model ?? profile.model,
    thinking: record.thinking ?? profile.thinking,
  });
}

async function runRawLocalAgentProvider(
  record: LocalAgentRecord,
  prompt: string,
): Promise<LocalAgentRunResult> {
  if (record.profileName !== record.provider || !isLocalAgentProvider(record.provider)) {
    throw new Error(`Subagent profile not found: ${record.profileName}`);
  }

  return runLocalAgentProvider(record.provider, {
    prompt,
    workspace: record.workspaceRoot,
    providerSessionId: record.providerSessionId,
    writeMode: "allowed",
    model: record.model,
    thinking: record.thinking,
  });
}

function spawnAgentWorker(agentId: string, promptFile: string): void {
  const child = spawn(process.execPath, [
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    "agents",
    "__worker",
    agentId,
    "--prompt-file",
    promptFile,
  ], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

function writeAgentPromptFile(prompt: string): string {
  const directory = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
  const filePath = join(directory, "prompt.txt");
  writeFileSync(filePath, prompt, { mode: 0o600 });
  return filePath;
}

function resolveCurrentWorkspaceRoot(): string {
  return resolve(process.env.DEVSPACE_WORKSPACE_ROOT || process.cwd());
}

function resolveCurrentWorkspaceScope(): { workspaceId?: string; workspaceRoot: string } {
  return {
    workspaceId: process.env.DEVSPACE_WORKSPACE_ID,
    workspaceRoot: resolveCurrentWorkspaceRoot(),
  };
}

function formatAgentLine(agent: Pick<
  LocalAgentRecord,
  "id" | "status" | "profileName" | "provider" | "model" | "thinking"
>): string {
  const model = agent.model ? ` ${agent.model}` : "";
  const thinking = agent.thinking ? ` thinking=${agent.thinking}` : "";
  return `${agent.id} ${agent.status} ${agent.profileName} ${agent.provider}${model}${thinking}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printAgentsHelp(): void {
  console.log(
    [
      "DevSpace agents",
      "",
      "Usage:",
      "  devspace agents ls",
      "  devspace agents run <profile-or-provider-or-id> [--model <model>] [--thinking <level>] <prompt>",
      "  devspace agents show <id>",
    ].join("\n"),
  );
}

function printVersion(): void {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Unable to read DevSpace package version.");
  }

  console.log(packageJson.version);
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function validatePort(value: string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "Enter a port between 1 and 65535.";
}

function validateRequiredPublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `DevSpace requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

function nodeVersionStatus(): string {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

class SetupCancelledError extends Error {}

function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

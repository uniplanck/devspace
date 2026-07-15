import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import {
  createJobStore,
  type JobEventLevel,
  type JobPreset,
  type JobRecord,
  type JobStore,
} from "./job-store.js";
import { runCompatibilitySmoke } from "./runtime-operations.js";
import { resolveExecutable, shellPathInfo } from "./shell-environment.js";
import {
  cancelBrowserApproval,
  configureBrowserDownloadDirectory,
  listBrowserApprovals,
  startBrowserSession,
} from "./browser-computer.js";
import {
  runChatGptTask,
  type ChatGptTaskInput,
  type ChatGptTaskState,
} from "./chatgpt-task.js";
import {
  createHermesBrowserTaskPlanner,
  createNativeBrowserTaskDriver,
  runBrowserTaskLoop,
  type BrowserTaskLoopInput,
  type BrowserTaskLoopRuntime,
  type BrowserTaskLoopState,
} from "./browser-task-loop.js";
import { GoogleAIKeyPool, loadBrowserPlannerConfig } from "./google-ai-key-pool.js";

export interface StartJobInput {
  workspaceId?: string;
  workspaceRoot: string;
  preset: JobPreset;
  title?: string;
  input?: Record<string, unknown>;
}

export interface JobRunnerOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  browserLoopRuntime?: BrowserTaskLoopRuntime;
}

export function startJob(
  config: Pick<ServerConfig, "stateDir">,
  input: StartJobInput,
): JobRecord {
  const store = createJobStore(config);
  try {
    store.recoverStaleJobs();
    const record = store.create(input);
    return launchJobWorker(store, record, "Worker started");
  } finally {
    store.close();
  }
}

export async function runJobWorker(
  config: Pick<ServerConfig, "stateDir">,
  jobId: string,
  options: JobRunnerOptions = {},
): Promise<JobRecord> {
  const store = createJobStore(config);
  const concurrency = clampInteger(
    options.concurrency ?? readConcurrency(process.env.DEVSPACE_JOB_CONCURRENCY),
    3,
    1,
    8,
  );
  const pollIntervalMs = clampInteger(options.pollIntervalMs, 350, 50, 5_000);
  let child: ChildProcess | undefined;

  try {
    let job = requireJob(store, jobId);
    store.update(job.id, { workerPid: process.pid, currentStep: "Waiting for execution slot", progress: 3 });
    store.appendEvent(job.id, "info", `Worker ready. Concurrency limit: ${concurrency}.`);

    job = requireJob(store, job.id);
    if (job.status === "cancelled" || job.status === "cancelling") {
      return finalizeCancelled(store, job, "Cancelled while queued.");
    }
    while (store.runningCount(job.workspaceRoot, job.id) >= concurrency) {
      await sleep(pollIntervalMs);
      job = requireJob(store, job.id);
      if (job.status === "cancelled" || job.status === "cancelling") {
        return finalizeCancelled(store, job, "Cancelled while queued.");
      }
    }

    job = store.update(job.id, {
      status: "running",
      progress: 8,
      currentStep: "Preparing preset",
      startedAt: job.startedAt ?? new Date().toISOString(),
      error: undefined,
    });
    store.appendEvent(job.id, "info", `Running preset: ${job.preset}.`);

    if (job.preset === "runtime-smoke") {
      return await runRuntimeSmokeJob(store, job);
    }
    if (job.preset === "browser-loop") {
      return await runBrowserLoopJob(store, job, options.browserLoopRuntime);
    }
    if (job.preset === "chatgpt-task") {
      return await runChatGptTaskJob(store, job);
    }

    const command = await resolvePresetCommand(job.preset, job.workspaceRoot);
    job = requireJob(store, job.id);
    if (job.status === "cancelled" || job.status === "cancelling") {
      return finalizeCancelled(store, job, "Cancelled before process launch.");
    }
    const pathInfo = shellPathInfo(process.env);
    child = spawn(command.executable, command.args, {
      cwd: job.workspaceRoot,
      env: { ...process.env, PATH: pathInfo.path },
      detached: false,
      shell: command.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    job = store.update(job.id, {
      processPid: child.pid,
      progress: 12,
      currentStep: command.label,
    });
    store.appendEvent(job.id, "info", `${command.label}${child.pid ? ` (pid ${child.pid})` : ""}.`);

    let firstOutputSeen = false;
    const consume = (stream: NodeJS.ReadableStream | null, level: JobEventLevel) => {
      if (!stream) return;
      const lines = createInterface({ input: stream });
      lines.on("line", (line) => {
        if (!line.trim()) return;
        store.appendEvent(job.id, level, line);
        const progress = inferProgress(job.preset, line, firstOutputSeen);
        firstOutputSeen = true;
        if (progress) {
          store.update(job.id, {
            progress: Math.max(requireJob(store, job.id).progress, progress.value),
            currentStep: progress.step,
          });
        }
      });
    };
    consume(child.stdout, "stdout");
    consume(child.stderr, "stderr");

    const exit = await waitForExit(child);
    job = requireJob(store, job.id);
    if (job.status === "cancelling" || job.status === "cancelled") {
      return finalizeCancelled(store, job, "Cancelled by request.", exit.code);
    }
    if (exit.code === 0) {
      const completed = store.update(job.id, {
        status: "succeeded",
        progress: 100,
        currentStep: "Completed",
        exitCode: 0,
        processPid: undefined,
        workerPid: undefined,
        finishedAt: new Date().toISOString(),
      });
      store.appendEvent(job.id, "info", "Job completed successfully.");
      return completed;
    }

    const message = exit.signal
      ? `Process ended by signal ${exit.signal}.`
      : `Process exited with code ${exit.code ?? "unknown"}.`;
    const failed = store.update(job.id, {
      status: "failed",
      progress: 100,
      currentStep: "Failed",
      exitCode: exit.code ?? undefined,
      processPid: undefined,
      workerPid: undefined,
      error: message,
      finishedAt: new Date().toISOString(),
    });
    store.appendEvent(job.id, "error", message);
    return failed;
  } catch (error) {
    const current = store.get(jobId);
    if (!current) throw error;
    if (current.status === "cancelling" || current.status === "cancelled") {
      return finalizeCancelled(store, current, "Cancelled by request.");
    }
    const message = error instanceof Error ? error.message : String(error);
    const failed = store.update(current.id, {
      status: "failed",
      progress: 100,
      currentStep: "Failed",
      processPid: undefined,
      workerPid: undefined,
      error: message,
      finishedAt: new Date().toISOString(),
    });
    store.appendEvent(current.id, "error", message);
    return failed;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGTERM"); } catch { /* process already exited */ }
    }
    store.close();
  }
}

export function cancelJob(
  config: Pick<ServerConfig, "stateDir">,
  idOrPrefix: string,
): JobRecord {
  const store = createJobStore(config);
  try {
    store.recoverStaleJobs();
    const job = store.get(idOrPrefix);
    if (!job) throw new Error(`Unknown or ambiguous job id: ${idOrPrefix}`);
    if (isTerminal(job.status)) return job;

    if (job.status === "queued" || job.status === "waiting_approval") {
      if (job.status === "waiting_approval") {
        const pendingApprovalId = readPendingApprovalId(job.state);
        if (pendingApprovalId) {
          try { cancelBrowserApproval(pendingApprovalId); } catch { /* already resolved or unavailable */ }
        }
      }
      const cancelled = store.update(job.id, {
        status: "cancelled",
        currentStep: "Cancelled before start",
        workerPid: undefined,
        processPid: undefined,
        finishedAt: new Date().toISOString(),
      });
      store.appendEvent(job.id, "warning", job.status === "waiting_approval"
        ? "Job cancelled while waiting for local approval."
        : "Job cancelled before execution.");
      return cancelled;
    }

    const cancelling = store.update(job.id, {
      status: "cancelling",
      currentStep: "Cancellation requested",
    });
    store.appendEvent(job.id, "warning", "Cancellation requested.");
    if (job.processPid) terminateProcess(job.processPid);
    return cancelling;
  } finally {
    store.close();
  }
}

export function resumeJob(
  config: Pick<ServerConfig, "stateDir">,
  idOrPrefix: string,
): JobRecord {
  const store = createJobStore(config);
  try {
    store.recoverStaleJobs();
    const job = store.get(idOrPrefix);
    if (!job) throw new Error(`Unknown or ambiguous job id: ${idOrPrefix}`);
    if (job.status !== "waiting_approval" && job.status !== "interrupted") {
      throw new Error(`Job cannot be resumed from status ${job.status}.`);
    }
    if (job.status === "waiting_approval") {
      const pendingApprovalId = readPendingApprovalId(job.state);
      if (!pendingApprovalId) throw new Error("Waiting browser job has no pending approval id.");
      const approval = listBrowserApprovals().find((candidate) => candidate.id === pendingApprovalId);
      if (!approval) throw new Error(`Pending browser approval was not found: ${pendingApprovalId}`);
      if (approval.status === "pending") {
        throw new Error(`Browser approval is still pending: ${pendingApprovalId}`);
      }
      if (approval.status !== "executed") {
        throw new Error(`Browser approval cannot resume the job from status ${approval.status}.`);
      }
    }
    const queued = store.update(job.id, {
      status: "queued",
      currentStep: "Queued for resume",
      workerPid: undefined,
      processPid: undefined,
      finishedAt: undefined,
      error: undefined,
    });
    store.appendEvent(job.id, "info", `Resume requested from ${job.status}.`);
    return launchJobWorker(store, queued, "Resume worker started");
  } finally {
    store.close();
  }
}

function launchJobWorker(store: JobStore, record: JobRecord, eventPrefix: string): JobRecord {
  const modulePath = fileURLToPath(import.meta.url);
  const cliPath = fileURLToPath(new URL(modulePath.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url));
  const worker = spawn(
    process.execPath,
    [...process.execArgv, cliPath, "jobs", "__worker", record.id],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        DEVSPACE_WORKSPACE_ID: record.workspaceId ?? "",
        DEVSPACE_WORKSPACE_ROOT: record.workspaceRoot,
      },
    },
  );
  worker.unref();
  const updated = store.update(record.id, {
    workerPid: worker.pid,
    currentStep: "Worker starting",
    progress: Math.max(2, record.progress),
  });
  store.appendEvent(record.id, "info", `${eventPrefix}${worker.pid ? ` (pid ${worker.pid})` : ""}.`);
  return updated;
}

async function runBrowserLoopJob(
  store: JobStore,
  job: JobRecord,
  injectedRuntime?: BrowserTaskLoopRuntime,
): Promise<JobRecord> {
  const input = readBrowserLoopInput(job.input);
  if (!injectedRuntime) {
    const browser = await startBrowserSession();
    store.appendEvent(
      job.id,
      "info",
      `Browser session: ${browser.status} (${browser.session.backgroundMode}).`,
    );
    const downloadDirectory = await configureBrowserDownloadDirectory({
      group: input.downloadGroup ?? "browser",
      taskId: `${job.title}-${job.id}`,
    });
    store.appendEvent(job.id, "info", `Browser downloads: ${downloadDirectory.path}`);
  }
  const plannerConfig = loadBrowserPlannerConfig();
  const configuredKeyCount = new GoogleAIKeyPool().configuredSlots().length;
  const configuredPlannerReady = plannerConfig.enabled && configuredKeyCount > 0;
  const configuredProvider = configuredPlannerReady ? plannerConfig.provider : undefined;
  const configuredModel = configuredPlannerReady ? plannerConfig.model : undefined;
  const plannerProvider = input.plannerProvider
    ?? process.env.DEVSPACE_BROWSER_PLANNER_PROVIDER
    ?? configuredProvider;
  const plannerModel = input.plannerModel
    ?? process.env.DEVSPACE_BROWSER_PLANNER_MODEL
    ?? configuredModel;
  if (!injectedRuntime) {
    store.appendEvent(
      job.id,
      "info",
      `Browser planner: ${plannerProvider ?? "not configured"}${plannerModel ? ` / ${plannerModel}` : ""}.`,
    );
  }
  const runtime = injectedRuntime ?? {
    planner: createHermesBrowserTaskPlanner({
      provider: plannerProvider,
      model: plannerModel,
    }),
    driver: createNativeBrowserTaskDriver(),
  };
  store.update(job.id, { progress: Math.max(job.progress, 12), currentStep: "Inspecting browser page" });
  const result = await runBrowserTaskLoop(
    input,
    runtime,
    job.state as BrowserTaskLoopState | undefined,
    (state, step) => {
      const progress = Math.min(94, 12 + Math.round((step.step / (input.maxSteps ?? 20)) * 80));
      store.update(job.id, {
        state: state as unknown as Record<string, unknown>,
        progress,
        currentStep: `Browser step ${step.step}: ${step.action.kind}`,
      });
      store.appendEvent(job.id, "info", `Browser step ${step.step}: ${step.action.kind} — ${step.outcome}`);
    },
  );

  if (result.status === "waiting-approval") {
    const waiting = store.update(job.id, {
      status: "waiting_approval",
      state: result.state as unknown as Record<string, unknown>,
      currentStep: `Waiting for local ${result.approval.category} approval`,
      workerPid: undefined,
      processPid: undefined,
    });
    store.appendEvent(job.id, "warning", `Local approval required: ${result.approval.id} (${result.approval.category}).`);
    return waiting;
  }
  if (result.status === "succeeded") {
    const completed = store.update(job.id, {
      status: "succeeded",
      progress: 100,
      state: result.state as unknown as Record<string, unknown>,
      currentStep: "Completed",
      exitCode: 0,
      processPid: undefined,
      workerPid: undefined,
      finishedAt: new Date().toISOString(),
    });
    store.appendEvent(job.id, "info", `Browser goal completed: ${result.summary}`);
    return completed;
  }
  const failed = store.update(job.id, {
    status: "failed",
    progress: 100,
    state: result.state as unknown as Record<string, unknown>,
    currentStep: "Browser task failed",
    exitCode: 1,
    processPid: undefined,
    workerPid: undefined,
    error: result.error,
    finishedAt: new Date().toISOString(),
  });
  store.appendEvent(job.id, "error", result.error);
  return failed;
}

async function runChatGptTaskJob(store: JobStore, job: JobRecord): Promise<JobRecord> {
  const input = readChatGptTaskInput(job.input);
  store.appendEvent(
    job.id,
    "info",
    "Execution engine: deterministic ChatGPT DOM; Hermes calls: 0; Codex planner calls: 0.",
  );
  const result = await runChatGptTask(
    input,
    job.state as Partial<ChatGptTaskState> | undefined,
    {
      onPhase: (phase, state) => {
        const progress = phase === "opening" ? 15 : phase === "waiting-approval" ? 35 : phase === "waiting-response" ? 55 : 95;
        store.update(job.id, {
          state: state as unknown as Record<string, unknown>,
          progress: Math.max(requireJob(store, job.id).progress, progress),
          currentStep: phase === "opening"
            ? "Opening isolated ChatGPT browser target"
            : phase === "waiting-approval"
              ? "Waiting for local submit approval"
              : phase === "waiting-response"
                ? "Waiting locally for ChatGPT response"
                : "Response captured",
        });
      },
      shouldStop: () => {
        const current = store.get(job.id);
        return current?.status === "cancelling" || current?.status === "cancelled";
      },
    },
  );

  if (result.status === "waiting-approval") {
    const waiting = store.update(job.id, {
      status: "waiting_approval",
      state: result.state as unknown as Record<string, unknown>,
      currentStep: "Waiting for local submit approval",
      workerPid: undefined,
      processPid: undefined,
    });
    store.appendEvent(job.id, "warning", `Local approval required: ${result.approval.id} (submit).`);
    return waiting;
  }

  const completed = store.update(job.id, {
    status: "succeeded",
    progress: 100,
    state: result.state as unknown as Record<string, unknown>,
    currentStep: "Completed without planner LLM",
    exitCode: 0,
    processPid: undefined,
    workerPid: undefined,
    finishedAt: new Date().toISOString(),
  });
  store.appendEvent(job.id, "info", `ChatGPT response captured (${result.responseText.length} characters).`);
  store.appendEvent(
    job.id,
    "info",
    `ChatGPT model: ${result.state.selectedModelLabel ?? result.state.selectedModel ?? result.state.requestedModel ?? "unverified"} (${result.state.modelSelectionStatus ?? "url-only"}).`,
  );
  store.appendEvent(job.id, "info", `Resume URL: ${result.conversationUrl}`);
  if (result.state.tabClosed) store.appendEvent(job.id, "info", "Unused child tab closed after result capture.");
  return completed;
}

function readPendingApprovalId(value: Record<string, unknown> | undefined): string | undefined {
  return typeof value?.pendingApprovalId === "string" && value.pendingApprovalId.trim()
    ? value.pendingApprovalId.trim()
    : undefined;
}

function readChatGptTaskInput(value: Record<string, unknown> | undefined): ChatGptTaskInput {
  const prompt = typeof value?.prompt === "string" ? value.prompt : "";
  if (!prompt.trim()) throw new Error("ChatGPT task requires an input.prompt string.");
  const url = typeof value?.url === "string" ? value.url : undefined;
  const expectedMarker = typeof value?.expectedMarker === "string" ? value.expectedMarker : undefined;
  const timeoutMs = typeof value?.timeoutMs === "number" ? value.timeoutMs : undefined;
  const closeWhenDone = typeof value?.closeWhenDone === "boolean" ? value.closeWhenDone : undefined;
  return { prompt, url, expectedMarker, timeoutMs, closeWhenDone };
}

function readBrowserLoopInput(value: Record<string, unknown> | undefined): BrowserTaskLoopInput {
  const goal = typeof value?.goal === "string" ? value.goal : "";
  if (!goal.trim()) throw new Error("Browser loop job requires an input.goal string.");
  const maxSteps = typeof value?.maxSteps === "number" ? value.maxSteps : undefined;
  const plannerProvider = typeof value?.plannerProvider === "string" ? value.plannerProvider : undefined;
  const plannerModel = typeof value?.plannerModel === "string" ? value.plannerModel : undefined;
  const downloadGroup = typeof value?.downloadGroup === "string" ? value.downloadGroup : undefined;
  return { goal, maxSteps, plannerProvider, plannerModel, downloadGroup };
}

async function runRuntimeSmokeJob(store: JobStore, job: JobRecord): Promise<JobRecord> {
  store.update(job.id, { progress: 35, currentStep: "Running compatibility checks" });
  const result = await runCompatibilitySmoke(job.workspaceRoot);
  for (const step of result.steps) {
    store.appendEvent(
      job.id,
      step.status === "failed" ? "error" : "stdout",
      `${step.name}: ${step.status} — ${step.detail}`,
    );
  }
  const success = result.status === "passed";
  const completed = store.update(job.id, {
    status: success ? "succeeded" : "failed",
    progress: 100,
    currentStep: success ? "Completed" : "Smoke test failed",
    exitCode: success ? 0 : 1,
    processPid: undefined,
    workerPid: undefined,
    error: success ? undefined : `${result.summary.failed} smoke check(s) failed.`,
    finishedAt: new Date().toISOString(),
  });
  store.appendEvent(
    job.id,
    success ? "info" : "error",
    `Smoke summary: ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped.`,
  );
  return completed;
}

async function resolvePresetCommand(
  preset: Exclude<JobPreset, "runtime-smoke" | "browser-loop" | "chatgpt-task">,
  workspaceRoot: string,
): Promise<{ executable: string; args: string[]; label: string; shell?: boolean }> {
  if (preset === "git-status") {
    const git = resolveExecutable("git");
    if (!git) throw new Error("git executable not found on the augmented PATH.");
    return { executable: git, args: ["status", "--short", "--branch"], label: "Inspecting Git status" };
  }

  const packagePath = pathToFileURL(join(workspaceRoot, "package.json"));
  let scripts: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
    scripts = parsed.scripts ?? {};
  } catch {
    throw new Error(`Unable to read package.json in ${workspaceRoot}.`);
  }
  if (typeof scripts[preset] !== "string") {
    throw new Error(`package.json does not define the ${preset} script.`);
  }
  const npm = resolveExecutable("npm");
  if (!npm) throw new Error("npm executable not found on the augmented PATH.");
  return {
    executable: npm,
    args: ["run", preset],
    label: `Running npm ${preset}`,
    shell: process.platform === "win32",
  };
}

function inferProgress(
  preset: JobPreset,
  line: string,
  outputSeen: boolean,
): { value: number; step: string } | undefined {
  const normalized = line.toLocaleLowerCase();
  if (preset === "build") {
    if (normalized.includes("clean")) return { value: 22, step: "Cleaning build output" };
    if (normalized.includes("build:app")) return { value: 42, step: "Building App UI" };
    if (normalized.includes("transforming")) return { value: 58, step: "Transforming frontend modules" };
    if (normalized.includes("rendering chunks")) return { value: 72, step: "Rendering frontend chunks" };
    if (normalized.includes("built in")) return { value: 88, step: "Compiling server" };
  }
  if (preset === "test") {
    if (normalized.includes("test")) return { value: 25, step: "Running test suite" };
    if (normalized.includes("skipping invalid")) return { value: 75, step: "Validating negative test cases" };
  }
  if (preset === "typecheck") return { value: outputSeen ? 72 : 42, step: "TypeScript compiler running" };
  if (preset === "git-status") return { value: 82, step: "Git status collected" };
  return outputSeen ? undefined : { value: 35, step: "Process producing output" };
}

function requireJob(store: JobStore, id: string): JobRecord {
  const job = store.get(id);
  if (!job) throw new Error(`Unknown job id: ${id}`);
  return job;
}

function finalizeCancelled(
  store: JobStore,
  job: JobRecord,
  message: string,
  exitCode?: number | null,
): JobRecord {
  const cancelled = store.update(job.id, {
    status: "cancelled",
    currentStep: "Cancelled",
    processPid: undefined,
    workerPid: undefined,
    exitCode: exitCode ?? undefined,
    error: undefined,
    finishedAt: new Date().toISOString(),
  });
  store.appendEvent(job.id, "warning", message);
  return cancelled;
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function terminateProcess(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, "SIGTERM"); } catch { /* process already exited */ }
}

function isTerminal(status: JobRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function readConcurrency(value: string | undefined): number {
  if (!value) return 3;
  return Number(value);
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

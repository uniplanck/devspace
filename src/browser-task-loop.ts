import { spawn } from "node:child_process";
import { homedir } from "node:os";
import {
  captureBrowserScreenshot,
  clickBrowserPoint,
  inspectBrowserPage,
  listBrowserApprovals,
  pressBrowserKey,
  scrollBrowserPage,
  typeBrowserText,
  type BrowserApprovalRecord,
  type BrowserInspectionResult,
} from "./browser-computer.js";
import { assertNonCodexProvider } from "./no-codex.js";
import { resolveExecutable, shellPathInfo } from "./shell-environment.js";

export type BrowserTaskAction =
  | { kind: "click"; elementIndex: number; rationale?: string }
  | { kind: "type"; text: string; rationale?: string }
  | { kind: "key"; key: "Tab" | "Escape" | "Backspace" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter"; rationale?: string }
  | { kind: "scroll"; deltaX?: number; deltaY: number; rationale?: string }
  | { kind: "wait"; milliseconds?: number; rationale?: string }
  | { kind: "done"; summary: string }
  | { kind: "fail"; reason: string };

export interface BrowserTaskStepRecord {
  step: number;
  timestamp: string;
  url: string;
  title: string;
  screenshotPath: string;
  action: BrowserTaskAction;
  outcome: string;
}

export interface BrowserTaskLoopState {
  schemaVersion: 1;
  steps: BrowserTaskStepRecord[];
  pendingApprovalId?: string;
  completedSummary?: string;
}

export interface BrowserTaskLoopInput {
  goal: string;
  maxSteps?: number;
  plannerProvider?: string;
  plannerModel?: string;
  downloadGroup?: string;
}

export interface BrowserTaskPlannerInput {
  goal: string;
  step: number;
  maxSteps: number;
  inspection: BrowserInspectionResult;
  screenshotPath: string;
  history: BrowserTaskStepRecord[];
}

export type BrowserTaskPlanner = (input: BrowserTaskPlannerInput) => Promise<BrowserTaskAction>;

export interface BrowserTaskDriver {
  inspect(): Promise<BrowserInspectionResult>;
  screenshot(): Promise<{ path: string }>;
  click(x: number, y: number): Promise<
    | { status: "clicked" }
    | { status: "approval-required"; approval: BrowserApprovalRecord }
  >;
  type(text: string): Promise<{ status: "typed" }>;
  key(key: Extract<BrowserTaskAction, { kind: "key" }>["key"]): Promise<
    | { status: "pressed" }
    | { status: "approval-required"; approval: BrowserApprovalRecord }
  >;
  scroll(deltaX: number, deltaY: number): Promise<{ status: "scrolled" }>;
  approval(id: string): BrowserApprovalRecord | undefined;
  wait(milliseconds: number): Promise<void>;
}

export interface BrowserTaskLoopRuntime {
  planner: BrowserTaskPlanner;
  driver: BrowserTaskDriver;
}

export type BrowserTaskLoopResult =
  | { status: "succeeded"; state: BrowserTaskLoopState; summary: string }
  | { status: "waiting-approval"; state: BrowserTaskLoopState; approval: BrowserApprovalRecord }
  | { status: "failed"; state: BrowserTaskLoopState; error: string };

const DEFAULT_MAX_STEPS = 20;
const MAX_MAX_STEPS = 60;
const MAX_GOAL_LENGTH = 4_000;
const MAX_HISTORY_FOR_PLANNER = 12;

export async function runBrowserTaskLoop(
  input: BrowserTaskLoopInput,
  runtime: BrowserTaskLoopRuntime,
  initialState?: BrowserTaskLoopState,
  onStep?: (state: BrowserTaskLoopState, step: BrowserTaskStepRecord) => void,
): Promise<BrowserTaskLoopResult> {
  const goal = validateGoal(input.goal);
  const maxSteps = clampInteger(input.maxSteps, DEFAULT_MAX_STEPS, 1, MAX_MAX_STEPS);
  const state = normalizeState(initialState);

  if (state.pendingApprovalId) {
    const approval = runtime.driver.approval(state.pendingApprovalId);
    if (!approval) {
      return {
        status: "failed",
        state: { ...state, pendingApprovalId: undefined },
        error: `Browser approval ${state.pendingApprovalId} was not found.`,
      };
    }
    if (approval.status === "pending") {
      return { status: "waiting-approval", state, approval };
    }
    if (approval.status !== "executed") {
      return {
        status: "failed",
        state: { ...state, pendingApprovalId: undefined },
        error: `Browser approval ${approval.id} is ${approval.status}.`,
      };
    }
    state.pendingApprovalId = undefined;
  }

  while (state.steps.length < maxSteps) {
    const inspection = await runtime.driver.inspect();
    const screenshot = await runtime.driver.screenshot();
    const stepNumber = state.steps.length + 1;
    const action = parseBrowserTaskAction(await runtime.planner({
      goal,
      step: stepNumber,
      maxSteps,
      inspection,
      screenshotPath: screenshot.path,
      history: state.steps.slice(-MAX_HISTORY_FOR_PLANNER),
    }));

    if (action.kind === "done") {
      const step = recordStep(stepNumber, inspection, screenshot.path, action, "Goal completed.");
      state.steps.push(step);
      state.completedSummary = action.summary;
      onStep?.(cloneState(state), step);
      return { status: "succeeded", state, summary: action.summary };
    }
    if (action.kind === "fail") {
      const step = recordStep(stepNumber, inspection, screenshot.path, action, action.reason);
      state.steps.push(step);
      onStep?.(cloneState(state), step);
      return { status: "failed", state, error: action.reason };
    }

    const executed = await executeAction(action, inspection, runtime.driver);
    const step = recordStep(stepNumber, inspection, screenshot.path, action, executed.outcome);
    state.steps.push(step);

    if (executed.approval) {
      state.pendingApprovalId = executed.approval.id;
      onStep?.(cloneState(state), step);
      return { status: "waiting-approval", state, approval: executed.approval };
    }
    onStep?.(cloneState(state), step);
  }

  return {
    status: "failed",
    state,
    error: `Browser task reached the maximum of ${maxSteps} steps without completion.`,
  };
}

export function createNativeBrowserTaskDriver(home: string = homedir()): BrowserTaskDriver {
  return {
    inspect: async () => await inspectBrowserPage(home),
    screenshot: async () => await captureBrowserScreenshot(home),
    click: async (x, y) => await clickBrowserPoint(x, y, { home }),
    type: async (text) => await typeBrowserText(text, home),
    key: async (key) => await pressBrowserKey(key, { home }),
    scroll: async (deltaX, deltaY) => await scrollBrowserPage(deltaX, deltaY, home),
    approval: (id) => listBrowserApprovals(home).find((approval) => approval.id === id),
    wait: async (milliseconds) => await sleep(milliseconds),
  };
}

export function createHermesBrowserTaskPlanner(options: {
  provider?: string;
  model?: string;
  timeoutMs?: number;
  executable?: string;
  env?: NodeJS.ProcessEnv;
} = {}): BrowserTaskPlanner {
  const env = options.env ?? process.env;
  assertNonCodexProvider(options.provider, "Hermes browser planner", env);
  return async (input) => {
    const executable = options.executable ?? resolveExecutable("hermes");
    if (!executable) throw new Error("Hermes executable was not found on the augmented PATH.");
    const prompt = buildPlannerPrompt(input);
    const args = ["chat", "-Q", "--max-turns", "1", "--source", "tool", "-q", prompt, "--image", input.screenshotPath];
    if (options.provider) args.push("--provider", options.provider);
    if (options.model) args.push("-m", options.model);
    const output = await runPlannerProcess(
      executable,
      args,
      options.timeoutMs ?? 120_000,
      env,
    );
    return parseBrowserTaskAction(extractJsonObject(output));
  };
}

export function parseBrowserTaskAction(value: unknown): BrowserTaskAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Browser planner response must be a JSON object.");
  }
  const raw = value as Record<string, unknown>;
  const kind = readString(raw.kind, "kind");
  const rationale = optionalString(raw.rationale, 500);

  switch (kind) {
    case "click":
      return { kind, elementIndex: readInteger(raw.elementIndex, "elementIndex", 0, 10_000), ...(rationale ? { rationale } : {}) };
    case "type":
      return { kind, text: readString(raw.text, "text", 4_000), ...(rationale ? { rationale } : {}) };
    case "key": {
      const key = readString(raw.key, "key") as Extract<BrowserTaskAction, { kind: "key" }>["key"];
      const allowed = new Set(["Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"]);
      if (!allowed.has(key)) throw new Error(`Unsupported browser planner key: ${key}`);
      return { kind, key, ...(rationale ? { rationale } : {}) };
    }
    case "scroll":
      return {
        kind,
        deltaX: raw.deltaX === undefined ? 0 : readNumber(raw.deltaX, "deltaX", -20_000, 20_000),
        deltaY: readNumber(raw.deltaY, "deltaY", -20_000, 20_000),
        ...(rationale ? { rationale } : {}),
      };
    case "wait":
      return {
        kind,
        milliseconds: raw.milliseconds === undefined ? 2_000 : readInteger(raw.milliseconds, "milliseconds", 100, 10_000),
        ...(rationale ? { rationale } : {}),
      };
    case "done":
      return { kind, summary: readString(raw.summary, "summary", 2_000) };
    case "fail":
      return { kind, reason: readString(raw.reason, "reason", 2_000) };
    default:
      throw new Error(`Unsupported browser planner action: ${kind}`);
  }
}

async function executeAction(
  action: Exclude<BrowserTaskAction, { kind: "done" | "fail" }>,
  inspection: BrowserInspectionResult,
  driver: BrowserTaskDriver,
): Promise<{ outcome: string; approval?: BrowserApprovalRecord }> {
  switch (action.kind) {
    case "click": {
      const element = inspection.interactive.find((candidate) => candidate.index === action.elementIndex);
      if (!element) throw new Error(`Browser planner selected unknown element index ${action.elementIndex}.`);
      const result = await driver.click(
        Math.round(element.x + element.width / 2),
        Math.round(element.y + element.height / 2),
      );
      if (result.status === "approval-required") {
        return { outcome: `Waiting for ${result.approval.category} approval ${result.approval.id}.`, approval: result.approval };
      }
      return { outcome: `Clicked element ${action.elementIndex}.` };
    }
    case "type":
      await driver.type(action.text);
      return { outcome: `Typed ${action.text.length} character(s).` };
    case "key": {
      const result = await driver.key(action.key);
      if (result.status === "approval-required") {
        return { outcome: `Waiting for ${result.approval.category} approval ${result.approval.id}.`, approval: result.approval };
      }
      return { outcome: `Pressed ${action.key}.` };
    }
    case "scroll":
      await driver.scroll(action.deltaX ?? 0, action.deltaY);
      return { outcome: `Scrolled by ${action.deltaX ?? 0}, ${action.deltaY}.` };
    case "wait": {
      const milliseconds = action.milliseconds ?? 2_000;
      await driver.wait(milliseconds);
      return { outcome: `Waited ${milliseconds}ms.` };
    }
  }
}

function buildPlannerPrompt(input: BrowserTaskPlannerInput): string {
  const elements = input.inspection.interactive.map((element) => ({
    index: element.index,
    tag: element.tag,
    type: element.type,
    role: element.role,
    text: element.text,
    ariaLabel: element.ariaLabel,
    name: element.name,
    href: element.href,
    download: element.download,
    rect: [element.x, element.y, element.width, element.height],
  }));
  const history = input.history.map((step) => ({
    step: step.step,
    action: step.action,
    outcome: step.outcome,
    url: step.url,
  }));
  return [
    "You are the bounded planner for GPT-Agent Browser Computer Use.",
    "Return exactly one JSON object and no markdown or commentary.",
    "Choose only one action from:",
    '{"kind":"click","elementIndex":0,"rationale":"..."}',
    '{"kind":"type","text":"...","rationale":"..."}',
    '{"kind":"key","key":"Tab|Escape|Backspace|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Enter","rationale":"..."}',
    '{"kind":"scroll","deltaX":0,"deltaY":600,"rationale":"..."}',
    '{"kind":"wait","milliseconds":2000,"rationale":"..."}',
    '{"kind":"done","summary":"..."}',
    '{"kind":"fail","reason":"..."}',
    "Never invent coordinates. Click only an elementIndex listed below.",
    "Never type passwords, tokens, payment details, secrets, or authentication codes.",
    "Never initiate a purchase, payment, public post, social-media publication, message send, email send, or other external communication unless that exact external action is explicitly required by the user goal.",
    "Do not type draft copy into a public-post or message composer unless the goal explicitly requires preparing that communication.",
    "Submit, login, upload, download, purchase, delete, and external communication actions are safety-sensitive and may pause for local human approval. Never try to bypass or work around that pause.",
    "Use done only when the visible page proves the goal is complete.",
    `Goal: ${input.goal}`,
    `Step: ${input.step}/${input.maxSteps}`,
    `Page title: ${input.inspection.title}`,
    `URL: ${input.inspection.url}`,
    `Viewport: ${JSON.stringify(input.inspection.viewport)}`,
    `Recent history: ${JSON.stringify(history)}`,
    `Visible interactive elements: ${JSON.stringify(elements)}`,
  ].join("\n");
}

async function runPlannerProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const pathInfo = shellPathInfo(env);
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      env: { ...env, PATH: pathInfo.path },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer): string => (current + chunk.toString("utf8")).slice(-262_144);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Hermes browser planner timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }
      const detail = stderr.trim().slice(-2_000);
      reject(new Error(`Hermes browser planner exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}${detail ? `: ${detail}` : ""}.`));
    });
  });
}

function extractJsonObject(output: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/giu;
  for (const match of output.matchAll(fenced)) {
    try { return JSON.parse(match[1]!.trim()); } catch { /* continue */ }
  }
  for (let start = output.indexOf("{"); start >= 0; start = output.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const character = output[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(output.slice(start, index + 1)); } catch { break; }
        }
      }
    }
  }
  throw new Error("Hermes browser planner did not return a valid JSON action.");
}

function recordStep(
  step: number,
  inspection: BrowserInspectionResult,
  screenshotPath: string,
  action: BrowserTaskAction,
  outcome: string,
): BrowserTaskStepRecord {
  return {
    step,
    timestamp: new Date().toISOString(),
    url: inspection.url,
    title: inspection.title,
    screenshotPath,
    action,
    outcome,
  };
}

function normalizeState(value?: BrowserTaskLoopState): BrowserTaskLoopState {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.steps)) {
    return { schemaVersion: 1, steps: [] };
  }
  return {
    schemaVersion: 1,
    steps: value.steps.slice(0, MAX_MAX_STEPS),
    pendingApprovalId: optionalString(value.pendingApprovalId, 120),
    completedSummary: optionalString(value.completedSummary, 2_000),
  };
}

function cloneState(state: BrowserTaskLoopState): BrowserTaskLoopState {
  return JSON.parse(JSON.stringify(state)) as BrowserTaskLoopState;
}

function validateGoal(value: string): string {
  const goal = value.normalize("NFKC").replace(/[\u0000\r\n\t]+/gu, " ").trim();
  if (!goal || goal.length > MAX_GOAL_LENGTH) {
    throw new Error(`Browser task goal must contain 1 to ${MAX_GOAL_LENGTH} characters.`);
  }
  return goal;
}

function readString(value: unknown, label: string, maxLength = 100): string {
  if (typeof value !== "string") throw new Error(`Browser planner ${label} must be a string.`);
  const normalized = value.replace(/\u0000/gu, "").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Browser planner ${label} must contain 1 to ${maxLength} characters.`);
  }
  return normalized;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\u0000/gu, "").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function readInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Browser planner ${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function readNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Browser planner ${label} must be a number from ${min} to ${max}.`);
  }
  return value;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

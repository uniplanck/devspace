import {
  activateBrowserTarget,
  closeBrowserTarget,
  focusChatGptComposer,
  inspectChatGptConversation,
  listBrowserApprovals,
  openBrowserUrlInNewTab,
  pressBrowserKey,
  startBrowserSession,
  typeBrowserText,
  waitForChatGptResponse,
  type BrowserApprovalRecord,
} from "./browser-computer.js";

export interface ChatGptTaskInput {
  prompt: string;
  url?: string;
  expectedMarker?: string;
  timeoutMs?: number;
  closeWhenDone?: boolean;
}

export interface ChatGptTaskState {
  schemaVersion: 1;
  engine: "deterministic-chatgpt-dom";
  modelCalls: 0;
  phase: "opening" | "waiting-approval" | "waiting-response" | "completed";
  targetId?: string;
  conversationUrl?: string;
  baselineAssistantCount?: number;
  pendingApprovalId?: string;
  responseText?: string;
  tabClosed?: boolean;
}

export type ChatGptTaskResult =
  | { status: "waiting-approval"; state: ChatGptTaskState; approval: BrowserApprovalRecord }
  | { status: "succeeded"; state: ChatGptTaskState; responseText: string; conversationUrl: string };

export interface ChatGptTaskRuntime {
  onPhase?: (phase: ChatGptTaskState["phase"], state: ChatGptTaskState) => void;
  shouldStop?: () => boolean;
}

const DEFAULT_URL = "https://chatgpt.com/";

export async function runChatGptTask(
  rawInput: ChatGptTaskInput,
  initialState?: Partial<ChatGptTaskState>,
  runtime: ChatGptTaskRuntime = {},
): Promise<ChatGptTaskResult> {
  const input = validateInput(rawInput);
  const state = normalizeState(initialState);
  await startBrowserSession();

  if (state.targetId) await activateBrowserTarget(state.targetId);

  if (state.pendingApprovalId) {
    const approval = listBrowserApprovals().find((candidate) => candidate.id === state.pendingApprovalId);
    if (!approval) throw new Error(`ChatGPT task approval was not found: ${state.pendingApprovalId}`);
    if (approval.status === "pending") {
      return { status: "waiting-approval", state, approval };
    }
    if (approval.status !== "executed") {
      throw new Error(`ChatGPT task approval is ${approval.status}: ${approval.id}`);
    }
    state.pendingApprovalId = undefined;
    state.phase = "waiting-response";
    runtime.onPhase?.(state.phase, cloneState(state));
  }

  if (!state.targetId) {
    state.phase = "opening";
    runtime.onPhase?.(state.phase, cloneState(state));
    const opened = await openBrowserUrlInNewTab(input.url ?? DEFAULT_URL);
    state.targetId = opened.targetId;
    state.conversationUrl = opened.url;

    const before = await waitForComposer(runtime.shouldStop);
    state.baselineAssistantCount = before.assistantCount;
    state.conversationUrl = before.url;
    await focusChatGptComposer({ requireEmpty: true });
    await typeBrowserText(input.prompt);
    const submission = await pressBrowserKey("Enter");
    state.phase = submission.status === "approval-required" ? "waiting-approval" : "waiting-response";
    if (submission.status === "approval-required") {
      state.pendingApprovalId = submission.approval.id;
      runtime.onPhase?.(state.phase, cloneState(state));
      return { status: "waiting-approval", state, approval: submission.approval };
    }
    runtime.onPhase?.(state.phase, cloneState(state));
  }

  if (state.baselineAssistantCount === undefined) {
    throw new Error("ChatGPT task state is missing baselineAssistantCount.");
  }

  const completed = await waitForChatGptResponse({
    baselineAssistantCount: state.baselineAssistantCount,
    expectedMarker: input.expectedMarker,
    timeoutMs: input.timeoutMs,
    shouldStop: runtime.shouldStop,
  });
  state.phase = "completed";
  state.responseText = completed.lastAssistantText;
  state.conversationUrl = completed.url;
  state.pendingApprovalId = undefined;

  if (input.closeWhenDone ?? true) {
    await closeBrowserTarget(completed.targetId);
    state.tabClosed = true;
  }
  runtime.onPhase?.(state.phase, cloneState(state));
  return {
    status: "succeeded",
    state,
    responseText: completed.lastAssistantText,
    conversationUrl: completed.url,
  };
}

async function waitForComposer(shouldStop?: () => boolean) {
  const deadline = Date.now() + 30_000;
  let latest = await inspectChatGptConversation();
  while (Date.now() < deadline) {
    if (shouldStop?.()) throw new Error("ChatGPT task was cancelled.");
    latest = await inspectChatGptConversation();
    if (latest.composerPresent) return latest;
    await sleep(500);
  }
  throw new Error(`ChatGPT composer did not become ready at ${latest.url}.`);
}

function validateInput(input: ChatGptTaskInput): ChatGptTaskInput {
  const prompt = input.prompt?.trim();
  if (!prompt || prompt.length > 4_000) {
    throw new Error("ChatGPT task prompt must contain 1 to 4000 characters.");
  }
  const expectedMarker = input.expectedMarker?.trim();
  if (expectedMarker && expectedMarker.length > 500) {
    throw new Error("ChatGPT task expected marker must be at most 500 characters.");
  }
  const timeoutMs = input.timeoutMs ?? 180_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 600_000) {
    throw new Error("ChatGPT task timeoutMs must be from 5000 to 600000.");
  }
  return {
    prompt,
    ...(input.url?.trim() ? { url: input.url.trim() } : {}),
    ...(expectedMarker ? { expectedMarker } : {}),
    timeoutMs,
    closeWhenDone: input.closeWhenDone ?? true,
  };
}

function normalizeState(value?: Partial<ChatGptTaskState>): ChatGptTaskState {
  return {
    schemaVersion: 1,
    engine: "deterministic-chatgpt-dom",
    modelCalls: 0,
    phase: value?.phase ?? "opening",
    ...(value?.targetId ? { targetId: value.targetId } : {}),
    ...(value?.conversationUrl ? { conversationUrl: value.conversationUrl } : {}),
    ...(typeof value?.baselineAssistantCount === "number"
      ? { baselineAssistantCount: value.baselineAssistantCount }
      : {}),
    ...(value?.pendingApprovalId ? { pendingApprovalId: value.pendingApprovalId } : {}),
    ...(value?.responseText ? { responseText: value.responseText } : {}),
    ...(value?.tabClosed ? { tabClosed: true } : {}),
  };
}

function cloneState(state: ChatGptTaskState): ChatGptTaskState {
  return JSON.parse(JSON.stringify(state)) as ChatGptTaskState;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
}

import { mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  acquirePreferredChatGptTaskTarget,
  activateBrowserTarget,
  closeBrowserTarget,
  focusChatGptComposer,
  inspectChatGptConversation,
  listBrowserApprovals,
  openBrowserUrlInNewTab,
  pressBrowserKey,
  resetPreferredChatGptTaskTarget,
  selectBestAvailableChatGptModel,
  startBrowserSession,
  typeBrowserText,
  waitForChatGptResponse,
  type BrowserApprovalRecord,
  type ChatGptModelSelectionResult,
} from "./browser-computer.js";
import {
  CHATGPT_MINIMUM_PREFERRED_MODEL,
  CHATGPT_MINIMUM_PREFERRED_URL,
  prepareChatGptNavigationUrl,
  prepareChatGptTaskUrl,
} from "./chatgpt-model.js";

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
  requestedModel?: string;
  selectedModel?: string;
  selectedModelLabel?: string;
  modelSelectionStatus?: "selected" | "url-only";
  reusedPreferredTarget?: boolean;
  tabReset?: boolean;
  tabClosed?: boolean;
}

export type ChatGptTaskResult =
  | { status: "waiting-approval"; state: ChatGptTaskState; approval: BrowserApprovalRecord }
  | { status: "succeeded"; state: ChatGptTaskState; responseText: string; conversationUrl: string };

export interface ChatGptTaskRuntime {
  onPhase?: (phase: ChatGptTaskState["phase"], state: ChatGptTaskState) => void;
  shouldStop?: () => boolean;
}

const DEFAULT_URL = CHATGPT_MINIMUM_PREFERRED_URL;

export async function runChatGptTask(
  rawInput: ChatGptTaskInput,
  initialState?: Partial<ChatGptTaskState>,
  runtime: ChatGptTaskRuntime = {},
): Promise<ChatGptTaskResult> {
  const input = validateInput(rawInput);
  const state = normalizeState(initialState);
  await startBrowserSession();

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
    const interaction = await withBrowserInputLock(async () => {
      const requestedUrl = input.url ?? DEFAULT_URL;
      const opened = await acquirePreferredChatGptTaskTarget(prepareChatGptNavigationUrl(requestedUrl));
      state.targetId = opened.targetId;
      state.conversationUrl = opened.url;
      state.reusedPreferredTarget = opened.reusedPreferredTarget;
      state.requestedModel = new URL(requestedUrl).searchParams.get("model")
        ?? CHATGPT_MINIMUM_PREFERRED_MODEL;
      await activateBrowserTarget(state.targetId);
      await waitForComposer(state.targetId, runtime.shouldStop);
      const modelSelection: ChatGptModelSelectionResult = await selectBestAvailableChatGptModel({ targetId: state.targetId })
        .catch((): ChatGptModelSelectionResult => ({
          status: "url-only" as const,
          targetId: state.targetId!,
          currentLabel: "",
          candidateCount: 0,
        }));
      state.modelSelectionStatus = modelSelection.status;
      state.selectedModel = modelSelection.selectedModel ?? state.requestedModel;
      state.selectedModelLabel = modelSelection.selectedLabel || modelSelection.currentLabel || state.selectedModel;
      const before = await waitForComposer(state.targetId, runtime.shouldStop);
      await focusChatGptComposer({ requireEmpty: true, targetId: state.targetId });
      await typeBrowserText(input.prompt, undefined, state.targetId);
      const submission = await pressBrowserKey("Enter", { targetId: state.targetId });
      const submitted = submission.status === "pressed"
        ? await waitForSubmittedMessage(state.targetId, before.userCount, runtime.shouldStop)
        : before;
      return { before, submission, submitted };
    }, runtime.shouldStop);
    state.baselineAssistantCount = interaction.before.assistantCount;
    state.conversationUrl = interaction.submitted.url;
    const submission = interaction.submission;
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
    targetId: state.targetId,
  });
  state.phase = "completed";
  state.responseText = completed.lastAssistantText;
  state.conversationUrl = completed.url;
  state.pendingApprovalId = undefined;

  if (input.closeWhenDone ?? true) {
    if (state.reusedPreferredTarget) {
      const reset = await resetPreferredChatGptTaskTarget(completed.targetId).catch(() => ({
        status: "not-preferred" as const,
      }));
      if (reset.status === "reset") {
        state.tabReset = true;
      } else {
        await closeBrowserTarget(completed.targetId);
        state.tabClosed = true;
      }
    } else {
      await closeBrowserTarget(completed.targetId);
      state.tabClosed = true;
    }
  }
  runtime.onPhase?.(state.phase, cloneState(state));
  return {
    status: "succeeded",
    state,
    responseText: completed.lastAssistantText,
    conversationUrl: completed.url,
  };
}

async function waitForSubmittedMessage(
  targetId: string,
  baselineUserCount: number,
  shouldStop?: () => boolean,
) {
  const deadline = Date.now() + 15_000;
  let latest = await inspectChatGptConversation(undefined, targetId);
  while (Date.now() < deadline) {
    if (shouldStop?.()) throw new Error("ChatGPT task was cancelled.");
    latest = await inspectChatGptConversation(undefined, targetId);
    if (latest.userCount > baselineUserCount) return latest;
    await sleep(150);
  }
  throw new Error(`ChatGPT did not acknowledge the submitted message at ${latest.url}.`);
}

async function waitForComposer(targetId: string, shouldStop?: () => boolean) {
  const deadline = Date.now() + 30_000;
  let latest = await inspectChatGptConversation(undefined, targetId);
  while (Date.now() < deadline) {
    if (shouldStop?.()) throw new Error("ChatGPT task was cancelled.");
    latest = await inspectChatGptConversation(undefined, targetId);
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
    url: prepareChatGptTaskUrl(input.url),
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
    ...(value?.requestedModel ? { requestedModel: value.requestedModel } : {}),
    ...(value?.selectedModel ? { selectedModel: value.selectedModel } : {}),
    ...(value?.selectedModelLabel ? { selectedModelLabel: value.selectedModelLabel } : {}),
    ...(value?.modelSelectionStatus ? { modelSelectionStatus: value.modelSelectionStatus } : {}),
    ...(value?.reusedPreferredTarget ? { reusedPreferredTarget: true } : {}),
    ...(value?.tabReset ? { tabReset: true } : {}),
    ...(value?.tabClosed ? { tabClosed: true } : {}),
  };
}

function cloneState(state: ChatGptTaskState): ChatGptTaskState {
  return JSON.parse(JSON.stringify(state)) as ChatGptTaskState;
}

async function withBrowserInputLock<T>(
  operation: () => Promise<T>,
  shouldStop?: () => boolean,
): Promise<T> {
  const lockPath = join(homedir(), ".devspace", "computer-browser-input.lock");
  const deadline = Date.now() + 45_000;
  while (true) {
    if (shouldStop?.()) throw new Error("ChatGPT task was cancelled.");
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs > 60_000) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the shared Browser Computer input lock.");
      }
      await sleep(100);
    }
  }
  try {
    return await operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
}

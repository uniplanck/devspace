import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  acquirePreferredChatGptTaskTarget,
  activateBrowserTarget,
  clearChatGptComposer,
  closeBrowserTarget,
  focusChatGptComposer,
  inspectChatGptConversation,
  listBrowserApprovals,
  openBrowserUrlInNewTab,
  pressBrowserKey,
  resetPreferredChatGptTaskTarget,
  selectChatGptPerformance,
  startBrowserSession,
  submitTrustedChatGptComposer,
  typeBrowserText,
  waitForChatGptResponse,
  type BrowserApprovalRecord,
  type ChatGptModelSelectionResult,
} from "./browser-computer.js";
import {
  CHATGPT_MINIMUM_PREFERRED_URL,
  parseChatGptPerformance,
  prepareChatGptNavigationUrl,
  prepareChatGptTaskUrl,
  type ChatGptPerformance,
} from "./chatgpt-model.js";
import {
  prepareJapaneseWritingPrompt,
  type JapaneseWritingKernelMode,
} from "./japanese-writing-kernel.js";
import { estimateModelApiCost, type ModelApiCostEstimate } from "./model-pricing.js";
import { estimateTokensFromChars } from "./usage-meter.js";
import {
  claimBrowserAutomationTarget,
  releaseBrowserAutomationTarget,
} from "./browser-target-lifecycle.js";
import { loadDevspaceFiles } from "./user-config.js";

export interface ChatGptTaskInput {
  prompt: string;
  url?: string;
  expectedMarker?: string;
  expectedImageCount?: number;
  timeoutMs?: number;
  closeWhenDone?: boolean;
  autoSubmit?: boolean;
  writingKernel?: JapaneseWritingKernelMode;
  performance?: ChatGptPerformance;
}

export interface ChatGptTaskState {
  schemaVersion: 1;
  engine: "deterministic-chatgpt-dom";
  modelCalls: 0;
  phase: "opening" | "waiting-approval" | "waiting-response" | "completed";
  targetId?: string;
  targetLeaseOwnerId?: string;
  conversationUrl?: string;
  baselineAssistantCount?: number;
  baselineImageCount?: number;
  pendingApprovalId?: string;
  responseText?: string;
  imageUrls?: string[];
  requestedPerformance?: ChatGptPerformance;
  requestedModel?: string;
  selectedModel?: string;
  selectedModelLabel?: string;
  modelSelectionStatus?: "selected" | "url-only" | "failed";
  modelSelectionError?: string;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  apiCostEstimate?: ModelApiCostEstimate;
  reusedPreferredTarget?: boolean;
  tabReset?: boolean;
  tabClosed?: boolean;
  writingKernelMode?: JapaneseWritingKernelMode;
  writingKernelApplied?: boolean;
  writingKernelReason?: string;
  writingKernelSource?: string;
  writingKernelCharacters?: number;
}

export type ChatGptTaskResult =
  | { status: "waiting-approval"; state: ChatGptTaskState; approval: BrowserApprovalRecord }
  | { status: "succeeded"; state: ChatGptTaskState; responseText: string; imageUrls: string[]; conversationUrl: string };

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
  const input = validateInput(applyConfiguredProjectUrl(rawInput));
  const configuredProjectApplied = !rawInput.url?.trim() && isChatGptProjectUrl(input.url);
  const state = normalizeState(initialState);
  state.targetLeaseOwnerId ??= randomUUID();
  let submittedPrompt = input.prompt;
  if (!state.targetId) {
    const preparedPrompt = prepareJapaneseWritingPrompt(input.prompt, {
      mode: input.writingKernel,
    });
    submittedPrompt = preparedPrompt.prompt;
    state.writingKernelMode = preparedPrompt.mode;
    state.writingKernelApplied = preparedPrompt.applied;
    state.writingKernelReason = preparedPrompt.reason;
    state.writingKernelSource = preparedPrompt.sourcePath;
    state.writingKernelCharacters = preparedPrompt.kernelCharacters;
  }
  await startBrowserSession({
    env: {
      ...process.env,
      DEVSPACE_BROWSER_BACKGROUND_MODE: process.platform === "darwin" ? "background-window" : "headless",
    },
    allowDownloads: false,
  });

  if (state.targetId) {
    const claim = claimBrowserAutomationTarget({
      targetId: state.targetId,
      ownerId: state.targetLeaseOwnerId,
      kind: state.reusedPreferredTarget ? "preferred" : "ephemeral",
    });
    if (claim.status === "in-use") {
      throw new Error(`ChatGPT browser target is already owned by another active task: ${state.targetId}`);
    }
  }

  if (state.pendingApprovalId) {
    const approval = listBrowserApprovals().find((candidate) => candidate.id === state.pendingApprovalId);
    if (!approval) {
      await cleanupChatGptTaskTarget(state, configuredProjectApplied).catch(() => undefined);
      throw new Error(`ChatGPT task approval was not found: ${state.pendingApprovalId}`);
    }
    if (approval.status === "pending") {
      return { status: "waiting-approval", state, approval };
    }
    if (approval.status !== "executed") {
      await cleanupChatGptTaskTarget(state, configuredProjectApplied).catch(() => undefined);
      throw new Error(`ChatGPT task approval is ${approval.status}: ${approval.id}`);
    }
    state.pendingApprovalId = undefined;
    state.phase = "waiting-response";
    runtime.onPhase?.(state.phase, cloneState(state));
  }

  if (!state.targetId) {
    state.phase = "opening";
    runtime.onPhase?.(state.phase, cloneState(state));
    let interaction;
    try {
      interaction = await withBrowserInputLock(async () => {
        const requestedUrl = input.url ?? DEFAULT_URL;
        state.requestedPerformance = input.performance;
        const opened = await acquirePreferredChatGptTaskTarget(
          prepareChatGptNavigationUrl(requestedUrl, input.performance),
          undefined,
          state.targetLeaseOwnerId,
        );
        state.targetId = opened.targetId;
        state.targetLeaseOwnerId = opened.leaseOwnerId;
        state.conversationUrl = opened.url;
        state.reusedPreferredTarget = opened.reusedPreferredTarget;
        state.requestedModel = new URL(requestedUrl).searchParams.get("model") ?? undefined;
        await activateBrowserTarget(state.targetId);
        await waitForComposer(state.targetId, runtime.shouldStop);
        let modelSelection: ChatGptModelSelectionResult;
        try {
          modelSelection = await selectChatGptPerformance({
            performance: input.performance!,
            targetId: state.targetId,
          });
        } catch (firstError) {
          const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
          if (/^CDP command timed out:/u.test(firstMessage)) {
            await activateBrowserTarget(state.targetId);
            await sleep(1_000);
            try {
              modelSelection = await selectChatGptPerformance({
                performance: input.performance!,
                targetId: state.targetId,
              });
            } catch (retryError) {
              state.modelSelectionStatus = "failed";
              state.modelSelectionError = retryError instanceof Error ? retryError.message : String(retryError);
              runtime.onPhase?.(state.phase, cloneState(state));
              throw new Error(`ChatGPT performance selection failed after retry: ${state.modelSelectionError}`);
            }
          } else {
            state.modelSelectionStatus = "failed";
            state.modelSelectionError = firstMessage;
            runtime.onPhase?.(state.phase, cloneState(state));
            throw new Error(`ChatGPT performance selection failed: ${state.modelSelectionError}`);
          }
        }
        state.modelSelectionStatus = modelSelection.status;
        state.selectedModel = modelSelection.selectedModel;
        state.selectedModelLabel = modelSelection.selectedLabel || modelSelection.currentLabel || undefined;
        state.modelSelectionError = undefined;
        // The model picker can replace the composer shortly after its label changes.
        // Wait for that rerender before typing so the draft is not lost.
        await sleep(750);
        let before = await waitForComposer(state.targetId, runtime.shouldStop);
        if (configuredProjectApplied && before.composerText.trim()) {
          await clearChatGptComposer({ targetId: state.targetId });
          await sleep(250);
          before = await waitForComposer(state.targetId, runtime.shouldStop);
          if (before.composerText.trim()) {
            throw new Error("The configured ChatGPT Project draft could not be cleared before automation.");
          }
        }
        const typeSubmittedPrompt = async (): Promise<void> => {
          await focusChatGptComposer({ requireEmpty: true, targetId: state.targetId });
          for (let offset = 0; offset < submittedPrompt.length; offset += 3_500) {
            await typeBrowserText(submittedPrompt.slice(offset, offset + 3_500), undefined, state.targetId);
          }
        };
        await typeSubmittedPrompt();
        await sleep(350);
        let drafted = await inspectChatGptConversation(undefined, state.targetId);
        if (!drafted.composerText.trim()) {
          // A late picker rerender removed our own draft. Retry once on the replacement composer.
          await sleep(650);
          await waitForComposer(state.targetId, runtime.shouldStop);
          await typeSubmittedPrompt();
          await sleep(200);
          drafted = await inspectChatGptConversation(undefined, state.targetId);
        }
        const normalizeDraft = (value: string): string => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
        if (normalizeDraft(drafted.composerText) !== normalizeDraft(submittedPrompt)) {
          throw new Error("ChatGPT composer did not retain the complete submitted prompt after model selection.");
        }
        await focusChatGptComposer({ requireEmpty: false, targetId: state.targetId });
        const submission = input.autoSubmit
          ? await submitTrustedChatGptComposer({ targetId: state.targetId })
          : await pressBrowserKey("Enter", { targetId: state.targetId });
        const submitted = submission.status === "pressed"
          ? await waitForSubmittedMessage(state.targetId, before.userCount, runtime.shouldStop)
          : before;
        return { before, submission, submitted };
      }, runtime.shouldStop);
    } catch (error) {
      await cleanupChatGptTaskTarget(state, configuredProjectApplied).catch(() => undefined);
      throw error;
    }
    state.baselineAssistantCount = interaction.before.assistantCount;
    state.baselineImageCount = interaction.before.assistantImageUrls.length;
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

  let completed: Awaited<ReturnType<typeof waitForChatGptResponse>>;
  try {
    completed = await waitForChatGptResponse({
      baselineAssistantCount: state.baselineAssistantCount,
      expectedMarker: input.expectedMarker,
      baselineImageCount: state.baselineImageCount,
      expectedImageCount: input.expectedImageCount,
      timeoutMs: input.timeoutMs,
      shouldStop: runtime.shouldStop,
      targetId: state.targetId,
    });
  } catch (error) {
    await cleanupChatGptTaskTarget(state, configuredProjectApplied).catch(() => undefined);
    throw error;
  }
  state.phase = "completed";
  state.responseText = completed.lastAssistantText;
  state.imageUrls = completed.assistantImageUrls.slice(state.baselineImageCount ?? 0);
  state.conversationUrl = completed.url;
  state.pendingApprovalId = undefined;
  state.estimatedInputTokens = estimateTokensFromChars(submittedPrompt.length);
  state.estimatedOutputTokens = estimateTokensFromChars(completed.lastAssistantText.length);
  state.apiCostEstimate = {
    ...estimateModelApiCost(
      {
        selectedModel: state.selectedModel,
        selectedModelLabel: state.selectedModelLabel,
        requestedModel: state.requestedModel,
      },
      state.estimatedInputTokens,
      state.estimatedOutputTokens,
    ),
    selectedModel: state.selectedModel,
    selectedModelLabel: state.selectedModelLabel,
  };

  await cleanupChatGptTaskTarget(
    state,
    configuredProjectApplied,
    !(input.closeWhenDone ?? true),
  );
  runtime.onPhase?.(state.phase, cloneState(state));
  return {
    status: "succeeded",
    state,
    responseText: completed.lastAssistantText,
    imageUrls: state.imageUrls,
    conversationUrl: completed.url,
  };
}

async function cleanupChatGptTaskTarget(
  state: ChatGptTaskState,
  configuredProjectApplied: boolean,
  keepOpen = false,
): Promise<void> {
  const targetId = state.targetId;
  const ownerId = state.targetLeaseOwnerId;
  if (!targetId || !ownerId) return;
  if (keepOpen) {
    releaseBrowserAutomationTarget(targetId, ownerId);
    return;
  }

  let cleaned = false;
  if (state.reusedPreferredTarget) {
    const reset = await resetPreferredChatGptTaskTarget(targetId).catch(() => ({
      status: "not-preferred" as const,
    }));
    if (reset.status === "reset") {
      state.tabReset = true;
      cleaned = true;
    } else {
      const closed = await closeBrowserTarget(targetId);
      state.tabClosed = closed.status === "closed";
      cleaned = closed.status === "closed" || closed.status === "not-found";
    }
  } else {
    if (configuredProjectApplied) {
      await clearChatGptComposer({ targetId }).catch(() => undefined);
    }
    const closed = await closeBrowserTarget(targetId);
    state.tabClosed = closed.status === "closed";
    cleaned = closed.status === "closed" || closed.status === "not-found";
  }
  if (cleaned) releaseBrowserAutomationTarget(targetId, ownerId);
}

function isTransientBrowserCdpError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^CDP command timed out:/u.test(message)
    || /Failed to connect to the browser CDP endpoint/u.test(message);
}

async function waitForSubmittedMessage(
  targetId: string,
  baselineUserCount: number,
  shouldStop?: () => boolean,
) {
  const deadline = Date.now() + 45_000;
  let latest: Awaited<ReturnType<typeof inspectChatGptConversation>> | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (shouldStop?.()) throw new Error("ChatGPT task was cancelled.");
    try {
      latest = await inspectChatGptConversation(undefined, targetId);
      if (latest.userCount > baselineUserCount) return latest;
      lastError = undefined;
    } catch (error) {
      if (!isTransientBrowserCdpError(error)) throw error;
      lastError = error;
    }
    await sleep(250);
  }
  const location = latest?.url ?? `target ${targetId}`;
  const detail = lastError instanceof Error ? ` Last CDP error: ${lastError.message}` : "";
  throw new Error(`ChatGPT did not acknowledge the submitted message at ${location}.${detail}`);
}

async function waitForComposer(targetId: string, shouldStop?: () => boolean) {
  const deadline = Date.now() + 75_000;
  let latest: Awaited<ReturnType<typeof inspectChatGptConversation>> | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (shouldStop?.()) throw new Error("ChatGPT task was cancelled.");
    try {
      latest = await inspectChatGptConversation(undefined, targetId);
      lastError = undefined;
      if (latest.errorText) {
        throw new Error(`ChatGPT reported an error before the composer became ready: ${latest.errorText}`);
      }
      if (latest.composerPresent) return latest;
    } catch (error) {
      if (!isTransientBrowserCdpError(error)) throw error;
      lastError = error;
    }
    await sleep(500);
  }
  if (latest) {
    throw new Error(`ChatGPT composer did not become ready at ${latest.url} (title: ${latest.title || "unknown"}).`);
  }
  const detail = lastError instanceof Error ? ` Last CDP error: ${lastError.message}` : "";
  throw new Error(`ChatGPT composer did not become ready for target ${targetId}.${detail}`);
}

export function applyConfiguredProjectUrl(
  input: ChatGptTaskInput,
  env: NodeJS.ProcessEnv = process.env,
): ChatGptTaskInput {
  const explicitUrl = input.url?.trim();
  if (explicitUrl) return { ...input, url: explicitUrl };

  const configuredUrl = env.DEVSPACE_CHATGPT_PROJECT_URL?.trim()
    || loadDevspaceFiles(env).config.chatgptProjectUrl?.trim();
  return configuredUrl ? { ...input, url: configuredUrl } : input;
}

function isChatGptProjectUrl(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return url.hostname === "chatgpt.com" && /^\/g\/[^/]+(?:\/project)?\/?$/u.test(url.pathname);
  } catch {
    return false;
  }
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
  const expectedImageCount = input.expectedImageCount ?? 0;
  if (!Number.isInteger(expectedImageCount) || expectedImageCount < 0 || expectedImageCount > 4) {
    throw new Error("ChatGPT task expectedImageCount must be an integer from 0 to 4.");
  }
  const timeoutMs = input.timeoutMs ?? 180_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 600_000) {
    throw new Error("ChatGPT task timeoutMs must be from 5000 to 600000.");
  }
  const writingKernel = input.writingKernel ?? "auto";
  if (!["auto", "on", "off"].includes(writingKernel)) {
    throw new Error("ChatGPT task writingKernel must be auto, on, or off.");
  }
  const performance = parseChatGptPerformance(input.performance);
  return {
    prompt,
    url: prepareChatGptTaskUrl(input.url, performance),
    ...(expectedMarker ? { expectedMarker } : {}),
    ...(expectedImageCount ? { expectedImageCount } : {}),
    timeoutMs,
    closeWhenDone: input.closeWhenDone ?? true,
    autoSubmit: input.autoSubmit ?? false,
    writingKernel,
    performance,
  };
}

function normalizeState(value?: Partial<ChatGptTaskState>): ChatGptTaskState {
  return {
    schemaVersion: 1,
    engine: "deterministic-chatgpt-dom",
    modelCalls: 0,
    phase: value?.phase ?? "opening",
    ...(value?.targetId ? { targetId: value.targetId } : {}),
    ...(value?.targetLeaseOwnerId ? { targetLeaseOwnerId: value.targetLeaseOwnerId } : {}),
    ...(value?.conversationUrl ? { conversationUrl: value.conversationUrl } : {}),
    ...(typeof value?.baselineAssistantCount === "number"
      ? { baselineAssistantCount: value.baselineAssistantCount }
      : {}),
    ...(typeof value?.baselineImageCount === "number"
      ? { baselineImageCount: value.baselineImageCount }
      : {}),
    ...(value?.pendingApprovalId ? { pendingApprovalId: value.pendingApprovalId } : {}),
    ...(value?.responseText ? { responseText: value.responseText } : {}),
    ...(Array.isArray(value?.imageUrls)
      ? { imageUrls: value.imageUrls.filter((url): url is string => typeof url === "string") }
      : {}),
    ...(value?.requestedPerformance ? { requestedPerformance: value.requestedPerformance } : {}),
    ...(value?.requestedModel ? { requestedModel: value.requestedModel } : {}),
    ...(value?.selectedModel ? { selectedModel: value.selectedModel } : {}),
    ...(value?.selectedModelLabel ? { selectedModelLabel: value.selectedModelLabel } : {}),
    ...(value?.modelSelectionStatus ? { modelSelectionStatus: value.modelSelectionStatus } : {}),
    ...(value?.modelSelectionError ? { modelSelectionError: value.modelSelectionError } : {}),
    ...(typeof value?.estimatedInputTokens === "number"
      ? { estimatedInputTokens: value.estimatedInputTokens }
      : {}),
    ...(typeof value?.estimatedOutputTokens === "number"
      ? { estimatedOutputTokens: value.estimatedOutputTokens }
      : {}),
    ...(value?.apiCostEstimate ? { apiCostEstimate: value.apiCostEstimate } : {}),
    ...(value?.reusedPreferredTarget ? { reusedPreferredTarget: true } : {}),
    ...(value?.tabReset ? { tabReset: true } : {}),
    ...(value?.tabClosed ? { tabClosed: true } : {}),
    ...(value?.writingKernelMode ? { writingKernelMode: value.writingKernelMode } : {}),
    ...(typeof value?.writingKernelApplied === "boolean"
      ? { writingKernelApplied: value.writingKernelApplied }
      : {}),
    ...(value?.writingKernelReason ? { writingKernelReason: value.writingKernelReason } : {}),
    ...(value?.writingKernelSource ? { writingKernelSource: value.writingKernelSource } : {}),
    ...(typeof value?.writingKernelCharacters === "number"
      ? { writingKernelCharacters: value.writingKernelCharacters }
      : {}),
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

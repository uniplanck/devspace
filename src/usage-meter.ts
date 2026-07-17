import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UsageContentMode } from "./config.js";

type TextContent = { type: "text"; text: string };
type ToolContent = TextContent | { type: "image"; data: string; mimeType: string };

export interface UsageBucket {
  observedTokens: number;
  savedTokens: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  estimatedJpy: number;
  estimatedUsdMax: number;
  estimatedJpyMax: number;
  calls: number;
  inputChars: number;
  outputChars: number;
  payloadChars: number;
  totalDurationMs: number;
  errorCalls: number;
  retries: number;
}

export interface ApiCostEstimate {
  model: "gpt-5.6-sol";
  inputTokens: number;
  outputTokens: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  longInputUsdPerMillion: number;
  longOutputUsdPerMillion: number;
  longContextThresholdTokens: number;
  usdJpyRate: number;
  usd: number;
  jpy: number;
  maxUsd: number;
  maxJpy: number;
  note: string;
}

export interface UsageEntry {
  ts: string;
  sessionPid: number;
  workspaceId?: string;
  workspaceRoot?: string;
  workspaceName?: string;
  tool: string;
  path?: string;
  observedChars: number;
  observedTokens: number;
  savedChars: number;
  savedTokens: number;
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
  payloadChars: number;
  durationMs: number;
  estimatedUsd: number;
  estimatedJpy: number;
  estimatedUsdMax: number;
  estimatedJpyMax: number;
  pricingModel: "gpt-5.6-sol";
  usdJpyRate: number;
  error: boolean;
  retries: number;
  sessionObservedTokens: number;
  sessionSavedTokens: number;
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionEstimatedUsd: number;
  sessionEstimatedJpy: number;
  sessionEstimatedUsdMax: number;
  sessionEstimatedJpyMax: number;
  sessionDurationMs: number;
  sessionCalls: number;
  sessionErrors: number;
  sessionRetries: number;
  byTool: Record<string, UsageBucket>;
  note: string;
}

export interface ExecutionCostSnapshot {
  observedTokens: number;
  savedTokens: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  estimatedJpy: number;
  estimatedUsdMax: number;
  estimatedJpyMax: number;
  pricingModel: "gpt-5.6-sol";
  usdJpyRate: number;
  totalDurationMs: number;
  calls: number;
  errors: number;
  retries: number;
  byTool: Record<string, UsageBucket>;
  note: string;
}

interface UsageState {
  observedTokens: number;
  savedTokens: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  estimatedJpy: number;
  estimatedUsdMax: number;
  estimatedJpyMax: number;
  totalDurationMs: number;
  calls: number;
  errors: number;
  retries: number;
  byTool: Map<string, UsageBucket>;
}

function createUsageState(): UsageState {
  return {
    observedTokens: 0,
    savedTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedUsd: 0,
    estimatedJpy: 0,
    estimatedUsdMax: 0,
    estimatedJpyMax: 0,
    totalDurationMs: 0,
    calls: 0,
    errors: 0,
    retries: 0,
    byTool: new Map<string, UsageBucket>(),
  };
}

const processUsage = createUsageState();
const chatUsage = new Map<string, UsageState>();
const usageSessionStorage = new AsyncLocalStorage<string>();
let historyWrite = Promise.resolve();

export function runWithUsageSession<T>(sessionId: string | undefined, callback: () => T): T {
  const normalized = String(sessionId || "").trim();
  return normalized ? usageSessionStorage.run(normalized, callback) : callback();
}

function chatUsageState(sessionId?: string): UsageState {
  const key = String(sessionId || "process").trim() || "process";
  const existing = chatUsage.get(key);
  if (existing) return existing;
  const created = createUsageState();
  chatUsage.set(key, created);
  return created;
}

function runtimeUsageLabel(): string {
  const explicit = String(process.env.DEVSPACE_USAGE_LABEL || "").trim();
  if (explicit) return explicit;
  const role = String(process.env.DEVSPACE_NODE_ROLE || "").toLowerCase();
  const instance = String(process.env.DEVSPACE_INSTANCE_NAME || "").toLowerCase();
  return role === "gae" || role === "ec2" || instance.includes("4ec2") ? "GAE" : "GAG";
}

function historyPath(): string {
  return process.env.DEVSPACE_USAGE_HISTORY
    ?? join(homedir(), ".local", "share", "devspace", "usage-history.jsonl");
}

function clampNumber(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.ceil(Number(value)) : 0;
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(clampNumber(chars) / 4);
}

export function textContentChars(content: ToolContent[]): number {
  return content
    .filter((item): item is TextContent => item?.type === "text" && typeof item.text === "string")
    .reduce((total, item) => total + item.text.length, 0);
}

export function estimateFileChars(path: string): number {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : 0;
  } catch {
    return 0;
  }
}

export function editInputChars(edits: Array<{ oldText?: string; newText?: string }>): number {
  return edits.reduce(
    (total, edit) =>
      total + String(edit.oldText ?? "").length + String(edit.newText ?? "").length,
    0,
  );
}

export function compactTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

export function compactDuration(durationMs: number): string {
  if (durationMs >= 60_000) return `${(durationMs / 60_000).toFixed(1)}m`;
  if (durationMs >= 1_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return `${durationMs}ms`;
}

function positiveEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function estimateGpt56ApiCost(
  inputTokens: number,
  outputTokens: number,
  options: {
    usdJpyRate?: number;
    inputUsdPerMillion?: number;
    outputUsdPerMillion?: number;
    longInputUsdPerMillion?: number;
    longOutputUsdPerMillion?: number;
    longContextThresholdTokens?: number;
  } = {},
): ApiCostEstimate {
  const normalizedInput = clampNumber(inputTokens);
  const normalizedOutput = clampNumber(outputTokens);
  const inputUsdPerMillion = options.inputUsdPerMillion
    ?? positiveEnvNumber("DEVSPACE_GPT56_INPUT_USD_PER_MTOK", 5);
  const outputUsdPerMillion = options.outputUsdPerMillion
    ?? positiveEnvNumber("DEVSPACE_GPT56_OUTPUT_USD_PER_MTOK", 30);
  const longInputUsdPerMillion = options.longInputUsdPerMillion
    ?? positiveEnvNumber("DEVSPACE_GPT56_LONG_INPUT_USD_PER_MTOK", 10);
  const longOutputUsdPerMillion = options.longOutputUsdPerMillion
    ?? positiveEnvNumber("DEVSPACE_GPT56_LONG_OUTPUT_USD_PER_MTOK", 45);
  const longContextThresholdTokens = options.longContextThresholdTokens
    ?? positiveEnvNumber("DEVSPACE_GPT56_LONG_CONTEXT_THRESHOLD_TOKENS", 272_000);
  const usdJpyRate = options.usdJpyRate
    ?? positiveEnvNumber("DEVSPACE_USD_JPY_RATE", 160);
  const usd = (normalizedInput / 1_000_000) * inputUsdPerMillion
    + (normalizedOutput / 1_000_000) * outputUsdPerMillion;
  const maxUsd = (normalizedInput / 1_000_000) * longInputUsdPerMillion
    + (normalizedOutput / 1_000_000) * longOutputUsdPerMillion;
  return {
    model: "gpt-5.6-sol",
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    inputUsdPerMillion,
    outputUsdPerMillion,
    longInputUsdPerMillion,
    longOutputUsdPerMillion,
    longContextThresholdTokens,
    usdJpyRate,
    usd,
    jpy: usd * usdJpyRate,
    maxUsd,
    maxJpy: maxUsd * usdJpyRate,
    note: "GPT-5.6 Sol API conversion range: short-context minimum to long-context maximum; not ChatGPT billing.",
  };
}

export function compactYen(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "¥0";
  if (value >= 100) return `¥${Math.round(value).toLocaleString("ja-JP")}`;
  if (value >= 1) return `¥${value.toFixed(1)}`;
  return `¥${value.toFixed(2)}`;
}

export function compactYenRange(minimum: number, maximum: number): string {
  const min = Math.min(minimum, maximum);
  const max = Math.max(minimum, maximum);
  if (Math.abs(max - min) < 0.005) return compactYen(min);
  return `${compactYen(min)}–${compactYen(max)}`;
}

function byToolSnapshot(state: UsageState): Record<string, UsageBucket> {
  return Object.fromEntries(
    Array.from(state.byTool.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tool, bucket]) => [tool, { ...bucket }]),
  );
}

function appendHistory(entry: UsageEntry): void {
  const file = historyPath();
  historyWrite = historyWrite.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  }).catch(() => {
    // Diagnostic only. Never break the actual tool result.
  });
}

export function recordObservedToolUsage(input: {
  tool?: string;
  usageSessionId?: string;
  workspaceId?: string;
  workspaceRoot?: string;
  path?: string;
  observedChars: number;
  savedChars: number;
  inputChars?: number;
  outputChars?: number;
  payloadChars?: number;
  durationMs?: number;
  error?: boolean;
  retries?: number;
}): UsageEntry {
  const tool = input.tool ?? "unknown";
  const session = chatUsageState(usageSessionStorage.getStore() ?? input.usageSessionId);
  const observedChars = clampNumber(input.observedChars);
  const savedChars = clampNumber(input.savedChars);
  const observedTokens = estimateTokensFromChars(observedChars);
  const savedTokens = estimateTokensFromChars(savedChars);
  const toolArgumentChars = clampNumber(input.inputChars);
  const toolResultChars = clampNumber(input.outputChars);
  // MCP tool results become model input on the next turn. Tool arguments were
  // generated by the model, so they belong to model output for billing purposes.
  const inputChars = toolResultChars;
  const outputChars = toolArgumentChars;
  const inputTokens = estimateTokensFromChars(inputChars);
  const outputTokens = estimateTokensFromChars(outputChars);
  const cost = estimateGpt56ApiCost(inputTokens, outputTokens);
  const payloadChars = clampNumber(input.payloadChars ?? observedChars);
  const durationMs = clampNumber(input.durationMs);
  const retries = clampNumber(input.retries);
  const error = input.error === true;
  const current = session.byTool.get(tool) ?? {
    observedTokens: 0,
    savedTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedUsd: 0,
    estimatedJpy: 0,
    estimatedUsdMax: 0,
    estimatedJpyMax: 0,
    calls: 0,
    inputChars: 0,
    outputChars: 0,
    payloadChars: 0,
    totalDurationMs: 0,
    errorCalls: 0,
    retries: 0,
  };

  current.observedTokens += observedTokens;
  current.savedTokens += savedTokens;
  current.inputTokens += inputTokens;
  current.outputTokens += outputTokens;
  current.estimatedUsd += cost.usd;
  current.estimatedJpy += cost.jpy;
  current.estimatedUsdMax += cost.maxUsd;
  current.estimatedJpyMax += cost.maxJpy;
  current.calls += 1;
  current.inputChars += inputChars;
  current.outputChars += outputChars;
  current.payloadChars += payloadChars;
  current.totalDurationMs += durationMs;
  current.errorCalls += error ? 1 : 0;
  current.retries += retries;
  session.byTool.set(tool, current);
  for (const state of [session, processUsage]) {
    state.observedTokens += observedTokens;
    state.savedTokens += savedTokens;
    state.inputTokens += inputTokens;
    state.outputTokens += outputTokens;
    state.estimatedUsd += cost.usd;
    state.estimatedJpy += cost.jpy;
    state.estimatedUsdMax += cost.maxUsd;
    state.estimatedJpyMax += cost.maxJpy;
    state.totalDurationMs += durationMs;
    state.calls += 1;
    state.errors += error ? 1 : 0;
    state.retries += retries;
  }
  if (session !== processUsage) {
    const aggregate = processUsage.byTool.get(tool) ?? {
      observedTokens: 0,
      savedTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedUsd: 0,
      estimatedJpy: 0,
      estimatedUsdMax: 0,
      estimatedJpyMax: 0,
      calls: 0,
      inputChars: 0,
      outputChars: 0,
      payloadChars: 0,
      totalDurationMs: 0,
      errorCalls: 0,
      retries: 0,
    };
    aggregate.observedTokens += observedTokens;
    aggregate.savedTokens += savedTokens;
    aggregate.inputTokens += inputTokens;
    aggregate.outputTokens += outputTokens;
    aggregate.estimatedUsd += cost.usd;
    aggregate.estimatedJpy += cost.jpy;
    aggregate.estimatedUsdMax += cost.maxUsd;
    aggregate.estimatedJpyMax += cost.maxJpy;
    aggregate.calls += 1;
    aggregate.inputChars += inputChars;
    aggregate.outputChars += outputChars;
    aggregate.payloadChars += payloadChars;
    aggregate.totalDurationMs += durationMs;
    aggregate.errorCalls += error ? 1 : 0;
    aggregate.retries += retries;
    processUsage.byTool.set(tool, aggregate);
  }

  const entry: UsageEntry = {
    ts: new Date().toISOString(),
    sessionPid: process.pid,
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    workspaceName: input.workspaceRoot
      ? String(input.workspaceRoot).split("/").filter(Boolean).at(-1)
      : undefined,
    tool,
    path: input.path,
    observedChars,
    observedTokens,
    savedChars,
    savedTokens,
    inputChars,
    outputChars,
    inputTokens,
    outputTokens,
    payloadChars,
    durationMs,
    estimatedUsd: cost.usd,
    estimatedJpy: cost.jpy,
    estimatedUsdMax: cost.maxUsd,
    estimatedJpyMax: cost.maxJpy,
    pricingModel: cost.model,
    usdJpyRate: cost.usdJpyRate,
    error,
    retries,
    sessionObservedTokens: session.observedTokens,
    sessionSavedTokens: session.savedTokens,
    sessionInputTokens: session.inputTokens,
    sessionOutputTokens: session.outputTokens,
    sessionEstimatedUsd: session.estimatedUsd,
    sessionEstimatedJpy: session.estimatedJpy,
    sessionEstimatedUsdMax: session.estimatedUsdMax,
    sessionEstimatedJpyMax: session.estimatedJpyMax,
    sessionDurationMs: session.totalDurationMs,
    sessionCalls: session.calls,
    sessionErrors: session.errors,
    sessionRetries: session.retries,
    byTool: byToolSnapshot(session),
    note: "GPT-Agent maps MCP tool results to model input and tool arguments to model output, then shows the GPT-5.6 Sol short-to-long-context API cost range. Not ChatGPT billing or actual model usage.",
  };
  appendHistory(entry);
  return entry;
}

function executionCostSnapshot(state: UsageState): ExecutionCostSnapshot {
  const cost = estimateGpt56ApiCost(state.inputTokens, state.outputTokens);
  return {
    observedTokens: state.observedTokens,
    savedTokens: state.savedTokens,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    estimatedUsd: cost.usd,
    estimatedJpy: cost.jpy,
    estimatedUsdMax: cost.maxUsd,
    estimatedJpyMax: cost.maxJpy,
    pricingModel: cost.model,
    usdJpyRate: cost.usdJpyRate,
    totalDurationMs: state.totalDurationMs,
    calls: state.calls,
    errors: state.errors,
    retries: state.retries,
    byTool: byToolSnapshot(state),
    note: "Model input/output tokens and GPT-5.6 Sol short-to-long-context API costs are estimates; duration and call/error counts are observed by GPT-Agent.",
  };
}

export function getExecutionCostSnapshot(): ExecutionCostSnapshot {
  return executionCostSnapshot(processUsage);
}

export function getCurrentChatExecutionCostSnapshot(): ExecutionCostSnapshot {
  const sessionId = usageSessionStorage.getStore();
  return executionCostSnapshot(sessionId ? chatUsageState(sessionId) : processUsage);
}

function fullUsageSummaryText(entry: UsageEntry): string {
  const byTool = Object.entries(entry.byTool)
    .map(([tool, value]) => `${tool} ${value.calls}回/${compactDuration(value.totalDurationMs)}`)
    .join(" / ");

  const label = runtimeUsageLabel();
  return [
    `${label} · GPT-5.6推定コスト:`,
    `今回: 入力約${compactTokenCount(entry.inputTokens)} / 出力約${compactTokenCount(entry.outputTokens)} token / ${compactYenRange(entry.estimatedJpy, entry.estimatedJpyMax)} / ${compactDuration(entry.durationMs)} / ${entry.error ? "error" : "ok"}`,
    `このChat累計: 入力約${compactTokenCount(entry.sessionInputTokens)} / 出力約${compactTokenCount(entry.sessionOutputTokens)} token / ${compactYenRange(entry.sessionEstimatedJpy, entry.sessionEstimatedJpyMax)} / ${compactDuration(entry.sessionDurationMs)} / ${entry.sessionCalls} calls / ${entry.sessionErrors} errors / ${entry.sessionRetries} retries`,
    `内訳: ${byTool || "なし"}`,
    `推定節約token: 約${compactTokenCount(entry.sessionSavedTokens)}`,
    `${label}返却結果をモデル入力、ツール引数をモデル出力として換算。短コンテキストは入力$5/M・出力$30/M、272K超の長コンテキストは入力$10/M・出力$45/M（USD/JPY=${entry.usdJpyRate}）。`,
    `実際の全入力tokenは${label}単独では取得できないため短〜長コンテキストの範囲表示です。ChatGPT本体の請求額ではありません。`,
  ].join("\n");
}

function compactUsageSummaryText(entry: UsageEntry): string {
  const label = runtimeUsageLabel();
  return [
    `**${label} · GPT-5.6推定**`,
    "",
    "| 指標 | 今回 | このChat累計 |",
    "|---|---:|---:|",
    `| 入力 | 約${compactTokenCount(entry.inputTokens)} tok | 約${compactTokenCount(entry.sessionInputTokens)} tok |`,
    `| 出力 | 約${compactTokenCount(entry.outputTokens)} tok | 約${compactTokenCount(entry.sessionOutputTokens)} tok |`,
    `| 推定料金 | ${compactYenRange(entry.estimatedJpy, entry.estimatedJpyMax)} | ${compactYenRange(entry.sessionEstimatedJpy, entry.sessionEstimatedJpyMax)} |`,
    `| 処理時間 | ${compactDuration(entry.durationMs)} | ${compactDuration(entry.sessionDurationMs)} |`,
    `| 呼出 | 1 | ${entry.sessionCalls} |`,
    `| エラー | ${entry.error ? 1 : 0} | ${entry.sessionErrors} |`,
  ].join("\n");
}

export function appendUsageToContent<T extends ToolContent>(
  content: T[],
  entry: UsageEntry,
  mode: UsageContentMode,
): ToolContent[] {
  if (mode === "off") return content;
  const text = mode === "full"
    ? fullUsageSummaryText(entry)
    : compactUsageSummaryText(entry);
  return [...content, { type: "text", text }];
}

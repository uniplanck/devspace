import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  compactDuration,
  compactYenRange,
  getCurrentChatExecutionCostSnapshot,
  getExecutionCostSnapshot,
} from "./usage-meter.js";

export type ChatProgressStatus = "running" | "paused" | "completed" | "failed";
export type EstimateSource = "provided" | "history" | "progress" | "blended" | "none";

export interface ChatProgressInput {
  sessionId?: string;
  conversationId?: string;
  conversationUrl?: string;
  chatLabel: string;
  workspaceId?: string;
  workspaceRoot?: string;
  overallProgress: number;
  currentProgress?: number;
  currentTask: string;
  completed?: string;
  next?: string;
  risk?: string;
  status?: ChatProgressStatus;
  estimateMinutes?: number;
}

export interface ChatProgressRecord {
  id: string;
  sessionId: string;
  conversationId?: string;
  conversationUrl?: string;
  chatLabel: string;
  workspaceId?: string;
  workspaceRoot?: string;
  workspaceName?: string;
  status: ChatProgressStatus;
  overallProgress: number;
  currentProgress: number;
  currentTask: string;
  completed: string;
  next: string;
  risk: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  elapsedSeconds: number;
  estimatedTotalSeconds?: number;
  remainingSeconds?: number;
  estimateSource: EstimateSource;
  usageScope: "conversation" | "task-fallback";
  sessionObservedTokens: number;
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionToolDurationMs: number;
  sessionCalls: number;
  sessionErrors: number;
  sessionEstimatedUsd: number;
  sessionEstimatedJpy: number;
  sessionEstimatedUsdMax?: number;
  sessionEstimatedJpyMax?: number;
  baselineInputTokens: number;
  baselineOutputTokens: number;
  baselineToolDurationMs: number;
  baselineCalls: number;
  baselineErrors: number;
  baselineEstimatedJpy: number;
  baselineEstimatedJpyMax: number;
  taskInputTokens: number;
  taskOutputTokens: number;
  taskToolDurationMs: number;
  taskCalls: number;
  taskErrors: number;
  taskEstimatedJpy: number;
  taskEstimatedJpyMax: number;
  pricingModel: "gpt-5.6-sol";
  usdJpyRate: number;
}

interface ProgressStoreFile {
  schemaVersion: 1;
  updatedAt: string;
  records: ChatProgressRecord[];
}

function progressPath(): string {
  return process.env.DEVSPACE_CHAT_PROGRESS_PATH
    ?? join(homedir(), ".local", "share", "devspace", "chat-progress.json");
}

function readStore(): ProgressStoreFile {
  try {
    const parsed = JSON.parse(readFileSync(progressPath(), "utf8")) as Partial<ProgressStoreFile>;
    if (parsed.schemaVersion === 1 && Array.isArray(parsed.records)) {
      return {
        schemaVersion: 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
        records: parsed.records.filter(isProgressRecord).slice(0, 200),
      };
    }
  } catch {
    // Missing or malformed progress state starts clean.
  }
  return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), records: [] };
}

function writeStore(store: ProgressStoreFile): void {
  const file = progressPath();
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}

function isProgressRecord(value: unknown): value is ChatProgressRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ChatProgressRecord>;
  return typeof record.id === "string"
    && typeof record.chatLabel === "string"
    && typeof record.startedAt === "string"
    && typeof record.updatedAt === "string"
    && typeof record.overallProgress === "number";
}

function normalizePercent(value: number | undefined, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(Number(value))));
}

function normalizeMinutes(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || Number(value) <= 0) return undefined;
  return Math.min(24 * 60, Math.max(1, Math.round(Number(value))));
}

function sanitizeText(value: string | undefined, limit: number, fallback = ""): string {
  const normalized = String(value ?? "").normalize("NFKC").replace(/[\r\n\t]+/gu, " ").trim();
  return (normalized || fallback).slice(0, limit);
}

function normalizeKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function recordId(input: ChatProgressInput): string {
  const conversation = sanitizeText(input.conversationId, 160);
  if (conversation) {
    return `chat_${conversation.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 120)}`;
  }
  const fallback = normalizeKey(input.chatLabel) || sanitizeText(input.sessionId, 120, "global");
  let hash = 2166136261;
  for (const character of fallback) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `chat_local_${(hash >>> 0).toString(16)}`;
}

function elapsedSeconds(startedAt: string, now: Date): number {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.round((now.getTime() - started) / 1000));
}

function nonNegativeDelta(current: number, baseline: number | undefined): number {
  const normalizedCurrent = Number.isFinite(current) ? current : 0;
  const normalizedBaseline = Number.isFinite(baseline) ? Number(baseline) : normalizedCurrent;
  return Math.max(0, normalizedCurrent - normalizedBaseline);
}

function median(values: number[]): number | undefined {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function historicalTotalSeconds(
  records: ChatProgressRecord[],
  currentId: string,
  chatLabel: string,
  workspaceRoot?: string,
): number | undefined {
  const label = normalizeKey(chatLabel);
  const completed = records.filter((record) => {
    if (record.id === currentId || record.status !== "completed") return false;
    if (normalizeKey(record.chatLabel) === label) return true;
    return Boolean(workspaceRoot && record.workspaceRoot === workspaceRoot);
  });
  return median(completed.map((record) => record.elapsedSeconds));
}

function estimateTotalSeconds(input: {
  elapsed: number;
  progress: number;
  providedMinutes?: number;
  historySeconds?: number;
  priorTotalSeconds?: number;
  priorSource?: EstimateSource;
}): { total?: number; source: EstimateSource } {
  const provided = input.providedMinutes ? input.providedMinutes * 60 : undefined;
  const progressEstimate = input.progress >= 5 && input.progress < 100
    ? Math.round((input.elapsed / input.progress) * 100)
    : undefined;

  if (progressEstimate && input.historySeconds) {
    return {
      total: Math.max(input.elapsed, Math.round(progressEstimate * 0.7 + input.historySeconds * 0.3)),
      source: "blended",
    };
  }
  if (progressEstimate) return { total: Math.max(input.elapsed, progressEstimate), source: "progress" };
  if (provided) return { total: Math.max(input.elapsed, provided), source: "provided" };
  if (input.priorTotalSeconds && input.priorTotalSeconds > 0) {
    return {
      total: Math.max(input.elapsed, input.priorTotalSeconds),
      source: input.priorSource ?? "provided",
    };
  }
  if (input.historySeconds) return { total: Math.max(input.elapsed, input.historySeconds), source: "history" };
  return { source: "none" };
}

export function updateChatProgress(input: ChatProgressInput): ChatProgressRecord {
  const now = new Date();
  const store = readStore();
  const id = recordId(input);
  const existing = store.records.find((record) => record.id === id);
  const status = input.status ?? (normalizePercent(input.overallProgress) >= 100 ? "completed" : "running");
  const overallProgress = status === "completed" ? 100 : normalizePercent(input.overallProgress);
  const currentProgress = status === "completed"
    ? 100
    : normalizePercent(input.currentProgress, overallProgress);
  const startedAt = existing?.startedAt ?? now.toISOString();
  const elapsed = elapsedSeconds(startedAt, now);
  const providedMinutes = normalizeMinutes(input.estimateMinutes);
  const historySeconds = historicalTotalSeconds(
    store.records,
    id,
    input.chatLabel,
    input.workspaceRoot,
  );
  const estimate = estimateTotalSeconds({
    elapsed,
    progress: overallProgress,
    providedMinutes,
    historySeconds,
    priorTotalSeconds: existing?.estimatedTotalSeconds,
    priorSource: existing?.estimateSource,
  });
  const conversationId = sanitizeText(input.conversationId, 160) || existing?.conversationId;
  const usageScope = conversationId ? "conversation" : "task-fallback";
  const cost = usageScope === "conversation"
    ? getCurrentChatExecutionCostSnapshot()
    : getExecutionCostSnapshot();
  const baselineInputTokens = existing?.baselineInputTokens ?? cost.inputTokens;
  const baselineOutputTokens = existing?.baselineOutputTokens ?? cost.outputTokens;
  const baselineToolDurationMs = existing?.baselineToolDurationMs ?? cost.totalDurationMs;
  const baselineCalls = existing?.baselineCalls ?? cost.calls;
  const baselineErrors = existing?.baselineErrors ?? cost.errors;
  const baselineEstimatedJpy = existing?.baselineEstimatedJpy ?? cost.estimatedJpy;
  const baselineEstimatedJpyMax = existing?.baselineEstimatedJpyMax ?? cost.estimatedJpyMax;
  const taskInputTokens = nonNegativeDelta(cost.inputTokens, baselineInputTokens);
  const taskOutputTokens = nonNegativeDelta(cost.outputTokens, baselineOutputTokens);
  const taskToolDurationMs = nonNegativeDelta(cost.totalDurationMs, baselineToolDurationMs);
  const taskCalls = nonNegativeDelta(cost.calls, baselineCalls);
  const taskErrors = nonNegativeDelta(cost.errors, baselineErrors);
  const taskEstimatedJpy = nonNegativeDelta(cost.estimatedJpy, baselineEstimatedJpy);
  const taskEstimatedJpyMax = nonNegativeDelta(cost.estimatedJpyMax, baselineEstimatedJpyMax);
  const finishedAt = status === "completed" || status === "failed"
    ? now.toISOString()
    : undefined;
  const record: ChatProgressRecord = {
    id,
    sessionId: sanitizeText(input.sessionId, 120, existing?.sessionId ?? "local"),
    conversationId,
    conversationUrl: sanitizeText(input.conversationUrl, 500) || existing?.conversationUrl,
    chatLabel: sanitizeText(input.chatLabel, 160, "GPT-Agent task"),
    workspaceId: sanitizeText(input.workspaceId, 160) || existing?.workspaceId,
    workspaceRoot: input.workspaceRoot || existing?.workspaceRoot,
    workspaceName: input.workspaceRoot ? basename(input.workspaceRoot) : existing?.workspaceName,
    status,
    overallProgress,
    currentProgress,
    currentTask: sanitizeText(input.currentTask, 240, status === "completed" ? "Completed" : "Working"),
    completed: sanitizeText(input.completed, 500),
    next: sanitizeText(input.next, 500),
    risk: sanitizeText(input.risk, 500),
    startedAt,
    updatedAt: now.toISOString(),
    finishedAt,
    elapsedSeconds: elapsed,
    estimatedTotalSeconds: status === "completed" ? elapsed : estimate.total,
    remainingSeconds: status === "completed" ? 0 : estimate.total === undefined
      ? undefined
      : Math.max(0, estimate.total - elapsed),
    estimateSource: status === "completed" ? "progress" : estimate.source,
    usageScope,
    sessionObservedTokens: usageScope === "conversation" ? cost.observedTokens : taskInputTokens + taskOutputTokens,
    sessionInputTokens: usageScope === "conversation" ? cost.inputTokens : taskInputTokens,
    sessionOutputTokens: usageScope === "conversation" ? cost.outputTokens : taskOutputTokens,
    sessionToolDurationMs: usageScope === "conversation" ? cost.totalDurationMs : taskToolDurationMs,
    sessionCalls: usageScope === "conversation" ? cost.calls : taskCalls,
    sessionErrors: usageScope === "conversation" ? cost.errors : taskErrors,
    sessionEstimatedUsd: usageScope === "conversation" ? cost.estimatedUsd : 0,
    sessionEstimatedJpy: usageScope === "conversation" ? cost.estimatedJpy : taskEstimatedJpy,
    sessionEstimatedUsdMax: usageScope === "conversation" ? cost.estimatedUsdMax : 0,
    sessionEstimatedJpyMax: usageScope === "conversation" ? cost.estimatedJpyMax : taskEstimatedJpyMax,
    baselineInputTokens,
    baselineOutputTokens,
    baselineToolDurationMs,
    baselineCalls,
    baselineErrors,
    baselineEstimatedJpy,
    baselineEstimatedJpyMax,
    taskInputTokens,
    taskOutputTokens,
    taskToolDurationMs,
    taskCalls,
    taskErrors,
    taskEstimatedJpy,
    taskEstimatedJpyMax,
    pricingModel: cost.pricingModel,
    usdJpyRate: cost.usdJpyRate,
  };

  const records = [record, ...store.records.filter((item) => item.id !== id)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 100);
  writeStore({ schemaVersion: 1, updatedAt: now.toISOString(), records });
  return record;
}

export function listChatProgress(): ChatProgressRecord[] {
  return readStore().records;
}

function runtimeProgressLabel(): string {
  const explicit = String(process.env.DEVSPACE_USAGE_LABEL || "").trim();
  if (explicit) return explicit;
  const role = String(process.env.DEVSPACE_NODE_ROLE || "").toLowerCase();
  if (role === "gae" || role === "ec2") return "GAE";
  if (role === "gag" || role === "mac") return "GAG";
  const instance = String(process.env.DEVSPACE_INSTANCE_NAME || "").toLowerCase();
  return instance.includes("4ec2") ? "GAE" : "GAG";
}

function progressStatusLabel(status: ChatProgressStatus): string {
  if (status === "completed") return "✅ 完了";
  if (status === "paused") return "⏸️ 一時停止";
  if (status === "failed") return "❌ 失敗";
  return "▶️ 実行中";
}

function progressTableCell(value: string | undefined, fallback: string): string {
  const normalized = String(value || "").trim();
  return (normalized || fallback).replace(/\|/gu, "\\|");
}

export function formatChatProgressResult(record: ChatProgressRecord): string {
  const label = runtimeProgressLabel();
  const elapsed = compactDuration(record.elapsedSeconds * 1000);
  const remaining = record.remainingSeconds === undefined
    ? "算出中"
    : compactDuration(record.remainingSeconds * 1000);
  const estimatedCost = compactYenRange(
    record.sessionEstimatedJpy,
    record.sessionEstimatedJpyMax ?? record.sessionEstimatedJpy,
  );
  const taskCost = compactYenRange(record.taskEstimatedJpy, record.taskEstimatedJpyMax);
  const sessionCost = compactYenRange(
    record.sessionEstimatedJpy,
    record.sessionEstimatedJpyMax ?? record.sessionEstimatedJpy,
  );
  const cumulativeLabel = record.usageScope === "conversation"
    ? `このChat内の${label}累計`
    : `このタスク内の${label}累計`;
  const scopeNote = record.usageScope === "conversation"
    ? ""
    : " Chat会話IDが渡されない経路では、同じchatLabelのタスク開始時点から集計します。";
  const finalExecutionInformation = record.status === "completed" || record.status === "failed"
    ? [
        "",
        `**${label} · 最終実行情報（GPT-5.6 API換算）**`,
        "",
        `| 指標 | 今回 | ${cumulativeLabel} |`,
        "|---|---:|---:|",
        `| 作業経過時間 | ${elapsed} | — |`,
        `| MCP処理時間 | ${compactDuration(record.taskToolDurationMs)} | ${compactDuration(record.sessionToolDurationMs)} |`,
        `| 入力推定 | 約${record.taskInputTokens.toLocaleString("ja-JP")} tok | 約${record.sessionInputTokens.toLocaleString("ja-JP")} tok |`,
        `| 出力推定 | 約${record.taskOutputTokens.toLocaleString("ja-JP")} tok | 約${record.sessionOutputTokens.toLocaleString("ja-JP")} tok |`,
        `| 推定費用 | ${taskCost} | ${sessionCost} |`,
        `| ツール呼出 | ${record.taskCalls} | ${record.sessionCalls} |`,
        `| エラー | ${record.taskErrors} | ${record.sessionErrors} |`,
        "",
        `※ ${label}のMCP入出力をGPT-5.6 API料金へ換算した参考値です。GAG/GAE利用自体の請求額やChatGPT本体の全token数ではありません。${scopeNote}`,
      ]
    : [];

  return [
    `**${label} · 実行状況**`,
    "",
    "| 項目 | 内容 |",
    "|---|---|",
    `| 状態 | ${progressStatusLabel(record.status)} |`,
    `| 全体進捗 | ${record.overallProgress}% |`,
    `| 現在の作業 | ${progressTableCell(record.currentTask, "—")} |`,
    `| 経過時間 | ${elapsed} |`,
    `| 残り予測 | ${remaining} |`,
    `| 完了済み | ${progressTableCell(record.completed, "—")} |`,
    `| 次の作業 | ${progressTableCell(record.next, "—")} |`,
    `| リスク | ${progressTableCell(record.risk, "なし")} |`,
    `| 推定費用 | ${estimatedCost} |`,
    "",
    "※ 推定費用はGAG/GAEのMCP入出力をGPT-5.6 API料金へ換算した参考値です。ChatGPT本体の請求額ではありません。",
    ...finalExecutionInformation,
  ].join("\n");
}

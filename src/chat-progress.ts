import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { compactDuration, compactYenRange, getExecutionCostSnapshot } from "./usage-meter.js";

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
  sessionObservedTokens: number;
  sessionEstimatedUsd: number;
  sessionEstimatedJpy: number;
  sessionEstimatedUsdMax?: number;
  sessionEstimatedJpyMax?: number;
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
  const session = sanitizeText(input.sessionId, 120);
  if (session) return `chat_${session.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 96)}`;
  const fallback = `${input.workspaceId ?? "global"}:${normalizeKey(input.chatLabel)}`;
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
  const cost = getExecutionCostSnapshot();
  const finishedAt = status === "completed" || status === "failed"
    ? now.toISOString()
    : undefined;
  const record: ChatProgressRecord = {
    id,
    sessionId: sanitizeText(input.sessionId, 120, existing?.sessionId ?? "local"),
    conversationId: sanitizeText(input.conversationId, 160) || existing?.conversationId,
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
    sessionObservedTokens: cost.observedTokens,
    sessionEstimatedUsd: cost.estimatedUsd,
    sessionEstimatedJpy: cost.estimatedJpy,
    sessionEstimatedUsdMax: cost.estimatedUsdMax,
    sessionEstimatedJpyMax: cost.estimatedJpyMax,
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

export function formatChatProgressResult(record: ChatProgressRecord): string {
  const elapsed = compactDuration(record.elapsedSeconds * 1000);
  const eta = record.remainingSeconds === undefined
    ? "ETA unknown"
    : `ETA ${compactDuration(record.remainingSeconds * 1000)}`;
  return `Progress synced: ${record.overallProgress}% · elapsed ${elapsed} · ${eta} · ${compactYenRange(record.sessionEstimatedJpy, record.sessionEstimatedJpyMax ?? record.sessionEstimatedJpy)} estimated`;
}

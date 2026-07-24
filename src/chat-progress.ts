import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  compactDuration,
  compactYenRange,
  getCurrentChatExecutionCostSnapshot,
  getExecutionCostSnapshot,
} from "./usage-meter.js";
import {
  applyEstimateCalibration,
  estimateAccuracyPercent,
  estimateCalibration,
  estimateErrorPercent,
  inferTaskCategory,
} from "./progress-estimator.js";
import {
  progressRuntimeId,
  progressRuntimeLabel,
  publishSharedProgressHistoryAsync,
  pullSharedProgressHistoryAsync,
} from "./progress-history-sync.js";

export type ChatProgressStatus = "running" | "paused" | "completed" | "failed";
export type EstimateSource = "provided" | "revised" | "history" | "progress" | "blended" | "none";
export type ProgressSyncStatus = "local" | "syncing" | "synced" | "sync-failed" | "disabled";

export interface ChatProgressInput {
  sessionId?: string;
  conversationId?: string;
  conversationUrl?: string;
  chatLabel: string;
  workspaceId?: string;
  workspaceRoot?: string;
  taskCategory?: string;
  overallProgress: number;
  programProgress?: number;
  currentProgress?: number;
  currentTask: string;
  completed?: string;
  next?: string;
  risk?: string;
  status?: ChatProgressStatus;
  estimateMinutes?: number;
  remainingEstimateMinutes?: number;
  finalResult?: string;
  changes?: string;
  verification?: string;
  remaining?: string;
  nextLikely?: string;
  qualityScore?: number;
  learningSummary?: string;
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
  taskCategory: string;
  runtimeLabel: "GAG" | "GAE";
  runtimeId: string;
  status: ChatProgressStatus;
  overallProgress: number;
  programProgress?: number;
  currentProgress: number;
  currentTask: string;
  completed: string;
  next: string;
  risk: string;
  finalResult?: string;
  changes?: string;
  verification?: string;
  remaining?: string;
  nextLikely?: string;
  qualityScore?: number;
  learningSummary?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  elapsedSeconds: number;
  initialEstimateSeconds?: number;
  estimatedTotalSeconds?: number;
  finalForecastTotalSeconds?: number;
  remainingSeconds?: number;
  estimateSource: EstimateSource;
  initialEstimateErrorPercent?: number;
  initialEstimateAccuracyPercent?: number;
  finalEstimateErrorPercent?: number;
  historyInitialAccuracyAveragePercent?: number;
  historySampleCount: number;
  historyCorrectionFactor: number;
  historyConfidence: "none" | "low" | "medium" | "high";
  syncStatus: ProgressSyncStatus;
  syncError?: string;
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

function staleProgressMilliseconds(): number {
  const minutes = Number(process.env.DEVSPACE_PROGRESS_STALE_MINUTES || 360);
  const normalized = Number.isFinite(minutes) ? Math.max(15, Math.min(7 * 24 * 60, minutes)) : 360;
  return normalized * 60_000;
}

function pauseStaleRecords(records: ChatProgressRecord[], now = Date.now()): { records: ChatProgressRecord[]; changed: boolean } {
  let changed = false;
  const staleAfter = staleProgressMilliseconds();
  const normalized = records.map((record) => {
    const updatedAt = Date.parse(record.updatedAt);
    if (record.status !== "running" || !Number.isFinite(updatedAt) || now - updatedAt < staleAfter) return record;
    changed = true;
    return {
      ...record,
      status: "paused" as const,
      risk: record.risk || "長時間更新がないため自動一時停止",
      next: record.next || "同じタスクを再開すると、この履歴から継続します。",
    };
  });
  return { records: normalized, changed };
}

function progressPath(): string {
  return process.env.DEVSPACE_CHAT_PROGRESS_PATH
    ?? join(homedir(), ".local", "share", "devspace", "chat-progress.json");
}

function readStore(): ProgressStoreFile {
  try {
    const parsed = JSON.parse(readFileSync(progressPath(), "utf8")) as Partial<ProgressStoreFile>;
    if (parsed.schemaVersion === 1 && Array.isArray(parsed.records)) {
      const store: ProgressStoreFile = {
        schemaVersion: 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
        records: parsed.records.filter(isProgressRecord).slice(0, 200),
      };
      const stale = pauseStaleRecords(store.records);
      if (!stale.changed) return store;
      const normalized = { ...store, updatedAt: new Date().toISOString(), records: stale.records };
      writeStore(normalized);
      return normalized;
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

function sanitizeMarkdown(value: string | undefined, limit: number, fallback = ""): string {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/\u0000/gu, "")
    .trim();
  return (normalized || fallback).slice(0, limit);
}

function normalizeKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function hashKey(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function recordBaseId(input: ChatProgressInput): string {
  const conversation = sanitizeText(input.conversationId, 160);
  if (conversation) return `chat_${conversation.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 120)}`;
  const fallback = normalizeKey(input.chatLabel) || sanitizeText(input.sessionId, 120, "global");
  return `chat_local_${hashKey(fallback)}`;
}

function activeProgressRecord(
  input: ChatProgressInput,
  records: ChatProgressRecord[],
): ChatProgressRecord | undefined {
  const conversationId = sanitizeText(input.conversationId, 160);
  if (conversationId) {
    const sameConversation = records
      .filter((record) => record.conversationId === conversationId)
      .filter((record) => record.status === "running" || record.status === "paused")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (sameConversation[0]) return sameConversation[0];
  }

  const sessionId = sanitizeText(input.sessionId, 120);
  if (!conversationId && sessionId) {
    const sameSession = records
      .filter((record) => record.sessionId === sessionId)
      .filter((record) => record.status === "running" || record.status === "paused")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (sameSession[0]) return sameSession[0];
  }

  const base = recordBaseId(input);
  const label = normalizeKey(input.chatLabel);
  return records
    .filter((record) => record.id === base || record.id.startsWith(`${base}_`))
    .filter((record) => normalizeKey(record.chatLabel) === label)
    .filter((record) => record.status === "running" || record.status === "paused")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function resolveProgressRecord(
  input: ChatProgressInput,
  records: ChatProgressRecord[],
): { id: string; existing?: ChatProgressRecord } {
  const active = activeProgressRecord(input, records);
  if (active) return { id: active.id, existing: active };

  const base = recordBaseId(input);
  const label = normalizeKey(input.chatLabel);
  const candidates = records
    .filter((record) => record.id === base || record.id.startsWith(`${base}_`))
    .filter((record) => normalizeKey(record.chatLabel) === label)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const suffix = Date.now().toString(36);
  return { id: candidates.length ? `${base}_${suffix}` : base };
}

export function ensureChatProgressStarted(input: ChatProgressInput): ChatProgressRecord {
  const store = readStore();
  const active = activeProgressRecord(input, store.records);
  return active ?? updateChatProgress({
    ...input,
    status: "running",
    overallProgress: normalizePercent(input.overallProgress),
    currentProgress: normalizePercent(input.currentProgress, input.overallProgress),
  });
}

function mergeProgressRecords(records: ChatProgressRecord[]): ChatProgressRecord[] {
  const byId = new Map<string, ChatProgressRecord>();
  for (const record of records) {
    if (!isProgressRecord(record)) continue;
    const existing = byId.get(record.id);
    if (!existing || record.updatedAt > existing.updatedAt) byId.set(record.id, record);
  }
  return [...byId.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 500);
}

function elapsedSeconds(startedAt: string, now: Date): number {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.round((now.getTime() - started) / 1000));
}

export function counterDeltaSinceBaseline(current: number, baseline: number | undefined): number {
  const normalizedCurrent = Number.isFinite(current) ? Math.max(0, current) : 0;
  if (!Number.isFinite(baseline)) return 0;
  const normalizedBaseline = Math.max(0, Number(baseline));
  // Tool usage counters are process-local. When GAG restarts during a task,
  // the new process starts from zero; count the new process total instead of
  // incorrectly reporting a zero delta against the old process baseline.
  return normalizedCurrent >= normalizedBaseline
    ? normalizedCurrent - normalizedBaseline
    : normalizedCurrent;
}

function estimateTotalSeconds(input: {
  elapsed: number;
  progress: number;
  initialSeconds?: number;
  revisedRemainingSeconds?: number;
  historySeconds?: number;
  priorTotalSeconds?: number;
  priorSource?: EstimateSource;
}): { total?: number; source: EstimateSource } {
  if (input.revisedRemainingSeconds !== undefined) {
    return { total: Math.max(input.elapsed, input.elapsed + input.revisedRemainingSeconds), source: "revised" };
  }
  const progressEstimate = input.progress >= 5 && input.progress < 100 && input.elapsed >= 2
    ? Math.round((input.elapsed / input.progress) * 100)
    : undefined;
  if (progressEstimate && input.historySeconds) {
    const prior = input.priorTotalSeconds ?? progressEstimate;
    return {
      total: Math.max(input.elapsed, Math.round(progressEstimate * 0.6 + input.historySeconds * 0.25 + prior * 0.15)),
      source: "blended",
    };
  }
  if (progressEstimate && input.priorTotalSeconds) {
    return {
      total: Math.max(input.elapsed, Math.round(progressEstimate * 0.7 + input.priorTotalSeconds * 0.3)),
      source: "progress",
    };
  }
  if (progressEstimate) return { total: Math.max(input.elapsed, progressEstimate), source: "progress" };
  if (input.priorTotalSeconds && input.priorTotalSeconds > 0) {
    return { total: Math.max(input.elapsed, input.priorTotalSeconds), source: input.priorSource ?? "provided" };
  }
  if (input.initialSeconds) return { total: Math.max(input.elapsed, input.initialSeconds), source: "provided" };
  if (input.historySeconds) return { total: Math.max(input.elapsed, input.historySeconds), source: "history" };
  return { source: "none" };
}

export function updateChatProgress(input: ChatProgressInput): ChatProgressRecord {
  const now = new Date();
  let store = readStore();
  let resolved = resolveProgressRecord(input, store.records);
  const startsNewRecord = !resolved.existing;
  let syncStatus: ProgressSyncStatus = resolved.existing?.syncStatus ?? (startsNewRecord ? "syncing" : "local");
  let syncError = resolved.existing?.syncError;
  const id = resolved.id;
  const existing = resolved.existing;
  const status = input.status ?? (normalizePercent(input.overallProgress) >= 100 ? "completed" : "running");
  const overallProgress = status === "completed" ? 100 : normalizePercent(input.overallProgress);
  const programProgress = Number.isFinite(input.programProgress)
    ? normalizePercent(input.programProgress)
    : existing?.programProgress;
  const currentProgress = status === "completed" ? 100 : normalizePercent(input.currentProgress, overallProgress);
  const startedAt = existing?.startedAt ?? now.toISOString();
  const elapsed = elapsedSeconds(startedAt, now);
  const taskCategory = sanitizeText(input.taskCategory, 80)
    || existing?.taskCategory
    || inferTaskCategory(input.chatLabel, input.workspaceRoot);
  const runtimeLabel = progressRuntimeLabel();
  const runtimeId = progressRuntimeId();
  const calibration = estimateCalibration(store.records, {
    taskCategory,
    workspaceRoot: input.workspaceRoot ?? existing?.workspaceRoot,
    runtimeLabel,
  });
  const providedMinutes = normalizeMinutes(input.estimateMinutes);
  const providedSeconds = providedMinutes === undefined ? undefined : providedMinutes * 60;
  const revisedMinutes = normalizeMinutes(input.remainingEstimateMinutes);
  const revisedRemainingSeconds = revisedMinutes === undefined ? undefined : revisedMinutes * 60;
  const initialEstimateSeconds = existing?.initialEstimateSeconds
    ?? applyEstimateCalibration(providedSeconds, calibration)
    ?? calibration.medianActualSeconds;
  const estimate = estimateTotalSeconds({
    elapsed,
    progress: overallProgress,
    initialSeconds: initialEstimateSeconds,
    revisedRemainingSeconds,
    historySeconds: calibration.medianActualSeconds,
    priorTotalSeconds: existing?.estimatedTotalSeconds,
    priorSource: existing?.estimateSource,
  });
  const finalForecastTotalSeconds = existing?.estimatedTotalSeconds ?? estimate.total ?? initialEstimateSeconds;
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
  const taskInputTokens = counterDeltaSinceBaseline(cost.inputTokens, baselineInputTokens);
  const taskOutputTokens = counterDeltaSinceBaseline(cost.outputTokens, baselineOutputTokens);
  const taskToolDurationMs = counterDeltaSinceBaseline(cost.totalDurationMs, baselineToolDurationMs);
  const taskCalls = counterDeltaSinceBaseline(cost.calls, baselineCalls);
  const taskErrors = counterDeltaSinceBaseline(cost.errors, baselineErrors);
  const taskEstimatedJpy = counterDeltaSinceBaseline(cost.estimatedJpy, baselineEstimatedJpy);
  const taskEstimatedJpyMax = counterDeltaSinceBaseline(cost.estimatedJpyMax, baselineEstimatedJpyMax);
  const finishedAt = status === "completed" || status === "failed" ? now.toISOString() : undefined;
  const initialEstimateErrorPercent = finishedAt
    ? estimateErrorPercent(initialEstimateSeconds, elapsed)
    : existing?.initialEstimateErrorPercent;
  const initialEstimateAccuracyPercent = finishedAt
    ? estimateAccuracyPercent(initialEstimateSeconds, elapsed)
    : existing?.initialEstimateAccuracyPercent;
  const finalEstimateErrorPercent = finishedAt
    ? estimateErrorPercent(finalForecastTotalSeconds, elapsed)
    : existing?.finalEstimateErrorPercent;
  let record: ChatProgressRecord = {
    id,
    sessionId: sanitizeText(input.sessionId, 120, existing?.sessionId ?? "local"),
    conversationId,
    conversationUrl: sanitizeText(input.conversationUrl, 500) || existing?.conversationUrl,
    chatLabel: sanitizeText(input.chatLabel, 160, "GPT-Agent task"),
    workspaceId: sanitizeText(input.workspaceId, 160) || existing?.workspaceId,
    workspaceRoot: input.workspaceRoot || existing?.workspaceRoot,
    workspaceName: input.workspaceRoot ? basename(input.workspaceRoot) : existing?.workspaceName,
    taskCategory,
    runtimeLabel,
    runtimeId,
    status,
    overallProgress,
    programProgress,
    currentProgress,
    currentTask: sanitizeText(input.currentTask, 240, status === "completed" ? "Completed" : "Working"),
    completed: sanitizeText(input.completed, 500),
    next: sanitizeText(input.next, 500),
    risk: sanitizeText(input.risk, 500),
    finalResult: sanitizeMarkdown(input.finalResult, 4_000) || existing?.finalResult,
    changes: sanitizeMarkdown(input.changes, 4_000) || existing?.changes,
    verification: sanitizeMarkdown(input.verification, 4_000) || existing?.verification,
    remaining: sanitizeMarkdown(input.remaining, 4_000) || existing?.remaining,
    nextLikely: sanitizeMarkdown(input.nextLikely, 2_000) || existing?.nextLikely,
    qualityScore: Number.isFinite(input.qualityScore)
      ? normalizePercent(input.qualityScore)
      : existing?.qualityScore,
    learningSummary: sanitizeMarkdown(input.learningSummary, 1_000) || existing?.learningSummary,
    startedAt,
    updatedAt: now.toISOString(),
    finishedAt,
    elapsedSeconds: elapsed,
    initialEstimateSeconds,
    estimatedTotalSeconds: status === "completed" ? elapsed : estimate.total,
    finalForecastTotalSeconds: finishedAt ? finalForecastTotalSeconds : existing?.finalForecastTotalSeconds,
    remainingSeconds: status === "completed" ? 0 : estimate.total === undefined
      ? undefined
      : Math.max(0, estimate.total - elapsed),
    estimateSource: status === "completed" ? (existing?.estimateSource ?? estimate.source) : estimate.source,
    initialEstimateErrorPercent,
    initialEstimateAccuracyPercent,
    finalEstimateErrorPercent,
    historyInitialAccuracyAveragePercent: calibration.averageInitialAccuracyPercent,
    historySampleCount: calibration.sampleCount,
    historyCorrectionFactor: calibration.correctionFactor,
    historyConfidence: calibration.confidence,
    syncStatus,
    syncError,
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

  let records = mergeProgressRecords([record, ...store.records.filter((item) => item.id !== id)]);
  writeStore({ schemaVersion: 1, updatedAt: now.toISOString(), records });
  if (startsNewRecord && !finishedAt) {
    const scheduledPull = pullSharedProgressHistoryAsync((pulled) => {
      const latestStore = readStore();
      const latestCurrent = latestStore.records.find((item) => item.id === id);
      let mergedRecords = mergeProgressRecords([
        ...latestStore.records,
        ...(pulled.records as ChatProgressRecord[]),
      ]);
      if (latestCurrent && latestCurrent.status !== "completed" && latestCurrent.status !== "failed") {
        const refreshedCurrent: ChatProgressRecord = {
          ...latestCurrent,
          syncStatus: !pulled.enabled ? "disabled" : pulled.ok ? "synced" : "sync-failed",
          syncError: pulled.ok ? undefined : pulled.error,
        };
        mergedRecords = mergeProgressRecords([
          refreshedCurrent,
          ...mergedRecords.filter((item) => item.id !== id),
        ]);
      }
      writeStore({ schemaVersion: 1, updatedAt: new Date().toISOString(), records: mergedRecords });
    });
    record = {
      ...record,
      syncStatus: !scheduledPull.enabled ? "disabled" : scheduledPull.ok ? "syncing" : "sync-failed",
      syncError: scheduledPull.ok ? undefined : scheduledPull.error,
    };
    records = mergeProgressRecords([
      record,
      ...records,
      ...(scheduledPull.records as ChatProgressRecord[]),
    ]);
    writeStore({ schemaVersion: 1, updatedAt: now.toISOString(), records });
  }
  if (finishedAt) {
    const completedForRuntime = records
      .filter((item) => item.runtimeId === runtimeId && item.status === "completed")
      .slice(0, 500);
    record = {
      ...record,
      syncStatus: "syncing",
      syncError: undefined,
    };
    records = mergeProgressRecords([record, ...records.filter((item) => item.id !== id)]);
    writeStore({ schemaVersion: 1, updatedAt: now.toISOString(), records });
    const scheduled = publishSharedProgressHistoryAsync(completedForRuntime, (published) => {
      const latestStore = readStore();
      const latest = latestStore.records.find((item) => item.id === id);
      if (!latest) return;
      const syncedRecord: ChatProgressRecord = {
        ...latest,
        syncStatus: !published.enabled ? "disabled" : published.ok ? "synced" : "sync-failed",
        syncError: published.ok ? undefined : published.error,
      };
      const updatedRecords = mergeProgressRecords([
        syncedRecord,
        ...latestStore.records.filter((item) => item.id !== id),
      ]);
      writeStore({ schemaVersion: 1, updatedAt: new Date().toISOString(), records: updatedRecords });
    });
    if (!scheduled.enabled) {
      record = { ...record, syncStatus: "disabled" };
      records = mergeProgressRecords([record, ...records.filter((item) => item.id !== id)]);
      writeStore({ schemaVersion: 1, updatedAt: now.toISOString(), records });
    } else if (!scheduled.ok) {
      record = { ...record, syncStatus: "sync-failed", syncError: scheduled.error };
      records = mergeProgressRecords([record, ...records.filter((item) => item.id !== id)]);
      writeStore({ schemaVersion: 1, updatedAt: now.toISOString(), records });
    }
  }
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

function formatJst(iso: string, includeSeconds = false): string {
  const value = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" as const } : {}),
    hourCycle: "h23",
  }).format(new Date(iso));
  return `${value} JST`;
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

function formatFinalExecutionInformation(record: ChatProgressRecord, label: string): string[] {
  const elapsed = compactDuration(record.elapsedSeconds * 1000);
  const finishedAt = record.finishedAt ?? record.updatedAt;
  const initialEstimate = record.initialEstimateSeconds === undefined
    ? "—"
    : compactDuration(record.initialEstimateSeconds * 1000);
  const historicalAccuracy = record.historyInitialAccuracyAveragePercent === undefined
    ? "—"
    : `過去平均 ${formatPercent(record.historyInitialAccuracyAveragePercent)}`;
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
  return [
    `**${label} · 最終MCP観測情報（GPT-5.6 API換算）**`,
    "",
    `| 指標 | 今回 | ${cumulativeLabel} |`,
    "|---|---:|---:|",
    `| 日時 | ${formatJst(finishedAt, true)} | — |`,
    `| 開始 → 終了 | ${formatJst(record.startedAt, true)} → ${formatJst(finishedAt, true)} | — |`,
    `| 作業経過時間 | ${elapsed} | — |`,
    `| 開始時予測 | ${initialEstimate} | — |`,
    `| 予測一致率 | ${formatPercent(record.initialEstimateAccuracyPercent)} | ${historicalAccuracy} |`,
    `| MCP処理時間 | ${compactDuration(record.taskToolDurationMs)} | ${compactDuration(record.sessionToolDurationMs)} |`,
    `| MCP観測入力推定 | 約${record.taskInputTokens.toLocaleString("ja-JP")} tok | 約${record.sessionInputTokens.toLocaleString("ja-JP")} tok |`,
    `| MCP観測出力推定 | 約${record.taskOutputTokens.toLocaleString("ja-JP")} tok | 約${record.sessionOutputTokens.toLocaleString("ja-JP")} tok |`,
    `| 推定費用 | ${taskCost} | ${sessionCost} |`,
    `| ツール呼出 | ${record.taskCalls} | ${record.sessionCalls} |`,
    `| エラー | ${record.taskErrors} | ${record.sessionErrors} |`,
    `| 最終予測誤差 | ${formatPercent(record.finalEstimateErrorPercent)} | — |`,
    `| 品質スコア | ${record.qualityScore === undefined ? "—" : `${record.qualityScore}/100`} | — |`,
    `| 学習記録 | ${progressTableCell(record.learningSummary, "なし")} | — |`,
    "",
    `※ MCPツールの引数・返却結果だけをGPT-5.6 API料金へ換算した観測値です。ChatGPT/Codexの全token数ではなく、両者の利用量と直接比較できません。GAG/GAE利用自体は現在の接続経路では無料です。${scopeNote}`,
  ];
}

export function formatFinalTaskResponse(record: ChatProgressRecord): string {
  const label = runtimeProgressLabel();
  const failed = record.status === "failed";
  const finalResult = record.finalResult?.trim()
    || record.completed.trim()
    || (failed ? "タスクは失敗しました。" : "タスクは完了しました。");
  const changes = record.changes?.trim() || "なし";
  const verification = record.verification?.trim()
    || (failed ? "完了条件を満たしていません。" : "なし");
  const remaining = record.remaining?.trim()
    || (failed ? record.risk.trim() || "失敗原因の解消が必要です。" : "なし");
  const nextLikely = record.nextLikely?.trim() || "なし";

  return [
    "## 完了結果",
    "",
    finalResult,
    "",
    "## 変更",
    "",
    changes,
    "",
    "## 検証",
    "",
    verification,
    "",
    "## 残り",
    "",
    remaining,
    "",
    "## 次に起こりそうなこと",
    "",
    nextLikely,
    "",
    "## 実行情報",
    "",
    ...formatFinalExecutionInformation(record, label),
  ].join("\n");
}

export function formatChatProgressResult(record: ChatProgressRecord): string {
  if (record.status === "completed" || record.status === "failed") {
    return formatFinalTaskResponse(record);
  }

  const label = runtimeProgressLabel();
  const elapsed = compactDuration(record.elapsedSeconds * 1000);
  const remaining = record.remainingSeconds === undefined
    ? "算出中"
    : compactDuration(record.remainingSeconds * 1000);
  const estimatedCost = compactYenRange(
    record.sessionEstimatedJpy,
    record.sessionEstimatedJpyMax ?? record.sessionEstimatedJpy,
  );

  return [
    `**${label} · 実行状況**`,
    "",
    "| 項目 | 内容 |",
    "|---|---|",
    `| 日時 | ${formatJst(record.updatedAt)} |`,
    `| 状態 | ${progressStatusLabel(record.status)} |`,
    `| 今回進捗 | ${record.overallProgress}% |`,
    `| 全フェーズ完成進捗 | ${record.programProgress === undefined ? "—" : `${record.programProgress}%`} |`,
    `| 現在の作業 | ${progressTableCell(record.currentTask, "—")} |`,
    `| 経過時間 | ${elapsed} |`,
    `| 初回予測 | ${record.initialEstimateSeconds === undefined ? "算出中" : compactDuration(record.initialEstimateSeconds * 1000)} |`,
    `| 修正後予測 | 残り ${remaining} |`,
    `| 予測学習 | ${record.historySampleCount}件 / 補正×${record.historyCorrectionFactor.toFixed(2)} / 信頼度 ${record.historyConfidence} |`,
    `| 履歴同期 | ${record.syncStatus}${record.syncError ? `（${progressTableCell(record.syncError, "")}）` : ""} |`,
    `| 完了済み | ${progressTableCell(record.completed, "—")} |`,
    `| 次の作業 | ${progressTableCell(record.next, "—")} |`,
    `| リスク | ${progressTableCell(record.risk, "なし")} |`,
    `| 推定費用 | ${estimatedCost} |`,
    "",
    "※ 推定費用はGAG/GAEのMCP入出力をGPT-5.6 API料金へ換算した参考値です。ChatGPT本体の請求額ではありません。",

  ].join("\n");
}

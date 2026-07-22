import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { progressRuntimeId, progressRuntimeLabel } from "./progress-history-sync.js";

const SCHEMA_VERSION = 1 as const;
const MAX_LOOPS = 5_000;
const MAX_PENDING = 200;
const MAX_CONSUMED_PENDING_IDS = 5_000;
const MAX_RULES = 12;
const MAX_PREDICTIONS = 3;
const ANALYSIS_SAMPLE_INTERVAL = 10;
const ANALYSIS_TIME_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const SHARED_PULL_CACHE_MS = 10 * 60 * 1_000;

export type OutputReaction =
  | "approval"
  | "continuation"
  | "refinement"
  | "correction"
  | "verification"
  | "new_topic"
  | "unknown";

export type OutputLearningSource = "begin_task" | "gex";

export interface OutputPrediction {
  intent: string;
  label: string;
  confidence: number;
}

export interface PendingOutputRecord {
  id: string;
  conversationKey: string;
  taskCategory: string;
  outputSummary: string;
  sectionSignature: string;
  predictedIntents: string[];
  qualityScore: number;
  completedAt: number;
  runtimeId: string;
}

export interface OutputLearningLoop {
  id: string;
  conversationKey: string;
  taskCategory: string;
  outputId: string;
  outputSummary: string;
  sectionSignature: string;
  predictedIntents: string[];
  nextUserInputSummary: string;
  nextIntent: string;
  reaction: OutputReaction;
  reactionConfidence: number;
  matchedPredictionRank?: number;
  signals: string[];
  capturedAt: number;
  source: OutputLearningSource;
  runtimeId: string;
}

export interface OutputLearningAnalysis {
  analyzedAt: number;
  analyzedLoopCount: number;
  latestLoopCapturedAt: number;
  sampleCount: number;
  correctionRate: number;
  refinementRate: number;
  approvalRate: number;
  predictionTop1Accuracy: number;
  predictionTop3Accuracy: number;
  recurringNextIntents: Array<{ intent: string; count: number }>;
  rules: string[];
}

export interface OutputLearningDocument {
  schemaVersion: 1;
  updatedAt: number;
  pending: PendingOutputRecord[];
  consumedPendingIds: string[];
  loops: OutputLearningLoop[];
  analysis: OutputLearningAnalysis;
  sync: {
    status: "local" | "syncing" | "synced" | "sync-failed" | "disabled";
    remote: string;
    runtimeId: string;
    error?: string;
    syncedAt?: number;
  };
}

export interface BeginOutputLearningInput {
  conversationId?: string;
  conversationUrl?: string;
  sessionId?: string;
  continuityKey?: string;
  userRequest: string;
  taskCategory?: string;
  capturedAt?: number;
}

export interface BeginOutputLearningResult {
  conversationKey: string;
  pairedLoop?: OutputLearningLoop;
  predictions: OutputPrediction[];
  rules: string[];
  analysis: OutputLearningAnalysis;
  syncStatus: OutputLearningDocument["sync"]["status"];
  syncError?: string;
}

export interface FinalizeOutputLearningInput {
  conversationId?: string;
  conversationUrl?: string;
  sessionId?: string;
  continuityKey?: string;
  taskCategory?: string;
  outputSummary: string;
  sectionSignature?: string;
  predictions?: string[];
  qualityScore?: number;
  completedAt?: number;
}

export interface GexLearningLoopInput {
  conversationKey?: unknown;
  prompt?: unknown;
  assistant?: unknown;
  followup?: unknown;
  capturedAt?: unknown;
}

const EMPTY_ANALYSIS: OutputLearningAnalysis = {
  analyzedAt: 0,
  analyzedLoopCount: 0,
  latestLoopCapturedAt: 0,
  sampleCount: 0,
  correctionRate: 0,
  refinementRate: 0,
  approvalRate: 0,
  predictionTop1Accuracy: 0,
  predictionTop3Accuracy: 0,
  recurringNextIntents: [],
  rules: [],
};

let sharedCache: OutputLearningDocument[] | undefined;
let sharedCacheAt = 0;
let sharedCacheError: string | undefined;
let sharedPullPromise: Promise<{ documents: OutputLearningDocument[]; error?: string }> | undefined;

function boundedText(value: unknown, max: number): string {
  return redactSensitiveText(String(value ?? ""))
    .normalize("NFKC")
    .replace(/\u0000/gu, "")
    .replace(/\r\n?/gu, "\n")
    .trim()
    .slice(0, max);
}

function boundedLine(value: unknown, max: number): string {
  return boundedText(value, max).replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function boundedIdentifier(value: unknown, max: number): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, max);
}

function boundedTimestamp(value: unknown, fallback = Date.now()): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function boundedPercent(value: unknown, fallback = 0): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function hash(parts: unknown[]): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

function safeToken(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80) || "unknown";
}

function uniqueStrings(values: unknown[], max: number, length: number): string[] {
  return Array.from(new Set(values.map((value) => boundedLine(value, length)).filter(Boolean))).slice(0, max);
}

function uniqueIdentifiers(values: unknown[], max: number, length: number): string[] {
  return Array.from(new Set(values.map((value) => boundedIdentifier(value, length)).filter(Boolean))).slice(-max);
}

function roundRate(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000) / 1_000;
}

function lexicalTokens(value: string): Set<string> {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
  const words = normalized.split(/\s+/u).filter((token) => token.length >= 2);
  const japanese = Array.from(normalized.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, ""));
  return new Set([...words, ...japanese]);
}

function lexicalSimilarity(left: string, right: string): number {
  const a = lexicalTokens(left);
  const b = lexicalTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.max(1, Math.min(a.size, b.size));
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{12,}\b/gu, "[REDACTED_TOKEN]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/gu, "[REDACTED_HEX]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/gu, "[REDACTED_SECRET]")
    .replace(/\b([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/gu, "[REDACTED_EMAIL]")
    .replace(/\b(password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]");
}

export function outputConversationKey(input: {
  conversationId?: string;
  conversationUrl?: string;
  sessionId?: string;
  continuityKey?: string;
}): string {
  const continuityKey = boundedIdentifier(input.continuityKey, 240);
  if (continuityKey) return continuityKey;
  const conversationId = boundedLine(input.conversationId, 180);
  if (conversationId) return `conversation:${safeToken(conversationId)}`;
  const url = boundedLine(input.conversationUrl, 800);
  if (url) {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/c\/([^/?#]+)/u);
      if (match?.[1]) return `conversation:${safeToken(match[1])}`;
      return `url:${hash([parsed.origin, parsed.pathname])}`;
    } catch {
      // Fall through to the transport session.
    }
  }
  return `session:${safeToken(boundedLine(input.sessionId, 180) || "global")}`;
}

function normalizeExternalConversationKey(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "conversation:global";
  if (/^https:\/\//iu.test(raw)) return outputConversationKey({ conversationUrl: raw });
  const normalized = boundedIdentifier(raw, 240);
  if (/^(conversation|session|url|gex):/u.test(normalized)) return normalized;
  return `conversation:${safeToken(normalized)}`;
}

function equivalentLoop(
  loops: OutputLearningLoop[],
  candidate: Pick<OutputLearningLoop, "conversationKey" | "nextUserInputSummary" | "capturedAt">,
): OutputLearningLoop | undefined {
  return loops.find((loop) =>
    loop.conversationKey === candidate.conversationKey
    && loop.nextUserInputSummary === candidate.nextUserInputSummary
    && Math.abs(loop.capturedAt - candidate.capturedAt) <= 24 * 60 * 60 * 1_000
  );
}

export function inferNextIntent(value: string): string {
  const text = boundedLine(value, 1_600).toLowerCase();
  if (!text) return "unknown";
  if (/(違う|ちゃう|間違|変わってない|できてない|反映されてない|おかしい|incorrect|wrong|not changed|didn't work)/u.test(text)) return "correct-result";
  if (/(本番|deploy|デプロイ|push|公開|反映して|リリース)/u.test(text)) return "publish-or-deploy";
  if (/(テスト|検証|確認|終わり|完成|大丈夫|合ってる|check|verify|tested|done\?)/u.test(text)) return "verify-completion";
  if (/(改善|もっと|進化|追加|調整|整えて|短く|長く|見やすく|improve|refine|adjust)/u.test(text)) return "refine-output";
  if (/(なぜ|どういう|説明|教えて|意味|仕組み|why|how|explain)/u.test(text)) return "explain-result";
  if (/(続け|再開|よろしく|やって|実装|進め|continue|resume|implement)/u.test(text)) return "continue-execution";
  if (/(調査|リサーチ|比較|最新|research|compare|latest)/u.test(text)) return "research-more";
  if (/(ありがとう|ok|了解|終了|完了|thanks|great|good)/u.test(text)) return "accept-result";
  return "new-or-specific-request";
}

export function classifyOutputReaction(input: {
  previousOutputSummary: string;
  nextUserInput: string;
}): { reaction: OutputReaction; confidence: number; signals: string[] } {
  const previous = boundedLine(input.previousOutputSummary, 1_600);
  const next = boundedLine(input.nextUserInput, 1_600);
  const lowered = next.toLowerCase();
  const signals: string[] = [];

  const correction = /(違う|ちゃう|間違|変わってない|できてない|反映されてない|おかしい|話が違う|incorrect|wrong|not changed|didn't work|misunderstood)/u;
  const refinement = /(もっと|改善|追加|調整|整えて|やっぱ|〜にして|短く|長く|見やすく|進化|improve|refine|adjust|add )/u;
  const verification = /(終わり\??|完成\??|大丈夫\??|合ってる\??|できた\??|テスト|検証|確認して|done\??|complete\??|verify|tested)/u;
  const approval = /^(ok|okay|了解|ありがとう|ありがと|終了|完了|よし|good|great|thanks|thank you|助かった)[!！。\s]*$/u;
  const continuation = /(続け|再開|次|そのまま|よろしく|やって|進め|continue|resume|next|proceed)/u;

  if (correction.test(lowered)) {
    signals.push("explicit-correction");
    return { reaction: "correction", confidence: 0.96, signals };
  }
  if (verification.test(lowered)) {
    signals.push("completion-or-verification-question");
    return { reaction: "verification", confidence: 0.9, signals };
  }
  if (refinement.test(lowered)) {
    signals.push("constraint-or-quality-refinement");
    return { reaction: "refinement", confidence: 0.86, signals };
  }
  if (approval.test(lowered)) {
    signals.push("explicit-acceptance");
    return { reaction: "approval", confidence: 0.95, signals };
  }
  if (continuation.test(lowered)) {
    signals.push("explicit-continuation");
    return { reaction: "continuation", confidence: 0.84, signals };
  }

  const similarity = lexicalSimilarity(previous, next);
  if (similarity < 0.05 && next.length >= 12) {
    signals.push(`low-lexical-similarity:${similarity.toFixed(2)}`);
    return { reaction: "new_topic", confidence: 0.72, signals };
  }
  if (similarity >= 0.12) {
    signals.push(`related-followup:${similarity.toFixed(2)}`);
    return { reaction: "continuation", confidence: 0.64, signals };
  }
  return { reaction: "unknown", confidence: 0.35, signals: ["insufficient-evidence"] };
}

function normalizePredictionIntent(value: unknown): string {
  return safeToken(boundedLine(value, 100));
}

function predictionLabel(intent: string): string {
  const labels: Record<string, string> = {
    "correct-result": "結果の誤り・未反映を指摘する",
    "publish-or-deploy": "本番反映・公開を依頼する",
    "verify-completion": "完了・検証状況を確認する",
    "refine-output": "品質や条件を追加して改善する",
    "explain-result": "仕組みや理由の説明を求める",
    "continue-execution": "次の実行へ進める",
    "research-more": "追加調査・比較を求める",
    "accept-result": "結果を承認して終了する",
    "new-or-specific-request": "関連する具体作業を追加する",
  };
  return labels[intent] ?? intent;
}

function genericPredictions(taskCategory: string): string[] {
  const category = taskCategory.toLowerCase();
  if (/(code|implementation|web|ui|development|実装|開発|修正)/u.test(category)) {
    return ["verify-completion", "refine-output", "publish-or-deploy"];
  }
  if (/(research|analysis|調査|比較)/u.test(category)) {
    return ["explain-result", "research-more", "refine-output"];
  }
  if (/(writing|article|post|文章|記事|投稿)/u.test(category)) {
    return ["refine-output", "accept-result", "continue-execution"];
  }
  return ["continue-execution", "verify-completion", "refine-output"];
}

function matchedPredictionRank(predictions: string[], actual: string): number | undefined {
  const index = predictions.findIndex((prediction) => prediction === actual);
  return index >= 0 ? index + 1 : undefined;
}

function normalizePending(raw: unknown): PendingOutputRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const conversationKey = normalizeExternalConversationKey(source.conversationKey);
  const outputSummary = boundedText(source.outputSummary, 2_000);
  if (!conversationKey || !outputSummary) return null;
  return {
    id: boundedIdentifier(source.id, 80) || hash([conversationKey, outputSummary, source.completedAt]),
    conversationKey,
    taskCategory: boundedLine(source.taskCategory, 80) || "general",
    outputSummary,
    sectionSignature: boundedLine(source.sectionSignature, 300) || "unknown",
    predictedIntents: uniqueStrings(Array.isArray(source.predictedIntents) ? source.predictedIntents : [], MAX_PREDICTIONS, 100)
      .map(normalizePredictionIntent),
    qualityScore: boundedPercent(source.qualityScore, 0),
    completedAt: boundedTimestamp(source.completedAt),
    runtimeId: boundedLine(source.runtimeId, 120) || "unknown",
  };
}

function normalizeLoop(raw: unknown): OutputLearningLoop | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const conversationKey = normalizeExternalConversationKey(source.conversationKey);
  const outputSummary = boundedText(source.outputSummary, 2_000);
  const nextUserInputSummary = boundedText(source.nextUserInputSummary, 1_600);
  if (!conversationKey || !outputSummary || !nextUserInputSummary) return null;
  const reaction = String(source.reaction ?? "unknown") as OutputReaction;
  const normalizedReaction: OutputReaction = [
    "approval", "continuation", "refinement", "correction", "verification", "new_topic", "unknown",
  ].includes(reaction) ? reaction : "unknown";
  const predictedIntents = uniqueStrings(
    Array.isArray(source.predictedIntents) ? source.predictedIntents : [],
    MAX_PREDICTIONS,
    100,
  ).map(normalizePredictionIntent);
  const nextIntent = normalizePredictionIntent(source.nextIntent) || inferNextIntent(nextUserInputSummary);
  const rank = Number(source.matchedPredictionRank);
  return {
    id: boundedIdentifier(source.id, 80) || hash([conversationKey, outputSummary, nextUserInputSummary]),
    conversationKey,
    taskCategory: boundedLine(source.taskCategory, 80) || "general",
    outputId: boundedIdentifier(source.outputId, 80) || hash([conversationKey, outputSummary]),
    outputSummary,
    sectionSignature: boundedLine(source.sectionSignature, 300) || "unknown",
    predictedIntents,
    nextUserInputSummary,
    nextIntent,
    reaction: normalizedReaction,
    reactionConfidence: roundRate(Number(source.reactionConfidence) || 0),
    ...(Number.isInteger(rank) && rank >= 1 && rank <= MAX_PREDICTIONS ? { matchedPredictionRank: rank } : {}),
    signals: uniqueStrings(Array.isArray(source.signals) ? source.signals : [], 8, 160),
    capturedAt: boundedTimestamp(source.capturedAt),
    source: source.source === "gex" ? "gex" : "begin_task",
    runtimeId: boundedLine(source.runtimeId, 120) || "unknown",
  };
}

function normalizeAnalysis(raw: unknown): OutputLearningAnalysis {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const recurring = Array.isArray(source.recurringNextIntents)
    ? source.recurringNextIntents.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const intent = normalizePredictionIntent(record.intent);
        const count = Math.max(0, Math.floor(Number(record.count) || 0));
        return intent && count ? [{ intent, count }] : [];
      }).slice(0, 12)
    : [];
  return {
    analyzedAt: boundedTimestamp(source.analyzedAt, 0),
    analyzedLoopCount: Math.max(0, Math.floor(Number(source.analyzedLoopCount) || 0)),
    latestLoopCapturedAt: boundedTimestamp(source.latestLoopCapturedAt, 0),
    sampleCount: Math.max(0, Math.floor(Number(source.sampleCount) || 0)),
    correctionRate: roundRate(Number(source.correctionRate) || 0),
    refinementRate: roundRate(Number(source.refinementRate) || 0),
    approvalRate: roundRate(Number(source.approvalRate) || 0),
    predictionTop1Accuracy: roundRate(Number(source.predictionTop1Accuracy) || 0),
    predictionTop3Accuracy: roundRate(Number(source.predictionTop3Accuracy) || 0),
    recurringNextIntents: recurring,
    rules: uniqueStrings(Array.isArray(source.rules) ? source.rules : [], MAX_RULES, 300),
  };
}

function emptyDocument(remote = sharedRemote()): OutputLearningDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: 0,
    pending: [],
    consumedPendingIds: [],
    loops: [],
    analysis: { ...EMPTY_ANALYSIS },
    sync: {
      status: sharedSyncEnabled() ? "local" : "disabled",
      remote,
      runtimeId: progressRuntimeId(),
    },
  };
}

function normalizeDocument(raw: unknown): OutputLearningDocument {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const syncSource = source.sync && typeof source.sync === "object" && !Array.isArray(source.sync)
    ? source.sync as Record<string, unknown>
    : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: boundedTimestamp(source.updatedAt, 0),
    pending: (Array.isArray(source.pending) ? source.pending : [])
      .map(normalizePending)
      .filter((value): value is PendingOutputRecord => Boolean(value))
      .sort((a, b) => b.completedAt - a.completedAt)
      .slice(0, MAX_PENDING),
    consumedPendingIds: uniqueIdentifiers(
      Array.isArray(source.consumedPendingIds) ? source.consumedPendingIds : [],
      MAX_CONSUMED_PENDING_IDS,
      80,
    ),
    loops: (Array.isArray(source.loops) ? source.loops : [])
      .map(normalizeLoop)
      .filter((value): value is OutputLearningLoop => Boolean(value))
      .sort((a, b) => b.capturedAt - a.capturedAt)
      .slice(0, MAX_LOOPS),
    analysis: normalizeAnalysis(source.analysis),
    sync: {
      status: ["local", "syncing", "synced", "sync-failed", "disabled"].includes(String(syncSource.status))
        ? syncSource.status as OutputLearningDocument["sync"]["status"]
        : "local",
      remote: boundedLine(syncSource.remote, 500) || sharedRemote(),
      runtimeId: boundedLine(syncSource.runtimeId, 120) || progressRuntimeId(),
      ...(boundedLine(syncSource.error, 240) ? { error: boundedLine(syncSource.error, 240) } : {}),
      ...(Number(syncSource.syncedAt) > 0 ? { syncedAt: boundedTimestamp(syncSource.syncedAt) } : {}),
    },
  };
}

function mergeDocuments(documents: OutputLearningDocument[]): OutputLearningDocument {
  const local = documents[0] ?? emptyDocument();
  const pending = new Map<string, PendingOutputRecord>();
  const consumedPendingIds = new Set<string>();
  const loops = new Map<string, OutputLearningLoop>();
  for (const document of documents) {
    for (const id of document.consumedPendingIds) consumedPendingIds.add(id);
    for (const record of document.pending) {
      const existing = pending.get(record.id);
      if (!existing || record.completedAt > existing.completedAt) pending.set(record.id, record);
    }
    for (const loop of document.loops) {
      const existing = loops.get(loop.id);
      if (!existing || loop.capturedAt > existing.capturedAt) loops.set(loop.id, loop);
    }
  }
  return {
    ...local,
    updatedAt: Math.max(...documents.map((document) => document.updatedAt), 0),
    pending: [...pending.values()]
      .filter((record) => !consumedPendingIds.has(record.id))
      .sort((a, b) => b.completedAt - a.completedAt)
      .slice(0, MAX_PENDING),
    consumedPendingIds: [...consumedPendingIds].slice(-MAX_CONSUMED_PENDING_IDS),
    loops: [...loops.values()].sort((a, b) => b.capturedAt - a.capturedAt).slice(0, MAX_LOOPS),
  };
}

export function analyzeOutputLearning(loops: OutputLearningLoop[], analyzedAt = Date.now()): OutputLearningAnalysis {
  const sampleCount = loops.length;
  if (sampleCount === 0) return { ...EMPTY_ANALYSIS, analyzedAt, analyzedLoopCount: 0, latestLoopCapturedAt: 0 };
  const count = (reaction: OutputReaction) => loops.filter((loop) => loop.reaction === reaction).length;
  const predicted = loops.filter((loop) => loop.predictedIntents.length > 0);
  const top1 = predicted.filter((loop) => loop.matchedPredictionRank === 1).length;
  const top3 = predicted.filter((loop) => loop.matchedPredictionRank !== undefined).length;
  const intentCounts = new Map<string, number>();
  for (const loop of loops) intentCounts.set(loop.nextIntent, (intentCounts.get(loop.nextIntent) ?? 0) + 1);
  const recurringNextIntents = [...intentCounts.entries()]
    .map(([intent, intentCount]) => ({ intent, count: intentCount }))
    .sort((a, b) => b.count - a.count || a.intent.localeCompare(b.intent))
    .slice(0, 12);
  const rules: string[] = [];
  const correctionRate = count("correction") / sampleCount;
  const refinementRate = count("refinement") / sampleCount;
  const approvalRate = count("approval") / sampleCount;
  if (sampleCount >= 3 && correctionRate >= 0.25) {
    rules.push("完了断定を弱め、実測の検証証拠と未確認範囲を分離して示す。結果が反映されたことを画面または実行結果で確認する。");
  }
  if (sampleCount >= 3 && refinementRate >= 0.3) {
    rules.push("初回出力で制約・完成条件・見た目の比較軸を先に固定し、ユーザーが後から追加しやすい余白を減らす。");
  }
  if (sampleCount >= 3 && count("verification") / sampleCount >= 0.2) {
    rules.push("最終回答の検証欄に、何を・どの環境で・どの結果まで確認したかを具体的に記録する。");
  }
  if (predicted.length >= 3 && top1 / predicted.length < 0.35) {
    rules.push("次入力予測は一般論より同じタスク分類の直近反応を優先し、上位3候補を分散させる。");
  }
  if (approvalRate >= 0.5 && sampleCount >= 4) {
    rules.push("現在の情報密度と完了報告の粒度は維持し、不要な追加提案を増やさない。");
  }
  for (const item of recurringNextIntents.slice(0, 3)) {
    if (item.count < 3) continue;
    rules.push(`次の依頼として「${predictionLabel(item.intent)}」が多い。最終回答内で必要な前提や証拠を先回りして用意する。`);
  }
  return {
    analyzedAt,
    analyzedLoopCount: sampleCount,
    latestLoopCapturedAt: Math.max(...loops.map((loop) => loop.capturedAt), 0),
    sampleCount,
    correctionRate: roundRate(correctionRate),
    refinementRate: roundRate(refinementRate),
    approvalRate: roundRate(approvalRate),
    predictionTop1Accuracy: roundRate(predicted.length ? top1 / predicted.length : 0),
    predictionTop3Accuracy: roundRate(predicted.length ? top3 / predicted.length : 0),
    recurringNextIntents,
    rules: uniqueStrings(rules, MAX_RULES, 300),
  };
}

function analysisDue(document: OutputLearningDocument, now = Date.now()): boolean {
  const newSamples = document.loops.length - document.analysis.analyzedLoopCount;
  const latestLoopCapturedAt = Math.max(...document.loops.map((loop) => loop.capturedAt), 0);
  const hasNewLoop = newSamples > 0 || latestLoopCapturedAt > document.analysis.latestLoopCapturedAt;
  if (!hasNewLoop) return false;
  if (newSamples >= ANALYSIS_SAMPLE_INTERVAL) return true;
  return now - document.analysis.analyzedAt >= ANALYSIS_TIME_INTERVAL_MS;
}

function learnedRulesFor(document: OutputLearningDocument, taskCategory: string): string[] {
  const category = boundedLine(taskCategory, 80) || "general";
  const sameCategory = document.loops.filter((loop) => loop.taskCategory === category);
  const categoryRules = sameCategory.length >= 3
    ? analyzeOutputLearning(sameCategory, document.analysis.analyzedAt || Date.now()).rules
    : [];
  return uniqueStrings([...categoryRules, ...document.analysis.rules], MAX_RULES, 300);
}

function predictionsFor(document: OutputLearningDocument, taskCategory: string): OutputPrediction[] {
  const category = boundedLine(taskCategory, 80) || "general";
  const sameCategory = document.loops.filter((loop) => loop.taskCategory === category);
  const counts = new Map<string, number>();
  for (const loop of sameCategory) counts.set(loop.nextIntent, (counts.get(loop.nextIntent) ?? 0) + 1);
  for (const item of document.analysis.recurringNextIntents) {
    counts.set(item.intent, (counts.get(item.intent) ?? 0) + item.count * 0.25);
  }
  const generic = genericPredictions(category);
  generic.forEach((intent, index) => counts.set(intent, (counts.get(intent) ?? 0) + (3 - index) * 0.35));
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0) || 1;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_PREDICTIONS)
    .map(([intent, intentCount]) => ({
      intent,
      label: predictionLabel(intent),
      confidence: Math.round(Math.min(0.95, Math.max(0.34, intentCount / total + 0.3)) * 100) / 100,
    }));
}

function sharedSyncEnabled(): boolean {
  if (process.env.DEVSPACE_OUTPUT_LEARNING_PATH) return false;
  const explicit = process.env.DEVSPACE_OUTPUT_LEARNING_SYNC_ENABLED;
  if (explicit === undefined) return true;
  return !["0", "false", "no", "off"].includes(explicit.trim().toLowerCase());
}

function sharedRemote(): string {
  return String(process.env.DEVSPACE_OUTPUT_LEARNING_SYNC_REMOTE || "grive:AI-Agent-OS/Output-Learning")
    .trim()
    .replace(/\/+$/u, "");
}

function syncTimeoutMs(): number {
  const value = Number(process.env.DEVSPACE_OUTPUT_LEARNING_SYNC_TIMEOUT_MS || 8_000);
  return Number.isFinite(value) ? Math.max(1_000, Math.min(30_000, Math.round(value))) : 8_000;
}

function safeError(error: unknown): string {
  return boundedLine(error instanceof Error ? error.message : String(error), 240);
}

function readSnapshot(path: string): OutputLearningDocument | null {
  try {
    return normalizeDocument(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function pullSharedDocumentsAsync(force = false): Promise<{ documents: OutputLearningDocument[]; error?: string }> {
  if (!sharedSyncEnabled()) return Promise.resolve({ documents: [] });
  const now = Date.now();
  if (!force && sharedCache && now - sharedCacheAt < SHARED_PULL_CACHE_MS) {
    return Promise.resolve({ documents: sharedCache, error: sharedCacheError });
  }
  if (!force && sharedPullPromise) return sharedPullPromise;

  const directory = mkdtempSync(join(tmpdir(), "devspace-output-learning-pull-"));
  const promise = new Promise<{ documents: OutputLearningDocument[]; error?: string }>((resolvePull) => {
    execFile(
      "rclone",
      ["copy", sharedRemote(), directory, "--include", "*.json", "--max-depth", "1", "--retries", "1", "--low-level-retries", "1"],
      {
        encoding: "utf8",
        timeout: syncTimeoutMs(),
        maxBuffer: 4 * 1024 * 1024,
      },
      (error) => {
        let result: { documents: OutputLearningDocument[]; error?: string };
        if (error) {
          sharedCache ??= [];
          sharedCacheAt = now;
          sharedCacheError = safeError(error);
          result = { documents: sharedCache, error: sharedCacheError };
        } else {
          const documents = existsSync(directory)
            ? readdirSync(directory)
                .filter((name) => name.endsWith(".json"))
                .map((name) => readSnapshot(join(directory, name)))
                .filter((document): document is OutputLearningDocument => Boolean(document))
            : [];
          sharedCache = documents;
          sharedCacheAt = now;
          sharedCacheError = undefined;
          result = { documents };
        }
        rmSync(directory, { recursive: true, force: true });
        resolvePull(result);
      },
    );
  });
  sharedPullPromise = promise;
  void promise.finally(() => {
    if (sharedPullPromise === promise) sharedPullPromise = undefined;
  });
  return promise;
}

function publishSharedDocumentAsync(document: OutputLearningDocument): Promise<string | undefined> {
  if (!sharedSyncEnabled()) return Promise.resolve(undefined);
  const directory = mkdtempSync(join(tmpdir(), "devspace-output-learning-push-"));
  const runtimeId = progressRuntimeId();
  const path = join(directory, `${runtimeId}.json`);
  const snapshot: OutputLearningDocument = {
    ...document,
    pending: document.pending.filter((item) => item.runtimeId === runtimeId).slice(0, MAX_PENDING),
    consumedPendingIds: document.consumedPendingIds.slice(-MAX_CONSUMED_PENDING_IDS),
    loops: document.loops.filter((item) => item.runtimeId === runtimeId).slice(0, MAX_LOOPS),
    sync: { status: "synced", remote: sharedRemote(), runtimeId, syncedAt: Date.now() },
  };
  try {
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    return Promise.resolve(safeError(error));
  }
  return new Promise((resolvePublish) => {
    execFile(
      "rclone",
      ["copyto", path, `${sharedRemote()}/${runtimeId}.json`, "--retries", "1", "--low-level-retries", "1"],
      {
        encoding: "utf8",
        timeout: syncTimeoutMs(),
        maxBuffer: 4 * 1024 * 1024,
      },
      (error) => {
        if (!error) {
          sharedCache = undefined;
          sharedCacheAt = 0;
          sharedCacheError = undefined;
        }
        rmSync(directory, { recursive: true, force: true });
        resolvePublish(error ? safeError(error) : undefined);
      },
    );
  });
}

function defaultPath(): string {
  return join(homedir(), ".local", "share", "devspace", "output-learning.json");
}

export class OutputLearningStore {
  readonly path: string;

  constructor(path = process.env.DEVSPACE_OUTPUT_LEARNING_PATH || defaultPath()) {
    this.path = resolve(path);
  }

  read(options: { pullShared?: boolean } = {}): OutputLearningDocument {
    const local = readSnapshot(this.path) ?? emptyDocument();
    if (options.pullShared === false) return local;
    if (!sharedSyncEnabled()) {
      return {
        ...local,
        sync: { status: "disabled", remote: sharedRemote(), runtimeId: progressRuntimeId() },
      };
    }
    const merged = mergeDocuments([local, ...(sharedCache ?? [])]);
    merged.sync = sharedCacheError
      ? { status: "sync-failed", remote: sharedRemote(), runtimeId: progressRuntimeId(), error: sharedCacheError }
      : sharedCache
        ? { status: "synced", remote: sharedRemote(), runtimeId: progressRuntimeId(), syncedAt: sharedCacheAt }
        : { status: "syncing", remote: sharedRemote(), runtimeId: progressRuntimeId() };
    return merged;
  }

  private writeLocal(document: OutputLearningDocument): OutputLearningDocument {
    const normalized = normalizeDocument({ ...document, updatedAt: Date.now() });
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now().toString(36)}`;
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    return normalized;
  }

  private write(document: OutputLearningDocument, publish = true): OutputLearningDocument {
    const normalized = normalizeDocument({
      ...document,
      sync: !sharedSyncEnabled()
        ? { status: "disabled", remote: sharedRemote(), runtimeId: progressRuntimeId() }
        : publish
          ? { status: "syncing", remote: sharedRemote(), runtimeId: progressRuntimeId() }
          : document.sync,
      updatedAt: Date.now(),
    });
    const saved = this.writeLocal(normalized);
    if (!publish || !sharedSyncEnabled()) return saved;

    void publishSharedDocumentAsync(saved).then((error) => {
      const current = readSnapshot(this.path) ?? saved;
      current.sync = error
        ? { status: "sync-failed", remote: sharedRemote(), runtimeId: progressRuntimeId(), error }
        : { status: "synced", remote: sharedRemote(), runtimeId: progressRuntimeId(), syncedAt: Date.now() };
      this.writeLocal(current);
    });
    return saved;
  }

  async refreshSharedSnapshot(force = false): Promise<OutputLearningDocument> {
    if (!sharedSyncEnabled()) {
      const local = this.read({ pullShared: false });
      local.sync = { status: "disabled", remote: sharedRemote(), runtimeId: progressRuntimeId() };
      return this.writeLocal(local);
    }
    const pulled = await pullSharedDocumentsAsync(force);
    const current = this.read({ pullShared: false });
    const merged = mergeDocuments([current, ...pulled.documents]);
    merged.sync = pulled.error
      ? { status: "sync-failed", remote: sharedRemote(), runtimeId: progressRuntimeId(), error: pulled.error }
      : { status: "synced", remote: sharedRemote(), runtimeId: progressRuntimeId(), syncedAt: Date.now() };
    return this.writeLocal(merged);
  }

  begin(input: BeginOutputLearningInput): BeginOutputLearningResult {
    void this.refreshSharedSnapshot();
    const now = boundedTimestamp(input.capturedAt);
    const conversationKey = outputConversationKey(input);
    const taskCategory = boundedLine(input.taskCategory, 80) || "general";
    const userRequest = boundedText(input.userRequest, 1_600);
    let document = this.read({ pullShared: true });
    const pending = document.pending
      .filter((item) => item.conversationKey === conversationKey)
      .sort((a, b) => b.completedAt - a.completedAt)[0];
    let pairedLoop: OutputLearningLoop | undefined;
    if (pending && userRequest) {
      const reaction = classifyOutputReaction({
        previousOutputSummary: pending.outputSummary,
        nextUserInput: userRequest,
      });
      const nextIntent = inferNextIntent(userRequest);
      pairedLoop = {
        id: hash([pending.id, userRequest]),
        conversationKey,
        taskCategory: pending.taskCategory || taskCategory,
        outputId: pending.id,
        outputSummary: pending.outputSummary,
        sectionSignature: pending.sectionSignature,
        predictedIntents: pending.predictedIntents,
        nextUserInputSummary: userRequest,
        nextIntent,
        reaction: reaction.reaction,
        reactionConfidence: reaction.confidence,
        ...(matchedPredictionRank(pending.predictedIntents, nextIntent)
          ? { matchedPredictionRank: matchedPredictionRank(pending.predictedIntents, nextIntent) }
          : {}),
        signals: reaction.signals,
        capturedAt: now,
        source: "begin_task",
        runtimeId: progressRuntimeId(),
      };
      const equivalent = equivalentLoop(document.loops, pairedLoop);
      if (equivalent) {
        const mergedPredictions = equivalent.predictedIntents.length > 0
          ? equivalent.predictedIntents
          : pairedLoop.predictedIntents;
        pairedLoop = {
          ...equivalent,
          predictedIntents: mergedPredictions,
          ...(matchedPredictionRank(mergedPredictions, equivalent.nextIntent)
            ? { matchedPredictionRank: matchedPredictionRank(mergedPredictions, equivalent.nextIntent) }
            : {}),
        };
      }
      document.pending = document.pending.filter((item) => item.id !== pending.id);
      document.consumedPendingIds = uniqueIdentifiers(
        [...document.consumedPendingIds, pending.id],
        MAX_CONSUMED_PENDING_IDS,
        80,
      );
      document.loops = [pairedLoop, ...document.loops.filter((item) => item.id !== pairedLoop?.id)].slice(0, MAX_LOOPS);
    }
    if (analysisDue(document, now)) document.analysis = analyzeOutputLearning(document.loops, now);
    document = this.write(document, Boolean(pairedLoop));
    return {
      conversationKey,
      pairedLoop,
      predictions: predictionsFor(document, taskCategory),
      rules: learnedRulesFor(document, taskCategory),
      analysis: document.analysis,
      syncStatus: document.sync.status,
      syncError: document.sync.error,
    };
  }

  finalize(input: FinalizeOutputLearningInput): {
    pending: PendingOutputRecord;
    predictions: OutputPrediction[];
    analysis: OutputLearningAnalysis;
    syncStatus: OutputLearningDocument["sync"]["status"];
    syncError?: string;
  } {
    void this.refreshSharedSnapshot();
    const document = this.read({ pullShared: true });
    const conversationKey = outputConversationKey(input);
    const taskCategory = boundedLine(input.taskCategory, 80) || "general";
    const generatedPredictions = predictionsFor(document, taskCategory);
    const predictedIntents = uniqueStrings(
      input.predictions?.length ? input.predictions : generatedPredictions.map((prediction) => prediction.intent),
      MAX_PREDICTIONS,
      100,
    ).map(normalizePredictionIntent);
    const outputSummary = boundedText(input.outputSummary, 2_000);
    if (!outputSummary) throw new Error("outputSummary is required for canonical output learning.");
    const completedAt = boundedTimestamp(input.completedAt);
    const pending: PendingOutputRecord = {
      id: hash([conversationKey, outputSummary, completedAt]),
      conversationKey,
      taskCategory,
      outputSummary,
      sectionSignature: boundedLine(input.sectionSignature, 300)
        || "完了結果>変更>検証>残り>次に起こりそうなこと>実行情報",
      predictedIntents,
      qualityScore: boundedPercent(input.qualityScore, 0),
      completedAt,
      runtimeId: progressRuntimeId(),
    };
    document.pending = [
      pending,
      ...document.pending.filter((item) => item.conversationKey !== conversationKey),
    ].slice(0, MAX_PENDING);
    const saved = this.write(document, true);
    return {
      pending,
      predictions: predictedIntents.map((intent, index) => ({
        intent,
        label: predictionLabel(intent),
        confidence: generatedPredictions.find((prediction) => prediction.intent === intent)?.confidence
          ?? Math.max(0.34, 0.7 - index * 0.12),
      })),
      analysis: saved.analysis,
      syncStatus: saved.sync.status,
      syncError: saved.sync.error,
    };
  }

  ingestGexLoops(rawLoops: GexLearningLoopInput[]): { added: number; total: number; analysis: OutputLearningAnalysis } {
    void this.refreshSharedSnapshot();
    const document = this.read({ pullShared: true });
    const existing = new Map(document.loops.map((loop) => [loop.id, loop]));
    let added = 0;
    for (const raw of rawLoops) {
      const prompt = boundedText(raw.prompt, 1_600);
      const assistant = boundedText(raw.assistant, 2_000);
      const followup = boundedText(raw.followup, 1_600);
      if (!prompt || !assistant || !followup) continue;
      const conversationKey = raw.conversationKey
        ? normalizeExternalConversationKey(raw.conversationKey)
        : `gex:${hash([prompt, assistant])}`;
      const reaction = classifyOutputReaction({ previousOutputSummary: assistant, nextUserInput: followup });
      const nextIntent = inferNextIntent(followup);
      const id = hash([conversationKey, prompt, assistant, followup]);
      if (existing.has(id)) continue;
      const candidate: OutputLearningLoop = {
        id,
        conversationKey,
        taskCategory: "gex-chat",
        outputId: hash([conversationKey, assistant]),
        outputSummary: assistant,
        sectionSignature: "gex-observed",
        predictedIntents: [],
        nextUserInputSummary: followup,
        nextIntent,
        reaction: reaction.reaction,
        reactionConfidence: reaction.confidence,
        signals: reaction.signals,
        capturedAt: boundedTimestamp(raw.capturedAt),
        source: "gex",
        runtimeId: progressRuntimeId(),
      };
      const duplicate = equivalentLoop([...existing.values()], candidate);
      if (duplicate) continue;
      existing.set(id, candidate);
      added += 1;
    }
    document.loops = [...existing.values()].sort((a, b) => b.capturedAt - a.capturedAt).slice(0, MAX_LOOPS);
    if (analysisDue(document)) document.analysis = analyzeOutputLearning(document.loops);
    const saved = this.write(document, added > 0);
    return { added, total: saved.loops.length, analysis: saved.analysis };
  }

  refreshAnalysis(options: { force?: boolean } = {}): {
    changed: boolean;
    analysis: OutputLearningAnalysis;
    syncStatus: OutputLearningDocument["sync"]["status"];
    syncError?: string;
  } {
    const document = this.read({ pullShared: true });
    if (!options.force && !analysisDue(document)) {
      return {
        changed: false,
        analysis: document.analysis,
        syncStatus: document.sync.status,
        syncError: document.sync.error,
      };
    }
    document.analysis = analyzeOutputLearning(document.loops);
    const saved = this.write(document, true);
    return {
      changed: true,
      analysis: saved.analysis,
      syncStatus: saved.sync.status,
      syncError: saved.sync.error,
    };
  }

  status(): {
    protocolVersion: string;
    runtimeLabel: "GAG" | "GAE";
    runtimeId: string;
    pending: number;
    loops: number;
    analysis: OutputLearningAnalysis;
    sync: OutputLearningDocument["sync"];
    file: string;
  } {
    void this.refreshSharedSnapshot();
    const document = this.read({ pullShared: true });
    return {
      protocolVersion: "2.0.0",
      runtimeLabel: progressRuntimeLabel(),
      runtimeId: progressRuntimeId(),
      pending: document.pending.length,
      loops: document.loops.length,
      analysis: document.analysis,
      sync: document.sync,
      file: basename(this.path),
    };
  }
}

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  NaoBrainGeminiClient,
  type GeminiFallbackKeyUpdate,
  type GeminiKeySettings,
} from "./naobrain-gemini-client.js";
import { NaoBrainProjectStore, type TodayProject } from "./naobrain-project-store.js";
import { NaoBrainTagStore, type TodayTag, type TodayTagKind } from "./naobrain-tag-store.js";

const execFileAsync = promisify(execFile);
const JST_TIME_ZONE = "Asia/Tokyo";
const DEFAULT_PROMPT = `あなたはNaoBrainの行動ログ分析器です。
入力された「今日の動き」を事実と推論に分け、誇張せず、次の行動へ接続してください。
必ずJSONだけを返し、次のキーを含めてください。
summary: 事実ベースの要約（80字以内）
result: 得られた結果または進捗（120字以内）
nextAction: 次に実行する一手（完了条件を含む、120字以内）
risk: 停滞要因または空文字
priority: NOW / NEXT / LATER / HOLD / DROP のいずれか
progressDelta: -100〜100の整数。進捗への寄与度
labels: 最大5件の短い文字列配列
外部成果物（投稿、LP、提案書、案件、納品物、実績記事）を、環境構築や構想拡張より優先してください。`;
const AGGREGATE_PROMPT = `あなたはNaoBrainの行動データ分析器です。
複数の記録をProject・タグ・種類・状態・期間などの指定軸で分析してください。
事実と推論を分離し、件数が少ない場合は断定を避けてください。
必ずJSONだけを返し、次のキーを含めてください。
summary: 全体要約（240字以内）
patterns: 反復パターンの配列（最大6件）
progress: 前進した点の配列（最大6件）
risks: 停滞・偏り・未完了の配列（最大6件）
nextActions: 次に実行する具体策の配列（最大6件）
metrics: 数値や傾向を表すオブジェクト。推測値は入れない
confidence: high / medium / low のいずれか
データにない事実を作らず、実行可能な次の一手を優先してください。`;

export type TodayEntryStatus = "done" | "doing" | "blocked" | "planned" | "note";
export type TodayEntryKind = "progress" | "result" | "plan" | "journal" | "note";
export type TodayAnalysisScope = "all" | "day" | "project" | "tag" | "kind" | "status";

export interface TodayEntryInput {
  title: string;
  body: string;
  status?: TodayEntryStatus;
  kind?: TodayEntryKind;
  project?: string;
  projectId?: string;
  tags?: string[];
  source?: "web" | "gae" | "journal" | "import";
  occurredAt?: string;
  startAt?: string;
  endAt?: string;
  startApproximate?: boolean;
  endApproximate?: boolean;
  runAi?: boolean;
}

export interface TodayEntryUpdateInput extends Partial<TodayEntryInput> {
  id: string;
  revisionNote?: string;
}

export interface TodayAiAnalysis {
  summary: string;
  result: string;
  nextAction: string;
  risk: string;
  priority: "NOW" | "NEXT" | "LATER" | "HOLD" | "DROP";
  progressDelta: number;
  labels: string[];
  model: string;
  keySlot: 1 | 2 | 3;
  generatedAt: string;
}

export interface TodayEntry {
  id: string;
  revisionId: string;
  previousRevisionId?: string;
  version: number;
  date: string;
  occurredAt: string;
  startAt?: string;
  endAt?: string;
  startApproximate: boolean;
  endApproximate: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  revisionNote?: string;
  title: string;
  body: string;
  status: TodayEntryStatus;
  kind: TodayEntryKind;
  project: string;
  projectId?: string;
  tags: string[];
  source: "web" | "gae" | "journal" | "import";
  ai?: TodayAiAnalysis;
  aiError?: string;
}

export interface TodayDaySnapshot {
  date: string;
  updatedAt: string;
  entries: TodayEntry[];
  summary: {
    total: number;
    done: number;
    doing: number;
    blocked: number;
    planned: number;
    note: number;
    progressScore: number;
    trackedMinutes: number;
    nextActions: string[];
  };
}

export interface TodayAggregateAnalysis {
  id: string;
  scope: TodayAnalysisScope;
  value: string;
  dateFrom: string;
  dateTo: string;
  entryCount: number;
  sourceUpdatedAt: string;
  summary: string;
  patterns: string[];
  progress: string[];
  risks: string[];
  nextActions: string[];
  metrics: Record<string, string | number | boolean>;
  confidence: "high" | "medium" | "low";
  model: string;
  keySlot: 1 | 2 | 3;
  generatedAt: string;
  automatic: boolean;
}

export interface TodayTagWithUsage extends TodayTag {
  usageCount: number;
  lastUsedAt?: string;
}

export interface TodayAnalysisInput {
  scope?: TodayAnalysisScope;
  value?: string;
  dateFrom?: string;
  dateTo?: string;
  automatic?: boolean;
}

export interface NaoBrainTodayConfig {
  dataDir: string;
  geminiApiKey?: string | null;
  geminiModel: string;
  geminiFallbackKeysFile: string;
  promptFile: string;
  driveRemote?: string | null;
  driveBasePath: string;
}

export interface DriveSyncResult {
  configured: boolean;
  synced: boolean;
  queued?: boolean;
  destination?: string;
  error?: string;
}

export class NaoBrainTodayStore {
  private readonly config: NaoBrainTodayConfig;
  private readonly projects: NaoBrainProjectStore;
  private readonly tags: NaoBrainTagStore;
  private readonly gemini: NaoBrainGeminiClient;
  private queue: Promise<unknown> = Promise.resolve();
  private schedulerRunning = false;
  private driveSyncTask: Promise<void> | null = null;
  private readonly pendingDriveDates = new Set<string>();

  constructor(config: NaoBrainTodayConfig) {
    this.config = config;
    this.projects = new NaoBrainProjectStore(config.dataDir);
    this.tags = new NaoBrainTagStore(config.dataDir);
    this.gemini = new NaoBrainGeminiClient({
      primaryApiKey: config.geminiApiKey,
      model: config.geminiModel,
      fallbackKeysFile: config.geminiFallbackKeysFile,
    });
  }

  async health() {
    const keys = await this.gemini.settings();
    return {
      ok: true,
      name: "naobrain-today",
      dataDir: this.config.dataDir,
      model: this.config.geminiModel,
      geminiConfigured: keys.configuredCount > 0,
      geminiKeys: keys,
      driveConfigured: Boolean(this.config.driveRemote),
      driveRemote: this.config.driveRemote ? redactRemote(this.config.driveRemote) : null,
    };
  }

  async append(input: TodayEntryInput): Promise<{ entry: TodayEntry; snapshot: TodayDaySnapshot; drive: DriveSyncResult }> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const normalized = await this.normalizeInput(input);
      const occurredAt = normalizeIsoDate(normalized.startAt || normalized.occurredAt || new Date().toISOString());
      const date = jstDate(occurredAt);
      const now = new Date().toISOString();
      const entry: TodayEntry = {
        id: randomUUID(),
        revisionId: randomUUID(),
        version: 1,
        date,
        occurredAt,
        startAt: normalized.startAt,
        endAt: normalized.endAt,
        startApproximate: normalized.startApproximate,
        endApproximate: normalized.endApproximate,
        createdAt: now,
        updatedAt: now,
        title: normalized.title,
        body: normalized.body,
        status: normalized.status,
        kind: normalized.kind,
        project: normalized.project,
        projectId: normalized.projectId,
        tags: normalized.tags,
        source: normalized.source,
      };

      await this.applyAi(entry, normalized.runAi);
      await this.appendRevision(entry);
      const snapshot = await this.rebuildSnapshot(date);
      const drive = await this.syncDateFiles(date);
      return { entry, snapshot, drive };
    });
  }

  async update(input: TodayEntryUpdateInput): Promise<{
    entry: TodayEntry;
    snapshot: TodayDaySnapshot;
    previousDate: string;
    drive: DriveSyncResult;
  }> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const current = await this.latestEntry(input.id);
      if (!current) throw new Error("Entry was not found.");
      if (current.deletedAt) throw new Error("Deleted entries cannot be edited.");

      const merged: TodayEntryInput = {
        title: input.title ?? current.title,
        body: input.body ?? current.body,
        status: input.status ?? current.status,
        kind: input.kind ?? current.kind,
        project: input.project ?? current.project,
        projectId: input.projectId ?? current.projectId,
        tags: input.tags ?? current.tags,
        source: input.source ?? current.source,
        occurredAt: input.occurredAt ?? current.occurredAt,
        startAt: input.startAt === undefined ? current.startAt : input.startAt,
        endAt: input.endAt === undefined ? current.endAt : input.endAt,
        startApproximate: input.startApproximate ?? current.startApproximate,
        endApproximate: input.endApproximate ?? current.endApproximate,
        runAi: input.runAi,
      };
      const normalized = await this.normalizeInput(merged);
      const occurredAt = normalizeIsoDate(normalized.startAt || normalized.occurredAt || current.occurredAt);
      const date = jstDate(occurredAt);
      const entry: TodayEntry = {
        ...current,
        revisionId: randomUUID(),
        previousRevisionId: current.revisionId,
        version: current.version + 1,
        date,
        occurredAt,
        startAt: normalized.startAt,
        endAt: normalized.endAt,
        startApproximate: normalized.startApproximate,
        endApproximate: normalized.endApproximate,
        updatedAt: new Date().toISOString(),
        revisionNote: cleanText(input.revisionNote || "", 240) || undefined,
        title: normalized.title,
        body: normalized.body,
        status: normalized.status,
        kind: normalized.kind,
        project: normalized.project,
        projectId: normalized.projectId,
        tags: normalized.tags,
        source: normalized.source,
        ai: undefined,
        aiError: undefined,
      };
      await this.applyAi(entry, input.runAi !== false);
      await this.appendRevision(entry);
      await this.rebuildSnapshot(current.date);
      const snapshot = current.date === date ? await this.list(date) : await this.rebuildSnapshot(date);
      const drive = await this.syncDates(Array.from(new Set([current.date, date])));
      return { entry, snapshot, previousDate: current.date, drive };
    });
  }

  async delete(id: string, revisionNote?: string): Promise<{
    entry: TodayEntry;
    snapshot: TodayDaySnapshot;
    drive: DriveSyncResult;
  }> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const current = await this.latestEntry(id);
      if (!current) throw new Error("Entry was not found.");
      if (current.deletedAt) {
        const snapshot = await this.rebuildSnapshot(current.date);
        return { entry: current, snapshot, drive: this.scheduleDateSync(current.date) };
      }
      const now = new Date().toISOString();
      const entry: TodayEntry = {
        ...current,
        revisionId: randomUUID(),
        previousRevisionId: current.revisionId,
        version: current.version + 1,
        updatedAt: now,
        deletedAt: now,
        revisionNote: cleanText(revisionNote || "記録を削除", 240),
        ai: undefined,
        aiError: undefined,
      };
      await this.appendRevision(entry);
      const snapshot = await this.rebuildSnapshot(current.date);
      const drive = this.scheduleDateSync(current.date);
      return { entry, snapshot, drive };
    });
  }

  async history(id: string): Promise<TodayEntry[]> {
    await this.ensureLayout();
    const normalizedId = normalizeEntryId(id);
    return (await this.readAllRevisions())
      .filter((entry) => entry.id === normalizedId)
      .sort((left, right) => left.version - right.version || left.updatedAt.localeCompare(right.updatedAt));
  }

  async list(date = jstDate(new Date().toISOString())): Promise<TodayDaySnapshot> {
    await this.ensureLayout();
    return this.rebuildSnapshot(normalizeDateOnly(date));
  }

  async digest(date = jstDate(new Date().toISOString())): Promise<string> {
    return renderMarkdown(await this.list(date));
  }

  async sync(date = jstDate(new Date().toISOString())): Promise<DriveSyncResult> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const normalizedDate = normalizeDateOnly(date);
      await this.rebuildSnapshot(normalizedDate);
      return this.syncDateFiles(normalizedDate);
    });
  }

  async listProjects(includeDeleted = false): Promise<TodayProject[]> {
    await this.ensureLayout();
    return this.projects.list(includeDeleted);
  }

  async createProject(name: string): Promise<TodayProject> {
    return this.enqueue(async () => {
      const project = await this.projects.create(name);
      await this.syncMetadataFiles();
      return project;
    });
  }

  async updateProject(id: string, name: string): Promise<TodayProject> {
    return this.enqueue(async () => {
      const project = await this.projects.update(id, name);
      await this.syncMetadataFiles();
      return project;
    });
  }

  async deleteProject(id: string): Promise<TodayProject> {
    return this.enqueue(async () => {
      const project = await this.projects.delete(id);
      await this.syncMetadataFiles();
      return project;
    });
  }

  async listTags(includeDeleted = false): Promise<TodayTagWithUsage[]> {
    await this.ensureLayout();
    const entries = (await this.latestEntries()).filter((entry) => !entry.deletedAt);
    await this.tags.ensureFromNames(entries.flatMap((entry) => entry.tags));
    const usage = new Map<string, { count: number; lastUsedAt?: string }>();
    for (const entry of entries) {
      for (const name of entry.tags) {
        const key = name.toLocaleLowerCase("ja");
        const current = usage.get(key) || { count: 0 };
        current.count += 1;
        if (!current.lastUsedAt || entry.occurredAt > current.lastUsedAt) current.lastUsedAt = entry.occurredAt;
        usage.set(key, current);
      }
    }
    return (await this.tags.list(includeDeleted)).map((tag) => {
      const stats = usage.get(tag.name.toLocaleLowerCase("ja"));
      return { ...tag, usageCount: stats?.count || 0, lastUsedAt: stats?.lastUsedAt };
    });
  }

  async createTag(name: string, category?: string, kind?: TodayTagKind): Promise<TodayTag> {
    return this.enqueue(async () => {
      const tag = await this.tags.create(name, category, kind);
      await this.syncMetadataFiles();
      return tag;
    });
  }

  async updateTag(id: string, input: { name: string; category?: string; kind?: TodayTagKind }): Promise<TodayTag> {
    return this.enqueue(async () => {
      const tag = await this.tags.update(id, input);
      await this.syncMetadataFiles();
      return tag;
    });
  }

  async deleteTag(id: string): Promise<TodayTag> {
    return this.enqueue(async () => {
      const tag = await this.tags.delete(id);
      await this.syncMetadataFiles();
      return tag;
    });
  }

  async aiSettings(): Promise<GeminiKeySettings> {
    return this.gemini.settings();
  }

  async updateAiSettings(input: GeminiFallbackKeyUpdate): Promise<GeminiKeySettings> {
    return this.gemini.updateFallbackKeys(input);
  }

  async analyzeScope(input: TodayAnalysisInput = {}): Promise<TodayAggregateAnalysis> {
    return this.enqueue(async () => this.analyzeScopeUnlocked(input));
  }

  async listAnalyses(limit = 20): Promise<TodayAggregateAnalysis[]> {
    await this.ensureLayout();
    const files = (await collectFiles(join(this.config.dataDir, "analyses")))
      .filter((path) => path.endsWith(".json") && !path.includes("/latest-"));
    const values: TodayAggregateAnalysis[] = [];
    for (const path of files) {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as TodayAggregateAnalysis;
        if (parsed?.id) values.push(parsed);
      } catch {
        // Ignore malformed historical analysis files.
      }
    }
    return values
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
      .slice(0, Math.max(1, Math.min(100, Math.round(limit))));
  }

  async runScheduledDailyAnalyses(now = new Date()): Promise<Array<{ date: string; status: "generated" | "unchanged" | "empty" | "skipped"; analysisId?: string; error?: string }>> {
    if (this.schedulerRunning) return [];
    this.schedulerRunning = true;
    try {
      await this.ensureLayout();
      const currentDate = jstDate(now.toISOString());
      const previousDate = shiftDate(currentDate, -1);
      const currentHour = jstHour(now.toISOString());
      const dates = currentHour >= 23 ? [previousDate, currentDate] : [previousDate];
      const results: Array<{ date: string; status: "generated" | "unchanged" | "empty" | "skipped"; analysisId?: string; error?: string }> = [];
      for (const date of dates) {
        try {
          const snapshot = await this.list(date);
          if (snapshot.entries.length === 0) {
            results.push({ date, status: "empty" });
            continue;
          }
          const existing = (await this.listAnalyses(100)).find((item) => item.automatic && item.scope === "day" && item.value === date);
          if (existing?.sourceUpdatedAt === snapshot.updatedAt) {
            results.push({ date, status: "unchanged", analysisId: existing.id });
            continue;
          }
          const analysis = await this.analyzeScopeUnlocked({
            scope: "day",
            value: date,
            dateFrom: date,
            dateTo: date,
            automatic: true,
          });
          results.push({ date, status: "generated", analysisId: analysis.id });
        } catch (error) {
          results.push({ date, status: "skipped", error: safeError(error, "Daily analysis failed") });
        }
      }
      return results;
    } finally {
      this.schedulerRunning = false;
    }
  }

  private async analyzeScopeUnlocked(input: TodayAnalysisInput): Promise<TodayAggregateAnalysis> {
    await this.ensureLayout();
    const scope = normalizeEnum(input.scope, ["all", "day", "project", "tag", "kind", "status"] as const, "all");
    const value = cleanText(input.value || "", 140);
    const today = jstDate(new Date().toISOString());
    const dateFrom = normalizeDateOnly(input.dateFrom || (scope === "day" && value ? value : shiftDate(today, -30)));
    const dateTo = normalizeDateOnly(input.dateTo || (scope === "day" && value ? value : today));
    if (dateFrom > dateTo) throw new Error("dateFrom must be before dateTo.");

    const allEntries = (await this.latestEntries()).filter((entry) => !entry.deletedAt);
    const entries = allEntries.filter((entry) => {
      if (entry.date < dateFrom || entry.date > dateTo) return false;
      if (scope === "all") return true;
      if (scope === "day") return entry.date === (value || dateFrom);
      if (scope === "project") return entry.projectId === value || entry.project === value;
      if (scope === "tag") return entry.tags.includes(value);
      if (scope === "kind") return entry.kind === value;
      if (scope === "status") return entry.status === value;
      return true;
    });
    if (entries.length === 0) throw new Error("No entries matched the selected analysis scope.");

    const sourceUpdatedAt = entries.reduce((latest, entry) => entry.updatedAt > latest ? entry.updatedAt : latest, "");
    const result = await this.gemini.generateJson({
      systemInstruction: AGGREGATE_PROMPT,
      userPayload: {
        scope,
        value,
        dateFrom,
        dateTo,
        entryCount: entries.length,
        deterministicSummary: deterministicMetrics(entries),
        entries: entries.slice(-300).map((entry) => ({
          date: entry.date,
          startAt: entry.startAt,
          endAt: entry.endAt,
          approximate: { start: entry.startApproximate, end: entry.endApproximate },
          title: entry.title,
          body: entry.body,
          status: entry.status,
          kind: entry.kind,
          project: entry.project,
          tags: entry.tags,
          ai: entry.ai ? {
            summary: entry.ai.summary,
            result: entry.ai.result,
            nextAction: entry.ai.nextAction,
            risk: entry.ai.risk,
            progressDelta: entry.ai.progressDelta,
          } : null,
        })),
      },
      temperature: 0.2,
      maxOutputTokens: 5_000,
      timeoutMs: 60_000,
    });

    const analysis: TodayAggregateAnalysis = {
      id: randomUUID(),
      scope,
      value,
      dateFrom,
      dateTo,
      entryCount: entries.length,
      sourceUpdatedAt,
      summary: cleanText(String(result.value.summary || ""), 800),
      patterns: normalizeTextArray(result.value.patterns, 6, 240),
      progress: normalizeTextArray(result.value.progress, 6, 240),
      risks: normalizeTextArray(result.value.risks, 6, 240),
      nextActions: normalizeTextArray(result.value.nextActions, 6, 260),
      metrics: normalizeMetrics(result.value.metrics),
      confidence: normalizeEnum(result.value.confidence, ["high", "medium", "low"] as const, entries.length >= 8 ? "medium" : "low"),
      model: result.model,
      keySlot: result.keySlot,
      generatedAt: result.generatedAt,
      automatic: input.automatic === true,
    };
    await this.saveAnalysis(analysis);
    await this.syncAnalysisFiles(analysis);
    return analysis;
  }

  private async applyAi(entry: TodayEntry, runAi: boolean): Promise<void> {
    if (!runAi) return;
    try {
      entry.ai = await this.analyze(entry);
    } catch (error) {
      entry.aiError = safeError(error, "Gemini analysis failed");
    }
  }

  private async analyze(entry: TodayEntry): Promise<TodayAiAnalysis> {
    const prompt = await this.readPrompt();
    const result = await this.gemini.generateJson({
      systemInstruction: prompt,
      userPayload: {
        date: entry.date,
        occurredAt: entry.occurredAt,
        startAt: entry.startAt,
        endAt: entry.endAt,
        startApproximate: entry.startApproximate,
        endApproximate: entry.endApproximate,
        title: entry.title,
        body: entry.body,
        status: entry.status,
        kind: entry.kind,
        project: entry.project,
        tags: entry.tags,
        source: entry.source,
      },
      temperature: 0.2,
      timeoutMs: 45_000,
    });
    return normalizeAiAnalysis(result.value, result.model, result.keySlot, result.generatedAt);
  }

  private async normalizeInput(input: TodayEntryInput) {
    const title = cleanText(input.title, 140);
    const body = cleanText(input.body, 8_000);
    if (!title) throw new Error("title is required");
    if (!body) throw new Error("body is required");

    let project = cleanText(input.project || "", 120);
    let projectId = cleanText(input.projectId || "", 80) || undefined;
    if (projectId) {
      const found = (await this.projects.list(true)).find((item) => item.id === projectId);
      if (!found) throw new Error("Selected project was not found.");
      project = found.name;
    } else if (project) {
      const found = await this.projects.create(project);
      project = found.name;
      projectId = found.id;
    }

    const tags = Array.from(new Set((input.tags || []).map((tag) => cleanText(tag, 40)).filter(Boolean))).slice(0, 20);
    await this.tags.ensureFromNames(tags);

    const startAt = normalizeOptionalIsoDate(input.startAt);
    const endAt = normalizeOptionalIsoDate(input.endAt);
    if (startAt && endAt && Date.parse(endAt) < Date.parse(startAt)) {
      throw new Error("End time must be after start time.");
    }

    return {
      title,
      body,
      status: normalizeEnum(input.status, ["done", "doing", "blocked", "planned", "note"] as const, "note"),
      kind: normalizeEnum(input.kind, ["progress", "result", "plan", "journal", "note"] as const, "note"),
      project,
      projectId,
      tags,
      source: normalizeEnum(input.source, ["web", "gae", "journal", "import"] as const, "gae"),
      occurredAt: input.occurredAt,
      startAt,
      endAt,
      startApproximate: input.startApproximate === true,
      endApproximate: input.endApproximate === true,
      runAi: input.runAi !== false,
    };
  }

  private async appendRevision(entry: TodayEntry): Promise<void> {
    const path = this.revisionsPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private async latestEntry(id: string): Promise<TodayEntry | null> {
    const normalizedId = normalizeEntryId(id);
    return (await this.latestEntries()).find((entry) => entry.id === normalizedId) || null;
  }

  private async latestEntries(): Promise<TodayEntry[]> {
    const revisions = await this.readAllRevisions();
    const latest = new Map<string, TodayEntry>();
    for (const entry of revisions) {
      const current = latest.get(entry.id);
      if (!current || entry.version > current.version || (entry.version === current.version && entry.updatedAt > current.updatedAt)) {
        latest.set(entry.id, entry);
      }
    }
    return Array.from(latest.values());
  }

  private async readAllRevisions(): Promise<TodayEntry[]> {
    try {
      const raw = await readFile(this.revisionsPath(), "utf8");
      return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => normalizeStoredEntry(JSON.parse(line)));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async rebuildSnapshot(date: string): Promise<TodayDaySnapshot> {
    const normalizedDate = normalizeDateOnly(date);
    const entries = (await this.latestEntries())
      .filter((entry) => !entry.deletedAt && entry.date === normalizedDate)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.createdAt.localeCompare(right.createdAt));
    const snapshot = buildSnapshot(normalizedDate, entries);
    await Promise.all([
      mkdir(dirname(this.snapshotPath(normalizedDate)), { recursive: true }),
      mkdir(dirname(this.markdownPath(normalizedDate)), { recursive: true }),
      mkdir(dirname(this.jsonlPath(normalizedDate)), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(this.snapshotPath(normalizedDate), `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }),
      writeFile(this.markdownPath(normalizedDate), `${renderMarkdown(snapshot)}\n`, { encoding: "utf8", mode: 0o600 }),
      writeFile(this.jsonlPath(normalizedDate), entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 }),
    ]);
    return snapshot;
  }

  private async saveAnalysis(analysis: TodayAggregateAnalysis): Promise<void> {
    const month = analysis.generatedAt.slice(0, 7).replace("-", "/");
    const path = join(this.config.dataDir, "analyses", month, `${analysis.id}.json`);
    const latest = join(this.config.dataDir, "analyses", `latest-${safeFilePart(analysis.scope)}-${safeFilePart(analysis.value || "all")}.json`);
    await Promise.all([mkdir(dirname(path), { recursive: true }), mkdir(dirname(latest), { recursive: true })]);
    const content = `${JSON.stringify(analysis, null, 2)}\n`;
    await Promise.all([
      writeFile(path, content, { encoding: "utf8", mode: 0o600 }),
      writeFile(latest, content, { encoding: "utf8", mode: 0o600 }),
    ]);
  }

  private scheduleDateSync(date: string): DriveSyncResult {
    if (!this.config.driveRemote) return { configured: false, synced: false };
    this.pendingDriveDates.add(date);
    if (!this.driveSyncTask) {
      this.driveSyncTask = (async () => {
        while (this.pendingDriveDates.size > 0) {
          const dates = Array.from(this.pendingDriveDates);
          this.pendingDriveDates.clear();
          for (const pendingDate of dates) await this.syncDateFiles(pendingDate);
        }
      })().finally(() => {
        this.driveSyncTask = null;
        if (this.pendingDriveDates.size > 0) this.scheduleDateSync(Array.from(this.pendingDriveDates)[0]);
      });
    }
    return {
      configured: true,
      synced: false,
      queued: true,
      destination: `${redactRemote(this.config.driveRemote)}${this.config.driveBasePath}`,
    };
  }

  private async syncDates(dates: string[]): Promise<DriveSyncResult> {
    let result: DriveSyncResult = { configured: Boolean(this.config.driveRemote), synced: Boolean(this.config.driveRemote) };
    for (const date of dates) {
      result = await this.syncDateFiles(date);
      if (!result.synced && result.configured) return result;
    }
    return result;
  }

  private async syncDateFiles(date: string): Promise<DriveSyncResult> {
    if (!this.config.driveRemote) return { configured: false, synced: false };
    const remoteRoot = joinRemote(this.config.driveRemote, this.config.driveBasePath, date.slice(0, 4), date.slice(5, 7));
    const remoteConfigRoot = joinRemote(this.config.driveRemote, this.config.driveBasePath, "config");
    const remoteHistoryRoot = joinRemote(this.config.driveRemote, this.config.driveBasePath, "history");
    const files = [
      { local: this.snapshotPath(date), remote: `${remoteRoot}/${date}.json` },
      { local: this.markdownPath(date), remote: `${remoteRoot}/${date}.md` },
      { local: this.jsonlPath(date), remote: `${remoteRoot}/${date}.jsonl` },
      { local: this.config.promptFile, remote: `${remoteConfigRoot}/prompt.md` },
      { local: this.revisionsPath(), remote: `${remoteHistoryRoot}/revisions.jsonl` },
    ];
    return this.copyFilesToDrive(files, [remoteRoot, remoteConfigRoot, remoteHistoryRoot]);
  }

  private async syncMetadataFiles(): Promise<DriveSyncResult> {
    if (!this.config.driveRemote) return { configured: false, synced: false };
    const remoteProjectsRoot = joinRemote(this.config.driveRemote, this.config.driveBasePath, "projects");
    const remoteTagsRoot = joinRemote(this.config.driveRemote, this.config.driveBasePath, "tags");
    const files = [
      { local: join(this.config.dataDir, "projects", "projects.json"), remote: `${remoteProjectsRoot}/projects.json` },
      { local: join(this.config.dataDir, "projects", "history.jsonl"), remote: `${remoteProjectsRoot}/history.jsonl` },
      { local: join(this.config.dataDir, "tags", "tags.json"), remote: `${remoteTagsRoot}/tags.json` },
      { local: join(this.config.dataDir, "tags", "history.jsonl"), remote: `${remoteTagsRoot}/history.jsonl` },
    ];
    return this.copyFilesToDrive(files, [remoteProjectsRoot, remoteTagsRoot]);
  }

  private async syncAnalysisFiles(analysis: TodayAggregateAnalysis): Promise<DriveSyncResult> {
    if (!this.config.driveRemote) return { configured: false, synced: false };
    const month = analysis.generatedAt.slice(0, 7).replace("-", "/");
    const local = join(this.config.dataDir, "analyses", month, `${analysis.id}.json`);
    const remoteRoot = joinRemote(this.config.driveRemote, this.config.driveBasePath, "analyses", month);
    return this.copyFilesToDrive([{ local, remote: `${remoteRoot}/${analysis.id}.json` }], [remoteRoot]);
  }

  private async copyFilesToDrive(files: Array<{ local: string; remote: string }>, remoteDirs: string[]): Promise<DriveSyncResult> {
    if (!this.config.driveRemote) return { configured: false, synced: false };
    try {
      for (const remoteDir of remoteDirs) {
        await execFileAsync("rclone", ["mkdir", remoteDir], { timeout: 60_000, maxBuffer: 512 * 1024 });
      }
      for (const file of files) {
        try {
          await readFile(file.local);
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        await execFileAsync("rclone", ["copyto", file.local, file.remote, "--retries", "2", "--low-level-retries", "3"], {
          timeout: 90_000,
          maxBuffer: 512 * 1024,
        });
      }
      return { configured: true, synced: true, destination: `${redactRemote(this.config.driveRemote)}${this.config.driveBasePath}` };
    } catch (error) {
      return {
        configured: true,
        synced: false,
        destination: `${redactRemote(this.config.driveRemote)}${this.config.driveBasePath}`,
        error: safeError(error, "Google Drive sync failed"),
      };
    }
  }

  private async readPrompt(): Promise<string> {
    try {
      const prompt = (await readFile(this.config.promptFile, "utf8")).trim();
      return prompt || DEFAULT_PROMPT;
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(dirname(this.config.promptFile), { recursive: true });
      await writeFile(this.config.promptFile, `${DEFAULT_PROMPT}\n`, { encoding: "utf8", mode: 0o600 });
      return DEFAULT_PROMPT;
    }
  }

  private async ensureLayout(): Promise<void> {
    await Promise.all([
      mkdir(join(this.config.dataDir, "entries"), { recursive: true }),
      mkdir(join(this.config.dataDir, "days"), { recursive: true }),
      mkdir(join(this.config.dataDir, "markdown"), { recursive: true }),
      mkdir(join(this.config.dataDir, "history"), { recursive: true }),
      mkdir(join(this.config.dataDir, "analyses"), { recursive: true }),
      mkdir(join(this.config.dataDir, "projects"), { recursive: true }),
      mkdir(join(this.config.dataDir, "tags"), { recursive: true }),
    ]);
    await this.readPrompt();
    await this.migrateLegacyEntries();
  }

  private async migrateLegacyEntries(): Promise<void> {
    const marker = join(this.config.dataDir, "history", ".migrated-v2");
    try {
      await readFile(marker, "utf8");
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const existing = await this.readAllRevisions();
    if (existing.length === 0) {
      const files = (await collectFiles(join(this.config.dataDir, "entries"))).filter((path) => path.endsWith(".jsonl"));
      const seen = new Set<string>();
      for (const path of files) {
        try {
          const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean);
          for (const line of lines) {
            const raw = JSON.parse(line);
            const entry = normalizeStoredEntry(raw);
            if (seen.has(entry.id)) continue;
            seen.add(entry.id);
            await this.appendRevision(entry);
          }
        } catch {
          // Keep migration tolerant; malformed legacy lines remain in their original files.
        }
      }
    }
    await writeFile(marker, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });

    const latestEntries = (await this.latestEntries()).filter((entry) => !entry.deletedAt);
    const projectNames = latestEntries.map((entry) => entry.project).filter(Boolean);
    await this.projects.ensureFromNames(projectNames);
    await this.tags.ensureFromNames(latestEntries.flatMap((entry) => entry.tags));
  }

  private revisionsPath(): string {
    return join(this.config.dataDir, "history", "revisions.jsonl");
  }

  private jsonlPath(date: string): string {
    return join(this.config.dataDir, "entries", date.slice(0, 4), date.slice(5, 7), `${date}.jsonl`);
  }

  private snapshotPath(date: string): string {
    return join(this.config.dataDir, "days", date.slice(0, 4), date.slice(5, 7), `${date}.json`);
  }

  private markdownPath(date: string): string {
    return join(this.config.dataDir, "markdown", date.slice(0, 4), date.slice(5, 7), `${date}.md`);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function normalizeStoredEntry(value: unknown): TodayEntry {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<TodayEntry>;
  const occurredAt = normalizeIsoDate(raw.occurredAt || raw.startAt || new Date().toISOString());
  const createdAt = normalizeIsoDate(raw.createdAt || occurredAt);
  const updatedAt = normalizeIsoDate(raw.updatedAt || raw.createdAt || occurredAt);
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : randomUUID(),
    revisionId: typeof raw.revisionId === "string" && raw.revisionId ? raw.revisionId : randomUUID(),
    previousRevisionId: typeof raw.previousRevisionId === "string" ? raw.previousRevisionId : undefined,
    version: Number.isInteger(raw.version) && Number(raw.version) > 0 ? Number(raw.version) : 1,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || "")) ? String(raw.date) : jstDate(occurredAt),
    occurredAt,
    startAt: normalizeOptionalIsoDate(raw.startAt),
    endAt: normalizeOptionalIsoDate(raw.endAt),
    startApproximate: raw.startApproximate === true,
    endApproximate: raw.endApproximate === true,
    createdAt,
    updatedAt,
    deletedAt: normalizeOptionalIsoDate(raw.deletedAt),
    revisionNote: cleanText(raw.revisionNote || "", 240) || undefined,
    title: cleanText(raw.title || "無題", 140),
    body: cleanText(raw.body || "", 8_000),
    status: normalizeEnum(raw.status, ["done", "doing", "blocked", "planned", "note"] as const, "note"),
    kind: normalizeEnum(raw.kind, ["progress", "result", "plan", "journal", "note"] as const, "note"),
    project: cleanText(raw.project || "", 120),
    projectId: cleanText(raw.projectId || "", 80) || undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => cleanText(tag, 40)).filter(Boolean).slice(0, 20) : [],
    source: normalizeEnum(raw.source, ["web", "gae", "journal", "import"] as const, "import"),
    ai: raw.ai,
    aiError: cleanText(raw.aiError || "", 500) || undefined,
  };
}

function normalizeAiAnalysis(value: Record<string, unknown>, model: string, keySlot: 1 | 2 | 3, generatedAt: string): TodayAiAnalysis {
  const priority = normalizeEnum(value.priority, ["NOW", "NEXT", "LATER", "HOLD", "DROP"] as const, "NEXT");
  const progressDeltaRaw = Number(value.progressDelta);
  const progressDelta = Number.isFinite(progressDeltaRaw) ? Math.max(-100, Math.min(100, Math.round(progressDeltaRaw))) : 0;
  return {
    summary: cleanText(String(value.summary ?? ""), 220),
    result: cleanText(String(value.result ?? ""), 300),
    nextAction: cleanText(String(value.nextAction ?? ""), 300),
    risk: cleanText(String(value.risk ?? ""), 220),
    priority,
    progressDelta,
    labels: normalizeTextArray(value.labels, 5, 32),
    model,
    keySlot,
    generatedAt,
  };
}

function buildSnapshot(date: string, entries: TodayEntry[]): TodayDaySnapshot {
  const counts = { done: 0, doing: 0, blocked: 0, planned: 0, note: 0 };
  let progressScore = 0;
  let trackedMinutes = 0;
  const nextActions: string[] = [];
  let updatedAt = "";
  for (const entry of entries) {
    counts[entry.status] += 1;
    progressScore += entry.ai?.progressDelta ?? 0;
    if (entry.ai?.nextAction) nextActions.push(entry.ai.nextAction);
    if (entry.startAt && entry.endAt) trackedMinutes += Math.max(0, Math.round((Date.parse(entry.endAt) - Date.parse(entry.startAt)) / 60_000));
    if (entry.updatedAt > updatedAt) updatedAt = entry.updatedAt;
  }
  return {
    date,
    updatedAt: updatedAt || new Date().toISOString(),
    entries,
    summary: {
      total: entries.length,
      ...counts,
      progressScore,
      trackedMinutes,
      nextActions: Array.from(new Set(nextActions)).slice(-5),
    },
  };
}

function renderMarkdown(snapshot: TodayDaySnapshot): string {
  const lines = [
    `# Today / ${snapshot.date}`,
    "",
    `- Total: ${snapshot.summary.total}`,
    `- Done: ${snapshot.summary.done}`,
    `- Doing: ${snapshot.summary.doing}`,
    `- Blocked: ${snapshot.summary.blocked}`,
    `- Tracked: ${snapshot.summary.trackedMinutes} min`,
    `- Progress score: ${snapshot.summary.progressScore >= 0 ? "+" : ""}${snapshot.summary.progressScore}`,
    "",
  ];
  for (const entry of snapshot.entries) {
    const time = formatEntryTime(entry);
    lines.push(`## ${time} · ${entry.title}`);
    lines.push("");
    lines.push(`- Version: ${entry.version}`);
    lines.push(`- Status: ${entry.status}`);
    lines.push(`- Kind: ${entry.kind}`);
    lines.push(`- Source: ${entry.source}`);
    if (entry.project) lines.push(`- Project: ${entry.project}`);
    if (entry.tags.length) lines.push(`- Tags: ${entry.tags.join(", ")}`);
    if (entry.revisionNote) lines.push(`- Revision note: ${entry.revisionNote}`);
    lines.push("");
    lines.push(entry.body);
    if (entry.ai) {
      lines.push("", "### AI analysis", "");
      lines.push(`- Priority: ${entry.ai.priority}`);
      lines.push(`- Summary: ${entry.ai.summary}`);
      lines.push(`- Result: ${entry.ai.result}`);
      lines.push(`- Next: ${entry.ai.nextAction}`);
      if (entry.ai.risk) lines.push(`- Risk: ${entry.ai.risk}`);
      lines.push(`- Progress delta: ${entry.ai.progressDelta >= 0 ? "+" : ""}${entry.ai.progressDelta}`);
      lines.push(`- API slot: ${entry.ai.keySlot}`);
    } else if (entry.aiError) {
      lines.push("", `- AI status: ${entry.aiError}`);
    }
    lines.push("");
  }
  if (snapshot.summary.nextActions.length) {
    lines.push("## Next actions", "");
    snapshot.summary.nextActions.forEach((action) => lines.push(`- ${action}`));
  }
  return lines.join("\n").trimEnd();
}

function deterministicMetrics(entries: TodayEntry[]) {
  const byStatus: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  const byTag: Record<string, number> = {};
  let trackedMinutes = 0;
  for (const entry of entries) {
    byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
    byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    if (entry.project) byProject[entry.project] = (byProject[entry.project] || 0) + 1;
    entry.tags.forEach((tag) => { byTag[tag] = (byTag[tag] || 0) + 1; });
    if (entry.startAt && entry.endAt) trackedMinutes += Math.max(0, Math.round((Date.parse(entry.endAt) - Date.parse(entry.startAt)) / 60_000));
  }
  return { byStatus, byKind, byProject, byTag, trackedMinutes };
}

function normalizeMetrics(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    const normalizedKey = cleanText(key, 60);
    if (!normalizedKey) continue;
    if (typeof item === "number" && Number.isFinite(item)) result[normalizedKey] = item;
    else if (typeof item === "boolean") result[normalizedKey] = item;
    else if (typeof item === "string") result[normalizedKey] = cleanText(item, 160);
  }
  return result;
}

function normalizeTextArray(value: unknown, maxItems: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.map((item) => cleanText(String(item ?? ""), maxLength)).filter(Boolean).slice(0, maxItems)
    : [];
}

function formatEntryTime(entry: TodayEntry): string {
  if (entry.startAt || entry.endAt) {
    const start = entry.startAt ? `${entry.startApproximate ? "約" : ""}${jstTime(entry.startAt)}` : "—";
    const end = entry.endAt ? `${entry.endApproximate ? "約" : ""}${jstTime(entry.endAt)}` : "—";
    return `${start}–${end}`;
  }
  return jstTime(entry.occurredAt);
}

function jstDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("occurredAt must be a valid ISO date");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: JST_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function jstTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: JST_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function jstHour(value: string): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: JST_TIME_ZONE, hour: "2-digit", hour12: false }).format(new Date(value));
  return Number(hour);
}

function normalizeDateOnly(value: string): string {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error("date must use YYYY-MM-DD");
  return normalized;
}

function normalizeIsoDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Date/time must be a valid ISO date");
  return date.toISOString();
}

function normalizeOptionalIsoDate(value: unknown): string | undefined {
  const normalized = String(value || "").trim();
  return normalized ? normalizeIsoDate(normalized) : undefined;
}

function normalizeEntryId(value: string): string {
  const id = String(value || "").trim();
  if (!/^[0-9a-f-]{20,}$/i.test(id)) throw new Error("Invalid entry id.");
  return id;
}

function normalizeEnum<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return allowed.includes(value as T[number]) ? value as T[number] : fallback;
}

function cleanText(value: unknown, max: number): string {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function shiftDate(value: string, delta: number): string {
  const date = new Date(`${normalizeDateOnly(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function safeFilePart(value: string): string {
  return String(value || "all").normalize("NFKC").replace(/[^0-9A-Za-zぁ-んァ-ヶ一-龠_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "all";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function safeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || fallback);
  return message
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/key[=:][^&\s\"']+/gi, "key=[redacted]")
    .slice(0, 700);
}

function joinRemote(remote: string, ...parts: string[]): string {
  const cleanRemote = remote.trim().replace(/\/+$/, "");
  const cleanParts = parts.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean);
  if (cleanRemote.endsWith(":")) return `${cleanRemote}${cleanParts.join("/")}`;
  return `${cleanRemote}/${cleanParts.join("/")}`;
}

function redactRemote(remote: string): string {
  const value = remote.trim();
  const colon = value.indexOf(":");
  return colon >= 0 ? `${value.slice(0, colon + 1)}` : "drive:";
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(path: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  await walk(root);
  return files;
}

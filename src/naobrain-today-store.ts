import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

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

export type TodayEntryStatus = "done" | "doing" | "blocked" | "planned" | "note";
export type TodayEntryKind = "progress" | "result" | "plan" | "journal" | "note";

export interface TodayEntryInput {
  title: string;
  body: string;
  status?: TodayEntryStatus;
  kind?: TodayEntryKind;
  project?: string;
  tags?: string[];
  source?: "web" | "gae" | "journal" | "import";
  occurredAt?: string;
  runAi?: boolean;
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
  generatedAt: string;
}

export interface TodayEntry {
  id: string;
  date: string;
  occurredAt: string;
  createdAt: string;
  title: string;
  body: string;
  status: TodayEntryStatus;
  kind: TodayEntryKind;
  project: string;
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
    nextActions: string[];
  };
}

export interface NaoBrainTodayConfig {
  dataDir: string;
  geminiApiKey?: string;
  geminiModel: string;
  promptFile: string;
  driveRemote?: string;
  driveBasePath: string;
}

export class NaoBrainTodayStore {
  private readonly config: NaoBrainTodayConfig;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(config: NaoBrainTodayConfig) {
    this.config = config;
  }

  health() {
    return {
      ok: true,
      name: "naobrain-today",
      dataDir: this.config.dataDir,
      model: this.config.geminiModel,
      geminiConfigured: Boolean(this.config.geminiApiKey),
      driveConfigured: Boolean(this.config.driveRemote),
      driveRemote: this.config.driveRemote ? redactRemote(this.config.driveRemote) : null,
    };
  }

  async append(input: TodayEntryInput): Promise<{ entry: TodayEntry; snapshot: TodayDaySnapshot; drive: DriveSyncResult }> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const normalized = normalizeInput(input);
      const occurredAt = normalizeIsoDate(normalized.occurredAt ?? new Date().toISOString());
      const date = jstDate(occurredAt);
      const createdAt = new Date().toISOString();
      const entry: TodayEntry = {
        id: randomUUID(),
        date,
        occurredAt,
        createdAt,
        title: normalized.title,
        body: normalized.body,
        status: normalized.status,
        kind: normalized.kind,
        project: normalized.project,
        tags: normalized.tags,
        source: normalized.source,
      };

      if (normalized.runAi) {
        if (this.config.geminiApiKey) {
          try {
            entry.ai = await this.analyze(entry);
          } catch (error) {
            entry.aiError = safeError(error, "Gemini analysis failed");
          }
        } else {
          entry.aiError = "Gemini API key is not configured.";
        }
      }

      const jsonlPath = this.jsonlPath(date);
      await mkdir(dirname(jsonlPath), { recursive: true });
      await appendFile(jsonlPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      const snapshot = await this.rebuildSnapshot(date);
      const drive = await this.syncDateFiles(date);
      return { entry, snapshot, drive };
    });
  }

  async list(date = jstDate(new Date().toISOString())): Promise<TodayDaySnapshot> {
    await this.ensureLayout();
    const normalizedDate = normalizeDateOnly(date);
    try {
      const raw = await readFile(this.snapshotPath(normalizedDate), "utf8");
      return JSON.parse(raw) as TodayDaySnapshot;
    } catch (error) {
      if (isMissing(error)) return emptySnapshot(normalizedDate);
      throw error;
    }
  }

  async digest(date = jstDate(new Date().toISOString())): Promise<string> {
    const snapshot = await this.list(date);
    return renderMarkdown(snapshot);
  }

  async sync(date = jstDate(new Date().toISOString())): Promise<DriveSyncResult> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const normalizedDate = normalizeDateOnly(date);
      await this.rebuildSnapshot(normalizedDate);
      return this.syncDateFiles(normalizedDate);
    });
  }

  private async analyze(entry: TodayEntry): Promise<TodayAiAnalysis> {
    const prompt = await this.readPrompt();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.config.geminiModel)}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.config.geminiApiKey || "",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt }] },
        contents: [{
          role: "user",
          parts: [{ text: JSON.stringify({
            date: entry.date,
            occurredAt: entry.occurredAt,
            title: entry.title,
            body: entry.body,
            status: entry.status,
            kind: entry.kind,
            project: entry.project,
            tags: entry.tags,
            source: entry.source,
          }) }],
        }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Gemini API ${response.status}: ${detail.slice(0, 240)}`);
    }

    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    if (!text) throw new Error("Gemini returned an empty response.");

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stripJsonFence(text)) as Record<string, unknown>;
    } catch {
      throw new Error("Gemini returned invalid JSON.");
    }

    return normalizeAiAnalysis(parsed, this.config.geminiModel);
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

  private async rebuildSnapshot(date: string): Promise<TodayDaySnapshot> {
    const jsonlPath = this.jsonlPath(date);
    await mkdir(dirname(jsonlPath), { recursive: true });
    await appendFile(jsonlPath, "", { encoding: "utf8", mode: 0o600 });
    const entries = await this.readJsonl(date);
    entries.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.createdAt.localeCompare(right.createdAt));
    const snapshot = buildSnapshot(date, entries);
    await Promise.all([
      mkdir(dirname(this.snapshotPath(date)), { recursive: true }),
      mkdir(dirname(this.markdownPath(date)), { recursive: true }),
    ]);
    await writeFile(this.snapshotPath(date), `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(this.markdownPath(date), `${renderMarkdown(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
    return snapshot;
  }

  private async readJsonl(date: string): Promise<TodayEntry[]> {
    try {
      const raw = await readFile(this.jsonlPath(date), "utf8");
      return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TodayEntry);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async syncDateFiles(date: string): Promise<DriveSyncResult> {
    if (!this.config.driveRemote) return { configured: false, synced: false };

    const remoteRoot = joinRemote(this.config.driveRemote, this.config.driveBasePath, date.slice(0, 4), date.slice(5, 7));
    const remoteConfigRoot = joinRemote(this.config.driveRemote, this.config.driveBasePath, "config");
    const files = [
      { local: this.snapshotPath(date), remote: `${remoteRoot}/${date}.json` },
      { local: this.markdownPath(date), remote: `${remoteRoot}/${date}.md` },
      { local: this.jsonlPath(date), remote: `${remoteRoot}/${date}.jsonl` },
      { local: this.config.promptFile, remote: `${remoteConfigRoot}/prompt.md` },
    ];

    try {
      for (const remoteDir of [remoteRoot, remoteConfigRoot]) {
        await execFileAsync("rclone", ["mkdir", remoteDir], {
          timeout: 60_000,
          maxBuffer: 512 * 1024,
        });
      }
      for (const file of files) {
        await execFileAsync("rclone", ["copyto", file.local, file.remote, "--retries", "2", "--low-level-retries", "3"], {
          timeout: 60_000,
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

  private async ensureLayout(): Promise<void> {
    await Promise.all([
      mkdir(join(this.config.dataDir, "entries"), { recursive: true }),
      mkdir(join(this.config.dataDir, "days"), { recursive: true }),
      mkdir(join(this.config.dataDir, "markdown"), { recursive: true }),
    ]);
    await this.readPrompt();
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

export interface DriveSyncResult {
  configured: boolean;
  synced: boolean;
  destination?: string;
  error?: string;
}

function normalizeInput(input: TodayEntryInput) {
  const title = cleanText(input.title, 140);
  const body = cleanText(input.body, 8_000);
  if (!title) throw new Error("title is required");
  if (!body) throw new Error("body is required");

  return {
    title,
    body,
    status: normalizeEnum(input.status, ["done", "doing", "blocked", "planned", "note"] as const, "note"),
    kind: normalizeEnum(input.kind, ["progress", "result", "plan", "journal", "note"] as const, "note"),
    project: cleanText(input.project || "", 120),
    tags: Array.from(new Set((input.tags || []).map((tag) => cleanText(tag, 40)).filter(Boolean))).slice(0, 10),
    source: normalizeEnum(input.source, ["web", "gae", "journal", "import"] as const, "gae"),
    occurredAt: input.occurredAt,
    runAi: input.runAi !== false,
  };
}

function normalizeAiAnalysis(value: Record<string, unknown>, model: string): TodayAiAnalysis {
  const priority = normalizeEnum(value.priority, ["NOW", "NEXT", "LATER", "HOLD", "DROP"] as const, "NEXT");
  const progressDeltaRaw = Number(value.progressDelta);
  const progressDelta = Number.isFinite(progressDeltaRaw) ? Math.max(-100, Math.min(100, Math.round(progressDeltaRaw))) : 0;
  const labels = Array.isArray(value.labels)
    ? value.labels.map((item) => cleanText(String(item ?? ""), 32)).filter(Boolean).slice(0, 5)
    : [];
  return {
    summary: cleanText(String(value.summary ?? ""), 220),
    result: cleanText(String(value.result ?? ""), 300),
    nextAction: cleanText(String(value.nextAction ?? ""), 300),
    risk: cleanText(String(value.risk ?? ""), 220),
    priority,
    progressDelta,
    labels,
    model,
    generatedAt: new Date().toISOString(),
  };
}

function buildSnapshot(date: string, entries: TodayEntry[]): TodayDaySnapshot {
  const counts = { done: 0, doing: 0, blocked: 0, planned: 0, note: 0 };
  let progressScore = 0;
  const nextActions: string[] = [];
  for (const entry of entries) {
    counts[entry.status] += 1;
    progressScore += entry.ai?.progressDelta ?? 0;
    if (entry.ai?.nextAction) nextActions.push(entry.ai.nextAction);
  }
  return {
    date,
    updatedAt: new Date().toISOString(),
    entries,
    summary: {
      total: entries.length,
      ...counts,
      progressScore,
      nextActions: Array.from(new Set(nextActions)).slice(-5),
    },
  };
}

function emptySnapshot(date: string): TodayDaySnapshot {
  return buildSnapshot(date, []);
}

function renderMarkdown(snapshot: TodayDaySnapshot): string {
  const lines = [
    `# Today / ${snapshot.date}`,
    "",
    `- Total: ${snapshot.summary.total}`,
    `- Done: ${snapshot.summary.done}`,
    `- Doing: ${snapshot.summary.doing}`,
    `- Blocked: ${snapshot.summary.blocked}`,
    `- Progress score: ${snapshot.summary.progressScore >= 0 ? "+" : ""}${snapshot.summary.progressScore}`,
    "",
  ];

  for (const entry of snapshot.entries) {
    const time = jstTime(entry.occurredAt);
    lines.push(`## ${time} · ${entry.title}`);
    lines.push("");
    lines.push(`- Status: ${entry.status}`);
    lines.push(`- Kind: ${entry.kind}`);
    lines.push(`- Source: ${entry.source}`);
    if (entry.project) lines.push(`- Project: ${entry.project}`);
    if (entry.tags.length) lines.push(`- Tags: ${entry.tags.join(", ")}`);
    lines.push("");
    lines.push(entry.body);
    if (entry.ai) {
      lines.push("");
      lines.push("### AI analysis");
      lines.push("");
      lines.push(`- Priority: ${entry.ai.priority}`);
      lines.push(`- Summary: ${entry.ai.summary}`);
      lines.push(`- Result: ${entry.ai.result}`);
      lines.push(`- Next: ${entry.ai.nextAction}`);
      if (entry.ai.risk) lines.push(`- Risk: ${entry.ai.risk}`);
      lines.push(`- Progress delta: ${entry.ai.progressDelta >= 0 ? "+" : ""}${entry.ai.progressDelta}`);
    } else if (entry.aiError) {
      lines.push("");
      lines.push(`- AI status: ${entry.aiError}`);
    }
    lines.push("");
  }

  if (snapshot.summary.nextActions.length) {
    lines.push("## Next actions", "");
    snapshot.summary.nextActions.forEach((action) => lines.push(`- ${action}`));
  }
  return lines.join("\n").trimEnd();
}

function jstDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("occurredAt must be a valid ISO date");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function jstTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: JST_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function normalizeDateOnly(value: string): string {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error("date must use YYYY-MM-DD");
  return normalized;
}

function normalizeIsoDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("occurredAt must be a valid ISO date");
  return date.toISOString();
}

function normalizeEnum<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return allowed.includes(value as T[number]) ? value as T[number] : fallback;
}

function cleanText(value: string, max: number): string {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function stripJsonFence(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function safeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || fallback);
  return message.replace(/key=[^&\s]+/gi, "key=[redacted]").slice(0, 300);
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

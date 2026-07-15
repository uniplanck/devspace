import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const JST_TIME_ZONE = "Asia/Tokyo";
const MAX_BANK_SIZE = 200;
const DEFAULT_SESSION_SIZE = 10;

const DEFAULT_PROMPT = `あなたはNaoBrainの記憶定着問題設計器です。
目的は、ユーザーの知識・ジャーナル・行動ログを、長期記憶と実務判断へ接続することです。
必ずJSONだけを返してください。出力形式は {"questions":[...]} です。
各questionは次のキーを含めます。
question: 日本語の問題文
choices: 4つの日本語選択肢
answer: 0〜3の正答インデックス
explanation: 正答理由と誤解しやすい点を含む説明
labels: 最大5件の短いタグ
sourceType: knowledge / journal / today / weakness / application のいずれか
sourceRefs: 入力資料内の見出しやファイル名を最大3件
difficulty: 1〜5の整数

問題設計ルール:
- 単純暗記だけでなく、比較、適用、誤答訂正、実務判断を混ぜる。
- 既存問題の表現だけを変えた重複問題を作らない。
- 誤答率が高い概念は、別角度の類題と応用問題にする。
- ジャーナルやTodayログから、今後学ぶ価値が高い概念・判断基準も出題する。
- 推測を事実として扱わない。資料に根拠がない場合は一般知識問題へ広げすぎない。
- 医療・心理診断を行わない。
- 問題数は6〜10問。`;

export type QuizSessionMode = "resume" | "restart" | "wrong" | "due" | "recommended";
export type QuizSourceType = "knowledge" | "journal" | "today" | "weakness" | "application" | "seed";

export interface QuizQuestion {
  id: string;
  question: string;
  choices: string[];
  answer: number;
  explanation: string;
  labels: string[];
  sourceType: QuizSourceType;
  sourceRefs: string[];
  difficulty: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  generationId?: string;
}

export interface QuizQuestionView {
  id: string;
  question: string;
  choices: string[];
  labels: string[];
  sourceType: QuizSourceType;
  difficulty: number;
}

export interface QuizQuestionStats {
  questionId: string;
  attempts: number;
  correctCount: number;
  wrongCount: number;
  streak: number;
  ease: number;
  intervalDays: number;
  lastAnsweredAt?: string;
  nextDueAt?: string;
  lastSelectedIndex?: number;
  lastCorrect?: boolean;
  averageResponseMs?: number;
}

export interface QuizAnswerRecord {
  id: string;
  sessionId: string;
  questionId: string;
  answeredAt: string;
  selectedIndex: number;
  correctIndex: number;
  correct: boolean;
  responseMs?: number;
  confidence?: "low" | "medium" | "high";
  question: string;
  selectedChoice: string;
  correctChoice: string;
  explanation: string;
}

export interface QuizSession {
  id: string;
  mode: Exclude<QuizSessionMode, "resume">;
  questionIds: string[];
  currentIndex: number;
  score: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  answers: QuizAnswerRecord[];
}

export interface QuizState {
  ok: true;
  bank: {
    total: number;
    active: number;
    attempted: number;
    due: number;
    wrong: number;
    accuracy: number;
  };
  session: {
    id: string;
    mode: QuizSession["mode"];
    currentIndex: number;
    total: number;
    score: number;
    completed: boolean;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
  } | null;
  currentQuestion: QuizQuestionView | null;
  wrongQuestionIds: string[];
  dueQuestionIds: string[];
  lastAnsweredAt: string | null;
  nextRecommendedMode: Exclude<QuizSessionMode, "resume">;
}

export interface QuizAnswerInput {
  sessionId: string;
  questionId: string;
  selectedIndex: number;
  responseMs?: number;
  confidence?: "low" | "medium" | "high";
}

export interface QuizGenerationResult {
  generated: boolean;
  reason: string;
  generationId?: string;
  added?: number;
  skippedDuplicates?: number;
  error?: string;
  drive?: QuizDriveSyncResult;
}

export interface QuizDriveSyncResult {
  configured: boolean;
  synced: boolean;
  destination?: string;
  error?: string;
}

export interface NaoBrainQuizConfig {
  dataDir: string;
  promptFile: string;
  geminiApiKey?: string;
  geminiModel: string;
  driveRemote?: string;
  driveBasePath: string;
  sourceRoots: string[];
}

interface QuizGenerationMeta {
  lastGeneratedAt?: string;
  lastGenerationId?: string;
  completedCycles: number;
}

export class NaoBrainQuizStore {
  private readonly config: NaoBrainQuizConfig;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(config: NaoBrainQuizConfig) {
    this.config = config;
  }

  health() {
    return {
      ok: true,
      name: "naobrain-quiz",
      dataDir: this.config.dataDir,
      model: this.config.geminiModel,
      geminiConfigured: Boolean(this.config.geminiApiKey),
      driveConfigured: Boolean(this.config.driveRemote),
      sourceRoots: this.config.sourceRoots.length,
    };
  }

  async getState(): Promise<QuizState> {
    await this.ensureLayout();
    const [bank, stats, session] = await Promise.all([
      this.readBank(),
      this.readStats(),
      this.readSession(),
    ]);
    return buildPublicState(bank, stats, session);
  }

  async start(mode: QuizSessionMode = "recommended", limit = DEFAULT_SESSION_SIZE): Promise<QuizState> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const [bank, stats, current] = await Promise.all([
        this.readBank(),
        this.readStats(),
        this.readSession(),
      ]);

      if (mode === "resume" && current && !current.completedAt && current.currentIndex < current.questionIds.length) {
        return buildPublicState(bank, stats, current);
      }

      const resolvedMode: Exclude<QuizSessionMode, "resume"> = mode === "resume" ? "recommended" : mode;
      const questionIds = selectQuestionIds(bank, stats, resolvedMode, Math.max(1, Math.min(50, Math.round(limit))));
      if (questionIds.length === 0) throw new Error("No active quiz questions are available.");

      const now = new Date().toISOString();
      const session: QuizSession = {
        id: randomUUID(),
        mode: resolvedMode,
        questionIds,
        currentIndex: 0,
        score: 0,
        createdAt: now,
        updatedAt: now,
        answers: [],
      };
      await this.writeSession(session);
      await this.syncToDrive();
      return buildPublicState(bank, stats, session);
    });
  }

  async answer(input: QuizAnswerInput): Promise<{
    ok: true;
    answer: QuizAnswerRecord;
    state: QuizState;
    generation: QuizGenerationResult;
    drive: QuizDriveSyncResult;
  }> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      const [bank, stats, session] = await Promise.all([
        this.readBank(),
        this.readStats(),
        this.readSession(),
      ]);
      if (!session || session.id !== input.sessionId) throw new Error("Quiz session is not active.");
      if (session.completedAt || session.currentIndex >= session.questionIds.length) throw new Error("Quiz session is already complete.");

      const expectedQuestionId = session.questionIds[session.currentIndex];
      if (expectedQuestionId !== input.questionId) throw new Error("Question does not match the current session position.");
      const question = bank.find((item) => item.id === expectedQuestionId && item.active);
      if (!question) throw new Error("Current quiz question is unavailable.");
      const selectedIndex = Number(input.selectedIndex);
      if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= question.choices.length) {
        throw new Error("selectedIndex is invalid.");
      }

      const answeredAt = new Date().toISOString();
      const correct = selectedIndex === question.answer;
      const answer: QuizAnswerRecord = {
        id: randomUUID(),
        sessionId: session.id,
        questionId: question.id,
        answeredAt,
        selectedIndex,
        correctIndex: question.answer,
        correct,
        responseMs: normalizeResponseMs(input.responseMs),
        confidence: normalizeConfidence(input.confidence),
        question: question.question,
        selectedChoice: question.choices[selectedIndex] || "",
        correctChoice: question.choices[question.answer] || "",
        explanation: question.explanation,
      };

      const updatedStats = updateQuestionStats(stats, answer);
      session.answers.push(answer);
      session.currentIndex += 1;
      session.score += correct ? 1 : 0;
      session.updatedAt = answeredAt;
      if (session.currentIndex >= session.questionIds.length) session.completedAt = answeredAt;

      await Promise.all([
        this.writeStats(updatedStats),
        this.writeSession(session),
        this.appendAnswer(answer),
      ]);

      let generation: QuizGenerationResult = { generated: false, reason: "session-in-progress" };
      if (session.completedAt) {
        generation = await this.maybeGenerateAfterCycle(session, bank, updatedStats);
      }
      const finalBank = generation.generated ? await this.readBank() : bank;
      const drive = await this.syncToDrive();
      return {
        ok: true,
        answer,
        state: buildPublicState(finalBank, updatedStats, session),
        generation,
        drive,
      };
    });
  }

  async generate(reason = "manual", force = false): Promise<QuizGenerationResult> {
    return this.enqueue(async () => this.generateUnlocked(reason, force));
  }

  async digest(): Promise<string> {
    await this.ensureLayout();
    const [bank, stats, session] = await Promise.all([
      this.readBank(),
      this.readStats(),
      this.readSession(),
    ]);
    const state = buildPublicState(bank, stats, session);
    const weak = stats
      .filter((item) => item.attempts > 0 && item.wrongCount > 0)
      .sort((left, right) => wrongRate(right) - wrongRate(left))
      .slice(0, 8)
      .map((item) => {
        const question = bank.find((candidate) => candidate.id === item.questionId);
        return question ? `- ${question.question}（誤答 ${item.wrongCount}/${item.attempts}、次回 ${item.nextDueAt || "未設定"}）` : null;
      })
      .filter(Boolean);

    return [
      "# NaoBrain Quiz Digest",
      "",
      `- Active questions: ${state.bank.active}`,
      `- Attempted: ${state.bank.attempted}`,
      `- Accuracy: ${state.bank.accuracy}%`,
      `- Due now: ${state.bank.due}`,
      `- Wrong pool: ${state.bank.wrong}`,
      `- Current session: ${state.session ? `${state.session.currentIndex}/${state.session.total}${state.session.completed ? " complete" : ""}` : "none"}`,
      "",
      "## Weak questions",
      ...(weak.length ? weak : ["- まだ誤答記録はありません。"]),
      "",
      "## Recommended next action",
      state.bank.wrong > 0
        ? "- 「間違えた問題だけ」で短い復習を行い、説明を自分の言葉で再現する。"
        : state.bank.due > 0
          ? "- 期限到来の問題を回答し、想起間隔を更新する。"
          : "- 最近のジャーナル・知識から新しい応用問題を生成する。",
    ].join("\n");
  }

  async sync(): Promise<QuizDriveSyncResult> {
    return this.enqueue(async () => {
      await this.ensureLayout();
      return this.syncToDrive();
    });
  }

  private async maybeGenerateAfterCycle(
    session: QuizSession,
    bank: QuizQuestion[],
    stats: QuizQuestionStats[],
  ): Promise<QuizGenerationResult> {
    const meta = await this.readGenerationMeta();
    meta.completedCycles += 1;
    await this.writeGenerationMeta(meta);

    const activeCount = bank.filter((question) => question.active).length;
    const coveredFullCycle = session.mode === "restart" || session.questionIds.length >= Math.min(activeCount, DEFAULT_SESSION_SIZE);
    if (!coveredFullCycle) return { generated: false, reason: "partial-session" };

    const stale = !meta.lastGeneratedAt || Date.now() - Date.parse(meta.lastGeneratedAt) >= 3 * 24 * 60 * 60 * 1000;
    const sessionWrongRate = session.answers.length
      ? session.answers.filter((answer) => !answer.correct).length / session.answers.length
      : 0;
    if (!stale && sessionWrongRate < 0.25) return { generated: false, reason: "generation-not-due" };

    return this.generateUnlocked(
      `cycle-${meta.completedCycles}; wrong-rate=${Math.round(sessionWrongRate * 100)}%; weak=${stats.filter((item) => wrongRate(item) >= 0.3).length}`,
      true,
    );
  }

  private async generateUnlocked(reason: string, force: boolean): Promise<QuizGenerationResult> {
    await this.ensureLayout();
    if (!this.config.geminiApiKey) return { generated: false, reason, error: "Gemini API key is not configured." };
    const meta = await this.readGenerationMeta();
    if (!force && meta.lastGeneratedAt && Date.now() - Date.parse(meta.lastGeneratedAt) < 6 * 60 * 60 * 1000) {
      return { generated: false, reason: "generation-cooldown" };
    }

    try {
      const [bank, stats, sourceDigest, prompt] = await Promise.all([
        this.readBank(),
        this.readStats(),
        this.collectSourceDigest(),
        this.readPrompt(),
      ]);
      const generationId = `gen-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const weakDigest = stats
        .filter((item) => item.wrongCount > 0)
        .sort((left, right) => wrongRate(right) - wrongRate(left))
        .slice(0, 12)
        .map((item) => {
          const question = bank.find((candidate) => candidate.id === item.questionId);
          return question ? `${question.question} | wrong ${item.wrongCount}/${item.attempts} | labels ${question.labels.join(",")}` : "";
        })
        .filter(Boolean)
        .join("\n");
      const existingDigest = bank
        .filter((question) => question.active)
        .slice(-60)
        .map((question) => `- ${question.question}`)
        .join("\n");

      const payload = [
        prompt,
        "",
        `生成理由: ${reason}`,
        "",
        "## 誤答・弱点",
        weakDigest || "なし",
        "",
        "## 既存問題（重複禁止）",
        existingDigest,
        "",
        "## 最近の知識・ジャーナル・Todayログ",
        sourceDigest || "利用可能な資料なし。既存問題の応用と誤答訂正を優先する。",
      ].join("\n");
      const raw = await this.callGemini(payload);
      const candidates = parseGeneratedQuestions(raw, generationId);
      const normalizedExisting = new Set(bank.map((question) => normalizeQuestionText(question.question)));
      const unique = candidates.filter((question) => {
        const normalized = normalizeQuestionText(question.question);
        if (!normalized || normalizedExisting.has(normalized)) return false;
        normalizedExisting.add(normalized);
        return true;
      });
      if (unique.length === 0) return { generated: false, reason, error: "Gemini returned only duplicate or invalid questions." };

      const merged = [...bank, ...unique].slice(-MAX_BANK_SIZE);
      await this.writeBank(merged);
      const generatedPath = join(this.config.dataDir, "generated", jstDate(new Date().toISOString()).slice(0, 7).replace("-", "/"), `${generationId}.json`);
      await mkdir(dirname(generatedPath), { recursive: true });
      await writeFile(generatedPath, `${JSON.stringify({ generationId, reason, createdAt: new Date().toISOString(), questions: unique }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

      meta.lastGeneratedAt = new Date().toISOString();
      meta.lastGenerationId = generationId;
      await this.writeGenerationMeta(meta);
      const drive = await this.syncToDrive();
      return {
        generated: true,
        reason,
        generationId,
        added: unique.length,
        skippedDuplicates: candidates.length - unique.length,
        drive,
      };
    } catch (error) {
      return { generated: false, reason, error: safeError(error, "Quiz generation failed") };
    }
  }

  private async callGemini(prompt: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.config.geminiModel)}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.config.geminiApiKey || "",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.45,
          maxOutputTokens: 6_000,
        },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini request failed (${response.status}): ${body.slice(0, 220)}`);
    }
    const json = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    if (!text) throw new Error("Gemini returned an empty response.");
    return text;
  }

  private async collectSourceDigest(): Promise<string> {
    const files: Array<{ path: string; root: string; mtimeMs: number }> = [];
    for (const root of this.config.sourceRoots) {
      await collectSourceFiles(root, root, files, 0);
    }
    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const selected = files.slice(0, 20);
    const chunks: string[] = [];
    for (const file of selected) {
      try {
        const content = (await readFile(file.path, "utf8")).trim().slice(0, 3_500);
        if (!content) continue;
        chunks.push(`### ${relative(file.root, file.path) || basename(file.path)}\n${content}`);
      } catch {
        // Individual source files are optional; skip unreadable files.
      }
    }
    return chunks.join("\n\n").slice(0, 55_000);
  }

  private async ensureLayout(): Promise<void> {
    await Promise.all([
      mkdir(join(this.config.dataDir, "bank"), { recursive: true }),
      mkdir(join(this.config.dataDir, "state"), { recursive: true }),
      mkdir(join(this.config.dataDir, "stats"), { recursive: true }),
      mkdir(join(this.config.dataDir, "sessions"), { recursive: true }),
      mkdir(join(this.config.dataDir, "generated"), { recursive: true }),
      mkdir(join(this.config.dataDir, "config"), { recursive: true }),
    ]);
    await this.readPrompt();
    try {
      await readFile(this.bankPath(), "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.writeBank(seedQuestions());
    }
    try {
      await readFile(this.statsPath(), "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.writeStats([]);
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

  private async readBank(): Promise<QuizQuestion[]> {
    return readJsonFile(this.bankPath(), seedQuestions());
  }

  private async writeBank(value: QuizQuestion[]): Promise<void> {
    await writeJsonFile(this.bankPath(), value);
  }

  private async readStats(): Promise<QuizQuestionStats[]> {
    return readJsonFile(this.statsPath(), []);
  }

  private async writeStats(value: QuizQuestionStats[]): Promise<void> {
    await writeJsonFile(this.statsPath(), value);
  }

  private async readSession(): Promise<QuizSession | null> {
    return readJsonFile(this.sessionPath(), null);
  }

  private async writeSession(value: QuizSession): Promise<void> {
    await writeJsonFile(this.sessionPath(), value);
  }

  private async readGenerationMeta(): Promise<QuizGenerationMeta> {
    return readJsonFile(this.generationMetaPath(), { completedCycles: 0 });
  }

  private async writeGenerationMeta(value: QuizGenerationMeta): Promise<void> {
    await writeJsonFile(this.generationMetaPath(), value);
  }

  private async appendAnswer(answer: QuizAnswerRecord): Promise<void> {
    const date = jstDate(answer.answeredAt);
    const path = join(this.config.dataDir, "sessions", date.slice(0, 4), date.slice(5, 7), `${date}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(answer)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private async syncToDrive(): Promise<QuizDriveSyncResult> {
    if (!this.config.driveRemote) return { configured: false, synced: false };
    const destination = joinRemote(this.config.driveRemote, this.config.driveBasePath);
    try {
      await execFileAsync("rclone", ["mkdir", destination], { timeout: 60_000, maxBuffer: 512 * 1024 });
      await execFileAsync("rclone", ["copy", this.config.dataDir, destination, "--retries", "2", "--low-level-retries", "3"], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
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

  private bankPath(): string {
    return join(this.config.dataDir, "bank", "questions.json");
  }

  private statsPath(): string {
    return join(this.config.dataDir, "stats", "question-stats.json");
  }

  private sessionPath(): string {
    return join(this.config.dataDir, "state", "current-session.json");
  }

  private generationMetaPath(): string {
    return join(this.config.dataDir, "state", "generation-meta.json");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function buildPublicState(
  bank: QuizQuestion[],
  stats: QuizQuestionStats[],
  session: QuizSession | null,
): QuizState {
  const active = bank.filter((question) => question.active);
  const statsMap = new Map(stats.map((item) => [item.questionId, item]));
  const now = Date.now();
  const wrongIds = active
    .filter((question) => (statsMap.get(question.id)?.wrongCount || 0) > 0)
    .sort((left, right) => wrongRate(statsMap.get(right.id)) - wrongRate(statsMap.get(left.id)))
    .map((question) => question.id);
  const dueIds = active
    .filter((question) => {
      const value = statsMap.get(question.id);
      return !value?.nextDueAt || Date.parse(value.nextDueAt) <= now;
    })
    .sort((left, right) => dueSortValue(statsMap.get(left.id)) - dueSortValue(statsMap.get(right.id)))
    .map((question) => question.id);
  const attempted = stats.filter((item) => item.attempts > 0);
  const totalAttempts = attempted.reduce((sum, item) => sum + item.attempts, 0);
  const correctAttempts = attempted.reduce((sum, item) => sum + item.correctCount, 0);
  const currentId = session && !session.completedAt ? session.questionIds[session.currentIndex] : undefined;
  const currentQuestion = currentId ? active.find((question) => question.id === currentId) : undefined;
  const lastAnsweredAt = stats
    .map((item) => item.lastAnsweredAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) || null;

  return {
    ok: true,
    bank: {
      total: bank.length,
      active: active.length,
      attempted: attempted.length,
      due: dueIds.length,
      wrong: wrongIds.length,
      accuracy: totalAttempts ? Math.round((correctAttempts / totalAttempts) * 100) : 0,
    },
    session: session
      ? {
          id: session.id,
          mode: session.mode,
          currentIndex: session.currentIndex,
          total: session.questionIds.length,
          score: session.score,
          completed: Boolean(session.completedAt),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          completedAt: session.completedAt,
        }
      : null,
    currentQuestion: currentQuestion ? questionView(currentQuestion) : null,
    wrongQuestionIds: wrongIds,
    dueQuestionIds: dueIds,
    lastAnsweredAt,
    nextRecommendedMode: wrongIds.length ? "wrong" : dueIds.length ? "due" : "recommended",
  };
}

function selectQuestionIds(
  bank: QuizQuestion[],
  stats: QuizQuestionStats[],
  mode: Exclude<QuizSessionMode, "resume">,
  limit: number,
): string[] {
  const active = bank.filter((question) => question.active);
  const statsMap = new Map(stats.map((item) => [item.questionId, item]));
  const wrong = active
    .filter((question) => (statsMap.get(question.id)?.wrongCount || 0) > 0)
    .sort((left, right) => wrongRate(statsMap.get(right.id)) - wrongRate(statsMap.get(left.id)));
  const due = active
    .filter((question) => {
      const item = statsMap.get(question.id);
      return !item?.nextDueAt || Date.parse(item.nextDueAt) <= Date.now();
    })
    .sort((left, right) => dueSortValue(statsMap.get(left.id)) - dueSortValue(statsMap.get(right.id)));
  const newQuestions = active.filter((question) => !statsMap.has(question.id));

  if (mode === "restart") return active.map((question) => question.id);
  if (mode === "wrong") return wrong.slice(0, limit).map((question) => question.id);
  if (mode === "due") return (due.length ? due : active).slice(0, limit).map((question) => question.id);

  const ordered = uniqueQuestions([
    ...wrong.slice(0, Math.ceil(limit * 0.4)),
    ...due.slice(0, Math.ceil(limit * 0.4)),
    ...newQuestions,
    ...active.sort((left, right) => dueSortValue(statsMap.get(left.id)) - dueSortValue(statsMap.get(right.id))),
  ]);
  return ordered.slice(0, limit).map((question) => question.id);
}

function updateQuestionStats(stats: QuizQuestionStats[], answer: QuizAnswerRecord): QuizQuestionStats[] {
  const index = stats.findIndex((item) => item.questionId === answer.questionId);
  const previous = index >= 0 ? stats[index] : {
    questionId: answer.questionId,
    attempts: 0,
    correctCount: 0,
    wrongCount: 0,
    streak: 0,
    ease: 2.5,
    intervalDays: 0,
  } satisfies QuizQuestionStats;
  const attempts = previous.attempts + 1;
  const streak = answer.correct ? previous.streak + 1 : 0;
  const easeDelta = answer.correct
    ? answer.confidence === "high" ? 0.12 : 0.06
    : answer.confidence === "high" ? -0.28 : -0.18;
  const ease = Math.max(1.3, Math.min(3.1, Number((previous.ease + easeDelta).toFixed(2))));
  const baseIntervals = [1, 1, 3, 7, 14, 30, 60, 120];
  let intervalDays = answer.correct
    ? baseIntervals[Math.min(streak, baseIntervals.length - 1)]
    : 1;
  if (answer.correct && answer.confidence === "low") intervalDays = Math.max(1, Math.floor(intervalDays / 2));
  const nextDueAt = new Date(Date.parse(answer.answeredAt) + intervalDays * 24 * 60 * 60 * 1000).toISOString();
  const responseMs = normalizeResponseMs(answer.responseMs);
  const averageResponseMs = responseMs === undefined
    ? previous.averageResponseMs
    : previous.averageResponseMs === undefined
      ? responseMs
      : Math.round(((previous.averageResponseMs * previous.attempts) + responseMs) / attempts);
  const next: QuizQuestionStats = {
    ...previous,
    attempts,
    correctCount: previous.correctCount + (answer.correct ? 1 : 0),
    wrongCount: previous.wrongCount + (answer.correct ? 0 : 1),
    streak,
    ease,
    intervalDays,
    lastAnsweredAt: answer.answeredAt,
    nextDueAt,
    lastSelectedIndex: answer.selectedIndex,
    lastCorrect: answer.correct,
    averageResponseMs,
  };
  const output = [...stats];
  if (index >= 0) output[index] = next;
  else output.push(next);
  return output;
}

function questionView(question: QuizQuestion): QuizQuestionView {
  return {
    id: question.id,
    question: question.question,
    choices: question.choices,
    labels: question.labels,
    sourceType: question.sourceType,
    difficulty: question.difficulty,
  };
}

export function parseGeneratedQuestions(raw: string, generationId: string): QuizQuestion[] {
  const parsed = parseJsonDocument(raw) as { questions?: unknown[] } | unknown[];
  const list = Array.isArray(parsed) ? parsed : parsed.questions;
  if (!Array.isArray(list)) throw new Error("Gemini response does not contain a questions array.");
  const now = new Date().toISOString();
  return list.slice(0, 12).map((value, index) => {
    const item = value as Record<string, unknown>;
    const choices = Array.isArray(item.choices)
      ? item.choices.map((choice) => cleanText(String(choice || ""), 240)).filter(Boolean).slice(0, 4)
      : [];
    const answer = Number(item.answer);
    const question = cleanText(String(item.question || ""), 500);
    const explanation = cleanText(String(item.explanation || ""), 1_200);
    if (!question || choices.length !== 4 || !Number.isInteger(answer) || answer < 0 || answer > 3 || !explanation) {
      throw new Error(`Generated question ${index + 1} is invalid.`);
    }
    return {
      id: randomUUID(),
      question,
      choices,
      answer,
      explanation,
      labels: Array.isArray(item.labels)
        ? item.labels.map((label) => cleanText(String(label || ""), 40)).filter(Boolean).slice(0, 5)
        : [],
      sourceType: normalizeSourceType(item.sourceType),
      sourceRefs: Array.isArray(item.sourceRefs)
        ? item.sourceRefs.map((ref) => cleanText(String(ref || ""), 160)).filter(Boolean).slice(0, 3)
        : [],
      difficulty: Math.max(1, Math.min(5, Math.round(Number(item.difficulty) || 2))),
      active: true,
      createdAt: now,
      updatedAt: now,
      generationId,
    } satisfies QuizQuestion;
  });
}

function parseJsonDocument(raw: string): unknown {
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(clean);
  } catch (originalError) {
    const objectStart = clean.indexOf("{");
    const arrayStart = clean.indexOf("[");
    const candidates = [objectStart, arrayStart].filter((value) => value >= 0);
    const start = candidates.length ? Math.min(...candidates) : -1;
    if (start < 0) throw originalError;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < clean.length; index += 1) {
      const character = clean[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) return JSON.parse(clean.slice(start, index + 1));
      }
    }
    throw originalError;
  }
}

async function collectSourceFiles(
  root: string,
  sourceRoot: string,
  output: Array<{ path: string; root: string; mtimeMs: number }>,
  depth: number,
): Promise<void> {
  if (depth > 7) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "coverage"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(path, sourceRoot, output, depth + 1);
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (![".md", ".json", ".jsonl", ".txt"].includes(extension)) continue;
    try {
      const info = await stat(path);
      if (info.size > 1_000_000) continue;
      output.push({ path, root: sourceRoot, mtimeMs: info.mtimeMs });
    } catch {
      // Ignore files that disappear during collection.
    }
  }
}

function seedQuestions(): QuizQuestion[] {
  const now = "2026-07-15T00:00:00.000Z";
  const seed: Array<Omit<QuizQuestion, "createdAt" | "updatedAt" | "active">> = [
    {
      id: "seed-empty-nature",
      question: "「色即是空」の『空』に最も近い意味は？",
      choices: ["何も存在しない", "固定・独立した自性がない", "物質が消滅する", "感情を捨てる"],
      answer: 1,
      explanation: "空は虚無ではなく、現象が単独で成立する固定本質を持たないことです。",
      labels: ["仏教", "空"],
      sourceType: "seed",
      sourceRefs: ["色即是空"],
      difficulty: 2,
    },
    {
      id: "seed-hom",
      question: "Hom_C(A, X) が集めるものは？",
      choices: ["XからAへのすべての射", "AとXの要素", "圏CにおけるAからXへのすべての射", "AとXの共通部分"],
      answer: 2,
      explanation: "Cが何を有効な射とするかを決め、その中のA→Xをすべて集めます。",
      labels: ["圏論", "Hom"],
      sourceType: "seed",
      sourceRefs: ["Hom"],
      difficulty: 2,
    },
    {
      id: "seed-hom-slot",
      question: "Hom(-, X) の『-』は何を意味する？",
      choices: ["負の数", "射の削除", "任意の対象を入れる空欄", "Xが未知であること"],
      answer: 2,
      explanation: "各対象Aを入れてHom(A, X)を得る、変数位置を表す空欄です。",
      labels: ["圏論", "関手"],
      sourceType: "seed",
      sourceRefs: ["Hom(-, X)"],
      difficulty: 2,
    },
    {
      id: "seed-yoneda",
      question: "米田の補題の直感として適切なのは？",
      choices: ["数個の関係で対象の全てが分かる", "対象の内部構造は存在しない", "射の自然な全体系が対象を同型まで特徴づける", "仏教思想を数学的に証明する"],
      answer: 2,
      explanation: "重要なのはすべての射の体系、自然性、そして『同型を除いて』という条件です。",
      labels: ["圏論", "米田の補題"],
      sourceType: "seed",
      sourceRefs: ["米田の補題"],
      difficulty: 3,
    },
    {
      id: "seed-analogy",
      question: "色即是空と圏論の関係として適切なのは？",
      choices: ["完全に同じ命題", "圏論が仏教を証明する", "関係構造を見る点でのアナロジー", "歴史的に互いを参照した"],
      answer: 2,
      explanation: "構造的な類似はありますが、数学定理と仏教思想を同一視してはいけません。",
      labels: ["比較", "アナロジー"],
      sourceType: "seed",
      sourceRefs: ["色即是空 × 圏論"],
      difficulty: 3,
    },
    {
      id: "seed-night-rule",
      question: "夜の崩れを防ぐ主要な介入は？",
      choices: ["仕事時間を増やす", "23:30以降に新しい娯楽を始めない", "ゲーム機を買い替える", "朝食を抜く"],
      answer: 1,
      explanation: "夜の疲れた自分に終了判断を委ねず、新規開始を時刻で遮断します。",
      labels: ["習慣", "睡眠"],
      sourceType: "seed",
      sourceRefs: ["夜の崩れ"],
      difficulty: 1,
    },
    {
      id: "seed-priority",
      question: "現時点の仕事上の最優先判断は？",
      choices: ["全機能を完成させる", "新しいツールを増やす", "販売可能な成果物を外へ出す", "長期構想を詳細化する"],
      answer: 2,
      explanation: "開発量ではなく、販売文・LP・提案・納品物など外部成果物を増やすことが優先です。",
      labels: ["判断", "事業"],
      sourceType: "seed",
      sourceRefs: ["現在の優先順位"],
      difficulty: 1,
    },
    {
      id: "seed-health-floor",
      question: "体調症状が2つ以上ある日の暫定ルールは？",
      choices: ["夜ゲーム禁止", "辛い食事を増やす", "通常予定を維持する", "深夜に軽作業する"],
      answer: 0,
      explanation: "健康を翌日以降の稼働資本として守るため、夜の負荷を切ります。",
      labels: ["健康運用", "判断"],
      sourceType: "seed",
      sourceRefs: ["現在の運用ルール"],
      difficulty: 1,
    },
  ];
  return seed.map((question) => ({ ...question, active: true, createdAt: now, updatedAt: now }));
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isMissing(error)) return fallback;
    throw error;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function uniqueQuestions(questions: QuizQuestion[]): QuizQuestion[] {
  const seen = new Set<string>();
  return questions.filter((question) => {
    if (seen.has(question.id)) return false;
    seen.add(question.id);
    return true;
  });
}

function wrongRate(stats?: QuizQuestionStats): number {
  return stats?.attempts ? stats.wrongCount / stats.attempts : 0;
}

function dueSortValue(stats?: QuizQuestionStats): number {
  if (!stats?.nextDueAt) return 0;
  const value = Date.parse(stats.nextDueAt);
  return Number.isFinite(value) ? value : 0;
}

function normalizeQuestionText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s。、，,.!?！？「」『』（）()\-—]/g, "");
}

function normalizeSourceType(value: unknown): QuizSourceType {
  const allowed: QuizSourceType[] = ["knowledge", "journal", "today", "weakness", "application", "seed"];
  return allowed.includes(value as QuizSourceType) ? value as QuizSourceType : "application";
}

function normalizeConfidence(value: unknown): QuizAnswerRecord["confidence"] {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function normalizeResponseMs(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.min(60 * 60 * 1000, Math.round(parsed));
}

function cleanText(value: string, max: number): string {
  return value.replace(/\u0000/g, "").trim().slice(0, max);
}

function jstDate(value: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function safeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || fallback);
  return message.replace(/key=[^&\s]+/gi, "key=[redacted]").slice(0, 420);
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

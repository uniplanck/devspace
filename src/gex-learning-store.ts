import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const SCHEMA_VERSION = 1;
const MAX_LOOPS = 5_000;
const MAX_PROFILE_POINTS = 20;

export interface GexLearningLoop {
  id: string;
  conversationKey: string;
  prompt: string;
  assistant: string;
  followup: string;
  capturedAt: number;
}

export interface GexLearningProfile {
  points: string[];
  sampleCount: number;
  updatedAt: number;
}

export interface GexLearningDocument {
  schemaVersion: number;
  updatedAt: number;
  loops: GexLearningLoop[];
  profile: GexLearningProfile;
}

export interface GexLearningSyncPayload {
  version?: unknown;
  capturedAt?: unknown;
  loops?: unknown;
  profile?: unknown;
}

function boundedText(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function boundedTimestamp(value: unknown, fallback = Date.now()): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : fallback;
}

function learningLoopId(loop: Omit<GexLearningLoop, "id">): string {
  return createHash("sha256")
    .update([
      loop.conversationKey,
      loop.prompt,
      loop.assistant,
      loop.followup,
    ].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

export function normalizeGexLearningLoop(raw: unknown): GexLearningLoop | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const loop = {
    conversationKey: boundedText(source.conversationKey, 240) || "global",
    prompt: boundedText(source.prompt, 1_400),
    assistant: boundedText(source.assistant, 2_600),
    followup: boundedText(source.followup, 1_400),
    capturedAt: boundedTimestamp(source.capturedAt),
  };
  if (!loop.prompt || !loop.assistant || !loop.followup) return null;
  return {
    id: boundedText(source.id, 180) || learningLoopId(loop),
    ...loop,
  };
}

export function normalizeGexLearningProfile(raw: unknown): GexLearningProfile {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const points = Array.isArray(source.points)
    ? source.points
      .map((value) => boundedText(value, 400))
      .filter(Boolean)
      .slice(0, MAX_PROFILE_POINTS)
    : [];
  return {
    points,
    sampleCount: Math.max(0, Math.floor(Number(source.sampleCount) || 0)),
    updatedAt: boundedTimestamp(source.updatedAt, 0),
  };
}

function emptyDocument(): GexLearningDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: 0,
    loops: [],
    profile: normalizeGexLearningProfile(null),
  };
}

function normalizeDocument(raw: unknown): GexLearningDocument {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const loops = Array.isArray(source.loops)
    ? source.loops.map(normalizeGexLearningLoop).filter((loop): loop is GexLearningLoop => Boolean(loop))
    : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: boundedTimestamp(source.updatedAt, 0),
    loops: loops
      .sort((a, b) => b.capturedAt - a.capturedAt)
      .slice(0, MAX_LOOPS),
    profile: normalizeGexLearningProfile(source.profile),
  };
}

function profileMarkdown(document: GexLearningDocument): string {
  const updated = document.updatedAt
    ? new Date(document.updatedAt).toISOString()
    : "未同期";
  const points = document.profile.points.length
    ? document.profile.points.map((point) => `- ${point}`).join("\n")
    : "- まだ学習プロフィールはありません。";
  return [
    "# GEX Learning Profile",
    "",
    `- 更新: ${updated}`,
    `- 保存ループ: ${document.loops.length}`,
    `- 学習サンプル: ${document.profile.sampleCount}`,
    "",
    "## 安定した依頼傾向",
    "",
    points,
    "",
    "> `learning.json` が機械可読の正本です。このMarkdownは確認用です。",
    "",
  ].join("\n");
}

export class GexLearningStore {
  readonly directory: string;
  readonly dataPath: string;
  readonly profilePath: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
    this.dataPath = join(this.directory, "learning.json");
    this.profilePath = join(this.directory, "profile.md");
  }

  async read(): Promise<GexLearningDocument> {
    try {
      return normalizeDocument(JSON.parse(await readFile(this.dataPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return emptyDocument();
      if (error instanceof SyntaxError) return emptyDocument();
      throw error;
    }
  }

  async sync(payload: GexLearningSyncPayload): Promise<{
    added: number;
    total: number;
    profilePoints: number;
    updatedAt: number;
  }> {
    const existing = await this.read();
    const incoming = Array.isArray(payload.loops)
      ? payload.loops.map(normalizeGexLearningLoop).filter((loop): loop is GexLearningLoop => Boolean(loop))
      : [];
    const merged = new Map<string, GexLearningLoop>();
    [...incoming, ...existing.loops].forEach((loop) => {
      if (!merged.has(loop.id)) merged.set(loop.id, loop);
    });
    const loops = Array.from(merged.values())
      .sort((a, b) => b.capturedAt - a.capturedAt)
      .slice(0, MAX_LOOPS);
    const incomingProfile = normalizeGexLearningProfile(payload.profile);
    const profile = incomingProfile.points.length || incomingProfile.updatedAt
      ? {
          ...incomingProfile,
          sampleCount: Math.max(incomingProfile.sampleCount, loops.length),
          updatedAt: incomingProfile.updatedAt || Date.now(),
        }
      : {
          ...existing.profile,
          sampleCount: Math.max(existing.profile.sampleCount, loops.length),
        };
    const document: GexLearningDocument = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: Date.now(),
      loops,
      profile,
    };

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporaryPath = `${this.dataPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.dataPath);
    await chmod(this.dataPath, 0o600);
    await writeFile(this.profilePath, profileMarkdown(document), { mode: 0o600 });
    await chmod(this.profilePath, 0o600);

    return {
      added: Math.max(0, loops.length - existing.loops.length),
      total: loops.length,
      profilePoints: profile.points.length,
      updatedAt: document.updatedAt,
    };
  }
}

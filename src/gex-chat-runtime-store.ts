import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCHEMA_VERSION = 1;
const MAX_RECORDS = 200;
const RECORD_TTL_MS = 2 * 60 * 1000;
const ACTIVATION_TTL_MS = 15 * 1000;

export interface GexChatRuntimePayload {
  tabId?: unknown;
  windowId?: unknown;
  url?: unknown;
  title?: unknown;
  generating?: unknown;
  visible?: unknown;
  closed?: unknown;
  reportedAt?: unknown;
}

export interface GexChatActivationPayload {
  tabId?: unknown;
  windowId?: unknown;
  url?: unknown;
}

export interface GexChatActivationCommand {
  id: string;
  type: "activate-tab";
  tabId: number;
  windowId: number;
  url?: string;
  requestedAt: number;
  expiresAt: number;
}

export interface GexChatRuntimeRecord {
  id: string;
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  generating: boolean;
  visible: boolean;
  startedAt?: number;
  reportedAt: number;
}

export interface GexChatRuntimeDocument {
  schemaVersion: 1;
  updatedAt: number;
  records: GexChatRuntimeRecord[];
}

function boundedInteger(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function boundedTimestamp(value: unknown, fallback = Date.now()): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function boundedText(value: unknown, max: number): string {
  return String(value ?? "").normalize("NFKC").trim().slice(0, max);
}

function normalizeChatUrl(value: unknown): string {
  const raw = boundedText(value, 1_000);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(host)) {
      return "";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function emptyDocument(): GexChatRuntimeDocument {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: 0, records: [] };
}

function normalizeRecord(raw: unknown): GexChatRuntimeRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const tabId = boundedInteger(source.tabId, -1);
  const url = normalizeChatUrl(source.url);
  if (tabId < 0 || !url) return null;
  const generating = source.generating === true;
  const reportedAt = boundedTimestamp(source.reportedAt, 0);
  const startedAt = generating ? boundedTimestamp(source.startedAt, reportedAt || Date.now()) : undefined;
  return {
    id: `brave-tab-${tabId}`,
    tabId,
    windowId: boundedInteger(source.windowId, -1),
    url,
    title: boundedText(source.title, 240) || "ChatGPT",
    generating,
    visible: source.visible === true,
    ...(startedAt ? { startedAt } : {}),
    reportedAt,
  };
}

function normalizeDocument(raw: unknown, now = Date.now()): GexChatRuntimeDocument {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const records = Array.isArray(source.records)
    ? source.records
      .map(normalizeRecord)
      .filter((record): record is GexChatRuntimeRecord => Boolean(record))
      .filter((record) => now - record.reportedAt <= RECORD_TTL_MS)
      .sort((a, b) => b.reportedAt - a.reportedAt)
      .slice(0, MAX_RECORDS)
    : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: boundedTimestamp(source.updatedAt, 0),
    records,
  };
}

export class GexChatRuntimeStore {
  readonly filePath: string;
  private pendingActivation?: GexChatActivationCommand;

  constructor(filePath = join(homedir(), ".local", "share", "devspace", "gex-chat-runtime.json")) {
    this.filePath = resolve(filePath);
  }

  private async read(): Promise<GexChatRuntimeDocument> {
    try {
      return normalizeDocument(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch {
      return emptyDocument();
    }
  }

  private async write(document: GexChatRuntimeDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  async sync(payload: GexChatRuntimePayload): Promise<{ active: number; total: number }> {
    const now = Date.now();
    const tabId = boundedInteger(payload.tabId, -1);
    if (tabId < 0) throw new Error("A valid ChatGPT tab is required.");

    const current = await this.read();
    if (payload.closed === true) {
      const records = current.records.filter((item) => item.tabId !== tabId);
      await this.write({ schemaVersion: SCHEMA_VERSION, updatedAt: now, records });
      return {
        active: records.filter((item) => item.generating).length,
        total: records.length,
      };
    }

    const url = normalizeChatUrl(payload.url);
    if (!url) throw new Error("A valid ChatGPT URL is required.");
    const previous = current.records.find((record) => record.tabId === tabId);
    const generating = payload.generating === true;
    const reportedAt = boundedTimestamp(payload.reportedAt, now);
    const record: GexChatRuntimeRecord = {
      id: `brave-tab-${tabId}`,
      tabId,
      windowId: boundedInteger(payload.windowId, -1),
      url,
      title: boundedText(payload.title, 240) || previous?.title || "ChatGPT",
      generating,
      visible: payload.visible === true,
      ...(generating ? { startedAt: previous?.generating ? previous.startedAt ?? reportedAt : reportedAt } : {}),
      reportedAt,
    };
    const records = [record, ...current.records.filter((item) => item.tabId !== tabId)]
      .filter((item) => now - item.reportedAt <= RECORD_TTL_MS)
      .sort((a, b) => b.reportedAt - a.reportedAt)
      .slice(0, MAX_RECORDS);
    await this.write({ schemaVersion: SCHEMA_VERSION, updatedAt: now, records });
    return {
      active: records.filter((item) => item.generating).length,
      total: records.length,
    };
  }

  requestActivation(payload: GexChatActivationPayload): GexChatActivationCommand {
    const tabId = boundedInteger(payload.tabId, -1);
    const url = normalizeChatUrl(payload.url);
    if (tabId < 0 && !url) throw new Error("A valid ChatGPT tab or URL is required.");
    const requestedAt = Date.now();
    const command: GexChatActivationCommand = {
      id: randomUUID(),
      type: "activate-tab",
      tabId,
      windowId: boundedInteger(payload.windowId, -1),
      ...(url ? { url } : {}),
      requestedAt,
      expiresAt: requestedAt + ACTIVATION_TTL_MS,
    };
    this.pendingActivation = command;
    return command;
  }

  activationCommand(now = Date.now()): GexChatActivationCommand | null {
    if (!this.pendingActivation) return null;
    if (this.pendingActivation.expiresAt <= now) {
      this.pendingActivation = undefined;
      return null;
    }
    return this.pendingActivation;
  }

  acknowledgeActivation(commandId: unknown): boolean {
    const id = boundedText(commandId, 100);
    if (!id || this.pendingActivation?.id !== id) return false;
    this.pendingActivation = undefined;
    return true;
  }
}

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

export interface ProgressHistorySyncResult {
  enabled: boolean;
  ok: boolean;
  records: unknown[];
  runtimeId: string;
  remote: string;
  error?: string;
}

interface ProgressHistorySnapshot {
  schemaVersion: 1;
  runtimeId: string;
  updatedAt: string;
  records: unknown[];
}

let remoteCache: unknown[] | undefined;
let lastPullAt = 0;
let lastPullError: string | undefined;

function normalizedBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function safeToken(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80) || "unknown";
}

export function progressRuntimeLabel(): "GAG" | "GAE" {
  const explicit = String(process.env.DEVSPACE_USAGE_LABEL || "").trim().toUpperCase();
  if (explicit === "GAE") return "GAE";
  if (explicit === "GAG") return "GAG";
  const role = String(process.env.DEVSPACE_NODE_ROLE || "").trim().toLowerCase();
  return role === "gae" || role === "ec2" ? "GAE" : "GAG";
}

export function progressRuntimeId(): string {
  const explicit = String(process.env.DEVSPACE_PROGRESS_RUNTIME_ID || "").trim();
  if (explicit) return safeToken(explicit);
  return `${progressRuntimeLabel().toLowerCase()}-${safeToken(hostname())}`;
}

function syncRemote(): string {
  return String(process.env.DEVSPACE_PROGRESS_SYNC_REMOTE || "grive:AI-Agent-OS/Progress-History")
    .trim()
    .replace(/\/+$/u, "");
}

function syncEnabled(): boolean {
  const testPath = process.env.DEVSPACE_CHAT_PROGRESS_PATH;
  const defaultEnabled = !testPath;
  return normalizedBoolean(process.env.DEVSPACE_PROGRESS_SYNC_ENABLED, defaultEnabled);
}

function timeoutMs(): number {
  const parsed = Number(process.env.DEVSPACE_PROGRESS_SYNC_TIMEOUT_MS || 8_000);
  return Number.isFinite(parsed) ? Math.max(1_000, Math.min(30_000, Math.round(parsed))) : 8_000;
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/[\r\n]+/gu, " ").slice(0, 240);
  return String(error).replace(/[\r\n]+/gu, " ").slice(0, 240);
}

function readSnapshot(file: string): unknown[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ProgressHistorySnapshot>;
    return parsed.schemaVersion === 1 && Array.isArray(parsed.records) ? parsed.records : [];
  } catch {
    return [];
  }
}

export function pullSharedProgressHistoryAsync(
  onComplete: (result: ProgressHistorySyncResult) => void,
): ProgressHistorySyncResult {
  const runtimeId = progressRuntimeId();
  const remote = syncRemote();
  if (!syncEnabled()) {
    const result = { enabled: false, ok: true, records: [], runtimeId, remote };
    queueMicrotask(() => onComplete(result));
    return result;
  }

  const now = Date.now();
  if (remoteCache && now - lastPullAt < 10 * 60_000) {
    const result = {
      enabled: true,
      ok: lastPullError === undefined,
      records: remoteCache,
      runtimeId,
      remote,
      error: lastPullError,
    };
    queueMicrotask(() => onComplete(result));
    return result;
  }

  const directory = mkdtempSync(join(tmpdir(), "devspace-progress-pull-"));
  try {
    execFile(
      "rclone",
      ["copy", remote, directory, "--include", "*.json", "--max-depth", "1", "--retries", "1", "--low-level-retries", "1"],
      {
        encoding: "utf8",
        timeout: timeoutMs(),
        maxBuffer: 2 * 1024 * 1024,
      },
      (error) => {
        let result: ProgressHistorySyncResult;
        if (error) {
          remoteCache ??= [];
          lastPullAt = now;
          lastPullError = safeError(error);
          result = { enabled: true, ok: false, records: remoteCache, runtimeId, remote, error: lastPullError };
        } else {
          const records = existsSync(directory)
            ? readdirSync(directory)
                .filter((name) => name.endsWith(".json"))
                .flatMap((name) => readSnapshot(join(directory, name)))
            : [];
          remoteCache = records;
          lastPullAt = now;
          lastPullError = undefined;
          result = { enabled: true, ok: true, records, runtimeId, remote };
        }
        rmSync(directory, { recursive: true, force: true });
        onComplete(result);
      },
    );
    return { enabled: true, ok: true, records: remoteCache ?? [], runtimeId, remote };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    const result = { enabled: true, ok: false, records: remoteCache ?? [], runtimeId, remote, error: safeError(error) };
    queueMicrotask(() => onComplete(result));
    return result;
  }
}

export function publishSharedProgressHistoryAsync(
  records: unknown[],
  onComplete: (result: ProgressHistorySyncResult) => void,
): ProgressHistorySyncResult {
  const runtimeId = progressRuntimeId();
  const remote = syncRemote();
  if (!syncEnabled()) {
    const result = { enabled: false, ok: true, records: [], runtimeId, remote };
    queueMicrotask(() => onComplete(result));
    return result;
  }

  const directory = mkdtempSync(join(tmpdir(), "devspace-progress-push-"));
  const file = join(directory, `${runtimeId}.json`);
  const snapshot: ProgressHistorySnapshot = {
    schemaVersion: 1,
    runtimeId,
    updatedAt: new Date().toISOString(),
    records,
  };
  try {
    writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    execFile(
      "rclone",
      ["copyto", file, `${remote}/${runtimeId}.json`, "--retries", "1", "--low-level-retries", "1"],
      {
        encoding: "utf8",
        timeout: timeoutMs(),
        maxBuffer: 2 * 1024 * 1024,
      },
      (error) => {
        const result: ProgressHistorySyncResult = error
          ? { enabled: true, ok: false, records: [], runtimeId, remote, error: safeError(error) }
          : { enabled: true, ok: true, records: [], runtimeId, remote };
        if (!error) {
          remoteCache = undefined;
          lastPullAt = 0;
          lastPullError = undefined;
        }
        rmSync(directory, { recursive: true, force: true });
        onComplete(result);
      },
    );
    return { enabled: true, ok: true, records: [], runtimeId, remote };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    const result = { enabled: true, ok: false, records: [], runtimeId, remote, error: safeError(error) };
    queueMicrotask(() => onComplete(result));
    return result;
  }
}

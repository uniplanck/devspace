import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { ServerConfig } from "./config.js";

export const JOB_PRESETS = [
  "typecheck",
  "test",
  "build",
  "git-status",
  "runtime-smoke",
  "browser-loop",
  "chatgpt-task",
  "image-to-drive",
] as const;

export type JobPreset = (typeof JOB_PRESETS)[number];
export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "waiting_approval"
  | "interrupted";
export type JobEventLevel = "info" | "stdout" | "stderr" | "warning" | "error";

export interface JobRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  title: string;
  preset: JobPreset;
  status: JobStatus;
  progress: number;
  currentStep: string;
  workerPid?: number;
  processPid?: number;
  exitCode?: number;
  error?: string;
  input?: Record<string, unknown>;
  state?: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface JobEventRecord {
  id: number;
  jobId: string;
  timestamp: string;
  level: JobEventLevel;
  message: string;
}

export interface CreateJobInput {
  workspaceId?: string;
  workspaceRoot: string;
  title?: string;
  preset: JobPreset;
  input?: Record<string, unknown>;
}

export interface JobListScope {
  workspaceId?: string;
  workspaceRoot?: string;
  statuses?: JobStatus[];
  limit?: number;
}

interface JobRow {
  id: string;
  workspace_id: string | null;
  workspace_root: string;
  title: string;
  preset: string;
  status: string;
  progress: number;
  current_step: string;
  worker_pid: number | null;
  process_pid: number | null;
  exit_code: number | null;
  error: string | null;
  input_json: string | null;
  state_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface JobEventRow {
  id: number;
  job_id: string;
  timestamp: string;
  level: string;
  message: string;
}

export class JobStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  create(input: CreateJobInput): JobRecord {
    const now = new Date().toISOString();
    const preset = readPreset(input.preset);
    const record: JobRecord = {
      id: `job_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      title: sanitizeTitle(input.title || defaultJobTitle(preset)),
      preset,
      status: "queued",
      progress: 0,
      currentStep: "Queued",
      input: sanitizeJsonRecord(input.input, "job input"),
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite.prepare(`
      insert into jobs (
        id, workspace_id, workspace_root, title, preset, status, progress,
        current_step, input_json, state_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.workspaceId ?? null,
      record.workspaceRoot,
      record.title,
      record.preset,
      record.status,
      record.progress,
      record.currentStep,
      serializeJsonRecord(record.input),
      null,
      record.createdAt,
      record.updatedAt,
    );
    this.appendEvent(record.id, "info", `Queued ${record.preset} job.`);
    return record;
  }

  list(scope: JobListScope = {}): JobRecord[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (scope.workspaceId) {
      conditions.push("workspace_id = ?");
      values.push(scope.workspaceId);
    } else if (scope.workspaceRoot) {
      conditions.push("workspace_root = ?");
      values.push(resolve(scope.workspaceRoot));
    }
    if (scope.statuses?.length) {
      conditions.push(`status in (${scope.statuses.map(() => "?").join(", ")})`);
      values.push(...scope.statuses);
    }
    const limit = clampInteger(scope.limit, 50, 1, 500);
    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
    const rows = this.database.sqlite.prepare(
      `select * from jobs ${where} order by updated_at desc limit ?`,
    ).all(...values, limit) as JobRow[];
    return rows.map(rowToJobRecord);
  }

  get(idOrPrefix: string): JobRecord | undefined {
    const exact = this.database.sqlite.prepare("select * from jobs where id = ? limit 1")
      .get(idOrPrefix) as JobRow | undefined;
    if (exact) return rowToJobRecord(exact);

    const rows = this.database.sqlite.prepare(
      `select * from jobs where id like ? escape '\\' order by updated_at desc`,
    ).all(`${escapeLike(idOrPrefix)}%`) as JobRow[];
    return rows.length === 1 ? rowToJobRecord(rows[0]!) : undefined;
  }

  update(id: string, patch: Partial<Omit<JobRecord, "id" | "createdAt">>): JobRecord {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown job id: ${id}`);
    const updated: JobRecord = {
      ...current,
      ...patch,
      workspaceRoot: resolve(patch.workspaceRoot ?? current.workspaceRoot),
      title: patch.title === undefined ? current.title : sanitizeTitle(patch.title),
      progress: clampInteger(patch.progress, current.progress, 0, 100),
      input: patch.input === undefined ? current.input : sanitizeJsonRecord(patch.input, "job input"),
      state: patch.state === undefined ? current.state : sanitizeJsonRecord(patch.state, "job state"),
      updatedAt: new Date().toISOString(),
    };

    this.database.sqlite.prepare(`
      update jobs set
        workspace_id = ?, workspace_root = ?, title = ?, preset = ?, status = ?,
        progress = ?, current_step = ?, worker_pid = ?, process_pid = ?, exit_code = ?,
        error = ?, input_json = ?, state_json = ?, started_at = ?, finished_at = ?, updated_at = ?
      where id = ?
    `).run(
      updated.workspaceId ?? null,
      updated.workspaceRoot,
      updated.title,
      updated.preset,
      updated.status,
      updated.progress,
      updated.currentStep,
      updated.workerPid ?? null,
      updated.processPid ?? null,
      updated.exitCode ?? null,
      updated.error ?? null,
      serializeJsonRecord(updated.input),
      serializeJsonRecord(updated.state),
      updated.startedAt ?? null,
      updated.finishedAt ?? null,
      updated.updatedAt,
      updated.id,
    );
    return updated;
  }

  appendEvent(jobId: string, level: JobEventLevel, message: string): JobEventRecord {
    if (!this.getById(jobId)) throw new Error(`Unknown job id: ${jobId}`);
    const timestamp = new Date().toISOString();
    const safeMessage = sanitizeEventMessage(message);
    const result = this.database.sqlite.prepare(
      "insert into job_events (job_id, timestamp, level, message) values (?, ?, ?, ?)",
    ).run(jobId, timestamp, level, safeMessage);
    this.pruneEvents(jobId);
    return {
      id: Number(result.lastInsertRowid),
      jobId,
      timestamp,
      level,
      message: safeMessage,
    };
  }

  events(jobId: string, limit = 200, afterId?: number): JobEventRecord[] {
    const boundedLimit = clampInteger(limit, 200, 1, 1000);
    const rows = afterId === undefined
      ? this.database.sqlite.prepare(
          "select * from job_events where job_id = ? order by id desc limit ?",
        ).all(jobId, boundedLimit) as JobEventRow[]
      : this.database.sqlite.prepare(
          "select * from job_events where job_id = ? and id > ? order by id asc limit ?",
        ).all(jobId, afterId, boundedLimit) as JobEventRow[];
    const ordered = afterId === undefined ? rows.reverse() : rows;
    return ordered.map(rowToJobEventRecord);
  }

  activeCount(workspaceRoot?: string): number {
    const statuses = ["queued", "running", "cancelling", "waiting_approval"];
    if (workspaceRoot) {
      const row = this.database.sqlite.prepare(
        `select count(*) as count from jobs
         where workspace_root = ? and status in (?, ?, ?, ?)`,
      ).get(resolve(workspaceRoot), ...statuses) as { count: number };
      return row.count;
    }
    const row = this.database.sqlite.prepare(
      "select count(*) as count from jobs where status in (?, ?, ?, ?)",
    ).get(...statuses) as { count: number };
    return row.count;
  }

  runningCount(workspaceRoot?: string, excludingJobId?: string): number {
    const conditions = ["status = 'running'"];
    const values: unknown[] = [];
    if (workspaceRoot) {
      conditions.push("workspace_root = ?");
      values.push(resolve(workspaceRoot));
    }
    if (excludingJobId) {
      conditions.push("id != ?");
      values.push(excludingJobId);
    }
    const row = this.database.sqlite.prepare(
      `select count(*) as count from jobs where ${conditions.join(" and ")}`,
    ).get(...values) as { count: number };
    return row.count;
  }

  recoverStaleJobs(isProcessAlive: (pid: number) => boolean = processAlive): JobRecord[] {
    const active = this.list({ statuses: ["running", "cancelling"], limit: 500 });
    const recovered: JobRecord[] = [];
    for (const job of active) {
      const processIsAlive = job.processPid ? isProcessAlive(job.processPid) : false;
      const workerIsAlive = job.workerPid ? isProcessAlive(job.workerPid) : false;
      if (processIsAlive || workerIsAlive) continue;
      const status: JobStatus = job.status === "cancelling" ? "cancelled" : "interrupted";
      const updated = this.update(job.id, {
        status,
        progress: status === "cancelled" ? job.progress : Math.min(job.progress, 99),
        currentStep: status === "cancelled" ? "Cancelled" : "Interrupted after process exit",
        finishedAt: new Date().toISOString(),
        processPid: undefined,
        workerPid: undefined,
        error: status === "interrupted" ? "Worker process is no longer running." : undefined,
      });
      this.appendEvent(
        job.id,
        status === "cancelled" ? "warning" : "error",
        updated.currentStep,
      );
      recovered.push(updated);
    }
    return recovered;
  }

  close(): void {
    this.database.close();
  }

  private getById(id: string): JobRecord | undefined {
    const row = this.database.sqlite.prepare("select * from jobs where id = ?")
      .get(id) as JobRow | undefined;
    return row ? rowToJobRecord(row) : undefined;
  }

  private pruneEvents(jobId: string): void {
    this.database.sqlite.prepare(`
      delete from job_events
      where job_id = ? and id not in (
        select id from job_events where job_id = ? order by id desc limit 1000
      )
    `).run(jobId, jobId);
  }
}

export function createJobStore(config: Pick<ServerConfig, "stateDir">): JobStore {
  return new JobStore(config.stateDir);
}

export function isJobPreset(value: string): value is JobPreset {
  return (JOB_PRESETS as readonly string[]).includes(value);
}

export function defaultJobTitle(preset: JobPreset): string {
  switch (preset) {
    case "typecheck": return "TypeScript typecheck";
    case "test": return "Project tests";
    case "build": return "Production build";
    case "git-status": return "Git status inspection";
    case "runtime-smoke": return "GPT-Agent runtime smoke";
    case "browser-loop": return "Browser Computer task";
    case "chatgpt-task": return "ChatGPT deterministic task";
    case "image-to-drive": return "ChatGPT image to Google Drive";
  }
}

function rowToJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    title: row.title,
    preset: readPreset(row.preset),
    status: readStatus(row.status),
    progress: clampInteger(row.progress, 0, 0, 100),
    currentStep: row.current_step,
    workerPid: row.worker_pid ?? undefined,
    processPid: row.process_pid ?? undefined,
    exitCode: row.exit_code ?? undefined,
    error: row.error ?? undefined,
    input: parseJsonRecord(row.input_json),
    state: parseJsonRecord(row.state_json),
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function rowToJobEventRecord(row: JobEventRow): JobEventRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    timestamp: row.timestamp,
    level: readEventLevel(row.level),
    message: row.message,
  };
}

function readPreset(value: string): JobPreset {
  if (isJobPreset(value)) return value;
  throw new Error(`Unsupported job preset: ${value}`);
}

function readStatus(value: string): JobStatus {
  if (
    value === "queued" || value === "running" || value === "succeeded" ||
    value === "failed" || value === "cancelling" || value === "cancelled" ||
    value === "waiting_approval" || value === "interrupted"
  ) return value;
  return "failed";
}

function readEventLevel(value: string): JobEventLevel {
  if (value === "info" || value === "stdout" || value === "stderr" || value === "warning" || value === "error") {
    return value;
  }
  return "info";
}

function sanitizeJsonRecord(
  value: Record<string, unknown> | undefined,
  label: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable.`);
  }
  if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) {
    throw new Error(`${label} exceeds the 256 KiB limit.`);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function serializeJsonRecord(value: Record<string, unknown> | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeTitle(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[\r\n\t]+/gu, " ").trim();
  return (normalized || "GPT-Agent job").slice(0, 160);
}

function sanitizeEventMessage(value: string): string {
  return value
    .replace(/\u0000/gu, "")
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted-long-value]")
    .slice(0, 2000);
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

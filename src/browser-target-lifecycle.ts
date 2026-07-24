import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type BrowserAutomationTargetKind = "ephemeral" | "preferred";

export interface BrowserAutomationTargetLease {
  targetId: string;
  ownerId: string;
  kind: BrowserAutomationTargetKind;
  createdAt: string;
  updatedAt: string;
}

interface BrowserAutomationTargetLeaseStore {
  schemaVersion: 1;
  leases: BrowserAutomationTargetLease[];
}

export interface ClaimBrowserAutomationTargetInput {
  targetId: string;
  ownerId: string;
  kind: BrowserAutomationTargetKind;
  home?: string;
  nowMs?: number;
  staleAfterMs?: number;
}

export type ClaimBrowserAutomationTargetResult =
  | {
      status: "claimed";
      lease: BrowserAutomationTargetLease;
      replacedStaleOwner?: string;
    }
  | {
      status: "in-use";
      lease: BrowserAutomationTargetLease;
    };

const LEASES_FILE = "computer-browser-target-leases.json";
const LEASES_LOCK_DIRECTORY = "computer-browser-target-leases.lock";
export const DEFAULT_BROWSER_TARGET_LEASE_STALE_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_COUNT = 100;
const LOCK_RETRY_MS = 10;
const sleepArray = new Int32Array(new SharedArrayBuffer(4));

function stateRoot(home: string = homedir()): string {
  return resolve(home, ".devspace");
}

export function browserAutomationTargetLeasesPath(home: string = homedir()): string {
  return join(stateRoot(home), LEASES_FILE);
}

function leasesLockPath(home: string = homedir()): string {
  return join(stateRoot(home), LEASES_LOCK_DIRECTORY);
}

function emptyStore(): BrowserAutomationTargetLeaseStore {
  return { schemaVersion: 1, leases: [] };
}

function normalizeLease(value: unknown): BrowserAutomationTargetLease | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<BrowserAutomationTargetLease>;
  if (!candidate.targetId || !candidate.ownerId) return undefined;
  if (candidate.kind !== "ephemeral" && candidate.kind !== "preferred") return undefined;
  const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : undefined;
  const updatedAt = typeof candidate.updatedAt === "string" ? candidate.updatedAt : undefined;
  if (!createdAt || !updatedAt) return undefined;
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) return undefined;
  return {
    targetId: candidate.targetId,
    ownerId: candidate.ownerId,
    kind: candidate.kind,
    createdAt,
    updatedAt,
  };
}

function readStore(home: string): BrowserAutomationTargetLeaseStore {
  try {
    const parsed = JSON.parse(readFileSync(browserAutomationTargetLeasesPath(home), "utf8")) as {
      schemaVersion?: unknown;
      leases?: unknown;
    };
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.leases)) return emptyStore();
    return {
      schemaVersion: 1,
      leases: parsed.leases
        .map(normalizeLease)
        .filter((lease): lease is BrowserAutomationTargetLease => Boolean(lease)),
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store: BrowserAutomationTargetLeaseStore, home: string): void {
  const path = browserAutomationTargetLeasesPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function waitForLock(): void {
  Atomics.wait(sleepArray, 0, 0, LOCK_RETRY_MS);
}

function withStoreLock<T>(home: string, operation: () => T): T {
  const lockPath = leasesLockPath(home);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        return operation();
      } finally {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}
      waitForLock();
    }
  }
  throw new Error("Timed out waiting for the browser target lease registry lock.");
}

function leaseAgeMs(lease: BrowserAutomationTargetLease, nowMs: number): number {
  const updatedAtMs = Date.parse(lease.updatedAt);
  return Number.isFinite(updatedAtMs) ? Math.max(0, nowMs - updatedAtMs) : Number.POSITIVE_INFINITY;
}

export function claimBrowserAutomationTarget(
  input: ClaimBrowserAutomationTargetInput,
): ClaimBrowserAutomationTargetResult {
  const home = input.home ?? homedir();
  const nowMs = input.nowMs ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_BROWSER_TARGET_LEASE_STALE_MS;
  const timestamp = new Date(nowMs).toISOString();
  return withStoreLock(home, () => {
    const store = readStore(home);
    const existing = store.leases.find((lease) => lease.targetId === input.targetId);
    if (existing && existing.ownerId !== input.ownerId && leaseAgeMs(existing, nowMs) <= staleAfterMs) {
      return { status: "in-use", lease: existing };
    }
    const lease: BrowserAutomationTargetLease = {
      targetId: input.targetId,
      ownerId: input.ownerId,
      kind: input.kind,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    store.leases = [
      ...store.leases.filter((candidate) => candidate.targetId !== input.targetId),
      lease,
    ];
    writeStore(store, home);
    return {
      status: "claimed",
      lease,
      ...(existing && existing.ownerId !== input.ownerId
        ? { replacedStaleOwner: existing.ownerId }
        : {}),
    };
  });
}

export function touchBrowserAutomationTarget(
  targetId: string,
  ownerId: string,
  home: string = homedir(),
  nowMs: number = Date.now(),
): boolean {
  return withStoreLock(home, () => {
    const store = readStore(home);
    const existing = store.leases.find((lease) => lease.targetId === targetId);
    if (!existing || existing.ownerId !== ownerId) return false;
    existing.updatedAt = new Date(nowMs).toISOString();
    writeStore(store, home);
    return true;
  });
}

export function releaseBrowserAutomationTarget(
  targetId: string,
  ownerId: string,
  home: string = homedir(),
): boolean {
  return withStoreLock(home, () => {
    const store = readStore(home);
    const existing = store.leases.find((lease) => lease.targetId === targetId);
    if (!existing || existing.ownerId !== ownerId) return false;
    store.leases = store.leases.filter((lease) => lease.targetId !== targetId);
    writeStore(store, home);
    return true;
  });
}

export function removeBrowserAutomationTarget(
  targetId: string,
  home: string = homedir(),
): boolean {
  return withStoreLock(home, () => {
    const store = readStore(home);
    const next = store.leases.filter((lease) => lease.targetId !== targetId);
    if (next.length === store.leases.length) return false;
    store.leases = next;
    writeStore(store, home);
    return true;
  });
}

export function listBrowserAutomationTargetLeases(
  home: string = homedir(),
): BrowserAutomationTargetLease[] {
  return withStoreLock(home, () => readStore(home).leases.map((lease) => ({ ...lease })));
}

export function pruneMissingBrowserAutomationTargets(
  validTargetIds: Iterable<string>,
  home: string = homedir(),
): string[] {
  const valid = new Set(validTargetIds);
  return withStoreLock(home, () => {
    const store = readStore(home);
    const removed = store.leases
      .filter((lease) => !valid.has(lease.targetId))
      .map((lease) => lease.targetId);
    if (!removed.length) return [];
    store.leases = store.leases.filter((lease) => valid.has(lease.targetId));
    writeStore(store, home);
    return removed;
  });
}

export function staleBrowserAutomationTargetLeases(
  home: string = homedir(),
  nowMs: number = Date.now(),
  staleAfterMs: number = DEFAULT_BROWSER_TARGET_LEASE_STALE_MS,
): BrowserAutomationTargetLease[] {
  return withStoreLock(home, () => readStore(home).leases
    .filter((lease) => leaseAgeMs(lease, nowMs) > staleAfterMs)
    .map((lease) => ({ ...lease })));
}

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const GOOGLE_AI_KEYCHAIN_SERVICE = "com.uniplanck.gpt-agent.google-ai";
export const GOOGLE_AI_PROVIDER = "gemini";
export const DEFAULT_GOOGLE_AI_MODEL = "gemma-4-26b-a4b-it";
export const GOOGLE_AI_KEY_SLOTS = [1, 2, 3] as const;

export type GoogleAIKeySlot = (typeof GOOGLE_AI_KEY_SLOTS)[number];
export type GoogleAIKeyState = "ready" | "cooldown" | "invalid" | "missing";

export interface BrowserPlannerConfig {
  schemaVersion: 1;
  enabled: boolean;
  provider: string;
  model: string;
  failover: "priority";
}

export interface GoogleAIKeySlotSnapshot {
  slot: GoogleAIKeySlot;
  configured: boolean;
  state: GoogleAIKeyState;
  active: boolean;
  cooldownUntil?: string;
  lastErrorCode?: string;
  lastSuccessAt?: string;
}

export interface GoogleAIKeyPoolSnapshot {
  schemaVersion: 1;
  provider: typeof GOOGLE_AI_PROVIDER;
  model: string;
  enabled: boolean;
  activeSlot?: GoogleAIKeySlot;
  slots: GoogleAIKeySlotSnapshot[];
}

interface StoredSlotStatus {
  state?: Exclude<GoogleAIKeyState, "missing">;
  cooldownUntil?: string;
  lastErrorCode?: string;
  lastSuccessAt?: string;
}

interface StoredPoolStatus {
  schemaVersion: 1;
  activeSlot?: GoogleAIKeySlot;
  slots: Partial<Record<`${GoogleAIKeySlot}`, StoredSlotStatus>>;
}

export interface GoogleAIKeyCandidate {
  slot: GoogleAIKeySlot;
  key: string;
}

export interface GoogleAIErrorClassification {
  rotate: boolean;
  state: "cooldown" | "invalid";
  code: string;
  cooldownMs: number;
}

interface KeyPoolOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => Date;
  readKeychainSecret?: (slot: GoogleAIKeySlot) => string | undefined;
}

const SHORT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const QUOTA_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const INVALID_KEY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function browserPlannerConfigPath(home: string = homedir()): string {
  return join(resolve(home), ".devspace", "browser-planner.json");
}

export function googleAIKeyPoolStatusPath(home: string = homedir()): string {
  return join(resolve(home), ".devspace", "google-ai-key-pool-status.json");
}

export function defaultBrowserPlannerConfig(): BrowserPlannerConfig {
  return {
    schemaVersion: 1,
    enabled: false,
    provider: GOOGLE_AI_PROVIDER,
    model: DEFAULT_GOOGLE_AI_MODEL,
    failover: "priority",
  };
}

export function loadBrowserPlannerConfig(home: string = homedir()): BrowserPlannerConfig {
  const fallback = defaultBrowserPlannerConfig();
  const path = browserPlannerConfigPath(home);
  if (!existsSync(path)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BrowserPlannerConfig>;
    if (raw.schemaVersion !== 1) return fallback;
    const provider = typeof raw.provider === "string" && raw.provider.trim()
      ? raw.provider.trim().toLowerCase()
      : fallback.provider;
    const model = typeof raw.model === "string" && raw.model.trim()
      ? raw.model.trim()
      : fallback.model;
    return {
      schemaVersion: 1,
      enabled: raw.enabled === true,
      provider,
      model,
      failover: "priority",
    };
  } catch {
    return fallback;
  }
}

export function writeBrowserPlannerConfig(
  config: BrowserPlannerConfig,
  home: string = homedir(),
): string {
  const path = browserPlannerConfigPath(home);
  ensurePrivateDirectory(dirname(path));
  const normalized: BrowserPlannerConfig = {
    schemaVersion: 1,
    enabled: config.enabled === true,
    provider: config.provider.trim().toLowerCase() || GOOGLE_AI_PROVIDER,
    model: config.model.trim() || DEFAULT_GOOGLE_AI_MODEL,
    failover: "priority",
  };
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export class GoogleAIKeyPool {
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly now: () => Date;
  private readonly readKeychainSecret: (slot: GoogleAIKeySlot) => string | undefined;

  constructor(options: KeyPoolOptions = {}) {
    this.env = options.env ?? process.env;
    this.home = resolve(options.home ?? homedir());
    this.now = options.now ?? (() => new Date());
    this.readKeychainSecret = options.readKeychainSecret ?? ((slot) => readGoogleAIKeychainSecret(slot));
  }

  availableCandidates(): GoogleAIKeyCandidate[] {
    const status = this.loadStatus();
    const nowMs = this.now().getTime();
    const result: GoogleAIKeyCandidate[] = [];
    for (const slot of GOOGLE_AI_KEY_SLOTS) {
      const key = this.readSecret(slot);
      if (!key) continue;
      const stored = status.slots[String(slot) as `${GoogleAIKeySlot}`];
      const cooldownMs = stored?.cooldownUntil ? Date.parse(stored.cooldownUntil) : 0;
      if (Number.isFinite(cooldownMs) && cooldownMs > nowMs) continue;
      result.push({ slot, key });
    }
    return result;
  }

  configuredSlots(): GoogleAIKeySlot[] {
    return GOOGLE_AI_KEY_SLOTS.filter((slot) => Boolean(this.readSecret(slot)));
  }

  markSuccess(slot: GoogleAIKeySlot): void {
    const status = this.loadStatus();
    status.activeSlot = slot;
    status.slots[String(slot) as `${GoogleAIKeySlot}`] = {
      state: "ready",
      lastSuccessAt: this.now().toISOString(),
    };
    this.saveStatus(status);
  }

  markFailure(slot: GoogleAIKeySlot, classification: GoogleAIErrorClassification): void {
    const status = this.loadStatus();
    if (status.activeSlot === slot) status.activeSlot = undefined;
    status.slots[String(slot) as `${GoogleAIKeySlot}`] = {
      state: classification.state,
      cooldownUntil: new Date(this.now().getTime() + classification.cooldownMs).toISOString(),
      lastErrorCode: classification.code,
    };
    this.saveStatus(status);
  }

  reset(): void {
    rmSync(googleAIKeyPoolStatusPath(this.home), { force: true });
  }

  snapshot(model: string = loadBrowserPlannerConfig(this.home).model): GoogleAIKeyPoolSnapshot {
    const config = loadBrowserPlannerConfig(this.home);
    const status = this.loadStatus();
    const nowMs = this.now().getTime();
    const slots = GOOGLE_AI_KEY_SLOTS.map((slot): GoogleAIKeySlotSnapshot => {
      const configured = Boolean(this.readSecret(slot));
      const stored = status.slots[String(slot) as `${GoogleAIKeySlot}`];
      const cooldownMs = stored?.cooldownUntil ? Date.parse(stored.cooldownUntil) : 0;
      let state: GoogleAIKeyState = configured ? (stored?.state ?? "ready") : "missing";
      if (!Number.isFinite(cooldownMs) || cooldownMs <= nowMs) {
        state = configured ? "ready" : "missing";
      }
      return {
        slot,
        configured,
        state,
        active: configured && status.activeSlot === slot,
        ...(stored?.cooldownUntil && cooldownMs > nowMs ? { cooldownUntil: stored.cooldownUntil } : {}),
        ...(stored?.lastErrorCode ? { lastErrorCode: stored.lastErrorCode } : {}),
        ...(stored?.lastSuccessAt ? { lastSuccessAt: stored.lastSuccessAt } : {}),
      };
    });
    return {
      schemaVersion: 1,
      provider: GOOGLE_AI_PROVIDER,
      model,
      enabled: config.enabled && slots.some((slot) => slot.configured),
      activeSlot: status.activeSlot,
      slots,
    };
  }

  private readSecret(slot: GoogleAIKeySlot): string | undefined {
    const envValue = this.env[`GAG_GOOGLE_AI_KEY_${slot}`]
      ?? (slot === 1 ? this.env.GOOGLE_API_KEY ?? this.env.GEMINI_API_KEY : undefined);
    const key = (envValue ?? this.readKeychainSecret(slot) ?? "").trim();
    return key || undefined;
  }

  private loadStatus(): StoredPoolStatus {
    const path = googleAIKeyPoolStatusPath(this.home);
    if (!existsSync(path)) return { schemaVersion: 1, slots: {} };
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredPoolStatus>;
      return {
        schemaVersion: 1,
        activeSlot: GOOGLE_AI_KEY_SLOTS.includes(raw.activeSlot as GoogleAIKeySlot)
          ? raw.activeSlot as GoogleAIKeySlot
          : undefined,
        slots: raw.slots && typeof raw.slots === "object" ? raw.slots : {},
      };
    } catch {
      return { schemaVersion: 1, slots: {} };
    }
  }

  private saveStatus(status: StoredPoolStatus): void {
    const path = googleAIKeyPoolStatusPath(this.home);
    ensurePrivateDirectory(dirname(path));
    writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
}

export function readGoogleAIKeychainSecret(slot: GoogleAIKeySlot): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const output = execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-w",
        "-s",
        GOOGLE_AI_KEYCHAIN_SERVICE,
        "-a",
        `slot-${slot}`,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3_000,
      },
    );
    const value = output.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function isGoogleAIProvider(provider: string | undefined): boolean {
  const normalized = (provider ?? "").trim().toLowerCase();
  return normalized === "gemini" || normalized === "google";
}

export function classifyGoogleAIPlannerError(error: unknown): GoogleAIErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const authFailure = /(?:\b401\b|\b403\b|api[ _-]?key[^\n]{0,40}(?:invalid|not valid)|permission[_ -]?denied|unauthori[sz]ed|forbidden)/u.test(normalized);
  if (authFailure) {
    return {
      rotate: true,
      state: "invalid",
      code: "auth",
      cooldownMs: INVALID_KEY_COOLDOWN_MS,
    };
  }
  const rateOrQuota = /(?:\b429\b|resource[_ -]?exhausted|quota|rate[_ -]?limit|too many requests|requests per (?:minute|day)|\brpd\b|\brpm\b|\btpm\b|credits? exhausted)/u.test(normalized);
  if (rateOrQuota) {
    const daily = /(?:per day|daily|\brpd\b|requests per day)/u.test(normalized);
    return {
      rotate: true,
      state: "cooldown",
      code: daily ? "daily-quota" : "rate-limit",
      cooldownMs: daily ? QUOTA_COOLDOWN_MS : SHORT_RATE_LIMIT_COOLDOWN_MS,
    };
  }
  return {
    rotate: false,
    state: "cooldown",
    code: "other",
    cooldownMs: 0,
  };
}

export function redactGoogleAISecrets(text: string, secrets: string[] = []): string {
  let redacted = text.replace(/AIza[0-9A-Za-z_-]{20,}/gu, "[REDACTED_GOOGLE_API_KEY]");
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[REDACTED_GOOGLE_API_KEY]");
  }
  return redacted;
}

export async function testGoogleAIKeySlot(input: {
  slot: GoogleAIKeySlot;
  model?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ slot: GoogleAIKeySlot; ok: boolean; model: string; detail: string }> {
  const pool = new GoogleAIKeyPool({ env: input.env, home: input.home });
  const candidate = pool.availableCandidates().find((item) => item.slot === input.slot);
  const model = input.model?.trim() || loadBrowserPlannerConfig(input.home).model || DEFAULT_GOOGLE_AI_MODEL;
  if (!candidate) {
    return { slot: input.slot, ok: false, model, detail: "Key is missing or in cooldown." };
  }
  const fetchFn = input.fetchImpl ?? fetch;
  try {
    const response = await fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": candidate.key,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Reply with OK only." }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 8 },
        }),
      },
    );
    if (response.ok) {
      pool.markSuccess(input.slot);
      return { slot: input.slot, ok: true, model, detail: "Google AI request succeeded." };
    }
    const body = redactGoogleAISecrets((await response.text()).slice(-2_000), [candidate.key]);
    const error = new Error(`Google AI returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
    const classification = classifyGoogleAIPlannerError(error);
    if (classification.rotate) pool.markFailure(input.slot, classification);
    return {
      slot: input.slot,
      ok: false,
      model,
      detail: redactGoogleAISecrets(error.message, [candidate.key]),
    };
  } catch (error) {
    return {
      slot: input.slot,
      ok: false,
      model,
      detail: redactGoogleAISecrets(error instanceof Error ? error.message : String(error), [candidate.key]),
    };
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

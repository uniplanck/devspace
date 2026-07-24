import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type GeminiKeySlot = 1 | 2 | 3;
export type GeminiKeySource = "web" | "system" | "none";

export interface NaoBrainGeminiClientConfig {
  primaryApiKey?: string | null;
  model: string;
  fallbackModels?: Array<string | null | undefined>;
  fallbackKeysFile: string;
}

export interface GeminiKeySettings {
  primaryConfigured: boolean;
  primaryOverrideConfigured: boolean;
  primarySource: GeminiKeySource;
  fallback2Configured: boolean;
  fallback3Configured: boolean;
  configuredCount: number;
  model: string;
  fallbackModel: string | null;
  tertiaryModel: string | null;
  models: string[];
  routingOrder: string[];
  lastModel: string | null;
  lastKeySlot: GeminiKeySlot | null;
  lastGeneratedAt: string | null;
  updatedAt: string | null;
}

export interface GeminiFallbackKeyUpdate {
  primary?: string;
  fallback2?: string;
  fallback3?: string;
  clearPrimary?: boolean;
  clearFallback2?: boolean;
  clearFallback3?: boolean;
}

export interface GeminiJsonResult {
  value: Record<string, unknown>;
  model: string;
  keySlot: GeminiKeySlot;
  generatedAt: string;
  attemptCount: number;
}

interface StoredFallbackKeys {
  primaryOverride?: string;
  fallback2?: string;
  fallback3?: string;
  updatedAt?: string;
}

interface StoredFallbackKeysInput extends StoredFallbackKeys {
  primary?: string;
  slot1?: string;
  slot2?: string;
  slot3?: string;
}

export class NaoBrainGeminiClient {
  private readonly config: NaoBrainGeminiClientConfig;
  private lastSelection: { model: string; keySlot: GeminiKeySlot; generatedAt: string } | null = null;

  constructor(config: NaoBrainGeminiClientConfig) {
    this.config = config;
  }

  async settings(): Promise<GeminiKeySettings> {
    const stored = await this.readStoredKeys();
    const keys = this.effectiveKeys(stored);
    const models = this.models();
    const primarySource: GeminiKeySource = stored.primaryOverride
      ? "web"
      : this.config.primaryApiKey
        ? "system"
        : "none";

    return {
      primaryConfigured: keys.some((candidate) => candidate.slot === 1),
      primaryOverrideConfigured: Boolean(stored.primaryOverride),
      primarySource,
      fallback2Configured: keys.some((candidate) => candidate.slot === 2),
      fallback3Configured: keys.some((candidate) => candidate.slot === 3),
      configuredCount: keys.length,
      model: models[0] || "",
      fallbackModel: models[1] || null,
      tertiaryModel: models[2] || null,
      models,
      routingOrder: models.flatMap((model) => keys.map((candidate) => `${model} / API ${candidate.slot}`)),
      lastModel: this.lastSelection?.model || null,
      lastKeySlot: this.lastSelection?.keySlot || null,
      lastGeneratedAt: this.lastSelection?.generatedAt || null,
      updatedAt: stored.updatedAt || null,
    };
  }

  async updateFallbackKeys(input: GeminiFallbackKeyUpdate): Promise<GeminiKeySettings> {
    const current = await this.readStoredKeys();
    const next: StoredFallbackKeys = { ...current };

    if (input.clearPrimary) delete next.primaryOverride;
    if (input.clearFallback2) delete next.fallback2;
    if (input.clearFallback3) delete next.fallback3;

    const primary = normalizeApiKey(input.primary);
    const fallback2 = normalizeApiKey(input.fallback2);
    const fallback3 = normalizeApiKey(input.fallback3);
    if (primary) next.primaryOverride = primary;
    if (fallback2) next.fallback2 = fallback2;
    if (fallback3) next.fallback3 = fallback3;

    const effective = this.effectiveKeys(next);
    const unique = new Set(effective.map((candidate) => candidate.key));
    if (unique.size !== effective.length) {
      throw new Error("API 1・API 2・API 3には異なるGoogle AI Studio APIキーを設定してください。");
    }

    next.updatedAt = new Date().toISOString();
    await this.writeStoredKeys(next);
    return this.settings();
  }

  async generateJson(input: {
    systemInstruction: string;
    userPayload: unknown;
    timeoutMs?: number;
    maxOutputTokens?: number;
  }): Promise<GeminiJsonResult> {
    const stored = await this.readStoredKeys();
    const keys = this.effectiveKeys(stored);
    if (keys.length === 0) throw new Error("Gemini API key is not configured.");

    const models = this.models();
    if (models.length === 0) throw new Error("Gemini model is not configured.");

    const failures: string[] = [];
    let attemptCount = 0;

    // Model quality is prioritized over key order:
    // 3.6/API1 -> 3.6/API2 -> 3.6/API3 -> 3.5/API1 -> ...
    for (const model of models) {
      for (const candidate of keys) {
        attemptCount += 1;
        let response: globalThis.Response;
        try {
          response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-goog-api-key": candidate.key,
              },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: input.systemInstruction }] },
                contents: [{ role: "user", parts: [{ text: JSON.stringify(input.userPayload) }] }],
                generationConfig: {
                  responseMimeType: "application/json",
                  maxOutputTokens: input.maxOutputTokens ?? 4_000,
                },
              }),
              signal: AbortSignal.timeout(input.timeoutMs ?? 45_000),
            },
          );
        } catch (error) {
          const message = safeError(error, "Gemini request failed");
          failures.push(`${model}/API ${candidate.slot}: ${message}`);
          if (isRetryableError(error)) continue;
          throw error;
        }

        const responseText = await response.text();
        if (!response.ok) {
          const detail = redactSensitive(responseText).slice(0, 260);
          failures.push(`${model}/API ${candidate.slot}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
          if (shouldTryNextCandidate(response.status, responseText)) continue;
          throw new Error(`Gemini API ${response.status}: ${detail}`);
        }

        let payload: {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        try {
          payload = JSON.parse(responseText) as typeof payload;
        } catch {
          failures.push(`${model}/API ${candidate.slot}: invalid response envelope`);
          continue;
        }

        const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
        if (!text) {
          failures.push(`${model}/API ${candidate.slot}: empty response`);
          continue;
        }

        const generatedAt = new Date().toISOString();
        this.lastSelection = { model, keySlot: candidate.slot, generatedAt };
        return {
          value: parseFirstJsonObject(text),
          model,
          keySlot: candidate.slot,
          generatedAt,
          attemptCount,
        };
      }
    }

    throw new Error(`Gemini models or API keys were unavailable: ${failures.join(" | ").slice(0, 1_200)}`);
  }

  private models(): string[] {
    return Array.from(new Set([
      normalizeModelId(this.config.model),
      ...(this.config.fallbackModels || []).map(normalizeModelId),
    ].filter(Boolean)));
  }

  private effectiveKeys(stored: StoredFallbackKeys): Array<{ slot: GeminiKeySlot; key: string }> {
    const values: Array<{ slot: GeminiKeySlot; key: string }> = [];
    const primary = stored.primaryOverride || normalizeApiKey(this.config.primaryApiKey);
    if (primary) values.push({ slot: 1, key: primary });
    if (stored.fallback2) values.push({ slot: 2, key: stored.fallback2 });
    if (stored.fallback3) values.push({ slot: 3, key: stored.fallback3 });
    return values;
  }

  private async readStoredKeys(): Promise<StoredFallbackKeys> {
    try {
      const raw = await readFile(this.config.fallbackKeysFile, "utf8");
      const parsed = JSON.parse(raw) as StoredFallbackKeysInput;
      return {
        primaryOverride: normalizeApiKey(parsed.primaryOverride || parsed.primary || parsed.slot1) || undefined,
        fallback2: normalizeApiKey(parsed.fallback2 || parsed.slot2) || undefined,
        fallback3: normalizeApiKey(parsed.fallback3 || parsed.slot3) || undefined,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
      };
    } catch (error) {
      if (isMissing(error)) return {};
      throw error;
    }
  }

  private async writeStoredKeys(value: StoredFallbackKeys): Promise<void> {
    await mkdir(dirname(this.config.fallbackKeysFile), { recursive: true });
    const temporaryPath = `${this.config.fallbackKeysFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.config.fallbackKeysFile);
  }
}

function shouldTryNextCandidate(status: number, body: string): boolean {
  if ([400, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504].includes(status)) return true;
  return /quota|rate.?limit|resource.?exhausted|temporar|unavailable|model.+not found|unsupported/i.test(body);
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  const message = error instanceof Error ? error.message : String(error || "");
  return /timeout|fetch failed|network|socket|quota|rate.?limit|unavailable|resource.?exhausted/i.test(message);
}

function normalizeApiKey(value: unknown): string {
  return String(value || "").replace(/[\r\n\u0000]/g, "").trim().slice(0, 512);
}

function normalizeModelId(value: unknown): string {
  return String(value || "").replace(/[\r\n\u0000]/g, "").trim().slice(0, 120);
}

function parseFirstJsonObject(value: string): Record<string, unknown> {
  const text = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Fall through to balanced extraction.
  }

  const start = text.indexOf("{");
  if (start < 0) throw new Error("Gemini returned invalid JSON.");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const parsed = JSON.parse(text.slice(start, index + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        break;
      }
    }
  }
  throw new Error("Gemini returned invalid JSON.");
}

function redactSensitive(value: string): string {
  return value
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/key[=:][^&\s\"']+/gi, "key=[redacted]");
}

function safeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || fallback);
  return redactSensitive(message).slice(0, 500);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface NaoBrainGeminiClientConfig {
  primaryApiKey?: string | null;
  model: string;
  fallbackKeysFile: string;
}

export interface GeminiKeySettings {
  primaryConfigured: boolean;
  fallback2Configured: boolean;
  fallback3Configured: boolean;
  configuredCount: number;
  model: string;
  updatedAt: string | null;
}

export interface GeminiFallbackKeyUpdate {
  fallback2?: string;
  fallback3?: string;
  clearFallback2?: boolean;
  clearFallback3?: boolean;
}

export interface GeminiJsonResult {
  value: Record<string, unknown>;
  model: string;
  keySlot: 1 | 2 | 3;
  generatedAt: string;
}

interface StoredFallbackKeys {
  fallback2?: string;
  fallback3?: string;
  updatedAt?: string;
}

export class NaoBrainGeminiClient {
  private readonly config: NaoBrainGeminiClientConfig;

  constructor(config: NaoBrainGeminiClientConfig) {
    this.config = config;
  }

  async settings(): Promise<GeminiKeySettings> {
    const stored = await this.readStoredKeys();
    const flags = [Boolean(this.config.primaryApiKey), Boolean(stored.fallback2), Boolean(stored.fallback3)];
    return {
      primaryConfigured: flags[0],
      fallback2Configured: flags[1],
      fallback3Configured: flags[2],
      configuredCount: flags.filter(Boolean).length,
      model: this.config.model,
      updatedAt: stored.updatedAt || null,
    };
  }

  async updateFallbackKeys(input: GeminiFallbackKeyUpdate): Promise<GeminiKeySettings> {
    const current = await this.readStoredKeys();
    const next: StoredFallbackKeys = { ...current };

    if (input.clearFallback2) delete next.fallback2;
    if (input.clearFallback3) delete next.fallback3;

    const fallback2 = normalizeApiKey(input.fallback2);
    const fallback3 = normalizeApiKey(input.fallback3);
    if (fallback2) next.fallback2 = fallback2;
    if (fallback3) next.fallback3 = fallback3;

    if (next.fallback2 && next.fallback3 && next.fallback2 === next.fallback3) {
      throw new Error("Fallback API keys must be different.");
    }
    if (this.config.primaryApiKey && (next.fallback2 === this.config.primaryApiKey || next.fallback3 === this.config.primaryApiKey)) {
      throw new Error("Fallback API keys must differ from the primary key.");
    }

    next.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.config.fallbackKeysFile), { recursive: true });
    await writeFile(this.config.fallbackKeysFile, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return this.settings();
  }

  async generateJson(input: {
    systemInstruction: string;
    userPayload: unknown;
    temperature?: number;
    timeoutMs?: number;
    maxOutputTokens?: number;
  }): Promise<GeminiJsonResult> {
    const keys = await this.keys();
    if (keys.length === 0) throw new Error("Gemini API key is not configured.");

    const failures: string[] = [];
    for (const candidate of keys) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.config.model)}:generateContent`,
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
                temperature: input.temperature ?? 0.2,
                responseMimeType: "application/json",
                maxOutputTokens: input.maxOutputTokens ?? 4_000,
              },
            }),
            signal: AbortSignal.timeout(input.timeoutMs ?? 45_000),
          },
        );

        const responseText = await response.text();
        if (!response.ok) {
          const detail = redactSensitive(responseText).slice(0, 260);
          failures.push(`slot ${candidate.slot}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
          if (shouldTryNextKey(response.status, responseText)) continue;
          throw new Error(`Gemini API ${response.status}: ${detail}`);
        }

        const payload = JSON.parse(responseText) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
        if (!text) throw new Error("Gemini returned an empty response.");
        return {
          value: parseFirstJsonObject(text),
          model: this.config.model,
          keySlot: candidate.slot,
          generatedAt: new Date().toISOString(),
        };
      } catch (error) {
        const message = safeError(error, "Gemini request failed");
        failures.push(`slot ${candidate.slot}: ${message}`);
        if (candidate.slot === keys[keys.length - 1]?.slot) break;
        if (!isRetryableError(error)) throw error;
      }
    }

    throw new Error(`Gemini API keys were unavailable: ${failures.join(" | ").slice(0, 700)}`);
  }

  private async keys(): Promise<Array<{ slot: 1 | 2 | 3; key: string }>> {
    const stored = await this.readStoredKeys();
    const values: Array<{ slot: 1 | 2 | 3; key: string }> = [];
    if (this.config.primaryApiKey) values.push({ slot: 1, key: this.config.primaryApiKey });
    if (stored.fallback2) values.push({ slot: 2, key: stored.fallback2 });
    if (stored.fallback3) values.push({ slot: 3, key: stored.fallback3 });
    return values;
  }

  private async readStoredKeys(): Promise<StoredFallbackKeys> {
    try {
      const raw = await readFile(this.config.fallbackKeysFile, "utf8");
      const parsed = JSON.parse(raw) as StoredFallbackKeys;
      return {
        fallback2: normalizeApiKey(parsed.fallback2) || undefined,
        fallback3: normalizeApiKey(parsed.fallback3) || undefined,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
      };
    } catch (error) {
      if (isMissing(error)) return {};
      throw error;
    }
  }
}

function shouldTryNextKey(status: number, body: string): boolean {
  if ([401, 403, 408, 409, 429, 500, 502, 503, 504].includes(status)) return true;
  return /quota|rate.?limit|resource.?exhausted|temporar|unavailable/i.test(body);
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  const message = error instanceof Error ? error.message : String(error || "");
  return /timeout|fetch failed|network|socket|quota|rate.?limit|unavailable|resource.?exhausted/i.test(message);
}

function normalizeApiKey(value: unknown): string {
  return String(value || "").replace(/[\r\n\u0000]/g, "").trim().slice(0, 512);
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

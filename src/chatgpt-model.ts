export const CHATGPT_FASTEST_MODEL = "gpt-5-5-instant";
export const CHATGPT_HIGH_MODEL = "gpt-5-6-thinking";
export const CHATGPT_MINIMUM_PREFERRED_MODEL = CHATGPT_HIGH_MODEL;
export const CHATGPT_FASTEST_URL = `https://chatgpt.com/?model=${CHATGPT_FASTEST_MODEL}`;
export const CHATGPT_MINIMUM_PREFERRED_URL = `https://chatgpt.com/?model=${CHATGPT_HIGH_MODEL}`;

export const CHATGPT_PERFORMANCE_VALUES = ["fastest", "high"] as const;
export type ChatGptPerformance = typeof CHATGPT_PERFORMANCE_VALUES[number];
export const DEFAULT_CHATGPT_PERFORMANCE: ChatGptPerformance = "high";

export interface ChatGptModelCandidate {
  label: string;
  href?: string;
  disabled?: boolean;
  domIndex?: number;
  modelSlug?: string;
  modelEvidence?: string[];
  role?: string;
  checked?: boolean;
}

export interface RankedChatGptModelCandidate extends ChatGptModelCandidate {
  score: number;
  modelSlug?: string;
}

export function parseChatGptPerformance(value: unknown): ChatGptPerformance {
  const normalized = String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase();
  if (!normalized) return DEFAULT_CHATGPT_PERFORMANCE;
  const aliases: Record<string, ChatGptPerformance> = {
    fastest: "fastest",
    fast: "fastest",
    instant: "fastest",
    "gpt-5.5-instant": "fastest",
    "gpt-5-5-instant": "fastest",
    最速: "fastest",
    high: "high",
    thinking: "high",
    "gpt-5.6-thinking": "high",
    "gpt-5-6-thinking": "high",
    高い: "high",
    // Legacy saved values are intentionally migrated to the remaining high tier.
    balanced: "high",
    balance: "high",
    medium: "high",
    中程度: "high",
    sol: "high",
    "gpt-5.6-sol": "high",
    "gpt-5-6-sol": "high",
  };
  const parsed = aliases[normalized];
  if (!parsed) {
    throw new Error(`ChatGPT performance must be one of: ${CHATGPT_PERFORMANCE_VALUES.join(", ")}.`);
  }
  return parsed;
}

export function chatGptPerformanceDisplayLabel(performance: ChatGptPerformance): string {
  return performance === "fastest" ? "最速" : "高い";
}

export function matchesChatGptPerformanceLabel(
  performance: ChatGptPerformance,
  rawLabel: string,
): boolean {
  const label = rawLabel.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  if (!label) return false;
  if (performance === "fastest") {
    return /(^|\s)(?:最速|fastest|fast|instant)(?:\s|$)/iu.test(label)
      && !/medium|balanced|中程度|high|高い|thinking|reasoning|sol/iu.test(label);
  }
  return /(^|\s)(?:高い|high|thinking|reasoning)(?:\s|$)/iu.test(label)
    && !/medium|balanced|中程度|sol/iu.test(label);
}

export function chooseChatGptPerformanceCandidate(
  performance: ChatGptPerformance,
  candidates: ChatGptModelCandidate[],
): RankedChatGptModelCandidate | undefined {
  const exact = candidates
    .filter((candidate) => !candidate.disabled)
    .filter((candidate) => matchesChatGptPerformanceLabel(performance, candidate.label))
    .map((candidate) => {
      const modelSlug = candidate.modelSlug
        ?? extractModelSlug(candidate.href)
        ?? extractModelSlug(candidate.label);
      return {
        ...candidate,
        ...(modelSlug ? { modelSlug } : {}),
        score: 1,
      };
    })
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return exact[0];
}

export function prepareChatGptTaskUrl(
  rawUrl?: string,
  performance: ChatGptPerformance = DEFAULT_CHATGPT_PERFORMANCE,
): string {
  const expectedModel = performance === "fastest" ? CHATGPT_FASTEST_MODEL : CHATGPT_HIGH_MODEL;
  const fallback = performance === "fastest" ? CHATGPT_FASTEST_URL : CHATGPT_MINIMUM_PREFERRED_URL;
  const url = new URL(rawUrl?.trim() || fallback);
  if (url.protocol !== "https:" || !isChatGptHostname(url.hostname)) {
    throw new Error("ChatGPT task URL must use https://chatgpt.com.");
  }
  url.hostname = "chatgpt.com";
  url.hash = "";

  url.searchParams.set("model", expectedModel);
  return url.toString();
}

export function prepareChatGptNavigationUrl(
  rawUrl?: string,
  performance: ChatGptPerformance = DEFAULT_CHATGPT_PERFORMANCE,
): string {
  const url = new URL(prepareChatGptTaskUrl(rawUrl, performance));
  url.searchParams.delete("model");
  return url.toString();
}

export function chooseBestDiscoveredChatGptModel(
  modelSlugs: string[],
): RankedChatGptModelCandidate | undefined {
  const candidates = modelSlugs
    .map((slug) => slug.normalize("NFKC").trim().toLocaleLowerCase())
    .filter(Boolean)
    .filter((slug) => !/mini|nano|instant|fast|auto/u.test(slug))
    .map((slug): ChatGptModelCandidate => ({
      label: slug,
      href: `https://chatgpt.com/?model=${encodeURIComponent(slug)}`,
    }));
  return chooseBestChatGptModelCandidate(candidates);
}

export function chooseBestChatGptModelCandidate(
  candidates: ChatGptModelCandidate[],
): RankedChatGptModelCandidate | undefined {
  return candidates
    .filter((candidate) => !candidate.disabled)
    .map((candidate) => {
      const modelSlug = candidate.modelSlug
        ?? extractModelSlug(candidate.href)
        ?? extractModelSlug(candidate.label);
      return {
        ...candidate,
        ...(modelSlug ? { modelSlug } : {}),
        score: scoreChatGptModel(`${candidate.label} ${modelSlug ?? ""}`),
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))[0];
}

export function scoreChatGptModel(value: string): number {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  if (!normalized.trim()) return 0;
  if (/\b(?:instant|fast|mini|nano|auto)\b|最速|高速|自動/u.test(normalized)) return 0;

  const reasoningRank = /thinking|reasoning|high|deep|思考|推論|高/u.test(normalized)
    ? 4
    : /\bpro\b|プロ/u.test(normalized)
      ? 3
      : 0;
  if (reasoningRank === 0) return 0;

  const version = extractGptVersion(normalized);
  return reasoningRank * 1_000_000_000 + version;
}

export function extractChatGptModelSlug(value?: string): string | undefined {
  return extractModelSlug(value);
}

function extractGptVersion(value: string): number {
  const match = /gpt[\s_-]*(\d+)(?:[.\s_-]+(\d+))?(?:[.\s_-]+(\d+))?/iu.exec(value);
  if (!match) return 0;
  const major = Number(match[1] ?? 0);
  const minor = Number(match[2] ?? 0);
  const patch = Number(match[3] ?? 0);
  if (![major, minor, patch].every(Number.isFinite)) return 0;
  return major * 1_000_000 + minor * 10_000 + patch * 100;
}

function extractModelSlug(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, "https://chatgpt.com/");
    const model = url.searchParams.get("model")?.trim();
    if (model) return model;
  } catch {}
  const solMatch = /\bgpt[\s._-]*\d+(?:[.\s_-]+\d+){0,2}[\s._-]+sol\b/iu.exec(value);
  if (solMatch) return solMatch[0].replace(/[\s._]+/gu, "-").toLocaleLowerCase();
  const match = /\bgpt[\s_-]*\d+(?:[.\s_-]+\d+){0,2}(?:[\s_-]+(?:thinking|reasoning|pro|high|deep|instant|fast))?\b/iu.exec(value);
  return match?.[0]?.replace(/\s+/gu, "-").toLocaleLowerCase();
}

function isChatGptHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/\.$/u, "");
  return normalized === "chatgpt.com" || normalized === "www.chatgpt.com";
}

export const CHATGPT_MINIMUM_PREFERRED_MODEL = "gpt-5-6-thinking";
export const CHATGPT_MINIMUM_PREFERRED_URL = `https://chatgpt.com/?model=${CHATGPT_MINIMUM_PREFERRED_MODEL}`;

export interface ChatGptModelCandidate {
  label: string;
  href?: string;
  disabled?: boolean;
  domIndex?: number;
}

export interface RankedChatGptModelCandidate extends ChatGptModelCandidate {
  score: number;
  modelSlug?: string;
}

export function prepareChatGptTaskUrl(rawUrl?: string): string {
  const url = new URL(rawUrl?.trim() || CHATGPT_MINIMUM_PREFERRED_URL);
  if (url.protocol !== "https:" || !isChatGptHostname(url.hostname)) {
    throw new Error("ChatGPT task URL must use https://chatgpt.com.");
  }
  url.hostname = "chatgpt.com";
  url.hash = "";

  const existingModel = url.searchParams.get("model")?.trim();
  if (!existingModel || scoreChatGptModel(existingModel) < scoreChatGptModel(CHATGPT_MINIMUM_PREFERRED_MODEL)) {
    url.searchParams.set("model", CHATGPT_MINIMUM_PREFERRED_MODEL);
  }
  return url.toString();
}

export function prepareChatGptNavigationUrl(rawUrl?: string): string {
  const url = new URL(prepareChatGptTaskUrl(rawUrl));
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
      const modelSlug = extractModelSlug(candidate.href) ?? extractModelSlug(candidate.label);
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
  const match = /\bgpt[\s_-]*\d+(?:[.\s_-]+\d+){0,2}(?:[\s_-]+(?:thinking|reasoning|pro|high|deep))?\b/iu.exec(value);
  return match?.[0]?.replace(/\s+/gu, "-").toLocaleLowerCase();
}

function isChatGptHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/\.$/u, "");
  return normalized === "chatgpt.com" || normalized === "www.chatgpt.com";
}

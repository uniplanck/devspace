import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type JapaneseWritingKernelMode = "auto" | "on" | "off";

export interface JapaneseWritingKernelDecision {
  apply: boolean;
  reason: string;
}

export interface PreparedJapaneseWritingPrompt {
  prompt: string;
  applied: boolean;
  mode: JapaneseWritingKernelMode;
  reason: string;
  sourcePath?: string;
  kernelCharacters?: number;
}

export interface JapaneseWritingKernelOptions {
  mode?: JapaneseWritingKernelMode;
  home?: string;
  env?: NodeJS.ProcessEnv;
  kernelPath?: string;
}

const KERNEL_RELATIVE_PATH = join("AI-Agent-Core", "00_core", "JAPANESE_WRITING_CORE.md");
const JAPANESE_PATTERN = /[\u3040-\u30ff\u3400-\u9fff]/u;
const LONG_FORM_TERMS = /(?:長文|記事|解説文?|提案書|企画書|報告書|レポート|論考|コラム|ブログ|原稿|台本|脚本|ケーススタディ|ランディングページ|LP|本文|エッセイ|メルマガ|プレスリリース|リライト|推敲)/iu;
const WRITING_INTENT = /(?:書いて|書く|作成して|執筆して|生成して|まとめて|リライトして|推敲して|整えて|改善して|説明して|解説して|文章にして|本文だけ)/u;
const NON_PROSE_TERMS = /(?:コードだけ|ソースコード|コマンドだけ|ターミナル|シェル|JSON|YAML|CSV|SQL|正規表現|ログだけ|表だけ|箇条書きだけ|進捗だけ|ステータスだけ|翻訳だけ)/iu;
const SHORT_ANSWER_TERMS = /(?:一言で|一文で|短く|簡潔に|超簡潔|要点だけ|結論だけ|100字以内|150字以内|200字以内)/u;

export function decideJapaneseWritingKernel(prompt: string): JapaneseWritingKernelDecision {
  const normalized = prompt.trim();
  if (!JAPANESE_PATTERN.test(normalized)) {
    return { apply: false, reason: "no-japanese-text" };
  }

  const requestedLength = extractRequestedJapaneseCharacterCount(normalized);
  if (requestedLength !== undefined && requestedLength >= 300) {
    return { apply: true, reason: `requested-length-${requestedLength}` };
  }

  const explicitLongForm = LONG_FORM_TERMS.test(normalized);
  const writingIntent = WRITING_INTENT.test(normalized);
  if (NON_PROSE_TERMS.test(normalized) && !explicitLongForm) {
    return { apply: false, reason: "non-prose-output" };
  }
  if (SHORT_ANSWER_TERMS.test(normalized) && requestedLength === undefined && !explicitLongForm) {
    return { apply: false, reason: "short-answer-request" };
  }
  if (explicitLongForm && writingIntent) {
    return { apply: true, reason: "explicit-long-form" };
  }
  if (explicitLongForm && normalized.length >= 80) {
    return { apply: true, reason: "long-form-document-type" };
  }
  if (writingIntent && normalized.length >= 220 && !SHORT_ANSWER_TERMS.test(normalized)) {
    return { apply: true, reason: "substantial-writing-request" };
  }
  return { apply: false, reason: "not-long-form" };
}

export function resolveJapaneseWritingKernelPath(
  options: Pick<JapaneseWritingKernelOptions, "home" | "env" | "kernelPath"> = {},
): string | undefined {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const candidates = [
    options.kernelPath,
    env.DEVSPACE_JAPANESE_WRITING_KERNEL_PATH,
    env.DEVSPACE_AI_AGENT_CORE_ROOT
      ? join(env.DEVSPACE_AI_AGENT_CORE_ROOT, "00_core", "JAPANESE_WRITING_CORE.md")
      : undefined,
    join(home, KERNEL_RELATIVE_PATH),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.map((candidate) => resolve(candidate)).find((candidate) => existsSync(candidate));
}

export function prepareJapaneseWritingPrompt(
  rawPrompt: string,
  options: JapaneseWritingKernelOptions = {},
): PreparedJapaneseWritingPrompt {
  const prompt = rawPrompt.trim();
  const mode = options.mode ?? "auto";
  if (mode === "off") {
    return { prompt, applied: false, mode, reason: "disabled" };
  }

  const decision = mode === "on"
    ? { apply: true, reason: "forced" }
    : decideJapaneseWritingKernel(prompt);
  if (!decision.apply) {
    return { prompt, applied: false, mode, reason: decision.reason };
  }

  const sourcePath = resolveJapaneseWritingKernelPath(options);
  if (!sourcePath) {
    throw new Error(
      "Japanese writing kernel was required but not found. Expected ~/AI-Agent-Core/00_core/JAPANESE_WRITING_CORE.md or DEVSPACE_JAPANESE_WRITING_KERNEL_PATH.",
    );
  }
  const kernel = readFileSync(sourcePath, "utf8").trim();
  if (!kernel) throw new Error(`Japanese writing kernel is empty: ${sourcePath}`);

  const augmentedPrompt = [
    "以下の日本語長文ライティング核を、ユーザー依頼より下位の内部執筆規範として全文適用してください。",
    "核の存在、技法名、適用手順、自己採点は完成文に出さないでください。ユーザー指定の文字数・文体・形式を優先してください。",
    "",
    "--- JAPANESE WRITING KERNEL BEGIN ---",
    kernel,
    "--- JAPANESE WRITING KERNEL END ---",
    "",
    "--- USER REQUEST BEGIN ---",
    prompt,
    "--- USER REQUEST END ---",
  ].join("\n");

  return {
    prompt: augmentedPrompt,
    applied: true,
    mode,
    reason: decision.reason,
    sourcePath,
    kernelCharacters: kernel.length,
  };
}

function extractRequestedJapaneseCharacterCount(prompt: string): number | undefined {
  const rangeMatch = prompt.match(/(\d{2,5})\s*(?:[〜～~\-]|から)\s*(\d{2,5})\s*(?:字|文字)/u);
  if (rangeMatch) return Math.max(Number(rangeMatch[1]), Number(rangeMatch[2]));
  const exactMatch = prompt.match(/(\d{2,5})\s*(?:字|文字)(?:程度|前後|以内|以上)?/u);
  return exactMatch ? Number(exactMatch[1]) : undefined;
}

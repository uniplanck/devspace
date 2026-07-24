import type { JobPreset } from "./job-store.js";

export const LIVE_BRIDGE_HEADER = "gag-live-bridge-v1";

export interface LiveBridgeIntent {
  transcript: string;
  preset?: JobPreset;
  title: string;
  confidence: number;
  requiresConfirmation: boolean;
  executable: boolean;
  reason: string;
}

const INTENTS: Array<{
  preset: JobPreset;
  patterns: RegExp[];
  title: string;
  requiresConfirmation: boolean;
}> = [
  {
    preset: "git-status",
    patterns: [/git\s*status/i, /変更(状況|内容|差分)/, /未コミット/, /リポジトリ.*状態/],
    title: "Git status",
    requiresConfirmation: false,
  },
  {
    preset: "runtime-smoke",
    patterns: [/runtime.*smoke/i, /稼働確認/, /動作確認/, /gag.*状態/, /ヘルスチェック/],
    title: "Runtime smoke",
    requiresConfirmation: false,
  },
  {
    preset: "typecheck",
    patterns: [/type\s*check/i, /型チェック/, /型検査/],
    title: "Typecheck",
    requiresConfirmation: false,
  },
  {
    preset: "test",
    patterns: [/テスト(して|を実行|回して)/, /npm\s+test/i, /run.*tests?/i],
    title: "Test",
    requiresConfirmation: true,
  },
  {
    preset: "build",
    patterns: [/ビルド(して|を実行|回して)/, /npm\s+run\s+build/i, /run.*build/i],
    title: "Build",
    requiresConfirmation: true,
  },
];

export function parseLiveBridgeIntent(rawTranscript: unknown): LiveBridgeIntent {
  const transcript = typeof rawTranscript === "string" ? rawTranscript.trim() : "";
  if (!transcript) {
    return {
      transcript: "",
      title: "Unknown request",
      confidence: 0,
      requiresConfirmation: false,
      executable: false,
      reason: "transcript is required",
    };
  }

  for (const intent of INTENTS) {
    if (intent.patterns.some((pattern) => pattern.test(transcript))) {
      return {
        transcript,
        preset: intent.preset,
        title: intent.title,
        confidence: 0.95,
        requiresConfirmation: intent.requiresConfirmation,
        executable: true,
        reason: `matched fixed preset: ${intent.preset}`,
      };
    }
  }

  return {
    transcript,
    title: "Unsupported request",
    confidence: 0,
    requiresConfirmation: false,
    executable: false,
    reason: "Only fixed, allowlisted GAG job presets are supported.",
  };
}

export interface ProgressEstimateSample {
  taskCategory?: string;
  runtimeLabel?: string;
  workspaceRoot?: string;
  status?: string;
  elapsedSeconds?: number;
  initialEstimateSeconds?: number;
  finalForecastTotalSeconds?: number;
  finishedAt?: string;
}

export interface ProgressEstimateCalibration {
  sampleCount: number;
  correctionFactor: number;
  medianActualToInitialRatio?: number;
  medianActualSeconds?: number;
  initialMape?: number;
  finalMape?: number;
  confidence: "none" | "low" | "medium" | "high";
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function median(values: number[], includeZero = false): number | undefined {
  const sorted = values
    .filter((value) => typeof value === "number" && Number.isFinite(value) && (includeZero ? value >= 0 : value > 0))
    .sort((left, right) => left - right);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalized(value: string | undefined): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

export function inferTaskCategory(chatLabel: string, workspaceRoot?: string): string {
  const text = normalized(`${chatLabel} ${workspaceRoot ?? ""}`);
  const rules: Array<[RegExp, string]> = [
    [/(video|動画|palmier|premiere|editorial|字幕|テロップ|カット)/u, "video-production"],
    [/(ui|ux|design|デザイン|sp版|responsive|レスポンシブ)/u, "ui-implementation"],
    [/(deploy|デプロイ|production|本番|cloudflare|worker)/u, "deployment"],
    [/(bug|fix|修正|不具合|障害|error|エラー)/u, "bug-fix"],
    [/(research|調査|分析|検証|benchmark|比較)/u, "research"],
    [/(sync|同期|drive|google drive|migration|移行)/u, "data-sync"],
    [/(agent|gag|gae|mcp|runtime|cli)/u, "agent-runtime"],
    [/(test|テスト|qa|qc)/u, "verification"],
  ];
  for (const [pattern, category] of rules) {
    if (pattern.test(text)) return category;
  }
  return "general-engineering";
}

function percentageError(forecast: number | undefined, actual: number): number | undefined {
  if (!finitePositive(forecast) || !finitePositive(actual)) return undefined;
  return Math.abs(forecast - actual) / actual;
}

export function estimateCalibration(
  samples: ProgressEstimateSample[],
  options: {
    taskCategory: string;
    workspaceRoot?: string;
    runtimeLabel?: string;
    limit?: number;
  },
): ProgressEstimateCalibration {
  const category = normalized(options.taskCategory);
  const workspace = normalized(options.workspaceRoot);
  const runtime = normalized(options.runtimeLabel);
  const completed = samples
    .filter((sample) => sample.status === "completed" && finitePositive(sample.elapsedSeconds))
    .sort((left, right) => String(right.finishedAt ?? "").localeCompare(String(left.finishedAt ?? "")));

  const exactCategory = completed.filter((sample) => normalized(sample.taskCategory) === category);
  const workspaceMatches = completed.filter((sample) => workspace && normalized(sample.workspaceRoot) === workspace);
  const runtimeMatches = completed.filter((sample) => runtime && normalized(sample.runtimeLabel) === runtime);

  const selected = (exactCategory.length >= 2
    ? exactCategory
    : workspaceMatches.length >= 2
      ? workspaceMatches
      : runtimeMatches.length >= 3
        ? runtimeMatches
        : completed)
    .slice(0, Math.max(5, options.limit ?? 40));

  const ratios = selected.flatMap((sample) => {
    if (!finitePositive(sample.initialEstimateSeconds) || !finitePositive(sample.elapsedSeconds)) return [];
    return [clamp(sample.elapsedSeconds / sample.initialEstimateSeconds, 0.25, 4)];
  });
  const ratioMedian = median(ratios);
  const sampleCount = ratios.length;
  const shrinkage = sampleCount / (sampleCount + 5);
  const correctionFactor = ratioMedian === undefined
    ? 1
    : clamp(1 + (ratioMedian - 1) * shrinkage, 0.5, 2.5);
  const actualMedian = median(selected.flatMap((sample) => finitePositive(sample.elapsedSeconds) ? [sample.elapsedSeconds] : []));
  const initialErrors = selected.flatMap((sample) => {
    const error = percentageError(sample.initialEstimateSeconds, Number(sample.elapsedSeconds));
    return error === undefined ? [] : [error];
  });
  const finalErrors = selected.flatMap((sample) => {
    const error = percentageError(sample.finalForecastTotalSeconds, Number(sample.elapsedSeconds));
    return error === undefined ? [] : [error];
  });
  const confidence = sampleCount >= 12 ? "high" : sampleCount >= 6 ? "medium" : sampleCount >= 2 ? "low" : "none";

  return {
    sampleCount,
    correctionFactor,
    medianActualToInitialRatio: ratioMedian,
    medianActualSeconds: actualMedian,
    initialMape: median(initialErrors, true),
    finalMape: median(finalErrors, true),
    confidence,
  };
}

export function applyEstimateCalibration(seconds: number | undefined, calibration: ProgressEstimateCalibration): number | undefined {
  if (!finitePositive(seconds)) return undefined;
  return Math.max(1, Math.round(seconds * calibration.correctionFactor));
}

export function estimateErrorPercent(forecastSeconds: number | undefined, actualSeconds: number): number | undefined {
  const error = percentageError(forecastSeconds, actualSeconds);
  return error === undefined ? undefined : Math.round(error * 1000) / 10;
}

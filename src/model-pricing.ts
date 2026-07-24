export const MODEL_PRICING_TABLE = {
  "gpt-5.5": {
    displayName: "GPT-5.5",
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 30,
    longInputUsdPerMillion: 10,
    longOutputUsdPerMillion: 45,
    longContextThresholdTokens: 272_000,
  },
  "gpt-5.6-sol": {
    displayName: "GPT-5.6 Sol",
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 30,
    longInputUsdPerMillion: 10,
    longOutputUsdPerMillion: 45,
    longContextThresholdTokens: 272_000,
  },
} as const;

export type RegisteredPricingModel = keyof typeof MODEL_PRICING_TABLE;

export interface ModelPricingIdentity {
  selectedModel?: string;
  selectedModelLabel?: string;
  requestedModel?: string;
}

export interface ModelPricingResolution {
  requestedModel?: string;
  selectedModel?: string;
  selectedModelLabel?: string;
  pricingModel?: RegisteredPricingModel;
  displayName: string;
  status: "registered" | "unregistered";
}

export interface ModelApiCostEstimate extends ModelPricingResolution {
  pricingLabel?: string;
  inputTokens: number;
  outputTokens: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  longInputUsdPerMillion?: number;
  longOutputUsdPerMillion?: number;
  longContextThresholdTokens?: number;
  usdJpyRate: number;
  usd?: number;
  jpy?: number;
  maxUsd?: number;
  maxJpy?: number;
  note: string;
}

export function resolveModelPricing(
  modelOrIdentity: unknown | ModelPricingIdentity,
): ModelPricingResolution {
  const identity = normalizeIdentity(modelOrIdentity);
  const selectedModel = clean(identity.selectedModel);
  const selectedModelLabel = clean(identity.selectedModelLabel);
  const requestedModel = clean(identity.requestedModel);

  // An observed model ID is authoritative. If it is unknown, do not replace it
  // with a friendlier label or requested model and accidentally apply the wrong rate.
  if (selectedModel) {
    return resolveKnownModel(selectedModel, {
      selectedModel,
      selectedModelLabel,
      requestedModel,
    });
  }
  if (selectedModelLabel) {
    return resolveKnownModel(selectedModelLabel, {
      selectedModelLabel,
      requestedModel,
    });
  }
  if (requestedModel) {
    return resolveKnownModel(requestedModel, { requestedModel });
  }
  return {
    displayName: "不明なモデル",
    status: "unregistered",
  };
}

export function estimateModelApiCost(
  modelOrIdentity: unknown | ModelPricingIdentity,
  inputTokens: number,
  outputTokens: number,
  options: { usdJpyRate?: number } = {},
): ModelApiCostEstimate {
  const resolution = resolveModelPricing(modelOrIdentity);
  const normalizedInput = clampTokens(inputTokens);
  const normalizedOutput = clampTokens(outputTokens);
  const usdJpyRate = positiveNumber(
    options.usdJpyRate,
    positiveEnvNumber("DEVSPACE_USD_JPY_RATE", 160),
  );
  if (!resolution.pricingModel) {
    return {
      ...resolution,
      pricingLabel: resolution.displayName,
      inputTokens: normalizedInput,
      outputTokens: normalizedOutput,
      usdJpyRate,
      note: "API換算単価が未登録のため金額は算出していません。GPT-5.6 Solの単価は代用していません。GAG/GAE利用自体は無料です。",
    };
  }
  const pricing = MODEL_PRICING_TABLE[resolution.pricingModel];
  const usd = (normalizedInput / 1_000_000) * pricing.inputUsdPerMillion
    + (normalizedOutput / 1_000_000) * pricing.outputUsdPerMillion;
  const maxUsd = (normalizedInput / 1_000_000) * pricing.longInputUsdPerMillion
    + (normalizedOutput / 1_000_000) * pricing.longOutputUsdPerMillion;
  return {
    ...resolution,
    pricingLabel: pricing.displayName,
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    inputUsdPerMillion: pricing.inputUsdPerMillion,
    outputUsdPerMillion: pricing.outputUsdPerMillion,
    longInputUsdPerMillion: pricing.longInputUsdPerMillion,
    longOutputUsdPerMillion: pricing.longOutputUsdPerMillion,
    longContextThresholdTokens: pricing.longContextThresholdTokens,
    usdJpyRate,
    usd,
    jpy: usd * usdJpyRate,
    maxUsd,
    maxJpy: maxUsd * usdJpyRate,
    note: `${pricing.displayName} API換算の推定値です。GAG/GAE利用自体は無料で、ChatGPTの実請求額ではありません。`,
  };
}

function resolveKnownModel(
  value: string,
  identity: ModelPricingIdentity,
): ModelPricingResolution {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase().replace(/[_.\s]+/gu, "-");
  if (/^gpt-5-5(?:-|$)/u.test(normalized) || normalized === "gpt-5.5" || /(?:^|\s)5[.]5(?:\s|$)/u.test(value)) {
    return {
      ...identity,
      pricingModel: "gpt-5.5",
      displayName: MODEL_PRICING_TABLE["gpt-5.5"].displayName,
      status: "registered",
    };
  }
  if (
    /^gpt-5-6-(?:sol|thinking)(?:-|$)/u.test(normalized)
    || /gpt[\s._-]*5[\s._-]*6[\s._-]*(?:sol|thinking)/iu.test(value)
  ) {
    return {
      ...identity,
      pricingModel: "gpt-5.6-sol",
      displayName: MODEL_PRICING_TABLE["gpt-5.6-sol"].displayName,
      status: "registered",
    };
  }
  return {
    ...identity,
    displayName: value,
    status: "unregistered",
  };
}

function normalizeIdentity(modelOrIdentity: unknown | ModelPricingIdentity): ModelPricingIdentity {
  if (modelOrIdentity && typeof modelOrIdentity === "object" && !Array.isArray(modelOrIdentity)) {
    const value = modelOrIdentity as ModelPricingIdentity;
    return {
      selectedModel: clean(value.selectedModel),
      selectedModelLabel: clean(value.selectedModelLabel),
      requestedModel: clean(value.requestedModel),
    };
  }
  return { selectedModel: clean(modelOrIdentity) };
}

function clean(value: unknown): string | undefined {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  return normalized || undefined;
}

function clampTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function positiveEnvNumber(name: string, fallback: number): number {
  return positiveNumber(Number(process.env[name]), fallback);
}

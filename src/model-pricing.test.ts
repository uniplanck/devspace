import assert from "node:assert/strict";
import {
  estimateModelApiCost,
  MODEL_PRICING_TABLE,
  resolveModelPricing,
} from "./model-pricing.js";

assert.equal(resolveModelPricing("gpt-5.5").pricingModel, "gpt-5.5");
assert.equal(resolveModelPricing("gpt-5-5-instant").pricingModel, "gpt-5.5");
assert.equal(resolveModelPricing("gpt-5.6-sol").pricingModel, "gpt-5.6-sol");
assert.equal(resolveModelPricing("gpt-5-6-thinking").pricingModel, "gpt-5.6-sol");
assert.equal(
  resolveModelPricing({
    selectedModel: "future-model",
    selectedModelLabel: "GPT-5.6 Sol",
    requestedModel: "gpt-5.6-sol",
  }).status,
  "unregistered",
);
assert.equal(
  resolveModelPricing({ selectedModelLabel: "GPT-5.6 Sol" }).pricingModel,
  "gpt-5.6-sol",
);
assert.equal(resolveModelPricing("future-model").status, "unregistered");

const gpt55 = estimateModelApiCost("gpt-5-5-instant", 1_000_000, 1_000_000, { usdJpyRate: 160 });
assert.equal(gpt55.pricingModel, "gpt-5.5");
assert.equal(gpt55.usd, 35);
assert.equal(gpt55.jpy, 5_600);
assert.equal(gpt55.maxUsd, 55);
assert.equal(gpt55.maxJpy, 8_800);

const sol = estimateModelApiCost("gpt-5.6-sol", 1_000_000, 1_000_000, { usdJpyRate: 160 });
assert.equal(sol.pricingModel, "gpt-5.6-sol");
assert.equal(sol.inputUsdPerMillion, MODEL_PRICING_TABLE["gpt-5.6-sol"].inputUsdPerMillion);
assert.equal(sol.outputUsdPerMillion, MODEL_PRICING_TABLE["gpt-5.6-sol"].outputUsdPerMillion);

const unknown = estimateModelApiCost("gpt-9-ultra", 1000, 2000, { usdJpyRate: 160 });
assert.equal(unknown.status, "unregistered");
assert.equal(unknown.jpy, undefined);
assert.match(unknown.note, /単価.*未登録/u);
assert.match(unknown.note, /Solの単価は代用していません/u);

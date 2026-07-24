import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NaoBrainGeminiClient } from "./naobrain-gemini-client.js";

const root = await mkdtemp(join(tmpdir(), "naobrain-gemini-client-test-"));
const keysFile = join(root, "gemini-keys.json");
const originalFetch = globalThis.fetch;
const MODELS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];

function success(summary: string): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ summary }) }] } }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function failure(status = 429, message = "quota exhausted"): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function modelFromUrl(url: string): string {
  return decodeURIComponent(url.match(/\/models\/([^:]+):generateContent/)?.[1] || "");
}

try {
  const client = new NaoBrainGeminiClient({
    primaryApiKey: "system-key-1",
    model: MODELS[0],
    fallbackModels: MODELS.slice(1),
    fallbackKeysFile: keysFile,
  });

  let settings = await client.settings();
  assert.equal(settings.primaryConfigured, true);
  assert.equal(settings.primarySource, "system");
  assert.deepEqual(settings.models, MODELS);
  assert.deepEqual(settings.routingOrder, MODELS.map((model) => `${model} / API 1`));

  settings = await client.updateFallbackKeys({
    primary: "web-key-1",
    fallback2: "web-key-2",
    fallback3: "web-key-3",
  });
  assert.equal(settings.primarySource, "web");
  assert.equal(settings.primaryOverrideConfigured, true);
  assert.equal(settings.configuredCount, 3);
  assert.deepEqual(settings.routingOrder.slice(0, 4), [
    "gemini-3.6-flash / API 1",
    "gemini-3.6-flash / API 2",
    "gemini-3.6-flash / API 3",
    "gemini-3.5-flash / API 1",
  ]);

  const persisted = JSON.parse(await readFile(keysFile, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.primaryOverride, "web-key-1");
  assert.equal(persisted.fallback2, "web-key-2");
  assert.equal(persisted.fallback3, "web-key-3");

  await assert.rejects(
    () => client.updateFallbackKeys({ fallback3: "web-key-2" }),
    /異なるGoogle AI Studio APIキー/,
  );

  const requestBodies: Array<Record<string, unknown>> = [];
  const requestRoutes: Array<{ model: string; key: string }> = [];
  globalThis.fetch = async (input, init) => {
    const model = modelFromUrl(String(input));
    const key = String((init?.headers as Record<string, string>)?.["x-goog-api-key"] || "");
    requestRoutes.push({ model, key });
    requestBodies.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
    if (model === MODELS[0] && key === "web-key-1") return failure();
    return success("second key keeps top model");
  };

  const keyFailover = await client.generateJson({
    systemInstruction: "Return JSON.",
    userPayload: { task: "key failover" },
  });
  assert.equal(keyFailover.model, MODELS[0]);
  assert.equal(keyFailover.keySlot, 2);
  assert.equal(keyFailover.attemptCount, 2);
  assert.deepEqual(requestRoutes, [
    { model: MODELS[0], key: "web-key-1" },
    { model: MODELS[0], key: "web-key-2" },
  ]);
  const generationConfig = requestBodies[0]?.generationConfig as Record<string, unknown>;
  assert.equal(generationConfig.temperature, undefined);
  assert.equal(generationConfig.topP, undefined);
  assert.equal(generationConfig.topK, undefined);

  requestRoutes.length = 0;
  globalThis.fetch = async (input, init) => {
    const model = modelFromUrl(String(input));
    const key = String((init?.headers as Record<string, string>)?.["x-goog-api-key"] || "");
    requestRoutes.push({ model, key });
    if (model === MODELS[0]) return failure();
    return success("middle model after every top key");
  };

  const modelFailover = await client.generateJson({
    systemInstruction: "Return JSON.",
    userPayload: { task: "model failover" },
  });
  assert.equal(modelFailover.model, MODELS[1]);
  assert.equal(modelFailover.keySlot, 1);
  assert.equal(modelFailover.attemptCount, 4);
  assert.deepEqual(requestRoutes.map((request) => `${request.model}/${request.key}`), [
    `${MODELS[0]}/web-key-1`,
    `${MODELS[0]}/web-key-2`,
    `${MODELS[0]}/web-key-3`,
    `${MODELS[1]}/web-key-1`,
  ]);

  requestRoutes.length = 0;
  globalThis.fetch = async (input, init) => {
    const model = modelFromUrl(String(input));
    const key = String((init?.headers as Record<string, string>)?.["x-goog-api-key"] || "");
    requestRoutes.push({ model, key });
    if (model !== MODELS[2]) return failure();
    return success("lite final fallback");
  };

  const liteFailover = await client.generateJson({
    systemInstruction: "Return JSON.",
    userPayload: { task: "lite failover" },
  });
  assert.equal(liteFailover.model, MODELS[2]);
  assert.equal(liteFailover.keySlot, 1);
  assert.equal(liteFailover.attemptCount, 7);
  assert.equal(requestRoutes.length, 7);

  settings = await client.settings();
  assert.equal(settings.lastModel, MODELS[2]);
  assert.equal(settings.lastKeySlot, 1);
  assert.ok(settings.lastGeneratedAt);

  settings = await client.updateFallbackKeys({ clearPrimary: true });
  assert.equal(settings.primarySource, "system");
  assert.equal(settings.primaryOverrideConfigured, false);

  const legacyKeysFile = join(root, "legacy-keys.json");
  await writeFile(legacyKeysFile, JSON.stringify({
    fallback2: "legacy-key-2",
    fallback3: "legacy-key-3",
  }));
  const legacyClient = new NaoBrainGeminiClient({
    primaryApiKey: "legacy-system-key-1",
    model: MODELS[0],
    fallbackModels: MODELS.slice(1),
    fallbackKeysFile: legacyKeysFile,
  });
  const legacySettings = await legacyClient.settings();
  assert.equal(legacySettings.configuredCount, 3);
  assert.equal(legacySettings.fallback2Configured, true);
  assert.equal(legacySettings.fallback3Configured, true);

  console.log("naobrain-gemini-client.test: ok");
} finally {
  globalThis.fetch = originalFetch;
}

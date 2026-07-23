import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NaoBrainGeminiClient } from "./naobrain-gemini-client.js";

const root = await mkdtemp(join(tmpdir(), "naobrain-gemini-client-test-"));
const fallbackKeysFile = join(root, "gemini-fallback-keys.json");
const originalFetch = globalThis.fetch;

try {
  const primaryRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    primaryRequests.push({ url, body });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"summary":"primary"}' }] } }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const primaryClient = new NaoBrainGeminiClient({
    primaryApiKey: "test-primary-key",
    model: "gemini-3.6-flash",
    fallbackModel: "gemini-3.5-flash-lite",
    fallbackKeysFile,
  });
  const primaryResult = await primaryClient.generateJson({
    systemInstruction: "Return JSON.",
    userPayload: { task: "primary" },
  });
  assert.equal(primaryResult.model, "gemini-3.6-flash");
  assert.equal(primaryResult.value.summary, "primary");
  assert.equal(primaryRequests.length, 1);
  assert.match(primaryRequests[0]?.url || "", /gemini-3\.6-flash/);
  const primaryGenerationConfig = primaryRequests[0]?.body.generationConfig as Record<string, unknown>;
  assert.equal(primaryGenerationConfig.temperature, undefined);
  assert.equal(primaryGenerationConfig.topP, undefined);
  assert.equal(primaryGenerationConfig.topK, undefined);

  const fallbackRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    fallbackRequests.push({ url, body });
    if (url.includes("gemini-3.6-flash")) {
      return new Response(JSON.stringify({ error: { message: "model unavailable" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"summary":"fallback"}' }] } }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const fallbackClient = new NaoBrainGeminiClient({
    primaryApiKey: "test-primary-key",
    model: "gemini-3.6-flash",
    fallbackModel: "gemini-3.5-flash-lite",
    fallbackKeysFile,
  });
  const fallbackResult = await fallbackClient.generateJson({
    systemInstruction: "Return JSON.",
    userPayload: { task: "fallback" },
  });
  assert.equal(fallbackResult.model, "gemini-3.5-flash-lite");
  assert.equal(fallbackResult.value.summary, "fallback");
  assert.equal(fallbackRequests.length, 2);
  assert.match(fallbackRequests[0]?.url || "", /gemini-3\.6-flash/);
  assert.match(fallbackRequests[1]?.url || "", /gemini-3\.5-flash-lite/);
  for (const request of fallbackRequests) {
    const generationConfig = request.body.generationConfig as Record<string, unknown>;
    assert.equal(generationConfig.temperature, undefined);
    assert.equal(generationConfig.topP, undefined);
    assert.equal(generationConfig.topK, undefined);
  }

  const settings = await fallbackClient.settings();
  assert.equal(settings.model, "gemini-3.6-flash");
  assert.equal(settings.fallbackModel, "gemini-3.5-flash-lite");

  console.log("naobrain-gemini-client.test: ok");
} finally {
  globalThis.fetch = originalFetch;
}

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyGoogleAIPlannerError,
  defaultBrowserPlannerConfig,
  GoogleAIKeyPool,
  loadBrowserPlannerConfig,
  redactGoogleAISecrets,
  testGoogleAIKeySlot,
  writeBrowserPlannerConfig,
} from "./google-ai-key-pool.js";

const home = mkdtempSync(join(tmpdir(), "gag-google-ai-pool-"));
assert.equal(loadBrowserPlannerConfig(home).enabled, false);
assert.deepEqual(defaultBrowserPlannerConfig(), {
  schemaVersion: 1,
  enabled: false,
  provider: "gemini",
  model: "gemma-4-26b-a4b-it",
  failover: "priority",
});

writeBrowserPlannerConfig({
  schemaVersion: 1,
  enabled: true,
  provider: "gemini",
  model: "gemma-4-31b-it",
  failover: "priority",
}, home);
assert.deepEqual(loadBrowserPlannerConfig(home), {
  schemaVersion: 1,
  enabled: true,
  provider: "gemini",
  model: "gemma-4-31b-it",
  failover: "priority",
});

let now = new Date("2026-07-12T00:00:00.000Z");
const secrets: Record<number, string> = {
  1: "AIza_test_slot_1_abcdefghijklmnopqrstuvwxyz",
  2: "AIza_test_slot_2_abcdefghijklmnopqrstuvwxyz",
  3: "AIza_test_slot_3_abcdefghijklmnopqrstuvwxyz",
};
const pool = new GoogleAIKeyPool({
  home,
  now: () => now,
  readKeychainSecret: (slot) => secrets[slot],
});
assert.deepEqual(pool.availableCandidates().map((item) => item.slot), [1, 2, 3]);

const quota = classifyGoogleAIPlannerError(new Error("429 RESOURCE_EXHAUSTED: requests per day quota"));
assert.equal(quota.rotate, true);
assert.equal(quota.code, "daily-quota");
pool.markFailure(1, quota);
assert.deepEqual(pool.availableCandidates().map((item) => item.slot), [2, 3]);
assert.equal(pool.snapshot().slots[0]?.state, "cooldown");

pool.markSuccess(2);
assert.equal(pool.snapshot().activeSlot, 2);
assert.equal(pool.snapshot().slots[1]?.state, "ready");

now = new Date("2026-07-13T00:01:00.000Z");
assert.deepEqual(pool.availableCandidates().map((item) => item.slot), [1, 2, 3]);
assert.equal(pool.snapshot().slots[0]?.state, "ready");

const auth = classifyGoogleAIPlannerError(new Error("HTTP 403 API key not valid"));
assert.equal(auth.rotate, true);
assert.equal(auth.state, "invalid");
assert.equal(classifyGoogleAIPlannerError(new Error("HTTP 500 internal error")).rotate, false);

const rawSecret = secrets[1]!;
assert.equal(redactGoogleAISecrets(`failed ${rawSecret}`, [rawSecret]).includes(rawSecret), false);
assert.match(redactGoogleAISecrets("AIza123456789012345678901234567890"), /REDACTED/);

const testHome = mkdtempSync(join(tmpdir(), "gag-google-ai-test-"));
writeBrowserPlannerConfig({
  schemaVersion: 1,
  enabled: true,
  provider: "gemini",
  model: "gemma-4-26b-a4b-it",
  failover: "priority",
}, testHome);
const success = await testGoogleAIKeySlot({
  slot: 1,
  home: testHome,
  env: { GAG_GOOGLE_AI_KEY_1: rawSecret },
  fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }), { status: 200 }),
});
assert.equal(success.ok, true);
assert.equal(success.slot, 1);

const failure = await testGoogleAIKeySlot({
  slot: 2,
  home: testHome,
  env: { GAG_GOOGLE_AI_KEY_2: secrets[2] },
  fetchImpl: async () => new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }), { status: 429 }),
});
assert.equal(failure.ok, false);
assert.match(failure.detail, /429/);

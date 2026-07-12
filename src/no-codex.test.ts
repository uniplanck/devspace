import assert from "node:assert/strict";
import {
  assertLocalAgentProviderAllowed,
  assertNonCodexProvider,
  isCodexAllowed,
  isCodexProvider,
} from "./no-codex.js";

assert.equal(isCodexProvider("openai-codex"), true);
assert.equal(isCodexProvider("codex"), true);
assert.equal(isCodexProvider("google"), false);
assert.equal(isCodexAllowed({}), false);
assert.equal(isCodexAllowed({ GAG_ALLOW_CODEX: "1" }), true);

assert.throws(
  () => assertNonCodexProvider(undefined, "test planner", {}),
  /explicit non-Codex provider/u,
);
assert.throws(
  () => assertNonCodexProvider("openai-codex", "test planner", {}),
  /No-Codex mode/u,
);
assert.doesNotThrow(() => assertNonCodexProvider("google", "test planner", {}));
assert.doesNotThrow(() => assertNonCodexProvider("openai-codex", "test planner", { GAG_ALLOW_CODEX: "1" }));

assert.throws(
  () => assertLocalAgentProviderAllowed("codex", {}),
  /Codex local agents are disabled/u,
);
assert.doesNotThrow(() => assertLocalAgentProviderAllowed("claude", {}));
assert.doesNotThrow(() => assertLocalAgentProviderAllowed("codex", { GAG_ALLOW_CODEX: "1" }));

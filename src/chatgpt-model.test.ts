import assert from "node:assert/strict";
import {
  CHATGPT_MINIMUM_PREFERRED_MODEL,
  chooseBestChatGptModelCandidate,
  chooseBestDiscoveredChatGptModel,
  prepareChatGptNavigationUrl,
  prepareChatGptTaskUrl,
  scoreChatGptModel,
} from "./chatgpt-model.js";

assert.equal(
  prepareChatGptTaskUrl(),
  `https://chatgpt.com/?model=${CHATGPT_MINIMUM_PREFERRED_MODEL}`,
);
assert.equal(prepareChatGptNavigationUrl(), "https://chatgpt.com/");
assert.equal(
  prepareChatGptNavigationUrl("https://chatgpt.com/g/example?foo=bar&model=gpt-5-7-thinking"),
  "https://chatgpt.com/g/example?foo=bar",
);

const projectUrl = new URL(prepareChatGptTaskUrl("https://www.chatgpt.com/g/example?foo=bar&model=gpt-5-fast"));
assert.equal(projectUrl.hostname, "chatgpt.com");
assert.equal(projectUrl.pathname, "/g/example");
assert.equal(projectUrl.searchParams.get("foo"), "bar");
assert.equal(projectUrl.searchParams.get("model"), CHATGPT_MINIMUM_PREFERRED_MODEL);

const futureUrl = new URL(prepareChatGptTaskUrl("https://chatgpt.com/?model=gpt-5-7-thinking"));
assert.equal(futureUrl.searchParams.get("model"), "gpt-5-7-thinking");
assert.throws(() => prepareChatGptTaskUrl("https://example.com/"), /chatgpt\.com/);

assert.equal(scoreChatGptModel("GPT-5.6 Instant"), 0);
assert.ok(scoreChatGptModel("GPT-5.6 Thinking") > scoreChatGptModel("GPT-5.5 Thinking"));

const best = chooseBestChatGptModelCandidate([
  { label: "GPT-5.6 Instant", domIndex: 0 },
  { label: "GPT-5.6 Thinking", href: "/?model=gpt-5-6-thinking", domIndex: 1 },
  { label: "GPT-5.7 Thinking", href: "/?model=gpt-5-7-thinking", domIndex: 2 },
  { label: "GPT-5.8 Pro — Upgrade", href: "/?model=gpt-5-8-pro", disabled: true, domIndex: 3 },
]);
assert.equal(best?.modelSlug, "gpt-5-7-thinking");
assert.equal(best?.domIndex, 2);

assert.equal(
  chooseBestDiscoveredChatGptModel(["gpt-5-5", "gpt-5-5-mini", "auto"]),
  undefined,
);

const currentApiBest = chooseBestDiscoveredChatGptModel(["gpt-5-5-thinking"]);
assert.equal(currentApiBest?.modelSlug, "gpt-5-5-thinking");
assert.ok((currentApiBest?.score ?? 0) < scoreChatGptModel(CHATGPT_MINIMUM_PREFERRED_MODEL));

const futureApiBest = chooseBestDiscoveredChatGptModel([
  "gpt-5-5-thinking",
  "gpt-5-7-thinking",
]);
assert.equal(futureApiBest?.modelSlug, "gpt-5-7-thinking");
assert.ok((futureApiBest?.score ?? 0) > scoreChatGptModel(CHATGPT_MINIMUM_PREFERRED_MODEL));

import assert from "node:assert/strict";
import { platform } from "node:os";
import {
  appendUsageToContent,
  compactDuration,
  compactTokenCount,
  compactYenRange,
  editInputChars,
  estimateGpt56ApiCost,
  estimateTokensFromChars,
  getCurrentChatExecutionCostSnapshot,
  getExecutionCostSnapshot,
  recordObservedToolUsage,
  runWithUsageSession,
  textContentChars,
} from "./usage-meter.js";

assert.equal(estimateTokensFromChars(0), 0);
assert.equal(estimateTokensFromChars(5), 2);
assert.equal(compactTokenCount(999), "999");
assert.equal(compactTokenCount(1_500), "1.5k");
assert.equal(compactDuration(950), "950ms");
assert.equal(compactDuration(1_500), "1.5s");
const priced = estimateGpt56ApiCost(1_000_000, 1_000_000, { usdJpyRate: 160 });
assert.equal(priced.usd, 35);
assert.equal(priced.jpy, 5_600);
assert.equal(priced.maxUsd, 55);
assert.equal(priced.maxJpy, 8_800);
assert.equal(priced.longContextThresholdTokens, 272_000);
assert.equal(compactYenRange(priced.jpy, priced.maxJpy), "¥5,600–¥8,800");
assert.equal(editInputChars([{ oldText: "old", newText: "new" }]), 6);
assert.equal(textContentChars([{ type: "text", text: "hello" }]), 5);

const previousHistory = process.env.DEVSPACE_USAGE_HISTORY;
const previousRole = process.env.DEVSPACE_NODE_ROLE;
const previousLabel = process.env.DEVSPACE_USAGE_LABEL;
process.env.DEVSPACE_USAGE_HISTORY = platform() === "win32" ? "NUL" : "/dev/null";
delete process.env.DEVSPACE_USAGE_LABEL;
process.env.DEVSPACE_NODE_ROLE = "gag";
const usage = recordObservedToolUsage({
  tool: "read",
  usageSessionId: "chat-a",
  observedChars: 40,
  savedChars: 80,
  inputChars: 10,
  outputChars: 30,
  payloadChars: 40,
  durationMs: 125,
  error: false,
  retries: 1,
});
const content = [{ type: "text" as const, text: "result" }];

assert.equal(usage.durationMs, 125);
assert.equal(usage.inputTokens, 8);
assert.equal(usage.outputTokens, 3);
assert.equal(usage.estimatedJpyMax > usage.estimatedJpy, true);
assert.equal(usage.sessionCalls >= 1, true);
assert.deepEqual(appendUsageToContent(content, usage, "off"), content);
const compactContent = appendUsageToContent(content, usage, "compact");
const compactText = compactContent.at(-1);
assert.match(
  compactText?.type === "text" ? compactText.text : "",
  /\*\*GAG · 利用量（GPT-5\.6 API換算）\*\*/u,
);
assert.match(
  compactText?.type === "text" ? compactText.text : "",
  /\| 指標 \| 今回 \| このChat内のGAG累計 \|/u,
);
assert.match(
  compactText?.type === "text" ? compactText.text : "",
  /\| 入力推定 \| 約8 tok \|/u,
);
assert.match(
  compactText?.type === "text" ? compactText.text : "",
  /\| 出力推定 \| 約3 tok \|/u,
);
const fullContent = appendUsageToContent(content, usage, "full");
const fullText = fullContent.at(-1);
assert.match(
  fullText?.type === "text" ? fullText.text : "",
  /GAG · 利用量（GPT-5\.6 API換算）/u,
);
assert.match(
  fullText?.type === "text" ? fullText.text : "",
  /GAG · 利用量詳細/u,
);
const sameChat = recordObservedToolUsage({
  tool: "read",
  usageSessionId: "chat-a",
  observedChars: 4,
  savedChars: 0,
  inputChars: 4,
  outputChars: 4,
});
const otherChat = recordObservedToolUsage({
  tool: "read",
  usageSessionId: "chat-b",
  observedChars: 4,
  savedChars: 0,
  inputChars: 4,
  outputChars: 4,
});
assert.equal(sameChat.sessionCalls, 2);
assert.equal(otherChat.sessionCalls, 1);
const stableFirst = runWithUsageSession("mcp-chat-stable", () => recordObservedToolUsage({
  tool: "read",
  usageSessionId: "request-a",
  observedChars: 4,
  savedChars: 0,
  inputChars: 4,
  outputChars: 4,
}));
const stableSecond = runWithUsageSession("mcp-chat-stable", () => recordObservedToolUsage({
  tool: "read",
  usageSessionId: "request-b",
  observedChars: 4,
  savedChars: 0,
  inputChars: 4,
  outputChars: 4,
}));
assert.equal(stableFirst.sessionCalls, 1);
assert.equal(stableSecond.sessionCalls, 2);
const currentChatSnapshot = runWithUsageSession(
  "mcp-chat-stable",
  () => getCurrentChatExecutionCostSnapshot(),
);
assert.equal(currentChatSnapshot.calls, 2);
process.env.DEVSPACE_NODE_ROLE = "gae";
const gaeText = appendUsageToContent(content, otherChat, "compact").at(-1);
assert.match(gaeText?.type === "text" ? gaeText.text : "", /^\*\*GAE · 利用量（GPT-5\.6 API換算）\*\*/u);
process.env.DEVSPACE_USAGE_LABEL = "CUSTOM";
const customText = appendUsageToContent(content, otherChat, "compact").at(-1);
assert.match(customText?.type === "text" ? customText.text : "", /^\*\*CUSTOM · 利用量（GPT-5\.6 API換算）\*\*/u);
delete process.env.DEVSPACE_USAGE_LABEL;
const snapshot = getExecutionCostSnapshot();
assert.equal(snapshot.calls >= 1, true);
assert.equal(snapshot.byTool.read.calls >= 1, true);
assert.equal(snapshot.byTool.read.totalDurationMs >= 125, true);
assert.equal(snapshot.inputTokens > 0, true);
assert.equal(snapshot.outputTokens > 0, true);
assert.equal(snapshot.estimatedJpy > 0, true);
assert.equal(snapshot.estimatedJpyMax > snapshot.estimatedJpy, true);
assert.equal(snapshot.retries >= 1, true);

if (previousHistory === undefined) {
  delete process.env.DEVSPACE_USAGE_HISTORY;
} else {
  process.env.DEVSPACE_USAGE_HISTORY = previousHistory;
}
if (previousRole === undefined) {
  delete process.env.DEVSPACE_NODE_ROLE;
} else {
  process.env.DEVSPACE_NODE_ROLE = previousRole;
}
if (previousLabel === undefined) {
  delete process.env.DEVSPACE_USAGE_LABEL;
} else {
  process.env.DEVSPACE_USAGE_LABEL = previousLabel;
}

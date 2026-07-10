import assert from "node:assert/strict";
import { platform } from "node:os";
import {
  appendUsageToContent,
  compactTokenCount,
  editInputChars,
  estimateTokensFromChars,
  recordObservedToolUsage,
  textContentChars,
} from "./usage-meter.js";

assert.equal(estimateTokensFromChars(0), 0);
assert.equal(estimateTokensFromChars(5), 2);
assert.equal(compactTokenCount(999), "999");
assert.equal(compactTokenCount(1_500), "1.5k");
assert.equal(editInputChars([{ oldText: "old", newText: "new" }]), 6);
assert.equal(textContentChars([{ type: "text", text: "hello" }]), 5);

const previousHistory = process.env.DEVSPACE_USAGE_HISTORY;
process.env.DEVSPACE_USAGE_HISTORY = platform() === "win32" ? "NUL" : "/dev/null";
const usage = recordObservedToolUsage({
  tool: "read",
  observedChars: 40,
  savedChars: 80,
});
const content = [{ type: "text" as const, text: "result" }];

assert.deepEqual(appendUsageToContent(content, usage, "off"), content);
const compactContent = appendUsageToContent(content, usage, "compact");
const compactText = compactContent.at(-1);
assert.match(
  compactText?.type === "text" ? compactText.text : "",
  /gag token目安/,
);
const fullContent = appendUsageToContent(content, usage, "full");
const fullText = fullContent.at(-1);
assert.match(
  fullText?.type === "text" ? fullText.text : "",
  /ChatGPT本体の実使用tokenではありません/,
);

if (previousHistory === undefined) {
  delete process.env.DEVSPACE_USAGE_HISTORY;
} else {
  process.env.DEVSPACE_USAGE_HISTORY = previousHistory;
}

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideJapaneseWritingKernel,
  prepareJapaneseWritingPrompt,
  resolveJapaneseWritingKernelPath,
} from "./japanese-writing-kernel.js";

const home = mkdtempSync(join(tmpdir(), "devspace-writing-kernel-"));
const kernelPath = join(home, "AI-Agent-Core", "00_core", "JAPANESE_WRITING_CORE.md");
mkdirSync(join(home, "AI-Agent-Core", "00_core"), { recursive: true });
writeFileSync(kernelPath, "# TEST KERNEL\n一段落一論点。文書進行を実況しない。\n", "utf8");

assert.equal(resolveJapaneseWritingKernelPath({ home }), kernelPath);
assert.deepEqual(decideJapaneseWritingKernel("OKとだけ返してください。"), {
  apply: false,
  reason: "not-long-form",
});
assert.equal(
  decideJapaneseWritingKernel("日本語で500〜650字の一般向け解説文を書いてください。").apply,
  true,
);
assert.equal(
  decideJapaneseWritingKernel("このTypeScriptコードを修正して、コードだけ返してください。").apply,
  false,
);
assert.equal(
  decideJapaneseWritingKernel("記事として読みやすくリライトしてください。対象読者は一般の利用者です。").apply,
  true,
);

const automatic = prepareJapaneseWritingPrompt(
  "日本語で500〜650字の一般向け解説文を書いてください。",
  { home },
);
assert.equal(automatic.applied, true);
assert.equal(automatic.mode, "auto");
assert.equal(automatic.sourcePath, kernelPath);
assert.match(automatic.prompt, /# TEST KERNEL/u);
assert.match(automatic.prompt, /USER REQUEST BEGIN/u);
assert.match(automatic.prompt, /500〜650字/u);

const shortAnswer = prepareJapaneseWritingPrompt("OKとだけ返してください。", { home });
assert.equal(shortAnswer.applied, false);
assert.equal(shortAnswer.prompt, "OKとだけ返してください。");

const forced = prepareJapaneseWritingPrompt("短く答えてください。", { home, mode: "on" });
assert.equal(forced.applied, true);
assert.equal(forced.reason, "forced");

const disabled = prepareJapaneseWritingPrompt(
  "日本語で500字の解説文を書いてください。",
  { home, mode: "off" },
);
assert.equal(disabled.applied, false);
assert.equal(disabled.reason, "disabled");

assert.throws(
  () => prepareJapaneseWritingPrompt(
    "日本語で500字の解説文を書いてください。",
    { home: join(home, "missing") },
  ),
  /Japanese writing kernel was required but not found/u,
);

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GexLearningStore } from "./gex-learning-store.js";

const directory = await mkdtemp(join(tmpdir(), "gex-learning-store-"));
const store = new GexLearningStore(directory);

const first = await store.sync({
  loops: [{
    id: "loop-1",
    conversationKey: "chat-a",
    prompt: "最初の依頼",
    assistant: "最初の回答",
    followup: "次の修正依頼",
    capturedAt: 100,
  }],
  profile: {
    points: ["結論先で進める", "UI差分を具体的に指摘する"],
    sampleCount: 1,
    updatedAt: 200,
  },
});

assert.equal(first.added, 1);
assert.equal(first.total, 1);
assert.equal(first.profilePoints, 2);

const second = await store.sync({
  loops: [
    {
      id: "loop-1",
      conversationKey: "chat-a",
      prompt: "最初の依頼",
      assistant: "最初の回答",
      followup: "次の修正依頼",
      capturedAt: 100,
    },
    {
      id: "loop-2",
      conversationKey: "chat-b",
      prompt: "別の依頼",
      assistant: "別の回答",
      followup: "別の追記",
      capturedAt: 300,
    },
  ],
});

assert.equal(second.added, 1);
assert.equal(second.total, 2);
const document = await store.read();
assert.deepEqual(document.loops.map((loop) => loop.id), ["loop-2", "loop-1"]);
assert.deepEqual(document.profile.points, ["結論先で進める", "UI差分を具体的に指摘する"]);
assert.equal(document.profile.sampleCount, 2);

const profile = await readFile(store.profilePath, "utf8");
assert.match(profile, /保存ループ: 2/);
assert.match(profile, /結論先で進める/);

console.log("gex-learning-store tests: OK");

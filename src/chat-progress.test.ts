import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatChatProgressResult,
  listChatProgress,
  updateChatProgress,
} from "./chat-progress.js";

const previousPath = process.env.DEVSPACE_CHAT_PROGRESS_PATH;
const previousUsageLabel = process.env.DEVSPACE_USAGE_LABEL;
const stateDir = mkdtempSync(join(tmpdir(), "devspace-chat-progress-"));
process.env.DEVSPACE_CHAT_PROGRESS_PATH = join(stateDir, "chat-progress.json");
process.env.DEVSPACE_USAGE_LABEL = "GAG";

const started = updateChatProgress({
  sessionId: "session_test",
  conversationId: "11111111-2222-3333-4444-555555555555",
  conversationUrl: "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
  chatLabel: "GAG進化",
  workspaceId: "ws_test",
  workspaceRoot: "/tmp/gag",
  overallProgress: 0,
  currentProgress: 0,
  currentTask: "既存確認",
  estimateMinutes: 20,
});
assert.equal(started.id, "chat_11111111-2222-3333-4444-555555555555");
assert.equal(started.conversationId, "11111111-2222-3333-4444-555555555555");
assert.equal(started.conversationUrl, "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555");
assert.equal(started.status, "running");
assert.equal(started.estimatedTotalSeconds, 1_200);
assert.equal(started.estimateSource, "provided");
assert.equal(started.usageScope, "conversation");

const updated = updateChatProgress({
  sessionId: "session_changed_but_same_chat",
  conversationId: "11111111-2222-3333-4444-555555555555",
  chatLabel: "GAG進化",
  workspaceId: "ws_test",
  workspaceRoot: "/tmp/gag",
  overallProgress: 50,
  currentProgress: 80,
  currentTask: "実装",
  completed: "設計完了",
  next: "テスト",
});
assert.equal(updated.overallProgress, 50);
assert.equal(updated.currentProgress, 80);
assert.equal(updated.estimatedTotalSeconds, 1_200);
const formattedProgress = formatChatProgressResult(updated);
assert.match(formattedProgress, /^\*\*GAG · 実行状況\*\*/u);
assert.match(formattedProgress, /\| 状態 \| ▶️ 実行中 \|/u);
assert.match(formattedProgress, /\| 全体進捗 \| 50% \|/u);
assert.match(formattedProgress, /\| 現在の作業 \| 実装 \|/u);
assert.match(formattedProgress, /\| 次の作業 \| テスト \|/u);

const completed = updateChatProgress({
  sessionId: "session_changed_again",
  conversationId: "11111111-2222-3333-4444-555555555555",
  chatLabel: "GAG進化",
  workspaceId: "ws_test",
  workspaceRoot: "/tmp/gag",
  overallProgress: 100,
  currentProgress: 100,
  currentTask: "完了",
  status: "completed",
});
assert.equal(completed.status, "completed");
assert.equal(completed.remainingSeconds, 0);
assert.equal(completed.taskInputTokens >= 0, true);
assert.equal(completed.taskOutputTokens >= 0, true);
const completedProgress = formatChatProgressResult(completed);
assert.match(completedProgress, /最終実行情報（GPT-5\.6 API換算）/u);
assert.match(completedProgress, /\| 作業経過時間 \|/u);
assert.match(completedProgress, /\| MCP処理時間 \|/u);
assert.match(completedProgress, /\| 入力推定 \|/u);
assert.match(completedProgress, /\| 出力推定 \|/u);
assert.match(completedProgress, /GAG\/GAE利用自体の請求額やChatGPT本体の全token数ではありません/u);
assert.equal(listChatProgress().length, 1);

const parallel = updateChatProgress({
  sessionId: "parallel_session",
  conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  conversationUrl: "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  chatLabel: "GAG進化",
  workspaceId: "ws_test",
  workspaceRoot: "/tmp/gag",
  overallProgress: 30,
  currentTask: "並列レビュー",
});
assert.equal(parallel.status, "running");
assert.equal(listChatProgress().length, 2);

const fallbackStarted = updateChatProgress({
  sessionId: "changing_transport_1",
  chatLabel: "GAE fallback task",
  overallProgress: 0,
  currentTask: "開始",
  estimateMinutes: 5,
});
const fallbackUpdated = updateChatProgress({
  sessionId: "changing_transport_2",
  chatLabel: "GAE fallback task",
  overallProgress: 60,
  currentTask: "継続",
});
assert.equal(fallbackUpdated.id, fallbackStarted.id);
assert.equal(fallbackUpdated.startedAt, fallbackStarted.startedAt);
assert.equal(fallbackUpdated.usageScope, "task-fallback");
assert.match(formatChatProgressResult({ ...fallbackUpdated, status: "completed" }), /このタスク内のGAG累計/u);
assert.equal(listChatProgress().length, 3);

if (previousPath === undefined) {
  delete process.env.DEVSPACE_CHAT_PROGRESS_PATH;
} else {
  process.env.DEVSPACE_CHAT_PROGRESS_PATH = previousPath;
}
if (previousUsageLabel === undefined) {
  delete process.env.DEVSPACE_USAGE_LABEL;
} else {
  process.env.DEVSPACE_USAGE_LABEL = previousUsageLabel;
}

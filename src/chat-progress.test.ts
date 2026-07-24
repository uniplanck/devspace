import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  counterDeltaSinceBaseline,
  ensureChatProgressStarted,
  formatChatProgressResult,
  listChatProgress,
  updateChatProgress,
} from "./chat-progress.js";
import { estimateAccuracyPercent, estimateCalibration } from "./progress-estimator.js";

const previousPath = process.env.DEVSPACE_CHAT_PROGRESS_PATH;
const previousUsageLabel = process.env.DEVSPACE_USAGE_LABEL;
const previousStaleMinutes = process.env.DEVSPACE_PROGRESS_STALE_MINUTES;
const stateDir = mkdtempSync(join(tmpdir(), "devspace-chat-progress-"));
const progressFile = join(stateDir, "chat-progress.json");
process.env.DEVSPACE_CHAT_PROGRESS_PATH = progressFile;
process.env.DEVSPACE_USAGE_LABEL = "GAG";
process.env.DEVSPACE_PROGRESS_STALE_MINUTES = "15";

assert.equal(estimateAccuracyPercent(90, 100), 90);
assert.equal(estimateAccuracyPercent(200, 100), 0);
assert.equal(counterDeltaSinceBaseline(125, 100), 25);
assert.equal(counterDeltaSinceBaseline(25, 100), 25);
assert.equal(counterDeltaSinceBaseline(0, 100), 0);
assert.equal(counterDeltaSinceBaseline(25, undefined), 0);
const accuracyCalibration = estimateCalibration([
  { taskCategory: "agent-runtime", runtimeLabel: "GAG", status: "completed", elapsedSeconds: 100, initialEstimateSeconds: 90 },
  { taskCategory: "agent-runtime", runtimeLabel: "GAG", status: "completed", elapsedSeconds: 100, initialEstimateSeconds: 110 },
], { taskCategory: "agent-runtime", runtimeLabel: "GAG" });
assert.equal(accuracyCalibration.averageInitialAccuracyPercent, 90);

const started = updateChatProgress({
  sessionId: "session_test",
  conversationId: "11111111-2222-3333-4444-555555555555",
  conversationUrl: "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555",
  chatLabel: "GAG進化",
  workspaceId: "ws_test",
  workspaceRoot: "/tmp/gag",
  taskCategory: "agent-runtime",
  overallProgress: 0,
  programProgress: 76,
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
assert.match(formattedProgress, /\| 日時 \| .* JST \|/u);
assert.match(formattedProgress, /\| 今回進捗 \| 50% \|/u);
assert.match(formattedProgress, /\| 全フェーズ完成進捗 \| 76% \|/u);
assert.match(formattedProgress, /\| 初回予測 \|/u);
assert.match(formattedProgress, /\| 予測学習 \|/u);
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
  finalResult: "統合が完了しました。",
  changes: "- gagとGAEの出力契約を統一\n- 完了応答を固定化",
  verification: "- typecheck成功\n- formatter test成功",
  remaining: "なし",
});
assert.equal(completed.status, "completed");
assert.equal(completed.remainingSeconds, 0);
assert.equal(completed.taskInputTokens >= 0, true);
assert.equal(completed.taskOutputTokens >= 0, true);
const completedProgress = formatChatProgressResult(completed);
assert.match(completedProgress, /^## 完了結果\n\n統合が完了しました。/u);
assert.match(completedProgress, /## 変更\n\n- gagとGAEの出力契約を統一\n- 完了応答を固定化/u);
assert.match(completedProgress, /## 検証\n\n- typecheck成功\n- formatter test成功/u);
assert.match(completedProgress, /## 残り\n\nなし/u);
assert.match(completedProgress, /## 実行情報\n\n\*\*GAG · 最終MCP観測情報（GPT-5\.6 API換算）\*\*/u);
const finalHeadings = [
  "## 完了結果",
  "## 変更",
  "## 検証",
  "## 残り",
  "## 次に起こりそうなこと",
  "## 実行情報",
];
assert.deepEqual(
  completedProgress.split("\n").filter((line) => line.startsWith("## ")),
  finalHeadings,
);
assert.doesNotMatch(completedProgress, /\*\*GAG · 実行状況\*\*/u);
assert.match(completedProgress, /\| 日時 \| .* JST \|/u);
assert.match(completedProgress, /\| 開始 → 終了 \| .* JST → .* JST \|/u);
assert.match(completedProgress, /\| 作業経過時間 \|/u);
assert.match(completedProgress, /\| 開始時予測 \|/u);
assert.match(completedProgress, /\| 予測一致率 \|/u);
assert.match(completedProgress, /\| MCP処理時間 \|/u);
assert.match(completedProgress, /\| MCP観測入力推定 \|/u);
assert.match(completedProgress, /\| MCP観測出力推定 \|/u);
assert.match(completedProgress, /ChatGPT\/Codexの全token数ではなく、両者の利用量と直接比較できません/u);
const timedCompletedProgress = formatChatProgressResult({
  ...completed,
  startedAt: "2026-07-22T01:00:00.000Z",
  finishedAt: "2026-07-22T01:10:00.000Z",
  updatedAt: "2026-07-22T01:10:00.000Z",
  elapsedSeconds: 600,
  initialEstimateSeconds: 720,
  initialEstimateAccuracyPercent: 80,
  historyInitialAccuracyAveragePercent: 85.4,
});
assert.match(timedCompletedProgress, /\| 日時 \| 2026\/07\/22 10:10:00 JST \| — \|/u);
assert.match(timedCompletedProgress, /\| 開始 → 終了 \| 2026\/07\/22 10:00:00 JST → 2026\/07\/22 10:10:00 JST \| — \|/u);
assert.match(timedCompletedProgress, /\| 作業経過時間 \| 10\.0m \| — \|/u);
assert.match(timedCompletedProgress, /\| 開始時予測 \| 12\.0m \| — \|/u);
assert.match(timedCompletedProgress, /\| 予測一致率 \| 80% \| 過去平均 85\.4% \|/u);
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

const staleStore = JSON.parse(readFileSync(progressFile, "utf8")) as {
  records: Array<{ id: string; status: string; updatedAt: string; risk?: string }>;
};
const staleRecord = staleStore.records.find((record) => record.id === parallel.id);
assert.ok(staleRecord);
staleRecord.updatedAt = new Date(Date.now() - 16 * 60_000).toISOString();
writeFileSync(progressFile, `${JSON.stringify(staleStore, null, 2)}\n`);
const autoPaused = listChatProgress().find((record) => record.id === parallel.id);
assert.equal(autoPaused?.status, "paused");
assert.equal(autoPaused?.risk, "長時間更新がないため自動一時停止");

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
const fallbackCompleted = formatChatProgressResult({ ...fallbackUpdated, status: "completed" });
assert.match(fallbackCompleted, /このタスク内のGAG累計/u);
assert.match(fallbackCompleted, /^## 完了結果/u);
assert.equal(listChatProgress().length, 3);

const nextTaskSameChat = updateChatProgress({
  sessionId: "next_task_same_chat",
  conversationId: "11111111-2222-3333-4444-555555555555",
  chatLabel: "GAG進化",
  workspaceId: "ws_test",
  workspaceRoot: "/tmp/gag",
  taskCategory: "agent-runtime",
  overallProgress: 0,
  programProgress: 77,
  currentTask: "次の作業を開始",
  estimateMinutes: 10,
});
assert.notEqual(nextTaskSameChat.id, completed.id);
assert.equal(nextTaskSameChat.programProgress, 77);
assert.equal(listChatProgress().length, 4);

const implicitStarted = ensureChatProgressStarted({
  sessionId: "implicit_progress_session",
  chatLabel: "GPT-Agent · implicit-workspace",
  workspaceId: "ws_implicit",
  workspaceRoot: "/tmp/implicit-workspace",
  overallProgress: 0,
  currentTask: "ワークスペースを開いて作業開始",
});
const implicitCompleted = updateChatProgress({
  sessionId: "implicit_progress_session",
  chatLabel: "明示的な最終タスク名",
  workspaceId: "ws_implicit",
  workspaceRoot: "/tmp/implicit-workspace",
  overallProgress: 100,
  currentProgress: 100,
  currentTask: "完了",
  status: "completed",
  finalResult: "自動開始した記録を再利用しました。",
  changes: "なし",
  verification: "同一sessionIdで重複レコードなし",
  remaining: "なし",
});
assert.equal(implicitCompleted.id, implicitStarted.id);
assert.equal(implicitCompleted.startedAt, implicitStarted.startedAt);
assert.equal(implicitCompleted.chatLabel, "明示的な最終タスク名");
assert.equal(
  listChatProgress().filter((record) => record.sessionId === "implicit_progress_session").length,
  1,
);

const conversationA = ensureChatProgressStarted({
  sessionId: "shared_transport_session",
  conversationId: "conversation-a",
  chatLabel: "Conversation A",
  overallProgress: 0,
  currentTask: "Aを開始",
});
const conversationB = ensureChatProgressStarted({
  sessionId: "shared_transport_session",
  conversationId: "conversation-b",
  chatLabel: "Conversation B",
  overallProgress: 0,
  currentTask: "Bを開始",
});
assert.notEqual(conversationA.id, conversationB.id);

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
if (previousStaleMinutes === undefined) {
  delete process.env.DEVSPACE_PROGRESS_STALE_MINUTES;
} else {
  process.env.DEVSPACE_PROGRESS_STALE_MINUTES = previousStaleMinutes;
}

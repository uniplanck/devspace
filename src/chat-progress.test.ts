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
const stateDir = mkdtempSync(join(tmpdir(), "devspace-chat-progress-"));
process.env.DEVSPACE_CHAT_PROGRESS_PATH = join(stateDir, "chat-progress.json");

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
assert.match(formatChatProgressResult(updated), /Progress synced: 50%/u);

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

if (previousPath === undefined) {
  delete process.env.DEVSPACE_CHAT_PROGRESS_PATH;
} else {
  process.env.DEVSPACE_CHAT_PROGRESS_PATH = previousPath;
}

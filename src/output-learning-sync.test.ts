import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputLearningStore } from "./output-learning.js";

function commandExists(command: string): boolean {
  try {
    execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}

if (!commandExists("rclone")) {
  console.log("output-learning sync tests: SKIPPED (rclone unavailable)");
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "devspace-output-learning-sync-"));
const remote = join(directory, "remote");
const localGag = join(directory, "gag.json");
const localGae = join(directory, "gae.json");
const saved = {
  path: process.env.DEVSPACE_OUTPUT_LEARNING_PATH,
  enabled: process.env.DEVSPACE_OUTPUT_LEARNING_SYNC_ENABLED,
  remote: process.env.DEVSPACE_OUTPUT_LEARNING_SYNC_REMOTE,
  timeout: process.env.DEVSPACE_OUTPUT_LEARNING_SYNC_TIMEOUT_MS,
  runtime: process.env.DEVSPACE_PROGRESS_RUNTIME_ID,
  label: process.env.DEVSPACE_USAGE_LABEL,
};

delete process.env.DEVSPACE_OUTPUT_LEARNING_PATH;
process.env.DEVSPACE_OUTPUT_LEARNING_SYNC_ENABLED = "true";
process.env.DEVSPACE_OUTPUT_LEARNING_SYNC_REMOTE = remote;
process.env.DEVSPACE_OUTPUT_LEARNING_SYNC_TIMEOUT_MS = "3000";

try {
  process.env.DEVSPACE_PROGRESS_RUNTIME_ID = "gag-sync-test";
  process.env.DEVSPACE_USAGE_LABEL = "GAG";
  const gag = new OutputLearningStore(localGag);
  const finalizeStarted = performance.now();
  const finalized = gag.finalize({
    conversationId: "shared-chat",
    taskCategory: "cross-runtime-test",
    outputSummary: "GAGで完了した出力をGAE側の次入力へ引き継ぐ。",
    predictions: ["verify-completion", "refine-output", "continue-execution"],
    qualityScore: 100,
    completedAt: 1_000,
  });
  assert.ok(performance.now() - finalizeStarted < 250, "finalize must not wait for shared sync");
  assert.equal(finalized.syncStatus, "syncing");
  await waitFor(() => existsSync(join(remote, "gag-sync-test.json")));

  process.env.DEVSPACE_PROGRESS_RUNTIME_ID = "gae-sync-test";
  process.env.DEVSPACE_USAGE_LABEL = "GAE";
  const gae = new OutputLearningStore(localGae);
  await gae.refreshSharedSnapshot(true);
  const beginStarted = performance.now();
  const paired = gae.begin({
    conversationId: "shared-chat",
    userRequest: "終わり？検証結果も見せて",
    taskCategory: "cross-runtime-test",
    capturedAt: 2_000,
  });
  assert.ok(performance.now() - beginStarted < 250, "begin must not wait for shared sync");
  assert.equal(paired.pairedLoop?.outputId, finalized.pending.id);
  assert.equal(paired.pairedLoop?.reaction, "verification");
  await waitFor(() => existsSync(join(remote, "gae-sync-test.json")));

  process.env.DEVSPACE_PROGRESS_RUNTIME_ID = "gag-sync-test";
  process.env.DEVSPACE_USAGE_LABEL = "GAG";
  await gag.refreshSharedSnapshot(true);
  const duplicate = gag.begin({
    conversationId: "shared-chat",
    userRequest: "もう一度同じ出力を学習しないで",
    taskCategory: "cross-runtime-test",
    capturedAt: 3_000,
  });
  assert.equal(duplicate.pairedLoop, undefined, "remote tombstone must prevent duplicate pairing");

  console.log("output-learning sync tests: OK");
} finally {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("DEVSPACE_OUTPUT_LEARNING_PATH", saved.path);
  restore("DEVSPACE_OUTPUT_LEARNING_SYNC_ENABLED", saved.enabled);
  restore("DEVSPACE_OUTPUT_LEARNING_SYNC_REMOTE", saved.remote);
  restore("DEVSPACE_OUTPUT_LEARNING_SYNC_TIMEOUT_MS", saved.timeout);
  restore("DEVSPACE_PROGRESS_RUNTIME_ID", saved.runtime);
  restore("DEVSPACE_USAGE_LABEL", saved.label);
  rmSync(directory, { recursive: true, force: true });
}

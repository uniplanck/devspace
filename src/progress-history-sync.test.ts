import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishSharedProgressHistoryAsync,
  pullSharedProgressHistoryAsync,
} from "./progress-history-sync.js";

function commandExists(command: string): boolean {
  try {
    execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!commandExists("rclone")) {
  console.log("progress-history async sync tests: SKIPPED (rclone unavailable)");
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "devspace-progress-async-sync-"));
const remote = join(directory, "remote");
const saved = {
  enabled: process.env.DEVSPACE_PROGRESS_SYNC_ENABLED,
  remote: process.env.DEVSPACE_PROGRESS_SYNC_REMOTE,
  timeout: process.env.DEVSPACE_PROGRESS_SYNC_TIMEOUT_MS,
  runtime: process.env.DEVSPACE_PROGRESS_RUNTIME_ID,
  chatPath: process.env.DEVSPACE_CHAT_PROGRESS_PATH,
};

delete process.env.DEVSPACE_CHAT_PROGRESS_PATH;
process.env.DEVSPACE_PROGRESS_SYNC_ENABLED = "true";
process.env.DEVSPACE_PROGRESS_SYNC_REMOTE = remote;
process.env.DEVSPACE_PROGRESS_SYNC_TIMEOUT_MS = "3000";
process.env.DEVSPACE_PROGRESS_RUNTIME_ID = "async-sync-test";

try {
  const publishStarted = performance.now();
  const publishCompleted = new Promise<void>((resolve, reject) => {
    const scheduled = publishSharedProgressHistoryAsync(
      [{ id: "record-1", status: "completed" }],
      (result) => {
        if (!result.ok) reject(new Error(result.error || "publish failed"));
        else resolve();
      },
    );
    assert.equal(scheduled.enabled, true);
  });
  const publishReturnMs = performance.now() - publishStarted;
  assert.ok(publishReturnMs < 250, `async publish blocked for ${publishReturnMs.toFixed(1)}ms`);
  await publishCompleted;

  const pullStarted = performance.now();
  const pulled = new Promise<unknown[]>((resolve, reject) => {
    const scheduled = pullSharedProgressHistoryAsync((result) => {
      if (!result.ok) reject(new Error(result.error || "pull failed"));
      else resolve(result.records);
    });
    assert.equal(scheduled.enabled, true);
  });
  const pullReturnMs = performance.now() - pullStarted;
  assert.ok(pullReturnMs < 250, `async pull blocked for ${pullReturnMs.toFixed(1)}ms`);
  const records = await pulled;
  assert.ok(records.some((record) => (record as { id?: string }).id === "record-1"));

  console.log("progress-history async sync tests: OK");
} finally {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("DEVSPACE_PROGRESS_SYNC_ENABLED", saved.enabled);
  restore("DEVSPACE_PROGRESS_SYNC_REMOTE", saved.remote);
  restore("DEVSPACE_PROGRESS_SYNC_TIMEOUT_MS", saved.timeout);
  restore("DEVSPACE_PROGRESS_RUNTIME_ID", saved.runtime);
  restore("DEVSPACE_CHAT_PROGRESS_PATH", saved.chatPath);
  rmSync(directory, { recursive: true, force: true });
}

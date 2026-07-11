import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelJob, runJobWorker } from "./job-runner.js";
import { JobStore } from "./job-store.js";

const stateDir = await mkdtemp(join(tmpdir(), "devspace-job-runner-state-"));
const workspaceRoot = await mkdtemp(join(tmpdir(), "devspace-job-runner-workspace-"));
await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({
  name: "job-runner-fixture",
  private: true,
  scripts: {
    typecheck: "node -e \"console.log('typecheck ok')\"",
    test: "node -e \"console.log('test started'); setTimeout(() => {}, 3000)\"",
  },
}, null, 2));

const config = { stateDir };

const successStore = new JobStore(stateDir);
const successJob = successStore.create({
  workspaceRoot,
  preset: "typecheck",
  title: "Successful job",
});
successStore.close();

const succeeded = await runJobWorker(config, successJob.id, { concurrency: 2, pollIntervalMs: 20 });
assert.equal(succeeded.status, "succeeded");
assert.equal(succeeded.progress, 100);
assert.equal(succeeded.exitCode, 0);

const inspectStore = new JobStore(stateDir);
assert.ok(inspectStore.events(successJob.id).some((event) => event.message.includes("typecheck ok")));
const cancellable = inspectStore.create({
  workspaceRoot,
  preset: "test",
  title: "Cancellable job",
});
inspectStore.close();

const running = runJobWorker(config, cancellable.id, { concurrency: 2, pollIntervalMs: 20 });
await waitForStatus(stateDir, cancellable.id, "running");
const cancelling = cancelJob(config, cancellable.id);
assert.equal(cancelling.status, "cancelling");
const cancelled = await running;
assert.equal(cancelled.status, "cancelled");

async function waitForStatus(
  directory: string,
  jobId: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const store = new JobStore(directory);
    const status = store.get(jobId)?.status;
    store.close();
    if (status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${jobId} to reach ${expected}.`);
}

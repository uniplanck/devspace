import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelJob, runJobWorker } from "./job-runner.js";
import { JobStore } from "./job-store.js";
import type { BrowserTaskLoopRuntime } from "./browser-task-loop.js";
import type { BrowserApprovalRecord } from "./browser-computer.js";

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

const browserStore = new JobStore(stateDir);
const browserJob = browserStore.create({
  workspaceRoot,
  preset: "browser-loop",
  title: "Browser loop job",
  input: { goal: "Confirm the page", maxSteps: 3 },
});
browserStore.close();
const browserRuntime: BrowserTaskLoopRuntime = {
  planner: async () => ({ kind: "done", summary: "Page confirmed." }),
  driver: {
    inspect: async () => ({
      targetId: "target_test",
      url: "https://example.com",
      title: "Example",
      viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
      interactive: [],
    }),
    screenshot: async () => ({ path: "/tmp/browser-job-test.png" }),
    click: async () => ({ status: "clicked" }),
    type: async () => ({ status: "typed" }),
    key: async () => ({ status: "pressed" }),
    scroll: async () => ({ status: "scrolled" }),
    approval: () => undefined,
    wait: async () => undefined,
  },
};
const browserCompleted = await runJobWorker(config, browserJob.id, {
  concurrency: 2,
  pollIntervalMs: 20,
  browserLoopRuntime: browserRuntime,
});
assert.equal(browserCompleted.status, "succeeded");
assert.equal(browserCompleted.currentStep, "Completed");
assert.equal((browserCompleted.state?.steps as unknown[])?.length, 1);

const approval: BrowserApprovalRecord = {
  id: "approval_job_test",
  status: "pending",
  category: "submit",
  reason: "Submit confirmation required.",
  action: { kind: "click", targetId: "target_test", x: 10, y: 10 },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const waitingStore = new JobStore(stateDir);
const waitingJob = waitingStore.create({
  workspaceRoot,
  preset: "browser-loop",
  title: "Waiting browser loop job",
  input: { goal: "Submit safely", maxSteps: 3 },
});
waitingStore.close();
const waitingRuntime: BrowserTaskLoopRuntime = {
  planner: async () => ({ kind: "click", elementIndex: 0 }),
  driver: {
    ...browserRuntime.driver,
    inspect: async () => ({
      targetId: "target_test",
      url: "https://example.com",
      title: "Example",
      viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
      interactive: [{
        index: 0,
        tag: "button",
        type: "submit",
        role: "button",
        text: "Submit",
        ariaLabel: "Submit",
        name: "",
        href: "",
        download: false,
        x: 0,
        y: 0,
        width: 20,
        height: 20,
      }],
    }),
    click: async () => ({ status: "approval-required", approval }),
    approval: () => approval,
  },
};
const browserWaiting = await runJobWorker(config, waitingJob.id, {
  concurrency: 2,
  pollIntervalMs: 20,
  browserLoopRuntime: waitingRuntime,
});
assert.equal(browserWaiting.status, "waiting_approval");
assert.equal(browserWaiting.state?.pendingApprovalId, approval.id);

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

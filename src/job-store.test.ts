import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "./job-store.js";

const stateDir = await mkdtemp(join(tmpdir(), "devspace-job-store-"));
const store = new JobStore(stateDir);

try {
  const created = store.create({
    workspaceId: "ws_test",
    workspaceRoot: stateDir,
    preset: "typecheck",
    title: "Store test",
    input: { goal: "Persist this input" },
  });
  assert.match(created.id, /^job_[a-z0-9]+$/u);
  assert.equal(created.status, "queued");
  assert.deepEqual(created.input, { goal: "Persist this input" });
  assert.equal(store.activeCount(stateDir), 1);
  assert.equal(store.get(created.id.slice(0, 8))?.id, created.id);

  const event = store.appendEvent(created.id, "stdout", "hello from worker");
  assert.equal(event.level, "stdout");
  assert.equal(store.events(created.id).at(-1)?.message, "hello from worker");

  store.update(created.id, {
    status: "running",
    progress: 45,
    currentStep: "Testing",
    workerPid: 987_654,
    state: { schemaVersion: 1, steps: [{ step: 1 }] },
  });
  assert.equal(store.runningCount(stateDir), 1);
  assert.deepEqual(store.get(created.id)?.state, { schemaVersion: 1, steps: [{ step: 1 }] });

  const recovered = store.recoverStaleJobs(() => false);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, "interrupted");
  assert.equal(store.activeCount(stateDir), 0);
  assert.equal(store.get(created.id)?.currentStep, "Interrupted after process exit");

  const waiting = store.create({
    workspaceRoot: stateDir,
    preset: "browser-loop",
    input: { goal: "Wait safely" },
  });
  store.update(waiting.id, { status: "waiting_approval", currentStep: "Waiting" });
  assert.equal(store.activeCount(stateDir), 1);
} finally {
  store.close();
}

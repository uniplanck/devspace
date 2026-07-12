import assert from "node:assert/strict";
import {
  createHermesBrowserTaskPlanner,
  parseBrowserTaskAction,
  runBrowserTaskLoop,
  type BrowserTaskAction,
  type BrowserTaskDriver,
  type BrowserTaskPlanner,
} from "./browser-task-loop.js";
import type { BrowserApprovalRecord, BrowserInspectionResult } from "./browser-computer.js";

const inspection: BrowserInspectionResult = {
  targetId: "target_test",
  url: "https://example.com/task",
  title: "Task page",
  viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
  interactive: [{
    index: 0,
    tag: "button",
    type: "button",
    role: "button",
    text: "Continue",
    ariaLabel: "Continue",
    name: "",
    href: "",
    download: false,
    x: 100,
    y: 200,
    width: 80,
    height: 40,
  }],
};

const actions: BrowserTaskAction[] = [
  { kind: "click", elementIndex: 0 },
  { kind: "done", summary: "Task completed." },
];
let plannerIndex = 0;
const planner: BrowserTaskPlanner = async () => actions[plannerIndex++]!;
let clickedAt: [number, number] | undefined;
const driver = createDriver({
  click: async (x, y) => {
    clickedAt = [x, y];
    return { status: "clicked" as const };
  },
});
const completed = await runBrowserTaskLoop({ goal: "Complete the task", maxSteps: 4 }, { planner, driver });
assert.equal(completed.status, "succeeded");
assert.deepEqual(clickedAt, [140, 220]);
assert.equal(completed.state.steps.length, 2);
assert.equal(completed.state.completedSummary, "Task completed.");

const approval: BrowserApprovalRecord = {
  id: "approval_test",
  status: "pending",
  category: "submit",
  reason: "Submit confirmation required.",
  action: { kind: "click", targetId: "target_test", x: 140, y: 220 },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
let currentApproval = approval;
const waiting = await runBrowserTaskLoop(
  { goal: "Submit the task", maxSteps: 4 },
  {
    planner: async () => ({ kind: "click", elementIndex: 0 }),
    driver: createDriver({
      click: async () => ({ status: "approval-required" as const, approval: currentApproval }),
      approval: () => currentApproval,
    }),
  },
);
assert.equal(waiting.status, "waiting-approval");
assert.equal(waiting.state.pendingApprovalId, approval.id);

const missingApproval = await runBrowserTaskLoop(
  { goal: "Submit the task", maxSteps: 4 },
  {
    planner: async () => ({ kind: "done", summary: "Should not run." }),
    driver: createDriver({ approval: () => undefined }),
  },
  waiting.state,
);
assert.equal(missingApproval.status, "failed");
assert.match(missingApproval.error, /not found/u);

currentApproval = { ...approval, status: "executed", executedAt: new Date().toISOString() };
const resumed = await runBrowserTaskLoop(
  { goal: "Submit the task", maxSteps: 4 },
  {
    planner: async () => ({ kind: "done", summary: "Submission confirmed." }),
    driver: createDriver({ approval: () => currentApproval }),
  },
  waiting.state,
);
assert.equal(resumed.status, "succeeded");
assert.equal(resumed.state.pendingApprovalId, undefined);
assert.equal(resumed.state.steps.length, 2);

assert.deepEqual(parseBrowserTaskAction({ kind: "wait", milliseconds: 500 }), {
  kind: "wait",
  milliseconds: 500,
});
assert.throws(
  () => parseBrowserTaskAction({ kind: "click", elementIndex: -1 }),
  /elementIndex/u,
);

assert.throws(
  () => createHermesBrowserTaskPlanner({ env: {} }),
  /explicit non-Codex provider/u,
);
assert.throws(
  () => createHermesBrowserTaskPlanner({ provider: "openai-codex", env: {} }),
  /No-Codex mode/u,
);
assert.doesNotThrow(() => createHermesBrowserTaskPlanner({ provider: "google", env: {} }));
assert.throws(
  () => parseBrowserTaskAction({ kind: "key", key: "F5" }),
  /Unsupported/u,
);

function createDriver(overrides: Partial<BrowserTaskDriver> = {}): BrowserTaskDriver {
  return {
    inspect: async () => inspection,
    screenshot: async () => ({ path: "/tmp/browser-test.png" }),
    click: async () => ({ status: "clicked" }),
    type: async () => ({ status: "typed" }),
    key: async () => ({ status: "pressed" }),
    scroll: async () => ({ status: "scrolled" }),
    approval: () => undefined,
    wait: async () => undefined,
    ...overrides,
  };
}

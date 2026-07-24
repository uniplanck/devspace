import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimBrowserAutomationTarget,
  disposableUnleasedBrowserAutomationTargetIds,
  isDisposableBrowserAutomationTargetUrl,
  listBrowserAutomationTargetLeases,
  pruneMissingBrowserAutomationTargets,
  releaseBrowserAutomationTarget,
  staleBrowserAutomationTargetLeases,
  touchBrowserAutomationTarget,
} from "./browser-target-lifecycle.js";

const home = await mkdtemp(join(tmpdir(), "browser-target-lifecycle-"));
const baseTime = Date.parse("2026-07-24T12:00:00.000Z");

try {
  const first = claimBrowserAutomationTarget({
    targetId: "target-a",
    ownerId: "job-a",
    kind: "ephemeral",
    home,
    nowMs: baseTime,
    staleAfterMs: 60_000,
  });
  assert.equal(first.status, "claimed");

  const conflict = claimBrowserAutomationTarget({
    targetId: "target-a",
    ownerId: "job-b",
    kind: "ephemeral",
    home,
    nowMs: baseTime + 30_000,
    staleAfterMs: 60_000,
  });
  assert.equal(conflict.status, "in-use");
  assert.equal(conflict.lease.ownerId, "job-a");

  assert.equal(touchBrowserAutomationTarget("target-a", "job-a", home, baseTime + 45_000), true);
  assert.equal(touchBrowserAutomationTarget("target-a", "job-b", home, baseTime + 45_000), false);
  assert.equal(staleBrowserAutomationTargetLeases(home, baseTime + 90_000, 60_000).length, 0);

  const takeover = claimBrowserAutomationTarget({
    targetId: "target-a",
    ownerId: "job-b",
    kind: "ephemeral",
    home,
    nowMs: baseTime + 120_001,
    staleAfterMs: 60_000,
  });
  assert.equal(takeover.status, "claimed");
  assert.equal(takeover.replacedStaleOwner, "job-a");
  assert.equal(releaseBrowserAutomationTarget("target-a", "job-a", home), false);
  assert.equal(releaseBrowserAutomationTarget("target-a", "job-b", home), true);

  claimBrowserAutomationTarget({
    targetId: "target-b",
    ownerId: "job-c",
    kind: "preferred",
    home,
    nowMs: baseTime,
  });
  claimBrowserAutomationTarget({
    targetId: "target-c",
    ownerId: "job-d",
    kind: "ephemeral",
    home,
    nowMs: baseTime,
  });
  assert.deepEqual(pruneMissingBrowserAutomationTargets(["target-c"], home), ["target-b"]);
  assert.deepEqual(
    listBrowserAutomationTargetLeases(home).map((lease) => lease.targetId),
    ["target-c"],
  );

  assert.equal(isDisposableBrowserAutomationTargetUrl("about:blank"), true);
  assert.equal(isDisposableBrowserAutomationTargetUrl("chrome://newtab/"), true);
  assert.equal(
    isDisposableBrowserAutomationTargetUrl("https://chatgpt.com/plugins#settings/Connectors?create-connector=true"),
    true,
  );
  assert.equal(isDisposableBrowserAutomationTargetUrl("https://chatgpt.com/c/example"), false);
  assert.equal(isDisposableBrowserAutomationTargetUrl("https://docs.google.com/spreadsheets/d/example/edit"), false);
  assert.deepEqual(
    disposableUnleasedBrowserAutomationTargetIds(
      [
        { targetId: "blank-a", url: "about:blank" },
        { targetId: "plugin-a", url: "https://chatgpt.com/plugins#settings/Plugins" },
        { targetId: "sheet-a", url: "https://docs.google.com/spreadsheets/d/example/edit" },
      ],
      ["plugin-a"],
    ),
    ["blank-a"],
  );
  assert.deepEqual(
    disposableUnleasedBrowserAutomationTargetIds(
      [{ targetId: "only-blank", url: "about:blank" }],
      [],
    ),
    [],
  );

  console.log("browser-target-lifecycle.test: ok");
} finally {
  await rm(home, { recursive: true, force: true });
}

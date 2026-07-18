import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveBrowserAction,
  browserStatus,
  classifyBrowserElementRisk,
  isManagedAutomationBrowserSession,
  listBrowserApprovals,
  resolveBrowserBackgroundMode,
  resolveBrowserDownloadDirectory,
  type BrowserElementDescriptor,
  type BrowserSessionRecord,
} from "./browser-computer.js";
import { defaultComputerUsePolicy } from "./computer-use.js";

const home = await mkdtemp(join(tmpdir(), "devspace-browser-computer-"));
try {
  const status = await browserStatus(home);
  assert.equal(status.active, false);
  assert.deepEqual(status.pages, []);
  assert.deepEqual(listBrowserApprovals(home), []);

  const legacyManualSession: BrowserSessionRecord = {
    schemaVersion: 1,
    pid: 123,
    port: 456,
    browserName: "Brave Browser",
    browserExecutable: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    browserWebSocketPath: "/devtools/browser/manual",
    profileDirectory: join(home, "manual-brave-profile"),
    backgroundMode: "window",
    startedAt: new Date(0).toISOString(),
  };
  assert.equal(isManagedAutomationBrowserSession(legacyManualSession), false);
  assert.equal(resolveBrowserBackgroundMode("background-window", {}), "background-window");
  assert.equal(
    resolveBrowserBackgroundMode("background-window", { DEVSPACE_BROWSER_BACKGROUND_MODE: "headless" }),
    "headless",
  );
  assert.throws(
    () => resolveBrowserBackgroundMode("headless", { DEVSPACE_BROWSER_BACKGROUND_MODE: "invalid" }),
    /must be headless/,
  );
  assert.equal(
    isManagedAutomationBrowserSession({ ...legacyManualSession, managedBy: "gpt-agent-automation" }),
    true,
  );

  const policy = defaultComputerUsePolicy(home);
  const downloadDirectory = resolveBrowserDownloadDirectory({
    group: "images/chatgpt",
    taskId: "Tiger image job_123",
    now: new Date(2026, 6, 11, 12, 0, 0),
  }, policy);
  assert.equal(
    downloadDirectory.path,
    join(home, "Downloads", "GPT-Agent", "images", "chatgpt", "2026-07-11", "Tiger-image-job_123"),
  );
  assert.equal(
    resolveBrowserDownloadDirectory({ group: "../../unsafe", taskId: "../task" }, policy).path.startsWith(
      join(home, "Downloads", "GPT-Agent"),
    ),
    true,
  );
  const base: BrowserElementDescriptor = {
    tag: "button",
    type: "button",
    role: "button",
    text: "",
    ariaLabel: "",
    name: "",
    href: "",
    download: false,
  };

  assert.deepEqual(
    classifyBrowserElementRisk({ ...base, text: "Delete account" }, policy),
    { category: "delete", reason: "The element appears to delete or remove data." },
  );
  assert.equal(
    classifyBrowserElementRisk({ ...base, text: "Open settings" }, policy),
    undefined,
  );
  assert.equal(
    classifyBrowserElementRisk({ ...base, type: "submit", text: "Continue" }, policy)?.category,
    "submit",
  );
  assert.equal(
    classifyBrowserElementRisk({ ...base, tag: "input", type: "file" }, policy)?.category,
    "upload",
  );
  assert.equal(
    classifyBrowserElementRisk({ ...base, tag: "a", download: true }, policy)?.category,
    "download",
  );
  assert.equal(
    classifyBrowserElementRisk({ ...base, text: "Post to social media" }, policy)?.category,
    "externalCommunication",
  );
  assert.equal(
    classifyBrowserElementRisk({ ...base, text: "Buy now" }, policy)?.category,
    "purchase",
  );

  await assert.rejects(
    approveBrowserAction("approval_missing", { home, localApproval: false }),
    /local GPT-Agent Tool app/,
  );
} finally {
  await rm(home, { recursive: true, force: true });
}

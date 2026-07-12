import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveBrowserAction,
  captureBrowserScreenshot,
  clickBrowserPoint,
  inspectBrowserPage,
  listBrowserApprovals,
  openBrowserUrl,
  scrollBrowserPage,
  startBrowserSession,
  stopBrowserSession,
  typeBrowserText,
} from "./browser-computer.js";
import { defaultComputerUsePolicy } from "./computer-use.js";

const home = await mkdtemp(join(tmpdir(), "devspace-browser-integration-"));
const policyPath = join(home, ".devspace", "computer-use.json");
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html><head><title>GPT-Agent Browser Test</title></head>
<body style="font-family: sans-serif; padding: 40px; min-height: 1800px">
  <h1>Browser Computer Integration</h1>
  ${Array.from({ length: 130 }, (_, index) => `<button style="position:absolute;top:${2_000 + index * 50}px">Offscreen ${index}</button>`).join("")}
  <input id="query" name="query" type="text" aria-label="Search query" style="width: 300px; height: 36px">
  <div id="composer" contenteditable="true" aria-label="Message composer" style="width: 300px; min-height: 36px; border: 1px solid #999"></div>
  <button id="safe" type="button" onclick="document.body.dataset.safe='clicked'" style="height: 40px">Open settings</button>
  <button id="danger" type="button" onclick="document.body.dataset.deleted='yes'" style="height: 40px">Delete account</button>
</body></html>`);
});

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Local test server did not bind.");

try {
  const policy = defaultComputerUsePolicy(home);
  await mkdir(join(home, ".devspace"), { recursive: true, mode: 0o700 });
  policy.enabled = true;
  policy.browser.enabled = true;
  policy.browser.allowedDomains = ["127.0.0.1"];
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });

  const started = await startBrowserSession({ home, policyPath });
  assert.equal(started.status, "started");
  const opened = await openBrowserUrl(`http://127.0.0.1:${address.port}/`, { home, policyPath });
  assert.match(opened.title, /GPT-Agent Browser Test/);

  const inspection = await inspectBrowserPage(home);
  const input = inspection.interactive.find((item) => item.name === "query");
  const composer = inspection.interactive.find((item) => item.ariaLabel === "Message composer");
  const safe = inspection.interactive.find((item) => item.text === "Open settings");
  const danger = inspection.interactive.find((item) => item.text === "Delete account");
  assert.ok(input && composer && safe && danger);

  const inputClick = await clickBrowserPoint(
    input.x + Math.max(1, input.width / 2),
    input.y + Math.max(1, input.height / 2),
    { home, policyPath },
  );
  assert.equal(inputClick.status, "clicked");
  assert.deepEqual(await typeBrowserText("browser-smoke", home), {
    status: "typed",
    targetId: inspection.targetId,
    characters: 13,
  });

  const composerClick = await clickBrowserPoint(
    composer.x + Math.max(1, composer.width / 2),
    composer.y + Math.max(1, composer.height / 2),
    { home, policyPath },
  );
  assert.equal(composerClick.status, "clicked");
  assert.deepEqual(await typeBrowserText("prosemirror-smoke", home), {
    status: "typed",
    targetId: inspection.targetId,
    characters: 17,
  });
  const afterComposerType = await inspectBrowserPage(home);
  assert.equal(
    afterComposerType.interactive.find((item) => item.ariaLabel === "Message composer")?.text,
    "prosemirror-smoke",
  );

  const safeClick = await clickBrowserPoint(
    safe.x + Math.max(1, safe.width / 2),
    safe.y + Math.max(1, safe.height / 2),
    { home, policyPath },
  );
  assert.equal(safeClick.status, "clicked");

  const dangerClick = await clickBrowserPoint(
    danger.x + Math.max(1, danger.width / 2),
    danger.y + Math.max(1, danger.height / 2),
    { home, policyPath },
  );
  assert.equal(dangerClick.status, "approval-required");
  if (dangerClick.status !== "approval-required") throw new Error("Expected approval request.");
  assert.equal(listBrowserApprovals(home)[0]?.category, "delete");
  const approved = await approveBrowserAction(dangerClick.approval.id, { home, localApproval: true });
  assert.equal(approved.status, "executed");

  await scrollBrowserPage(0, 400, home);
  const screenshot = await captureBrowserScreenshot(home);
  assert.equal(screenshot.mimeType, "image/png");
  assert.equal(existsSync(screenshot.path), true);
  assert.ok(statSync(screenshot.path).size > 1000);
  assert.ok(screenshot.base64.length > 1000);
} finally {
  await stopBrowserSession(home).catch(() => undefined);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await rm(home, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveBrowserAction,
  browserStatus,
  classifyBrowserElementRisk,
  listBrowserApprovals,
  type BrowserElementDescriptor,
} from "./browser-computer.js";
import { defaultComputerUsePolicy } from "./computer-use.js";

const home = await mkdtemp(join(tmpdir(), "devspace-browser-computer-"));
try {
  const status = await browserStatus(home);
  assert.equal(status.active, false);
  assert.deepEqual(status.pages, []);
  assert.deepEqual(listBrowserApprovals(home), []);

  const policy = defaultComputerUsePolicy(home);
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

  await assert.rejects(
    approveBrowserAction("approval_missing", { home, localApproval: false }),
    /local GPT-Agent Tool app/,
  );
} finally {
  await rm(home, { recursive: true, force: true });
}

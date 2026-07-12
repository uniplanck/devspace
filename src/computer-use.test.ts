import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultComputerUsePolicy,
  diagnoseComputerUse,
  enableChatGptBrowserPolicy,
  initializeComputerUsePolicy,
  isAllowedBrowserHost,
  loadComputerUsePolicy,
  validateBrowserUrl,
} from "./computer-use.js";

const root = await mkdtemp(join(tmpdir(), "devspace-computer-use-"));
const policyPath = join(root, "computer-use.json");
const initialized = initializeComputerUsePolicy(policyPath, root);
assert.equal(initialized.created, true);
assert.equal(initialized.policy.enabled, false);
assert.equal(initialized.policy.confirmations.purchase, true);
assert.equal(initialized.policy.browser.downloadDirectory, join(root, "Downloads", "GPT-Agent"));

const loaded = loadComputerUsePolicy(policyPath, root);
assert.equal(loaded.valid, true);
assert.equal(loaded.exists, true);

const disabledDoctor = diagnoseComputerUse({
  policyPath,
  home: root,
  platform: "darwin",
  fileExists: (path) => path.includes("Brave Browser") || path.endsWith("screencapture") || path.endsWith("osascript"),
  packageAvailable: () => true,
});
assert.equal(disabledDoctor.browser.name, "Brave Browser");
assert.equal(disabledDoctor.browser.adapter, "native-cdp");
assert.equal(disabledDoctor.browser.nativeCdpAvailable, true);
assert.equal(disabledDoctor.browser.ready, false);
assert.match(disabledDoctor.diagnostics.join(" "), /disabled by policy/);

const chatGptEnabled = enableChatGptBrowserPolicy(policyPath, root);
assert.equal(chatGptEnabled.policy.enabled, true);
assert.equal(chatGptEnabled.policy.browser.enabled, true);
assert.deepEqual(chatGptEnabled.policy.browser.allowedDomains, ["chatgpt.com"]);
assert.equal(chatGptEnabled.policy.browser.allowDownloads, true);
assert.equal(chatGptEnabled.policy.confirmations.purchase, true);
assert.equal(chatGptEnabled.policy.confirmations.externalCommunication, true);

const enabled = defaultComputerUsePolicy(root);
enabled.enabled = true;
enabled.browser.enabled = true;
enabled.browser.allowedDomains = ["example.com"];
await writeFile(policyPath, `${JSON.stringify(enabled, null, 2)}\n`);
const readyDoctor = diagnoseComputerUse({
  policyPath,
  home: root,
  platform: "darwin",
  fileExists: (path) => path.includes("Brave Browser") || path.endsWith("screencapture") || path.endsWith("osascript"),
  packageAvailable: () => false,
});
assert.equal(readyDoctor.browser.ready, true);
assert.equal(readyDoctor.browser.playwrightAvailable, false);
assert.equal(readyDoctor.browser.downloadDirectory, join(root, "Downloads", "GPT-Agent"));
assert.deepEqual(readyDoctor.safety.credentialsStoredByGPTAgent, false);
assert.equal(isAllowedBrowserHost("example.com", ["example.com"]), true);
assert.equal(isAllowedBrowserHost("app.example.com", ["*.example.com"]), true);
assert.equal(isAllowedBrowserHost("example.com", ["*.example.com"]), false);
assert.equal(validateBrowserUrl("https://example.com/path#fragment", enabled).toString(), "https://example.com/path");
assert.throws(() => validateBrowserUrl("http://example.com", enabled), /requires HTTPS/);
assert.throws(() => validateBrowserUrl("https://outside.example", enabled), /not allowed/);
assert.throws(() => validateBrowserUrl("https://user:pass@example.com", enabled), /Credentials/);

const legacyRaw = JSON.parse(await readFile(policyPath, "utf8"));
delete legacyRaw.browser.downloadDirectory;
await writeFile(policyPath, JSON.stringify(legacyRaw));
const legacyLoaded = loadComputerUsePolicy(policyPath, root);
assert.equal(legacyLoaded.valid, true);
assert.equal(legacyLoaded.policy.browser.downloadDirectory, join(root, "Downloads", "GPT-Agent"));

const raw = JSON.parse(await readFile(policyPath, "utf8"));
raw.browser.allowedDomains = ["https://invalid.example.com/path"];
await writeFile(policyPath, JSON.stringify(raw));
const invalid = loadComputerUsePolicy(policyPath, root);
assert.equal(invalid.valid, false);

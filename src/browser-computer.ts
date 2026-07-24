import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  findAutomationBrowser,
  loadComputerUsePolicy,
  type ComputerUsePolicy,
  validateBrowserUrl,
} from "./computer-use.js";
import {
  CHATGPT_MINIMUM_PREFERRED_MODEL,
  chooseBestChatGptModelCandidate,
  chooseBestDiscoveredChatGptModel,
  chooseChatGptPerformanceCandidate,
  extractChatGptModelSlug,
  matchesChatGptPerformanceLabel,
  scoreChatGptModel,
  type ChatGptPerformance,
} from "./chatgpt-model.js";
import {
  claimBrowserAutomationTarget,
  disposableUnleasedBrowserAutomationTargetIds,
  listBrowserAutomationTargetLeases,
  pruneMissingBrowserAutomationTargets,
  removeBrowserAutomationTarget,
  staleBrowserAutomationTargetLeases,
} from "./browser-target-lifecycle.js";

export interface BrowserSessionRecord {
  schemaVersion: 1;
  managedBy?: "gpt-agent-automation";
  pid: number;
  port: number;
  browserName: string;
  browserExecutable: string;
  browserWebSocketPath: string;
  profileDirectory: string;
  backgroundMode: "headless" | "background-window" | "window";
  startedAt: string;
  targetId?: string;
}

export interface BrowserTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface BrowserElementDescriptor {
  tag: string;
  type: string;
  role: string;
  text: string;
  ariaLabel: string;
  name: string;
  href: string;
  download: boolean;
}

export type BrowserApprovalCategory =
  | "login"
  | "submit"
  | "upload"
  | "download"
  | "purchase"
  | "delete"
  | "externalCommunication";

export interface BrowserApprovalRecord {
  id: string;
  status: "pending" | "executed" | "expired" | "cancelled";
  category: BrowserApprovalCategory;
  reason: string;
  action:
    | { kind: "click"; targetId: string; x: number; y: number }
    | { kind: "key"; targetId: string; key: "Enter" };
  element?: BrowserElementDescriptor;
  createdAt: string;
  expiresAt: string;
  executedAt?: string;
}

export interface BrowserInspectionResult {
  targetId: string;
  url: string;
  title: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  interactive: Array<BrowserElementDescriptor & {
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export interface BrowserScreenshotResult {
  targetId: string;
  url: string;
  title: string;
  path: string;
  mimeType: "image/png";
  base64: string;
}

export interface ChatGptConversationSnapshot {
  targetId: string;
  url: string;
  title: string;
  assistantCount: number;
  userCount: number;
  lastAssistantText: string;
  composerText: string;
  composerPresent: boolean;
  generating: boolean;
  errorText: string;
  assistantImageUrls: string[];
}

export interface ChatGptModelSelectionResult {
  status: "selected" | "url-only";
  targetId: string;
  requestedPerformance?: ChatGptPerformance;
  currentLabel: string;
  selectedLabel?: string;
  selectedModel?: string;
  candidateCount: number;
}

export interface ChatGptResponseWaitInput {
  baselineAssistantCount: number;
  expectedMarker?: string;
  baselineImageCount?: number;
  expectedImageCount?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  shouldStop?: () => boolean;
  targetId?: string;
}

const SESSION_FILE = "computer-browser-session.json";
const APPROVALS_FILE = "computer-browser-approvals.json";
const ARTIFACTS_DIR = "computer-browser-artifacts";
const MAX_APPROVALS = 100;
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const MAX_INSPECT_ELEMENTS = 120;
const CHATGPT_COMPOSER_SELECTORS = [
  "#prompt-textarea",
  "[data-testid='composer-input']",
  "[contenteditable][role='textbox']",
  "[role='textbox'][aria-label*='chat' i]",
  "[role='textbox'][aria-label*='チャット']",
  "[role='textbox'][aria-label*='質問']",
  "[role='textbox'][aria-label*='message' i]",
  "textarea[placeholder]",
] as const;
const CHATGPT_COMPOSER_SELECTOR = CHATGPT_COMPOSER_SELECTORS.join(",");

function stateRoot(home: string = homedir()): string {
  return resolve(home, ".devspace");
}

export function browserSessionPath(home: string = homedir()): string {
  return join(stateRoot(home), SESSION_FILE);
}

export function browserApprovalsPath(home: string = homedir()): string {
  return join(stateRoot(home), APPROVALS_FILE);
}

function browserArtifactsDirectory(home: string = homedir()): string {
  return join(stateRoot(home), ARTIFACTS_DIR);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlinked Computer Use directory: ${path}`);
  chmodSync(path, 0o700);
}

function writePrivateJson(path: string, value: unknown): void {
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function loadPolicy(path?: string, home: string = homedir()): ComputerUsePolicy {
  const loaded = loadComputerUsePolicy(path, home);
  if (!loaded.exists) throw new Error("Computer Use policy is not initialized.");
  if (!loaded.valid) throw new Error(`Computer Use policy is invalid: ${loaded.error}`);
  if (!loaded.policy.enabled) throw new Error("Computer Use is disabled by policy.");
  if (!loaded.policy.browser.enabled) throw new Error("Browser Computer Use is disabled by policy.");
  if (loaded.policy.browser.allowedDomains.length === 0) {
    throw new Error("Browser Computer Use requires at least one allowed domain.");
  }
  return loaded.policy;
}

function readSession(home: string = homedir()): BrowserSessionRecord | undefined {
  const path = browserSessionPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as BrowserSessionRecord;
    if (
      raw?.schemaVersion !== 1
      || !Number.isInteger(raw.pid)
      || !Number.isInteger(raw.port)
      || typeof raw.browserWebSocketPath !== "string"
      || typeof raw.profileDirectory !== "string"
    ) return undefined;
    return {
      ...raw,
      backgroundMode: raw.backgroundMode === "headless"
        ? "headless"
        : raw.backgroundMode === "background-window"
          ? "background-window"
          : "window",
    };
  } catch {
    return undefined;
  }
}

function saveSession(session: BrowserSessionRecord, home: string = homedir()): void {
  writePrivateJson(browserSessionPath(home), session);
}

function clearSession(home: string = homedir()): void {
  rmSync(browserSessionPath(home), { force: true });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearStaleBrowserProfileLocks(profileDirectory: string): void {
  if (process.platform !== "linux") return;
  const lockPath = join(profileDirectory, "SingletonLock");
  let lockPid: number | undefined;
  try {
    const target = readlinkSync(lockPath);
    const match = target.match(/-(\d+)$/u);
    lockPid = match ? Number(match[1]) : undefined;
  } catch {}
  if (lockPid && processExists(lockPid)) return;
  for (const name of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
    rmSync(join(profileDirectory, name), { force: true });
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function runAppleScript(script: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  return await new Promise<string | undefined>((resolveScript) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 2_000 }, (error, stdout) => {
      resolveScript(error ? undefined : stdout.trim());
    });
  });
}

async function frontmostApplicationPid(): Promise<number | undefined> {
  const value = await runAppleScript(
    'tell application "System Events" to get unix id of first application process whose frontmost is true',
  );
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function hideBackgroundBrowserApplication(
  session: BrowserSessionRecord,
  restoreFrontmostPid?: number,
): Promise<void> {
  if (process.platform !== "darwin" || session.backgroundMode !== "background-window") return;
  const restore = restoreFrontmostPid && restoreFrontmostPid !== session.pid
    ? `\nset frontmost of first application process whose unix id is ${restoreFrontmostPid} to true`
    : "";
  await runAppleScript(`tell application "System Events"
set visible of first application process whose unix id is ${session.pid} to false${restore}
end tell`);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}: ${response.statusText}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

function cdpOrigin(session: BrowserSessionRecord): string {
  return `http://127.0.0.1:${session.port}`;
}

async function sessionResponds(session: BrowserSessionRecord): Promise<boolean> {
  try {
    const client = await CdpClient.connect(
      `ws://127.0.0.1:${session.port}${session.browserWebSocketPath}`,
    );
    try {
      await client.send("Browser.getVersion");
      return true;
    } finally {
      client.close();
    }
  } catch {
    return false;
  }
}

async function waitForSessionResponse(
  session: BrowserSessionRecord,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await sessionResponds(session)) return true;
    await sleep(100);
  }
  return false;
}

export function isManagedAutomationBrowserSession(session: BrowserSessionRecord): boolean {
  return session.managedBy === "gpt-agent-automation";
}

export async function browserStatus(home: string = homedir()): Promise<{
  active: boolean;
  session?: BrowserSessionRecord;
  pages: BrowserTargetInfo[];
}> {
  const session = readSession(home);
  if (!session || !isManagedAutomationBrowserSession(session)) {
    if (session) clearSession(home);
    return { active: false, pages: [] };
  }
  if (!await waitForSessionResponse(session, 10_000)) {
    return { active: false, session, pages: [] };
  }
  const pages = await listTargets(session);
  return { active: true, session, pages };
}

export function effectiveBrowserBackgroundMode(
  policyMode: "headless" | "background-window" | "window",
  env: NodeJS.ProcessEnv = process.env,
): "headless" | "background-window" | "window" {
  const override = String(env.DEVSPACE_BROWSER_BACKGROUND_MODE ?? "").trim();
  if (override === "headless" || override === "background-window" || override === "window") {
    return override;
  }
  return policyMode;
}

export async function startBrowserSession(input: {
  policyPath?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  allowDownloads?: boolean;
} = {}): Promise<{ status: "started" | "already-running"; session: BrowserSessionRecord }> {
  const home = input.home ?? homedir();
  const policy = loadPolicy(input.policyPath, home);
  const browser = findAutomationBrowser(undefined, home);
  if (!browser) {
    throw new Error("Chrome for Testing was not found. Run npm run browser:install:chrome-for-testing.");
  }
  const profileDirectory = resolve(policy.browser.profileDirectory);
  const backgroundMode = effectiveBrowserBackgroundMode(policy.browser.backgroundMode, input.env ?? process.env);
  const allowDownloads = input.allowDownloads ?? policy.browser.allowDownloads;
  const restoreFrontmostPid = backgroundMode === "background-window"
    ? await frontmostApplicationPid()
    : undefined;
  const existing = readSession(home);
  if (existing && await sessionResponds(existing)) {
    const sameManagedBrowser = isManagedAutomationBrowserSession(existing)
      && existing.browserExecutable === browser.path
      && resolve(existing.profileDirectory) === profileDirectory
      && existing.backgroundMode === backgroundMode;
    if (sameManagedBrowser) {
      await hideBackgroundBrowserApplication(existing, restoreFrontmostPid);
      await cleanupStaleBrowserAutomationTargets(home).catch(() => undefined);
      return { status: "already-running", session: existing };
    }
    if (isManagedAutomationBrowserSession(existing)) {
      await stopBrowserSession(home);
    } else {
      clearSession(home);
    }
  } else if (existing) {
    clearSession(home);
  }
  ensurePrivateDirectory(profileDirectory);
  clearStaleBrowserProfileLocks(profileDirectory);
  rmSync(join(profileDirectory, "DevToolsActivePort"), { force: true });

  const browserArgs = [
    `--user-data-dir=${profileDirectory}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-popup-blocking=false",
    "--disable-save-password-bubble",
    "--disable-features=AutofillServerCommunication,MediaRouter,PasswordManagerOnboarding,Translate",
  ];
  if (backgroundMode === "headless") {
    browserArgs.push("--headless=new", "--window-size=1440,1200");
  } else if (backgroundMode === "background-window") {
    browserArgs.push(
      "--disable-background-mode",
      "--window-position=-32000,-32000",
      "--window-size=1440,1200",
    );
  }
  browserArgs.push("about:blank");

  const child = spawn(browser.path, browserArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) throw new Error("Browser process did not return a PID.");

  const activePortPath = join(profileDirectory, "DevToolsActivePort");
  let port = 0;
  let browserWebSocketPath = "";
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (!processExists(child.pid)) throw new Error("Browser process exited before CDP became ready.");
    if (existsSync(activePortPath)) {
      const [portLine, wsPath] = readFileSync(activePortPath, "utf8").trim().split(/\r?\n/u);
      port = Number(portLine);
      browserWebSocketPath = wsPath ?? "";
      if (Number.isInteger(port) && port > 0 && browserWebSocketPath.startsWith("/")) break;
    }
    await sleep(100);
  }
  if (!port || !browserWebSocketPath) {
    try { process.kill(child.pid, "SIGTERM"); } catch {}
    throw new Error("Timed out waiting for the browser CDP endpoint.");
  }

  const session: BrowserSessionRecord = {
    schemaVersion: 1,
    managedBy: "gpt-agent-automation",
    pid: child.pid,
    port,
    browserName: browser.name,
    browserExecutable: browser.path,
    browserWebSocketPath,
    profileDirectory,
    backgroundMode,
    startedAt: new Date().toISOString(),
  };
  saveSession(session, home);
  if (!await waitForSessionResponse(session, 10_000)) {
    clearSession(home);
    try { process.kill(child.pid, "SIGTERM"); } catch {}
    throw new Error("Browser CDP endpoint did not become ready after launch.");
  }

  const browserClient = await CdpClient.connect(`ws://127.0.0.1:${port}${browserWebSocketPath}`);
  try {
    const downloadDirectory = resolve(policy.browser.downloadDirectory);
    if (allowDownloads) ensurePrivateDirectory(downloadDirectory);
    await browserClient.send("Browser.setDownloadBehavior", {
      behavior: allowDownloads ? "allow" : "deny",
      ...(allowDownloads ? { downloadPath: downloadDirectory, eventsEnabled: true } : {}),
    });
  } finally {
    browserClient.close();
  }
  await hideBackgroundBrowserApplication(session, restoreFrontmostPid);
  await cleanupStaleBrowserAutomationTargets(home).catch(() => undefined);
  return { status: "started", session };
}

export interface BrowserDownloadDirectoryResult {
  path: string;
  relativePath: string;
}

export interface ChatGptImageDownloadResult {
  targetId: string;
  files: Array<{
    url: string;
    fileName: string;
    path: string;
    bytes: number;
  }>;
}

export function resolveBrowserDownloadDirectory(
  input: { group?: string; taskId?: string; now?: Date } = {},
  policy: ComputerUsePolicy,
): BrowserDownloadDirectoryResult {
  const root = resolve(policy.browser.downloadDirectory);
  const groupSegments = sanitizeDownloadPath(input.group ?? "browser");
  const date = formatLocalDate(input.now ?? new Date());
  const task = sanitizeDownloadSegment(input.taskId ?? "manual");
  const relativePath = join(...groupSegments, date, task);
  return { path: join(root, relativePath), relativePath };
}

export async function configureBrowserDownloadDirectory(
  input: {
    group?: string;
    taskId?: string;
    now?: Date;
    policyPath?: string;
    home?: string;
  } = {},
): Promise<BrowserDownloadDirectoryResult> {
  const home = input.home ?? homedir();
  const policy = loadPolicy(input.policyPath, home);
  if (!policy.browser.allowDownloads) {
    throw new Error("Browser downloads are disabled by policy.");
  }
  const session = await requireActiveSession(home);
  const directory = resolveBrowserDownloadDirectory(input, policy);
  ensurePrivateDirectory(directory.path);
  const browserClient = await CdpClient.connect(
    `ws://127.0.0.1:${session.port}${session.browserWebSocketPath}`,
  );
  try {
    await browserClient.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: directory.path,
      eventsEnabled: true,
    });
  } finally {
    browserClient.close();
  }
  return directory;
}

export async function downloadChatGptImages(
  input: {
    urls: string[];
    directory: string;
    fileNames?: string[];
    targetId?: string;
    timeoutMs?: number;
    home?: string;
  },
): Promise<ChatGptImageDownloadResult> {
  const home = input.home ?? homedir();
  const policy = loadPolicy(undefined, home);
  const directory = resolve(input.directory);
  const downloadsRoot = resolve(policy.browser.downloadDirectory);
  if (directory !== downloadsRoot && !directory.startsWith(`${downloadsRoot}${sep}`)) {
    throw new Error("ChatGPT image download directory must remain inside the configured browser download root.");
  }
  const urls = [...new Set(input.urls.map((value) => value.trim()).filter(Boolean))];
  if (urls.length < 1 || urls.length > 4) throw new Error("ChatGPT image download requires 1 to 4 unique URLs.");
  for (const rawUrl of urls) {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || !url.pathname.startsWith("/backend-api/estuary/content")) {
      throw new Error("Only authenticated ChatGPT generated-image URLs may be downloaded.");
    }
  }
  const names = urls.map((_, index) => sanitizeImageFileName(
    input.fileNames?.[index] ?? `chatgpt-image-${String(index + 1).padStart(2, "0")}.png`,
  ));
  if (new Set(names).size !== names.length) throw new Error("ChatGPT image filenames must be unique.");
  ensurePrivateDirectory(directory);
  for (const name of names) {
    if (existsSync(join(directory, name))) throw new Error(`Refusing to overwrite existing browser download: ${name}`);
  }
  const files: ChatGptImageDownloadResult["files"] = [];
  let targetId = input.targetId;
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]!;
    const fileName = names[index]!;
    const path = join(directory, fileName);
    const fetched = await withPageClient(home, async (client, target) => {
      const result = await evaluate<{
        ok: boolean;
        status?: number;
        contentType?: string;
        base64?: string;
        error?: string;
      }>(client, `(async () => {
        try {
          const response = await fetch(${JSON.stringify(url)}, {
            credentials: "include",
            redirect: "follow",
            headers: { accept: "image/png,image/*;q=0.9,*/*;q=0.1" }
          });
          if (!response.ok) return { ok: false, status: response.status };
          const contentType = response.headers.get("content-type") || "";
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = "";
          const chunkSize = 0x8000;
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
          }
          return { ok: true, status: response.status, contentType, base64: btoa(binary) };
        } catch (error) {
          return { ok: false, error: String(error?.message || error) };
        }
      })()`);
      return { ...result, targetId: target.id };
    }, targetId);
    targetId = fetched.targetId;
    if (!fetched.ok || !fetched.base64) {
      throw new Error(`ChatGPT image browser fetch failed${fetched.status ? ` with HTTP ${fetched.status}` : ""}: ${fetched.error ?? "missing image data"}.`);
    }
    const contentType = fetched.contentType?.toLowerCase() ?? "";
    if (!contentType.startsWith("image/")) {
      throw new Error(`ChatGPT image response had unexpected content type: ${contentType || "missing"}.`);
    }
    const buffer = Buffer.from(fetched.base64, "base64");
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("ChatGPT generated-image response was not a PNG file.");
    }
    writeFileSync(path, buffer, { mode: 0o600, flag: "wx" });
    files.push({ url, fileName, path, bytes: statSync(path).size });
  }
  if (!targetId) throw new Error("ChatGPT image download did not resolve a browser target.");
  return { targetId, files };
}

function sanitizeImageFileName(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  const stem = normalized.replace(/\.png$/iu, "") || "chatgpt-image";
  return `${stem}.png`;
}

function sanitizeDownloadPath(value: string): string[] {
  const segments = value
    .normalize("NFKC")
    .split(/[\\/]+/u)
    .map(sanitizeDownloadSegment)
    .filter(Boolean);
  if (segments.length === 0) return ["browser"];
  if (segments.length > 4) throw new Error("Download group may contain at most four path segments.");
  return segments;
}

function sanitizeDownloadSegment(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  if (!normalized || normalized === "." || normalized === "..") return "browser";
  return normalized;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function launchBrowserLoginSession(
  input: { url?: string; policyPath?: string; home?: string } = {},
): Promise<{
  status: "launched";
  pid: number;
  browserName: string;
  profileDirectory: string;
  url: string;
}> {
  const home = input.home ?? homedir();
  const policy = loadPolicy(input.policyPath, home);
  const requested = validateBrowserUrl(input.url ?? "https://chatgpt.com/", policy);
  await stopBrowserSession(home);
  const browser = findAutomationBrowser(undefined, home);
  if (!browser) {
    throw new Error("Chrome for Testing was not found. Run npm run browser:install:chrome-for-testing.");
  }
  const profileDirectory = resolve(policy.browser.profileDirectory);
  ensurePrivateDirectory(profileDirectory);
  const child = spawn(browser.path, [
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    requested.toString(),
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) throw new Error("Login browser process did not return a PID.");
  return {
    status: "launched",
    pid: child.pid,
    browserName: browser.name,
    profileDirectory,
    url: requested.toString(),
  };
}

export async function stopBrowserSession(home: string = homedir()): Promise<{ status: "stopped" | "not-running" }> {
  const session = readSession(home);
  if (!session) return { status: "not-running" };
  if (!isManagedAutomationBrowserSession(session)) {
    clearSession(home);
    return { status: "not-running" };
  }
  if (await sessionResponds(session)) {
    try {
      const browserClient = await CdpClient.connect(
        `ws://127.0.0.1:${session.port}${session.browserWebSocketPath}`,
      );
      try {
        await browserClient.send("Browser.close");
      } finally {
        browserClient.close();
      }
    } catch {
      try { process.kill(session.pid, "SIGTERM"); } catch {}
    }
  }
  clearSession(home);
  return { status: "stopped" };
}

async function requireActiveSession(home: string = homedir()): Promise<BrowserSessionRecord> {
  const session = readSession(home);
  if (!session || !isManagedAutomationBrowserSession(session)) {
    if (session) clearSession(home);
    throw new Error("GPT-Agent Browser session is not running.");
  }
  return session;
}

async function listTargets(session: BrowserSessionRecord): Promise<BrowserTargetInfo[]> {
  const client = await CdpClient.connect(
    `ws://127.0.0.1:${session.port}${session.browserWebSocketPath}`,
  );
  try {
    const { targetInfos } = await client.send<{
      targetInfos: Array<{
        targetId: string;
        type: string;
        title: string;
        url: string;
      }>;
    }>("Target.getTargets");
    return targetInfos
      .filter((target) => target.type === "page")
      .map((target) => ({
        id: target.targetId,
        type: target.type,
        title: target.title,
        url: target.url,
        webSocketDebuggerUrl: `ws://127.0.0.1:${session.port}/devtools/page/${target.targetId}`,
      }));
  } finally {
    client.close();
  }
}

async function createBlankTarget(session: BrowserSessionRecord): Promise<BrowserTargetInfo> {
  const client = await CdpClient.connect(
    `ws://127.0.0.1:${session.port}${session.browserWebSocketPath}`,
  );
  try {
    const { targetId } = await client.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    return {
      id: targetId,
      type: "page",
      title: "",
      url: "about:blank",
      webSocketDebuggerUrl: `ws://127.0.0.1:${session.port}/devtools/page/${targetId}`,
    };
  } finally {
    client.close();
  }
}

async function getTarget(
  session: BrowserSessionRecord,
  home: string = homedir(),
  requestedTargetId?: string,
): Promise<BrowserTargetInfo> {
  const pages = await listTargets(session);
  if (requestedTargetId) {
    const requested = pages.find((page) => page.id === requestedTargetId);
    if (!requested) throw new Error(`Browser target is no longer available: ${requestedTargetId}`);
    if (!requested.webSocketDebuggerUrl) throw new Error("Browser target has no CDP WebSocket URL.");
    return requested;
  }
  let target = session.targetId ? pages.find((page) => page.id === session.targetId) : undefined;
  target ??= pages[0];
  target ??= await createBlankTarget(session);
  if (!target.webSocketDebuggerUrl) throw new Error("Browser target has no CDP WebSocket URL.");
  if (session.targetId !== target.id) {
    saveSession({ ...session, targetId: target.id }, home);
  }
  return target;
}

async function withPageClient<T>(
  home: string,
  fn: (client: CdpClient, target: BrowserTargetInfo, session: BrowserSessionRecord) => Promise<T>,
  targetId?: string,
): Promise<T> {
  const session = await requireActiveSession(home);
  const target = await getTarget(session, home, targetId);
  const client = await CdpClient.connect(target.webSocketDebuggerUrl!);
  try {
    return await fn(client, target, session);
  } finally {
    client.close();
  }
}

async function evaluate<T>(client: CdpClient, expression: string): Promise<T> {
  const response = await client.send<{
    result: { value?: T; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description
      ?? response.exceptionDetails.text
      ?? "Browser JavaScript evaluation failed.",
    );
  }
  return response.result.value as T;
}

async function waitForDocument(client: CdpClient): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate<string>(client, "document.readyState");
      if (state === "interactive" || state === "complete") return;
    } catch {}
    await sleep(150);
  }
}

async function waitForAllowedPage(
  client: CdpClient,
  policy: ComputerUsePolicy,
  requested: URL,
): Promise<{ url: string; title: string }> {
  const deadline = Date.now() + 30_000;
  let latestUrl = "about:blank";
  while (Date.now() < deadline) {
    try {
      const page = await evaluate<{ url: string; title: string; readyState: string }>(client, `({
        url: location.href,
        title: document.title.slice(0, 300),
        readyState: document.readyState
      })`);
      latestUrl = page.url;
      if (page.url !== "about:blank") {
        validateBrowserUrl(page.url, policy);
        return { url: page.url, title: page.title };
      }
    } catch (error) {
      if (latestUrl !== "about:blank") throw error;
    }
    await sleep(200);
  }
  throw new Error(`Browser did not reach ${requested.origin} after navigation; last URL: ${latestUrl}.`);
}

export async function openBrowserUrl(
  rawUrl: string,
  input: { policyPath?: string; home?: string } = {},
): Promise<{ targetId: string; url: string; title: string }> {
  const home = input.home ?? homedir();
  const policy = loadPolicy(input.policyPath, home);
  const requested = validateBrowserUrl(rawUrl, policy);
  return await withPageClient(home, async (client, target) => {
    await client.send("Page.enable");
    try {
      const navigation = await client.send<{ errorText?: string }>("Page.navigate", { url: requested.toString() });
      if (navigation.errorText && navigation.errorText !== "net::ERR_ABORTED") {
        throw new Error(`Browser navigation failed: ${navigation.errorText}`);
      }
    } catch (error) {
      if (!(error instanceof Error) || !/CDP command timed out: Page\.navigate/u.test(error.message)) throw error;
    }
    try {
      const page = await waitForAllowedPage(client, policy, requested);
      return { targetId: target.id, url: page.url, title: page.title };
    } catch (error) {
      await client.send("Page.navigate", { url: "about:blank" }).catch(() => undefined);
      throw new Error(`Navigation left the allowlist or did not complete: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export async function openBrowserUrlInNewTab(
  rawUrl: string,
  input: { policyPath?: string; home?: string } = {},
): Promise<{ targetId: string; url: string; title: string }> {
  const home = input.home ?? homedir();
  const policy = loadPolicy(input.policyPath, home);
  const requested = validateBrowserUrl(rawUrl, policy);
  const session = await requireActiveSession(home);
  const target = await createBlankTarget(session);
  if (!target.webSocketDebuggerUrl) throw new Error("Browser target has no CDP WebSocket URL.");
  saveSession({ ...session, targetId: target.id }, home);
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    try {
      const navigation = await client.send<{ errorText?: string }>("Page.navigate", { url: requested.toString() });
      if (navigation.errorText && navigation.errorText !== "net::ERR_ABORTED") {
        throw new Error(`Browser navigation failed: ${navigation.errorText}`);
      }
    } catch (error) {
      if (!(error instanceof Error) || !/CDP command timed out: Page\.navigate/u.test(error.message)) throw error;
    }
    const page = await waitForAllowedPage(client, policy, requested);
    return { targetId: target.id, url: page.url, title: page.title };
  } catch (error) {
    await closeBrowserTarget(target.id, home).catch(() => undefined);
    throw error;
  } finally {
    client.close();
  }
}

export async function closeBrowserTarget(
  targetId: string,
  home: string = homedir(),
): Promise<{ status: "closed" | "not-found"; targetId: string }> {
  const session = await requireActiveSession(home);
  const pages = await listTargets(session);
  if (!pages.some((page) => page.id === targetId)) {
    removeBrowserAutomationTarget(targetId, home);
    return { status: "not-found", targetId };
  }
  const browserClient = await CdpClient.connect(
    `ws://127.0.0.1:${session.port}${session.browserWebSocketPath}`,
  );
  try {
    await browserClient.send("Target.closeTarget", { targetId });
  } finally {
    browserClient.close();
  }
  removeBrowserAutomationTarget(targetId, home);
  const remaining = (await listTargets(session)).filter((page) => page.id !== targetId);
  saveSession({ ...session, targetId: remaining[0]?.id }, home);
  return { status: "closed", targetId };
}

export async function activateBrowserTarget(
  targetId: string,
  home: string = homedir(),
): Promise<{ status: "activated"; targetId: string }> {
  const session = await requireActiveSession(home);
  const pages = await listTargets(session);
  if (!pages.some((page) => page.id === targetId)) {
    throw new Error(`Browser target is no longer available: ${targetId}`);
  }
  const restoreFrontmostPid = session.backgroundMode === "background-window"
    ? await frontmostApplicationPid()
    : undefined;
  const browserClient = await CdpClient.connect(
    `ws://127.0.0.1:${session.port}${session.browserWebSocketPath}`,
  );
  try {
    await browserClient.send("Target.activateTarget", { targetId });
  } finally {
    browserClient.close();
  }
  await hideBackgroundBrowserApplication(session, restoreFrontmostPid);
  saveSession({ ...session, targetId }, home);
  return { status: "activated", targetId };
}

export async function inspectBrowserPage(home: string = homedir()): Promise<BrowserInspectionResult> {
  return await withPageClient(home, async (client, target) => {
    const result = await evaluate<Omit<BrowserInspectionResult, "targetId">>(client, `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 240);
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 1
          && r.height > 1
          && style.visibility !== "hidden"
          && style.display !== "none"
          && r.right >= 0
          && r.bottom >= 0
          && r.left <= window.innerWidth
          && r.top <= window.innerHeight;
      };
      const selectors = "a,button,input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox'],[role='button'],[role='link'],[tabindex]";
      const active = document.activeElement;
      const editableSelector = "input,textarea,[contenteditable]:not([contenteditable='false']),[role='textbox']";
      const interactive = Array.from(document.querySelectorAll(selectors))
        .filter(visible)
        .map((el, order) => ({
          el,
          order,
          priority: el === active || (active instanceof Node && el.contains(active))
            ? 2
            : el.matches(editableSelector) ? 1 : 0,
        }))
        .sort((a, b) => b.priority - a.priority || a.order - b.order)
        .slice(0, ${MAX_INSPECT_ELEMENTS})
        .map(({ el }, index) => {
          const r = el.getBoundingClientRect();
          return {
            index,
            tag: el.tagName.toLowerCase(),
            type: clean(el.getAttribute("type")),
            role: clean(el.getAttribute("role")),
            text: clean(el.innerText || el.textContent),
            ariaLabel: clean(el.getAttribute("aria-label")),
            name: clean(el.getAttribute("name")),
            href: el instanceof HTMLAnchorElement ? clean(el.href) : "",
            download: el instanceof HTMLAnchorElement && el.hasAttribute("download"),
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        });
      return {
        url: location.href,
        title: document.title.slice(0, 300),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          deviceScaleFactor: window.devicePixelRatio || 1,
        },
        interactive,
      };
    })()`);
    return { targetId: target.id, ...result };
  });
}

export async function inspectChatGptConversation(
  home: string = homedir(),
  targetId?: string,
): Promise<ChatGptConversationSnapshot> {
  return await withPageClient(home, async (client, target) => {
    const page = await evaluate<Omit<ChatGptConversationSnapshot, "targetId">>(client, `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const messages = Array.from(document.querySelectorAll("[data-message-author-role]"));
      const assistants = messages.filter((el) => el.getAttribute("data-message-author-role") === "assistant");
      const users = messages.filter((el) => el.getAttribute("data-message-author-role") === "user");
      const visible = (candidate) => {
        if (!(candidate instanceof HTMLElement)) return false;
        const r = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return r.width > 1 && r.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const composer = Array.from(document.querySelectorAll(
        ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)}
      )).find(visible);
      const stopButton = document.querySelector(
        "button[data-testid='stop-button'],button[aria-label*='Stop'],button[aria-label*='停止']"
      );
      const inlineError = document.querySelector(
        "[data-testid='conversation-turn-error'],[role='alert']"
      );
      const blockingDialog = Array.from(document.querySelectorAll("[role='dialog']"))
        .find((candidate) => visible(candidate)
          && /too many requests|requests too quickly|temporarily limited|リクエストが多すぎ|しばらく待/u.test(
            String(candidate.innerText || candidate.textContent || "")
          ));
      const error = inlineError || blockingDialog;
      const generatedImages = Array.from(document.querySelectorAll("img"))
        .map((image) => ({
          src: image instanceof HTMLImageElement ? image.currentSrc || image.src : "",
          width: image instanceof HTMLImageElement ? image.naturalWidth : 0,
          height: image instanceof HTMLImageElement ? image.naturalHeight : 0,
        }))
        .filter((image) => image.src.includes("/backend-api/estuary/content")
          && image.width >= 512
          && image.height >= 256)
        .map((image) => image.src);
      return {
        url: location.href,
        title: document.title.slice(0, 300),
        assistantCount: assistants.length,
        userCount: users.length,
        lastAssistantText: clean(assistants.at(-1)?.innerText || assistants.at(-1)?.textContent),
        composerText: clean(composer?.innerText || composer?.textContent || composer?.value),
        composerPresent: Boolean(composer),
        generating: Boolean(stopButton),
        errorText: clean(error?.innerText || error?.textContent).slice(0, 500),
        assistantImageUrls: [...new Set(generatedImages)],
      };
    })()`);
    return { targetId: target.id, ...page };
  }, targetId);
}

export async function selectBestAvailableChatGptModel(
  input: { home?: string; targetId?: string } = {},
): Promise<ChatGptModelSelectionResult> {
  const home = input.home ?? homedir();
  return await withPageClient(home, async (client, target) => {
    const discovery = await evaluate<{
      hostname: string;
      currentUrl: string;
      currentPresetLabel: string;
      reasoningModelSlugs: string[];
    }>(client, `(async () => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const isPresetLabel = (value) => {
        const text = clean(value);
        return ["高い", "中程度", "最速", "High", "Medium", "Fast"].includes(text)
          || [" 高い", " 中程度", " 最速", " High", " Medium", " Fast"].some((suffix) => text.endsWith(suffix));
      };
      const presetButton = Array.from(document.querySelectorAll("button"))
        .find((candidate) => visible(candidate) && isPresetLabel(candidate.innerText));
      const storedValues = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key) storedValues.push(localStorage.getItem(key) || "");
      }
      const storedText = storedValues.join("\\n");
      const storedReasoningSlugs = storedText.match(/gpt-[0-9]+(?:-[0-9]+)+(?:-thinking|-reasoning)/gi) || [];
      const result = {
        hostname: location.hostname,
        currentUrl: location.href,
        currentPresetLabel: clean(presetButton?.innerText),
        reasoningModelSlugs: storedReasoningSlugs.map((slug) => slug.toLowerCase())
      };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(
          "/backend-api/models?history_and_training_disabled=false",
          { credentials: "include", signal: controller.signal }
        );
        clearTimeout(timer);
        if (!response.ok) return { ...result, reasoningModelSlugs: [...new Set(result.reasoningModelSlugs)] };
        const json = await response.json();
        const rawModels = Array.isArray(json?.models)
          ? json.models
          : json?.models && typeof json.models === "object"
            ? Object.values(json.models)
            : [];
        const explicitReasoningSlugs = rawModels
          .map((item) => String(item?.slug || item?.id || item?.model_slug || item?.modelSlug || "").trim())
          .filter((slug) => /thinking|reasoning|high|deep|pro/i.test(slug));
        const presetReasoningSlugs = (Array.isArray(json?.versions) ? json.versions : [])
          .flatMap((version) => {
            if (Array.isArray(version?.intelligence_presets)) return version.intelligence_presets;
            if (Array.isArray(version?.intelligencePresets)) return version.intelligencePresets;
            return [];
          })
          .filter((preset) => {
            const descriptor = [
              preset?.lane,
              preset?.title,
              preset?.selected_display_title,
              preset?.selectedDisplayTitle,
              preset?.preset_type,
              preset?.presetType
            ].map((value) => String(value || "")).join(" ");
            return /thinking|reasoning|high|deep|pro|思考|推論|高|プロ/i.test(descriptor)
              && !/unavailable|disabled|利用不可/i.test(descriptor);
          })
          .map((preset) => String(preset?.model_slug || preset?.modelSlug || "").trim())
          .filter(Boolean)
          .map((slug) => /thinking|reasoning|high|deep|pro/i.test(slug) ? slug : slug + "-thinking");
        result.reasoningModelSlugs = [...new Set([
          ...result.reasoningModelSlugs,
          ...explicitReasoningSlugs,
          ...presetReasoningSlugs
        ].map((slug) => slug.toLowerCase()))];
      } catch {}
      return { ...result, reasoningModelSlugs: [...new Set(result.reasoningModelSlugs)] };
    })()`);
    if (discovery.hostname !== "chatgpt.com" && !discovery.hostname.endsWith(".chatgpt.com")) {
      throw new Error(`ChatGPT model selector requires chatgpt.com, got ${discovery.hostname || "unknown host"}.`);
    }
    const currentModel = new URL(discovery.currentUrl).searchParams.get("model")
      ?? CHATGPT_MINIMUM_PREFERRED_MODEL;
    const currentScore = scoreChatGptModel(currentModel);
    const discovered = chooseBestDiscoveredChatGptModel(discovery.reasoningModelSlugs);
    const currentPresetIsHigh = discovery.currentPresetLabel === "高い"
      || discovery.currentPresetLabel === "High"
      || discovery.currentPresetLabel.endsWith(" 高い")
      || discovery.currentPresetLabel.endsWith(" High");
    if (currentPresetIsHigh && discovered?.modelSlug
      && discovered.score >= scoreChatGptModel(CHATGPT_MINIMUM_PREFERRED_MODEL)) {
      return {
        status: "selected",
        targetId: target.id,
        currentLabel: discovery.currentPresetLabel,
        selectedLabel: discovery.currentPresetLabel,
        selectedModel: discovered.modelSlug,
        candidateCount: discovery.reasoningModelSlugs.length,
      };
    }
    if (currentScore > scoreChatGptModel(CHATGPT_MINIMUM_PREFERRED_MODEL)) {
      return {
        status: "selected",
        targetId: target.id,
        currentLabel: currentModel,
        selectedLabel: currentModel,
        selectedModel: currentModel,
        candidateCount: discovery.reasoningModelSlugs.length,
      };
    }

    const menu = await evaluate<{
      hostname: string;
      currentLabel: string;
      x?: number;
      y?: number;
    }>(client, `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const direct = document.querySelector("[data-testid='model-switcher-dropdown-button']");
      const isPresetLabel = (value) => {
        const text = clean(value);
        return ["高い", "中程度", "最速", "High", "Medium", "Fast"].includes(text)
          || [" 高い", " 中程度", " 最速", " High", " Medium", " Fast"].some((suffix) => text.endsWith(suffix));
      };
      const preset = Array.from(document.querySelectorAll("button"))
        .find((candidate) => visible(candidate) && isPresetLabel(candidate.innerText));
      const fallback = Array.from(document.querySelectorAll("button[aria-haspopup='menu'],button[aria-haspopup='listbox']"))
        .find((candidate) => {
          const descriptor = clean(candidate.innerText || candidate.getAttribute("aria-label"));
          const testId = candidate.getAttribute("data-testid") || "";
          return visible(candidate)
            && /gpt|model|モデル|thinking|思考|推論/i.test(descriptor)
            && !/会話オプション|プロジェクトオプション|conversation options|project options/i.test(descriptor)
            && !/history-item/i.test(testId);
        });
      const button = direct || preset || fallback;
      if (!(button instanceof HTMLElement)) {
        return { hostname: location.hostname, currentLabel: "" };
      }
      const r = button.getBoundingClientRect();
      return {
        hostname: location.hostname,
        currentLabel: clean(button.innerText || button.getAttribute("aria-label")),
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2)
      };
    })()`);
    if (menu.hostname !== "chatgpt.com" && !menu.hostname.endsWith(".chatgpt.com")) {
      throw new Error(`ChatGPT model selector requires chatgpt.com, got ${menu.hostname || "unknown host"}.`);
    }
    if (menu.x === undefined || menu.y === undefined) {
      return {
        status: "url-only",
        targetId: target.id,
        currentLabel: menu.currentLabel,
        candidateCount: 0,
      };
    }

    await dispatchClick(client, menu.x, menu.y);
    await sleep(350);
    const candidates = await evaluate<Array<{
      label: string;
      href?: string;
      disabled: boolean;
      domIndex: number;
    }>>(client, `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const nodes = Array.from(document.querySelectorAll(
        "[role='menuitem'],[role='menuitemradio'],[role='option'],a[href*='model=']"
      )).filter(visible);
      return nodes.map((el, domIndex) => {
        const link = el instanceof HTMLAnchorElement ? el : el.closest("a[href]");
        return {
          label: clean(el.innerText || el.textContent || el.getAttribute("aria-label")),
          href: link instanceof HTMLAnchorElement ? link.href : undefined,
          disabled: el.getAttribute("aria-disabled") === "true"
            || el.hasAttribute("disabled")
            || /upgrade|unavailable|利用不可|アップグレード/i.test(clean(el.innerText || el.textContent)),
          domIndex
        };
      }).filter((candidate) => candidate.label);
    })()`);
    const highPreset = candidates.find((candidate) => !candidate.disabled
      && (candidate.label === "高い"
        || candidate.label === "High"
        || candidate.label.endsWith(" 高い")
        || candidate.label.endsWith(" High")));
    const best = highPreset
      ? {
          ...highPreset,
          score: discovered?.score ?? scoreChatGptModel(highPreset.label),
          ...(discovered?.modelSlug ? { modelSlug: discovered.modelSlug } : {}),
        }
      : chooseBestChatGptModelCandidate(candidates);
    if (!best || best.domIndex === undefined) {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
      return {
        status: "url-only",
        targetId: target.id,
        currentLabel: menu.currentLabel,
        candidateCount: candidates.length,
      };
    }

    const point = await evaluate<{ x: number; y: number } | undefined>(client, `(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const nodes = Array.from(document.querySelectorAll(
        "[role='menuitem'],[role='menuitemradio'],[role='option'],a[href*='model=']"
      )).filter(visible);
      const el = nodes[${best.domIndex}];
      if (!(el instanceof HTMLElement)) return undefined;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!point) {
      return {
        status: "url-only",
        targetId: target.id,
        currentLabel: menu.currentLabel,
        candidateCount: candidates.length,
      };
    }

    await dispatchClick(client, point.x, point.y);
    await sleep(500);
    const selectedLabel = await evaluate<string>(client, `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const preset = Array.from(document.querySelectorAll("button"))
        .find((candidate) => {
          const text = clean(candidate.innerText);
          return ["高い", "中程度", "最速", "High", "Medium", "Fast"].includes(text)
            || [" 高い", " 中程度", " 最速", " High", " Medium", " Fast"].some((suffix) => text.endsWith(suffix));
        });
      const button = document.querySelector("[data-testid='model-switcher-dropdown-button']") || preset;
      return clean(button?.innerText || button?.getAttribute("aria-label"));
    })()`);
    return {
      status: "selected",
      targetId: target.id,
      currentLabel: menu.currentLabel,
      selectedLabel: selectedLabel || best.label,
      ...(best.modelSlug ? { selectedModel: best.modelSlug } : {}),
      candidateCount: candidates.length,
    };
  }, input.targetId);
}

export async function selectChatGptPerformance(
  input: { performance: ChatGptPerformance; home?: string; targetId?: string },
): Promise<ChatGptModelSelectionResult> {
  const home = input.home ?? homedir();
  return await withPageClient(home, async (client, target) => {
    const locateButton = async () => await evaluate<{
      hostname: string;
      label: string;
      x?: number;
      y?: number;
    }>(client, `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const directCandidate = document.querySelector("[data-testid='model-switcher-dropdown-button']");
      const direct = directCandidate && visible(directCandidate) ? directCandidate : null;
      const known = Array.from(document.querySelectorAll(
        "button[aria-haspopup='menu'],button[aria-haspopup='listbox']"
      )).find((candidate) => {
        const descriptor = clean(candidate.innerText || candidate.getAttribute("aria-label"));
        const testId = candidate.getAttribute("data-testid") || "";
        return visible(candidate)
          && !/会話オプション|プロジェクトオプション|conversation options|project options/i.test(descriptor)
          && !/history-item/i.test(testId)
          && /^(?:最速(?:\\s+5[.]5)?|中程度|高い|fastest(?:\\s+5[.]5)?|instant(?:\\s+5[.]5)?|fast|medium|balanced|high|gpt[\\s._-]*5[\\s._-]*6[\\s._-]*sol)$/i
            .test(descriptor);
      });
      const fallback = Array.from(document.querySelectorAll("button[aria-haspopup='menu'],button[aria-haspopup='listbox']"))
        .find((candidate) => {
          const descriptor = clean(candidate.innerText || candidate.getAttribute("aria-label"));
          const testId = candidate.getAttribute("data-testid") || "";
          return visible(candidate)
            && /gpt|model|モデル|thinking|思考|推論/i.test(descriptor)
            && !/会話オプション|プロジェクトオプション|conversation options|project options/i.test(descriptor)
            && !/history-item/i.test(testId);
        });
      const button = direct || known || fallback;
      if (!(button instanceof HTMLElement)) return { hostname: location.hostname, label: "" };
      const r = button.getBoundingClientRect();
      return {
        hostname: location.hostname,
        label: clean(button.innerText || button.getAttribute("aria-label")),
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2)
      };
    })()`);

    let before = await locateButton();
    for (let attempt = 0; attempt < 20 && (before.x === undefined || before.y === undefined); attempt += 1) {
      await sleep(250);
      before = await locateButton();
    }
    if (before.hostname !== "chatgpt.com" && !before.hostname.endsWith(".chatgpt.com")) {
      throw new Error(`ChatGPT model selector requires chatgpt.com, got ${before.hostname || "unknown host"}.`);
    }
    if (matchesChatGptPerformanceLabel(input.performance, before.label)) {
      const actual = await inspectSelectedChatGptModel(client, input.performance, before.label)
        .catch(() => undefined);
      if (actual) {
        return {
          status: "selected",
          targetId: target.id,
          requestedPerformance: input.performance,
          currentLabel: before.label,
          selectedLabel: before.label,
          selectedModel: actual,
          candidateCount: 0,
        };
      }
    }
    // Prefer ChatGPT's own model-picker shortcut so an existing conversation URL
    // is never rewritten merely to change performance. The visible picker click
    // remains a fallback for accounts where the shortcut has not rolled out.
    await dispatchBrowserShortcut(client, {
      key: "M",
      code: "KeyM",
      windowsVirtualKeyCode: 77,
      modifiers: 10,
    });
    const collectCandidates = async () => await evaluate<Array<{
      label: string;
      href?: string;
      modelSlug?: string;
      modelEvidence?: string[];
      role?: string;
      checked?: boolean;
      disabled: boolean;
      domIndex: number;
    }>>(client, `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const slugPattern = /gpt[-_. ]*[0-9]+(?:[-_. ][0-9]+)+(?:[-_. ]+(?:sol|thinking|reasoning|instant|fast|auto))?/gi;
      const normalizeSlug = (value) => clean(value).replace(/[_. ]+/g, "-").toLowerCase();
      const scanReactSlugs = (el) => {
        const slugs = new Set();
        const seen = new WeakSet();
        const visit = (value, depth) => {
          if (value == null || depth > 7) return;
          if (typeof value === "string") {
            for (const slug of value.match(slugPattern) || []) slugs.add(normalizeSlug(slug));
            return;
          }
          if (typeof value !== "object" || seen.has(value)) return;
          seen.add(value);
          const entries = Array.isArray(value)
            ? value.slice(0, 120).map((item, index) => [String(index), item])
            : Object.entries(value).slice(0, 120);
          for (const [, item] of entries) visit(item, depth + 1);
        };
        for (const key of Object.getOwnPropertyNames(el)) {
          if (!key.startsWith("__reactProps$")) continue;
          try { visit(el[key], 0); } catch {}
        }
        return [...slugs];
      };
      return Array.from(document.querySelectorAll(
        "[role='menuitem'],[role='menuitemradio'],[role='option'],a[href*='model=']"
      )).filter(visible).map((el, domIndex) => {
        const link = el instanceof HTMLAnchorElement ? el : el.closest("a[href]");
        const descriptor = [
          el.getAttribute("data-model"),
          el.getAttribute("data-value"),
          el.getAttribute("value"),
          el.id,
          link instanceof HTMLAnchorElement ? link.href : ""
        ].filter(Boolean).join(" ");
        const attributeSlugs = (descriptor.match(slugPattern) || []).map(normalizeSlug);
        const modelEvidence = [...new Set([...attributeSlugs, ...scanReactSlugs(el)])];
        return {
          label: clean(el.innerText || el.textContent || el.getAttribute("aria-label")),
          href: link instanceof HTMLAnchorElement ? link.href : undefined,
          modelSlug: modelEvidence.length === 1 ? modelEvidence[0] : undefined,
          modelEvidence,
          role: el.getAttribute("role") || undefined,
          checked: el.getAttribute("aria-checked") === "true" || el.getAttribute("data-state") === "checked",
          disabled: el.getAttribute("aria-disabled") === "true"
            || el.hasAttribute("disabled")
            || /upgrade|unavailable|利用不可|アップグレード/i.test(clean(el.innerText || el.textContent)),
          domIndex
        };
      }).filter((candidate) => candidate.label);
    })()`);
    let candidates = await collectCandidates();
    for (let attempt = 0; attempt < 20 && candidates.length === 0; attempt += 1) {
      await sleep(250);
      candidates = await collectCandidates();
    }
    if (candidates.length === 0 && before.x !== undefined && before.y !== undefined) {
      await dispatchClick(client, before.x, before.y);
      for (let attempt = 0; attempt < 20 && candidates.length === 0; attempt += 1) {
        await sleep(250);
        candidates = await collectCandidates();
      }
    }
    if (candidates.length === 0) {
      const fallbackClicked = await evaluate<boolean>(client, `(() => {
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return r.width > 1 && r.height > 1 && r.right > 0 && r.bottom > 0
            && style.display !== "none" && style.visibility !== "hidden";
        };
        const button = Array.from(document.querySelectorAll(
          "button[aria-haspopup='menu'],button[aria-haspopup='listbox']"
        )).find((candidate) => {
          const descriptor = clean(candidate.innerText || candidate.getAttribute("aria-label"));
          const testId = candidate.getAttribute("data-testid") || "";
          return visible(candidate)
            && !/会話オプション|プロジェクトオプション|conversation options|project options/i.test(descriptor)
            && !/history-item/i.test(testId)
            && descriptor === ${JSON.stringify(before.label)};
        });
        if (!(button instanceof HTMLElement)) return false;
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          const event = type.startsWith("pointer")
            ? new PointerEvent(type, { bubbles: true, button: 0, pointerType: "mouse" })
            : new MouseEvent(type, { bubbles: true, button: 0 });
          button.dispatchEvent(event);
        }
        return true;
      })()`);
      if (fallbackClicked) {
        for (let attempt = 0; attempt < 20 && candidates.length === 0; attempt += 1) {
          await sleep(250);
          candidates = await collectCandidates();
        }
      }
    }
    const eligibleCandidates = candidates.filter((candidate) => candidate.role !== "menuitem");
    const chosen = chooseChatGptPerformanceCandidate(input.performance, eligibleCandidates);
    if (!chosen || chosen.domIndex === undefined) {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
      const available = candidates.map((candidate) => candidate.label).join(" | ") || "none";
      throw new Error(`ChatGPT performance ${input.performance} was not available. Candidates: ${available}.`);
    }

    const point = await evaluate<{ x: number; y: number } | undefined>(client, `(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const nodes = Array.from(document.querySelectorAll(
        "[role='menuitem'],[role='menuitemradio'],[role='option'],a[href*='model=']"
      )).filter(visible);
      const el = nodes[${chosen.domIndex}];
      if (!(el instanceof HTMLElement)) return undefined;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!point) throw new Error(`ChatGPT performance ${input.performance} candidate disappeared before selection.`);

    await dispatchClick(client, point.x, point.y);
    await sleep(500);
    const after = await locateButton();
    let selectedLabel = after.label || chosen.label;
    const evidenceModels = [...new Set(chosen.modelEvidence ?? [])];
    let selectedModel: string | undefined = chosen.modelSlug
      ?? extractChatGptModelSlug(chosen.href)
      ?? (evidenceModels.length === 1 ? evidenceModels[0] : undefined);
    if (!matchesChatGptPerformanceLabel(input.performance, selectedLabel)) {
      let actualAfterSelection: string | undefined;
      let verificationDetail = "no model evidence";
      try {
        actualAfterSelection = await inspectSelectedChatGptModel(
          client,
          input.performance,
          chosen.label,
        );
      } catch (error) {
        verificationDetail = error instanceof Error ? error.message : String(error);
      }
      if (actualAfterSelection && matchesChatGptPerformanceLabel(input.performance, actualAfterSelection)) {
        selectedLabel = chosen.label;
        selectedModel = actualAfterSelection;
      } else {
        throw new Error(
          `ChatGPT performance ${input.performance} selection was not confirmed; displayed label: ${selectedLabel || "unknown"}; ${verificationDetail}.`,
        );
      }
    }
    selectedModel ??= await inspectSelectedChatGptModel(client, input.performance, selectedLabel);
    if (!selectedModel) {
      throw new Error(
        `ChatGPT performance ${input.performance} was selected as ${selectedLabel}, but the actual model could not be verified.`,
      );
    }
    return {
      status: "selected",
      targetId: target.id,
      requestedPerformance: input.performance,
      currentLabel: before.label,
      selectedLabel,
      ...(selectedModel ? { selectedModel } : {}),
      candidateCount: candidates.length,
    };
  }, input.targetId);
}

async function inspectSelectedChatGptModel(
  client: CdpClient,
  performance: ChatGptPerformance,
  selectedLabel: string,
): Promise<string | undefined> {
  const snapshot = await evaluate<{
    urlModel: string;
    apiStatus: number;
    evidence: Array<{
      source: string;
      descriptor: string;
      modelSlug: string;
      selected: boolean;
    }>;
  }>(client, `(async () => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const slugPattern = /gpt[-_. ]*[0-9]+(?:[-_. ][0-9]+)+(?:[-_. ]+(?:sol|thinking|reasoning|instant|fast|auto))?/gi;
    const normalizeSlug = (value) => clean(value).replace(/[_. ]+/g, "-").toLowerCase();
    const performancePattern = ${JSON.stringify(performance === "fastest"
      ? "最速|fastest|instant|fast"
      : "高い|high|thinking|reasoning")};
    const performanceRegex = new RegExp(performancePattern, "i");
    const evidence = [];
    const seenEvidence = new Set();
    const addEvidence = (source, descriptor, modelSlug, selected = false) => {
      const slug = normalizeSlug(modelSlug);
      if (!slug || !/^gpt-[0-9]+(?:-[0-9]+)+/i.test(slug)) return;
      const key = [source, slug, Boolean(selected), clean(descriptor).slice(0, 220)].join("|");
      if (seenEvidence.has(key)) return;
      seenEvidence.add(key);
      evidence.push({
        source,
        descriptor: clean(descriptor).slice(0, 220),
        modelSlug: slug,
        selected: Boolean(selected)
      });
    };
    const scanObject = (root, source) => {
      const seen = new WeakSet();
      const visit = (value, path, depth) => {
        if (!value || typeof value !== "object" || depth > 9 || seen.has(value)) return;
        seen.add(value);
        const entries = Array.isArray(value)
          ? value.slice(0, 300).map((item, index) => [String(index), item])
          : Object.entries(value).slice(0, 300);
        const primitives = entries
          .filter(([, item]) => item == null || ["string", "number", "boolean"].includes(typeof item))
          .map(([key, item]) => key + "=" + clean(item))
          .join(" ");
        const descriptor = clean(path + " " + primitives);
        const slugs = descriptor.match(slugPattern) || [];
        const selected = /(?:selected|active|current|is_selected|isSelected)=?(?:true|1|yes)|selected_/i.test(descriptor);
        if (performanceRegex.test(descriptor)) {
          for (const slug of slugs) addEvidence(source, descriptor, slug, selected);
        }
        for (const [key, item] of entries) {
          if (item && typeof item === "object") visit(item, path + "." + key, depth + 1);
        }
      };
      visit(root, source, 0);
    };

    const result = {
      urlModel: new URL(location.href).searchParams.get("model") || "",
      apiStatus: 0,
      evidence
    };
    if (result.urlModel) addEvidence("url", selectedLabel, result.urlModel, true);

    const buttons = Array.from(document.querySelectorAll("button"));
    const selectorButton = document.querySelector("[data-testid='model-switcher-dropdown-button']")
      || buttons.find((button) => clean(button.innerText || button.getAttribute("aria-label")) === ${JSON.stringify(selectedLabel)});
    let node = selectorButton;
    for (let level = 0; node && level < 5; level += 1, node = node.parentElement) {
      const attributes = Array.from(node.attributes || []).map((attribute) => attribute.name + "=" + attribute.value).join(" ");
      const descriptor = clean([node.innerText, node.getAttribute?.("aria-label"), attributes].filter(Boolean).join(" "));
      for (const slug of descriptor.match(slugPattern) || []) addEvidence("dom", descriptor, slug, true);
      for (const key of Object.getOwnPropertyNames(node)) {
        if (!key.startsWith("__reactProps$") && !key.startsWith("__reactFiber$")) continue;
        try { scanObject(node[key], "react." + key.slice(0, 16)); } catch {}
      }
    }

    for (const [storageName, storage] of [["localStorage", localStorage], ["sessionStorage", sessionStorage]]) {
      for (let index = 0; index < Math.min(storage.length, 300); index += 1) {
        const key = storage.key(index) || "";
        const value = String(storage.getItem(key) || "").slice(0, 500000);
        if (!performanceRegex.test(key + " " + value)) continue;
        for (const slug of value.match(slugPattern) || []) {
          addEvidence(storageName, key, slug, /selected|active|current/i.test(key + " " + value.slice(0, 5000)));
        }
        try { scanObject(JSON.parse(value), storageName + "." + key); } catch {}
      }
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(
        "/backend-api/models?history_and_training_disabled=false",
        { credentials: "include", signal: controller.signal }
      );
      clearTimeout(timer);
      result.apiStatus = response.status;
      if (response.ok) scanObject(await response.json(), "models-api");
    } catch {}
    return result;
  })()`);

  const canonicalModelSlug = (value: string): string => value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[\u2010-\u2015\u2212_.\s-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const ranked = snapshot.evidence
    .map((candidate) => ({
      ...candidate,
      modelSlug: canonicalModelSlug(candidate.modelSlug),
    }))
    .sort((a, b) => {
      const sourceRank = (source: string) => source === "url"
        ? 5
        : source.startsWith("react")
          ? 4
          : source === "models-api"
            ? 3
            : source === "dom"
              ? 2
              : 1;
      return Number(b.selected) - Number(a.selected)
        || sourceRank(b.source) - sourceRank(a.source)
        || a.modelSlug.localeCompare(b.modelSlug);
    });
  const expectedFamily = performance === "fastest" ? "gpt-5-5" : "gpt-5-6";
  const familyModels = [...new Set(
    ranked
      .map((candidate) => candidate.modelSlug)
      .filter((model) => model === expectedFamily || model.startsWith(`${expectedFamily}-`)),
  )];
  if (familyModels.length === 1) return familyModels[0];

  const evidenceScore = (candidate: typeof ranked[number]): number => {
    const sourceScore = candidate.source === "url"
      ? 60
      : candidate.source.startsWith("react.__reactProps$")
        ? 50
        : candidate.source.startsWith("react.__reactFiber$")
          ? 40
          : candidate.source === "models-api"
            ? 30
            : candidate.source === "dom"
              ? 20
              : 10;
    return sourceScore + (candidate.selected ? 100 : 0);
  };
  const bestScoreByModel = new Map<string, number>();
  for (const candidate of ranked) {
    bestScoreByModel.set(
      candidate.modelSlug,
      Math.max(bestScoreByModel.get(candidate.modelSlug) ?? 0, evidenceScore(candidate)),
    );
  }
  const topScore = Math.max(0, ...bestScoreByModel.values());
  const topModels = [...bestScoreByModel.entries()]
    .filter(([, score]) => score === topScore)
    .map(([model]) => model);
  if (topModels.length === 1) return topModels[0];
  const evidenceCountByModel = new Map<string, number>();
  for (const candidate of ranked) {
    if (!topModels.includes(candidate.modelSlug)) continue;
    evidenceCountByModel.set(
      candidate.modelSlug,
      (evidenceCountByModel.get(candidate.modelSlug) ?? 0) + 1,
    );
  }
  const topEvidenceCount = Math.max(0, ...evidenceCountByModel.values());
  const corroboratedModels = [...evidenceCountByModel.entries()]
    .filter(([, count]) => count === topEvidenceCount)
    .map(([model]) => model);
  if (corroboratedModels.length === 1 && topEvidenceCount >= 2) return corroboratedModels[0];
  if (snapshot.urlModel && matchesChatGptPerformanceLabel(performance, snapshot.urlModel)) {
    return snapshot.urlModel;
  }
  const summary = snapshot.evidence
    .slice(0, 12)
    .map((candidate) => `${candidate.source}:${canonicalModelSlug(candidate.modelSlug)}${candidate.selected ? ":selected" : ""}`)
    .join(", ") || "none";
  throw new Error(
    `Actual ChatGPT model could not be uniquely verified for ${performance}; models-api=${snapshot.apiStatus || "unavailable"}; family=${familyModels.join("|") || "none"}; evidence=${summary}.`,
  );
}

export interface BrowserAutomationTargetCleanupResult {
  closedTargetIds: string[];
  closedOrphanTargetIds: string[];
  prunedTargetIds: string[];
  activeLeaseCount: number;
}

export async function cleanupStaleBrowserAutomationTargets(
  home: string = homedir(),
): Promise<BrowserAutomationTargetCleanupResult> {
  const session = await requireActiveSession(home);
  const pages = await listTargets(session);
  const pageIds = pages.map((page) => page.id);
  const prunedTargetIds = pruneMissingBrowserAutomationTargets(pageIds, home);
  const cleanupOwnerId = `cleanup:${process.pid}:${randomUUID()}`;
  const staleLeases = staleBrowserAutomationTargetLeases(home);
  const closedTargetIds: string[] = [];
  for (const lease of staleLeases) {
    const claim = claimBrowserAutomationTarget({
      targetId: lease.targetId,
      ownerId: cleanupOwnerId,
      kind: lease.kind,
      home,
    });
    if (claim.status !== "claimed" || claim.replacedStaleOwner !== lease.ownerId) continue;
    const closed = await closeBrowserTarget(lease.targetId, home).catch(() => ({
      status: "not-found" as const,
      targetId: lease.targetId,
    }));
    if (closed.status === "closed") closedTargetIds.push(lease.targetId);
    removeBrowserAutomationTarget(lease.targetId, home);
  }

  const remainingPages = await listTargets(session);
  const activeLeases = listBrowserAutomationTargetLeases(home);
  const orphanTargetIds = disposableUnleasedBrowserAutomationTargetIds(
    remainingPages.map((page) => ({ targetId: page.id, url: page.url })),
    activeLeases.map((lease) => lease.targetId),
  );
  const closedOrphanTargetIds: string[] = [];
  const cleanedOrphanTargetIds = new Set<string>();
  for (const targetId of orphanTargetIds) {
    const claim = claimBrowserAutomationTarget({
      targetId,
      ownerId: cleanupOwnerId,
      kind: "ephemeral",
      home,
    });
    if (claim.status !== "claimed") continue;
    const closed = await closeBrowserTarget(targetId, home).catch(() => ({
      status: "not-found" as const,
      targetId,
    }));
    if (closed.status === "closed") closedOrphanTargetIds.push(targetId);
    if (closed.status === "closed" || closed.status === "not-found") cleanedOrphanTargetIds.add(targetId);
    removeBrowserAutomationTarget(targetId, home);
  }
  if (session.targetId && cleanedOrphanTargetIds.has(session.targetId)) {
    const replacementTargetId = remainingPages.find((page) => !cleanedOrphanTargetIds.has(page.id))?.id;
    saveSession({ ...session, targetId: replacementTargetId }, home);
  }
  return {
    closedTargetIds,
    closedOrphanTargetIds,
    prunedTargetIds,
    activeLeaseCount: listBrowserAutomationTargetLeases(home).length,
  };
}

export interface PreferredChatGptTaskTarget {
  targetId: string;
  url: string;
  title: string;
  reusedPreferredTarget: boolean;
  leaseOwnerId: string;
}

export async function acquirePreferredChatGptTaskTarget(
  rawUrl: string,
  home: string = homedir(),
  leaseOwnerId: string = randomUUID(),
): Promise<PreferredChatGptTaskTarget> {
  await cleanupStaleBrowserAutomationTargets(home);
  const policy = loadPolicy(undefined, home);
  const requested = validateBrowserUrl(rawUrl, policy);
  const isExistingConversation = requested.hostname === "chatgpt.com"
    && /(?:^|\/)c\/[^/]+/u.test(requested.pathname);
  if (isExistingConversation) {
    const canonicalPath = (value: string): string => {
      const parsed = new URL(value);
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
    };
    const requestedPath = canonicalPath(requested.toString());
    const session = await requireActiveSession(home);
    const targets = await listTargets(session);
    for (const target of targets) {
      if (target.type !== "page" || !target.webSocketDebuggerUrl) continue;
      let current: Awaited<ReturnType<typeof inspectChatGptConversation>>;
      try {
        current = await inspectChatGptConversation(home, target.id);
      } catch {
        continue;
      }
      if (!current.composerPresent) continue;
      let currentPath: string;
      try {
        currentPath = canonicalPath(current.url);
      } catch {
        continue;
      }
      if (currentPath !== requestedPath) continue;
      const claim = claimBrowserAutomationTarget({
        targetId: target.id,
        ownerId: leaseOwnerId,
        kind: "ephemeral",
        home,
      });
      if (claim.status === "in-use") continue;
      await activateBrowserTarget(target.id, home);
      return {
        targetId: target.id,
        url: current.url,
        title: current.title,
        reusedPreferredTarget: false,
        leaseOwnerId,
      };
    }
  }
  const isNewChatRoot = requested.hostname === "chatgpt.com"
    && requested.pathname === "/"
    && !requested.search;
  if (isNewChatRoot) {
    const session = await requireActiveSession(home);
    const targets = await listTargets(session);
    let usableFallback: {
      target: BrowserTargetInfo;
      current: Awaited<ReturnType<typeof inspectChatGptConversation>>;
    } | undefined;
    for (const target of targets) {
      if (target.type !== "page" || !target.webSocketDebuggerUrl) continue;
      let current: Awaited<ReturnType<typeof inspectChatGptConversation>>;
      try {
        current = await inspectChatGptConversation(home, target.id);
      } catch {
        continue;
      }
      if (
        current.url !== "https://chatgpt.com/"
        || !current.composerPresent
        || current.composerText.trim()
      ) continue;
      usableFallback ??= { target, current };
      if (current.userCount > 0 || current.assistantCount > 0) continue;
      const model = await selectBestAvailableChatGptModel({ home, targetId: target.id }).catch(() => undefined);
      const highPreset = model?.currentLabel === "高い"
        || model?.currentLabel === "High"
        || model?.currentLabel.endsWith(" 高い")
        || model?.currentLabel.endsWith(" High");
      if (
        model?.status !== "selected"
        || !highPreset
        || !model.selectedModel
        || scoreChatGptModel(model.selectedModel) < scoreChatGptModel(CHATGPT_MINIMUM_PREFERRED_MODEL)
      ) continue;
      const claim = claimBrowserAutomationTarget({
        targetId: target.id,
        ownerId: leaseOwnerId,
        kind: "preferred",
        home,
      });
      if (claim.status === "in-use") continue;
      await activateBrowserTarget(target.id, home);
      return {
        targetId: target.id,
        url: current.url,
        title: current.title,
        reusedPreferredTarget: true,
        leaseOwnerId,
      };
    }
    if (usableFallback) {
      await selectBestAvailableChatGptModel({
        home,
        targetId: usableFallback.target.id,
      }).catch(() => undefined);
      await clearChatGptComposer({
        home,
        targetId: usableFallback.target.id,
      });
      const normalized = await inspectChatGptConversation(home, usableFallback.target.id);
      if (!normalized.composerPresent || normalized.composerText.trim()) {
        throw new Error("The dedicated ChatGPT automation tab could not be normalized to an empty composer.");
      }
      const claim = claimBrowserAutomationTarget({
        targetId: usableFallback.target.id,
        ownerId: leaseOwnerId,
        kind: "preferred",
        home,
      });
      if (claim.status === "claimed") {
        await activateBrowserTarget(usableFallback.target.id, home);
        return {
          targetId: usableFallback.target.id,
          url: usableFallback.current.url,
          title: usableFallback.current.title,
          reusedPreferredTarget: true,
          leaseOwnerId,
        };
      }
    }
  }
  const opened = await openBrowserUrlInNewTab(requested.toString(), { home });
  const claim = claimBrowserAutomationTarget({
    targetId: opened.targetId,
    ownerId: leaseOwnerId,
    kind: "ephemeral",
    home,
  });
  if (claim.status === "in-use") {
    await closeBrowserTarget(opened.targetId, home).catch(() => undefined);
    throw new Error(`New browser target was claimed by another job: ${opened.targetId}`);
  }
  return { ...opened, reusedPreferredTarget: false, leaseOwnerId };
}

export async function clearChatGptComposer(
  input: { home?: string; targetId?: string } = {},
): Promise<{ status: "cleared" | "already-empty"; targetId: string }> {
  const home = input.home ?? homedir();
  return await withPageClient(home, async (client, target) => {
    const result = await evaluate<{ found: boolean; hadText: boolean }>(client, `(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const selectors = ${JSON.stringify(CHATGPT_COMPOSER_SELECTORS)};
      const element = selectors
        .map((selector) => Array.from(document.querySelectorAll(selector)).find((candidate) => visible(candidate)))
        .find(Boolean);
      if (!(element instanceof HTMLElement)) return { found: false, hadText: false };
      const currentText = String(element.innerText || element.textContent || element.value || "").trim();
      element.focus();
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        setter?.call(element, "");
      } else {
        element.replaceChildren();
      }
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "deleteContentBackward",
        data: null,
      }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { found: true, hadText: Boolean(currentText) };
    })()`);
    if (!result.found) throw new Error("ChatGPT message composer was not found while clearing draft.");
    return {
      status: result.hadText ? "cleared" as const : "already-empty" as const,
      targetId: target.id,
    };
  }, input.targetId);
}

export async function resetPreferredChatGptTaskTarget(
  targetId: string,
  home: string = homedir(),
): Promise<{ status: "reset" | "not-preferred"; model?: string }> {
  await activateBrowserTarget(targetId, home);
  const point = await withPageClient(home, async (client) => evaluate<{ x: number; y: number } | undefined>(client, `(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && style.display !== "none" && style.visibility !== "hidden";
    };
    const links = Array.from(document.querySelectorAll("a[href='https://chatgpt.com/'],a[href='/']"))
      .filter((candidate) => visible(candidate)
        && /新しいチャット|new chat/i.test(String(candidate.innerText || candidate.getAttribute("aria-label") || "")));
    const link = links.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    if (!(link instanceof HTMLElement)) return undefined;
    const r = link.getBoundingClientRect();
    return { x: Math.round(r.x + Math.min(r.width / 2, 24)), y: Math.round(r.y + r.height / 2) };
  })()`), targetId);
  if (point) {
    await withPageClient(home, async (client) => dispatchClick(client, point.x, point.y), targetId);
  }
  const deadline = Date.now() + 20_000;
  let current = await inspectChatGptConversation(home, targetId);
  while (Date.now() < deadline) {
    current = await inspectChatGptConversation(home, targetId);
    if (
      current.url === "https://chatgpt.com/"
      && current.composerPresent
      && !current.composerText.trim()
      && current.userCount === 0
      && current.assistantCount === 0
    ) break;
    await sleep(250);
  }
  if (
    current.url !== "https://chatgpt.com/"
    || !current.composerPresent
    || current.composerText.trim()
    || current.userCount > 0
    || current.assistantCount > 0
  ) return { status: "not-preferred" };
  const model = await selectBestAvailableChatGptModel({ home, targetId }).catch(() => undefined);
  await sleep(500);
  await clearChatGptComposer({ home, targetId }).catch(() => undefined);
  await sleep(250);
  current = await inspectChatGptConversation(home, targetId);
  if (current.composerText.trim()) {
    await clearChatGptComposer({ home, targetId }).catch(() => undefined);
    await sleep(250);
    current = await inspectChatGptConversation(home, targetId);
  }
  if (current.composerText.trim()) return { status: "not-preferred" };
  const highPreset = model?.currentLabel === "高い"
    || model?.currentLabel === "High"
    || model?.currentLabel.endsWith(" 高い")
    || model?.currentLabel.endsWith(" High");
  if (
    model?.status !== "selected"
    || !highPreset
    || !model.selectedModel
    || scoreChatGptModel(model.selectedModel) < scoreChatGptModel(CHATGPT_MINIMUM_PREFERRED_MODEL)
  ) return { status: "not-preferred" };
  return { status: "reset", model: model.selectedModel };
}

export async function focusChatGptComposer(
  input: { requireEmpty?: boolean; home?: string; targetId?: string } = {},
): Promise<{ targetId: string; x: number; y: number; existingText: string }> {
  const home = input.home ?? homedir();
  return await withPageClient(home, async (client, target) => {
    const location = await evaluate<string>(client, "location.hostname");
    if (location !== "chatgpt.com" && !location.endsWith(".chatgpt.com")) {
      throw new Error(`ChatGPT DOM driver requires chatgpt.com, got ${location || "unknown host"}.`);
    }
    const composer = await evaluate<{ x: number; y: number; existingText: string } | undefined>(client, `(() => {
      const selectors = ${JSON.stringify(CHATGPT_COMPOSER_SELECTORS)};
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const el = selectors.map((selector) => document.querySelector(selector)).find((candidate) => candidate && visible(candidate));
      if (!(el instanceof HTMLElement)) return undefined;
      const r = el.getBoundingClientRect();
      const existingText = String(el.innerText || el.textContent || el.value || "").trim();
      el.focus();
      return {
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        existingText,
      };
    })()`);
    if (!composer) throw new Error("ChatGPT message composer was not found.");
    if ((input.requireEmpty ?? true) && composer.existingText) {
      throw new Error("ChatGPT composer contains an existing draft; refusing to overwrite it.");
    }
    await dispatchClick(client, composer.x, composer.y);
    return { targetId: target.id, ...composer };
  }, input.targetId);
}

export async function submitTrustedChatGptComposer(
  input: { home?: string; targetId?: string } = {},
): Promise<{ status: "pressed"; targetId: string; key: "Enter" }> {
  const home = input.home ?? homedir();
  return await withPageClient(home, async (client, target) => {
    const composer = await evaluate<{ valid: boolean; text: string; host: string }>(client, `(() => {
      const host = location.hostname;
      const composerSelector = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
      const visible = (candidate) => {
        if (!(candidate instanceof HTMLElement)) return false;
        const r = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return r.width > 1 && r.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const active = document.activeElement;
      let element = active instanceof HTMLElement ? active.closest(composerSelector) : null;
      if (!(element instanceof HTMLElement) || !visible(element)) {
        element = Array.from(document.querySelectorAll(composerSelector)).find(visible) || null;
      }
      if (!(element instanceof HTMLElement)) return { valid: false, text: "", host };
      element.focus({ preventScroll: true });
      const text = String(element.innerText || element.textContent || element.value || "").trim();
      return {
        valid: (host === "chatgpt.com" || host.endsWith(".chatgpt.com")) && Boolean(text),
        text,
        host,
      };
    })()`);
    if (!composer.valid) {
      throw new Error(`Trusted ChatGPT submit requires a non-empty focused composer on chatgpt.com; host=${composer.host || "unknown"}.`);
    }
    await dispatchKey(client, "Enter");
    return { status: "pressed" as const, targetId: target.id, key: "Enter" as const };
  }, input.targetId);
}

export function shouldAcceptStableChatGptText(input: {
  generating: boolean;
  stablePolls: number;
  expectedMarker?: string;
}): boolean {
  if (!input.generating) return input.stablePolls >= 1;
  const requiredStablePolls = input.expectedMarker ? 4 : 24;
  return input.stablePolls >= requiredStablePolls;
}

export async function waitForChatGptResponse(
  input: ChatGptResponseWaitInput,
  home: string = homedir(),
): Promise<ChatGptConversationSnapshot> {
  const timeoutMs = Math.min(600_000, Math.max(5_000, input.timeoutMs ?? 180_000));
  const pollIntervalMs = Math.min(5_000, Math.max(250, input.pollIntervalMs ?? 750));
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  let lastImageSignature = "";
  let stablePolls = 0;
  let imageStablePolls = 0;
  let incompleteStablePolls = 0;
  let hydrationAttempts = 0;
  let latest = await inspectChatGptConversation(home, input.targetId);

  while (Date.now() < deadline) {
    if (input.shouldStop?.()) throw new Error("ChatGPT response wait was cancelled.");
    latest = await inspectChatGptConversation(home, input.targetId);
    if (latest.errorText && !latest.generating) {
      throw new Error(`ChatGPT reported an error: ${latest.errorText}`);
    }
    const hasNewAssistant = latest.assistantCount > input.baselineAssistantCount;
    const hasExpectedMarker = !input.expectedMarker || latest.lastAssistantText.includes(input.expectedMarker);
    const baselineImageCount = Math.max(0, input.baselineImageCount ?? 0);
    const expectedImageCount = Math.max(0, input.expectedImageCount ?? 0);
    const newImageCount = Math.max(0, latest.assistantImageUrls.length - baselineImageCount);
    const imageSignature = latest.assistantImageUrls.slice(baselineImageCount).join("\n");
    const imageReady = expectedImageCount > 0
      && newImageCount >= expectedImageCount
      && hasExpectedMarker;
    if (imageReady) {
      imageStablePolls = imageSignature === lastImageSignature ? imageStablePolls + 1 : 0;
      stablePolls = 0;
      incompleteStablePolls = 0;
      lastImageSignature = imageSignature;
      lastText = latest.lastAssistantText;
      const requiredStablePolls = latest.generating ? 4 : 1;
      if (imageStablePolls >= requiredStablePolls) return latest;
    } else if (expectedImageCount === 0 && hasNewAssistant && latest.lastAssistantText && hasExpectedMarker) {
      stablePolls = latest.lastAssistantText === lastText ? stablePolls + 1 : 0;
      imageStablePolls = 0;
      incompleteStablePolls = 0;
      lastText = latest.lastAssistantText;
      if (shouldAcceptStableChatGptText({
        generating: latest.generating,
        stablePolls,
        expectedMarker: input.expectedMarker,
      })) return latest;
    } else {
      imageStablePolls = 0;
      stablePolls = 0;
      const incompleteAndStable = hasNewAssistant
        && !hasExpectedMarker
        && !latest.generating
        && latest.lastAssistantText === lastText;
      incompleteStablePolls = incompleteAndStable ? incompleteStablePolls + 1 : 0;
      lastText = latest.lastAssistantText;
      if (input.targetId && incompleteStablePolls >= 3 && hydrationAttempts < 2) {
        await activateBrowserTarget(input.targetId, home);
        hydrationAttempts += 1;
        incompleteStablePolls = 0;
        await sleep(500);
      }
    }
    await sleep(pollIntervalMs);
  }

  const markerDetail = input.expectedMarker ? ` Expected marker: ${input.expectedMarker}.` : "";
  const imageDetail = input.expectedImageCount
    ? ` Expected ${input.expectedImageCount} new image(s), found ${Math.max(0, latest.assistantImageUrls.length - (input.baselineImageCount ?? 0))}.`
    : "";
  throw new Error(`Timed out waiting for a completed ChatGPT response.${markerDetail}${imageDetail}`);
}

export async function captureBrowserScreenshot(home: string = homedir()): Promise<BrowserScreenshotResult> {
  return await withPageClient(home, async (client, target) => {
    await client.send("Page.enable");
    const [{ data }, page] = await Promise.all([
      client.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      }),
      evaluate<{ url: string; title: string }>(client, `({
        url: location.href,
        title: document.title.slice(0, 300)
      })`),
    ]);
    const artifacts = browserArtifactsDirectory(home);
    ensurePrivateDirectory(artifacts);
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const path = join(artifacts, `browser-${timestamp}.png`);
    writeFileSync(path, Buffer.from(data, "base64"), { mode: 0o600 });
    chmodSync(path, 0o600);
    return {
      targetId: target.id,
      url: page.url,
      title: page.title,
      path,
      mimeType: "image/png",
      base64: data,
    };
  });
}

async function elementAtPoint(
  client: CdpClient,
  x: number,
  y: number,
): Promise<BrowserElementDescriptor | undefined> {
  return await evaluate<BrowserElementDescriptor | undefined>(client, `(() => {
    const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    if (!el) return undefined;
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 240);
    const anchor = el.closest("a");
    return {
      tag: el.tagName.toLowerCase(),
      type: clean(el.getAttribute("type")),
      role: clean(el.getAttribute("role")),
      text: clean(el.innerText || el.textContent),
      ariaLabel: clean(el.getAttribute("aria-label")),
      name: clean(el.getAttribute("name")),
      href: anchor instanceof HTMLAnchorElement ? clean(anchor.href) : "",
      download: anchor instanceof HTMLAnchorElement && anchor.hasAttribute("download"),
    };
  })()`);
}

export function classifyBrowserElementRisk(
  element: BrowserElementDescriptor,
  policy: ComputerUsePolicy,
): { category: BrowserApprovalCategory; reason: string } | undefined {
  const text = [element.text, element.ariaLabel, element.name, element.type, element.role]
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase();
  const checks: Array<[BrowserApprovalCategory, boolean, RegExp, string]> = [
    ["upload", policy.confirmations.upload, /(?:upload|アップロード|添付)/u, "The element appears to upload a file."],
    ["download", policy.confirmations.download, /(?:download|ダウンロード)/u, "The element appears to download a file."],
    ["purchase", policy.confirmations.purchase, /(?:buy|purchase|checkout|pay|order|購入|注文|決済|支払)/u, "The element appears to make or advance a purchase."],
    ["delete", policy.confirmations.delete, /(?:delete|remove|destroy|erase|削除|消去|退会)/u, "The element appears to delete or remove data."],
    ["login", policy.confirmations.login, /(?:log\s*in|sign\s*in|ログイン|サインイン)/u, "The element appears to start or submit a login."],
    ["externalCommunication", policy.confirmations.externalCommunication, /(?:send|publish|post|share|送信|投稿|公開|共有)/u, "The element appears to communicate externally."],
  ];
  if (element.type.toLocaleLowerCase() === "file" && policy.confirmations.upload) {
    return { category: "upload", reason: "The element is a file input." };
  }
  if (element.download && policy.confirmations.download) {
    return { category: "download", reason: "The element has a download action." };
  }
  for (const [category, enabled, pattern, reason] of checks) {
    if (enabled && pattern.test(text)) return { category, reason };
  }
  if (policy.confirmations.submit && element.type.toLocaleLowerCase() === "submit") {
    return { category: "submit", reason: "The element is a form submit control." };
  }
  return undefined;
}

function readApprovals(home: string = homedir()): BrowserApprovalRecord[] {
  const path = browserApprovalsPath(home);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw as BrowserApprovalRecord[] : [];
  } catch {
    return [];
  }
}

function saveApprovals(records: BrowserApprovalRecord[], home: string = homedir()): void {
  const now = Date.now();
  const normalized = records
    .map((record) => record.status === "pending" && Date.parse(record.expiresAt) <= now
      ? { ...record, status: "expired" as const }
      : record)
    .slice(-MAX_APPROVALS);
  writePrivateJson(browserApprovalsPath(home), normalized);
}

function createApproval(
  input: Omit<BrowserApprovalRecord, "id" | "status" | "createdAt" | "expiresAt">,
  home: string,
): BrowserApprovalRecord {
  const createdAt = new Date();
  const record: BrowserApprovalRecord = {
    ...input,
    id: `approval_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    status: "pending",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + APPROVAL_TTL_MS).toISOString(),
  };
  saveApprovals([...readApprovals(home), record], home);
  return record;
}

export function listBrowserApprovals(home: string = homedir()): BrowserApprovalRecord[] {
  const approvals = readApprovals(home);
  saveApprovals(approvals, home);
  return readApprovals(home).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function dispatchClick(client: CdpClient, x: number, y: number): Promise<void> {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function clickBrowserPoint(
  x: number,
  y: number,
  input: { policyPath?: string; home?: string } = {},
): Promise<
  | { status: "clicked"; targetId: string; element?: BrowserElementDescriptor }
  | { status: "approval-required"; approval: BrowserApprovalRecord }
> {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 20_000 || y > 20_000) {
    throw new Error("Browser click coordinates are invalid.");
  }
  const home = input.home ?? homedir();
  const policy = loadPolicy(input.policyPath, home);
  return await withPageClient(home, async (client, target) => {
    const element = await elementAtPoint(client, x, y);
    if (element?.href) validateBrowserUrl(element.href, policy);
    const risk = element ? classifyBrowserElementRisk(element, policy) : undefined;
    if (risk) {
      return {
        status: "approval-required" as const,
        approval: createApproval({
          category: risk.category,
          reason: risk.reason,
          action: { kind: "click", targetId: target.id, x, y },
          element,
        }, home),
      };
    }
    await dispatchClick(client, x, y);
    return { status: "clicked" as const, targetId: target.id, element };
  });
}

export async function typeBrowserText(
  text: string,
  home: string = homedir(),
  targetId?: string,
): Promise<{ status: "typed"; targetId: string; characters: number }> {
  if (!text || text.length > 4_000) throw new Error("Browser text must contain 1 to 4000 characters.");
  return await withPageClient(home, async (client, target) => {
    const active = await evaluate<{
      tag: string;
      type: string;
      name: string;
      autocomplete: string;
      editable: boolean;
      formHasPassword: boolean;
    }>(client, `(() => {
      const editableSelector = "input,textarea,[contenteditable]:not([contenteditable='false']),[role='textbox']";
      const composerSelector = ${JSON.stringify(CHATGPT_COMPOSER_SELECTOR)};
      const visible = (candidate) => {
        if (!(candidate instanceof HTMLElement)) return false;
        const r = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return r.width > 1 && r.height > 1 && style.display !== "none" && style.visibility !== "hidden";
      };
      const focused = document.activeElement;
      let el = focused instanceof HTMLElement ? focused.closest(editableSelector) : null;
      const host = location.hostname;
      if (!(el instanceof HTMLElement)
        && (host === "chatgpt.com" || host.endsWith(".chatgpt.com"))) {
        const composer = Array.from(document.querySelectorAll(composerSelector)).find(visible);
        if (composer instanceof HTMLElement) {
          composer.focus({ preventScroll: true });
          el = composer.closest(editableSelector) || composer;
        }
      }
      const form = el instanceof HTMLElement ? el.closest("form") : null;
      return {
        tag: el instanceof HTMLElement ? el.tagName.toLowerCase() : "",
        type: el instanceof HTMLInputElement ? String(el.type || "").toLowerCase() : "",
        name: el instanceof HTMLElement ? String(el.getAttribute("name") || "").toLowerCase() : "",
        autocomplete: el instanceof HTMLElement ? String(el.getAttribute("autocomplete") || "").toLowerCase() : "",
        editable: el instanceof HTMLInputElement
          || el instanceof HTMLTextAreaElement
          || Boolean(el instanceof HTMLElement && (
            el.isContentEditable
            || ((host === "chatgpt.com" || host.endsWith(".chatgpt.com")) && el.getAttribute("role") === "textbox")
          )),
        formHasPassword: Boolean(form && form.querySelector("input[type='password']")),
      };
    })()`);
    const secretLike = active.type === "password"
      || active.autocomplete.includes("password")
      || /(?:password|passwd|secret|token|api.?key)/u.test(active.name)
      || (active.formHasPassword && (active.type === "email" || active.autocomplete.includes("email")));
    if (secretLike) {
      throw new Error("GPT-Agent will not type credentials. Enter login credentials manually in the isolated browser.");
    }
    if (!active.editable) {
      throw new Error("No editable input, textarea, or contenteditable element is focused.");
    }
    await client.send("Input.insertText", { text });
    return { status: "typed" as const, targetId: target.id, characters: text.length };
  }, targetId);
}

const allowedKeys = new Map<string, { key: string; code: string; windowsVirtualKeyCode: number }>([
  ["Tab", { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }],
  ["Escape", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }],
  ["Backspace", { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }],
  ["ArrowUp", { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 }],
  ["ArrowDown", { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }],
  ["ArrowLeft", { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 }],
  ["ArrowRight", { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }],
  ["Enter", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }],
]);

async function dispatchKey(client: CdpClient, key: string): Promise<void> {
  const descriptor = allowedKeys.get(key);
  if (!descriptor) throw new Error(`Unsupported browser key: ${key}`);
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...descriptor });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...descriptor });
}

async function dispatchBrowserShortcut(
  client: CdpClient,
  descriptor: {
    key: string;
    code: string;
    windowsVirtualKeyCode: number;
    modifiers: number;
  },
): Promise<void> {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...descriptor,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...descriptor,
  });
}

export async function pressBrowserKey(
  key: string,
  input: { policyPath?: string; home?: string; targetId?: string } = {},
): Promise<
  | { status: "pressed"; targetId: string; key: string }
  | { status: "approval-required"; approval: BrowserApprovalRecord }
> {
  if (!allowedKeys.has(key)) throw new Error(`Unsupported browser key: ${key}`);
  const home = input.home ?? homedir();
  const policy = loadPolicy(input.policyPath, home);
  return await withPageClient(home, async (client, target) => {
    if (key === "Enter" && policy.confirmations.submit) {
      return {
        status: "approval-required" as const,
        approval: createApproval({
          category: "submit",
          reason: "Enter may submit the active form.",
          action: { kind: "key", targetId: target.id, key: "Enter" },
        }, home),
      };
    }
    await dispatchKey(client, key);
    return { status: "pressed" as const, targetId: target.id, key };
  }, input.targetId);
}

export async function scrollBrowserPage(
  deltaX: number,
  deltaY: number,
  home: string = homedir(),
): Promise<{ status: "scrolled"; targetId: string; deltaX: number; deltaY: number }> {
  if (![deltaX, deltaY].every(Number.isFinite) || Math.abs(deltaX) > 20_000 || Math.abs(deltaY) > 20_000) {
    throw new Error("Browser scroll delta is invalid.");
  }
  return await withPageClient(home, async (client, target) => {
    const viewport = await evaluate<{ width: number; height: number }>(client, `({
      width: window.innerWidth,
      height: window.innerHeight
    })`);
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.max(1, Math.round(viewport.width / 2)),
      y: Math.max(1, Math.round(viewport.height / 2)),
      deltaX,
      deltaY,
    });
    return { status: "scrolled" as const, targetId: target.id, deltaX, deltaY };
  });
}

export async function approveBrowserAction(
  id: string,
  input: { home?: string; localApproval: boolean },
): Promise<BrowserApprovalRecord> {
  if (!input.localApproval) {
    throw new Error("Browser approvals require an explicit action in the local GPT-Agent Tool app.");
  }
  const home = input.home ?? homedir();
  const approvals = listBrowserApprovals(home);
  const index = approvals.findIndex((approval) => approval.id === id);
  if (index < 0) throw new Error(`Unknown browser approval: ${id}`);
  const approval = approvals[index]!;
  if (approval.status !== "pending") throw new Error(`Browser approval is not pending: ${approval.status}`);
  if (Date.parse(approval.expiresAt) <= Date.now()) {
    approvals[index] = { ...approval, status: "expired" };
    saveApprovals(approvals, home);
    throw new Error("Browser approval has expired.");
  }
  await withPageClient(home, async (client, target) => {
    if (target.id !== approval.action.targetId) {
      throw new Error("Browser target changed after approval was requested.");
    }
    if (approval.action.kind === "click") {
      await dispatchClick(client, approval.action.x, approval.action.y);
    } else {
      await dispatchKey(client, approval.action.key);
    }
  });
  const executed: BrowserApprovalRecord = {
    ...approval,
    status: "executed",
    executedAt: new Date().toISOString(),
  };
  approvals[index] = executed;
  saveApprovals(approvals, home);
  return executed;
}

export function cancelBrowserApproval(id: string, home: string = homedir()): BrowserApprovalRecord {
  const approvals = listBrowserApprovals(home);
  const index = approvals.findIndex((approval) => approval.id === id);
  if (index < 0) throw new Error(`Unknown browser approval: ${id}`);
  const approval = approvals[index]!;
  if (approval.status !== "pending") throw new Error(`Browser approval is not pending: ${approval.status}`);
  const cancelled: BrowserApprovalRecord = { ...approval, status: "cancelled" };
  approvals[index] = cancelled;
  saveApprovals(approvals, home);
  return cancelled;
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      this.rejectAll(new Error("CDP WebSocket closed."));
    });
    socket.addEventListener("error", () => {
      this.rejectAll(new Error("CDP WebSocket error."));
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => {
        socket.close();
        rejectOpen(new Error("Timed out connecting to the browser CDP endpoint."));
      }, 5_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectOpen(new Error("Failed to connect to the browser CDP endpoint."));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const id = this.nextId++;
    return await new Promise<T>((resolveSend, rejectSend) => {
      const timeoutMs = method === "Runtime.evaluate" ? 30_000 : method === "Page.navigate" ? 12_000 : 10_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolveSend,
        reject: rejectSend,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
    this.rejectAll(new Error("CDP client closed."));
  }

  private async handleMessage(data: unknown): Promise<void> {
    const text = await websocketDataToText(data);
    let payload: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      return;
    }
    if (!payload.id) return;
    const pending = this.pending.get(payload.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(payload.id);
    if (payload.error) {
      pending.reject(new Error(payload.error.message ?? "CDP command failed."));
      return;
    }
    pending.resolve(payload.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function websocketDataToText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) return await data.text();
  return String(data);
}

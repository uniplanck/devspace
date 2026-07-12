import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  findSupportedBrowser,
  loadComputerUsePolicy,
  type ComputerUsePolicy,
  validateBrowserUrl,
} from "./computer-use.js";

export interface BrowserSessionRecord {
  schemaVersion: 1;
  pid: number;
  port: number;
  browserName: string;
  browserExecutable: string;
  browserWebSocketPath: string;
  profileDirectory: string;
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
}

export interface ChatGptResponseWaitInput {
  baselineAssistantCount: number;
  expectedMarker?: string;
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
    return raw;
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

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
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
  if (!processExists(session.pid)) return false;
  try {
    await fetchJson<Record<string, unknown>>(`${cdpOrigin(session)}/json/version`);
    return true;
  } catch {
    return false;
  }
}

export async function browserStatus(home: string = homedir()): Promise<{
  active: boolean;
  session?: BrowserSessionRecord;
  pages: BrowserTargetInfo[];
}> {
  const session = readSession(home);
  if (!session || !await sessionResponds(session)) {
    if (session) clearSession(home);
    return { active: false, pages: [] };
  }
  const pages = await listTargets(session);
  return { active: true, session, pages };
}

export async function startBrowserSession(input: {
  policyPath?: string;
  home?: string;
} = {}): Promise<{ status: "started" | "already-running"; session: BrowserSessionRecord }> {
  const home = input.home ?? homedir();
  const policy = loadPolicy(input.policyPath, home);
  const existing = readSession(home);
  if (existing && await sessionResponds(existing)) {
    return { status: "already-running", session: existing };
  }
  if (existing) clearSession(home);

  const browser = findSupportedBrowser();
  if (!browser) throw new Error("Brave, Chrome, or Chromium was not found.");
  const profileDirectory = resolve(policy.browser.profileDirectory);
  ensurePrivateDirectory(profileDirectory);
  rmSync(join(profileDirectory, "DevToolsActivePort"), { force: true });

  const child = spawn(browser.path, [
    `--user-data-dir=${profileDirectory}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-popup-blocking=false",
    "--disable-save-password-bubble",
    "--disable-features=AutofillServerCommunication,MediaRouter,PasswordManagerOnboarding,Translate",
    "about:blank",
  ], {
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
    pid: child.pid,
    port,
    browserName: browser.name,
    browserExecutable: browser.path,
    browserWebSocketPath,
    profileDirectory,
    startedAt: new Date().toISOString(),
  };
  saveSession(session, home);

  const browserClient = await CdpClient.connect(`ws://127.0.0.1:${port}${browserWebSocketPath}`);
  try {
    const downloadDirectory = resolve(policy.browser.downloadDirectory);
    if (policy.browser.allowDownloads) ensurePrivateDirectory(downloadDirectory);
    await browserClient.send("Browser.setDownloadBehavior", {
      behavior: policy.browser.allowDownloads ? "allow" : "deny",
      ...(policy.browser.allowDownloads ? { downloadPath: downloadDirectory, eventsEnabled: true } : {}),
    });
  } finally {
    browserClient.close();
  }
  return { status: "started", session };
}

export interface BrowserDownloadDirectoryResult {
  path: string;
  relativePath: string;
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
  const browser = findSupportedBrowser();
  if (!browser) throw new Error("Brave, Chrome, or Chromium was not found.");
  const profileDirectory = resolve(policy.browser.profileDirectory);
  ensurePrivateDirectory(profileDirectory);
  const child = spawn(browser.path, [
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
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
  if (!session || !await sessionResponds(session)) {
    if (session) clearSession(home);
    throw new Error("Browser Computer Use session is not running.");
  }
  return session;
}

async function listTargets(session: BrowserSessionRecord): Promise<BrowserTargetInfo[]> {
  const targets = await fetchJson<BrowserTargetInfo[]>(`${cdpOrigin(session)}/json/list`);
  return targets.filter((target) => target.type === "page");
}

async function createBlankTarget(session: BrowserSessionRecord): Promise<BrowserTargetInfo> {
  return await fetchJson<BrowserTargetInfo>(`${cdpOrigin(session)}/json/new?about%3Ablank`, {
    method: "PUT",
  });
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

export async function openBrowserUrl(
  rawUrl: string,
  input: { policyPath?: string; home?: string } = {},
): Promise<{ targetId: string; url: string; title: string }> {
  const home = input.home ?? homedir();
  const policy = loadPolicy(input.policyPath, home);
  const requested = validateBrowserUrl(rawUrl, policy);
  return await withPageClient(home, async (client, target) => {
    await client.send("Page.enable");
    const navigation = await client.send<{ errorText?: string }>("Page.navigate", { url: requested.toString() });
    if (navigation.errorText) throw new Error(`Browser navigation failed: ${navigation.errorText}`);
    await waitForDocument(client);
    const page = await evaluate<{ url: string; title: string }>(client, `({
      url: location.href,
      title: document.title.slice(0, 300)
    })`);
    try {
      validateBrowserUrl(page.url, policy);
    } catch (error) {
      await client.send("Page.navigate", { url: "about:blank" });
      throw new Error(`Navigation left the allowlist and was stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { targetId: target.id, url: page.url, title: page.title };
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
    const navigation = await client.send<{ errorText?: string }>("Page.navigate", { url: requested.toString() });
    if (navigation.errorText) throw new Error(`Browser navigation failed: ${navigation.errorText}`);
    await waitForDocument(client);
    const page = await evaluate<{ url: string; title: string }>(client, `({
      url: location.href,
      title: document.title.slice(0, 300)
    })`);
    validateBrowserUrl(page.url, policy);
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
  if (!pages.some((page) => page.id === targetId)) return { status: "not-found", targetId };
  const browserClient = await CdpClient.connect(
    `ws://127.0.0.1:${session.port}${session.browserWebSocketPath}`,
  );
  try {
    await browserClient.send("Target.closeTarget", { targetId });
  } finally {
    browserClient.close();
  }
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
  const browserClient = await CdpClient.connect(
    `ws://127.0.0.1:${session.port}${session.browserWebSocketPath}`,
  );
  try {
    await browserClient.send("Target.activateTarget", { targetId });
  } finally {
    browserClient.close();
  }
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
      const composer = document.querySelector(
        "#prompt-textarea,[data-testid='composer-input'],[contenteditable='true'][role='textbox'],textarea[placeholder]"
      );
      const stopButton = document.querySelector(
        "button[data-testid='stop-button'],button[aria-label*='Stop'],button[aria-label*='停止']"
      );
      const error = document.querySelector(
        "[data-testid='conversation-turn-error'],[role='alert']"
      );
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
      };
    })()`);
    return { targetId: target.id, ...page };
  }, targetId);
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
      const selectors = [
        "#prompt-textarea",
        "[data-testid='composer-input']",
        "[contenteditable='true'][role='textbox']",
        "textarea[placeholder]"
      ];
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

export async function waitForChatGptResponse(
  input: ChatGptResponseWaitInput,
  home: string = homedir(),
): Promise<ChatGptConversationSnapshot> {
  const timeoutMs = Math.min(600_000, Math.max(5_000, input.timeoutMs ?? 180_000));
  const pollIntervalMs = Math.min(5_000, Math.max(250, input.pollIntervalMs ?? 750));
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  let stablePolls = 0;
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
    if (hasNewAssistant && latest.lastAssistantText && hasExpectedMarker && !latest.generating) {
      stablePolls = latest.lastAssistantText === lastText ? stablePolls + 1 : 0;
      incompleteStablePolls = 0;
      lastText = latest.lastAssistantText;
      if (stablePolls >= 1) return latest;
    } else {
      stablePolls = 0;
      const incompleteAndStable = hasNewAssistant
        && Boolean(latest.lastAssistantText)
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
  throw new Error(`Timed out waiting for a completed ChatGPT response.${markerDetail}`);
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
      const focused = document.activeElement;
      const el = focused instanceof HTMLElement
        ? focused.closest("input,textarea,[contenteditable]:not([contenteditable='false'])")
        : null;
      const form = el instanceof HTMLElement ? el.closest("form") : null;
      return {
        tag: el instanceof HTMLElement ? el.tagName.toLowerCase() : "",
        type: el instanceof HTMLInputElement ? String(el.type || "").toLowerCase() : "",
        name: el instanceof HTMLElement ? String(el.getAttribute("name") || "").toLowerCase() : "",
        autocomplete: el instanceof HTMLElement ? String(el.getAttribute("autocomplete") || "").toLowerCase() : "",
        editable: el instanceof HTMLInputElement
          || el instanceof HTMLTextAreaElement
          || Boolean(el instanceof HTMLElement && el.isContentEditable),
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`CDP command timed out: ${method}`));
      }, 10_000);
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

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export interface ComputerUsePolicy {
  schemaVersion: 1;
  enabled: boolean;
  browser: {
    enabled: boolean;
    allowedDomains: string[];
    profileDirectory: string;
    downloadDirectory: string;
    allowDownloads: boolean;
    backgroundMode: "headless" | "background-window" | "window";
  };
  desktop: {
    enabled: boolean;
    allowedApplications: string[];
  };
  confirmations: {
    login: boolean;
    submit: boolean;
    upload: boolean;
    download: boolean;
    purchase: boolean;
    delete: boolean;
    externalCommunication: boolean;
  };
}

export interface ComputerUseDoctorResult {
  platform: NodeJS.Platform;
  policyPath: string;
  policyExists: boolean;
  policyValid: boolean;
  enabled: boolean;
  browser: {
    enabled: boolean;
    executable?: string;
    name?: string;
    adapter: "native-cdp";
    nativeCdpAvailable: boolean;
    playwrightAvailable: boolean;
    allowedDomainCount: number;
    profileDirectory: string;
    downloadDirectory: string;
    backgroundMode: "headless" | "background-window" | "window";
    ready: boolean;
  };
  desktop: {
    enabled: boolean;
    screenCaptureTool: boolean;
    accessibilityTool: boolean;
    allowedApplicationCount: number;
    permissions: "requires-user-approval" | "not-requested";
    ready: boolean;
  };
  safety: {
    confirmationsRequired: string[];
    credentialsStoredByGPTAgent: false;
    isolatedBrowserProfile: true;
  };
  missingRequirements: string[];
  diagnostics: string[];
}

export const browserCandidates = [
  {
    name: "Brave Browser",
    path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  },
  {
    name: "Google Chrome",
    path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  },
  {
    name: "Chromium",
    path: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  },
] as const;

export function chromeForTestingExecutable(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const override = process.env.DEVSPACE_CHROME_FOR_TESTING_EXECUTABLE?.trim();
  if (override) return resolve(expandHome(override, home));
  const root = join(home, ".devspace", "browsers", "chrome-for-testing", "current");
  if (platform === "darwin") {
    return join(root, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  }
  if (platform === "linux") return join(root, "chrome");
  return undefined;
}

export function findAutomationBrowser(
  fileExists: (path: string) => boolean = existsSync,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): { name: string; path: string } | undefined {
  const managedExecutables = [...new Set([home, homedir()])]
    .map((candidateHome) => chromeForTestingExecutable(candidateHome, platform))
    .filter((path): path is string => Boolean(path));
  const candidates = [
    ...managedExecutables.map((path) => ({ name: "Chrome for Testing", path })),
    ...(platform === "darwin" ? [{
      name: "Chrome for Testing",
      path: "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    }] : []),
  ];
  return candidates.find((candidate) => fileExists(candidate.path));
}

export function computerUsePolicyPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return resolve(env.DEVSPACE_COMPUTER_USE_POLICY ?? join(home, ".devspace", "computer-use.json"));
}

export function defaultComputerUsePolicy(home: string = homedir()): ComputerUsePolicy {
  return {
    schemaVersion: 1,
    enabled: false,
    browser: {
      enabled: false,
      allowedDomains: [],
      profileDirectory: join(home, ".devspace", "chrome-for-testing-profile"),
      downloadDirectory: join(home, "Downloads", "GPT-Agent"),
      allowDownloads: false,
      backgroundMode: "headless",
    },
    desktop: {
      enabled: false,
      allowedApplications: [],
    },
    confirmations: {
      login: true,
      submit: true,
      upload: true,
      download: true,
      purchase: true,
      delete: true,
      externalCommunication: true,
    },
  };
}

export function initializeComputerUsePolicy(
  path: string = computerUsePolicyPath(),
  home: string = homedir(),
): { path: string; created: boolean; policy: ComputerUsePolicy } {
  const absolutePath = resolve(path);
  if (existsSync(absolutePath)) {
    const loaded = loadComputerUsePolicy(absolutePath, home);
    if (!loaded.valid) throw new Error(`Existing Computer Use policy is invalid: ${loaded.error}`);
    return { path: absolutePath, created: false, policy: loaded.policy };
  }
  mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
  const policy = defaultComputerUsePolicy(home);
  writeFileSync(absolutePath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(absolutePath, 0o600);
  return { path: absolutePath, created: true, policy };
}

export function enableChatGptBrowserPolicy(
  path: string = computerUsePolicyPath(),
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): { path: string; policy: ComputerUsePolicy } {
  const absolutePath = resolve(path);
  const loaded = loadComputerUsePolicy(absolutePath, home);
  if (!loaded.valid) throw new Error(`Computer Use policy is invalid: ${loaded.error}`);
  const policy: ComputerUsePolicy = {
    ...loaded.policy,
    enabled: true,
    browser: {
      ...loaded.policy.browser,
      enabled: true,
      allowedDomains: ["chatgpt.com"],
      profileDirectory: join(home, ".devspace", "chrome-for-testing-profile"),
      downloadDirectory: join(home, "Downloads", "GPT-Agent"),
      allowDownloads: true,
      backgroundMode: platform === "darwin" ? "background-window" : "headless",
    },
    desktop: {
      ...loaded.policy.desktop,
      enabled: false,
      allowedApplications: [],
    },
    confirmations: {
      login: true,
      submit: true,
      upload: true,
      download: true,
      purchase: true,
      delete: true,
      externalCommunication: true,
    },
  };
  mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
  writeFileSync(absolutePath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  chmodSync(absolutePath, 0o600);
  return { path: absolutePath, policy };
}

export function loadComputerUsePolicy(
  path: string = computerUsePolicyPath(),
  home: string = homedir(),
): { exists: boolean; valid: true; policy: ComputerUsePolicy } | { exists: true; valid: false; policy: ComputerUsePolicy; error: string } {
  const absolutePath = resolve(path);
  const fallback = defaultComputerUsePolicy(home);
  if (!existsSync(absolutePath)) return { exists: false, valid: true, policy: fallback };
  try {
    const raw = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
    return { exists: true, valid: true, policy: validatePolicy(raw, home) };
  } catch (error) {
    return {
      exists: true,
      valid: false,
      policy: fallback,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function diagnoseComputerUse(input: {
  policyPath?: string;
  home?: string;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
  packageAvailable?: (name: string) => boolean;
} = {}): ComputerUseDoctorResult {
  const home = input.home ?? homedir();
  const platform = input.platform ?? process.platform;
  const path = input.policyPath ?? computerUsePolicyPath(process.env, home);
  const fileExists = input.fileExists ?? existsSync;
  const packageAvailable = input.packageAvailable ?? isPackageAvailable;
  const loaded = loadComputerUsePolicy(path, home);
  const policy = loaded.policy;
  const browser = findAutomationBrowser(fileExists, home, platform);
  const playwrightAvailable = packageAvailable("playwright") || packageAvailable("playwright-core");
  const nativeCdpAvailable = typeof WebSocket === "function" && typeof fetch === "function";
  const screenCaptureTool = fileExists("/usr/sbin/screencapture") || fileExists("/usr/bin/screencapture");
  const accessibilityTool = fileExists("/usr/bin/osascript");
  const missingRequirements: string[] = [];
  const diagnostics: string[] = [];

  if (!loaded.exists) missingRequirements.push("Initialize the Computer Use policy file.");
  if (!loaded.valid) missingRequirements.push("Repair the invalid Computer Use policy file.");
  if (!policy.enabled) diagnostics.push("Computer Use is disabled by policy.");
  if (!browser) {
    missingRequirements.push("Install Chrome for Testing with npm run browser:install:chrome-for-testing.");
  }
  if (!nativeCdpAvailable) missingRequirements.push("Node.js WebSocket/fetch support is required for the native CDP adapter.");
  if (policy.browser.enabled && policy.browser.allowedDomains.length === 0) {
    missingRequirements.push("Add at least one allowed browser domain.");
  }
  if (platform !== "darwin") diagnostics.push("Desktop Computer Use foundation currently targets macOS.");
  if (!screenCaptureTool) missingRequirements.push("macOS screen capture tool was not found.");
  if (!accessibilityTool) missingRequirements.push("macOS automation tool was not found.");
  if (policy.desktop.enabled && policy.desktop.allowedApplications.length === 0) {
    missingRequirements.push("Add at least one allowed desktop application.");
  }

  const confirmationsRequired = Object.entries(policy.confirmations)
    .filter(([, required]) => required)
    .map(([name]) => name);
  const browserReady = Boolean(
    loaded.valid
    && policy.enabled
    && policy.browser.enabled
    && browser
    && nativeCdpAvailable
    && policy.browser.allowedDomains.length > 0,
  );
  const desktopReady = Boolean(
    loaded.valid
    && policy.enabled
    && policy.desktop.enabled
    && platform === "darwin"
    && screenCaptureTool
    && accessibilityTool
    && policy.desktop.allowedApplications.length > 0,
  );

  return {
    platform,
    policyPath: resolve(path),
    policyExists: loaded.exists,
    policyValid: loaded.valid,
    enabled: loaded.valid && policy.enabled,
    browser: {
      enabled: policy.browser.enabled,
      executable: browser?.path,
      name: browser?.name,
      adapter: "native-cdp",
      nativeCdpAvailable,
      playwrightAvailable,
      allowedDomainCount: policy.browser.allowedDomains.length,
      profileDirectory: resolve(expandHome(policy.browser.profileDirectory, home)),
      downloadDirectory: resolve(expandHome(policy.browser.downloadDirectory, home)),
      backgroundMode: policy.browser.backgroundMode,
      ready: browserReady,
    },
    desktop: {
      enabled: policy.desktop.enabled,
      screenCaptureTool,
      accessibilityTool,
      allowedApplicationCount: policy.desktop.allowedApplications.length,
      permissions: policy.desktop.enabled ? "requires-user-approval" : "not-requested",
      ready: desktopReady,
    },
    safety: {
      confirmationsRequired,
      credentialsStoredByGPTAgent: false,
      isolatedBrowserProfile: true,
    },
    missingRequirements,
    diagnostics,
  };
}

function validatePolicy(value: unknown, home: string): ComputerUsePolicy {
  if (!isRecord(value)) throw new Error("Policy must be a JSON object.");
  if (value.schemaVersion !== 1) throw new Error("Unsupported policy schemaVersion.");
  if (!isRecord(value.browser) || !isRecord(value.desktop) || !isRecord(value.confirmations)) {
    throw new Error("Policy browser, desktop, and confirmations sections are required.");
  }
  const domains = readStringArray(value.browser.allowedDomains, "browser.allowedDomains", 100)
    .map(normalizeDomain);
  const applications = readStringArray(value.desktop.allowedApplications, "desktop.allowedApplications", 100)
    .map((application) => application.slice(0, 200));
  const profileDirectory = resolve(expandHome(
    readString(value.browser.profileDirectory, "browser.profileDirectory"),
    home,
  ));
  const downloadDirectory = resolve(expandHome(
    typeof value.browser.downloadDirectory === "string"
      ? value.browser.downloadDirectory
      : join(home, "Downloads", "GPT-Agent"),
    home,
  ));
  const computerStateRoot = resolve(join(home, ".devspace"));
  if (profileDirectory !== computerStateRoot && !profileDirectory.startsWith(`${computerStateRoot}${sep}`)) {
    throw new Error("browser.profileDirectory must remain inside ~/.devspace.");
  }
  const downloadsRoot = resolve(join(home, "Downloads"));
  if (downloadDirectory !== downloadsRoot && !downloadDirectory.startsWith(`${downloadsRoot}${sep}`)) {
    throw new Error("browser.downloadDirectory must remain inside ~/Downloads.");
  }
  const confirmations = value.confirmations;

  return {
    schemaVersion: 1,
    enabled: readBoolean(value.enabled, "enabled"),
    browser: {
      enabled: readBoolean(value.browser.enabled, "browser.enabled"),
      allowedDomains: [...new Set(domains)],
      profileDirectory,
      downloadDirectory,
      allowDownloads: readBoolean(value.browser.allowDownloads, "browser.allowDownloads"),
      backgroundMode: readBackgroundMode(value.browser.backgroundMode),
    },
    desktop: {
      enabled: readBoolean(value.desktop.enabled, "desktop.enabled"),
      allowedApplications: [...new Set(applications)],
    },
    confirmations: {
      login: readBoolean(confirmations.login, "confirmations.login"),
      submit: readBoolean(confirmations.submit, "confirmations.submit"),
      upload: readBoolean(confirmations.upload, "confirmations.upload"),
      download: readBoolean(confirmations.download, "confirmations.download"),
      purchase: readBoolean(confirmations.purchase, "confirmations.purchase"),
      delete: readBoolean(confirmations.delete, "confirmations.delete"),
      externalCommunication: readBoolean(
        confirmations.externalCommunication,
        "confirmations.externalCommunication",
      ),
    },
  };
}

export function findSupportedBrowser(
  fileExists: (path: string) => boolean = existsSync,
): { name: string; path: string } | undefined {
  return browserCandidates.find((candidate) => fileExists(candidate.path));
}

export function isAllowedBrowserHost(hostname: string, allowedDomains: string[]): boolean {
  const normalized = hostname.normalize("NFKC").trim().toLocaleLowerCase().replace(/\.$/u, "");
  return allowedDomains.some((domain) => {
    const allowed = normalizeDomain(domain);
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(2);
      return normalized !== suffix && normalized.endsWith(`.${suffix}`);
    }
    return normalized === allowed;
  });
}

export function validateBrowserUrl(rawUrl: string, policy: ComputerUsePolicy): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Browser URL must be an absolute URL.");
  }
  if (url.username || url.password) throw new Error("Credentials must not be embedded in browser URLs.");
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
    throw new Error("Browser navigation requires HTTPS, except for loopback development URLs.");
  }
  if (!isAllowedBrowserHost(url.hostname, policy.browser.allowedDomains)) {
    throw new Error(`Browser domain is not allowed by policy: ${url.hostname}`);
  }
  url.hash = "";
  return url;
}

function normalizeDomain(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
  if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(normalized)) {
    throw new Error(`Invalid allowed domain: ${value}`);
  }
  return normalized;
}

function readStringArray(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of at most ${max} strings.`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function readBackgroundMode(value: unknown): "headless" | "background-window" | "window" {
  if (value === undefined) return "headless";
  if (value === "headless" || value === "background-window" || value === "window") return value;
  throw new Error("browser.backgroundMode must be headless, background-window, or window.");
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function isPackageAvailable(name: string): boolean {
  try {
    import.meta.resolve(name);
    return true;
  } catch {
    return false;
  }
}

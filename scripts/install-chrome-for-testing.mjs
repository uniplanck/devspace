import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, platform, arch, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const manifestUrl = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const installRoot = resolve(
  process.env.DEVSPACE_CHROME_FOR_TESTING_DIR
    ?? join(homedir(), ".devspace", "browsers", "chrome-for-testing"),
);
const currentDirectory = join(installRoot, "current");
const metadataPath = join(installRoot, "version.json");
const force = process.argv.includes("--force");

function targetPlatform() {
  if (platform() === "darwin" && arch() === "arm64") return "mac-arm64";
  if (platform() === "darwin" && arch() === "x64") return "mac-x64";
  if (platform() === "linux" && arch() === "x64") return "linux64";
  throw new Error(`Unsupported Chrome for Testing platform: ${platform()}-${arch()}`);
}

function executablePath(root) {
  if (platform() === "darwin") {
    return join(root, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  }
  return join(root, "chrome");
}

async function fetchJson(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Chrome for Testing manifest request failed: HTTP ${response.status}`);
  return response.json();
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Chrome for Testing download failed: HTTP ${response.status}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
}

function extractArchive(zipPath, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const command = platform() === "darwin" ? "ditto" : "unzip";
  const args = platform() === "darwin"
    ? ["-x", "-k", zipPath, destination]
    : ["-q", zipPath, "-d", destination];
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed while extracting Chrome for Testing.`);
}

const target = targetPlatform();
const manifest = await fetchJson(manifestUrl);
const stable = manifest?.channels?.Stable;
const downloadEntry = stable?.downloads?.chrome?.find((entry) => entry.platform === target);
if (!stable?.version || !downloadEntry?.url) {
  throw new Error(`Stable Chrome for Testing download was not found for ${target}.`);
}

let installedVersion;
if (existsSync(metadataPath)) {
  try {
    installedVersion = JSON.parse(readFileSync(metadataPath, "utf8")).version;
  } catch {}
}

const currentExecutable = executablePath(currentDirectory);
if (!force && installedVersion === stable.version && existsSync(currentExecutable)) {
  console.log(JSON.stringify({
    status: "already-installed",
    version: stable.version,
    platform: target,
    executable: currentExecutable,
  }, null, 2));
  process.exit(0);
}

mkdirSync(installRoot, { recursive: true, mode: 0o700 });
const temporaryDirectory = await mkdtemp(join(tmpdir(), "devspace-cft-"));
const zipPath = join(temporaryDirectory, "chrome.zip");
const extractedDirectory = join(temporaryDirectory, "extracted");
const stagingDirectory = join(installRoot, `.staging-${process.pid}`);

try {
  await download(downloadEntry.url, zipPath);
  extractArchive(zipPath, extractedDirectory);

  const archiveRoot = join(extractedDirectory, `chrome-${target}`);
  if (!existsSync(archiveRoot)) throw new Error(`Unexpected Chrome for Testing archive layout: ${archiveRoot}`);

  rmSync(stagingDirectory, { recursive: true, force: true });
  renameSync(archiveRoot, stagingDirectory);
  const stagingExecutable = executablePath(stagingDirectory);
  if (!existsSync(stagingExecutable)) throw new Error(`Chrome for Testing executable was not found: ${stagingExecutable}`);
  chmodSync(stagingExecutable, 0o755);

  rmSync(currentDirectory, { recursive: true, force: true });
  renameSync(stagingDirectory, currentDirectory);
  mkdirSync(dirname(metadataPath), { recursive: true, mode: 0o700 });
  writeFileSync(metadataPath, `${JSON.stringify({
    channel: "Stable",
    version: stable.version,
    platform: target,
    source: downloadEntry.url,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });

  console.log(JSON.stringify({
    status: "installed",
    version: stable.version,
    platform: target,
    executable: currentExecutable,
  }, null, 2));
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true });
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

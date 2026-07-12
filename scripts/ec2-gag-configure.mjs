import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";

const home = process.env.HOME || "/home/ubuntu";
const configDir = join(home, ".devspace");
const configPath = join(configDir, "config.json");
const authPath = join(configDir, "auth.json");
const stateDir = join(home, ".local", "share", "devspace");
const worktreeRoot = join(configDir, "worktrees");
const copyPath = join(home, "copy.txt");
const gagRoot = join(home, "GPT-Agent");
const coreRoot = join(home, "AI-Agent-Core");

if (process.platform !== "linux") throw new Error("EC2 configuration requires Linux.");
if (userInfo().username !== "ubuntu") throw new Error(`Run as ubuntu, not ${userInfo().username}.`);
for (const requiredPath of [gagRoot, coreRoot]) {
  if (!existsSync(requiredPath)) throw new Error(`Required directory is missing: ${requiredPath}`);
}

function command(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function readJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writePrivateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

const tailscaleIp = command("tailscale", ["ip", "-4"])
  .split(/\s+/u)
  .find((value) => /^100\./u.test(value));
if (!tailscaleIp) throw new Error("No Tailscale IPv4 address was found.");

const status = JSON.parse(command("tailscale", ["status", "--json"]));
const tailscaleDnsName = String(status?.Self?.DNSName ?? "").replace(/\.$/u, "");
if (!tailscaleDnsName) throw new Error("Tailscale MagicDNS name is unavailable.");

mkdirSync(configDir, { recursive: true, mode: 0o700 });
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });
chmodSync(configDir, 0o700);
chmodSync(stateDir, 0o700);
chmodSync(worktreeRoot, 0o700);

const existingConfig = readJson(configPath);
const existingAuth = readJson(authPath);
const ownerToken = typeof existingAuth.ownerToken === "string" && existingAuth.ownerToken.length >= 16
  ? existingAuth.ownerToken
  : randomBytes(32).toString("base64url");

const allowedHosts = Array.from(new Set([
  "127.0.0.1",
  "localhost",
  tailscaleIp,
  hostname(),
  "minecraft-ec2",
  tailscaleDnsName,
]));

const config = {
  ...existingConfig,
  host: "127.0.0.1",
  port: 7676,
  allowedRoots: [gagRoot, coreRoot],
  publicBaseUrl: `https://${tailscaleDnsName}`,
  allowedHosts,
  stateDir,
  worktreeRoot,
  subagents: false,
};

writePrivateJson(configPath, config);
writePrivateJson(authPath, { ownerToken });
if (!existsSync(copyPath)) writeFileSync(copyPath, "", { mode: 0o600 });
chmodSync(copyPath, 0o600);

console.log(JSON.stringify({
  configured: true,
  role: "ec2",
  host: config.host,
  port: 7676,
  tailscaleIp,
  tailscaleDnsName,
  publicBaseUrl: config.publicBaseUrl,
  allowedRoots: config.allowedRoots,
  allowedHosts,
  configPath,
  authPath,
  ownerToken: "stored-not-displayed",
}, null, 2));

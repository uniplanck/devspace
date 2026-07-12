import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface ShellPathInfo {
  path: string;
  entries: string[];
  addedEntries: string[];
}

function uniqueEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function shellPathInfo(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  directoryExists: (path: string) => boolean = existsSync,
): ShellPathInfo {
  const pathApi = platform === "win32" ? win32 : posix;
  const existingEntries = String(env.PATH ?? "")
    .split(pathApi.delimiter)
    .filter(Boolean);
  const candidates = platform === "win32"
    ? []
    : [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        pathApi.join(home, ".local", "bin"),
        pathApi.join(home, "bin"),
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ];
  const existingSet = new Set(existingEntries);
  const addedEntries = uniqueEntries(candidates)
    .filter((entry) => !existingSet.has(entry) && directoryExists(entry));
  const entries = uniqueEntries([...existingEntries, ...addedEntries]);

  return {
    path: entries.join(pathApi.delimiter),
    entries,
    addedEntries,
  };
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function commandWithAugmentedPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return command;
  const info = shellPathInfo(env, platform);
  return `export PATH=${quotePosix(info.path)}; ${command}`;
}

export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
): string | undefined {
  if (!/^[A-Za-z0-9._+-]+$/.test(command)) return undefined;
  const pathApi = platform === "win32" ? win32 : posix;
  const info = shellPathInfo(env, platform, homedir(), fileExists);
  const extensions = platform === "win32"
    ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];

  for (const entry of info.entries) {
    for (const extension of extensions) {
      const candidate = pathApi.join(entry, `${command}${extension}`);
      if (fileExists(candidate)) return candidate;
    }
  }
  return undefined;
}

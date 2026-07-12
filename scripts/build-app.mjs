import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDirectory = join(projectRoot, "dist");
const currentDirectory = join(distDirectory, "ui");
const nextDirectory = join(distDirectory, `.ui-next-${process.pid}`);
const viteExecutable = join(projectRoot, "node_modules", "vite", "bin", "vite.js");

rmSync(nextDirectory, { recursive: true, force: true });
mkdirSync(distDirectory, { recursive: true });

const build = spawnSync(process.execPath, [viteExecutable, "build"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    DEVSPACE_UI_OUT_DIR: nextDirectory,
  },
  stdio: "inherit",
});

if (build.status !== 0) {
  rmSync(nextDirectory, { recursive: true, force: true });
  process.exit(build.status ?? 1);
}

const previousAssets = manifestAssets(currentDirectory);
const nextAssets = manifestAssets(nextDirectory);
mkdirSync(currentDirectory, { recursive: true });

copyTree(nextDirectory, currentDirectory, (sourcePath) => {
  return relative(nextDirectory, sourcePath) !== join(".vite", "manifest.json");
});

const nextManifest = join(nextDirectory, ".vite", "manifest.json");
const currentManifest = join(currentDirectory, ".vite", "manifest.json");
mkdirSync(dirname(currentManifest), { recursive: true });
const manifestTemporary = `${currentManifest}.tmp-${process.pid}`;
writeFileSync(manifestTemporary, readFileSync(nextManifest));
renameSync(manifestTemporary, currentManifest);

const retainedAssets = new Set([...previousAssets, ...nextAssets]);
pruneUnreferencedAssets(currentDirectory, retainedAssets);
rmSync(nextDirectory, { recursive: true, force: true });

function manifestAssets(directory) {
  const manifestPath = join(directory, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) return new Set();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const assets = new Set();
  for (const entry of Object.values(manifest)) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.file === "string") assets.add(entry.file);
    for (const key of ["css", "assets"]) {
      const values = entry[key];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (typeof value === "string") assets.add(value);
      }
    }
  }
  return assets;
}

function copyTree(sourceDirectory, targetDirectory, shouldCopy) {
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = join(sourceDirectory, entry.name);
    const targetPath = join(targetDirectory, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(targetPath, { recursive: true });
      copyTree(sourcePath, targetPath, shouldCopy);
      continue;
    }
    if (!entry.isFile() || !shouldCopy(sourcePath)) continue;
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

function pruneUnreferencedAssets(directory, retainedAssets) {
  const assetsDirectory = join(directory, "assets");
  if (!existsSync(assetsDirectory)) return;
  for (const entry of readdirSync(assetsDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relativePath = join("assets", entry.name);
    if (!retainedAssets.has(relativePath)) {
      rmSync(join(assetsDirectory, entry.name), { force: true });
    }
  }
}

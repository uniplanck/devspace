import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDirectory = join(projectRoot, "dist");

if (existsSync(distDirectory)) {
  for (const entry of readdirSync(distDirectory, { withFileTypes: true })) {
    if (entry.name === "ui") continue;
    rmSync(join(distDirectory, entry.name), { recursive: true, force: true });
  }
}

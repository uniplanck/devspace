import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const targetRoot = process.argv[2] ? resolve(process.argv[2]) : "";
if (!targetRoot) {
  throw new Error("usage: node scripts/sanitize-public-core.mjs /path/to/devspace-checkout");
}

const markedFiles = [
  ".env.example",
  "src/config.test.ts",
  "src/config.ts",
  "src/server.ts",
  "src/user-config.ts",
];

const privateBlockPattern = /^[\t ]*(?:\/\/|#) PRIVATE_GEX_START[\t ]*\n[\s\S]*?^[\t ]*(?:\/\/|#) PRIVATE_GEX_END[\t ]*\n?/gm;

for (const relativePath of markedFiles) {
  const path = join(targetRoot, relativePath);
  const source = await readFile(path, "utf8");
  const sanitized = source.replace(privateBlockPattern, "");
  if (source === sanitized) {
    throw new Error(`public sanitizer found no private GEX block in ${relativePath}`);
  }
  await writeFile(path, sanitized);
}

const packagePath = join(targetRoot, "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const privateTest = "tsx src/gex-learning-store.test.ts && ";
if (!String(packageJson.scripts?.test || "").includes(privateTest)) {
  throw new Error("public sanitizer could not find the private GEX test command");
}
packageJson.scripts.test = packageJson.scripts.test.replace(privateTest, "");
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

await rm(join(targetRoot, "src/gex-learning-store.ts"), { force: true });
await rm(join(targetRoot, "src/gex-learning-store.test.ts"), { force: true });

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const forbidden = /PRIVATE_GEX_|DEVSPACE_GEX_LEARNING_DIR|gex-learning|gexLearning|GEX learning/i;
const scanFiles = [
  join(targetRoot, ".env.example"),
  join(targetRoot, "package.json"),
  ...await filesUnder(join(targetRoot, "src")),
];
for (const path of scanFiles) {
  const content = await readFile(path, "utf8");
  if (forbidden.test(content)) {
    throw new Error(`public export still contains private GEX content: ${path}`);
  }
}

console.log("public core sanitizer: OK");

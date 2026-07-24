import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { batchEditWorkspace } from "./batch-edit.js";
import {
  focusedContext,
  projectSnapshot,
  reviewChanges,
  workspaceDigest,
  type WorkspaceInspectionContext,
} from "./compound-tools.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "gpt-agent-compound-tools-test-"));

try {
  await mkdir(join(root, "src"));
  await mkdir(join(root, "other"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "fixture-project",
    version: "1.2.3",
    scripts: { typecheck: "tsc", test: "test-command", build: "build-command" },
  }));
  await writeFile(join(root, "src", "target.ts"), "export function targetSymbol() { return 1; }\n");
  await writeFile(join(root, "other", "outside.ts"), "export const targetSymbol = 2;\n");
  await writeFile(join(root, ".env"), "API_KEY=super-secret-value-that-must-not-leak\n");
  await git(["init"]);
  await git(["config", "user.email", "gpt-agent@example.com"]);
  await git(["config", "user.name", "GPT Agent"]);
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);

  await writeFile(join(root, "src", "target.ts"), [
    "export function targetSymbol() {",
    "  const unsafe: any = 2;",
    "  return unsafe;",
    "}",
    "",
  ].join("\n"));
  await writeFile(join(root, ".env"), "API_KEY=changed-secret-value-that-must-not-leak\n");

  const context: WorkspaceInspectionContext = {
    root,
    instructionPaths: [join(root, "AGENTS.md")],
    skills: Array.from({ length: 80 }, (_, index) => ({
      name: `skill-${index}`,
      description: `Skill ${index} description`,
    })),
    agentProviders: [{ name: "codex", provider: "codex", available: true }],
    agentProfiles: [{ name: "review", provider: "codex", writeMode: "read_only" }],
  };

  const snapshot = await projectSnapshot(context, { maxCharacters: 2_000 });
  assert.equal(snapshot.package.name, "fixture-project");
  assert.deepEqual(snapshot.package.scripts.sort(), ["build", "test", "typecheck"]);
  assert.equal(snapshot.recommendedTestCommand, "npm test");
  assert.equal(snapshot.recommendedBuildCommand, "npm run build");
  assert.equal(snapshot.metrics.truncated, true);
  assert.ok(snapshot.metrics.payloadCharacters <= 2_000);
  assert.equal(snapshot.metrics.payloadCharacters, JSON.stringify(snapshot).length);
  assert.equal(JSON.stringify(snapshot).includes("super-secret-value"), false);

  const focused = await focusedContext(context, {
    focus: "targetSymbol",
    paths: ["src"],
    maxFiles: 1,
    maxCharacters: 4_000,
  });
  assert.deepEqual(focused.relevantFiles, ["src/target.ts"]);
  assert.equal(focused.relevantFiles.some((path) => path.startsWith("other/")), false);
  assert.equal(focused.relevantFiles.length <= 1, true);
  assert.equal(focused.metrics.payloadCharacters, JSON.stringify(focused).length);

  const digest = await workspaceDigest(context, {
    focus: "targetSymbol unsafe",
    paths: ["src"],
    maxFiles: 2,
    contextLines: 20,
    maxCharacters: 8_000,
  });
  assert.equal(digest.project.branch !== null, true);
  assert.deepEqual(digest.focus.relevantFiles, ["src/target.ts"]);
  assert.equal(digest.excerpts.length, 1);
  assert.match(digest.excerpts[0]!.content, /targetSymbol/u);
  assert.equal(JSON.stringify(digest).includes("changed-secret-value"), false);
  assert.equal(digest.metrics.payloadCharacters, JSON.stringify(digest).length);

  const fileBefore = await readFile(join(root, "src", "target.ts"));
  const indexBefore = await readFile(join(root, ".git", "index"));
  const statusBefore = (await git(["status", "--porcelain=v1", "-z"])).stdout;
  const stagedBefore = (await git(["diff", "--cached"])).stdout;
  const review = await reviewChanges(context, { maxCharacters: 4_000 });
  assert.ok(review.changedFiles.some((entry) => entry.path === "src/target.ts"));
  assert.ok(review.suspiciousChanges.some((entry) => entry.rule === "type_safety_escape"));
  assert.equal(JSON.stringify(review).includes("changed-secret-value"), false);
  assert.equal(review.metrics.payloadCharacters, JSON.stringify(review).length);
  assert.deepEqual(await readFile(join(root, "src", "target.ts")), fileBefore);
  assert.deepEqual(await readFile(join(root, ".git", "index")), indexBefore);
  assert.equal((await git(["status", "--porcelain=v1", "-z"])).stdout, statusBefore);
  assert.equal((await git(["diff", "--cached"])).stdout, stagedBefore);

  await assert.rejects(
    () => reviewChanges(context, { baseRef: "--output=/tmp/escape" }),
    /Invalid baseRef/,
  );

  await writeFile(join(root, "src", "second.ts"), "export const second = 1;\n");
  const batch = await batchEditWorkspace(root, [
    {
      path: "src/target.ts",
      edits: [{ oldText: "const unsafe: any = 2;", newText: "const safe = 2;" }],
    },
    {
      path: "src/second.ts",
      edits: [{ oldText: "second = 1", newText: "second = 2" }],
    },
  ]);
  assert.equal(batch.totalFiles, 2);
  assert.equal(batch.totalReplacements, 2);
  assert.match(await readFile(join(root, "src", "target.ts"), "utf8"), /const safe = 2/u);
  assert.match(await readFile(join(root, "src", "second.ts"), "utf8"), /second = 2/u);

  const targetBeforeFailedBatch = await readFile(join(root, "src", "target.ts"), "utf8");
  await assert.rejects(
    () => batchEditWorkspace(root, [
      {
        path: "src/target.ts",
        edits: [{ oldText: "missing exact text", newText: "never applied" }],
      },
      {
        path: ".env",
        edits: [{ oldText: "API_KEY", newText: "KEY" }],
      },
    ]),
    /matched 0 times|Secret-like files/u,
  );
  assert.equal(await readFile(join(root, "src", "target.ts"), "utf8"), targetBeforeFailedBatch);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd: root, encoding: "utf8" });
}

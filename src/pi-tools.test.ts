import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellTool } from "./pi-tools.js";

const root = await mkdtemp(join(tmpdir(), "devspace-approved-shell-test-"));
const commandsFile = join(root, "approved.json");
const previousCommandsFile = process.env.DEVSPACE_APPROVED_SHELL_COMMANDS_FILE;

try {
  await mkdir(join(root, "nested"));
  process.env.DEVSPACE_APPROVED_SHELL_COMMANDS_FILE = commandsFile;
  await writeFile(commandsFile, JSON.stringify({
    commands: [{
      alias: "where",
      workspaceRoot: root,
      workingDirectory: "nested",
      command: "pwd",
    }],
  }));

  const allowed = await runShellTool(
    { command: "devspace-approved where" },
    { cwd: root, root },
  );
  assert.equal(allowed.isError, undefined);
  assert.match(allowed.content[0]?.type === "text" ? allowed.content[0].text : "", /nested/);

  await writeFile(commandsFile, JSON.stringify({
    commands: [{
      alias: "escape",
      workspaceRoot: root,
      workingDirectory: "..",
      command: "pwd",
    }],
  }));
  const denied = await runShellTool(
    { command: "devspace-approved escape" },
    { cwd: root, root },
  );
  assert.equal(denied.isError, true);
  assert.match(denied.content[0]?.type === "text" ? denied.content[0].text : "", /outside allowed roots/);
} finally {
  if (previousCommandsFile === undefined) {
    delete process.env.DEVSPACE_APPROVED_SHELL_COMMANDS_FILE;
  } else {
    process.env.DEVSPACE_APPROVED_SHELL_COMMANDS_FILE = previousCommandsFile;
  }
  await rm(root, { recursive: true, force: true });
}

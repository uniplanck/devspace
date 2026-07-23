import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellTool } from "./pi-tools.js";
import { JobStore } from "./job-store.js";
import { initializeComputerUsePolicy } from "./computer-use.js";

const root = await mkdtemp(join(tmpdir(), "devspace-approved-shell-test-"));
const commandsFile = join(root, "approved.json");
const previousCommandsFile = process.env.DEVSPACE_APPROVED_SHELL_COMMANDS_FILE;
const previousStateDir = process.env.DEVSPACE_STATE_DIR;
const previousComputerPolicy = process.env.DEVSPACE_COMPUTER_USE_POLICY;
const previousOwnerToken = process.env.DEVSPACE_OAUTH_OWNER_TOKEN;
const previousProgressPath = process.env.DEVSPACE_CHAT_PROGRESS_PATH;

try {
  await mkdir(join(root, "nested"));
  process.env.DEVSPACE_APPROVED_SHELL_COMMANDS_FILE = commandsFile;
  process.env.DEVSPACE_STATE_DIR = join(root, "state");
  process.env.DEVSPACE_COMPUTER_USE_POLICY = join(root, "computer-use.json");
  process.env.DEVSPACE_OAUTH_OWNER_TOKEN = "test-owner-token-for-pi-tools";
  process.env.DEVSPACE_CHAT_PROGRESS_PATH = join(root, "chat-progress.json");
  initializeComputerUsePolicy(process.env.DEVSPACE_COMPUTER_USE_POLICY);
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

  const diagnosis = await runShellTool(
    { command: "devspace-runtime diagnose node git" },
    { cwd: root, root },
  );
  assert.equal(diagnosis.isError, undefined);
  const diagnosisText = diagnosis.content[0]?.type === "text" ? diagnosis.content[0].text : "";
  assert.match(diagnosisText, /"accessible": true/);
  assert.match(diagnosisText, /"command": "node"/);

  const smoke = await runShellTool(
    { command: "devspace-runtime smoke" },
    { cwd: root, root },
  );
  assert.equal(smoke.isError, undefined);
  assert.match(smoke.content[0]?.type === "text" ? smoke.content[0].text : "", /"status": "passed"/);

  const costs = await runShellTool(
    { command: "devspace-runtime costs" },
    { cwd: root, root },
  );
  assert.equal(costs.isError, undefined);
  assert.match(costs.content[0]?.type === "text" ? costs.content[0].text : "", /"calls":/);

  const finalized = await runShellTool(
    {
      command: "devspace-runtime progress finalize --label 'Fallback task' --result '完了しました' --changes '変更なし' --verification 'テスト成功' --remaining 'なし'",
    },
    { cwd: root, root, workspaceId: "ws_test" },
  );
  assert.equal(finalized.isError, undefined);
  const finalizedText = finalized.content[0]?.type === "text" ? finalized.content[0].text : "";
  assert.deepEqual(
    finalizedText.split("\n").filter((line) => line.startsWith("## ")),
    ["## 完了結果", "## 変更", "## 検証", "## 残り", "## 実行情報"],
  );
  assert.match(finalizedText, /完了しました/u);
  assert.match(finalizedText, /テスト成功/u);

  const jobStore = new JobStore(process.env.DEVSPACE_STATE_DIR);
  jobStore.create({ workspaceId: "ws_test", workspaceRoot: root, preset: "typecheck", title: "Tool job" });
  jobStore.close();
  const jobs = await runShellTool(
    { command: "devspace-runtime jobs list" },
    { cwd: root, root, workspaceId: "ws_test" },
  );
  assert.equal(jobs.isError, undefined);
  assert.match(jobs.content[0]?.type === "text" ? jobs.content[0].text : "", /Tool job/);

  const computerDoctor = await runShellTool(
    { command: "devspace-runtime computer doctor" },
    { cwd: root, root },
  );
  assert.equal(computerDoctor.isError, undefined);
  assert.match(
    computerDoctor.content[0]?.type === "text" ? computerDoctor.content[0].text : "",
    /"policyExists": true/,
  );

  const computerPolicy = await runShellTool(
    { command: "devspace-runtime computer policy" },
    { cwd: root, root },
  );
  assert.equal(computerPolicy.isError, undefined);
  assert.match(
    computerPolicy.content[0]?.type === "text" ? computerPolicy.content[0].text : "",
    /"enabled": false/,
  );

  const browserStartDenied = await runShellTool(
    { command: "devspace-runtime computer browser start" },
    { cwd: root, root },
  );
  assert.equal(browserStartDenied.isError, true);
  assert.match(
    browserStartDenied.content[0]?.type === "text" ? browserStartDenied.content[0].text : "",
    /disabled by policy/,
  );

  const finderEscape = await runShellTool(
    { command: "devspace-runtime finder ../outside" },
    { cwd: root, root },
  );
  assert.equal(finderEscape.isError, true);
  assert.match(
    finderEscape.content[0]?.type === "text" ? finderEscape.content[0].text : "",
    /outside allowed roots/,
  );

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
  if (previousCommandsFile === undefined) delete process.env.DEVSPACE_APPROVED_SHELL_COMMANDS_FILE;
  else process.env.DEVSPACE_APPROVED_SHELL_COMMANDS_FILE = previousCommandsFile;
  if (previousStateDir === undefined) delete process.env.DEVSPACE_STATE_DIR;
  else process.env.DEVSPACE_STATE_DIR = previousStateDir;
  if (previousComputerPolicy === undefined) delete process.env.DEVSPACE_COMPUTER_USE_POLICY;
  else process.env.DEVSPACE_COMPUTER_USE_POLICY = previousComputerPolicy;
  if (previousOwnerToken === undefined) delete process.env.DEVSPACE_OAUTH_OWNER_TOKEN;
  else process.env.DEVSPACE_OAUTH_OWNER_TOKEN = previousOwnerToken;
  if (previousProgressPath === undefined) delete process.env.DEVSPACE_CHAT_PROGRESS_PATH;
  else process.env.DEVSPACE_CHAT_PROGRESS_PATH = previousProgressPath;
  await rm(root, { recursive: true, force: true });
}

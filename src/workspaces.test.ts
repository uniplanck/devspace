import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { formatAgentsNotice, WorkspaceRegistry } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "pi-on-mcp-workspace-test-"));

try {
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    PI_ON_MCP_ALLOWED_ROOTS: root,
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const { workspace, agentsFiles } = await registry.openWorkspace(root);

  assert.match(formatAgentsNotice(agentsFiles) ?? "", /root instructions/);

  const missingWorkspaceRoot = join(root, "missing", "workspace");
  const missingWorkspace = await registry.openWorkspace(missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.root, missingWorkspaceRoot);
  assert.equal((await stat(missingWorkspaceRoot)).isDirectory(), true);

  const rootAgain = await registry.loadAgentsForDirectory(workspace, root);
  assert.equal(formatAgentsNotice(rootAgain), undefined);

  const nestedPath = registry.resolvePath(workspace, "nested/file.txt");
  const nestedFirst = await registry.loadAgentsForPath(workspace, nestedPath);
  const nestedFirstNotice = formatAgentsNotice(nestedFirst) ?? "";
  assert.doesNotMatch(nestedFirstNotice, /root instructions/);
  assert.match(nestedFirstNotice, /nested instructions/);

  const nestedAgain = await registry.loadAgentsForPath(workspace, nestedPath);
  assert.equal(formatAgentsNotice(nestedAgain), undefined);

  const stateDir = join(root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const persistentRegistry = new WorkspaceRegistry(config, firstStore);
  const persistentWorkspace = await persistentRegistry.openWorkspace(root);
  const persistentNestedPath = persistentRegistry.resolvePath(
    persistentWorkspace.workspace,
    "nested/file.txt",
  );
  await persistentRegistry.loadAgentsForPath(
    persistentWorkspace.workspace,
    persistentNestedPath,
  );
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const restoredRegistry = new WorkspaceRegistry(config, secondStore);
  const restoredWorkspace = restoredRegistry.getWorkspace(persistentWorkspace.workspace.id);
  assert.equal(restoredWorkspace.root, root);

  const restoredRootAgents = await restoredRegistry.loadAgentsForDirectory(
    restoredWorkspace,
    root,
  );
  assert.equal(formatAgentsNotice(restoredRootAgents), undefined);

  const restoredNestedAgents = await restoredRegistry.loadAgentsForPath(
    restoredWorkspace,
    restoredRegistry.resolvePath(restoredWorkspace, "nested/file.txt"),
  );
  assert.equal(formatAgentsNotice(restoredNestedAgents), undefined);
  secondStore.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

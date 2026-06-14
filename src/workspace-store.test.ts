import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const stateDir = await mkdtemp(join(tmpdir(), "pi-on-mcp-workspace-store-test-"));

try {
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const session = firstStore.createSession({
    id: "ws_persistent",
    root: "/tmp/project",
  });
  const agentFile = firstStore.putLoadedAgentFile({
    workspaceSessionId: session.id,
    path: "/tmp/project/AGENTS.md",
    content: "root instructions\n",
  });
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const loadedSession = secondStore.getSession(session.id);
  assert.equal(loadedSession?.id, "ws_persistent");
  assert.equal(loadedSession?.root, "/tmp/project");
  assert.equal(loadedSession?.status, "active");

  const loadedAgentFiles = secondStore.listLoadedAgentFiles(session.id);
  assert.equal(loadedAgentFiles.length, 1);
  assert.equal(loadedAgentFiles[0]?.path, "/tmp/project/AGENTS.md");
  assert.equal(loadedAgentFiles[0]?.content, "root instructions\n");
  assert.equal(loadedAgentFiles[0]?.contentHash, agentFile.contentHash);

  secondStore.touchSession(session.id);
  const touchedSession = secondStore.getSession(session.id);
  assert.ok(touchedSession);
  assert.notEqual(touchedSession.lastUsedAt, session.lastUsedAt);
  secondStore.close();
} finally {
  await rm(stateDir, { recursive: true, force: true });
}

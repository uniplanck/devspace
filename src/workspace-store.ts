import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  loadedAgentFiles,
  workspaceSessions,
  type LoadedAgentFileRow,
  type WorkspaceSessionRow,
} from "./db/schema.js";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface LoadedAgentFileState {
  path: string;
  content: string;
  contentHash: string;
  loadedAt: string;
  lastSeenAt: string;
}

export interface WorkspaceStore {
  createSession(input: { id: string; root: string }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  touchSession(id: string): void;
  listLoadedAgentFiles(workspaceSessionId: string): LoadedAgentFileState[];
  putLoadedAgentFile(input: {
    workspaceSessionId: string;
    path: string;
    content: string;
  }): LoadedAgentFileState;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.migrate();
  }

  createSession(input: { id: string; root: string }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        root: session.root,
        status: session.status,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  touchSession(id: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(workspaceSessions.id, id))
      .run();
  }

  listLoadedAgentFiles(workspaceSessionId: string): LoadedAgentFileState[] {
    return this.database.db
      .select()
      .from(loadedAgentFiles)
      .where(eq(loadedAgentFiles.workspaceSessionId, workspaceSessionId))
      .all()
      .map(rowToLoadedAgentFileState);
  }

  putLoadedAgentFile(input: {
    workspaceSessionId: string;
    path: string;
    content: string;
  }): LoadedAgentFileState {
    const now = new Date().toISOString();
    const contentHash = hashContent(input.content);
    const existing = this.database.db
      .select()
      .from(loadedAgentFiles)
      .where(
        and(
          eq(loadedAgentFiles.workspaceSessionId, input.workspaceSessionId),
          eq(loadedAgentFiles.path, input.path),
        ),
      )
      .get();

    const loadedAt = existing?.loadedAt ?? now;
    const state: LoadedAgentFileState = {
      path: input.path,
      content: input.content,
      contentHash,
      loadedAt,
      lastSeenAt: now,
    };

    this.database.db
      .insert(loadedAgentFiles)
      .values({
        workspaceSessionId: input.workspaceSessionId,
        path: state.path,
        contentHash: state.contentHash,
        content: state.content,
        loadedAt: state.loadedAt,
        lastSeenAt: state.lastSeenAt,
      })
      .onConflictDoUpdate({
        target: [loadedAgentFiles.workspaceSessionId, loadedAgentFiles.path],
        set: {
          contentHash: state.contentHash,
          content: state.content,
          lastSeenAt: state.lastSeenAt,
        },
      })
      .run();

    return state;
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.sqlite.exec(`
      create table if not exists workspace_sessions (
        id text primary key,
        root text not null,
        status text not null default 'active',
        created_at text not null,
        last_used_at text not null
      );

      create index if not exists workspace_sessions_root_idx
        on workspace_sessions(root, last_used_at desc);

      create index if not exists workspace_sessions_status_idx
        on workspace_sessions(status, last_used_at desc);

      create table if not exists loaded_agent_files (
        workspace_session_id text not null,
        path text not null,
        content_hash text not null,
        content text not null,
        loaded_at text not null,
        last_seen_at text not null,
        primary key (workspace_session_id, path),
        foreign key (workspace_session_id)
          references workspace_sessions(id)
          on delete cascade
      );

      create index if not exists loaded_agent_files_path_idx
        on loaded_agent_files(path);
    `);
  }
}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    root: row.root,
    status: row.status,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToLoadedAgentFileState(row: LoadedAgentFileRow): LoadedAgentFileState {
  return {
    path: row.path,
    content: row.content,
    contentHash: row.contentHash,
    loadedAt: row.loadedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

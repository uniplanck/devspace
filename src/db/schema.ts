import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    title: text("title").notNull(),
    preset: text("preset").notNull(),
    status: text("status").notNull(),
    progress: integer("progress").notNull().default(0),
    currentStep: text("current_step").notNull().default("Queued"),
    workerPid: integer("worker_pid"),
    processPid: integer("process_pid"),
    exitCode: integer("exit_code"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("jobs_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("jobs_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("jobs_status_idx").on(table.status, table.updatedAt),
  ],
);

export const jobEvents = sqliteTable(
  "job_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    timestamp: text("timestamp").notNull(),
    level: text("level").notNull(),
    message: text("message").notNull(),
  },
  (table) => [
    index("job_events_job_id_idx").on(table.jobId, table.id),
  ],
);

export const localAgentSessions = sqliteTable(
  "local_agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    thinking: text("thinking"),
    providerSessionId: text("provider_session_id"),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type JobEventRow = typeof jobEvents.$inferSelect;
export type NewJobEventRow = typeof jobEvents.$inferInsert;

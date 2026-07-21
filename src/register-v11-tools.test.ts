import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { enabledV11ToolNames } from "./register-v11-tools.js";

const baseEnv = {
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.deepEqual(
  enabledV11ToolNames(loadConfig(baseEnv)),
  ["project_snapshot", "focused_context", "workspace_digest", "review_changes", "batch_edit"],
);
assert.deepEqual(
  enabledV11ToolNames(loadConfig({
    ...baseEnv,
    DEVSPACE_SKILL_MATCHER: "1",
    DEVSPACE_COMPOUND_TOOLS: "1",
    DEVSPACE_DESIGN_AUDIT: "1",
  })),
  [
    "match_skills",
    "project_snapshot",
    "focused_context",
    "workspace_digest",
    "review_changes",
    "batch_edit",
    "design_audit",
  ],
);
assert.deepEqual(
  enabledV11ToolNames(loadConfig({
    ...baseEnv,
    DEVSPACE_SKILL_MATCHER: "1",
    DEVSPACE_SKILLS: "0",
  })),
  ["project_snapshot", "focused_context", "workspace_digest", "review_changes", "batch_edit"],
);
assert.deepEqual(
  enabledV11ToolNames(loadConfig({
    ...baseEnv,
    DEVSPACE_TOOL_MODE: "codex",
  })),
  ["project_snapshot", "focused_context", "workspace_digest", "review_changes"],
);
assert.deepEqual(
  enabledV11ToolNames(loadConfig({
    ...baseEnv,
    DEVSPACE_COMPOUND_TOOLS: "0",
  })),
  [],
);

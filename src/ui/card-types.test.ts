import assert from "node:assert/strict";
import {
  isEditTool,
  isExpandableCard,
  isPatchTool,
  isProgressTool,
  isShellTool,
  isToolName,
} from "./card-types.js";

for (const tool of [
  "begin_task",
  "report_progress",
  "finalize_task",
  "output_core_status",
  "apply_patch",
  "exec_command",
  "write_stdin",
]) {
  assert.equal(isToolName(tool), true, `${tool} should be a recognized card tool`);
}

assert.equal(isPatchTool("apply_patch"), true);
assert.equal(isEditTool("apply_patch"), false);
assert.equal(isShellTool("exec_command"), true);
assert.equal(isShellTool("write_stdin"), true);
assert.equal(isEditTool("exec_command"), false);
assert.equal(isShellTool("apply_patch"), false);
assert.equal(isProgressTool("begin_task"), true);
assert.equal(isProgressTool("report_progress"), true);
assert.equal(isProgressTool("finalize_task"), true);
assert.equal(isProgressTool("output_core_status"), true);
assert.equal(isProgressTool("read"), false);

assert.equal(
  isExpandableCard({ tool: "apply_patch", payload: { patch: "diff --git a/a b/a" } }),
  true,
);
assert.equal(isExpandableCard({ tool: "apply_patch" }), false);

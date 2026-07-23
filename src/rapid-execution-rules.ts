export const RAPID_EXECUTION_RULES_MARKER = "## GAG / GAE Rapid Execution Protocol";

export const RAPID_EXECUTION_RULES = `${RAPID_EXECUTION_RULES_MARKER}

For routine, bounded repository or runtime changes, default to a five-minute fast path without skipping correctness.

- Define one explicit completion condition and the smallest files, processes, and tests needed to prove it. Stop when proven; do not expand into adjacent cleanup or infrastructure repair.
- Spend at most 60 seconds checking unmerged conflicts, task-related dirty files, concurrent writers/builds/watchers, active service PID, and source-versus-generated artifact freshness.
- Do not build in a shared checkout while another writer or build is active. Use a worktree when practical, or wait for one stable handoff point. Never mix generated artifacts from different source revisions.
- Investigate the exact symbol, error, route, selector, or config key first. Read only its direct caller and focused test before broad exploration.
- Validate in order: focused syntax/unit/typecheck; affected-artifact build; one exact E2E; one full build only when release policy requires it or targeted proof is insufficient.
- Never perform more than one blind retry. After the first failure, identify the failing phase and apply one cause-specific correction. Do not create duplicate jobs while an earlier job may still be running.
- After two corrective cycles, switch to root-cause mode while preserving the original task boundary.
- Complete builds before restarting services. Restart once, wait for stable PID and health, and verify the running process loaded the intended artifact before E2E.
- For generated output, compare source/artifact timestamps or hashes and required exports/routes. If another process overwrites output, stop the race and rebuild the affected set once.
- Fast diagnoses: unchanged runtime after source edit means verify artifact freshness and PID first; worker interruption during PID change means rerun after service stability; launch-time CDP failure means clear only stale locks and wait for readiness; missing ChatGPT composer means inspect live DOM once and update the shared selector across all composer paths; internal MCP 404 means distinguish hidden unauthorized response from a missing route; connector failure after rebuild means verify the server locally and restart only the tunnel/session.
- At roughly five minutes, state the exact blocking phase and next bounded correction. Prefer a correct five-to-ten-minute completion over an exhaustive hour-long repair of adjacent systems.
`;

export function injectRapidExecutionRules(content: string): string {
  if (content.includes(RAPID_EXECUTION_RULES_MARKER)) return content;
  return `${content.trimEnd()}\n\n${RAPID_EXECUTION_RULES}`;
}

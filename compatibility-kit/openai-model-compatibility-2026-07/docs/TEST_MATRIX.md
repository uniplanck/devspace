# Validation Matrix

## Automated checks

The public branch must pass:

- `npm ci`
- `npm run typecheck`
- `npm test`
- `npm run build`
- privacy-marker scan from `verify.mjs`
- `git apply --check` for every compatibility patch against upstream v1.0.4

## Behavioral checks

### Workspace opening

- Compact mode returns a valid `workspaceId`.
- Loaded instruction files include bounded content and truncation metadata.
- Full mode preserves the prior full-payload behavior.
- A full read of an advertised instruction path succeeds.
- A non-advertised neighboring path remains blocked.

### Primitive tools

- `read`, `write`, `edit`, `grep`, `glob`, `ls`, and `bash` preserve their
  existing structured results.
- Usage reporting can be disabled.
- Usage reporting cannot break a successful underlying tool call.

### Approved commands

- Unknown aliases fail.
- Invalid alias syntax fails.
- A command configured for another workspace fails.
- A configured working directory cannot escape the active workspace.
- Arbitrary normal shell commands continue through the existing shell path and
  are not rewritten as approved aliases.

### Optional capabilities

- Skill matcher disabled by default.
- Compound tools disabled by default.
- Built-in profiles disabled by default.
- Design audit disabled by default.
- Invalid feature-flag values fail configuration loading.

### MCP client smoke test

The original regression was observed in ChatGPT sessions using GPT-5.5 and
GPT-5.6. A manual smoke test should open one repository, read one instruction
file, list a directory, run a harmless Git inspection command, and complete a
small multi-step task with both available model families.

Model-provider behavior can change independently of this repository, so manual
results should include the test date and client environment rather than being
treated as permanent guarantees.

# Palmier Pro Integration Lab

## Verdict

Palmier Pro is the preferred first interactive test host, but it must remain outside the core dependency graph.

It is useful because the current project is a Swift-native macOS editor, exposes a local HTTP MCP server while the app is open, supports timeline edits through agents, and exports NLE XML for Premiere Pro and DaVinci Resolve. It is not suitable as the only renderer or the system source of truth because it is macOS-only, version-sensitive, and licensed GPLv3.

## Verified upstream characteristics

As of July 2026, Palmier's official project describes:

- macOS 26 (Tahoe) on Apple Silicon as the supported platform;
- a local MCP endpoint at `http://127.0.0.1:19789/mcp` while Palmier is open;
- timeline operations such as trimming, splitting, reordering, and clip adjustment through an agent;
- MP4 export and NLE XML export for Premiere Pro and DaVinci Resolve;
- a Swift-native open-source editor and MCP server under GPLv3;
- closed-source generative AI processing as a separate part of the product.

Upstream references:

- https://github.com/palmier-io/palmier-pro
- https://www.palmier.io/docs
- https://www.palmier.io/

## Boundary decision

```text
GAE / headless environment
  gag video core
  -> analysis
  -> Editorial IR
  -> headless preview and QC
  -> versioned artifacts in Git-managed project

Mac / GAG environment
  Editorial IR
  -> Palmier MCP adapter
  -> Palmier project timeline
  -> Palmier preview / XML export
  -> comparison report
```

Do not expose Palmier's localhost MCP endpoint to the public internet or route it directly to EC2. Palmier interaction should run through GAG on the Mac where the editor is installed. GAE remains responsible for design, headless processing, and non-GUI verification.

## Integration modes

### Mode A — external MCP adapter

Preferred first mode.

The gag adapter connects to Palmier's existing MCP endpoint and maps canonical Editorial IR operations to supported Palmier tools.

Benefits:

- no Palmier source modification;
- minimal license and upgrade coupling;
- fastest validation of agent-operated timeline editing;
- easy comparison against headless output.

Risks:

- MCP tool coverage may not represent every IR operation;
- tool names and semantics may change between Palmier releases;
- round-trip inspection may be incomplete;
- complex effects and caption styling may be lossy.

### Mode B — NLE XML interchange

Use the core's XML output as a second path.

Benefits:

- validates a renderer-neutral interchange artifact;
- provides a route to Premiere and Resolve;
- does not require direct timeline mutation.

Risks:

- modern effects, generated-media metadata, style semantics, and some caption behavior may not survive;
- path relinking and track semantics require testing.

### Mode C — separate Palmier fork

Use only when a blocking capability cannot be implemented through MCP or interchange.

Rules:

- create a separate fork or managed worktree;
- never copy Palmier source into GPT-Agent;
- isolate changes as a narrow adapter or missing MCP capability;
- preserve upstream attribution and GPLv3 obligations;
- do not make GPT-Agent core depend on fork-only types;
- document the upstream version and patch set.

The legal effect of combining or distributing GPLv3 components depends on the actual integration and distribution model. Local private experimentation is different from distributing a combined product; obtain specific legal review before product distribution.

## Adapter contract

The Palmier adapter accepts:

```text
editorial-ir.json
asset-manifest.json
palmier-capabilities.json
project target identifier
```

It outputs:

```text
palmier-apply-report.json
palmier-project-state.json or supported snapshot
palmier-export.xml
optional palmier-preview.mp4
mapping-loss-report.json
```

Every operation receives one status:

- `applied_exactly`;
- `applied_with_fallback`;
- `unsupported`;
- `failed`;
- `skipped_by_policy`.

No canonical operation may be omitted without a status and reason.

## Initial MCP operation set

Do not start by exposing every Palmier tool. Validate a bounded set:

1. inspect active project and timeline;
2. import or locate an asset;
3. create or identify a sequence;
4. place a source range;
5. trim and split;
6. reorder clips;
7. place basic text/caption events;
8. set basic transform, opacity, and speed when supported;
9. inspect resulting timeline state;
10. export preview or NLE XML.

Generated media, external model calls, and paid credits are excluded from the first lab.

## Experiment sequence

### LAB-0 — capability inventory

- record Palmier version and commit/release;
- list available MCP tools and schemas;
- create `palmier-capabilities.json`;
- classify exact, partial, and unsupported mappings.

Exit condition: the adapter can reason from a stored capability profile rather than assumptions.

### LAB-1 — deterministic timeline construction

Apply a hand-authored Editorial IR containing three source selections, one reorder, and basic captions.

Exit condition: Palmier timeline state matches the IR within one frame and reports every mapping.

### LAB-2 — headless parity

Compile the same IR through the headless renderer and Palmier.

Compare:

- clip order;
- source in/out points;
- sequence duration;
- caption timing and text;
- audio fades;
- unsupported semantics.

Exit condition: all timing differences are explained and bounded.

### LAB-3 — analysis-generated first cut

Use the MVP interview fixture to generate IR through the gag core, then apply it to Palmier without replanning.

Exit condition: the Palmier adapter consumes the same canonical IR used for the headless preview.

### LAB-4 — XML bridge to Premiere

Export NLE XML from the canonical compiler and optionally from Palmier. Import them into Premiere on the Mac and compare behavior.

Exit condition: the team has a measured compatibility matrix. Direct Premiere automation is not required.

### LAB-5 — missing capability decision

For each blocking gap, choose one:

- retain headless rendering;
- use XML fallback;
- add a local post-process;
- contribute an upstream Palmier MCP tool;
- maintain a minimal fork patch;
- defer the feature.

A fork is the last option, not the default.

## Test ownership

- **GAE:** architecture, schemas, headless pipeline, fixtures, deterministic checks, and comparison logic.
- **GAG on Mac:** Palmier installation, localhost MCP connection, GUI-visible verification, exports, and later Premiere import tests.
- **Human editor:** qualitative assessment and correction-time measurement.

## Version pinning

Every Palmier result must record:

- application version;
- source commit when built locally;
- MCP tool inventory hash;
- macOS version;
- adapter version;
- project and fixture hashes.

A Palmier update triggers capability re-inventory before regression results are accepted.

## Lab completion condition

Palmier is considered a viable adapter when the canonical MVP IR can be applied without replanning, its timeline can be inspected or exported, all unsupported operations are reported, and the resulting edit is materially equivalent to the headless reference for cuts and caption timing.

# AI Video Production OS — Design Baseline v0

Status: provisional architecture freeze  
Owner: GPT-Agent / gag  
Scope: design only; no runtime integration, deployment, or production mutation

## Decision

Build a renderer-neutral AI post-production core inside the GPT-Agent ecosystem. The core must work without Adobe Premiere Pro and must treat Premiere Pro, Palmier Pro, FFmpeg, and future NLEs as adapters rather than as the source of truth.

The first test host is Palmier Pro because it exposes a local MCP server, offers an editable multi-track timeline, is open source, and exports NLE XML for Premiere Pro and DaVinci Resolve. Palmier is a laboratory and reference adapter, not the core architecture.

## Product target

The long-term product is an AI post-production operating layer that can:

1. understand footage, speech, speakers, shots, expressions, audio events, and story function;
2. create an editorial plan before applying timeline operations;
3. produce cuts, captions, audio treatments, graphics, effects, and review notes;
4. compile the same editorial intent into multiple execution targets;
5. render a preview without requiring a commercial NLE;
6. inspect the rendered result and propose bounded corrections;
7. learn from human timeline corrections without overwriting the base rules.

The MVP does not claim autonomous television-grade delivery. Its target is a reviewable first cut whose logic is inspectable and reproducible.

## Non-negotiable architecture rules

- The source of truth is `Editorial IR`, not a Premiere project, Palmier project, XML file, or FFmpeg command.
- Analysis output and editorial decisions remain separate.
- Every destructive-looking operation is represented as a non-destructive source-range selection.
- Core phases have versioned input/output contracts.
- Experimental capabilities enter through Special Phases and cannot silently modify stable phase contracts.
- The headless path must generate a preview, captions, timeline interchange, and QC report without Premiere or Palmier.
- NLE adapters may fail independently without invalidating the editorial plan.
- Human corrections are stored as diffs and preferences, not directly merged into global rules.

## Baseline pipeline

```text
Media / brief / references
  -> P0 Project Contract
  -> P1 Ingest and Normalize
  -> P2 Production Intelligence Graph
  -> P3 Editorial Planning
  -> P4 Editorial IR Validation
  -> P5 Timeline Compilation
  -> P6 Headless Preview Render
  -> P7 Automated Review and QC
  -> P8 Human Review and Correction Diff
  -> Adapters: Palmier / Premiere / Resolve / FFmpeg
```

Special Phases may be inserted only at declared extension points. See `phase-model.md`.

## MVP definition

### Supported input

- one talking-head or interview recording;
- optional second synchronized camera;
- 5–30 minutes of source material;
- Japanese speech as the primary language;
- local media files with a known frame rate.

### Required output

- `analysis.json`: time-aligned speech, silence, shot, speaker, and quality signals;
- `editorial-ir.json`: selected source ranges, captions, transitions, audio instructions, and reasons;
- `preview.mp4`: headless deterministic review render;
- `captions.srt` or `captions.ass`;
- `timeline.xml`: interchange output intended for Premiere Pro and DaVinci Resolve;
- `qc-report.json`: timing, continuity, caption, clipping, and schema findings;
- `human-diff.json`: optional corrections made after review.

### MVP completion condition

Given a fixed test clip, one command or gag task produces the required output set, passes schema validation, and generates a preview whose cut points and captions correspond to `editorial-ir.json`. The same IR can then be imported or applied through the Palmier adapter without changing the core plan.

## Repository boundary

This directory contains architecture and contracts only. Runtime implementation should not begin until the contracts, fixture set, and MVP acceptance tests are approved.

Recommended later implementation location:

```text
src/video-production/
  core/
  phases/
  schemas/
  adapters/
  review/
  fixtures/
```

Palmier source modifications, if needed, must live in a separate fork or worktree. Do not copy GPLv3 Palmier source into GPT-Agent. Prefer MCP and file interchange boundaries.

## Documents

- `architecture.md` — component boundaries and data flow
- `phase-model.md` — stable phases, Special Phases, and insertion rules
- `mvp-test-plan.md` — Premiere-independent acceptance strategy
- `palmier-pro-lab.md` — Palmier integration and experiment plan
- `editorial-ir-v0.schema.json` — provisional machine-readable IR contract

## External references

- Palmier Pro: https://www.palmier.io/
- Palmier documentation: https://www.palmier.io/docs
- Palmier source: https://github.com/palmier-io/palmier-pro

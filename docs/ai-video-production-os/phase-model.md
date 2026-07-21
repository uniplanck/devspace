# Stable Phases and Special Phase Model

## Purpose

The pipeline needs enough stability to complete an MVP without preventing later experiments. The correct freeze is a provisional freeze of phase boundaries, schemas, and acceptance gates. Implementations, model providers, and editor targets remain replaceable.

## Stable phase sequence

| ID | Phase | Input | Output | MVP gate |
|---|---|---|---|---|
| P0 | Project Contract | user brief, delivery constraints | `project-contract.json` | required fields and approval policy valid |
| P1 | Ingest and Normalize | source media | `asset-manifest.json`, proxies, normalized audio | reproducible fingerprints and time bases |
| P2 | Production Intelligence | manifest and normalized media | `analysis.json` / Production Graph | provenance and time alignment valid |
| P3 | Editorial Planning | contract and Production Graph | candidate editorial plans | rationale and confidence present |
| P4 | IR Assembly and Validation | chosen plan | `editorial-ir.json` | schema, range, and policy checks pass |
| P5 | Timeline Compilation | IR and adapter capability profile | target timeline instructions | no silent operation loss |
| P6 | Headless Preview | compiled headless plan | `preview.mp4`, captions | deterministic output generated |
| P7 | Review and QC | preview, IR, contract | `qc-report.json`, correction proposal | blocking checks pass or are reported |
| P8 | Human Review Diff | approved human changes | `human-diff.json` | corrections scoped and reversible |

## Provisional freeze rule

Version `v0` freezes:

- names and ordering of stable phases;
- required artifact names;
- the principle that analysis, planning, and execution are separate;
- the Editorial IR envelope;
- extension-point identifiers;
- acceptance-gate semantics.

Version `v0` does not freeze:

- model vendors;
- prompt wording;
- exact scoring weights;
- UI;
- NLE-specific implementation;
- internal algorithms;
- optional fields inside extension namespaces.

A change to a stable phase contract requires an Architecture Decision Record and a schema version increment. A Special Phase does not.

## Extension points

Special Phases may be inserted at the following named boundaries:

```text
X0  after P0, before ingest
X1  after P1, before intelligence
X2  during P2 as an analysis contributor
X3  after P2, before editorial planning
X4  during P3 as a planning contributor
X5  after P4 validation, before compilation
X6  during P5 as an adapter transform
X7  after P6 render, before QC
X8  after P7, before human review
X9  after P8 as a learning candidate
```

## Special Phase contract

Every Special Phase must provide a manifest.

```yaml
id: SP-CAPTION-EMPHASIS-v0
name: Japanese emphasis caption classifier
extension_point: X4
status: experimental
inputs:
  - production_graph.v0
  - editorial_plan.v0
outputs:
  patch_type: editorial_plan_patch.v0
permissions:
  network: optional
  external_generation: false
fallback: no_op
failure_policy: continue_with_warning
acceptance_tests:
  - fixtures/interview-ja-01
owner: video-production
```

Required properties:

- unique ID and version;
- exact extension point;
- accepted input versions;
- output as a patch, annotation, or candidate—not an undocumented mutation;
- permissions and side effects;
- deterministic fallback;
- failure policy;
- fixtures and acceptance criteria;
- promotion criteria.

## Special Phase classes

### Analysis contributor

Adds observations to the Production Graph, such as facial reaction detection, music beat analysis, or on-screen text recognition.

It may not delete observations produced by other contributors. Conflicts remain visible with provenance and confidence.

### Planning contributor

Proposes editorial decisions, such as a cold-open candidate, reaction insert, caption emphasis, B-roll request, or audio motif.

It outputs ranked candidates or a patch. The stable planner accepts or rejects them.

### Compilation transform

Maps canonical intent to adapter-specific operations or fallbacks. It cannot change the editorial rationale to fit an editor limitation.

### Review critic

Adds findings after preview render. It may propose corrections but cannot rewrite the accepted IR without returning through P4 validation.

### Learning candidate

Extracts a possible preference from human corrections. It remains project-scoped until explicitly promoted.

## Promotion path

A Special Phase moves through:

```text
experimental -> fixture-validated -> shadow -> opt-in -> default -> stable candidate
```

Promotion conditions:

1. schema-valid outputs across the fixture set;
2. no increase in blocking QC failures;
3. measurable improvement against a named metric;
4. deterministic or bounded fallback;
5. acceptable latency and cost;
6. no additional permission without explicit policy change;
7. human review of representative failures.

A feature is not promoted because a single demo looks good.

## MVP phase allocation

### Core MVP

- P0–P8 skeleton and artifacts;
- single-camera Japanese interview path;
- word-timestamp transcript;
- silence, filler, and repeated-phrase candidates;
- conservative source-range selection;
- basic caption segmentation;
- audio fades and loudness normalization instructions;
- headless preview;
- XML interchange;
- deterministic QC.

### Initial Special Phases

- `SP-REACTION-SCORE-v0` at X2: optional face/expression observations;
- `SP-CAPTION-EMPHASIS-v0` at X4: semantic emphasis captions;
- `SP-PALMIER-MCP-v0` at X6: Palmier timeline application;
- `SP-SEMANTIC-CRITIC-v0` at X7: rendered-video review suggestions.

These are explicitly non-blocking for the first MVP. The MVP is complete even if they are disabled.

## Scope control

### NOW

Freeze contracts, define fixtures, implement the headless path, and prove IR-to-preview correspondence.

### NEXT

Add Palmier MCP as the first interactive timeline adapter and compare it with NLE XML import.

### LATER

Add richer graphics, effects, B-roll generation, multi-camera grammar, Premiere UXP, and human preference learning.

### HOLD

General television genres, fully autonomous delivery, custom foundation-model training, and a complete proprietary NLE.

### DROP

Any requirement that makes Palmier or Premiere mandatory for testing the core, or allows an experimental phase to mutate stable artifacts without a versioned patch.

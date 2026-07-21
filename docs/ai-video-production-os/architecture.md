# Reference Architecture v0

## Architectural verdict

Freeze interfaces, not implementations.

The system must preserve a stable path from analyzed media to editorial intent, while allowing analysis models, renderers, NLEs, and effect engines to change independently. Prematurely freezing model choices or Palmier/Premiere-specific operations would create the wrong dependency direction.

## System boundary

```text
                         +-------------------------+
                         | gag orchestration layer |
                         +------------+------------+
                                      |
                         project contract / policy
                                      |
          +---------------------------v---------------------------+
          |              Production Intelligence Core             |
          | speech | speakers | shots | faces | motion | audio QC |
          +---------------------------+---------------------------+
                                      |
                             Production Graph
                                      |
          +---------------------------v---------------------------+
          |                 Editorial Planning Core                |
          | structure | selections | captions | audio | graphics |
          +---------------------------+---------------------------+
                                      |
                                Editorial IR
                                      |
                    +-----------------v-----------------+
                    | validator / policy / diff engine |
                    +-----------------+-----------------+
                                      |
              +-----------------------+-----------------------+
              |                       |                       |
      Headless compiler       Palmier adapter        Premiere adapter
      FFmpeg + overlays         MCP / project          XML first, UXP later
              |                       |                       |
        preview + QC             Palmier timeline        Premiere timeline
```

## Core components

### 1. Project Contract

Defines the job before analysis begins.

Required fields:

- target duration or duration range;
- format and frame rate;
- audience and platform;
- editorial objective;
- approved style profile;
- mandatory inclusions and exclusions;
- allowed automation level;
- output targets;
- review checkpoints.

The contract prevents the planner from optimizing for an unstated goal.

### 2. Media Ingest

Responsibilities:

- fingerprint source files;
- inspect streams and metadata;
- create proxies and normalized audio;
- preserve original time bases;
- detect variable frame-rate risk;
- build a reproducible asset manifest.

FFmpeg may be used here as a deterministic media utility. It is not treated as the intelligence layer.

### 3. Production Intelligence Graph

A time-aligned graph of observations rather than a flat transcript.

Example node types:

- speech segment and word;
- speaker identity or anonymous speaker cluster;
- shot and scene;
- person track, face, expression, gaze, and gesture;
- sound event and music beat;
- technical quality event;
- topic, claim, reaction, setup, and payoff;
- cross-camera synchronization relation.

Every observation stores provenance, confidence, model/version, and source time range.

### 4. Editorial Planning Core

Produces editorial decisions from the project contract and Production Graph.

Planning is hierarchical:

```text
program -> sequence -> beat -> shot -> frame boundary
```

The planner must create alternatives when confidence is low. It must not hide uncertainty by producing one authoritative timeline.

### 5. Editorial IR

Editorial IR is the system source of truth.

It represents:

- source-range selections;
- sequence order;
- J/L cuts and transitions;
- captions and semantic style tokens;
- audio gain, cleanup, ducking, and fades;
- overlays, graphics, effects, and generated-asset requests;
- rationale, confidence, provenance, and fallback behavior.

It must avoid direct dependency on Premiere effect IDs or Palmier-internal model types.

### 6. Validator and Policy Engine

Validation layers:

1. JSON schema and type validation;
2. time-range and frame-boundary validation;
3. overlap, gap, and asset-reference validation;
4. capability validation for the selected adapter;
5. editorial policy checks;
6. destructive-action and external-generation approval checks.

Unsupported operations must be reported or downgraded through an explicit fallback. They may not disappear silently.

### 7. Timeline Compilers

Each compiler maps Editorial IR into an execution target.

- **Headless compiler:** FFmpeg/filter graph plus caption and overlay renderer.
- **Palmier compiler:** MCP operations and, only when necessary, a small Palmier fork patch.
- **Premiere compiler:** NLE XML for the first implementation; UXP for operations XML cannot preserve.
- **Resolve compiler:** NLE XML initially; native scripting later.

Compiler behavior is deterministic for the same IR, capability profile, and media manifest.

### 8. Review and QC

Review is run against the rendered output, not only the plan.

Checks include:

- black frames and missing media;
- audiovisual drift;
- clipped or inaudible dialogue;
- abrupt audio edits;
- caption overflow, collision, and insufficient reading time;
- repeated or contradictory content;
- continuity and camera-switching violations;
- excessive cut frequency or static duration;
- target duration and delivery constraints.

AI critics can add semantic observations, but deterministic checks remain the release gate for machine-verifiable properties.

### 9. Human Correction Diff

Human changes are represented as diffs against the generated IR.

A correction records:

- before and after operation;
- affected time range;
- user-supplied reason when available;
- inferred preference separately from confirmed preference;
- scope: one project, one show profile, or global;
- confidence and expiry/review status.

Global style memory must never be changed from a single correction without explicit promotion.

## Capability profiles

Each adapter publishes a machine-readable capability profile.

Example:

```json
{
  "adapter": "palmier-pro",
  "version": "0.x",
  "supports": {
    "multi_track": true,
    "trim_split_reorder": true,
    "captions": true,
    "semantic_style_tokens": "partial",
    "mogrt": false,
    "native_effect_graph": "partial",
    "nle_xml_export": true
  }
}
```

The planner can constrain its output to a target profile or generate a richer canonical IR plus documented fallbacks.

## Security and execution boundaries

- Default to read/plan/preview operations.
- Timeline mutation requires a named project and explicit adapter target.
- Export and external generation are separate permissions.
- Original media is never overwritten.
- Every compiled output receives a new version identifier.
- Network model calls must be declared in the project contract.
- Secrets and provider credentials do not enter analysis artifacts or logs.

## Decisions deferred

- exact multimodal model providers;
- local versus cloud transcription engine;
- motion graphics renderer;
- style-learning model;
- direct Palmier source patches;
- Premiere UXP implementation;
- distributed rendering.

These are intentionally deferred because the MVP can validate the architecture without fixing them.

# MVP Test Plan — Premiere-Independent First

## Test strategy

The MVP must be verifiable on EC2 or another headless environment. Premiere Pro and Palmier Pro are optional integration targets, not prerequisites for core correctness.

Testing is divided into four layers:

1. artifact contract tests;
2. deterministic media tests;
3. editorial quality review;
4. optional NLE adapter tests.

## Primary MVP scenario

### Input fixture

A 5–10 minute Japanese talking-head clip containing:

- normal speech;
- at least three pauses longer than the configured threshold;
- at least three filler words;
- one repeated phrase or self-correction;
- one intentional dramatic pause that should remain;
- one caption-length edge case;
- stable frame rate and usable dialogue audio.

A second fixture may add a synchronized reaction camera, but it is not a blocker for MVP completion.

### Required pipeline result

```text
fixture media
  -> asset-manifest.json
  -> analysis.json
  -> editorial-ir.json
  -> preview.mp4
  -> captions.srt or captions.ass
  -> timeline.xml
  -> qc-report.json
```

## Acceptance gates

### Gate A — artifact validity

- every required artifact exists;
- every JSON artifact passes its versioned schema;
- every referenced asset exists in the manifest;
- source time ranges are non-negative, ordered, and inside source duration;
- selected ranges do not overlap unless the operation explicitly permits it;
- the generated timeline duration matches the IR calculation within one frame.

### Gate B — deterministic compilation

Given the same source hashes, project contract, IR, compiler version, and seed:

- the sequence operation list is identical;
- the caption event list is identical;
- preview duration is identical within one frame;
- output hashes may differ only where the encoder is documented as nondeterministic.

### Gate C — audiovisual integrity

- no missing-media frame;
- no unexpected black frame longer than two frames;
- no audio/video drift above one frame at the end of the preview;
- no sample clipping above the configured true-peak limit;
- every hard dialogue cut receives a configured fade or room-tone treatment unless explicitly waived;
- captions remain inside the render-safe region.

### Gate D — editorial correspondence

For a sample of operations:

- the source range used in `preview.mp4` matches `editorial-ir.json`;
- retained dramatic pauses remain present;
- filler removals do not cut adjacent phonemes materially;
- repeated-phrase removal preserves the intended sentence;
- captions correspond to the selected dialogue and remain readable for the configured minimum duration.

This gate requires a human review checklist for the first MVP. It is not reduced to a model score.

### Gate E — reversible handoff

- the original source media is untouched;
- recompiling after changing one IR operation changes only the expected output region;
- a previous IR version can regenerate its previous preview;
- unsupported NLE operations appear in a capability/fallback report.

## Golden fixture policy

Each fixture directory should eventually contain:

```text
fixtures/interview-ja-01/
  source/
  project-contract.json
  expected/
    required-decisions.json
    forbidden-decisions.json
    caption-cases.json
    qc-expectations.json
  review/
    reviewer-notes.md
```

Do not store large source media in the main Git repository. Store hashes, generation instructions, or a controlled external fixture location.

## Quality metrics

Machine metrics are supporting evidence, not the complete definition of editorial quality.

| Metric | MVP use |
|---|---|
| transcript word accuracy | diagnose recognition errors |
| cut-boundary phoneme damage | block visibly/audibly broken cuts |
| retained-content coverage | detect excessive deletion |
| caption reading-time compliance | block unreadable captions |
| caption line-length compliance | block layout overflow |
| loudness and true peak | delivery safety |
| AV synchronization | technical integrity |
| human correction time | primary product metric |

The most useful MVP product metric is:

> Minutes of human correction required to turn a generated first cut into an acceptable deliverable.

## Comparison matrix

Generate the same IR through multiple paths when available.

| Path | Required for MVP | Purpose |
|---|---:|---|
| Headless FFmpeg preview | yes | core correctness and CI |
| NLE XML import | yes as artifact, manual import later | interchange viability |
| Palmier MCP adapter | no, first integration experiment | interactive timeline validation |
| Premiere direct adapter | no | later production workflow validation |

## Palmier comparison test

When a Mac test host is available:

1. load the source fixture into Palmier;
2. apply the canonical IR through the Palmier MCP adapter;
3. export Palmier preview and NLE XML;
4. compare event order, source ranges, captions, and duration with the headless reference;
5. record unsupported or lossy mappings;
6. do not modify the canonical IR to hide Palmier limitations.

## Premiere handoff test

Premiere is not required during core development. The first Premiere-specific test is limited to importing `timeline.xml` and verifying:

- media relink behavior;
- clip order and source ranges;
- audio/video track mapping;
- caption import behavior;
- sequence frame rate and duration;
- a documented list of effects or semantics that do not survive interchange.

Direct UXP automation begins only after XML limitations are measured.

## MVP exit criteria

The MVP is complete when:

1. one approved Japanese interview fixture passes Gates A–E;
2. the headless path produces all required artifacts without a desktop NLE;
3. each cut and caption can be traced to analysis evidence and an editorial rationale;
4. changing the target adapter does not require re-running editorial planning;
5. Palmier integration is either demonstrated or explicitly listed as a non-blocking pending experiment;
6. the remaining human correction time and failure modes are measured and documented.

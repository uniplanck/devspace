import assert from 'node:assert/strict';
import {
  buildMulticamEditorialIr,
  buildMulticamQc,
  estimateAudioOffset,
  normalizeCameraPlan,
} from './multicam-core.mjs';

function syntheticEnvelope(length = 700) {
  const values = Array.from({ length }, () => 0);
  const events = [
    [45, 12, 0.8],
    [132, 18, 0.45],
    [224, 9, 1],
    [360, 24, 0.62],
    [515, 14, 0.9],
  ];
  for (const [start, width, amplitude] of events) {
    for (let index = 0; index < width; index += 1) {
      values[start + index] = amplitude * (1 - Math.abs(index - width / 2) / (width / 2 + 1));
    }
  }
  return values;
}

const reference = syntheticEnvelope();
const delayed = Array.from({ length: reference.length + 80 }, () => 0);
for (let index = 0; index < reference.length; index += 1) delayed[index + 50] = reference[index];
const sync = estimateAudioOffset(reference, delayed, 50, {
  maximumOffsetSeconds: 3,
  minimumOverlapFrames: 200,
  minimumSyncConfidence: 0.5,
  minimumCorrelationScore: 0.4,
});
assert.equal(sync.status, 'synced');
assert.ok(Math.abs(sync.sourceOffsetSeconds - 1) <= 0.02, JSON.stringify(sync));
assert.ok(sync.confidence >= 0.5);

const plan = normalizeCameraPlan([
  { assetId: 'cam-a', timelineIn: 0, timelineOut: 2.5 },
  { assetId: 'cam-b', timelineIn: 2.5, timelineOut: 5 },
], 5, 'cam-a');
assert.equal(plan.length, 2);
assert.throws(() => normalizeCameraPlan([
  { assetId: 'cam-a', timelineIn: 0, timelineOut: 2 },
  { assetId: 'cam-b', timelineIn: 2.2, timelineOut: 5 },
], 5, 'cam-a'), /not contiguous/u);

const referenceIr = {
  schemaVersion: '0.2.0',
  projectId: 'reference',
  intent: '不要区間を除去する',
  timeline: {
    frameRate: 30,
    durationSeconds: 5,
    sourceDurationSeconds: 7,
    operations: [
      { id: 'select-1', type: 'select_range', assetId: 'cam-a', sourceIn: 0, sourceOut: 2, timelineIn: 0 },
      { id: 'select-2', type: 'select_range', assetId: 'cam-a', sourceIn: 4, sourceOut: 7, timelineIn: 2 },
      { id: 'caption-1', type: 'caption', timelineIn: 0.2, timelineOut: 1.5, text: 'テスト' },
    ],
  },
  generatedAt: '2026-07-21T00:00:00.000Z',
};
const assets = [
  { id: 'cam-a', durationSeconds: 7, hasAudio: true },
  { id: 'cam-b', durationSeconds: 9, hasAudio: true },
];
const synchronization = {
  'cam-a': { method: 'reference', status: 'synced', sourceOffsetSeconds: 0, confidence: 1 },
  'cam-b': { method: 'audio_correlation', status: 'synced', sourceOffsetSeconds: 1, confidence: 0.9 },
};
const built = buildMulticamEditorialIr({
  projectId: 'multicam-test',
  referenceEditorialIr: referenceIr,
  referenceAssetId: 'cam-a',
  assets,
  synchronization,
  cameraPlan: [
    { assetId: 'cam-a', timelineIn: 0, timelineOut: 2.5 },
    { assetId: 'cam-b', timelineIn: 2.5, timelineOut: 5 },
  ],
  generatedAt: '2026-07-21T00:01:00.000Z',
});
const selects = built.editorialIr.timeline.operations.filter((operation) => operation.type === 'select_range');
assert.equal(selects.length, 3);
assert.deepEqual(selects.map((operation) => operation.assetId), ['cam-a', 'cam-a', 'cam-b']);
assert.equal(selects[2].timelineIn, 2.5);
assert.equal(selects[2].referenceSourceIn, 4.5);
assert.equal(selects[2].sourceIn, 5.5);
assert.equal(selects[2].sourceOut, 8);
assert.equal(selects[2].audioAssetId, 'cam-b');
assert.equal(selects[2].audioSourceIn, 5.5);
assert.ok(built.editorialIr.timeline.operations.some((operation) => operation.type === 'caption'));
assert.equal(built.warnings.length, 0);

const qc = buildMulticamQc({
  editorialIr: built.editorialIr,
  assets,
  synchronization,
  warnings: built.warnings,
});
assert.equal(qc.status, 'pass');
assert.equal(qc.summary.selectedAssetCount, 2);
assert.equal(qc.summary.audioStrategy, 'selected_asset');

const masterBuilt = buildMulticamEditorialIr({
  projectId: 'multicam-master-audio',
  referenceEditorialIr: referenceIr,
  referenceAssetId: 'cam-a',
  assets,
  synchronization,
  cameraPlan: [
    { assetId: 'cam-a', timelineIn: 0, timelineOut: 2.5 },
    { assetId: 'cam-b', timelineIn: 2.5, timelineOut: 5 },
  ],
  audioStrategy: 'master_audio',
  masterAudioAssetId: 'cam-a',
});
const masterSelects = masterBuilt.editorialIr.timeline.operations.filter((operation) => operation.type === 'select_range');
assert.equal(masterBuilt.editorialIr.multicam.audioStrategy, 'master_audio');
assert.equal(masterBuilt.editorialIr.multicam.masterAudioAssetId, 'cam-a');
assert.deepEqual([...new Set(masterSelects.map((operation) => operation.audioAssetId))], ['cam-a']);
assert.deepEqual(masterSelects.map((operation) => operation.audioSourceIn), [0, 4, 4.5]);
const masterQc = buildMulticamQc({
  editorialIr: masterBuilt.editorialIr,
  assets,
  synchronization,
  warnings: masterBuilt.warnings,
});
assert.equal(masterQc.status, 'pass');
assert.equal(masterQc.summary.audioStrategy, 'master_audio');
assert.deepEqual(masterQc.summary.audioAssetIds, ['cam-a']);
assert.throws(() => buildMulticamEditorialIr({
  projectId: 'multicam-invalid-master',
  referenceEditorialIr: referenceIr,
  referenceAssetId: 'cam-a',
  assets,
  synchronization: {
    ...synchronization,
    'cam-b': { method: 'audio_correlation', status: 'review', sourceOffsetSeconds: 1, confidence: 0.2 },
  },
  cameraPlan: [{ assetId: 'cam-a', timelineIn: 0, timelineOut: 5 }],
  audioStrategy: 'master_audio',
  masterAudioAssetId: 'cam-b',
}), /not synchronized/u);

const reviewBuilt = buildMulticamEditorialIr({
  projectId: 'multicam-review',
  referenceEditorialIr: referenceIr,
  referenceAssetId: 'cam-a',
  assets,
  synchronization: {
    ...synchronization,
    'cam-b': { method: 'audio_correlation', status: 'review', sourceOffsetSeconds: 1, confidence: 0.3 },
  },
  cameraPlan: [
    { assetId: 'cam-a', timelineIn: 0, timelineOut: 2.5 },
    { assetId: 'cam-b', timelineIn: 2.5, timelineOut: 5 },
  ],
});
assert.ok(reviewBuilt.warnings.length > 0);
assert.ok(reviewBuilt.editorialIr.timeline.operations.filter((operation) => operation.type === 'select_range').every((operation) => operation.assetId === 'cam-a'));

console.log('multicam-core tests passed');

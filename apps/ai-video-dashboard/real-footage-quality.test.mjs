import assert from 'node:assert/strict';
import { buildRealFootageQualityReport } from './real-footage-quality.mjs';

const project = { id: 'quality-test', outputDurationSeconds: 8 };
const analysis = {
  referenceAssetId: 'cam-a',
  assets: [
    { id: 'cam-a', durationSeconds: 12 },
    { id: 'cam-b', durationSeconds: 13.2 },
  ],
};
const editorialIr = {
  projectId: 'quality-test',
  multicam: { audioStrategy: 'master_audio', masterAudioAssetId: 'cam-a', fallbackCount: 0 },
  timeline: {
    durationSeconds: 8,
    operations: [
      { id: 's1', type: 'select_range', assetId: 'cam-a', sourceIn: 0, sourceOut: 3, timelineIn: 0, audioAssetId: 'cam-a', audioSourceIn: 0, audioSourceOut: 3 },
      { id: 's2', type: 'select_range', assetId: 'cam-b', sourceIn: 4.2, sourceOut: 9.2, timelineIn: 3, audioAssetId: 'cam-a', audioSourceIn: 3, audioSourceOut: 8 },
    ],
  },
};
const qc = { summary: { fallbackCount: 0 } };
const syncAudit = {
  assets: {
    'cam-a': { method: 'reference', windows: [], driftMsPerMinute: 0 },
    'cam-b': {
      method: 'audio_correlation',
      driftMsPerMinute: 8,
      windows: [
        { confidence: 0.91, absoluteOffsetSeconds: 1.2 },
        { confidence: 0.88, absoluteOffsetSeconds: 1.201 },
        { confidence: 0.9, absoluteOffsetSeconds: 1.202 },
      ],
    },
  },
};
const previewAudit = { durationSeconds: 8.02, hasAudio: true, meanVolumeDb: -18, maxVolumeDb: -1.2, boundarySilenceHits: [] };

const pass = buildRealFootageQualityReport({ project, analysis, editorialIr, qc, syncAudit, previewAudit });
assert.equal(pass.status, 'pass');
assert.equal(pass.score, 100);
assert.equal(pass.recommendations.length, 0);

const review = buildRealFootageQualityReport({
  project,
  analysis,
  editorialIr,
  qc,
  syncAudit: {
    assets: {
      ...syncAudit.assets,
      'cam-b': {
        ...syncAudit.assets['cam-b'],
        driftMsPerMinute: 45,
        windows: syncAudit.assets['cam-b'].windows.map((window) => ({ ...window, confidence: 0.5 })),
      },
    },
  },
  previewAudit: {
    ...previewAudit,
    maxVolumeDb: -0.05,
    boundarySilenceHits: [{ boundarySeconds: 3, silence: { start: 2.98, end: 3.1 } }],
  },
});
assert.equal(review.status, 'review');
assert.ok(review.score >= 70 && review.score < 100);
assert.ok(review.recommendations.some((item) => item.checkId === 'sync-drift'));

const invalidIr = structuredClone(editorialIr);
invalidIr.timeline.operations[1].sourceOut = 99;
invalidIr.timeline.operations[1].audioAssetId = 'cam-b';
const fail = buildRealFootageQualityReport({
  project,
  analysis,
  editorialIr: invalidIr,
  qc,
  syncAudit: { assets: {} },
  previewAudit: { durationSeconds: 0, hasAudio: false, boundarySilenceHits: [] },
});
assert.equal(fail.status, 'fail');
assert.ok(fail.checks.some((item) => item.id === 'source-bounds' && item.status === 'fail'));
assert.ok(fail.checks.some((item) => item.id === 'master-audio-consistency' && item.status === 'fail'));

console.log('real-footage-quality tests passed');

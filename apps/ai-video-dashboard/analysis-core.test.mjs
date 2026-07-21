import assert from 'node:assert/strict';
import {
  DEFAULT_ANALYSIS_POLICY,
  analyzeTranscript,
  buildAnalysisDocument,
  buildEditorialIr,
  buildQcReport,
  planRemovals,
  subtractRanges,
} from './analysis-core.mjs';

const media = {
  durationSeconds: 12,
  frameRate: 30,
  width: 1280,
  height: 720,
  hasAudio: true,
  fingerprint: '0123456789abcdef',
};
const transcript = {
  language: 'ja',
  provider: 'fixture',
  segments: [
    { id: 's1', start: 0, end: 1.8, speaker: 'A', text: '今日はAI動画編集の検証をします。' },
    { id: 's2', start: 3.2, end: 4.1, speaker: 'A', text: 'えっと' },
    { id: 's3', start: 4.1, end: 5.0, speaker: 'A', text: '編集ソフトを、いや' },
    { id: 's4', start: 6.3, end: 8.5, speaker: 'A', text: '編集判断を正本にします。' },
    { id: 's5', start: 8.5, end: 11.5, speaker: 'A', text: '同じ判断をPalmierへ反映します。' },
  ],
};
const silences = [
  { start: 1.9, end: 3.2 },
  { start: 5.0, end: 6.3 },
];

const transcriptAnalysis = analyzeTranscript(transcript);
assert.ok(transcriptAnalysis.findings.some((finding) => finding.type === 'filler_only' && finding.autoRemove));
assert.ok(transcriptAnalysis.findings.some((finding) => finding.type === 'false_start' && finding.autoRemove));

const plan = planRemovals({ durationSeconds: media.durationSeconds, silences, transcript });
assert.equal(plan.silences.length, 2);
assert.equal(plan.removals.length, 1);
assert.ok(plan.removals[0].reason.includes('filler_only'));
assert.ok(plan.removals[0].reason.includes('false_start'));
assert.equal(plan.removals[0].duration, 4.16);

const keeps = subtractRanges(media.durationSeconds, plan.removals);
assert.ok(keeps.length >= 2);
assert.equal(keeps[0].start, 0);
assert.equal(keeps.at(-1).end, 12);
for (let index = 1; index < keeps.length; index += 1) {
  assert.ok(keeps[index].timelineIn >= keeps[index - 1].timelineIn + keeps[index - 1].duration - 0.001);
}

const editorialIr = buildEditorialIr({
  projectId: 'analysis-lab',
  assetId: 'cam-a',
  media,
  transcript,
  plan,
  generatedAt: '2026-07-21T05:00:00.000Z',
});
assert.equal(editorialIr.schemaVersion, '0.2.0');
assert.ok(editorialIr.timeline.operations.filter((operation) => operation.type === 'select_range').length >= 2);
assert.ok(editorialIr.timeline.operations.some((operation) => operation.type === 'caption' && operation.text.includes('正本')));
assert.ok(!editorialIr.timeline.operations.some((operation) => operation.type === 'caption' && operation.text === 'えっと'));
assert.ok(editorialIr.timeline.durationSeconds < media.durationSeconds);

const analysis = buildAnalysisDocument({ media, transcript, plan, sceneChanges: [], generatedAt: editorialIr.generatedAt });
assert.equal(analysis.version, 'analysis.v1');
assert.equal(analysis.signals.semanticVision.status, 'not_implemented');

const qc = buildQcReport({ media, transcript, plan, editorialIr, sceneChanges: [] });
assert.equal(qc.status, 'review');
assert.ok(qc.summary.removedDurationSeconds > 0);
assert.ok(qc.warnings.some((warning) => warning.includes('表情')));

const noTranscriptPlan = planRemovals({
  durationSeconds: 5,
  silences: [{ start: 1, end: 2 }],
  transcript: { segments: [] },
  policy: DEFAULT_ANALYSIS_POLICY,
});
assert.equal(noTranscriptPlan.transcriptFindings.length, 0);

console.log('analysis-core tests passed');

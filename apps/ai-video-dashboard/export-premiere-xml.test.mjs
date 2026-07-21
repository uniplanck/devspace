import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildPremiereXmlDocument, buildSrt } from './export-premiere-xml.mjs';

const execFileAsync = promisify(execFile);
const editorialIr = {
  schemaVersion: '0.3.0',
  projectId: 'master-audio-lab',
  timeline: {
    frameRate: 30,
    durationSeconds: 7.84,
    operations: [
      { id: 'select-1', type: 'select_range', assetId: 'cam-a', sourceIn: 0, sourceOut: 2.02, timelineIn: 0, audioAssetId: 'cam-a', audioSourceIn: 0, audioSourceOut: 2.02 },
      { id: 'select-2', type: 'select_range', assetId: 'cam-b', sourceIn: 7.38, sourceOut: 9.7, timelineIn: 2.02, audioAssetId: 'cam-a', audioSourceIn: 6.18, audioSourceOut: 8.5 },
      { id: 'select-3', type: 'select_range', assetId: 'cam-a', sourceIn: 8.5, sourceOut: 12, timelineIn: 4.34, audioAssetId: 'cam-a', audioSourceIn: 8.5, audioSourceOut: 12 },
      { id: 'caption-1', type: 'caption', timelineIn: 0, timelineOut: 1.8, text: '今日はAI動画編集の検証をします。' },
      { id: 'caption-2', type: 'caption', timelineIn: 2.14, timelineOut: 4.34, text: '編集判断を正本にします。' },
    ],
  },
  multicam: { audioStrategy: 'master_audio', masterAudioAssetId: 'cam-a' },
};
const assetA = {
  path: '/tmp/cam a.mp4',
  name: 'cam a.mp4',
  durationSeconds: 12,
  width: 1280,
  height: 720,
  hasVideo: true,
  hasAudio: true,
  sampleRate: 48000,
  channels: 1,
};
const assetB = { ...assetA, path: '/tmp/cam-b.mp4', name: 'cam-b.mp4', durationSeconds: 13.2 };
const first = buildPremiereXmlDocument({ projectName: '検証 & Sequence', editorialIr, assets: { 'cam-a': assetA, 'cam-b': assetB } });
const second = buildPremiereXmlDocument({ projectName: '検証 & Sequence', editorialIr, assets: { 'cam-a': assetA, 'cam-b': assetB } });
assert.equal(first.document, second.document);
assert.equal(first.summary.totalFrames, 235);
assert.equal(first.summary.videoClipCount, 3);
assert.equal(first.summary.audioClipCount, 3);
assert.equal(first.summary.captionMarkerCount, 2);
assert.equal(first.summary.audioStrategy, 'master_audio');
assert.match(first.document, /<xmeml version="5">/);
assert.match(first.document, /<name>検証 &amp; Sequence<\/name>/);
assert.match(first.document, /file:\/\/\/tmp\/cam%20a\.mp4/);
assert.match(first.document, /<start>61<\/start>[\s\S]*?<end>130<\/end>/);
assert.match(first.document, /<sourcetrack>[\s\S]*?<mediatype>audio<\/mediatype>/);
assert.equal((first.document.match(/<clipitem id="video-clip-/g) || []).length, 3);
assert.equal((first.document.match(/<clipitem id="audio-clip-/g) || []).length, 3);
assert.equal((first.document.match(/<marker>/g) || []).length, 2);
const srt = buildSrt(editorialIr);
assert.match(srt, /00:00:00,000 --> 00:00:01,800/);
assert.match(srt, /今日はAI動画編集の検証をします。/);

const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'premiere-xml-test-'));
const xmlFile = path.join(tempDir, 'sequence.xml');
try {
  await fs.writeFile(xmlFile, first.document, 'utf8');
  const xmllint = (await Promise.all(['/usr/bin/xmllint', '/usr/local/bin/xmllint'].map(async (candidate) => (
    await fs.access(candidate).then(() => candidate).catch(() => null)
  )))).find(Boolean);
  if (xmllint) await execFileAsync(xmllint, ['--noout', xmlFile]);
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
console.log('export-premiere-xml tests passed');

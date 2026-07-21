import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildRenderPlan } from './render-preview.mjs';

const previewPlan = buildRenderPlan({
  timeline: {
    frameRate: 30,
    operations: [
      { type: 'select_range', sourceIn: 0, sourceOut: 2, timelineIn: 0 },
      { type: 'select_range', sourceIn: 4, sourceOut: 7, timelineIn: 2 },
      { type: 'caption', timelineIn: 1, timelineOut: 3, text: 'preview' },
    ],
  },
});
assert.equal(previewPlan.durationSeconds, 5);
assert.equal(previewPlan.captions.length, 1);

const port = 44317;
const base = `http://127.0.0.1:${port}`;
const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'ai-video-dashboard-test-'));
const demoDir = path.join(dataDir, 'projects', 'demo-talk');
await fs.mkdir(demoDir, { recursive: true });
await fs.mkdir(path.join(dataDir, 'queue'), { recursive: true });
await Promise.all([
  fs.writeFile(path.join(demoDir, 'project.json'), JSON.stringify({ id: 'demo-talk', title: 'Demo', status: 'review_ready', updatedAt: '2026-07-21T00:00:00.000Z' })),
  fs.writeFile(path.join(demoDir, 'editorial-ir.json'), JSON.stringify({ projectId: 'demo-talk', timeline: { operations: [] } })),
  fs.writeFile(path.join(demoDir, 'qc-report.json'), JSON.stringify({ status: 'pass' })),
  fs.writeFile(path.join(demoDir, 'transcript.json'), JSON.stringify({ language: 'ja', segments: [] })),
  fs.writeFile(path.join(demoDir, 'analysis.json'), JSON.stringify({ version: 'analysis.v1', signals: {} })),
  fs.writeFile(path.join(demoDir, 'artifacts.json'), JSON.stringify({ version: 1, artifacts: [] })),
]);

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, AIVIDEO_PORT: String(port), AIVIDEO_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  let ready = false;
  for (let index = 0; index < 40; index += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert.equal(ready, true);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  const projects = await (await fetch(`${base}/api/projects`)).json();
  assert.ok(projects.projects.some((project) => project.id === 'demo-talk'));
  const project = await (await fetch(`${base}/api/projects/demo-talk`)).json();
  assert.equal(project.editorialIr.projectId, 'demo-talk');
  assert.equal(project.analysis.version, 'analysis.v1');

  const bundle = {
    project: { id: 'analysis-lab', title: 'Analysis Lab', status: 'analysis_ready', updatedAt: '2026-07-21T01:00:00.000Z' },
    editorialIr: { projectId: 'analysis-lab', timeline: { durationSeconds: 7.84, operations: [] } },
    qc: { version: 'qc.v1', status: 'pass' },
    transcript: { language: 'ja', segments: [{ start: 0, end: 1, text: 'test' }] },
    analysis: { version: 'analysis.v1', decisions: { removals: [] } },
    artifacts: { version: 1, artifacts: [] },
  };
  const syncResponse = await fetch(`${base}/api/projects/analysis-lab`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  assert.equal(syncResponse.status, 200);
  const synced = await syncResponse.json();
  assert.equal(synced.id, 'analysis-lab');
  assert.equal(synced.analysis.version, 'analysis.v1');

  const artifactResponse = await fetch(`${base}/api/projects/analysis-lab/artifacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      artifact: {
        id: 'artifact-test',
        kind: 'preview',
        label: 'Preview',
        note: 'test',
        filename: 'preview.mp4',
        bytes: 100,
        sha256: '0123456789abcdef',
        drivePath: 'AI-Video/preview.mp4',
        url: 'https://drive.google.com/open?id=test',
        createdAt: '2026-07-21T01:05:00.000Z',
      },
    }),
  });
  assert.equal(artifactResponse.status, 201);
  const withArtifact = await artifactResponse.json();
  assert.equal(withArtifact.artifacts.length, 1);
  assert.equal(withArtifact.artifacts[0].kind, 'preview');

  const mismatchResponse = await fetch(`${base}/api/projects/wrong-id`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  assert.equal(mismatchResponse.status, 400);

  const createdResponse = await fetch(`${base}/api/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'analysis-lab', action: 'apply_ir' }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.status, 'waiting_for_device');
  const patched = await (await fetch(`${base}/api/queue/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'claimed' }),
  })).json();
  assert.equal(patched.status, 'claimed');
  const html = await (await fetch(base)).text();
  assert.match(html, /AI Video Production/);
  assert.match(html, /メディア解析/);
  console.log('ai-video-dashboard tests passed');
} finally {
  child.kill('SIGTERM');
  await fs.rm(dataDir, { recursive: true, force: true });
}

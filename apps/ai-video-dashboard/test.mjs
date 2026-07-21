import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = 44317;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env, AIVIDEO_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await delay(100);
  }
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  const projects = await (await fetch(`${base}/api/projects`)).json();
  assert.ok(projects.projects.some(p => p.id === 'demo-talk'));
  const project = await (await fetch(`${base}/api/projects/demo-talk`)).json();
  assert.equal(project.editorialIr.projectId, 'demo-talk');
  const createdResponse = await fetch(`${base}/api/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'demo-talk', action: 'apply_ir' }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.status, 'waiting_for_device');
  const patched = await (await fetch(`${base}/api/queue/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'claimed' }) })).json();
  assert.equal(patched.status, 'claimed');
  const html = await (await fetch(base)).text();
  assert.match(html, /AI Video Production/);
  console.log('ai-video-dashboard tests passed');
} finally {
  child.kill('SIGTERM');
}

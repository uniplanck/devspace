import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { getQualityLabData } from './quality-rubric.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.AIVIDEO_DATA_DIR || path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const HOST = process.env.AIVIDEO_HOST || '127.0.0.1';
const PORT = Number(process.env.AIVIDEO_PORT || 4317);
const MAX_BODY = 16 * 1024 * 1024;

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

async function ensureData() {
  await fs.mkdir(path.join(DATA_DIR, 'projects'), { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'queue'), { recursive: true });
}

function sendJson(res, status, body) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(body, null, 2));
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temp, file);
}

async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
}

function safeId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
}

async function listProjects() {
  const entries = await fs.readdir(path.join(DATA_DIR, 'projects'), { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJson(path.join(DATA_DIR, 'projects', entry.name, 'project.json'));
    if (manifest) projects.push(manifest);
  }
  return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function getProject(id) {
  if (!safeId(id)) return null;
  const dir = path.join(DATA_DIR, 'projects', id);
  const project = await readJson(path.join(dir, 'project.json'));
  if (!project) return null;
  const [editorialIr, qc, transcript, analysis, artifacts, evaluation] = await Promise.all([
    readJson(path.join(dir, 'editorial-ir.json')),
    readJson(path.join(dir, 'qc-report.json')),
    readJson(path.join(dir, 'transcript.json')),
    readJson(path.join(dir, 'analysis.json')),
    readJson(path.join(dir, 'artifacts.json'), { version: 1, artifacts: [] }),
    readJson(path.join(dir, 'evaluation-report.json'), null),
  ]);
  return { ...project, editorialIr, qc, transcript, analysis, evaluation, artifacts: artifacts?.artifacts || [] };
}

async function syncProject(id, body) {
  if (!safeId(id)) throw Object.assign(new Error('invalid project id'), { status: 400 });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('invalid project bundle'), { status: 400 });
  const project = body.project;
  if (!project || typeof project !== 'object' || project.id !== id) throw Object.assign(new Error('project.id must match URL id'), { status: 400 });
  const required = [
    ['editorial-ir.json', body.editorialIr],
    ['qc-report.json', body.qc],
    ['transcript.json', body.transcript],
    ['analysis.json', body.analysis],
  ];
  for (const [name, value] of required) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error(`${name} is required`), { status: 400 });
  }
  const dir = path.join(DATA_DIR, 'projects', id);
  await fs.mkdir(dir, { recursive: true });
  const artifacts = Array.isArray(body.artifacts)
    ? { version: 1, artifacts: body.artifacts }
    : body.artifacts && typeof body.artifacts === 'object'
      ? body.artifacts
      : { version: 1, artifacts: [] };
  const writes = [
    writeJsonAtomic(path.join(dir, 'project.json'), project),
    writeJsonAtomic(path.join(dir, 'editorial-ir.json'), body.editorialIr),
    writeJsonAtomic(path.join(dir, 'qc-report.json'), body.qc),
    writeJsonAtomic(path.join(dir, 'transcript.json'), body.transcript),
    writeJsonAtomic(path.join(dir, 'analysis.json'), body.analysis),
    writeJsonAtomic(path.join(dir, 'artifacts.json'), artifacts),
  ];
  if (body.evaluation && typeof body.evaluation === 'object' && !Array.isArray(body.evaluation)) {
    writes.push(writeJsonAtomic(path.join(dir, 'evaluation-report.json'), body.evaluation));
  }
  await Promise.all(writes);
  return getProject(id);
}

async function registerArtifact(id, body) {
  if (!safeId(id)) throw Object.assign(new Error('invalid project id'), { status: 400 });
  const project = await getProject(id);
  if (!project) throw Object.assign(new Error('project not found'), { status: 404 });
  const artifact = body?.artifact && typeof body.artifact === 'object' && !Array.isArray(body.artifact)
    ? body.artifact
    : body;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw Object.assign(new Error('invalid artifact'), { status: 400 });
  if (typeof artifact.url !== 'string' || !artifact.url.startsWith('https://')) throw Object.assign(new Error('artifact.url must be HTTPS'), { status: 400 });
  if (typeof artifact.sha256 !== 'string' || artifact.sha256.length < 8) throw Object.assign(new Error('artifact.sha256 is required'), { status: 400 });
  if (typeof artifact.kind !== 'string' || !artifact.kind) throw Object.assign(new Error('artifact.kind is required'), { status: 400 });
  const file = path.join(DATA_DIR, 'projects', id, 'artifacts.json');
  const manifest = await readJson(file, { version: 1, artifacts: [] });
  manifest.version = 1;
  manifest.updatedAt = new Date().toISOString();
  manifest.artifacts = [artifact, ...(Array.isArray(manifest.artifacts) ? manifest.artifacts : [])]
    .filter((item, index, items) => index === items.findIndex((candidate) => candidate.sha256 === item.sha256 && candidate.kind === item.kind));
  await writeJsonAtomic(file, manifest);
  return getProject(id);
}

async function listQueue() {
  const entries = await fs.readdir(path.join(DATA_DIR, 'queue'));
  const rows = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const item = await readJson(path.join(DATA_DIR, 'queue', name));
    if (item) rows.push(item);
  }
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function enqueue(body) {
  if (!safeId(body.projectId)) throw Object.assign(new Error('invalid projectId'), { status: 400 });
  const allowed = new Set(['apply_ir', 'export_xml', 'render_preview', 'sync_timeline']);
  if (!allowed.has(body.action)) throw Object.assign(new Error('unsupported action'), { status: 400 });
  const project = await getProject(body.projectId);
  if (!project) throw Object.assign(new Error('project not found'), { status: 404 });
  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(),
    projectId: body.projectId,
    action: body.action,
    target: body.target || 'palmier-mac',
    status: 'waiting_for_device',
    payload: body.payload && typeof body.payload === 'object' ? body.payload : {},
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
  await writeJsonAtomic(path.join(DATA_DIR, 'queue', `${item.id}.json`), item);
  return item;
}

async function updateQueue(id, body) {
  if (!safeId(id)) return null;
  const file = path.join(DATA_DIR, 'queue', `${id}.json`);
  const item = await readJson(file);
  if (!item) return null;
  const allowed = new Set(['waiting_for_device', 'claimed', 'running', 'completed', 'failed', 'cancelled']);
  if (body.status && !allowed.has(body.status)) throw Object.assign(new Error('unsupported status'), { status: 400 });
  const next = {
    ...item,
    ...(body.status ? { status: body.status } : {}),
    ...(typeof body.message === 'string' ? { message: body.message.slice(0, 1000) } : {}),
    ...(typeof body.result === 'object' && body.result ? { result: body.result } : {}),
    updatedAt: new Date().toISOString(),
    attempts: body.status === 'claimed' ? Number(item.attempts || 0) + 1 : item.attempts,
  };
  await writeJsonAtomic(file, next);
  return next;
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.includes('..')) return false;
  const file = path.join(PUBLIC_DIR, relative);
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file);
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(data);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, service: 'ai-video-dashboard', version: 1, now: new Date().toISOString(), palmierBridge: 'offline-capable' });
    }
    if (pathname === '/api/capabilities' && req.method === 'GET') {
      return sendJson(res, 200, {
        dashboard: ['quality_lab', 'quality_history', 'rubric_profiles', 'project_list', 'project_detail', 'project_sync', 'artifact_register', 'media_analysis', 'editorial_ir', 'transcript', 'qc_report', 'command_queue'],
        queueActions: ['apply_ir', 'export_xml', 'render_preview', 'sync_timeline'],
        adapters: { headless: 'available', palmier: 'contract_ready_mac_required', premiere: 'planned_via_xml_or_uxp' },
      });
    }
    if (pathname === '/api/quality-lab' && req.method === 'GET') {
      return sendJson(res, 200, getQualityLabData(url.searchParams.get('profile') || 'explainer'));
    }
    if (pathname === '/api/projects' && req.method === 'GET') return sendJson(res, 200, { projects: await listProjects() });
    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && req.method === 'GET') {
      const project = await getProject(projectMatch[1]);
      return project ? sendJson(res, 200, project) : sendError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found');
    }
    if (projectMatch && req.method === 'PUT') {
      return sendJson(res, 200, await syncProject(projectMatch[1], await parseBody(req)));
    }
    const artifactMatch = pathname.match(/^\/api\/projects\/([^/]+)\/artifacts$/);
    if (artifactMatch && req.method === 'POST') {
      return sendJson(res, 201, await registerArtifact(artifactMatch[1], await parseBody(req)));
    }
    if (pathname === '/api/queue' && req.method === 'GET') return sendJson(res, 200, { commands: await listQueue() });
    if (pathname === '/api/queue' && req.method === 'POST') return sendJson(res, 201, await enqueue(await parseBody(req)));
    const queueMatch = pathname.match(/^\/api\/queue\/([^/]+)$/);
    if (queueMatch && req.method === 'PATCH') {
      const updated = await updateQueue(queueMatch[1], await parseBody(req));
      return updated ? sendJson(res, 200, updated) : sendError(res, 404, 'COMMAND_NOT_FOUND', 'Command not found');
    }
    if (pathname === '/api/bridge/contract' && req.method === 'GET') {
      return sendJson(res, 200, {
        protocol: 'gag-palmier-bridge/v0',
        transport: 'HTTPS over tailnet to dashboard; localhost MCP from Mac bridge to Palmier',
        poll: 'GET /api/queue',
        claim: 'PATCH /api/queue/:id {status:"claimed"}',
        complete: 'PATCH /api/queue/:id {status:"completed",result:{...}}',
        failure: 'PATCH /api/queue/:id {status:"failed",message:"..."}',
        security: ['tailnet-only exposure', 'no direct Palmier MCP exposure', 'write actions must originate from queued commands'],
      });
    }
    if (req.method === 'GET' && await serveStatic(req, res, pathname)) return;
    sendError(res, 404, 'NOT_FOUND', 'Route not found');
  } catch (error) {
    const status = Number(error?.status || 500);
    sendError(res, status, status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', status >= 500 ? 'Internal server error' : error.message);
    if (status >= 500) console.error(error);
  }
}

await ensureData();
const server = http.createServer(handler);
server.listen(PORT, HOST, () => console.log(`AI Video Dashboard listening on http://${HOST}:${PORT}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

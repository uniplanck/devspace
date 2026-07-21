import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { renderPreview } from './render-preview.mjs';
import { uploadArtifact } from './upload-artifact.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DASHBOARD = process.env.AIVIDEO_DASHBOARD_URL || 'http://100.66.201.64:4317';
const PALMIER = process.env.PALMIER_MCP_URL || 'http://127.0.0.1:19789/mcp';
const POLL_MS = Number(process.env.AIVIDEO_POLL_MS || 5000);
const TARGET = process.env.AIVIDEO_BRIDGE_TARGET || 'palmier-mac';
const STATE_DIR = process.env.AIVIDEO_BRIDGE_STATE_DIR || path.join(ROOT, 'data', 'mac-bridge');
let mcpSessionId = null;

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  return body;
}

async function patchCommand(id, body) {
  return requestJson(`${DASHBOARD}/api/queue/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

async function mcpRequest(method, params = {}) {
  const id = crypto.randomUUID();
  const headers = { accept: 'application/json, text/event-stream' };
  if (mcpSessionId) headers['mcp-session-id'] = mcpSessionId;
  const response = await fetch(PALMIER, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const session = response.headers.get('mcp-session-id');
  if (session) mcpSessionId = session;
  const text = await response.text();
  if (!response.ok) throw new Error(`Palmier MCP ${response.status}: ${text.slice(0, 500)}`);
  const lines = text.split('\n').filter((line) => line.startsWith('data:'));
  const payload = lines.length ? JSON.parse(lines.at(-1).slice(5).trim()) : JSON.parse(text);
  if (payload.error) throw new Error(`Palmier MCP error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function initializeMcp() {
  const result = await mcpRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gag-palmier-bridge', version: '0.1.0' },
  });
  await mcpRequest('notifications/initialized').catch(() => undefined);
  return result;
}

async function inventoryCapabilities() {
  await initializeMcp();
  const tools = await mcpRequest('tools/list');
  await fs.mkdir(STATE_DIR, { recursive: true });
  const snapshot = {
    capturedAt: new Date().toISOString(),
    palmierMcpUrl: PALMIER,
    sessionIdPresent: Boolean(mcpSessionId),
    tools: tools?.tools || [],
  };
  await fs.writeFile(path.join(STATE_DIR, 'palmier-capabilities.json'), JSON.stringify(snapshot, null, 2) + '\n');
  return snapshot;
}

function chooseTool(tools, patterns) {
  return tools.find((tool) => patterns.some((pattern) => pattern.test(tool.name)));
}

async function callTool(name, args = {}) {
  return mcpRequest('tools/call', { name, arguments: args });
}

async function handleCommand(command) {
  if (command.action === 'render_preview') {
    const project = await requestJson(`${DASHBOARD}/api/projects/${command.projectId}`);
    const operations = project?.editorialIr?.timeline?.operations;
    if (!Array.isArray(operations)) return { status: 'unsupported', reason: 'Project has no Editorial IR operations' };
    const assetIds = [...new Set(operations.filter((operation) => operation?.type === 'select_range').map((operation) => operation.assetId).filter(Boolean))];
    if (assetIds.length !== 1) return { status: 'unsupported', reason: 'Headless preview currently requires exactly one source asset' };
    const bindings = normalizeAssetBindings(command.payload);
    const binding = bindings[assetIds[0]] || {};
    const mediaPath = typeof binding.path === 'string' && path.isAbsolute(binding.path)
      ? binding.path
      : typeof project.sourceMediaPath === 'string' && path.isAbsolute(project.sourceMediaPath)
        ? project.sourceMediaPath
        : null;
    if (!mediaPath) return { status: 'unsupported', reason: `Preview source path is missing for ${assetIds[0]}` };
    await fs.access(mediaPath);

    const fingerprint = stableHash(project.editorialIr).slice(0, 16);
    const previewDir = path.join(STATE_DIR, 'previews');
    await fs.mkdir(previewDir, { recursive: true });
    const irFile = path.join(previewDir, `${command.projectId}-${fingerprint}.editorial-ir.json`);
    const outputPath = typeof command.payload?.outputPath === 'string' && path.isAbsolute(command.payload.outputPath)
      ? command.payload.outputPath
      : path.join(previewDir, `${command.projectId}-${fingerprint}.mp4`);
    await fs.writeFile(irFile, `${JSON.stringify(project.editorialIr, null, 2)}\n`, 'utf8');
    const render = await renderPreview({
      media: mediaPath,
      ir: irFile,
      output: outputPath,
      ...(command.payload?.font ? { font: command.payload.font } : {}),
      ...(command.payload?.crf ? { crf: command.payload.crf } : {}),
    });

    let artifact = null;
    if (command.payload?.publishToDrive !== false) {
      const uploaded = await uploadArtifact({
        projectId: command.projectId,
        file: outputPath,
        kind: 'preview',
        label: command.payload?.label || 'AI解析・編集プレビュー',
        note: command.payload?.note || 'Editorial IRから自動生成',
        dataDir: STATE_DIR,
      });
      artifact = uploaded.artifact;
      await requestJson(`${DASHBOARD}/api/projects/${command.projectId}/artifacts`, {
        method: 'POST',
        body: JSON.stringify({ artifact }),
      });
    }
    return { status: 'completed', mode: 'headless_ffmpeg_preview', render, artifact };
  }

  const capabilitySnapshot = await inventoryCapabilities();
  const tools = capabilitySnapshot.tools;
  if (command.action === 'sync_timeline') {
    const tool = chooseTool(tools, [/timeline.*(get|inspect|read)/i, /(get|inspect|read).*timeline/i, /active.*sequence/i]);
    if (!tool) return { status: 'unsupported', reason: 'No timeline inspection tool found', capabilityCount: tools.length };
    return { status: 'completed', tool: tool.name, output: await callTool(tool.name, command.payload || {}) };
  }
  if (command.action === 'export_xml') {
    const tool = chooseTool(tools, [/export.*xml/i, /xml.*export/i, /nle.*xml/i]);
    if (!tool) return { status: 'unsupported', reason: 'No XML export tool found', capabilityCount: tools.length };
    return { status: 'completed', tool: tool.name, output: await callTool(tool.name, command.payload || {}) };
  }
  if (command.action === 'apply_ir') {
    return {
      status: 'unsupported',
      reason: 'IR application requires the LAB-0 capability mapping before mutation is allowed',
      capabilityCount: tools.length,
      capabilityFile: path.join(STATE_DIR, 'palmier-capabilities.json'),
    };
  }
  throw new Error(`Unsupported command action: ${command.action}`);
}

async function pollOnce() {
  const response = await requestJson(`${DASHBOARD}/api/queue`);
  const commands = (response.commands || [])
    .filter((item) => item.target === TARGET && item.status === 'waiting_for_device')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const command of commands) {
    await patchCommand(command.id, { status: 'claimed', message: `Claimed by ${TARGET}` });
    try {
      await patchCommand(command.id, { status: 'running', message: 'Connecting to Palmier MCP' });
      const result = await handleCommand(command);
      if (result.status === 'unsupported') {
        await patchCommand(command.id, { status: 'failed', message: result.reason, result });
      } else {
        await patchCommand(command.id, { status: 'completed', message: 'Palmier command completed', result });
      }
    } catch (error) {
      await patchCommand(command.id, { status: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }
  return commands.length;
}

async function main() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const once = process.argv.includes('--once');
  if (process.argv.includes('--inventory')) {
    const snapshot = await inventoryCapabilities();
    console.log(JSON.stringify({ ok: true, tools: snapshot.tools.length, file: path.join(STATE_DIR, 'palmier-capabilities.json') }, null, 2));
    return;
  }
  if (process.argv.includes('--media')) {
    const snapshot = await inventoryCapabilities();
    const tool = chooseTool(snapshot.tools, [/^get_media$/i]);
    if (!tool) throw new Error('Palmier get_media tool is unavailable');
    console.log(JSON.stringify(await callTool(tool.name, {}), null, 2));
    return;
  }
  if (process.argv.includes('--timeline')) {
    const snapshot = await inventoryCapabilities();
    const tool = chooseTool(snapshot.tools, [/^get_timeline$/i]);
    if (!tool) throw new Error('Palmier get_timeline tool is unavailable');
    console.log(JSON.stringify(await callTool(tool.name, {}), null, 2));
    return;
  }
  do {
    try {
      const count = await pollOnce();
      if (count) console.log(`[${new Date().toISOString()}] processed ${count} command(s)`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] bridge poll failed:`, error instanceof Error ? error.message : error);
      if (once) process.exitCode = 1;
    }
    if (!once) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  } while (!once);
}

await main();

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DASHBOARD = process.env.AIVIDEO_DASHBOARD_URL || 'http://100.66.201.64:4317';
const PALMIER = process.env.PALMIER_MCP_URL || 'http://127.0.0.1:19789/mcp';
const POLL_MS = Number(process.env.AIVIDEO_POLL_MS || 5000);
const TARGET = process.env.AIVIDEO_BRIDGE_TARGET || 'palmier-mac';
const STATE_DIR = process.env.AIVIDEO_BRIDGE_STATE_DIR || path.resolve('apps/ai-video-dashboard/data/mac-bridge');
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

function toolErrorMessage(result) {
  if (!result?.isError) return null;
  const text = Array.isArray(result.content)
    ? result.content.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text
    : null;
  return text || 'Palmier tool returned an error';
}

function toolContentJson(result) {
  const text = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text
    : null;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function textEventKey(startFrame, durationFrames, text) {
  return `${startFrame}:${durationFrames}:${text}`;
}

function existingTextEventKeys(timeline) {
  const keys = new Set();
  for (const track of timeline?.tracks || []) {
    for (const clip of track.clips || []) {
      const text = clip.textContent || clip.content || clip.text;
      if (typeof text === 'string') keys.add(textEventKey(clip.startFrame, clip.durationFrames, text));
    }
    for (const group of track.captionGroups || []) {
      for (const row of group.clips || group.rows || []) {
        if (Array.isArray(row) && row.length >= 4) keys.add(textEventKey(row[1], row[2], row[3]));
      }
    }
  }
  return keys;
}

async function callTool(name, args = {}) {
  const result = await mcpRequest('tools/call', { name, arguments: args });
  const message = toolErrorMessage(result);
  if (message) throw new Error(`Palmier tool ${name} failed: ${message}`);
  return result;
}

async function handleCommand(command) {
  const capabilitySnapshot = await inventoryCapabilities();
  const tools = capabilitySnapshot.tools;
  if (command.action === 'sync_timeline') {
    const tool = chooseTool(tools, [/timeline.*(get|inspect|read)/i, /(get|inspect|read).*timeline/i, /active.*sequence/i]);
    if (!tool) return { status: 'unsupported', reason: 'No timeline inspection tool found', capabilityCount: tools.length };
    const args = {};
    if (Number.isInteger(command.payload?.startFrame)) args.startFrame = command.payload.startFrame;
    if (Number.isInteger(command.payload?.endFrame)) args.endFrame = command.payload.endFrame;
    return { status: 'completed', tool: tool.name, output: await callTool(tool.name, args) };
  }
  if (command.action === 'export_xml') {
    const tool = chooseTool(tools, [/export.*xml/i, /xml.*export/i, /nle.*xml/i]);
    if (!tool) return { status: 'unsupported', reason: 'No XML export tool found', capabilityCount: tools.length };
    return { status: 'completed', tool: tool.name, output: await callTool(tool.name, command.payload || {}) };
  }
  if (command.action === 'render_preview') {
    const tool = chooseTool(tools, [/export.*(video|preview|mp4)/i, /render.*preview/i]);
    if (!tool) return { status: 'unsupported', reason: 'No preview export tool found', capabilityCount: tools.length };
    return { status: 'completed', tool: tool.name, output: await callTool(tool.name, command.payload || {}) };
  }
  if (command.action === 'apply_ir') {
    const timelineTool = chooseTool(tools, [/^get_timeline$/i, /timeline.*(get|inspect|read)/i, /(get|inspect|read).*timeline/i]);
    const addTextsTool = chooseTool(tools, [/^add_texts$/i, /add.*text/i]);
    if (!timelineTool || !addTextsTool) {
      return {
        status: 'unsupported',
        reason: 'Palmier does not expose the minimum get_timeline + add_texts tool set',
        capabilityCount: tools.length,
      };
    }

    const project = await requestJson(`${DASHBOARD}/api/projects/${command.projectId}`);
    const operations = project?.editorialIr?.timeline?.operations;
    if (!Array.isArray(operations)) {
      return { status: 'unsupported', reason: 'Project has no Editorial IR operations' };
    }

    const timelineResult = await callTool(timelineTool.name, {});
    const timeline = toolContentJson(timelineResult) || {};
    const fps = Number(timeline.fps || project.editorialIr.timeline.frameRate || 30);
    const existing = existingTextEventKeys(timeline);
    const captionEntries = [];
    const operationResults = [];

    for (const operation of operations) {
      if (operation.type !== 'caption') {
        operationResults.push({
          operationId: operation.id,
          type: operation.type,
          status: 'unsupported',
          reason: 'MVP Palmier mapping currently applies caption operations only',
        });
        continue;
      }
      const startFrame = Math.max(0, Math.round(Number(operation.timelineIn || 0) * fps));
      const endFrame = Math.max(startFrame + 1, Math.round(Number(operation.timelineOut || operation.timelineIn || 0) * fps));
      const durationFrames = endFrame - startFrame;
      const key = textEventKey(startFrame, durationFrames, operation.text);
      if (existing.has(key)) {
        operationResults.push({ operationId: operation.id, type: operation.type, status: 'already_present' });
        continue;
      }
      captionEntries.push({
        startFrame,
        durationFrames,
        content: operation.text,
        fontName: 'Helvetica-Bold',
        fontSize: operation.role === 'emphasis' ? 72 : 50,
        color: '#FFFFFF',
        alignment: 'center',
        transform: { centerX: 0.5, centerY: 0.88 },
      });
      operationResults.push({ operationId: operation.id, type: operation.type, status: 'pending' });
    }

    let applyOutput = null;
    if (captionEntries.length) {
      applyOutput = await callTool(addTextsTool.name, { entries: captionEntries });
      for (const result of operationResults) {
        if (result.status === 'pending') result.status = 'applied_exactly';
      }
    }

    return {
      status: 'completed',
      mode: 'caption_mvp',
      fps,
      capabilityCount: tools.length,
      operationResults,
      applyOutput,
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

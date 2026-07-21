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

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function bridgeStateFile(projectId) {
  return path.join(STATE_DIR, `project-${projectId}.json`);
}

async function readBridgeState(projectId) {
  try { return JSON.parse(await fs.readFile(bridgeStateFile(projectId), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeBridgeState(projectId, value) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const file = bridgeStateFile(projectId);
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

function secondsToFrame(seconds, fps) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid non-negative time: ${seconds}`);
  return Math.round(value * fps);
}

function normalizeAssetBindings(payload) {
  const raw = payload?.assetBindings;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const bindings = {};
  for (const [assetId, binding] of Object.entries(raw)) {
    if (typeof binding === 'string') bindings[assetId] = { path: binding };
    else if (binding && typeof binding === 'object') bindings[assetId] = binding;
  }
  return bindings;
}

function compileEditorialPlan(operations, fps) {
  const selected = operations
    .filter((operation) => operation?.type === 'select_range')
    .map((operation, index) => {
      const sourceInFrame = secondsToFrame(operation.sourceIn, fps);
      const sourceOutFrame = secondsToFrame(operation.sourceOut, fps);
      if (sourceOutFrame <= sourceInFrame) throw new Error(`select_range ${operation.id || index} has an empty range`);
      return {
        operationId: operation.id || `select-${index}`,
        assetId: operation.assetId,
        sourceInFrame,
        durationFrames: sourceOutFrame - sourceInFrame,
        requestedTimelineFrame: Number.isFinite(Number(operation.timelineIn))
          ? secondsToFrame(operation.timelineIn, fps)
          : null,
        ordinal: index,
      };
    });

  let cursor = 0;
  const clips = selected
    .sort((a, b) => (a.requestedTimelineFrame ?? Number.MAX_SAFE_INTEGER) - (b.requestedTimelineFrame ?? Number.MAX_SAFE_INTEGER) || a.ordinal - b.ordinal)
    .map((segment) => {
      const startFrame = segment.requestedTimelineFrame ?? cursor;
      cursor = Math.max(cursor, startFrame + segment.durationFrames);
      return { ...segment, startFrame };
    });

  const captions = operations
    .filter((operation) => operation?.type === 'caption')
    .map((operation, index) => {
      const startFrame = secondsToFrame(operation.timelineIn || 0, fps);
      const endFrame = Math.max(startFrame + 1, secondsToFrame(operation.timelineOut ?? operation.timelineIn ?? 0, fps));
      return {
        operationId: operation.id || `caption-${index}`,
        startFrame,
        durationFrames: endFrame - startFrame,
        text: String(operation.text || ''),
        role: operation.role || 'caption',
      };
    });

  return { fps, clips, captions };
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

function mediaItemsFromResult(result) {
  const parsed = toolContentJson(result);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.media)) return parsed.media;
  if (Array.isArray(parsed?.assets)) return parsed.assets;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.entries)) return parsed.entries;
  return [];
}

function mediaIdentity(item) {
  return item?.id || item?.mediaRef || item?.reference || item?.assetId || null;
}

function mediaDisplayName(item) {
  return item?.name || item?.displayName || item?.filename || item?.title || '';
}

async function resolveMediaBindings({ command, projectId, plan, tools }) {
  const getMediaTool = chooseTool(tools, [/^get_media$/i]);
  const importMediaTool = chooseTool(tools, [/^import_media$/i]);
  if (!getMediaTool || !importMediaTool) throw new Error('Palmier requires get_media and import_media for cut application');

  const bindings = normalizeAssetBindings(command.payload);
  const requiredAssetIds = [...new Set(plan.clips.map((clip) => clip.assetId))];
  const resolved = {};
  let media = mediaItemsFromResult(await callTool(getMediaTool.name, {}));

  for (const assetId of requiredAssetIds) {
    if (!assetId) throw new Error('select_range is missing assetId');
    const binding = bindings[assetId];
    if (!binding) throw new Error(`No asset binding supplied for ${assetId}`);

    if (typeof binding.mediaRef === 'string' && binding.mediaRef) {
      const found = media.find((item) => mediaIdentity(item) === binding.mediaRef);
      if (!found) throw new Error(`Bound mediaRef not found in Palmier: ${binding.mediaRef}`);
      resolved[assetId] = binding.mediaRef;
      continue;
    }

    const importName = binding.name || `gag-${projectId}-${assetId}`;
    const existing = media.find((item) => mediaDisplayName(item) === importName);
    if (existing && mediaIdentity(existing)) {
      resolved[assetId] = mediaIdentity(existing);
      continue;
    }

    const source = {};
    if (typeof binding.path === 'string' && path.isAbsolute(binding.path)) source.path = binding.path;
    else if (typeof binding.url === 'string' && /^https:\/\//.test(binding.url)) source.url = binding.url;
    else throw new Error(`Asset ${assetId} requires an absolute local path, HTTPS URL, or mediaRef`);

    await callTool(importMediaTool.name, { source, name: importName });
    media = mediaItemsFromResult(await callTool(getMediaTool.name, {}));
    const imported = media.find((item) => mediaDisplayName(item) === importName);
    const mediaRef = mediaIdentity(imported);
    if (!mediaRef) throw new Error(`Palmier imported ${assetId} but did not expose a mediaRef`);
    resolved[assetId] = mediaRef;
  }
  return resolved;
}

function allTimelineClips(timeline) {
  const clips = [];
  for (const [trackIndex, track] of (timeline?.tracks || []).entries()) {
    for (const clip of track.clips || []) clips.push({ ...clip, trackIndex });
    for (const group of track.captionGroups || []) {
      for (const row of group.clips || group.rows || []) {
        if (Array.isArray(row) && row.length >= 4) {
          clips.push({ id: row[0], startFrame: row[1], durationFrames: row[2], textContent: row[3], mediaType: 'text', trackIndex });
        }
      }
    }
  }
  return clips;
}

function clipMatchesExpected(clip, expected) {
  return clip
    && clip.mediaRef === expected.mediaRef
    && clip.startFrame === expected.startFrame
    && clip.durationFrames === expected.durationFrames
    && Number(clip.trimStartFrame || 0) === expected.sourceInFrame;
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
  if (command.action === 'apply_ir') {
    const timelineTool = chooseTool(tools, [/^get_timeline$/i]);
    const addTextsTool = chooseTool(tools, [/^add_texts$/i]);
    const addClipsTool = chooseTool(tools, [/^add_clips$/i]);
    const setClipTool = chooseTool(tools, [/^set_clip_properties$/i]);
    const removeClipsTool = chooseTool(tools, [/^remove_clips$/i]);
    if (!timelineTool || !addTextsTool || !addClipsTool || !setClipTool || !removeClipsTool) {
      return {
        status: 'unsupported',
        reason: 'Palmier lacks one or more required timeline tools',
        capabilityCount: tools.length,
      };
    }

    const project = await requestJson(`${DASHBOARD}/api/projects/${command.projectId}`);
    const operations = project?.editorialIr?.timeline?.operations;
    if (!Array.isArray(operations)) return { status: 'unsupported', reason: 'Project has no Editorial IR operations' };

    const initialTimeline = toolContentJson(await callTool(timelineTool.name, {})) || {};
    const fps = Number(initialTimeline.fps || project.editorialIr.timeline.frameRate || 30);
    if (!Number.isFinite(fps) || fps <= 0) throw new Error(`Invalid project fps: ${fps}`);
    const plan = compileEditorialPlan(operations, fps);
    const bindings = await resolveMediaBindings({ command, projectId: command.projectId, plan, tools });
    const expectedClips = plan.clips.map((clip) => ({ ...clip, mediaRef: bindings[clip.assetId] }));
    const fingerprint = stableHash({ plan, bindings });
    const previousState = await readBridgeState(command.projectId);
    const initialClips = allTimelineClips(initialTimeline);

    if (previousState?.fingerprint === fingerprint) {
      const managedVideoValid = (previousState.managedVideoClipIds || []).every((id) => initialClips.some((clip) => clip.id === id));
      const captionsValid = plan.captions.every((caption) => existingTextEventKeys(initialTimeline).has(textEventKey(caption.startFrame, caption.durationFrames, caption.text)));
      const expectedValid = expectedClips.every((expected) => initialClips.some((clip) => clipMatchesExpected(clip, expected)));
      if (managedVideoValid && captionsValid && expectedValid) {
        return {
          status: 'completed',
          mode: 'cut_caption_mvp',
          result: 'already_applied',
          fps,
          fingerprint,
          operationResults: operations.map((operation) => ({ operationId: operation.id, type: operation.type, status: 'already_present' })),
        };
      }
    }

    const beforeIds = new Set(initialClips.map((clip) => clip.id));
    const createdVideoIds = [];
    const createdTextIds = [];
    let mutationStarted = false;
    try {
      if (expectedClips.length) {
        mutationStarted = true;
        await callTool(addClipsTool.name, {
          entries: expectedClips.map((clip) => ({
            mediaRef: clip.mediaRef,
            startFrame: clip.startFrame,
            durationFrames: clip.durationFrames,
          })),
        });

        let timeline = toolContentJson(await callTool(timelineTool.name, {})) || {};
        let clips = allTimelineClips(timeline);
        for (const expected of expectedClips) {
          const created = clips.find((clip) => !beforeIds.has(clip.id)
            && clip.mediaRef === expected.mediaRef
            && clip.startFrame === expected.startFrame
            && clip.durationFrames === expected.durationFrames
            && clip.mediaType !== 'audio');
          if (!created?.id) throw new Error(`Unable to identify Palmier clip for ${expected.operationId}`);
          createdVideoIds.push(created.id);
          if (expected.sourceInFrame > 0) {
            await callTool(setClipTool.name, { clipIds: [created.id], trimStartFrame: expected.sourceInFrame });
          }
        }
      }

      let timelineAfterVideo = toolContentJson(await callTool(timelineTool.name, {})) || {};
      const existingText = existingTextEventKeys(timelineAfterVideo);
      const captionsToAdd = plan.captions.filter((caption) => !existingText.has(textEventKey(caption.startFrame, caption.durationFrames, caption.text)));
      if (captionsToAdd.length) {
        mutationStarted = true;
        const idsBeforeText = new Set(allTimelineClips(timelineAfterVideo).map((clip) => clip.id));
        await callTool(addTextsTool.name, {
          entries: captionsToAdd.map((caption) => ({
            startFrame: caption.startFrame,
            durationFrames: caption.durationFrames,
            content: caption.text,
            fontName: 'Helvetica-Bold',
            fontSize: caption.role === 'emphasis' ? 72 : 50,
            color: '#FFFFFF',
            alignment: 'center',
            transform: { centerX: 0.5, centerY: 0.88 },
          })),
        });
        timelineAfterVideo = toolContentJson(await callTool(timelineTool.name, {})) || {};
        for (const clip of allTimelineClips(timelineAfterVideo)) {
          if (!idsBeforeText.has(clip.id) && clip.mediaType === 'text') createdTextIds.push(clip.id);
        }
      }

      const finalTimeline = toolContentJson(await callTool(timelineTool.name, {})) || {};
      const finalClips = allTimelineClips(finalTimeline);
      const clipChecks = expectedClips.map((expected) => ({
        operationId: expected.operationId,
        valid: finalClips.some((clip) => clipMatchesExpected(clip, expected)),
      }));
      const captionChecks = plan.captions.map((caption) => ({
        operationId: caption.operationId,
        valid: existingTextEventKeys(finalTimeline).has(textEventKey(caption.startFrame, caption.durationFrames, caption.text)),
      }));
      const failedCheck = [...clipChecks, ...captionChecks].find((check) => !check.valid);
      if (failedCheck) throw new Error(`Postflight verification failed for ${failedCheck.operationId}`);

      const oldManagedIds = [...new Set([...(previousState?.managedVideoClipIds || []), ...(previousState?.managedTextClipIds || [])])]
        .filter((id) => finalClips.some((clip) => clip.id === id))
        .filter((id) => !createdVideoIds.includes(id) && !createdTextIds.includes(id));
      if (oldManagedIds.length) await callTool(removeClipsTool.name, { clipIds: oldManagedIds });

      await writeBridgeState(command.projectId, {
        schemaVersion: 1,
        projectId: command.projectId,
        fingerprint,
        fps,
        managedVideoClipIds: createdVideoIds,
        managedTextClipIds: createdTextIds,
        appliedAt: new Date().toISOString(),
      });

      return {
        status: 'completed',
        mode: 'cut_caption_mvp',
        result: previousState ? 'replaced_managed_edit' : 'applied',
        fps,
        fingerprint,
        managedVideoClipIds: createdVideoIds,
        managedTextClipIds: createdTextIds,
        operationResults: operations.map((operation) => ({
          operationId: operation.id,
          type: operation.type,
          status: operation.type === 'remove_range' ? 'applied_by_reconstruction' : 'applied_exactly',
        })),
      };
    } catch (error) {
      if (mutationStarted) {
        const rollbackIds = [...new Set([...createdVideoIds, ...createdTextIds])];
        if (rollbackIds.length) await callTool(removeClipsTool.name, { clipIds: rollbackIds }).catch(() => undefined);
      }
      throw error;
    }
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
  if (process.argv.includes('--self-test')) {
    const plan = compileEditorialPlan([
      { id: 'a', type: 'select_range', assetId: 'cam', sourceIn: 2, sourceOut: 5, timelineIn: 0 },
      { id: 'b', type: 'select_range', assetId: 'cam', sourceIn: 7, sourceOut: 9, timelineIn: 3 },
      { id: 'c', type: 'caption', timelineIn: 0.5, timelineOut: 2.5, text: 'test' },
    ], 30);
    const valid = plan.clips.length === 2
      && plan.clips[0].sourceInFrame === 60
      && plan.clips[0].durationFrames === 90
      && plan.clips[1].startFrame === 90
      && plan.clips[1].sourceInFrame === 210
      && plan.captions[0].startFrame === 15
      && plan.captions[0].durationFrames === 60;
    if (!valid) throw new Error('Bridge compiler self-test failed');
    console.log(JSON.stringify({ ok: true, test: 'bridge-compiler' }));
    return;
  }
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

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { renderPreview } from './render-preview.mjs';
import { exportPremiereXml } from './export-premiere-xml.mjs';
import { uploadArtifact } from './upload-artifact.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = process.env.AIVIDEO_DASHBOARD_URL || 'http://100.66.201.64:4317';
const PALMIER = process.env.PALMIER_MCP_URL || 'http://127.0.0.1:19789/mcp';
const POLL_MS = Number(process.env.AIVIDEO_POLL_MS || 5000);
const TARGET = process.env.AIVIDEO_BRIDGE_TARGET || 'palmier-mac';
const STATE_DIR = process.env.AIVIDEO_BRIDGE_STATE_DIR || path.join(ROOT, 'data', 'mac-bridge');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
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

export function compileEditorialPlan(operations, fps, multicam = {}) {
  const selected = operations
    .filter((operation) => operation?.type === 'select_range')
    .map((operation, index) => {
      const sourceIn = Number(operation.sourceIn);
      const sourceOut = Number(operation.sourceOut);
      const sourceInFrame = secondsToFrame(sourceIn, fps);
      const sourceOutFrame = secondsToFrame(sourceOut, fps);
      if (sourceOutFrame <= sourceInFrame) throw new Error(`select_range ${operation.id || index} has an empty range`);
      const requestedTimelineFrame = Number.isFinite(Number(operation.timelineIn))
        ? secondsToFrame(operation.timelineIn, fps)
        : null;
      const requestedTimelineEndFrame = requestedTimelineFrame === null
        ? null
        : secondsToFrame(Number(operation.timelineIn) + (sourceOut - sourceIn), fps);
      const durationFrames = requestedTimelineEndFrame === null
        ? sourceOutFrame - sourceInFrame
        : requestedTimelineEndFrame - requestedTimelineFrame;
      if (durationFrames <= 0) throw new Error(`select_range ${operation.id || index} has an empty timeline range`);
      const audioAssetId = operation.audioAssetId || operation.assetId;
      const audioSourceIn = Number(operation.audioSourceIn ?? operation.sourceIn);
      const audioSourceOut = Number(operation.audioSourceOut ?? operation.sourceOut);
      if (!Number.isFinite(audioSourceIn) || !Number.isFinite(audioSourceOut) || audioSourceOut <= audioSourceIn) {
        throw new Error(`select_range ${operation.id || index} has an invalid audio range`);
      }
      if (Math.abs((audioSourceOut - audioSourceIn) - (sourceOut - sourceIn)) > 0.05) {
        throw new Error(`select_range ${operation.id || index} has mismatched audio/video duration`);
      }
      return {
        operationId: operation.id || `select-${index}`,
        assetId: operation.assetId,
        sourceInFrame,
        durationFrames,
        audioAssetId,
        audioSourceInFrame: secondsToFrame(audioSourceIn, fps),
        requestedTimelineFrame,
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

  return {
    fps,
    clips,
    captions,
    audioStrategy: String(multicam?.audioStrategy || 'selected_asset'),
    masterAudioAssetId: multicam?.masterAudioAssetId ? String(multicam.masterAudioAssetId) : undefined,
  };
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

async function resolveMasterAudioMedia({ command, projectId, plan, tools }) {
  if (plan.audioStrategy !== 'master_audio') return null;
  const audioAssetIds = [...new Set(plan.clips.map((clip) => clip.audioAssetId).filter(Boolean))];
  if (audioAssetIds.length !== 1) throw new Error('master_audio requires exactly one audio asset');
  const audioAssetId = audioAssetIds[0];
  if (plan.masterAudioAssetId && plan.masterAudioAssetId !== audioAssetId) {
    throw new Error(`masterAudioAssetId mismatch: ${plan.masterAudioAssetId} != ${audioAssetId}`);
  }

  const getMediaTool = chooseTool(tools, [/^get_media$/i]);
  const importMediaTool = chooseTool(tools, [/^import_media$/i]);
  if (!getMediaTool || !importMediaTool) throw new Error('Palmier requires get_media and import_media for master audio');
  const bindings = normalizeAssetBindings(command.payload);
  const binding = bindings[audioAssetId];
  if (!binding) throw new Error(`No asset binding supplied for master audio ${audioAssetId}`);
  let media = mediaItemsFromResult(await callTool(getMediaTool.name, {}));

  if (typeof binding.audioMediaRef === 'string' && binding.audioMediaRef) {
    const found = media.find((item) => mediaIdentity(item) === binding.audioMediaRef);
    if (!found) throw new Error(`Bound audioMediaRef not found in Palmier: ${binding.audioMediaRef}`);
    if (String(found.type || '').toLowerCase() !== 'audio') throw new Error(`audioMediaRef is not an audio asset: ${binding.audioMediaRef}`);
    return { audioAssetId, mediaRef: binding.audioMediaRef, source: 'audioMediaRef' };
  }

  const sourcePath = typeof binding.audioPath === 'string' && path.isAbsolute(binding.audioPath)
    ? binding.audioPath
    : typeof binding.path === 'string' && path.isAbsolute(binding.path)
      ? binding.path
      : null;
  if (!sourcePath) {
    throw new Error(`master_audio ${audioAssetId} requires audioMediaRef, audioPath, or a local video path`);
  }
  const sourceStat = await fs.stat(sourcePath);
  const sourceFingerprint = stableHash({
    path: sourcePath,
    size: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs,
  }).slice(0, 16);
  const importNameBase = binding.audioName || `gag-${projectId}-${audioAssetId}-master-audio`;
  const importName = `${importNameBase}-${sourceFingerprint}`;
  const existing = media.find((item) => mediaDisplayName(item) === importName && String(item.type || '').toLowerCase() === 'audio');
  if (existing && mediaIdentity(existing)) {
    return { audioAssetId, mediaRef: mediaIdentity(existing), source: 'existing_audio_asset', sourceFingerprint };
  }

  let audioPath;
  if (typeof binding.audioPath === 'string' && path.isAbsolute(binding.audioPath)) {
    audioPath = binding.audioPath;
  } else {
    const audioDir = path.join(STATE_DIR, 'master-audio');
    await fs.mkdir(audioDir, { recursive: true });
    audioPath = path.join(audioDir, `${projectId}-${audioAssetId}-${sourceFingerprint}.m4a`);
    const exists = await fs.access(audioPath).then(() => true).catch(() => false);
    if (!exists) {
      await execFileAsync(FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', sourcePath,
        '-map', '0:a:0',
        '-vn', '-c:a', 'aac', '-b:a', '192k',
        audioPath,
      ], { timeout: 10 * 60_000, maxBuffer: 4_000_000 });
    }
  }

  await callTool(importMediaTool.name, { source: { path: audioPath }, name: importName });
  media = mediaItemsFromResult(await callTool(getMediaTool.name, {}));
  const imported = media.find((item) => mediaDisplayName(item) === importName && String(item.type || '').toLowerCase() === 'audio');
  const mediaRef = mediaIdentity(imported);
  if (!mediaRef) throw new Error(`Palmier imported master audio ${audioAssetId} but did not expose an audio mediaRef`);
  return { audioAssetId, mediaRef, audioPath, source: 'extracted_audio', sourceFingerprint };
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
    const assetIds = [...new Set(operations
      .filter((operation) => operation?.type === 'select_range')
      .flatMap((operation) => [operation.assetId, operation.audioAssetId])
      .filter(Boolean))];
    if (!assetIds.length) return { status: 'unsupported', reason: 'Project has no selected source assets' };
    const bindings = normalizeAssetBindings(command.payload);
    const projectPaths = project.sourceMediaPaths && typeof project.sourceMediaPaths === 'object'
      ? project.sourceMediaPaths
      : {};
    const assetBindings = {};
    for (const assetId of assetIds) {
      const binding = bindings[assetId] || {};
      const mediaPath = typeof binding.path === 'string' && path.isAbsolute(binding.path)
        ? binding.path
        : typeof projectPaths[assetId] === 'string' && path.isAbsolute(projectPaths[assetId])
          ? projectPaths[assetId]
          : assetIds.length === 1 && typeof project.sourceMediaPath === 'string' && path.isAbsolute(project.sourceMediaPath)
            ? project.sourceMediaPath
            : null;
      if (!mediaPath) return { status: 'unsupported', reason: `Preview source path is missing for ${assetId}` };
      await fs.access(mediaPath);
      assetBindings[assetId] = { path: mediaPath };
    }

    const fingerprint = stableHash(project.editorialIr).slice(0, 16);
    const previewDir = path.join(STATE_DIR, 'previews');
    await fs.mkdir(previewDir, { recursive: true });
    const irFile = path.join(previewDir, `${command.projectId}-${fingerprint}.editorial-ir.json`);
    const outputPath = typeof command.payload?.outputPath === 'string' && path.isAbsolute(command.payload.outputPath)
      ? command.payload.outputPath
      : path.join(previewDir, `${command.projectId}-${fingerprint}.mp4`);
    await fs.writeFile(irFile, `${JSON.stringify(project.editorialIr, null, 2)}\n`, 'utf8');
    const render = await renderPreview({
      assetBindings,
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

  if (command.action === 'export_xml') {
    const project = await requestJson(`${DASHBOARD}/api/projects/${command.projectId}`);
    const operations = project?.editorialIr?.timeline?.operations;
    if (!Array.isArray(operations)) return { status: 'unsupported', reason: 'Project has no Editorial IR operations' };
    const assetIds = [...new Set(operations
      .filter((operation) => operation?.type === 'select_range')
      .flatMap((operation) => [operation.assetId, operation.audioAssetId])
      .filter(Boolean))];
    if (!assetIds.length) return { status: 'unsupported', reason: 'Project has no selected source assets' };
    const bindings = normalizeAssetBindings(command.payload);
    const projectPaths = project.sourceMediaPaths && typeof project.sourceMediaPaths === 'object'
      ? project.sourceMediaPaths
      : {};
    const assetBindings = {};
    for (const assetId of assetIds) {
      const binding = bindings[assetId] || {};
      const mediaPath = typeof binding.path === 'string' && path.isAbsolute(binding.path)
        ? binding.path
        : typeof projectPaths[assetId] === 'string' && path.isAbsolute(projectPaths[assetId])
          ? projectPaths[assetId]
          : assetIds.length === 1 && typeof project.sourceMediaPath === 'string' && path.isAbsolute(project.sourceMediaPath)
            ? project.sourceMediaPath
            : null;
      if (!mediaPath) return { status: 'unsupported', reason: `Premiere XML source path is missing for ${assetId}` };
      await fs.access(mediaPath);
      assetBindings[assetId] = { path: mediaPath };
    }

    const fingerprint = stableHash(project.editorialIr).slice(0, 16);
    const exportDir = path.join(STATE_DIR, 'exports');
    await fs.mkdir(exportDir, { recursive: true });
    const outputPath = typeof command.payload?.outputPath === 'string' && path.isAbsolute(command.payload.outputPath)
      ? command.payload.outputPath
      : path.join(exportDir, `${command.projectId}-${fingerprint}.xml`);
    const captionsOutput = typeof command.payload?.captionsOutputPath === 'string' && path.isAbsolute(command.payload.captionsOutputPath)
      ? command.payload.captionsOutputPath
      : path.join(exportDir, `${command.projectId}-${fingerprint}.srt`);
    const exported = await exportPremiereXml({
      project,
      editorialIr: project.editorialIr,
      assetBindings,
      output: outputPath,
      captionsOutput,
      ...(command.payload?.ffprobe ? { ffprobePath: command.payload.ffprobe } : {}),
    });

    const artifacts = [];
    if (command.payload?.publishToDrive !== false) {
      const xmlUpload = await uploadArtifact({
        projectId: command.projectId,
        file: outputPath,
        kind: 'export',
        label: command.payload?.label || 'Premiere Pro XML',
        note: command.payload?.note || 'Editorial IRから生成したXMEML v5',
        dataDir: STATE_DIR,
      });
      artifacts.push(xmlUpload.artifact);
      if (exported.captionMarkerCount > 0) {
        const captionsUpload = await uploadArtifact({
          projectId: command.projectId,
          file: captionsOutput,
          kind: 'captions',
          label: command.payload?.captionsLabel || 'Premiere字幕 SRT',
          note: command.payload?.captionsNote || 'Editorial IR字幕のsidecar',
          dataDir: STATE_DIR,
        });
        artifacts.push(captionsUpload.artifact);
      }
      for (const artifact of artifacts) {
        await requestJson(`${DASHBOARD}/api/projects/${command.projectId}/artifacts`, {
          method: 'POST',
          body: JSON.stringify({ artifact }),
        });
      }
    }
    return { status: 'completed', mode: 'premiere_xmeml_v5', export: exported, artifacts };
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
    const plan = compileEditorialPlan(operations, fps, project.editorialIr.multicam);
    const bindings = await resolveMediaBindings({ command, projectId: command.projectId, plan, tools });
    const masterAudio = await resolveMasterAudioMedia({ command, projectId: command.projectId, plan, tools });
    const expectedClips = plan.clips.map((clip) => ({ ...clip, mediaRef: bindings[clip.assetId] }));
    const expectedMasterAudioClips = masterAudio
      ? plan.clips.map((clip) => ({
          operationId: `${clip.operationId}-master-audio`,
          mediaRef: masterAudio.mediaRef,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          sourceInFrame: clip.audioSourceInFrame,
        }))
      : [];
    const fingerprint = stableHash({ plan, bindings, masterAudioMediaRef: masterAudio?.mediaRef });
    const previousState = await readBridgeState(command.projectId);
    const initialClips = allTimelineClips(initialTimeline);

    if (previousState?.fingerprint === fingerprint) {
      const managedVideoValid = (previousState.managedVideoClipIds || []).every((id) => initialClips.some((clip) => clip.id === id));
      const managedAudioValid = (previousState.managedAudioClipIds || []).every((id) => initialClips.some((clip) => clip.id === id));
      const mutedLinkedAudioValid = (previousState.mutedLinkedAudioClipIds || []).every((id) => initialClips.some((clip) => clip.id === id && Number(clip.volume ?? 1) === 0));
      const captionsValid = plan.captions.every((caption) => existingTextEventKeys(initialTimeline).has(textEventKey(caption.startFrame, caption.durationFrames, caption.text)));
      const expectedValid = expectedClips.every((expected) => initialClips.some((clip) => clipMatchesExpected(clip, expected)));
      const expectedMasterAudioValid = expectedMasterAudioClips.every((expected) => initialClips.some((clip) => clip.mediaType === 'audio' && clipMatchesExpected(clip, expected)));
      if (managedVideoValid && managedAudioValid && mutedLinkedAudioValid && captionsValid && expectedValid && expectedMasterAudioValid) {
        return {
          status: 'completed',
          mode: masterAudio ? 'cut_caption_master_audio_mvp' : 'cut_caption_mvp',
          result: 'already_applied',
          fps,
          fingerprint,
          operationResults: operations.map((operation) => ({ operationId: operation.id, type: operation.type, status: 'already_present' })),
        };
      }
    }

    const beforeIds = new Set(initialClips.map((clip) => clip.id));
    const createdVideoIds = [];
    const createdAudioIds = [];
    const mutedLinkedAudioIds = [];
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
          if (masterAudio && created.linkGroupId) {
            const linkedAudio = clips.find((clip) => clip.linkGroupId === created.linkGroupId && clip.mediaType === 'audio');
            if (!linkedAudio?.id) throw new Error(`Unable to identify linked Palmier audio for ${expected.operationId}`);
            mutedLinkedAudioIds.push(linkedAudio.id);
          }
        }
        if (mutedLinkedAudioIds.length) {
          await callTool(setClipTool.name, { clipIds: mutedLinkedAudioIds, volume: 0 });
        }
      }

      if (expectedMasterAudioClips.length) {
        mutationStarted = true;
        const beforeMasterAudio = allTimelineClips(toolContentJson(await callTool(timelineTool.name, {})) || {});
        const idsBeforeMasterAudio = new Set(beforeMasterAudio.map((clip) => clip.id));
        await callTool(addClipsTool.name, {
          entries: expectedMasterAudioClips.map((clip) => ({
            mediaRef: clip.mediaRef,
            startFrame: clip.startFrame,
            durationFrames: clip.durationFrames,
          })),
        });
        const timelineAfterMasterAudio = toolContentJson(await callTool(timelineTool.name, {})) || {};
        const clipsAfterMasterAudio = allTimelineClips(timelineAfterMasterAudio);
        for (const expected of expectedMasterAudioClips) {
          const created = clipsAfterMasterAudio.find((clip) => !idsBeforeMasterAudio.has(clip.id)
            && clip.mediaType === 'audio'
            && clip.mediaRef === expected.mediaRef
            && clip.startFrame === expected.startFrame
            && clip.durationFrames === expected.durationFrames);
          if (!created?.id) throw new Error(`Unable to identify Palmier master audio for ${expected.operationId}`);
          createdAudioIds.push(created.id);
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
      const audioChecks = expectedMasterAudioClips.map((expected) => ({
        operationId: expected.operationId,
        valid: finalClips.some((clip) => clip.mediaType === 'audio' && clipMatchesExpected(clip, expected)),
      }));
      const mutedLinkedAudioChecks = mutedLinkedAudioIds.map((clipId) => ({
        operationId: `mute-${clipId}`,
        valid: finalClips.some((clip) => clip.id === clipId && clip.mediaType === 'audio' && Number(clip.volume ?? 1) === 0),
      }));
      const captionChecks = plan.captions.map((caption) => ({
        operationId: caption.operationId,
        valid: existingTextEventKeys(finalTimeline).has(textEventKey(caption.startFrame, caption.durationFrames, caption.text)),
      }));
      const failedCheck = [...clipChecks, ...audioChecks, ...mutedLinkedAudioChecks, ...captionChecks].find((check) => !check.valid);
      if (failedCheck) throw new Error(`Postflight verification failed for ${failedCheck.operationId}`);

      const oldManagedIds = [...new Set([
        ...(previousState?.managedVideoClipIds || []),
        ...(previousState?.managedAudioClipIds || []),
        ...(previousState?.managedTextClipIds || []),
      ])]
        .filter((id) => finalClips.some((clip) => clip.id === id))
        .filter((id) => !createdVideoIds.includes(id) && !createdAudioIds.includes(id) && !createdTextIds.includes(id));
      if (oldManagedIds.length) await callTool(removeClipsTool.name, { clipIds: oldManagedIds });

      await writeBridgeState(command.projectId, {
        schemaVersion: 2,
        projectId: command.projectId,
        fingerprint,
        fps,
        audioStrategy: plan.audioStrategy,
        managedVideoClipIds: createdVideoIds,
        managedAudioClipIds: createdAudioIds,
        mutedLinkedAudioClipIds: mutedLinkedAudioIds,
        managedTextClipIds: createdTextIds,
        appliedAt: new Date().toISOString(),
      });

      return {
        status: 'completed',
        mode: masterAudio ? 'cut_caption_master_audio_mvp' : 'cut_caption_mvp',
        result: previousState ? 'replaced_managed_edit' : 'applied',
        fps,
        fingerprint,
        managedVideoClipIds: createdVideoIds,
        managedAudioClipIds: createdAudioIds,
        mutedLinkedAudioClipIds: mutedLinkedAudioIds,
        managedTextClipIds: createdTextIds,
        operationResults: operations.map((operation) => ({
          operationId: operation.id,
          type: operation.type,
          status: operation.type === 'remove_range' ? 'applied_by_reconstruction' : 'applied_exactly',
        })),
      };
    } catch (error) {
      if (mutationStarted) {
        const expectedMediaRefs = new Set([
          ...expectedClips.map((clip) => clip.mediaRef),
          ...expectedMasterAudioClips.map((clip) => clip.mediaRef),
        ]);
        const expectedTexts = new Set(plan.captions.map((caption) => caption.text));
        const currentTimeline = toolContentJson(await callTool(timelineTool.name, {}).catch(() => null)) || {};
        const discovered = allTimelineClips(currentTimeline).filter((clip) => !beforeIds.has(clip.id)
          && (expectedMediaRefs.has(clip.mediaRef) || (clip.mediaType === 'text' && expectedTexts.has(clip.textContent))));
        const candidates = [
          ...discovered,
          ...allTimelineClips(currentTimeline).filter((clip) => [...createdVideoIds, ...createdAudioIds, ...createdTextIds].includes(clip.id)),
        ];
        const rollbackIds = [];
        const seenGroups = new Set();
        for (const clip of candidates) {
          const key = clip.linkGroupId || clip.id;
          if (!clip.id || seenGroups.has(key)) continue;
          seenGroups.add(key);
          rollbackIds.push(clip.id);
        }
        if (rollbackIds.length) await callTool(removeClipsTool.name, { clipIds: rollbackIds }).catch(() => undefined);
      }
      throw error;
    }
  }
  throw new Error(`Unsupported command action: ${command.action}`);
}

export async function pollOnce() {
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
        await patchCommand(command.id, { status: 'completed', message: 'Bridge command completed', result });
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

#!/usr/bin/env node
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DEFAULT_ANALYSIS_POLICY,
  buildAnalysisDocument,
  buildEditorialIr,
  buildQcReport,
  normalizeTranscript,
  planRemovals,
  stableFingerprint,
} from './analysis-core.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'no-scenes' || key === 'dry-run') {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function required(options, key) {
  const value = String(options[key] || '').trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function parseFrameRate(value) {
  const text = String(value || '30/1');
  const [left, right] = text.split('/').map(Number);
  const rate = right ? left / right : left;
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : 30;
}

function parseTimestamp(value) {
  const match = String(value).trim().match(/(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})/u);
  if (!match) return undefined;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function parseTimedText(text, extension) {
  const cleaned = String(text).replace(/^WEBVTT[^\n]*\n+/u, '').trim();
  const blocks = cleaned.split(/\n\s*\n/u);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const [startText, endText] = lines[timingIndex].split('-->').map((part) => part.trim().split(/\s+/u)[0]);
    const start = parseTimestamp(startText);
    const end = parseTimestamp(endText);
    const content = lines.slice(timingIndex + 1).join(' ').replace(/<[^>]+>/gu, '').trim();
    if (start === undefined || end === undefined || end <= start || !content) continue;
    segments.push({ start, end, speaker: 'speaker-1', text: content });
  }
  return { language: 'und', provider: extension.slice(1), segments };
}

async function loadTranscript(file) {
  if (!file) return { language: 'und', provider: 'none', segments: [] };
  const extension = path.extname(file).toLowerCase();
  const text = await fs.readFile(file, 'utf8');
  if (extension === '.json') return normalizeTranscript(JSON.parse(text));
  if (extension === '.srt' || extension === '.vtt') return normalizeTranscript(parseTimedText(text, extension));
  throw new Error(`Unsupported transcript format: ${extension}`);
}

async function run(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout || 120_000,
  });
}

async function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function probeMedia(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size,format_name:stream=index,codec_type,width,height,r_frame_rate,sample_rate,channels,codec_name',
    '-of', 'json',
    file,
  ]);
  const parsed = JSON.parse(stdout);
  const video = (parsed.streams || []).find((stream) => stream.codec_type === 'video');
  const audio = (parsed.streams || []).find((stream) => stream.codec_type === 'audio');
  const durationSeconds = Number(parsed.format?.duration || 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('ffprobe returned an invalid duration');
  return {
    path: file,
    filename: path.basename(file),
    durationSeconds: Math.round(durationSeconds * 1000) / 1000,
    sizeBytes: Number(parsed.format?.size || 0),
    format: String(parsed.format?.format_name || ''),
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    frameRate: parseFrameRate(video?.r_frame_rate),
    videoCodec: String(video?.codec_name || ''),
    hasAudio: Boolean(audio),
    audioCodec: String(audio?.codec_name || ''),
    audioSampleRate: Number(audio?.sample_rate || 0),
    audioChannels: Number(audio?.channels || 0),
  };
}

function parseSilenceOutput(stderr, durationSeconds) {
  const events = [];
  let pendingStart;
  for (const line of String(stderr).split(/\r?\n/u)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/u);
    if (startMatch) pendingStart = Number(startMatch[1]);
    const endMatch = line.match(/silence_end:\s*([0-9.]+)/u);
    if (endMatch) {
      const end = Number(endMatch[1]);
      const start = pendingStart ?? 0;
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) events.push({ start, end });
      pendingStart = undefined;
    }
  }
  if (pendingStart !== undefined && durationSeconds > pendingStart) events.push({ start: pendingStart, end: durationSeconds });
  return events;
}

async function detectSilences(file, media, options) {
  if (!media.hasAudio) return [];
  const noise = String(options['silence-threshold'] || '-35dB');
  const minimum = String(options['detector-silence-min'] || '0.35');
  try {
    const { stderr } = await run('ffmpeg', [
      '-hide_banner', '-nostats', '-i', file,
      '-af', `silencedetect=noise=${noise}:d=${minimum}`,
      '-f', 'null', '-',
    ]);
    return parseSilenceOutput(stderr, media.durationSeconds);
  } catch (error) {
    const stderr = error?.stderr || '';
    const parsed = parseSilenceOutput(stderr, media.durationSeconds);
    if (parsed.length) return parsed;
    throw new Error(`Silence detection failed: ${String(error?.message || error).slice(0, 240)}`);
  }
}

async function detectSceneChanges(file, threshold = 0.35) {
  try {
    const { stderr } = await run('ffmpeg', [
      '-hide_banner', '-nostats', '-i', file,
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-an', '-f', 'null', '-',
    ], { timeout: 180_000 });
    return [...String(stderr).matchAll(/pts_time:([0-9.]+)/gu)].map((match, index) => ({
      id: `scene-${String(index + 1).padStart(3, '0')}`,
      time: Math.round(Number(match[1]) * 1000) / 1000,
      threshold,
      confidence: 0.65,
    }));
  } catch (error) {
    const stderr = String(error?.stderr || '');
    const parsed = [...stderr.matchAll(/pts_time:([0-9.]+)/gu)].map((match, index) => ({
      id: `scene-${String(index + 1).padStart(3, '0')}`,
      time: Math.round(Number(match[1]) * 1000) / 1000,
      threshold,
      confidence: 0.65,
    }));
    return parsed;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

async function publishProject(dashboardUrl, projectId, bundle) {
  const base = String(dashboardUrl).trim().replace(/\/+$/u, '');
  const response = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Dashboard sync failed (${response.status}): ${body?.error?.message || 'unknown error'}`);
  return { dashboardUrl: base, projectId: body.id, updatedAt: body.updatedAt };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectId = required(options, 'project');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(projectId)) throw new Error('Invalid --project id');
  const mediaPath = path.resolve(required(options, 'media'));
  if (!existsSync(mediaPath)) throw new Error(`Media file not found: ${mediaPath}`);
  const transcriptPath = options.transcript ? path.resolve(String(options.transcript)) : undefined;
  if (transcriptPath && !existsSync(transcriptPath)) throw new Error(`Transcript file not found: ${transcriptPath}`);
  const outputDir = path.resolve(String(options['output-dir'] || path.join(ROOT, 'data', 'projects', projectId)));
  const assetId = String(options['asset-id'] || 'cam-a');
  const generatedAt = new Date().toISOString();

  const [media, transcript, fingerprint] = await Promise.all([
    probeMedia(mediaPath),
    loadTranscript(transcriptPath),
    fileSha256(mediaPath),
  ]);
  media.fingerprint = fingerprint;
  const policy = {
    ...DEFAULT_ANALYSIS_POLICY,
    ...(options['silence-min'] ? { silenceRemoveMinSeconds: Number(options['silence-min']) } : {}),
  };
  const silences = await detectSilences(mediaPath, media, options);
  const sceneChanges = options['no-scenes'] ? [] : await detectSceneChanges(mediaPath, Number(options['scene-threshold'] || 0.35));
  const plan = planRemovals({ durationSeconds: media.durationSeconds, silences, transcript, policy });
  const editorialIr = buildEditorialIr({ projectId, assetId, media, transcript, plan, policy, generatedAt });
  const analysis = buildAnalysisDocument({ media, transcript, plan, sceneChanges, policy, generatedAt });
  analysis.inputFingerprint = stableFingerprint({ media: fingerprint, transcript });
  const qc = buildQcReport({ media, transcript, plan, editorialIr, sceneChanges });
  const project = {
    id: projectId,
    title: String(options.title || `解析 ${path.basename(mediaPath)}`),
    description: String(options.description || 'FFmpeg音響解析と文字起こしからEditorial IRを自動生成'),
    status: qc.status === 'fail' ? 'analysis_failed' : qc.status === 'review' ? 'review_ready' : 'analysis_ready',
    durationSeconds: media.durationSeconds,
    outputDurationSeconds: editorialIr.timeline.durationSeconds,
    adapterStatus: 'editorial_ir_ready',
    sourceAssetId: assetId,
    sourceMediaPath: mediaPath,
    updatedAt: generatedAt,
  };

  const existingArtifacts = await fs.readFile(path.join(outputDir, 'artifacts.json'), 'utf8').then(JSON.parse).catch(() => ({ version: 1, artifacts: [] }));
  const bundle = { project, analysis, transcript, editorialIr, qc, artifacts: existingArtifacts };
  const result = {
    ok: qc.status !== 'fail',
    projectId,
    outputDir,
    sourceDurationSeconds: media.durationSeconds,
    outputDurationSeconds: editorialIr.timeline.durationSeconds,
    removalCount: plan.removals.length,
    captionCount: editorialIr.timeline.operations.filter((operation) => operation.type === 'caption').length,
    qcStatus: qc.status,
    files: ['project.json', 'analysis.json', 'transcript.json', 'editorial-ir.json', 'qc-report.json'],
  };

  if (!options['dry-run']) {
    await Promise.all([
      writeJsonAtomic(path.join(outputDir, 'project.json'), project),
      writeJsonAtomic(path.join(outputDir, 'analysis.json'), analysis),
      writeJsonAtomic(path.join(outputDir, 'transcript.json'), transcript),
      writeJsonAtomic(path.join(outputDir, 'editorial-ir.json'), editorialIr),
      writeJsonAtomic(path.join(outputDir, 'qc-report.json'), qc),
      writeJsonAtomic(path.join(outputDir, 'artifacts.json'), existingArtifacts),
    ]);
    if (options['dashboard-url']) result.publish = await publishProject(options['dashboard-url'], projectId, bundle);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});

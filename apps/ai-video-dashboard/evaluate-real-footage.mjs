#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateAudioOffset } from './multicam-core.mjs';
import { buildRealFootageQualityReport } from './real-footage-quality.mjs';

const DEFAULT_FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const DEFAULT_FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
}

function required(options, key) {
  const value = String(options[key] || '').trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

async function runCapture(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 120_000);
  const maxBytes = Number(options.maxBytes || 8 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        reject(new Error(`${path.basename(command)} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill('SIGKILL');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`${path.basename(command)} output exceeded ${maxBytes} bytes`));
        }
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${path.basename(command)} exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(-1200)}`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

function pcmEnvelope(buffer, sampleRate, envelopeFrameRate) {
  const samplesPerFrame = Math.max(1, Math.round(sampleRate / envelopeFrameRate));
  const sampleCount = Math.floor(buffer.length / 2);
  const frameCount = Math.floor(sampleCount / samplesPerFrame);
  const values = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sumSquares = 0;
    const start = frame * samplesPerFrame;
    for (let index = 0; index < samplesPerFrame; index += 1) {
      const sample = buffer.readInt16LE((start + index) * 2) / 32768;
      sumSquares += sample * sample;
    }
    values.push(Math.log1p(Math.sqrt(sumSquares / samplesPerFrame) * 100));
  }
  return values;
}

async function extractEnvelope(file, startSeconds, durationSeconds, options) {
  const sampleRate = Number(options.sampleRate || 8000);
  const frameRate = Number(options.envelopeFrameRate || 50);
  const { stdout } = await runCapture(options.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, startSeconds)), '-i', file,
    '-t', String(durationSeconds), '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', 'pipe:1',
  ], { timeoutMs: 180_000, maxBytes: Math.ceil(sampleRate * 2 * durationSeconds + 500_000) });
  return { frameRate, values: pcmEnvelope(stdout, sampleRate, frameRate) };
}

function sampleStarts(minimum, maximum, windowSeconds) {
  const last = Math.max(minimum, maximum - windowSeconds);
  return [...new Set([minimum, (minimum + last) / 2, last].map((value) => round(value)))];
}

function driftMetrics(windows) {
  if (windows.length < 2) return { driftMsPerMinute: 0, offsetRangeMs: 0 };
  const meanTime = windows.reduce((sum, row) => sum + row.referenceStartSeconds, 0) / windows.length;
  const meanOffset = windows.reduce((sum, row) => sum + row.absoluteOffsetSeconds, 0) / windows.length;
  const denominator = windows.reduce((sum, row) => sum + (row.referenceStartSeconds - meanTime) ** 2, 0);
  const slope = denominator > 0
    ? windows.reduce((sum, row) => sum + (row.referenceStartSeconds - meanTime) * (row.absoluteOffsetSeconds - meanOffset), 0) / denominator
    : 0;
  const offsets = windows.map((row) => row.absoluteOffsetSeconds);
  return {
    driftMsPerMinute: round(slope * 60_000, 2),
    offsetRangeMs: round((Math.max(...offsets) - Math.min(...offsets)) * 1000, 2),
  };
}

async function buildSyncAudit(analysis, options) {
  const assets = Array.isArray(analysis?.assets) ? analysis.assets : [];
  const referenceAssetId = String(analysis?.referenceAssetId || '');
  const reference = assets.find((asset) => String(asset.id) === referenceAssetId);
  if (!reference) throw new Error(`Reference asset is unavailable: ${referenceAssetId}`);
  const result = {
    version: 'sync-audit.v1',
    referenceAssetId,
    assets: { [referenceAssetId]: { method: 'reference', windows: [], driftMsPerMinute: 0, offsetRangeMs: 0 } },
  };
  for (const asset of assets) {
    const assetId = String(asset.id);
    if (assetId === referenceAssetId) continue;
    const sync = analysis?.synchronization?.[assetId] || {};
    const expectedOffset = Number(sync.sourceOffsetSeconds || 0);
    const minimum = Math.max(0, -expectedOffset);
    const maximum = Math.min(Number(reference.durationSeconds || 0), Number(asset.durationSeconds || 0) - expectedOffset);
    const overlap = maximum - minimum;
    const windowSeconds = Math.min(Number(options.windowSeconds || 8), overlap / 3);
    const windows = [];
    if (reference.hasAudio && asset.hasAudio && windowSeconds >= 1.5) {
      for (const referenceStartSeconds of sampleStarts(minimum, maximum, windowSeconds)) {
        const candidateStartSeconds = referenceStartSeconds + expectedOffset;
        const [left, right] = await Promise.all([
          extractEnvelope(reference.path, referenceStartSeconds, windowSeconds, options),
          extractEnvelope(asset.path, candidateStartSeconds, windowSeconds, options),
        ]);
        const residual = estimateAudioOffset(left.values, right.values, left.frameRate, {
          maximumOffsetSeconds: Number(options.residualMaxSeconds || 1),
          minimumOverlapFrames: Math.max(50, Math.floor(left.frameRate * Math.min(2, windowSeconds / 2))),
          minimumSyncConfidence: 0.45,
          minimumCorrelationScore: 0.35,
        });
        windows.push({
          referenceStartSeconds,
          candidateStartSeconds: round(candidateStartSeconds),
          expectedOffsetSeconds: round(expectedOffset),
          residualOffsetSeconds: round(residual.sourceOffsetSeconds || 0),
          absoluteOffsetSeconds: round(expectedOffset + Number(residual.sourceOffsetSeconds || 0)),
          correlationScore: residual.correlationScore,
          confidence: residual.confidence,
          status: residual.status,
        });
      }
    }
    result.assets[assetId] = {
      method: sync.method || 'audio_correlation',
      expectedOffsetSeconds: round(expectedOffset),
      windows,
      ...driftMetrics(windows),
      ...(windows.length ? {} : { reason: reference.hasAudio && asset.hasAudio ? 'insufficient_overlap' : 'audio_stream_unavailable' }),
    };
  }
  return result;
}

function parseSilences(stderr, durationSeconds) {
  const events = [...stderr.toString('utf8').matchAll(/silence_(start|end):\s*([0-9.]+)/gu)]
    .map((match) => ({ type: match[1], time: Number(match[2]) }));
  const intervals = [];
  let open = null;
  for (const event of events) {
    if (event.type === 'start') open = event.time;
    else if (open !== null) {
      intervals.push({ start: round(open), end: round(event.time), duration: round(event.time - open) });
      open = null;
    }
  }
  if (open !== null) intervals.push({ start: round(open), end: round(durationSeconds), duration: round(durationSeconds - open) });
  return intervals;
}

async function probePreview(previewPath, editorialIr, options) {
  const { stdout } = await runCapture(options.ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', previewPath,
  ], { timeoutMs: 30_000, maxBytes: 1_000_000 });
  const parsed = JSON.parse(stdout.toString('utf8'));
  const durationSeconds = Number(parsed.format?.duration || 0);
  const hasAudio = (parsed.streams || []).some((stream) => stream.codec_type === 'audio');
  let meanVolumeDb = null;
  let maxVolumeDb = null;
  let silenceIntervals = [];
  if (hasAudio) {
    const { stderr } = await runCapture(options.ffmpeg, [
      '-hide_banner', '-i', previewPath, '-vn', '-af', 'silencedetect=noise=-45dB:d=0.08,volumedetect', '-f', 'null', '-',
    ], { timeoutMs: 180_000, maxBytes: 4_000_000 });
    const text = stderr.toString('utf8');
    meanVolumeDb = Number(text.match(/mean_volume:\s*(-?[0-9.]+) dB/u)?.[1] ?? NaN);
    maxVolumeDb = Number(text.match(/max_volume:\s*(-?[0-9.]+) dB/u)?.[1] ?? NaN);
    silenceIntervals = parseSilences(stderr, durationSeconds);
  }
  const boundaries = [...new Set((editorialIr?.timeline?.operations || [])
    .filter((operation) => operation?.type === 'select_range' && Number(operation.timelineIn) > 0)
    .map((operation) => round(operation.timelineIn)))]
    .sort((left, right) => left - right);
  const tolerance = Number(options.boundaryWindowSeconds || 0.08);
  const boundarySilenceHits = boundaries.flatMap((boundary) => silenceIntervals
    .filter((interval) => interval.start <= boundary + tolerance && interval.end >= boundary - tolerance)
    .map((interval) => ({ boundarySeconds: boundary, silence: interval })));
  return {
    path: previewPath,
    durationSeconds: round(durationSeconds),
    hasAudio,
    meanVolumeDb: Number.isFinite(meanVolumeDb) ? meanVolumeDb : null,
    maxVolumeDb: Number.isFinite(maxVolumeDb) ? maxVolumeDb : null,
    silenceIntervals,
    cutBoundariesSeconds: boundaries,
    boundarySilenceHits,
  };
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

export async function evaluateRealFootage(options) {
  const projectDir = path.resolve(required(options, 'project-dir'));
  const previewPath = path.resolve(required(options, 'preview'));
  await fs.access(previewPath);
  const [project, analysis, editorialIr, qc, transcript, artifacts] = await Promise.all([
    readJson(path.join(projectDir, 'project.json')),
    readJson(path.join(projectDir, 'analysis.json')),
    readJson(path.join(projectDir, 'editorial-ir.json')),
    readJson(path.join(projectDir, 'qc-report.json')),
    readJson(path.join(projectDir, 'transcript.json')),
    readJson(path.join(projectDir, 'artifacts.json'), { version: 1, artifacts: [] }),
  ]);
  const runtime = {
    ffmpeg: String(options.ffmpeg || DEFAULT_FFMPEG),
    ffprobe: String(options.ffprobe || DEFAULT_FFPROBE),
    sampleRate: 8000,
    envelopeFrameRate: 50,
    windowSeconds: Number(options['window-seconds'] || 8),
    residualMaxSeconds: Number(options['residual-max-seconds'] || 1),
    boundaryWindowSeconds: Number(options['boundary-window-seconds'] || 0.08),
  };
  const [syncAudit, previewAudit] = await Promise.all([
    buildSyncAudit(analysis, runtime),
    probePreview(previewPath, editorialIr, runtime),
  ]);
  const generatedAt = new Date().toISOString();
  const evaluation = buildRealFootageQualityReport({ project, analysis, editorialIr, qc, previewAudit, syncAudit, generatedAt });
  const updatedProject = { ...project, evaluationStatus: evaluation.status, qualityScore: evaluation.score, updatedAt: generatedAt };
  const outputPath = path.resolve(String(options.output || path.join(projectDir, 'evaluation-report.json')));
  await Promise.all([
    writeJsonAtomic(outputPath, evaluation),
    writeJsonAtomic(path.join(projectDir, 'project.json'), updatedProject),
  ]);
  const result = {
    ok: evaluation.status !== 'fail',
    projectId: updatedProject.id,
    status: evaluation.status,
    score: evaluation.score,
    output: outputPath,
    syncDriftMsPerMinute: evaluation.summary.syncDriftMsPerMinute,
    durationErrorSeconds: evaluation.summary.durationErrorSeconds,
    boundarySilenceHitCount: evaluation.summary.boundarySilenceHitCount,
  };
  if (options['dashboard-url']) {
    result.publish = await publishProject(options['dashboard-url'], updatedProject.id, {
      project: updatedProject,
      analysis,
      editorialIr,
      qc,
      transcript,
      artifacts,
      evaluation,
    });
  }
  return result;
}

async function main() {
  process.stdout.write(`${JSON.stringify(await evaluateRealFootage(parseArgs(process.argv.slice(2))), null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}

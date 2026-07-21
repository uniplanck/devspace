#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MULTICAM_POLICY,
  buildMulticamEditorialIr,
  buildMulticamQc,
  estimateAudioOffset,
  normalizeCameraPlan,
} from './multicam-core.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const DEFAULT_FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
    if (token === '--dry-run') {
      options['dry-run'] = true;
      continue;
    }
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

function safeProjectId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(id)) throw new Error(`Invalid project id: ${id}`);
  return id;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

async function runBuffer(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 120_000);
  const maxBytes = Number(options.maxBytes || 8 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        reject(new Error(`${path.basename(command)} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        child.kill('SIGKILL');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`${path.basename(command)} output exceeded ${maxBytes} bytes`));
        }
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 1_000_000) stderr.push(chunk);
    });
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
        reject(new Error(`${path.basename(command)} exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 1000)}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

async function probeMedia(file, ffprobePath) {
  const output = await runBuffer(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration,size,format_name:stream=codec_type,width,height,r_frame_rate,sample_rate,channels,codec_name',
    '-of', 'json',
    file,
  ], { timeoutMs: 30_000, maxBytes: 2_000_000 });
  const parsed = JSON.parse(output.toString('utf8'));
  const video = (parsed.streams || []).find((stream) => stream.codec_type === 'video');
  const audio = (parsed.streams || []).find((stream) => stream.codec_type === 'audio');
  const durationSeconds = Number(parsed.format?.duration || 0);
  if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`Invalid media: ${file}`);
  const frameRateText = String(video.r_frame_rate || '30/1');
  const [numerator, denominator] = frameRateText.split('/').map(Number);
  const frameRate = denominator ? numerator / denominator : numerator;
  return {
    path: file,
    filename: path.basename(file),
    durationSeconds: round(durationSeconds),
    sizeBytes: Number(parsed.format?.size || 0),
    format: String(parsed.format?.format_name || ''),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    frameRate: Number.isFinite(frameRate) && frameRate > 0 ? round(frameRate) : 30,
    videoCodec: String(video.codec_name || ''),
    hasAudio: Boolean(audio),
    audioCodec: String(audio?.codec_name || ''),
    audioSampleRate: Number(audio?.sample_rate || 0),
    audioChannels: Number(audio?.channels || 0),
  };
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

async function extractAudioEnvelope(file, options) {
  const sampleRate = Number(options.sampleRate || 8000);
  const envelopeFrameRate = Number(options.envelopeFrameRate || 50);
  const windowSeconds = Number(options.windowSeconds || 120);
  const maxBytes = Math.ceil(sampleRate * 2 * windowSeconds + 1_000_000);
  const buffer = await runBuffer(options.ffmpegPath || DEFAULT_FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-i', file,
    '-vn', '-ac', '1', '-ar', String(sampleRate),
    '-t', String(windowSeconds),
    '-f', 's16le', 'pipe:1',
  ], { timeoutMs: 180_000, maxBytes });
  return {
    frameRate: envelopeFrameRate,
    windowSeconds: round(buffer.length / 2 / sampleRate),
    values: pcmEnvelope(buffer, sampleRate, envelopeFrameRate),
  };
}

function resolveManifestPath(value, manifestDir) {
  const text = String(value || '').trim();
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.resolve(manifestDir, text);
}

async function loadReferenceProject(directory) {
  const names = ['project.json', 'analysis.json', 'transcript.json', 'editorial-ir.json', 'qc-report.json'];
  const values = await Promise.all(names.map((name) => readJson(path.join(directory, name))));
  const artifacts = await readJson(path.join(directory, 'artifacts.json')).catch(() => ({ version: 1, artifacts: [] }));
  return {
    project: values[0],
    analysis: values[1],
    transcript: values[2],
    editorialIr: values[3],
    qc: values[4],
    artifacts,
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectId = safeProjectId(required(options, 'project'));
  const manifestPath = path.resolve(required(options, 'manifest'));
  const referenceProjectDir = path.resolve(required(options, 'reference-project-dir'));
  const outputDir = path.resolve(String(options['output-dir'] || path.join(ROOT, 'data', 'projects', projectId)));
  const manifest = await readJson(manifestPath);
  const manifestDir = path.dirname(manifestPath);
  const reference = await loadReferenceProject(referenceProjectDir);
  const referenceAssetId = String(manifest.referenceAssetId || reference.project.sourceAssetId || '').trim();
  if (!referenceAssetId) throw new Error('manifest.referenceAssetId is required');
  if (!Array.isArray(manifest.assets) || manifest.assets.length < 2) throw new Error('manifest.assets requires at least two assets');
  const ids = new Set();
  const configuredAssets = manifest.assets.map((entry, index) => {
    const id = String(entry?.id || '').trim();
    const mediaPath = resolveManifestPath(entry?.path, manifestDir);
    if (!id || ids.has(id)) throw new Error(`Invalid or duplicate asset id at index ${index}`);
    if (!mediaPath) throw new Error(`Asset ${id} requires path`);
    ids.add(id);
    return { ...entry, id, path: mediaPath };
  });
  if (!ids.has(referenceAssetId)) throw new Error(`Reference asset not found: ${referenceAssetId}`);

  const ffprobePath = String(options.ffprobe || manifest.ffprobePath || DEFAULT_FFPROBE);
  const ffmpegPath = String(options.ffmpeg || manifest.ffmpegPath || DEFAULT_FFMPEG);
  const probedAssets = await Promise.all(configuredAssets.map(async (entry) => ({
    ...entry,
    ...(await probeMedia(entry.path, ffprobePath)),
  })));
  const referenceAsset = probedAssets.find((asset) => asset.id === referenceAssetId);
  const syncPolicy = {
    ...DEFAULT_MULTICAM_POLICY,
    ...(manifest.sync || {}),
    ...(options['max-offset'] ? { maximumOffsetSeconds: Number(options['max-offset']) } : {}),
    ...(options['minimum-confidence'] ? { minimumSyncConfidence: Number(options['minimum-confidence']) } : {}),
  };
  const envelopeOptions = {
    ffmpegPath,
    sampleRate: Number(manifest.sync?.sampleRate || 8000),
    envelopeFrameRate: Number(manifest.sync?.envelopeFrameRate || 50),
    windowSeconds: Number(manifest.sync?.windowSeconds || 120),
  };
  const referenceEnvelope = referenceAsset.hasAudio
    ? await extractAudioEnvelope(referenceAsset.path, envelopeOptions)
    : null;
  const synchronization = {
    [referenceAssetId]: {
      method: 'reference',
      status: 'synced',
      sourceOffsetSeconds: 0,
      correlationScore: 1,
      confidence: 1,
      reason: 'reference_asset',
    },
  };
  for (const asset of probedAssets) {
    if (asset.id === referenceAssetId) continue;
    if (Number.isFinite(Number(asset.manualOffsetSeconds))) {
      synchronization[asset.id] = {
        method: 'manual',
        status: 'synced',
        sourceOffsetSeconds: round(Number(asset.manualOffsetSeconds)),
        correlationScore: null,
        confidence: 1,
        reason: 'manifest_manual_offset',
      };
      continue;
    }
    if (!referenceEnvelope || !asset.hasAudio) {
      synchronization[asset.id] = {
        method: 'audio_correlation',
        status: 'unavailable',
        sourceOffsetSeconds: 0,
        correlationScore: 0,
        confidence: 0,
        reason: 'audio_stream_unavailable',
      };
      continue;
    }
    const candidateEnvelope = await extractAudioEnvelope(asset.path, envelopeOptions);
    synchronization[asset.id] = estimateAudioOffset(
      referenceEnvelope.values,
      candidateEnvelope.values,
      referenceEnvelope.frameRate,
      syncPolicy,
    );
  }

  const cameraPlan = normalizeCameraPlan(
    manifest.cameraPlan,
    reference.editorialIr.timeline.durationSeconds,
    referenceAssetId,
  );
  const audioStrategy = String(options['audio-strategy'] || manifest.audioStrategy || manifest.audio?.strategy || 'selected_asset');
  const masterAudioAssetId = String(options['master-audio-asset'] || manifest.masterAudioAssetId || manifest.audio?.assetId || referenceAssetId);
  const generatedAt = new Date().toISOString();
  const built = buildMulticamEditorialIr({
    projectId,
    referenceEditorialIr: reference.editorialIr,
    referenceAssetId,
    assets: probedAssets,
    synchronization,
    cameraPlan,
    audioStrategy,
    masterAudioAssetId,
    policy: syncPolicy,
    generatedAt,
  });
  const qc = buildMulticamQc({
    editorialIr: built.editorialIr,
    assets: probedAssets,
    synchronization,
    warnings: built.warnings,
    minimumSyncConfidence: syncPolicy.minimumSyncConfidence,
  });
  const analysis = {
    version: 'multicam-analysis.v1',
    generatedAt,
    referenceProjectId: reference.project.id,
    referenceAssetId,
    assets: probedAssets,
    synchronization,
    cameraPlan,
    audio: {
      strategy: built.editorialIr.multicam.audioStrategy,
      masterAudioAssetId: built.editorialIr.multicam.masterAudioAssetId,
    },
    sourceAnalysis: reference.analysis,
    policy: syncPolicy,
  };
  const sourceMediaPaths = Object.fromEntries(probedAssets.map((asset) => [asset.id, asset.path]));
  const project = {
    id: projectId,
    title: String(options.title || manifest.title || `マルチカム ${reference.project.title || projectId}`),
    description: String(options.description || manifest.description || '音声同期済み複数素材からEditorial IRを生成'),
    status: qc.status === 'fail' ? 'multicam_failed' : qc.status === 'review' ? 'multicam_review' : 'multicam_ready',
    durationSeconds: Math.max(...probedAssets.map((asset) => asset.durationSeconds)),
    outputDurationSeconds: built.editorialIr.timeline.durationSeconds,
    adapterStatus: 'multicam_ir_ready',
    sourceAssetId: referenceAssetId,
    sourceMediaPath: referenceAsset.path,
    sourceMediaPaths,
    updatedAt: generatedAt,
  };
  const bundle = {
    project,
    analysis,
    transcript: reference.transcript,
    editorialIr: built.editorialIr,
    qc,
    artifacts: reference.artifacts,
  };
  const result = {
    ok: qc.status !== 'fail',
    projectId,
    outputDir,
    referenceAssetId,
    assetCount: probedAssets.length,
    selectedAssetCount: new Set(built.editorialIr.timeline.operations.filter((operation) => operation.type === 'select_range').map((operation) => operation.assetId)).size,
    sync: Object.fromEntries(Object.entries(synchronization).map(([assetId, row]) => [assetId, {
      status: row.status,
      method: row.method,
      sourceOffsetSeconds: row.sourceOffsetSeconds,
      correlationScore: row.correlationScore,
      confidence: row.confidence,
    }])),
    qcStatus: qc.status,
    fallbackCount: built.warnings.length,
    audioStrategy: built.editorialIr.multicam.audioStrategy,
    masterAudioAssetId: built.editorialIr.multicam.masterAudioAssetId,
    files: ['project.json', 'analysis.json', 'transcript.json', 'editorial-ir.json', 'qc-report.json', 'asset-manifest.json'],
  };

  if (!options['dry-run']) {
    await Promise.all([
      writeJsonAtomic(path.join(outputDir, 'project.json'), project),
      writeJsonAtomic(path.join(outputDir, 'analysis.json'), analysis),
      writeJsonAtomic(path.join(outputDir, 'transcript.json'), reference.transcript),
      writeJsonAtomic(path.join(outputDir, 'editorial-ir.json'), built.editorialIr),
      writeJsonAtomic(path.join(outputDir, 'qc-report.json'), qc),
      writeJsonAtomic(path.join(outputDir, 'artifacts.json'), reference.artifacts),
      writeJsonAtomic(path.join(outputDir, 'asset-manifest.json'), manifest),
    ]);
    if (options['dashboard-url']) result.publish = await publishProject(options['dashboard-url'], projectId, bundle);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});

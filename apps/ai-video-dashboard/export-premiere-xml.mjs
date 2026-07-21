import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildRenderPlan } from './render-preview.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FFPROBE = process.env.FFPROBE_PATH || '/usr/local/bin/ffprobe';

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('Usage: node export-premiere-xml.mjs --project <project.json> --ir <editorial-ir.json> --asset-bindings <json> --output <sequence.xml> [--captions <captions.srt>] [--ffprobe <path>]\n');
  process.exit(2);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--self-test') {
      values['self-test'] = true;
      continue;
    }
    if (!arg.startsWith('--')) usage(`Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for ${arg}`);
    values[arg.slice(2)] = value;
    index += 1;
  }
  return values;
}

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function safeId(value, fallback) {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return normalized || fallback;
}

function roundFrame(seconds, fps) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid non-negative time: ${seconds}`);
  return Math.round(value * fps);
}

function rateDescriptor(fpsInput) {
  const fps = Number(fpsInput);
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`Invalid frame rate: ${fpsInput}`);
  const candidates = [
    { fps: 23.976, timebase: 24, ntsc: true },
    { fps: 29.97, timebase: 30, ntsc: true },
    { fps: 59.94, timebase: 60, ntsc: true },
  ];
  const match = candidates.find((candidate) => Math.abs(candidate.fps - fps) < 0.02);
  if (match) return match;
  const timebase = Math.round(fps);
  if (Math.abs(timebase - fps) > 0.02) throw new Error(`Unsupported non-integer frame rate: ${fps}`);
  return { fps, timebase, ntsc: false };
}

function rateXml(rate, indent = '      ') {
  return [
    `${indent}<rate>`,
    `${indent}  <timebase>${rate.timebase}</timebase>`,
    `${indent}  <ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc>`,
    `${indent}</rate>`,
  ].join('\n');
}

function timecodeXml(rate, indent = '    ') {
  return [
    `${indent}<timecode>`,
    rateXml(rate, `${indent}  `),
    `${indent}  <string>00:00:00:00</string>`,
    `${indent}  <frame>0</frame>`,
    `${indent}  <displayformat>NDF</displayformat>`,
    `${indent}</timecode>`,
  ].join('\n');
}

function normalizeBinding(value, assetId) {
  const binding = typeof value === 'string' ? { path: value } : value;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error(`Missing asset binding for ${assetId}`);
  const mediaPath = String(binding.path || '').trim();
  if (!path.isAbsolute(mediaPath)) throw new Error(`Premiere XML requires an absolute local path for ${assetId}`);
  return { ...binding, path: mediaPath };
}

async function probeMedia(mediaPath, ffprobePath) {
  await fs.access(mediaPath);
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate,sample_rate,channels',
    '-of', 'json',
    mediaPath,
  ], { timeout: 30_000, maxBuffer: 2_000_000 });
  const parsed = JSON.parse(stdout);
  const video = (parsed.streams || []).find((stream) => stream.codec_type === 'video');
  const audio = (parsed.streams || []).find((stream) => stream.codec_type === 'audio');
  const durationSeconds = Number(parsed.format?.duration || 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`Invalid media duration: ${mediaPath}`);
  return {
    path: mediaPath,
    name: path.basename(mediaPath),
    durationSeconds,
    width: Number(video?.width || 1920),
    height: Number(video?.height || 1080),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    sampleRate: Number(audio?.sample_rate || 48000),
    channels: Number(audio?.channels || 2),
  };
}

function buildFramePlan(editorialIr) {
  const renderPlan = buildRenderPlan(editorialIr);
  const rate = rateDescriptor(renderPlan.frameRate);
  const totalFrames = roundFrame(renderPlan.durationSeconds, renderPlan.frameRate);
  const starts = renderPlan.selects.map((select) => roundFrame(select.timelineIn, renderPlan.frameRate));
  const clips = renderPlan.selects.map((select, index) => {
    const startFrame = starts[index];
    const endFrame = index + 1 < starts.length ? starts[index + 1] : totalFrames;
    const durationFrames = endFrame - startFrame;
    if (durationFrames <= 0) throw new Error(`Empty timeline range for ${select.id}`);
    return {
      ...select,
      startFrame,
      endFrame,
      durationFrames,
      sourceInFrame: roundFrame(select.sourceIn, renderPlan.frameRate),
      audioSourceInFrame: roundFrame(select.audioSourceIn, renderPlan.frameRate),
    };
  });
  const captions = renderPlan.captions.map((caption) => ({
    ...caption,
    startFrame: roundFrame(caption.start, renderPlan.frameRate),
    endFrame: Math.max(roundFrame(caption.start, renderPlan.frameRate) + 1, roundFrame(caption.end, renderPlan.frameRate)),
  }));
  return { ...renderPlan, rate, totalFrames, clips, captions };
}

function validateAssets(plan, assets) {
  for (const clip of plan.clips) {
    const video = assets[clip.assetId];
    const audio = assets[clip.audioAssetId];
    if (!video?.hasVideo) throw new Error(`Video stream unavailable for ${clip.assetId}`);
    if (!audio?.hasAudio) throw new Error(`Audio stream unavailable for ${clip.audioAssetId}`);
    const videoOut = clip.sourceInFrame + clip.durationFrames;
    const audioOut = clip.audioSourceInFrame + clip.durationFrames;
    const videoDurationFrames = roundFrame(video.durationSeconds, plan.frameRate);
    const audioDurationFrames = roundFrame(audio.durationSeconds, plan.frameRate);
    if (videoOut > videoDurationFrames + 1) throw new Error(`Video range exceeds ${clip.assetId} duration`);
    if (audioOut > audioDurationFrames + 1) throw new Error(`Audio range exceeds ${clip.audioAssetId} duration`);
  }
}

function fileMediaXml(asset, rate, indent) {
  const rows = [`${indent}<media>`];
  if (asset.hasVideo) {
    rows.push(
      `${indent}  <video>`,
      `${indent}    <samplecharacteristics>`,
      rateXml(rate, `${indent}      `),
      `${indent}      <width>${asset.width}</width>`,
      `${indent}      <height>${asset.height}</height>`,
      `${indent}      <anamorphic>FALSE</anamorphic>`,
      `${indent}      <pixelaspectratio>square</pixelaspectratio>`,
      `${indent}      <fielddominance>none</fielddominance>`,
      `${indent}    </samplecharacteristics>`,
      `${indent}  </video>`,
    );
  }
  if (asset.hasAudio) {
    rows.push(
      `${indent}  <audio>`,
      `${indent}    <samplecharacteristics>`,
      `${indent}      <depth>16</depth>`,
      `${indent}      <samplerate>${asset.sampleRate}</samplerate>`,
      `${indent}    </samplecharacteristics>`,
      `${indent}    <channelcount>${Math.max(1, asset.channels)}</channelcount>`,
      `${indent}  </audio>`,
    );
  }
  rows.push(`${indent}</media>`);
  return rows.join('\n');
}

function fullFileXml(assetId, asset, rate, fileId, indent) {
  const durationFrames = roundFrame(asset.durationSeconds, rate.fps);
  return [
    `${indent}<file id="${xml(fileId)}">`,
    `${indent}  <name>${xml(asset.name)}</name>`,
    `${indent}  <pathurl>${xml(pathToFileURL(asset.path).href)}</pathurl>`,
    `${indent}  <duration>${durationFrames}</duration>`,
    rateXml(rate, `${indent}  `),
    timecodeXml(rate, `${indent}  `),
    fileMediaXml(asset, rate, `${indent}  `),
    `${indent}</file>`,
  ].join('\n');
}

function clipItemXml({ clip, index, kind, assetId, sourceInFrame, plan, assets, fileIds, emittedFiles }) {
  const asset = assets[assetId];
  const clipId = `${kind}-clip-${index + 1}`;
  const fileId = fileIds[assetId];
  const fileXml = emittedFiles.has(assetId)
    ? `          <file id="${xml(fileId)}"/>`
    : fullFileXml(assetId, asset, plan.rate, fileId, '          ');
  emittedFiles.add(assetId);
  return [
    `        <clipitem id="${xml(clipId)}">`,
    `          <name>${xml(asset.name)}</name>`,
    `          <enabled>TRUE</enabled>`,
    `          <duration>${clip.durationFrames}</duration>`,
    rateXml(plan.rate, '          '),
    `          <start>${clip.startFrame}</start>`,
    `          <end>${clip.endFrame}</end>`,
    `          <in>${sourceInFrame}</in>`,
    `          <out>${sourceInFrame + clip.durationFrames}</out>`,
    fileXml,
    `          <sourcetrack>`,
    `            <mediatype>${kind}</mediatype>`,
    `            <trackindex>1</trackindex>`,
    `          </sourcetrack>`,
    `        </clipitem>`,
  ].join('\n');
}

function markerXml(caption) {
  const label = caption.text.length > 40 ? `${caption.text.slice(0, 37)}...` : caption.text;
  return [
    `    <marker>`,
    `      <name>${xml(`Caption: ${label}`)}</name>`,
    `      <comment>${xml(caption.text)}</comment>`,
    `      <in>${caption.startFrame}</in>`,
    `      <out>${caption.endFrame}</out>`,
    `    </marker>`,
  ].join('\n');
}

function sequenceFormatXml(plan, primaryAsset) {
  return [
    `      <format>`,
    `        <samplecharacteristics>`,
    rateXml(plan.rate, '          '),
    `          <width>${primaryAsset.width}</width>`,
    `          <height>${primaryAsset.height}</height>`,
    `          <anamorphic>FALSE</anamorphic>`,
    `          <pixelaspectratio>square</pixelaspectratio>`,
    `          <fielddominance>none</fielddominance>`,
    `        </samplecharacteristics>`,
    `      </format>`,
  ].join('\n');
}

function audioFormatXml(primaryAudioAsset) {
  return [
    `      <format>`,
    `        <samplecharacteristics>`,
    `          <depth>16</depth>`,
    `          <samplerate>${primaryAudioAsset.sampleRate}</samplerate>`,
    `        </samplecharacteristics>`,
    `      </format>`,
    `      <outputs>`,
    `        <group>`,
    `          <index>1</index>`,
    `          <numchannels>${Math.min(2, Math.max(1, primaryAudioAsset.channels))}</numchannels>`,
    `          <downmix>0</downmix>`,
    `          <channel><index>1</index></channel>`,
    ...(primaryAudioAsset.channels > 1 ? [`          <channel><index>2</index></channel>`] : []),
    `        </group>`,
    `      </outputs>`,
  ].join('\n');
}

export function buildPremiereXmlDocument({ projectName, editorialIr, assets }) {
  const plan = buildFramePlan(editorialIr);
  validateAssets(plan, assets);
  const requiredAssetIds = [...new Set(plan.clips.flatMap((clip) => [clip.assetId, clip.audioAssetId]))];
  const fileIds = Object.fromEntries(requiredAssetIds.map((assetId, index) => [assetId, `file-${index + 1}-${safeId(assetId, `asset-${index + 1}`)}`]));
  const emittedFiles = new Set();
  const primaryVideoAsset = assets[plan.clips[0].assetId];
  const primaryAudioAsset = assets[plan.clips[0].audioAssetId];
  const videoItems = plan.clips.map((clip, index) => clipItemXml({
    clip,
    index,
    kind: 'video',
    assetId: clip.assetId,
    sourceInFrame: clip.sourceInFrame,
    plan,
    assets,
    fileIds,
    emittedFiles,
  }));
  const audioItems = plan.clips.map((clip, index) => clipItemXml({
    clip,
    index,
    kind: 'audio',
    assetId: clip.audioAssetId,
    sourceInFrame: clip.audioSourceInFrame,
    plan,
    assets,
    fileIds,
    emittedFiles,
  }));
  const markers = plan.captions.map(markerXml);
  const sequenceName = String(projectName || editorialIr?.projectId || 'AI Video Sequence');
  const document = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE xmeml>`,
    `<xmeml version="5">`,
    `  <sequence id="sequence-1">`,
    `    <name>${xml(sequenceName)}</name>`,
    `    <duration>${plan.totalFrames}</duration>`,
    rateXml(plan.rate, '    '),
    timecodeXml(plan.rate, '    '),
    ...markers,
    `    <media>`,
    `      <video>`,
    sequenceFormatXml(plan, primaryVideoAsset),
    `        <track>`,
    ...videoItems,
    `          <enabled>TRUE</enabled>`,
    `          <locked>FALSE</locked>`,
    `        </track>`,
    `      </video>`,
    `      <audio>`,
    audioFormatXml(primaryAudioAsset),
    `        <track>`,
    ...audioItems,
    `          <enabled>TRUE</enabled>`,
    `          <locked>FALSE</locked>`,
    `        </track>`,
    `      </audio>`,
    `    </media>`,
    `  </sequence>`,
    `</xmeml>`,
    ``,
  ].join('\n');
  return {
    document,
    plan,
    summary: {
      sequenceName,
      frameRate: plan.frameRate,
      totalFrames: plan.totalFrames,
      durationSeconds: plan.durationSeconds,
      videoClipCount: videoItems.length,
      audioClipCount: audioItems.length,
      captionMarkerCount: markers.length,
      assetIds: requiredAssetIds,
      audioStrategy: plan.audioStrategy,
    },
  };
}

function srtTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const ms = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function buildSrt(editorialIr) {
  const plan = buildFramePlan(editorialIr);
  return plan.captions.map((caption, index) => [
    String(index + 1),
    `${srtTimestamp(caption.startFrame / plan.frameRate)} --> ${srtTimestamp(caption.endFrame / plan.frameRate)}`,
    caption.text,
    '',
  ].join('\n')).join('\n');
}

export async function exportPremiereXml({ project, editorialIr, assetBindings, output, captionsOutput, ffprobePath = DEFAULT_FFPROBE }) {
  const plan = buildFramePlan(editorialIr);
  const assetIds = [...new Set(plan.clips.flatMap((clip) => [clip.assetId, clip.audioAssetId]))];
  const assets = {};
  for (const assetId of assetIds) {
    const binding = normalizeBinding(assetBindings?.[assetId], assetId);
    assets[assetId] = { ...await probeMedia(binding.path, ffprobePath), assetId };
  }
  const built = buildPremiereXmlDocument({
    projectName: project?.title || project?.id || editorialIr?.projectId,
    editorialIr,
    assets,
  });
  const outputPath = path.resolve(output);
  const srtPath = path.resolve(captionsOutput || outputPath.replace(/\.xml$/iu, '') + '.srt');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, built.document, 'utf8');
  const srt = buildSrt(editorialIr);
  await fs.writeFile(srtPath, srt, 'utf8');
  return {
    ok: true,
    output: outputPath,
    captionsOutput: srtPath,
    ...built.summary,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) {
    const editorialIr = {
      projectId: 'self-test',
      timeline: {
        frameRate: 30,
        operations: [
          { id: 'a', type: 'select_range', assetId: 'cam-a', sourceIn: 0, sourceOut: 2, timelineIn: 0, audioAssetId: 'cam-a', audioSourceIn: 0, audioSourceOut: 2 },
          { id: 'b', type: 'select_range', assetId: 'cam-b', sourceIn: 4, sourceOut: 6, timelineIn: 2, audioAssetId: 'cam-a', audioSourceIn: 2, audioSourceOut: 4 },
          { id: 'c', type: 'caption', timelineIn: 0.5, timelineOut: 1.5, text: 'test' },
        ],
      },
      multicam: { audioStrategy: 'master_audio', masterAudioAssetId: 'cam-a' },
    };
    const asset = { path: '/tmp/example.mp4', name: 'example.mp4', durationSeconds: 10, width: 1920, height: 1080, hasVideo: true, hasAudio: true, sampleRate: 48000, channels: 2 };
    const built = buildPremiereXmlDocument({ projectName: 'Self Test', editorialIr, assets: { 'cam-a': asset, 'cam-b': { ...asset, path: '/tmp/example-b.mp4', name: 'example-b.mp4' } } });
    if (!built.document.includes('<xmeml version="5">') || built.summary.videoClipCount !== 2 || built.summary.audioClipCount !== 2) throw new Error('Premiere XML self-test failed');
    process.stdout.write(`${JSON.stringify({ ok: true, test: 'premiere-xml-adapter' })}\n`);
    return;
  }
  for (const key of ['project', 'ir', 'asset-bindings', 'output']) if (!args[key]) usage(`Missing --${key}`);
  const [project, editorialIr, assetBindings] = await Promise.all([
    fs.readFile(path.resolve(args.project), 'utf8').then(JSON.parse),
    fs.readFile(path.resolve(args.ir), 'utf8').then(JSON.parse),
    fs.readFile(path.resolve(args['asset-bindings']), 'utf8').then(JSON.parse),
  ]);
  const result = await exportPremiereXml({
    project,
    editorialIr,
    assetBindings,
    output: args.output,
    captionsOutput: args.captions,
    ffprobePath: args.ffprobe || DEFAULT_FFPROBE,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}

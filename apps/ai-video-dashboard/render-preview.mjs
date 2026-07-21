import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_FFMPEG = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';
const DEFAULT_FFPROBE = process.env.FFPROBE_PATH || '/usr/local/bin/ffprobe';
const FONT_CANDIDATES = [
  '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc',
  '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
  '/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
];

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('Usage: node render-preview.mjs (--media <video> | --asset-bindings <json>) --ir <editorial-ir.json> --output <preview.mp4> [--font <fontfile>] [--crf 18]\n');
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

function finiteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeSelects(operations) {
  const selects = operations
    .filter((operation) => operation?.type === 'select_range' && operation.enabled !== false)
    .map((operation, index) => {
      const sourceIn = finiteNumber(operation.sourceIn, `select_range ${operation.id || index} sourceIn`);
      const sourceOut = finiteNumber(operation.sourceOut, `select_range ${operation.id || index} sourceOut`);
      const timelineIn = finiteNumber(operation.timelineIn ?? 0, `select_range ${operation.id || index} timelineIn`);
      if (sourceIn < 0 || sourceOut <= sourceIn || timelineIn < 0) throw new Error(`Invalid select_range ${operation.id || index}`);
      const assetId = String(operation.assetId || 'default');
      const audioAssetId = String(operation.audioAssetId || assetId);
      const audioSourceIn = finiteNumber(operation.audioSourceIn ?? sourceIn, `select_range ${operation.id || index} audioSourceIn`);
      const audioSourceOut = finiteNumber(operation.audioSourceOut ?? sourceOut, `select_range ${operation.id || index} audioSourceOut`);
      if (audioSourceIn < 0 || audioSourceOut <= audioSourceIn) throw new Error(`Invalid audio range for select_range ${operation.id || index}`);
      if (Math.abs((audioSourceOut - audioSourceIn) - (sourceOut - sourceIn)) > 0.05) {
        throw new Error(`Audio/video duration mismatch for select_range ${operation.id || index}`);
      }
      return {
        id: operation.id || `select-${index + 1}`,
        assetId,
        sourceIn,
        sourceOut,
        timelineIn,
        audioAssetId,
        audioSourceIn,
        audioSourceOut,
      };
    })
    .sort((left, right) => left.timelineIn - right.timelineIn || left.sourceIn - right.sourceIn);
  if (!selects.length) throw new Error('Editorial IR has no enabled select_range operations');
  let expectedTimeline = 0;
  for (const select of selects) {
    if (Math.abs(select.timelineIn - expectedTimeline) > 0.05) {
      throw new Error(`select_range ${select.id} is not contiguous at timeline ${select.timelineIn}`);
    }
    expectedTimeline += select.sourceOut - select.sourceIn;
  }
  return selects;
}

function normalizeCaptions(operations, durationSeconds) {
  return operations
    .filter((operation) => operation?.type === 'caption' && operation.enabled !== false)
    .map((operation, index) => {
      const start = finiteNumber(operation.timelineIn, `caption ${operation.id || index} timelineIn`);
      const end = finiteNumber(operation.timelineOut, `caption ${operation.id || index} timelineOut`);
      const text = String(operation.text || '').trim();
      if (!text || start < 0 || end <= start) throw new Error(`Invalid caption ${operation.id || index}`);
      return {
        id: operation.id || `caption-${index + 1}`,
        start: Math.min(durationSeconds, start),
        end: Math.min(durationSeconds, end),
        text,
        role: String(operation.role || 'speech'),
      };
    })
    .filter((caption) => caption.end > caption.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

export function buildRenderPlan(editorialIr) {
  const operations = editorialIr?.timeline?.operations;
  if (!Array.isArray(operations)) throw new Error('Editorial IR timeline.operations is required');
  const selects = normalizeSelects(operations);
  const durationSeconds = round(selects.reduce((sum, select) => sum + select.sourceOut - select.sourceIn, 0));
  const captions = normalizeCaptions(operations, durationSeconds);
  return {
    frameRate: finiteNumber(editorialIr?.timeline?.frameRate || 30, 'timeline frameRate'),
    durationSeconds,
    selects,
    captions,
    audioStrategy: String(editorialIr?.multicam?.audioStrategy || 'selected_asset'),
    masterAudioAssetId: editorialIr?.multicam?.masterAudioAssetId
      ? String(editorialIr.multicam.masterAudioAssetId)
      : undefined,
  };
}

async function fileExists(file) {
  return fs.access(file).then(() => true).catch(() => false);
}

async function chooseFont(explicit) {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!await fileExists(resolved)) throw new Error(`Font file not found: ${resolved}`);
    return resolved;
  }
  for (const candidate of FONT_CANDIDATES) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error('No Japanese-capable preview font found. Pass --font <fontfile>.');
}

function normalizeAssetBindingValue(value) {
  if (typeof value === 'string') return { path: value };
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

async function resolveAssetPaths(options, plan) {
  let bindings = options.assetBindings && typeof options.assetBindings === 'object' && !Array.isArray(options.assetBindings)
    ? options.assetBindings
    : {};
  if (options['asset-bindings']) {
    const file = path.resolve(String(options['asset-bindings']));
    if (!await fileExists(file)) throw new Error(`Asset bindings file not found: ${file}`);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Asset bindings JSON must be an object');
    bindings = parsed;
  }
  const assetIds = [...new Set(plan.selects.flatMap((select) => [select.assetId, select.audioAssetId]))];
  const result = new Map();
  for (const assetId of assetIds) {
    const binding = normalizeAssetBindingValue(bindings[assetId]);
    const candidate = binding.path || (assetIds.length === 1 ? options.media : undefined);
    if (!candidate) throw new Error(`Media binding is missing for asset ${assetId}`);
    const resolved = path.resolve(String(candidate));
    if (!await fileExists(resolved)) throw new Error(`Media file not found for ${assetId}: ${resolved}`);
    result.set(assetId, resolved);
  }
  return result;
}

async function probeMedia(mediaPath, ffprobePath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'stream=index,codec_type,width,height:format=duration',
    '-of', 'json',
    mediaPath,
  ], { timeout: 30_000, maxBuffer: 2_000_000 });
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find((stream) => stream.codec_type === 'video');
  const audio = (data.streams || []).find((stream) => stream.codec_type === 'audio');
  const durationSeconds = Number(data.format?.duration || 0);
  if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Input video stream or duration is unavailable');
  return {
    durationSeconds,
    width: Number(video.width || 1280),
    height: Number(video.height || 720),
    hasAudio: Boolean(audio),
  };
}

function escapeFilterPath(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'");
}

async function buildFilterScript({ plan, mediaByAsset, inputIndexByAsset, outputMedia, fontFile, tempDir }) {
  const lines = [];
  const concatInputs = [];
  const hasAudio = plan.selects.some((select) => mediaByAsset.get(select.audioAssetId)?.hasAudio);
  for (const [index, select] of plan.selects.entries()) {
    const inputIndex = inputIndexByAsset.get(select.assetId);
    const audioInputIndex = inputIndexByAsset.get(select.audioAssetId);
    const media = mediaByAsset.get(select.audioAssetId);
    const duration = round(select.sourceOut - select.sourceIn, 6);
    lines.push(
      `[${inputIndex}:v]trim=start=${select.sourceIn}:end=${select.sourceOut},setpts=PTS-STARTPTS,`
      + `scale=${outputMedia.width}:${outputMedia.height}:force_original_aspect_ratio=decrease,`
      + `pad=${outputMedia.width}:${outputMedia.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,`
      + `fps=${plan.frameRate},format=yuv420p[v${index}]`,
    );
    concatInputs.push(`[v${index}]`);
    if (hasAudio) {
      if (media?.hasAudio) {
        lines.push(
          `[${audioInputIndex}:a]atrim=start=${select.audioSourceIn}:end=${select.audioSourceOut},asetpts=PTS-STARTPTS,`
          + 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'
          + `[a${index}]`,
        );
      } else {
        lines.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`);
      }
      concatInputs.push(`[a${index}]`);
    }
  }
  if (hasAudio) {
    lines.push(`${concatInputs.join('')}concat=n=${plan.selects.length}:v=1:a=1[vcat][acat]`);
  } else {
    lines.push(`${concatInputs.join('')}concat=n=${plan.selects.length}:v=1:a=0[vcat]`);
  }

  let previous = 'vcat';
  const fontSize = Math.max(32, Math.min(72, Math.round(outputMedia.height / 16)));
  const boxBorder = Math.max(12, Math.round(fontSize * 0.3));
  for (const [index, caption] of plan.captions.entries()) {
    const textFile = path.join(tempDir, `caption-${String(index + 1).padStart(3, '0')}.txt`);
    await fs.writeFile(textFile, `${caption.text}\n`, 'utf8');
    const next = `vcap${index}`;
    const roleScale = caption.role === 'emphasis' ? 1.15 : 1;
    const size = Math.round(fontSize * roleScale);
    lines.push(
      `[${previous}]drawtext=`
      + `fontfile='${escapeFilterPath(fontFile)}':`
      + `textfile='${escapeFilterPath(textFile)}':`
      + `expansion=none:reload=0:fontcolor=white:fontsize=${size}:`
      + `box=1:boxcolor=black@0.62:boxborderw=${boxBorder}:`
      + `x=(w-text_w)/2:y=h-text_h-${Math.max(42, Math.round(outputMedia.height * 0.07))}:`
      + `enable='between(t,${caption.start},${caption.end})'[${next}]`,
    );
    previous = next;
  }
  if (previous === 'vcat') lines.push('[vcat]null[vout]');
  else lines.push(`[${previous}]null[vout]`);
  return { script: `${lines.join(';\n')}\n`, hasAudio };
}

export async function renderPreview(options) {
  const irPath = path.resolve(options.ir);
  const outputPath = path.resolve(options.output);
  if (!await fileExists(irPath)) throw new Error(`Editorial IR file not found: ${irPath}`);
  const [editorialIr, fontFile] = await Promise.all([
    fs.readFile(irPath, 'utf8').then(JSON.parse),
    chooseFont(options.font),
  ]);
  const plan = buildRenderPlan(editorialIr);
  const assetPaths = await resolveAssetPaths(options, plan);
  const assetIds = [...assetPaths.keys()];
  const mediaRows = await Promise.all(assetIds.map(async (assetId, index) => ({
    assetId,
    inputIndex: index,
    path: assetPaths.get(assetId),
    media: await probeMedia(assetPaths.get(assetId), options.ffprobe || DEFAULT_FFPROBE),
  })));
  const mediaByAsset = new Map(mediaRows.map((row) => [row.assetId, row.media]));
  const inputIndexByAsset = new Map(mediaRows.map((row) => [row.assetId, row.inputIndex]));
  const outputMedia = mediaByAsset.get(plan.selects[0].assetId);
  for (const select of plan.selects) {
    const media = mediaByAsset.get(select.assetId);
    const audioMedia = mediaByAsset.get(select.audioAssetId);
    if (!media) throw new Error(`Media metadata is missing for asset ${select.assetId}`);
    if (!audioMedia) throw new Error(`Audio metadata is missing for asset ${select.audioAssetId}`);
    if (select.sourceOut > media.durationSeconds + 0.05) {
      throw new Error(`select_range ${select.id} exceeds ${select.assetId} duration`);
    }
    if (select.audioSourceOut > audioMedia.durationSeconds + 0.05) {
      throw new Error(`Audio range ${select.id} exceeds ${select.audioAssetId} duration`);
    }
  }

  const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'ai-video-preview-'));
  try {
    const filterScript = path.join(tempDir, 'filter.txt');
    const filter = await buildFilterScript({ plan, mediaByAsset, inputIndexByAsset, outputMedia, fontFile, tempDir });
    await fs.writeFile(filterScript, filter.script, 'utf8');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const row of mediaRows) args.push('-i', row.path);
    args.push('-filter_complex_script', filterScript, '-map', '[vout]');
    if (filter.hasAudio) args.push('-map', '[acat]');
    args.push(
      '-c:v', 'libx264',
      '-preset', String(options.preset || 'medium'),
      '-crf', String(options.crf || '18'),
      '-pix_fmt', 'yuv420p',
    );
    if (filter.hasAudio) args.push('-c:a', 'aac', '-b:a', '192k');
    else args.push('-an');
    args.push('-movflags', '+faststart', outputPath);
    await execFileAsync(options.ffmpeg || DEFAULT_FFMPEG, args, { timeout: 10 * 60_000, maxBuffer: 4_000_000 });

    const rendered = await probeMedia(outputPath, options.ffprobe || DEFAULT_FFPROBE);
    const tolerance = Math.max(0.12, 2 / plan.frameRate);
    const durationError = Math.abs(rendered.durationSeconds - plan.durationSeconds);
    if (durationError > tolerance) {
      throw new Error(`Rendered duration ${rendered.durationSeconds}s differs from IR ${plan.durationSeconds}s`);
    }
    return {
      ok: true,
      output: outputPath,
      assetCount: assetIds.length,
      sourceDurationSeconds: round(outputMedia.durationSeconds),
      sourceDurationsSeconds: Object.fromEntries(mediaRows.map((row) => [row.assetId, round(row.media.durationSeconds)])),
      outputDurationSeconds: round(rendered.durationSeconds),
      expectedDurationSeconds: plan.durationSeconds,
      durationErrorSeconds: round(durationError),
      selectCount: plan.selects.length,
      captionCount: plan.captions.length,
      audioStrategy: plan.audioStrategy,
      audioAssetIds: [...new Set(plan.selects.map((select) => select.audioAssetId))],
      hasAudio: rendered.hasAudio,
      width: rendered.width,
      height: rendered.height,
      fontFile,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options['self-test']) {
    const plan = buildRenderPlan({
      timeline: {
        frameRate: 30,
        operations: [
          { id: 's1', type: 'select_range', sourceIn: 0, sourceOut: 2, timelineIn: 0 },
          { id: 's2', type: 'select_range', sourceIn: 5, sourceOut: 8, timelineIn: 2 },
          { id: 'c1', type: 'caption', timelineIn: 1, timelineOut: 3, text: '検証' },
        ],
      },
    });
    const ok = plan.durationSeconds === 5 && plan.selects.length === 2 && plan.captions.length === 1;
    if (!ok) throw new Error('preview renderer self-test failed');
    process.stdout.write(`${JSON.stringify({ ok: true, test: 'preview-render-plan' })}\n`);
    return;
  }
  if ((!options.media && !options['asset-bindings']) || !options.ir || !options.output) usage('Missing required arguments');
  process.stdout.write(`${JSON.stringify(await renderPreview(options), null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}

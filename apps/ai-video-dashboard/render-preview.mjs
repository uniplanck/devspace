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

function normalizeOverlays(operations, durationSeconds) {
  const allowed = new Set(['title_card', 'chapter', 'callout', 'cta', 'evidence_card']);
  return operations
    .filter((operation) => allowed.has(operation?.type) && operation.enabled !== false)
    .map((operation, index) => {
      const start = finiteNumber(operation.timelineIn, `${operation.type} ${operation.id || index} timelineIn`);
      const end = finiteNumber(operation.timelineOut, `${operation.type} ${operation.id || index} timelineOut`);
      const text = String(operation.text || '').trim();
      if (!text || start < 0 || end <= start) throw new Error(`Invalid ${operation.type} ${operation.id || index}`);
      return {
        id: operation.id || `${operation.type}-${index + 1}`,
        type: operation.type,
        start: Math.min(durationSeconds, start),
        end: Math.min(durationSeconds, end),
        text,
        position: String(operation.position || (operation.type === 'chapter' ? 'top_left' : 'center')),
        eyebrow: String(operation.eyebrow || '').trim(),
        footer: String(operation.footer || '').trim(),
        variant: String(operation.variant || 'evidence'),
      };
    })
    .filter((operation) => operation.end > operation.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function normalizeVisualEffects(operations, durationSeconds) {
  return operations
    .filter((operation) => operation?.type === 'visual_effect' && operation.enabled !== false)
    .map((operation, index) => {
      const start = finiteNumber(operation.timelineIn, `visual_effect ${operation.id || index} timelineIn`);
      const end = finiteNumber(operation.timelineOut, `visual_effect ${operation.id || index} timelineOut`);
      const scale = finiteNumber(operation.scale ?? 1.08, `visual_effect ${operation.id || index} scale`);
      if (start < 0 || end <= start || scale < 1 || scale > 1.25) throw new Error(`Invalid visual_effect ${operation.id || index}`);
      return {
        id: operation.id || `visual-effect-${index + 1}`,
        start: Math.min(durationSeconds, start),
        end: Math.min(durationSeconds, end),
        scale,
      };
    })
    .filter((operation) => operation.end > operation.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function quantizeSelects(selects, frameRate) {
  const rawDurationSeconds = selects.reduce((sum, select) => sum + select.sourceOut - select.sourceIn, 0);
  const totalFrames = Math.max(1, Math.round(rawDurationSeconds * frameRate));
  const quantized = selects.map((select, index) => {
    const startFrame = Math.round(select.timelineIn * frameRate);
    const endFrame = index + 1 < selects.length
      ? Math.round(selects[index + 1].timelineIn * frameRate)
      : totalFrames;
    const durationFrames = endFrame - startFrame;
    if (durationFrames <= 0) throw new Error(`select_range ${select.id} collapses after frame quantization`);
    const sourceStartFrame = Math.round(select.sourceIn * frameRate);
    const audioSourceStartFrame = Math.round(select.audioSourceIn * frameRate);
    return {
      ...select,
      timelineIn: startFrame / frameRate,
      sourceIn: sourceStartFrame / frameRate,
      sourceOut: (sourceStartFrame + durationFrames) / frameRate,
      audioSourceIn: audioSourceStartFrame / frameRate,
      audioSourceOut: (audioSourceStartFrame + durationFrames) / frameRate,
      startFrame,
      durationFrames,
    };
  });
  const quantizedFrames = quantized.reduce((sum, select) => sum + select.durationFrames, 0);
  if (quantizedFrames !== totalFrames) throw new Error(`Frame plan mismatch: ${quantizedFrames} != ${totalFrames}`);
  return { selects: quantized, totalFrames, durationSeconds: totalFrames / frameRate };
}

export function buildRenderPlan(editorialIr) {
  const operations = editorialIr?.timeline?.operations;
  if (!Array.isArray(operations)) throw new Error('Editorial IR timeline.operations is required');
  const frameRate = finiteNumber(editorialIr?.timeline?.frameRate || 30, 'timeline frameRate');
  const framePlan = quantizeSelects(normalizeSelects(operations), frameRate);
  const captions = normalizeCaptions(operations, framePlan.durationSeconds);
  const overlays = normalizeOverlays(operations, framePlan.durationSeconds);
  const visualEffects = normalizeVisualEffects(operations, framePlan.durationSeconds);
  return {
    frameRate,
    totalFrames: framePlan.totalFrames,
    durationSeconds: round(framePlan.durationSeconds, 6),
    selects: framePlan.selects,
    captions,
    overlays,
    visualEffects,
    captionMode: String(editorialIr?.retentionPlan?.captionMode || 'standard'),
    audioProcessing: String(editorialIr?.audio?.processing || 'none'),
    videoProcessing: String(editorialIr?.video?.processing || 'none'),
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
  const cleanVoice = plan.audioProcessing === 'voice_youtube_clean';
  const voiceProcessing = cleanVoice || plan.audioProcessing === 'voice_youtube';
  const cleanVideo = plan.videoProcessing === 'youtube_clean';
  for (const [index, select] of plan.selects.entries()) {
    const inputIndex = inputIndexByAsset.get(select.assetId);
    const audioInputIndex = inputIndexByAsset.get(select.audioAssetId);
    const media = mediaByAsset.get(select.audioAssetId);
    const duration = select.durationFrames / plan.frameRate;
    const videoCleanup = cleanVideo
      ? 'hqdn3d=luma_spatial=1.15:chroma_spatial=2.8:luma_tmp=1.8:chroma_tmp=5.4,'
      : '';
    lines.push(
      `[${inputIndex}:v]trim=start=${select.sourceIn},setpts=PTS-STARTPTS,`
      + `fps=${plan.frameRate},trim=end_frame=${select.durationFrames},setpts=PTS-STARTPTS,`
      + videoCleanup
      + `scale=${outputMedia.width}:${outputMedia.height}:force_original_aspect_ratio=decrease,`
      + `pad=${outputMedia.width}:${outputMedia.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,`
      + `format=yuv420p[v${index}]`,
    );
    concatInputs.push(`[v${index}]`);
    if (hasAudio) {
      if (media?.hasAudio) {
        const boundaryFade = voiceProcessing && duration > 0.12
          ? `,afade=t=in:st=0:d=0.035,afade=t=out:st=${Math.max(0, duration - 0.035)}:d=0.035`
          : '';
        lines.push(
          `[${audioInputIndex}:a]atrim=start=${select.audioSourceIn}:duration=${duration},asetpts=PTS-STARTPTS,`
          + 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'
          + `${boundaryFade}[a${index}]`,
        );
      } else {
        lines.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`);
      }
      concatInputs.push(`[a${index}]`);
    }
  }
  let audioOutput = null;
  if (hasAudio) {
    lines.push(`${concatInputs.join('')}concat=n=${plan.selects.length}:v=1:a=1[vcat][acat]`);
    if (cleanVoice) {
      lines.push('[acat]highpass=f=75,lowpass=f=15500,afftdn=nr=11:nf=-36:tn=1:gs=8,deesser=i=0.16:m=0.35:f=0.58,acompressor=threshold=-25dB:ratio=2.6:attack=18:release=220:makeup=1.35,loudnorm=I=-16:LRA=7:TP=-1.5[aout]');
      audioOutput = 'aout';
    } else if (voiceProcessing) {
      lines.push('[acat]highpass=f=70,acompressor=threshold=-24dB:ratio=3:attack=15:release=180,loudnorm=I=-16:LRA=9:TP=-1.5[aout]');
      audioOutput = 'aout';
    } else {
      audioOutput = 'acat';
    }
  } else {
    lines.push(`${concatInputs.join('')}concat=n=${plan.selects.length}:v=1:a=0[vcat]`);
  }

  let previous = 'vcat';
  for (const [index, effect] of plan.visualEffects.entries()) {
    const scaledWidth = Math.ceil(outputMedia.width * effect.scale / 2) * 2;
    const scaledHeight = Math.ceil(outputMedia.height * effect.scale / 2) * 2;
    const base = `vfxbase${index}`;
    const zoom = `vfxzoom${index}`;
    const zoomed = `vfxzoomed${index}`;
    const next = `vfx${index}`;
    lines.push(`[${previous}]split=2[${base}][${zoom}]`);
    lines.push(`[${zoom}]scale=${scaledWidth}:${scaledHeight},crop=${outputMedia.width}:${outputMedia.height}:(iw-ow)/2:(ih-oh)/2[${zoomed}]`);
    lines.push(`[${base}][${zoomed}]overlay=0:0:enable='between(t,${effect.start},${effect.end})'[${next}]`);
    previous = next;
  }

  const fontSize = Math.max(32, Math.min(72, Math.round(outputMedia.height / 16)));
  const boxBorder = Math.max(12, Math.round(fontSize * 0.3));
  const cardAccents = {
    hook: '0xF59E0B',
    evidence: '0x38BDF8',
    comparison: '0xA78BFA',
    caution: '0xF87171',
    summary: '0x34D399',
  };
  for (const [index, overlay] of plan.overlays.entries()) {
    const textFile = path.join(tempDir, `overlay-${String(index + 1).padStart(3, '0')}.txt`);
    await fs.writeFile(textFile, `${overlay.text}\n`, 'utf8');
    if (overlay.type === 'evidence_card') {
      const eyebrowFile = path.join(tempDir, `overlay-${String(index + 1).padStart(3, '0')}-eyebrow.txt`);
      const footerFile = path.join(tempDir, `overlay-${String(index + 1).padStart(3, '0')}-footer.txt`);
      await Promise.all([
        fs.writeFile(eyebrowFile, `${overlay.eyebrow || ''}\n`, 'utf8'),
        fs.writeFile(footerFile, `${overlay.footer || ''}\n`, 'utf8'),
      ]);
      const position = overlay.position || 'full';
      const geometry = position === 'left'
        ? { x: 0.04, y: 0.15, width: 0.64, height: 0.52 }
        : position === 'right'
          ? { x: 0.32, y: 0.15, width: 0.64, height: 0.52 }
          : position === 'bottom'
            ? { x: 0.05, y: 0.42, width: 0.9, height: 0.32 }
            : { x: 0.06, y: 0.12, width: 0.88, height: 0.56 };
      const x = Math.round(outputMedia.width * geometry.x);
      const y = Math.round(outputMedia.height * geometry.y);
      const width = Math.round(outputMedia.width * geometry.width);
      const height = Math.round(outputMedia.height * geometry.height);
      const padding = Math.round(outputMedia.width * 0.035);
      const accentWidth = Math.max(8, Math.round(outputMedia.width * 0.006));
      const bodySize = Math.round(fontSize * (position === 'bottom' ? 0.82 : 1.05));
      const eyebrowSize = Math.round(fontSize * 0.52);
      const footerSize = Math.round(fontSize * 0.44);
      const accent = cardAccents[overlay.variant] || cardAccents.evidence;
      const enable = `between(t,${overlay.start},${overlay.end})`;
      const dimmed = `vcard${index}dim`;
      const panel = `vcard${index}panel`;
      const stripe = `vcard${index}stripe`;
      lines.push(`[${previous}]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.22:t=fill:enable='${enable}'[${dimmed}]`);
      lines.push(`[${dimmed}]drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=0x07111F@0.88:t=fill:enable='${enable}'[${panel}]`);
      lines.push(`[${panel}]drawbox=x=${x}:y=${y}:w=${accentWidth}:h=${height}:color=${accent}@1:t=fill:enable='${enable}'[${stripe}]`);
      let cardPrevious = stripe;
      if (overlay.eyebrow) {
        const eyebrowLabel = `vcard${index}eyebrow`;
        lines.push(
          `[${cardPrevious}]drawtext=`
          + `fontfile='${escapeFilterPath(fontFile)}':textfile='${escapeFilterPath(eyebrowFile)}':`
          + `expansion=none:reload=0:fontcolor=${accent}:fontsize=${eyebrowSize}:`
          + `x=${x + padding}:y=${y + Math.round(padding * 0.7)}:fix_bounds=1:enable='${enable}'[${eyebrowLabel}]`,
        );
        cardPrevious = eyebrowLabel;
      }
      const bodyLabel = `vcard${index}body`;
      const bodyY = y + padding + (overlay.eyebrow ? Math.round(eyebrowSize * 1.45) : 0);
      lines.push(
        `[${cardPrevious}]drawtext=`
        + `fontfile='${escapeFilterPath(fontFile)}':textfile='${escapeFilterPath(textFile)}':`
        + `expansion=none:reload=0:fontcolor=white:fontsize=${bodySize}:`
        + `line_spacing=${Math.round(bodySize * 0.22)}:borderw=${Math.max(2, Math.round(bodySize * 0.035))}:bordercolor=black@0.6:`
        + `x=${x + padding}:y=${bodyY}:fix_bounds=1:enable='${enable}'[${bodyLabel}]`,
      );
      cardPrevious = bodyLabel;
      if (overlay.footer) {
        const footerLabel = `vcard${index}footer`;
        lines.push(
          `[${cardPrevious}]drawtext=`
          + `fontfile='${escapeFilterPath(fontFile)}':textfile='${escapeFilterPath(footerFile)}':`
          + `expansion=none:reload=0:fontcolor=0xCBD5E1:fontsize=${footerSize}:`
          + `x=${x + padding}:y=${y + height - padding - footerSize}:fix_bounds=1:enable='${enable}'[${footerLabel}]`,
        );
        cardPrevious = footerLabel;
      }
      previous = cardPrevious;
      continue;
    }
    const next = `voverlay${index}`;
    const enable = `between(t,${overlay.start},${overlay.end})`;
    if (overlay.type === 'chapter') {
      const x = Math.round(outputMedia.width * 0.045);
      const y = Math.round(outputMedia.height * 0.055);
      const width = Math.round(outputMedia.width * 0.34);
      const height = Math.round(outputMedia.height * 0.068);
      const panel = `vchapter${index}panel`;
      const accent = `vchapter${index}accent`;
      lines.push(`[${previous}]drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=0x07111F@0.82:t=fill:enable='${enable}'[${panel}]`);
      lines.push(`[${panel}]drawbox=x=${x}:y=${y}:w=${Math.max(8, Math.round(outputMedia.width * 0.006))}:h=${height}:color=0xF5B942@1:t=fill:enable='${enable}'[${accent}]`);
      lines.push(
        `[${accent}]drawtext=fontfile='${escapeFilterPath(fontFile)}':textfile='${escapeFilterPath(textFile)}':`
        + `expansion=none:reload=0:fontcolor=white:fontsize=${Math.round(fontSize * 0.62)}:`
        + `x=${x + Math.round(outputMedia.width * 0.022)}:y=${y + Math.round(height * 0.19)}:`
        + `fix_bounds=1:enable='${enable}'[${next}]`,
      );
      previous = next;
      continue;
    }
    if (overlay.type === 'callout') {
      lines.push(
        `[${previous}]drawtext=fontfile='${escapeFilterPath(fontFile)}':textfile='${escapeFilterPath(textFile)}':`
        + `expansion=none:reload=0:fontcolor=0x07111F:fontsize=${Math.round(fontSize * 0.66)}:`
        + `box=1:boxcolor=0xF5B942@0.96:boxborderw=${Math.round(fontSize * 0.28)}:`
        + `x=w-text_w-${Math.round(outputMedia.width * 0.055)}:y=${Math.round(outputMedia.height * 0.065)}:`
        + `fix_bounds=1:enable='${enable}'[${next}]`,
      );
      previous = next;
      continue;
    }
    const size = overlay.type === 'title_card' || overlay.type === 'cta'
      ? Math.round(fontSize * 1.2)
      : Math.round(fontSize * 0.95);
    const position = overlay.type === 'title_card'
      ? `x=${Math.round(outputMedia.width * 0.06)}:y=${Math.round(outputMedia.height * 0.18)}`
      : overlay.position === 'top'
        ? `x=(w-text_w)/2:y=${Math.round(outputMedia.height * 0.08)}`
        : 'x=(w-text_w)/2:y=(h-text_h)/2';
    lines.push(
      `[${previous}]drawtext=`
      + `fontfile='${escapeFilterPath(fontFile)}':`
      + `textfile='${escapeFilterPath(textFile)}':`
      + `expansion=none:reload=0:fontcolor=white:fontsize=${size}:line_spacing=${Math.round(size * 0.16)}:`
      + `box=1:boxcolor=0x07111F@0.84:boxborderw=${Math.round(size * 0.34)}:`
      + `${position}:enable='${enable}'[${next}]`,
    );
    previous = next;
  }

  for (const [index, caption] of plan.captions.entries()) {
    const textFile = path.join(tempDir, `caption-${String(index + 1).padStart(3, '0')}.txt`);
    await fs.writeFile(textFile, `${caption.text}\n`, 'utf8');
    const next = `vcap${index}`;
    const roleScale = caption.role === 'emphasis' ? 1.06 : 1;
    const fullCaption = plan.captionMode === 'full_aligned';
    const readableCaption = plan.captionMode === 'full_readable';
    const size = Math.round(fontSize * roleScale * (fullCaption ? 1.06 : readableCaption ? 0.98 : 1));
    const fontColor = caption.role === 'emphasis' ? '0xFFD166' : 'white';
    const captionStyle = readableCaption
      ? `box=1:boxcolor=0x061018@0.84:boxborderw=${Math.round(size * 0.34)}:borderw=${Math.max(2, Math.round(size * 0.035))}:bordercolor=black@0.8:line_spacing=${Math.round(size * 0.18)}:`
      : fullCaption
        ? `borderw=${Math.max(4, Math.round(size * 0.075))}:bordercolor=black@0.96:shadowx=2:shadowy=2:shadowcolor=black@0.7:line_spacing=${Math.round(size * 0.14)}:`
        : `box=1:boxcolor=black@0.62:boxborderw=${boxBorder}:`;
    lines.push(
      `[${previous}]drawtext=`
      + `fontfile='${escapeFilterPath(fontFile)}':`
      + `textfile='${escapeFilterPath(textFile)}':`
      + `expansion=none:reload=0:fontcolor=${fontColor}:fontsize=${size}:`
      + captionStyle
      + `x=(w-text_w)/2:y=h-text_h-${Math.max(70, Math.round(outputMedia.height * (readableCaption ? 0.105 : 0.075)))}:`
      + `enable='between(t,${caption.start},${caption.end})'[${next}]`,
    );
    previous = next;
  }
  if (previous === 'vcat') lines.push('[vcat]null[vout]');
  else lines.push(`[${previous}]null[vout]`);
  return { script: `${lines.join(';\n')}\n`, hasAudio, audioOutput };
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
    if (filter.hasAudio) args.push('-map', `[${filter.audioOutput}]`);
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
      overlayCount: plan.overlays.length,
      visualEffectCount: plan.visualEffects.length,
      audioProcessing: plan.audioProcessing,
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
    const ok = plan.durationSeconds === 5
      && plan.selects.length === 2
      && plan.captions.length === 1
      && plan.overlays.length === 0
      && plan.visualEffects.length === 0
      && plan.audioProcessing === 'none';
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

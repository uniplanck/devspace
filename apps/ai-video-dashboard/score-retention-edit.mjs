#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildRenderPlan } from './render-preview.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_FFMPEG = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';
const DEFAULT_FFPROBE = process.env.FFPROBE_PATH || '/usr/local/bin/ffprobe';

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('Usage: node score-retention-edit.mjs --ir <editorial-ir.json> [--video <rendered.mp4>] [--output <report.json>]\n');
  process.exit(2);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--self-test') {
      values['self-test'] = true;
      continue;
    }
    if (!token.startsWith('--')) usage(`Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for ${token}`);
    values[token.slice(2)] = value;
    index += 1;
  }
  return values;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function category(id, label, score, maxScore, evidence) {
  return { id, label, score: round(score), maxScore, evidence };
}

function maxGapSeconds(durationSeconds, eventTimes) {
  const points = [0, ...eventTimes.filter((value) => Number.isFinite(value) && value > 0 && value < durationSeconds), durationSeconds]
    .sort((left, right) => left - right);
  let maximum = 0;
  for (let index = 1; index < points.length; index += 1) maximum = Math.max(maximum, points[index] - points[index - 1]);
  return maximum;
}

async function probeVideo(videoPath, ffprobePath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height',
    '-of', 'json',
    videoPath,
  ], { timeout: 30_000, maxBuffer: 2_000_000 });
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find((stream) => stream.codec_type === 'video');
  const audio = (data.streams || []).find((stream) => stream.codec_type === 'audio');
  return {
    durationSeconds: Number(data.format?.duration || 0),
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    hasAudio: Boolean(audio),
  };
}

async function measureLoudness(videoPath, ffmpegPath) {
  let stderr = '';
  try {
    const result = await execFileAsync(ffmpegPath, [
      '-hide_banner', '-nostats', '-i', videoPath,
      '-af', 'loudnorm=I=-16:LRA=9:TP=-1.5:print_format=json',
      '-f', 'null', '-',
    ], { timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    stderr = String(result.stderr || '');
  } catch (error) {
    stderr = String(error?.stderr || '');
  }
  const matches = [...stderr.matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/gu)];
  const block = matches.at(-1)?.[0];
  if (!block) return null;
  try {
    const parsed = JSON.parse(block);
    return {
      integratedLufs: Number(parsed.input_i),
      truePeakDbtp: Number(parsed.input_tp),
      loudnessRange: Number(parsed.input_lra),
    };
  } catch {
    return null;
  }
}

export async function scoreRetentionEdit({ editorialIr, videoPath, ffmpegPath = DEFAULT_FFMPEG, ffprobePath = DEFAULT_FFPROBE }) {
  const plan = buildRenderPlan(editorialIr);
  const retention = editorialIr?.retentionPlan || {};
  const chapters = plan.overlays.filter((operation) => operation.type === 'chapter');
  const titleCards = plan.overlays.filter((operation) => operation.type === 'title_card');
  const ctas = plan.overlays.filter((operation) => operation.type === 'cta');
  const callouts = plan.overlays.filter((operation) => operation.type === 'callout');
  const firstHook = titleCards[0];
  const conclusion = plan.overlays.find((operation) => /結論|可能性|断定/u.test(operation.text) && operation.start >= plan.durationSeconds * 0.75);
  const cutsPerMinute = plan.selects.length / (plan.durationSeconds / 60);
  const minimumClipSeconds = Math.min(...plan.selects.map((select) => select.durationFrames / plan.frameRate));
  const visualEventTimes = [
    ...plan.visualEffects.flatMap((effect) => [effect.start, effect.end]),
    ...plan.overlays.map((overlay) => overlay.start),
  ];
  const visualGap = maxGapSeconds(plan.durationSeconds, visualEventTimes);
  const captionTexts = plan.captions.map((caption) => caption.text);
  const longestCaption = captionTexts.reduce((maximum, text) => Math.max(maximum, [...text].length), 0);
  const suspiciousTerms = ['関東カラー', '竜宮場', '謝罪分', 'ジョイボーイミカ', '急激に吹ける', '上位ボーイ'];
  const suspiciousCaptionCount = captionTexts.filter((text) => suspiciousTerms.some((term) => text.includes(term))).length;

  const hookScore = firstHook && firstHook.start <= 0.5 ? 18 : firstHook && firstHook.start <= 5 ? 12 : 0;
  const structureScore = Math.min(12, chapters.length * 4)
    + (conclusion ? 3 : 0)
    + (plan.durationSeconds >= 90 && plan.durationSeconds <= 240 ? 2 : 0);
  const tempoScore = (cutsPerMinute <= 10 ? 8 : cutsPerMinute <= 20 ? 6 : cutsPerMinute <= 30 ? 3 : 0)
    + (minimumClipSeconds >= 1.5 ? 4 : minimumClipSeconds >= 0.3 ? 2 : 0)
    + (plan.selects.length <= 12 ? 3 : plan.selects.length <= 24 ? 1 : 0);
  const visualBase = (visualGap <= 15 ? 6 : visualGap <= 20 ? 4 : visualGap <= 30 ? 2 : 0)
    + (plan.visualEffects.length >= 8 ? 2 : plan.visualEffects.length >= 4 ? 1 : 0)
    + (plan.overlays.length >= 8 ? 1 : 0);
  const visualScore = retention.visualEvidenceMode === 'source_only' ? Math.min(9, visualBase) : Math.min(15, visualBase + 4);
  const captionBase = (plan.captions.length >= 12 ? 4 : plan.captions.length >= 8 ? 3 : 1)
    + (longestCaption <= 40 ? 2 : longestCaption <= 56 ? 1 : 0)
    + (suspiciousCaptionCount === 0 ? 1 : 0);
  const captionScore = retention.captionMode === 'key_points_manual' ? Math.min(7, captionBase) : Math.min(10, captionBase + 2);

  let video = null;
  let loudness = null;
  if (videoPath) {
    video = await probeVideo(videoPath, ffprobePath);
    loudness = video.hasAudio ? await measureLoudness(videoPath, ffmpegPath) : null;
  }
  const durationErrorSeconds = video ? Math.abs(video.durationSeconds - plan.durationSeconds) : null;
  const audioScore = (plan.audioProcessing === 'voice_youtube' ? 5 : 0)
    + (loudness && loudness.integratedLufs >= -18 && loudness.integratedLufs <= -14 ? 3 : 0)
    + (loudness && loudness.truePeakDbtp <= -1 ? 2 : 0);
  const smoothnessScore = (plan.selects.length <= 12 ? 3 : plan.selects.length <= 24 ? 1 : 0)
    + (minimumClipSeconds >= 3 ? 2 : minimumClipSeconds >= 1.5 ? 1 : 0);
  const ctaScore = ctas.some((cta) => cta.start >= plan.durationSeconds - 12) ? 5 : 0;

  const categories = [
    category('hook', '冒頭フック', hookScore, 20, { firstHookSeconds: firstHook?.start ?? null, text: firstHook?.text ?? null }),
    category('structure', '論理構成', structureScore, 20, { chapterCount: chapters.length, conclusion: Boolean(conclusion), durationSeconds: plan.durationSeconds }),
    category('tempo', 'テンポ・カット', tempoScore, 15, { cutsPerMinute: round(cutsPerMinute), selectCount: plan.selects.length, minimumClipSeconds: round(minimumClipSeconds) }),
    category('visuals', '視覚変化', visualScore, 15, { visualEffectCount: plan.visualEffects.length, overlayCount: plan.overlays.length, maximumVisualGapSeconds: round(visualGap), evidenceMode: retention.visualEvidenceMode || 'unknown' }),
    category('captions', '字幕・テロップ', captionScore, 10, { captionCount: plan.captions.length, longestCaptionCharacters: longestCaption, suspiciousCaptionCount, captionMode: retention.captionMode || 'unknown' }),
    category('audio', '音声', audioScore, 10, { processing: plan.audioProcessing, loudness }),
    category('smoothness', 'カットの自然さ', smoothnessScore, 5, { selectCount: plan.selects.length, minimumClipSeconds: round(minimumClipSeconds) }),
    category('cta', '結論・視聴後行動', ctaScore, 5, { ctaCount: ctas.length, finalCtaSeconds: ctas.at(-1)?.start ?? null }),
  ];
  const score = round(categories.reduce((sum, row) => sum + row.score, 0));
  const technicalChecks = [
    { id: 'duration', status: durationErrorSeconds === null ? 'not_run' : durationErrorSeconds <= Math.max(0.12, 2 / plan.frameRate) ? 'pass' : 'fail', value: durationErrorSeconds === null ? null : round(durationErrorSeconds, 3) },
    { id: 'video-stream', status: video === null ? 'not_run' : video.width > 0 && video.height > 0 ? 'pass' : 'fail', value: video ? `${video.width}x${video.height}` : null },
    { id: 'audio-stream', status: video === null ? 'not_run' : video.hasAudio ? 'pass' : 'fail', value: video?.hasAudio ?? null },
    { id: 'micro-clips', status: minimumClipSeconds >= 0.3 ? 'pass' : 'fail', value: round(minimumClipSeconds, 3) },
    { id: 'hook-deadline', status: firstHook && firstHook.start <= 5 ? 'pass' : 'fail', value: firstHook?.start ?? null },
  ];
  const hasTechnicalFailure = technicalChecks.some((check) => check.status === 'fail');
  const status = hasTechnicalFailure || score < 60 ? 'fail' : score < 75 ? 'review' : 'pass';
  return {
    version: 'retention-quality.v1',
    score,
    targetScore: Number(retention.targetScore || 60),
    status,
    passedTarget: !hasTechnicalFailure && score >= Number(retention.targetScore || 60),
    categories,
    metrics: {
      durationSeconds: plan.durationSeconds,
      cutsPerMinute: round(cutsPerMinute),
      minimumClipSeconds: round(minimumClipSeconds),
      maximumVisualGapSeconds: round(visualGap),
      captionCount: plan.captions.length,
      overlayCount: plan.overlays.length,
      visualEffectCount: plan.visualEffects.length,
      loudness,
      renderedVideo: video,
      durationErrorSeconds: durationErrorSeconds === null ? null : round(durationErrorSeconds, 3),
    },
    technicalChecks,
    limitations: [
      '視覚評価はsource映像・パンチイン・テロップ構成の検査であり、漫画コマや外部資料の意味的適合は未評価です。',
      '発話の自然さと論理のつながりは機械指標だけでは保証できないため、最終的な人間視聴が必要です。',
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) {
    const editorialIr = {
      retentionPlan: { targetScore: 60, captionMode: 'key_points_manual', visualEvidenceMode: 'source_only' },
      audio: { processing: 'voice_youtube' },
      timeline: {
        frameRate: 30,
        operations: [
          { id: 's1', type: 'select_range', assetId: 'cam-a', sourceIn: 10, sourceOut: 18, timelineIn: 0 },
          { id: 's2', type: 'select_range', assetId: 'cam-a', sourceIn: 30, sourceOut: 38, timelineIn: 8 },
          { id: 'hook', type: 'title_card', timelineIn: 0, timelineOut: 3, text: '結論' },
          { id: 'ch1', type: 'chapter', timelineIn: 3, timelineOut: 5, text: '根拠1' },
          { id: 'ch2', type: 'chapter', timelineIn: 6, timelineOut: 8, text: '根拠2' },
          { id: 'ch3', type: 'chapter', timelineIn: 9, timelineOut: 11, text: '根拠3' },
          { id: 'cta', type: 'cta', timelineIn: 12, timelineOut: 16, text: 'どう思う？' },
          ...Array.from({ length: 12 }, (_, index) => ({ id: `c${index}`, type: 'caption', timelineIn: index, timelineOut: index + 0.8, text: `字幕${index}` })),
          ...Array.from({ length: 8 }, (_, index) => ({ id: `v${index}`, type: 'visual_effect', timelineIn: index * 2, timelineOut: index * 2 + 1, scale: 1.08 })),
        ],
      },
    };
    const report = await scoreRetentionEdit({ editorialIr });
    if (report.score < 60 || report.technicalChecks.find((check) => check.id === 'micro-clips')?.status !== 'pass') {
      throw new Error('retention scorer self-test failed');
    }
    process.stdout.write(`${JSON.stringify({ ok: true, test: 'retention-quality-scorer', score: report.score })}\n`);
    return;
  }
  if (!args.ir) usage('Missing --ir');
  const irPath = path.resolve(String(args.ir));
  const editorialIr = JSON.parse(await fs.readFile(irPath, 'utf8'));
  const report = await scoreRetentionEdit({
    editorialIr,
    videoPath: args.video ? path.resolve(String(args.video)) : undefined,
    ffmpegPath: String(args.ffmpeg || DEFAULT_FFMPEG),
    ffprobePath: String(args.ffprobe || DEFAULT_FFPROBE),
  });
  if (args.output) {
    const outputPath = path.resolve(String(args.output));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passedTarget) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});

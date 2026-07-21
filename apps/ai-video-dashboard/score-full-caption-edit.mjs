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
  process.stderr.write('Usage: node score-full-caption-edit.mjs --ir <ir.json> --video <video.mp4> --mix-report <mix.json> --sfx-plan <sfx.json> [--output <report.json>]\n');
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

function maxGapSeconds(durationSeconds, times) {
  const points = [0, ...times.filter((value) => Number.isFinite(value) && value > 0 && value < durationSeconds), durationSeconds]
    .sort((left, right) => left - right);
  let maximum = 0;
  for (let index = 1; index < points.length; index += 1) maximum = Math.max(maximum, points[index] - points[index - 1]);
  return maximum;
}

async function probeVideo(videoPath, ffprobePath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', videoPath,
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
      '-af', 'loudnorm=I=-14.5:LRA=8:TP=-1.2:print_format=json', '-f', 'null', '-',
    ], { timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    stderr = String(result.stderr || '');
  } catch (error) {
    stderr = String(error?.stderr || '');
  }
  const block = [...stderr.matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/gu)].at(-1)?.[0];
  if (!block) return null;
  const parsed = JSON.parse(block);
  return {
    integratedLufs: Number(parsed.input_i),
    truePeakDbtp: Number(parsed.input_tp),
    loudnessRange: Number(parsed.input_lra),
  };
}

export async function scoreFullCaptionEdit({ editorialIr, videoPath, mixReport, sfxPlan, ffmpegPath = DEFAULT_FFMPEG, ffprobePath = DEFAULT_FFPROBE }) {
  const plan = buildRenderPlan(editorialIr);
  const retention = editorialIr.retentionPlan || {};
  const video = await probeVideo(videoPath, ffprobePath);
  const loudness = video.hasAudio ? await measureLoudness(videoPath, ffmpegPath) : null;
  const chapters = plan.overlays.filter((operation) => operation.type === 'chapter');
  const title = plan.overlays.find((operation) => operation.type === 'title_card');
  const ctas = plan.overlays.filter((operation) => operation.type === 'cta');
  const conclusion = plan.overlays.find((operation) => /結論|可能性|断定/u.test(operation.text) && operation.start >= plan.durationSeconds * 0.75);
  const cutsPerMinute = plan.selects.length / (plan.durationSeconds / 60);
  const minimumClipSeconds = Math.min(...plan.selects.map((select) => select.durationFrames / plan.frameRate));
  const visualGap = maxGapSeconds(plan.durationSeconds, [
    ...plan.visualEffects.flatMap((effect) => [effect.start, effect.end]),
    ...plan.overlays.map((overlay) => overlay.start),
  ]);
  const coverage = Number(retention.captionCoverageRatio || 0);
  const maxOnset = Number(retention.maximumOnsetErrorFrames ?? Number.POSITIVE_INFINITY);
  const p95Onset = Number(retention.p95OnsetErrorFrames ?? Number.POSITIVE_INFINITY);
  const captionLines = plan.captions.flatMap((caption) => caption.text.split('\n'));
  const maximumLineCharacters = captionLines.reduce((maximum, line) => Math.max(maximum, [...line].length), 0);
  const maximumLineCount = plan.captions.reduce((maximum, caption) => Math.max(maximum, caption.text.split('\n').length), 0);
  const suspiciousTerms = ['関東カラー', '竜宮場', '謝罪分', 'ジョイボーイミカ', '急激に吹ける', '上位ボーイ', 'ジョイボイ'];
  const suspiciousCaptionCount = plan.captions.filter((caption) => suspiciousTerms.some((term) => caption.text.includes(term))).length;
  const durationError = Math.abs(video.durationSeconds - plan.durationSeconds);

  const hookScore = (title && title.start <= 1 / plan.frameRate ? 12 : title && title.start <= 2 ? 8 : 0)
    + (title && /ジョイボーイ|浦島太郎/u.test(title.text) ? 3 : 0);
  const structureScore = Math.min(9, chapters.length * 3)
    + (conclusion ? 3 : 0)
    + (plan.durationSeconds >= 90 && plan.durationSeconds <= 180 ? 3 : 0);
  const pacingScore = (cutsPerMinute >= 2 && cutsPerMinute <= 10 ? 5 : cutsPerMinute <= 16 ? 3 : 0)
    + (minimumClipSeconds >= 3 ? 3 : minimumClipSeconds >= 1 ? 1 : 0)
    + (plan.selects.length <= 12 ? 2 : 0);
  const captionScore = (retention.captionMode === 'full_aligned' ? 5 : 0)
    + (coverage >= 0.98 ? 8 : coverage >= 0.9 ? 5 : 0)
    + (maxOnset <= 2 ? 7 : maxOnset <= 4 ? 3 : 0)
    + (p95Onset <= 1 ? 3 : p95Onset <= 2 ? 1 : 0)
    + (maximumLineCount <= 2 && maximumLineCharacters <= 20 ? 2 : maximumLineCount <= 2 ? 1 : 0)
    - Math.min(5, suspiciousCaptionCount * 2);
  const visualScore = (visualGap <= 12 ? 5 : visualGap <= 18 ? 3 : 0)
    + (plan.visualEffects.length >= 8 ? 3 : plan.visualEffects.length >= 4 ? 1 : 0)
    + (plan.overlays.length >= 8 ? 2 : plan.overlays.length >= 4 ? 1 : 0);
  const soundScore = (mixReport?.bgm?.path ? 6 : 0)
    + (Number(mixReport?.bgm?.sidechain?.ratio || 0) >= 4 ? 3 : 0)
    + (sfxPlan.length >= 5 && sfxPlan.length <= 10 ? 4 : sfxPlan.length > 0 ? 2 : 0)
    + (Number(mixReport?.bgm?.gainDb) >= -34 && Number(mixReport?.bgm?.gainDb) <= -22 ? 2 : 0);
  const audioScore = (loudness && loudness.integratedLufs >= -16 && loudness.integratedLufs <= -13 ? 3 : 0)
    + (loudness && loudness.truePeakDbtp <= -1 ? 2 : 0);
  const ctaScore = ctas.some((cta) => cta.start >= plan.durationSeconds - 12) ? 5 : 0;

  const categories = [
    category('hook', '冒頭フック', Math.max(0, hookScore), 15, { firstFrame: title?.start ?? null, text: title?.text ?? null }),
    category('structure', '論理構成', structureScore, 15, { chapterCount: chapters.length, conclusion: Boolean(conclusion), durationSeconds: plan.durationSeconds }),
    category('pacing', 'テンポ', pacingScore, 10, { cutsPerMinute: round(cutsPerMinute), minimumClipSeconds: round(minimumClipSeconds), selectCount: plan.selects.length }),
    category('captions', 'フルテロップ', Math.max(0, captionScore), 25, { captionCount: plan.captions.length, coverageRatio: coverage, maximumOnsetErrorFrames: maxOnset, p95OnsetErrorFrames: p95Onset, maximumLineCount, maximumLineCharacters, suspiciousCaptionCount }),
    category('visuals', '視覚変化', visualScore, 10, { maximumVisualGapSeconds: round(visualGap), visualEffectCount: plan.visualEffects.length, overlayCount: plan.overlays.length }),
    category('sound-design', 'BGM・効果音', soundScore, 15, { bgm: mixReport?.bgm || null, soundEffectCount: sfxPlan.length }),
    category('audio', '音声技術品質', audioScore, 5, { loudness }),
    category('cta', '結論・視聴後行動', ctaScore, 5, { finalCtaSeconds: ctas.at(-1)?.start ?? null }),
  ];
  const score = round(categories.reduce((sum, row) => sum + row.score, 0));
  const technicalChecks = [
    { id: 'duration', status: durationError <= Math.max(0.12, 2 / plan.frameRate) ? 'pass' : 'fail', value: round(durationError, 3) },
    { id: 'video-stream', status: video.width > 0 && video.height > 0 ? 'pass' : 'fail', value: `${video.width}x${video.height}` },
    { id: 'audio-stream', status: video.hasAudio ? 'pass' : 'fail', value: video.hasAudio },
    { id: 'caption-coverage', status: coverage >= 0.95 ? 'pass' : 'fail', value: coverage },
    { id: 'caption-onset', status: maxOnset <= 2 ? 'pass' : 'fail', value: maxOnset },
    { id: 'caption-lines', status: maximumLineCount <= 2 ? 'pass' : 'fail', value: maximumLineCount },
    { id: 'bgm', status: mixReport?.bgm?.path ? 'pass' : 'fail', value: mixReport?.bgm?.path || null },
    { id: 'sound-effects', status: sfxPlan.length >= 3 ? 'pass' : 'fail', value: sfxPlan.length },
  ];
  const hasTechnicalFailure = technicalChecks.some((check) => check.status === 'fail');
  return {
    version: 'full-caption-quality.v1',
    score,
    targetScore: 60,
    status: hasTechnicalFailure || score < 60 ? 'fail' : score < 75 ? 'review' : 'pass',
    passedTarget: !hasTechnicalFailure && score >= 60,
    categories,
    metrics: { durationSeconds: plan.durationSeconds, renderedDurationSeconds: video.durationSeconds, loudness, captionCount: plan.captions.length, coverageRatio: coverage, maximumOnsetErrorFrames: maxOnset, soundEffectCount: sfxPlan.length },
    technicalChecks,
    limitations: [
      '60点はフルテロップ・音響・構成・技術QCの制約評価であり、実視聴者の維持率を保証しません。',
      '外部資料画像や漫画コマの意味的適合、全編の人間視聴による違和感判定は別途必要です。',
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) {
    const editorialIr = {
      retentionPlan: { captionMode: 'full_aligned', captionCoverageRatio: 1, maximumOnsetErrorFrames: 0.5, p95OnsetErrorFrames: 0.5 },
      timeline: { frameRate: 30, operations: [
        { id: 's1', type: 'select_range', sourceIn: 0, sourceOut: 10, timelineIn: 0 },
        { id: 's2', type: 'select_range', sourceIn: 20, sourceOut: 30, timelineIn: 10 },
        { id: 'title', type: 'title_card', timelineIn: 0, timelineOut: 2, text: 'ジョイボーイ＝浦島太郎？' },
        { id: 'c1', type: 'chapter', timelineIn: 2, timelineOut: 4, text: '根拠1' },
        { id: 'c2', type: 'chapter', timelineIn: 7, timelineOut: 9, text: '根拠2' },
        { id: 'c3', type: 'chapter', timelineIn: 12, timelineOut: 14, text: '根拠3' },
        { id: 'conclusion', type: 'chapter', timelineIn: 16, timelineOut: 18, text: '結論：可能性は高い' },
        { id: 'cta', type: 'cta', timelineIn: 18, timelineOut: 20, text: 'どう思う？' },
        ...Array.from({ length: 10 }, (_, index) => ({ id: `cap-${index}`, type: 'caption', timelineIn: index * 2, timelineOut: index * 2 + 2, text: 'フルテロップ' })),
        ...Array.from({ length: 8 }, (_, index) => ({ id: `fx-${index}`, type: 'visual_effect', timelineIn: index * 2.5, timelineOut: index * 2.5 + 1, scale: 1.08 })),
      ] },
    };
    const plan = buildRenderPlan(editorialIr);
    if (plan.captions.length !== 10) throw new Error('full caption scorer self-test failed');
    process.stdout.write(`${JSON.stringify({ ok: true, test: 'full-caption-quality-plan' })}\n`);
    return;
  }
  if (!args.ir || !args.video || !args['mix-report'] || !args['sfx-plan']) usage('Missing required arguments');
  const [editorialIr, mixReport, sfxPlan] = await Promise.all([
    fs.readFile(path.resolve(args.ir), 'utf8').then(JSON.parse),
    fs.readFile(path.resolve(args['mix-report']), 'utf8').then(JSON.parse),
    fs.readFile(path.resolve(args['sfx-plan']), 'utf8').then(JSON.parse),
  ]);
  const report = await scoreFullCaptionEdit({ editorialIr, videoPath: path.resolve(args.video), mixReport, sfxPlan });
  if (args.output) {
    const output = path.resolve(args.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passedTarget) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});

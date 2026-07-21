#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CORRECTIONS = [
  ['関東カラー', '巻頭カラー'],
  ['竜宮場', '竜宮城'],
  ['謝罪分', '謝罪文'],
  ['ジョイボーイミカ', 'ジョイボーイ、ニカ'],
  ['急激に吹ける', '急激に老ける'],
  ['急激 にける', '急激に老ける'],
  ['上位ボーイ', 'ジョイボーイ'],
  ['ジョイボイ', 'ジョイボーイ'],
  ['ルフィー', 'ルフィ'],
  ['人米', 'ジンベエ'],
  ['イ様', 'イム様'],
  ['アラパスタ', 'アラバスタ'],
  ['小ブラ王', 'コブラ王'],
  ['天流人', '天竜人'],
  ['フェルタリー', 'ネフェルタリ'],
  ['急激にける', '急激に老ける'],
  ['魚人 島', '魚人島'],
  ['竜宮 王国', '竜宮王国'],
];

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('Usage: node build-full-caption-edit.mjs --ir <base-ir.json> --transcript <transcript.json> --output <full-caption-ir.json> [--corrections <json>]\n');
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

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function cleanText(value) {
  return String(value || '')
    .replace(/\[[^\]]+\]/gu, ' ')
    .replace(/[\r\n]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function compact(value) {
  return cleanText(value).replace(/\s+/gu, '');
}

function applyCorrections(text, corrections) {
  let result = cleanText(text);
  for (const [from, to] of corrections) result = result.split(from).join(to);
  return result
    .replace(/\s+([、。！？])/gu, '$1')
    .replace(/([、。！？])\s+/gu, '$1')
    .replace(/\s+/gu, '')
    .trim();
}

function longestRollingOverlap(previous, current) {
  const left = compact(previous);
  const right = compact(current);
  const maximum = Math.min(left.length, right.length);
  for (let length = maximum; length >= 2; length -= 1) {
    if (left.slice(-length) === right.slice(0, length)) return length;
  }
  return 0;
}

function incrementalText(previous, current) {
  const prior = compact(previous);
  const next = compact(current);
  if (!next || next === prior || prior.includes(next)) return '';
  if (next.startsWith(prior)) return next.slice(prior.length);
  const overlap = longestRollingOverlap(prior, next);
  if (overlap > 0) return next.slice(overlap);
  return next;
}

function splitReadable(text, maxCharacters = 32, lineCharacters = 16) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  const pieces = [];
  let rest = normalized;
  while (rest.length > maxCharacters) {
    let cut = -1;
    for (const punctuation of ['。', '！', '？', '、']) {
      const position = rest.lastIndexOf(punctuation, maxCharacters - 1);
      if (position >= Math.floor(maxCharacters * 0.55)) cut = Math.max(cut, position + 1);
    }
    if (cut < 1) cut = maxCharacters;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces.map((piece) => {
    if (piece.length <= lineCharacters) return piece;
    let cut = lineCharacters;
    const punctuation = Math.max(
      piece.lastIndexOf('、', lineCharacters),
      piece.lastIndexOf('。', lineCharacters),
      piece.lastIndexOf('？', lineCharacters),
      piece.lastIndexOf('！', lineCharacters),
    );
    if (punctuation >= Math.floor(lineCharacters * 0.55)) cut = punctuation + 1;
    return `${piece.slice(0, cut)}\n${piece.slice(cut)}`;
  });
}

function quantize(seconds, frameRate) {
  return Math.round(seconds * frameRate) / frameRate;
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((row) => row.end > row.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const row of sorted) {
    const prior = merged.at(-1);
    if (prior && row.start <= prior.end + 0.001) prior.end = Math.max(prior.end, row.end);
    else merged.push({ ...row });
  }
  return merged;
}

export function buildFullCaptionEditorialIr({ editorialIr, transcript, corrections = DEFAULT_CORRECTIONS }) {
  const frameRate = Number(editorialIr?.timeline?.frameRate || 30);
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error('Invalid timeline frame rate');
  const operations = editorialIr?.timeline?.operations;
  if (!Array.isArray(operations)) throw new Error('Editorial IR timeline.operations is required');
  const selects = operations
    .filter((operation) => operation?.type === 'select_range' && operation.enabled !== false)
    .sort((left, right) => Number(left.timelineIn) - Number(right.timelineIn));
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  if (!selects.length || !segments.length) throw new Error('Select ranges and transcript segments are required');

  const rawCaptions = [];
  const speechIntervals = [];
  for (const select of selects) {
    const sourceIn = Number(select.sourceIn);
    const sourceOut = Number(select.sourceOut);
    const timelineIn = Number(select.timelineIn);
    const timelineOut = timelineIn + sourceOut - sourceIn;
    const overlapping = segments
      .filter((segment) => Number(segment.end) > sourceIn && Number(segment.start) < sourceOut)
      .sort((left, right) => Number(left.start) - Number(right.start) || Number(left.end) - Number(right.end));
    let previousRolling = '';
    for (const segment of overlapping) {
      const segmentStart = Math.max(sourceIn, Number(segment.start));
      const segmentEnd = Math.min(sourceOut, Number(segment.end));
      if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd) || segmentEnd - segmentStart < 0.05) continue;
      const currentRolling = cleanText(segment.text);
      if (!currentRolling) continue;
      const delta = incrementalText(previousRolling, currentRolling);
      if (compact(currentRolling).length >= compact(previousRolling).length || !compact(previousRolling).includes(compact(currentRolling))) {
        previousRolling = currentRolling;
      }
      const corrected = applyCorrections(delta, corrections);
      if (!corrected || corrected.length < 1) continue;
      const mappedStart = timelineIn + segmentStart - sourceIn;
      const mappedEnd = timelineIn + segmentEnd - sourceIn;
      speechIntervals.push({ start: mappedStart, end: mappedEnd });
      const chunks = splitReadable(corrected);
      for (const [chunkIndex, text] of chunks.entries()) {
        const start = quantize(mappedStart + chunkIndex * 0.001, frameRate);
        rawCaptions.push({
          start,
          sourceStart: segmentStart,
          sourceEnd: segmentEnd,
          sectionId: String(select.id || ''),
          text,
          sectionEnd: timelineOut,
        });
      }
    }
  }

  rawCaptions.sort((left, right) => left.start - right.start || left.sourceStart - right.sourceStart);
  const captions = [];
  for (const row of rawCaptions) {
    const prior = captions.at(-1);
    if (prior && row.start <= prior.start + 1 / frameRate && compact(row.text) === compact(prior.text)) continue;
    captions.push(row);
  }
  for (let index = 0; index < captions.length; index += 1) {
    const row = captions[index];
    const next = captions[index + 1];
    const nextStart = next && next.start > row.start ? next.start : row.sectionEnd;
    row.end = quantize(Math.min(row.sectionEnd, nextStart), frameRate);
    if (row.end <= row.start) row.end = quantize(Math.min(row.sectionEnd, row.start + 1 / frameRate), frameRate);
  }

  const captionOperations = captions.map((row, index) => ({
    id: `full-caption-${String(index + 1).padStart(3, '0')}`,
    type: 'caption',
    timelineIn: round(row.start, 6),
    timelineOut: round(row.end, 6),
    text: row.text,
    role: 'speech',
    sourceStart: round(row.sourceStart, 3),
    sourceEnd: round(row.sourceEnd, 3),
    sectionId: row.sectionId,
    onsetErrorFrames: round((row.start - (Number(selects.find((select) => String(select.id || '') === row.sectionId)?.timelineIn || 0) + row.sourceStart - Number(selects.find((select) => String(select.id || '') === row.sectionId)?.sourceIn || 0))) * frameRate, 3),
  }));

  const mergedSpeech = mergeIntervals(speechIntervals);
  const speechDuration = mergedSpeech.reduce((sum, row) => sum + row.end - row.start, 0);
  const captionCoverage = mergeIntervals(captionOperations.map((caption) => ({ start: caption.timelineIn, end: caption.timelineOut })))
    .reduce((sum, row) => sum + row.end - row.start, 0);
  const onsetErrors = captionOperations.map((caption) => Math.abs(Number(caption.onsetErrorFrames || 0)));
  const maximumOnsetErrorFrames = onsetErrors.length ? Math.max(...onsetErrors) : null;
  const p95OnsetErrorFrames = onsetErrors.length
    ? [...onsetErrors].sort((left, right) => left - right)[Math.min(onsetErrors.length - 1, Math.floor(onsetErrors.length * 0.95))]
    : null;

  const retained = operations.filter((operation) => operation.type !== 'caption');
  return {
    ...editorialIr,
    schemaVersion: '0.6.0',
    generatedAt: new Date().toISOString(),
    retentionPlan: {
      ...(editorialIr.retentionPlan || {}),
      captionMode: 'full_aligned',
      fullCaptionCount: captionOperations.length,
      captionCoverageRatio: speechDuration > 0 ? round(Math.min(1, captionCoverage / speechDuration), 4) : 0,
      maximumOnsetErrorFrames,
      p95OnsetErrorFrames,
    },
    timeline: {
      ...editorialIr.timeline,
      operations: [...retained, ...captionOperations],
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) {
    const base = {
      timeline: {
        frameRate: 30,
        operations: [{ id: 's1', type: 'select_range', sourceIn: 10, sourceOut: 16, timelineIn: 0 }],
      },
      retentionPlan: {},
    };
    const transcript = { segments: [
      { start: 10, end: 12, text: 'ジョイボイは' },
      { start: 12, end: 14, text: 'ジョイボイは 浦島太郎の可能性' },
      { start: 14, end: 16, text: '浦島太郎の可能性 が高い' },
    ] };
    const result = buildFullCaptionEditorialIr({ editorialIr: base, transcript });
    const captions = result.timeline.operations.filter((operation) => operation.type === 'caption');
    if (captions.length !== 3 || captions[0].timelineIn !== 0 || result.retentionPlan.maximumOnsetErrorFrames > 0.5) {
      throw new Error('full caption builder self-test failed');
    }
    process.stdout.write(`${JSON.stringify({ ok: true, test: 'full-caption-builder', captionCount: captions.length })}\n`);
    return;
  }
  if (!args.ir || !args.transcript || !args.output) usage('Missing required arguments');
  const [editorialIr, transcript] = await Promise.all([
    fs.readFile(path.resolve(args.ir), 'utf8').then(JSON.parse),
    fs.readFile(path.resolve(args.transcript), 'utf8').then(JSON.parse),
  ]);
  let corrections = DEFAULT_CORRECTIONS;
  if (args.corrections) {
    const custom = await fs.readFile(path.resolve(args.corrections), 'utf8').then(JSON.parse);
    if (!Array.isArray(custom)) throw new Error('Corrections must be an array of [from, to] rows');
    corrections = [...DEFAULT_CORRECTIONS, ...custom];
  }
  const result = buildFullCaptionEditorialIr({ editorialIr, transcript, corrections });
  const output = path.resolve(args.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    output,
    captionCount: result.retentionPlan.fullCaptionCount,
    coverageRatio: result.retentionPlan.captionCoverageRatio,
    maximumOnsetErrorFrames: result.retentionPlan.maximumOnsetErrorFrames,
    p95OnsetErrorFrames: result.retentionPlan.p95OnsetErrorFrames,
  }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('Usage: node apply-caption-plan.mjs --ir <base-ir.json> --captions <captions.json> --output <output-ir.json>\n');
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

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${label}: ${value}`);
  return number;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mergeIntervals(intervals) {
  const rows = intervals.slice().sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const row of rows) {
    const prior = merged.at(-1);
    if (prior && row.start <= prior.end + 0.001) prior.end = Math.max(prior.end, row.end);
    else merged.push({ ...row });
  }
  return merged;
}

export function applyCaptionPlan({ editorialIr, captions }) {
  const frameRate = finite(editorialIr?.timeline?.frameRate || 30, 'frameRate');
  const durationSeconds = finite(editorialIr?.timeline?.durationSeconds, 'timeline duration');
  if (!Array.isArray(captions) || !captions.length) throw new Error('Caption plan must be a non-empty array');
  const normalized = captions.map((caption, index) => {
    const originalStart = finite(caption.timelineIn, `caption ${index} timelineIn`);
    const originalEnd = finite(caption.timelineOut, `caption ${index} timelineOut`);
    const startFrame = Math.round(originalStart * frameRate);
    const endFrame = Math.round(originalEnd * frameRate);
    const text = String(caption.text || '').trim();
    if (!text || startFrame < 0 || endFrame <= startFrame || endFrame > Math.round(durationSeconds * frameRate)) {
      throw new Error(`Invalid caption ${index + 1}`);
    }
    const lines = text.split('\n');
    if (lines.length > 2) throw new Error(`Caption ${index + 1} exceeds two lines`);
    return {
      id: `full-caption-${String(index + 1).padStart(3, '0')}`,
      type: 'caption',
      timelineIn: round(startFrame / frameRate),
      timelineOut: round(endFrame / frameRate),
      text,
      role: 'speech',
      onsetErrorFrames: round(startFrame - originalStart * frameRate, 3),
      maximumLineCharacters: Math.max(...lines.map((line) => [...line].length)),
    };
  }).sort((left, right) => left.timelineIn - right.timelineIn || left.timelineOut - right.timelineOut);

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (current.timelineIn < previous.timelineIn) throw new Error('Caption plan is not sorted');
    if (current.timelineIn < previous.timelineOut - 1 / frameRate) throw new Error(`Captions overlap by more than one frame at ${current.id}`);
  }

  const covered = mergeIntervals(normalized.map((caption) => ({ start: caption.timelineIn, end: caption.timelineOut })))
    .reduce((sum, row) => sum + row.end - row.start, 0);
  const errors = normalized.map((caption) => Math.abs(caption.onsetErrorFrames));
  const sortedErrors = errors.slice().sort((left, right) => left - right);
  const maximumOnsetErrorFrames = Math.max(...errors);
  const p95OnsetErrorFrames = sortedErrors[Math.min(sortedErrors.length - 1, Math.floor(sortedErrors.length * 0.95))];
  const maximumLineCharacters = Math.max(...normalized.map((caption) => caption.maximumLineCharacters));
  const operations = editorialIr.timeline.operations.filter((operation) => operation.type !== 'caption');
  return {
    ...editorialIr,
    schemaVersion: '0.6.0',
    generatedAt: new Date().toISOString(),
    retentionPlan: {
      ...(editorialIr.retentionPlan || {}),
      captionMode: 'full_aligned',
      captionSource: 'human_corrected_plan',
      fullCaptionCount: normalized.length,
      captionCoverageRatio: round(Math.min(1, covered / durationSeconds), 4),
      maximumOnsetErrorFrames,
      p95OnsetErrorFrames,
      maximumCaptionLineCharacters: maximumLineCharacters,
    },
    timeline: {
      ...editorialIr.timeline,
      operations: [...operations, ...normalized.map(({ maximumLineCharacters: _ignored, ...caption }) => caption)],
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) {
    const editorialIr = { retentionPlan: {}, timeline: { frameRate: 30, durationSeconds: 4, operations: [{ type: 'select_range', sourceIn: 0, sourceOut: 4, timelineIn: 0 }] } };
    const result = applyCaptionPlan({ editorialIr, captions: [
      { timelineIn: 0, timelineOut: 2, text: 'テスト前半' },
      { timelineIn: 2, timelineOut: 4, text: 'テスト後半' },
    ] });
    if (result.retentionPlan.captionCoverageRatio !== 1 || result.retentionPlan.maximumOnsetErrorFrames !== 0) throw new Error('caption plan self-test failed');
    process.stdout.write(`${JSON.stringify({ ok: true, test: 'caption-plan-application' })}\n`);
    return;
  }
  if (!args.ir || !args.captions || !args.output) usage('Missing required arguments');
  const [editorialIr, captions] = await Promise.all([
    fs.readFile(path.resolve(args.ir), 'utf8').then(JSON.parse),
    fs.readFile(path.resolve(args.captions), 'utf8').then(JSON.parse),
  ]);
  const result = applyCaptionPlan({ editorialIr, captions });
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
    maximumCaptionLineCharacters: result.retentionPlan.maximumCaptionLineCharacters,
  }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});

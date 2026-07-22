#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getQualityLabData, scoreAssessment } from './quality-rubric.mjs';

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('Usage: node score-quality-assessment.mjs --input <assessment.json> --output <report.json>\n');
  process.exit(2);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--self-test') {
      result.selfTest = true;
      continue;
    }
    if (!token.startsWith('--')) usage(`Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for ${token}`);
    result[token.slice(2)] = value;
    index += 1;
  }
  return result;
}

export function buildQualityAssessmentReport(input, evaluatedAt = new Date().toISOString()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Assessment input must be an object');
  const profileId = String(input.profileId || 'explainer');
  const data = getQualityLabData(profileId);
  const knownCriteria = new Set(data.categories.flatMap((category) => category.criteria.map((criterion) => criterion.id)));
  const levels = input.levels && typeof input.levels === 'object' && !Array.isArray(input.levels) ? input.levels : {};
  const unknownCriteria = Object.keys(levels).filter((id) => !knownCriteria.has(id));
  if (unknownCriteria.length) throw new Error(`Unknown criteria: ${unknownCriteria.join(', ')}`);
  const missingCriteria = [...knownCriteria].filter((id) => !Object.hasOwn(levels, id));
  if (missingCriteria.length) throw new Error(`Missing criteria: ${missingCriteria.join(', ')}`);
  for (const [id, level] of Object.entries(levels)) {
    if (!Number.isInteger(Number(level)) || Number(level) < 0 || Number(level) > 4) {
      throw new Error(`Criterion ${id} must be an integer from 0 to 4`);
    }
  }
  const activeGates = Array.isArray(input.activeGates) ? input.activeGates.map(String) : [];
  const score = scoreAssessment({ profileId, levels, activeGates });
  const categories = score.categoryScores.map((row) => {
    const category = data.categories.find((candidate) => candidate.id === row.id);
    return {
      ...row,
      name: category?.name || row.id,
      criteria: category?.criteria.map((criterion) => ({
        id: criterion.id,
        name: criterion.name,
        level: Number(levels[criterion.id]),
        maxPoints: criterion.maxPoints,
        note: String(input.notes?.[criterion.id] || ''),
      })) || [],
    };
  });
  return {
    version: 'quality-assessment.v1',
    projectId: String(input.projectId || 'unknown'),
    releaseId: String(input.releaseId || ''),
    evaluatedAt,
    profile: data.profile,
    rubricVersion: data.version,
    criterionCount: data.criterionCount,
    rawScore: score.rawScore,
    finalScore: score.finalScore,
    scoreCap: score.cap,
    band: score.band,
    activeGates: score.activeGates,
    humanScore: Number.isFinite(input.humanScore) ? Number(input.humanScore) : null,
    scoringPolicy: '制作品質の厳格な内部評価。人間視聴スコアと公開実績スコアは別管理。',
    categories,
    metrics: input.metrics && typeof input.metrics === 'object' ? input.metrics : {},
    strengths: Array.isArray(input.strengths) ? input.strengths.map(String) : [],
    weaknesses: Array.isArray(input.weaknesses) ? input.weaknesses.map(String) : [],
    nextActions: Array.isArray(input.nextActions) ? input.nextActions.map(String) : [],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const data = getQualityLabData('explainer');
    const levels = Object.fromEntries(data.categories.flatMap((category) => category.criteria.map((criterion) => [criterion.id, 2])));
    const report = buildQualityAssessmentReport({ projectId: 'test', profileId: 'explainer', levels, activeGates: ['human-review-missing'] }, '2026-07-22T00:00:00.000Z');
    if (report.criterionCount !== 82 || report.rawScore !== 50 || report.finalScore !== 50) throw new Error('quality assessment self-test failed');
    process.stdout.write(`${JSON.stringify({ ok: true, test: 'quality-assessment', score: report.finalScore })}\n`);
    return;
  }
  if (!args.input || !args.output) usage('Missing required arguments');
  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const report = buildQualityAssessmentReport(input);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ok: true, output: outputPath, rawScore: report.rawScore, finalScore: report.finalScore, band: report.band.label }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('Usage: node build-retention-edit.mjs --project <id> --plan <plan.json> --output <editorial-ir.json>\n');
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

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeTimedOperation(operation, index, durationSeconds) {
  const timelineIn = finite(operation.timelineIn, `operation ${operation.id || index} timelineIn`);
  const timelineOut = finite(operation.timelineOut, `operation ${operation.id || index} timelineOut`);
  if (timelineIn < 0 || timelineOut <= timelineIn || timelineOut > durationSeconds + 0.05) {
    throw new Error(`Timed operation ${operation.id || index} is outside the edit timeline`);
  }
  const text = operation.text === undefined ? undefined : String(operation.text).trim();
  if (operation.type !== 'visual_effect' && !text) throw new Error(`Timed operation ${operation.id || index} requires text`);
  return {
    ...operation,
    id: String(operation.id || `${operation.type}-${index + 1}`),
    timelineIn: round(timelineIn),
    timelineOut: round(timelineOut),
    ...(text === undefined ? {} : { text }),
  };
}

export function buildRetentionEditorialIr({ projectId, plan, generatedAt = new Date().toISOString() }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(projectId)) throw new Error('Invalid project id');
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Plan must be an object');
  const frameRate = finite(plan.frameRate || 30, 'frameRate');
  const sourceDurationSeconds = finite(plan.sourceDurationSeconds, 'sourceDurationSeconds');
  const assetId = String(plan.assetId || 'cam-a');
  const sections = Array.isArray(plan.sections) ? plan.sections : [];
  if (!sections.length) throw new Error('Plan requires at least one section');

  let cursor = 0;
  const selects = sections.map((section, index) => {
    const sourceIn = finite(section.sourceIn, `section ${section.id || index} sourceIn`);
    const sourceOut = finite(section.sourceOut, `section ${section.id || index} sourceOut`);
    if (sourceIn < 0 || sourceOut <= sourceIn || sourceOut > sourceDurationSeconds + 0.05) {
      throw new Error(`Section ${section.id || index} is outside the source media`);
    }
    const duration = sourceOut - sourceIn;
    if (duration < 0.3) throw new Error(`Section ${section.id || index} is shorter than 0.3 seconds`);
    const operation = {
      id: String(section.id || `section-${index + 1}`),
      type: 'select_range',
      assetId,
      sourceIn: round(sourceIn),
      sourceOut: round(sourceOut),
      timelineIn: round(cursor),
      reason: String(section.reason || section.label || 'retention_restructure'),
      section: String(section.label || section.id || `Section ${index + 1}`),
    };
    cursor += duration;
    return operation;
  });
  const durationSeconds = round(cursor, 6);
  const timed = [
    ...(Array.isArray(plan.captions) ? plan.captions : []).map((row) => ({ ...row, type: 'caption' })),
    ...(Array.isArray(plan.overlays) ? plan.overlays : []),
    ...(Array.isArray(plan.visualEffects) ? plan.visualEffects.map((row) => ({ ...row, type: 'visual_effect' })) : []),
  ].map((operation, index) => normalizeTimedOperation(operation, index, durationSeconds));

  const operations = [...selects, ...timed];
  return {
    schemaVersion: '0.5.0',
    projectId,
    intent: String(plan.intent || '視聴維持を優先して結論先出し・章構成・要点字幕へ再編集'),
    generatedAt,
    source: {
      assetId,
      durationSeconds: sourceDurationSeconds,
    },
    audio: {
      processing: String(plan.audioProcessing || 'voice_youtube'),
    },
    retentionPlan: {
      targetScore: finite(plan.targetScore || 60, 'targetScore'),
      captionMode: String(plan.captionMode || 'key_points_manual'),
      visualEvidenceMode: String(plan.visualEvidenceMode || 'source_only'),
      humanSemanticReview: Boolean(plan.humanSemanticReview),
      sectionCount: selects.length,
      chapterCount: timed.filter((operation) => operation.type === 'chapter').length,
      hookAtSeconds: timed.find((operation) => operation.type === 'title_card')?.timelineIn ?? null,
      ctaAtSeconds: timed.find((operation) => operation.type === 'cta')?.timelineIn ?? null,
    },
    timeline: {
      frameRate,
      durationSeconds,
      operations,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) {
    const ir = buildRetentionEditorialIr({
      projectId: 'retention-test',
      generatedAt: '2026-07-21T00:00:00.000Z',
      plan: {
        sourceDurationSeconds: 20,
        sections: [
          { id: 'hook', sourceIn: 5, sourceOut: 9 },
          { id: 'body', sourceIn: 10, sourceOut: 16 },
        ],
        overlays: [
          { id: 'hook-title', type: 'title_card', timelineIn: 0, timelineOut: 2, text: '結論' },
          { id: 'cta', type: 'cta', timelineIn: 8, timelineOut: 10, text: 'どう思う？' },
        ],
        visualEffects: [{ id: 'zoom', timelineIn: 0, timelineOut: 4, scale: 1.08 }],
      },
    });
    const selects = ir.timeline.operations.filter((operation) => operation.type === 'select_range');
    if (ir.timeline.durationSeconds !== 10 || selects[1].timelineIn !== 4) throw new Error('retention builder self-test failed');
    process.stdout.write(`${JSON.stringify({ ok: true, test: 'retention-edit-builder' })}\n`);
    return;
  }
  const projectId = String(args.project || '').trim();
  const planPath = path.resolve(String(args.plan || ''));
  const outputPath = path.resolve(String(args.output || ''));
  if (!projectId || !args.plan || !args.output) usage('Missing required arguments');
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  const editorialIr = buildRetentionEditorialIr({ projectId, plan });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(editorialIr, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectId,
    output: outputPath,
    durationSeconds: editorialIr.timeline.durationSeconds,
    sectionCount: editorialIr.retentionPlan.sectionCount,
    chapterCount: editorialIr.retentionPlan.chapterCount,
    operationCount: editorialIr.timeline.operations.length,
  }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});

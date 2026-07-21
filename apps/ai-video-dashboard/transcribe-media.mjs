#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseCommandArgs, resolveTranscript } from './transcription-adapters.mjs';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
    const key = token.slice(2);
    if (key === 'dry-run' || key === 'no-auto-sidecar') {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function required(options, key) {
  const value = String(options[key] || '').trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mediaPath = path.resolve(required(options, 'media'));
  if (!existsSync(mediaPath)) throw new Error(`Media file not found: ${mediaPath}`);
  const transcriptPath = options.transcript ? path.resolve(String(options.transcript)) : undefined;
  const command = options.command ? {
    executable: String(options.command),
    args: parseCommandArgs(options['command-args-json']),
    format: String(options.format || 'json'),
    provider: options.provider ? String(options.provider) : undefined,
    timeoutMs: options['timeout-ms'] ? Number(options['timeout-ms']) : undefined,
    cwd: options.cwd ? String(options.cwd) : undefined,
  } : undefined;
  const resolved = await resolveTranscript({
    mediaPath,
    transcriptPath,
    autoSidecar: !options['no-auto-sidecar'],
    command,
  });
  if (resolved.source === 'none') {
    throw new Error('No transcript sidecar or command adapter was available');
  }
  const mediaExtension = path.extname(mediaPath);
  const mediaBase = mediaExtension ? mediaPath.slice(0, -mediaExtension.length) : mediaPath;
  const outputPath = path.resolve(String(options.output || `${mediaBase}.transcript.json`));
  if (!options['dry-run']) await writeJsonAtomic(outputPath, resolved.transcript);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mediaPath,
    outputPath: options['dry-run'] ? null : outputPath,
    source: resolved.source,
    sourcePath: resolved.sourcePath,
    format: resolved.format,
    provider: resolved.transcript.provider,
    language: resolved.transcript.language,
    segmentCount: resolved.transcript.segments.length,
    dryRun: Boolean(options['dry-run']),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});

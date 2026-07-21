import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { normalizeTranscript } from './analysis-core.mjs';

const execFileAsync = promisify(execFile);
const TRANSCRIPT_EXTENSIONS = new Set(['.json', '.srt', '.vtt']);

export function parseTranscriptTimestamp(value) {
  const match = String(value || '').trim().match(/(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})/u);
  if (!match) return undefined;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function parseTimedText(text, format = 'srt') {
  const provider = String(format || 'srt').replace(/^\./u, '').toLowerCase();
  const cleaned = String(text || '')
    .replace(/^\uFEFF/u, '')
    .replace(/^WEBVTT[^\n]*\n+/u, '')
    .trim();
  const blocks = cleaned ? cleaned.split(/\n\s*\n/u) : [];
  const segments = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const [startText, endText] = lines[timingIndex].split('-->').map((part) => part.trim().split(/\s+/u)[0]);
    const start = parseTranscriptTimestamp(startText);
    const end = parseTranscriptTimestamp(endText);
    const content = lines
      .slice(timingIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/gu, '')
      .replace(/&nbsp;/giu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (start === undefined || end === undefined || end <= start || !content) continue;
    segments.push({ start, end, speaker: 'speaker-1', text: content });
  }
  return normalizeTranscript({ language: 'und', provider, segments });
}

export function parseTranscriptPayload(text, format = 'json', provider) {
  const normalizedFormat = String(format || 'json').replace(/^\./u, '').toLowerCase();
  let transcript;
  if (normalizedFormat === 'json') transcript = normalizeTranscript(JSON.parse(String(text || '')));
  else if (normalizedFormat === 'srt' || normalizedFormat === 'vtt') transcript = parseTimedText(text, normalizedFormat);
  else throw new Error(`Unsupported transcript format: ${normalizedFormat}`);
  return provider ? { ...transcript, provider: String(provider) } : transcript;
}

export async function loadTranscriptFile(file) {
  const absolute = path.resolve(String(file || ''));
  const extension = path.extname(absolute).toLowerCase();
  if (!TRANSCRIPT_EXTENSIONS.has(extension)) throw new Error(`Unsupported transcript format: ${extension || '(none)'}`);
  const text = await fs.readFile(absolute, 'utf8');
  const transcript = parseTranscriptPayload(text, extension.slice(1));
  return { transcript, source: 'sidecar', sourcePath: absolute, format: extension.slice(1) };
}

export function transcriptSidecarCandidates(mediaPath) {
  const absolute = path.resolve(String(mediaPath || ''));
  const extension = path.extname(absolute);
  const base = extension ? absolute.slice(0, -extension.length) : absolute;
  return [
    `${base}.transcript.json`,
    `${base}.srt`,
    `${base}.vtt`,
    `${base}.json`,
  ];
}

export async function findTranscriptSidecar(mediaPath) {
  for (const candidate of transcriptSidecarCandidates(mediaPath)) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function parseCommandArgs(value) {
  if (value === undefined || value === null || value === '') return [];
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('Transcript command args must be a JSON array of strings');
  }
  return parsed;
}

function commandProvider(executable, provider) {
  return String(provider || `command:${path.basename(executable)}`);
}

export async function transcribeWithCommand({
  mediaPath,
  executable,
  args = [],
  format = 'json',
  provider,
  timeoutMs = 10 * 60_000,
  cwd,
}) {
  const media = path.resolve(String(mediaPath || ''));
  const command = path.resolve(String(executable || ''));
  if (!existsSync(media)) throw new Error(`Media file not found: ${media}`);
  if (!path.isAbsolute(String(executable || '')) || !existsSync(command)) {
    throw new Error('Transcript command must be an existing absolute executable path');
  }
  const normalizedArgs = parseCommandArgs(args).map((value) => value.replaceAll('{media}', media));
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > 60 * 60_000) {
    throw new Error('Transcript command timeout must be between 1000 and 3600000 ms');
  }
  const { stdout, stderr } = await execFileAsync(command, normalizedArgs, {
    cwd: cwd ? path.resolve(String(cwd)) : undefined,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
  if (!String(stdout || '').trim()) {
    throw new Error(`Transcript command produced no stdout${stderr ? `: ${String(stderr).slice(0, 300)}` : ''}`);
  }
  const transcript = parseTranscriptPayload(stdout, format, commandProvider(command, provider));
  return {
    transcript,
    source: 'command',
    sourcePath: command,
    format: String(format || 'json').replace(/^\./u, '').toLowerCase(),
    stderr: String(stderr || '').trim().slice(0, 1000),
  };
}

export async function resolveTranscript({
  mediaPath,
  transcriptPath,
  autoSidecar = true,
  command,
}) {
  if (transcriptPath) return loadTranscriptFile(transcriptPath);
  if (autoSidecar) {
    const discovered = await findTranscriptSidecar(mediaPath);
    if (discovered) return loadTranscriptFile(discovered);
  }
  if (command?.executable) {
    return transcribeWithCommand({
      mediaPath,
      executable: command.executable,
      args: command.args || [],
      format: command.format || 'json',
      provider: command.provider,
      timeoutMs: command.timeoutMs,
      cwd: command.cwd,
    });
  }
  return {
    transcript: normalizeTranscript({ language: 'und', provider: 'none', segments: [] }),
    source: 'none',
    sourcePath: null,
    format: null,
  };
}

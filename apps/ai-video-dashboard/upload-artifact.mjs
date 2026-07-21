import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DATA_DIR = process.env.AIVIDEO_DATA_DIR || path.join(ROOT, 'data');
const DRIVE_REMOTE = process.env.AIVIDEO_DRIVE_REMOTE || 'grive:';
const DRIVE_BASE = process.env.AIVIDEO_DRIVE_BASE || 'AI-Video-Production-OS/Test-Artifacts';

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node upload-artifact.mjs --project <id> --file <path> [--kind preview|fixture|ir|qc|export] [--label <text>] [--note <text>]');
  process.exit(2);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) usage(`Unknown argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function safeProjectId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temporary, file);
}

const args = parseArgs(process.argv.slice(2));
if (!safeProjectId(args.project)) usage('Invalid --project');
if (!args.file) usage('Missing --file');

const source = path.resolve(args.file);
const stat = await fs.stat(source).catch(() => null);
if (!stat?.isFile()) usage(`File not found: ${source}`);

const now = new Date();
const datePath = now.toISOString().slice(0, 10);
const filename = path.basename(source).replace(/[^a-zA-Z0-9._-]+/g, '-');
const remotePath = `${DRIVE_BASE}/${datePath}/${args.project}/${filename}`;
const destination = `${DRIVE_REMOTE}${remotePath}`;

await execFileAsync('rclone', ['copyto', source, destination, '--retries', '3', '--low-level-retries', '5', '--checksum'], { timeout: 10 * 60_000 });
const { stdout } = await execFileAsync('rclone', ['link', destination], { timeout: 60_000 });
const url = stdout.trim();
if (!/^https:\/\//.test(url)) throw new Error(`rclone did not return a share link: ${url}`);

const manifestFile = path.join(DATA_DIR, 'projects', args.project, 'artifacts.json');
const manifest = await readJson(manifestFile, { version: 1, artifacts: [] });
const checksum = await sha256(source);
const artifact = {
  id: crypto.randomUUID(),
  kind: args.kind || 'artifact',
  label: args.label || filename,
  note: args.note || '',
  filename,
  bytes: stat.size,
  sha256: checksum,
  drivePath: remotePath,
  url,
  createdAt: now.toISOString(),
};
manifest.version = 1;
manifest.updatedAt = artifact.createdAt;
manifest.artifacts = [artifact, ...(Array.isArray(manifest.artifacts) ? manifest.artifacts : [])]
  .filter((item, index, items) => index === items.findIndex((candidate) => candidate.sha256 === item.sha256 && candidate.kind === item.kind));
await writeJsonAtomic(manifestFile, manifest);

console.log(JSON.stringify({ ok: true, projectId: args.project, artifact, manifestFile }, null, 2));

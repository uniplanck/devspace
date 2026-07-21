import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = process.env.AIVIDEO_DATA_DIR || path.join(ROOT, 'data');
const DEFAULT_DRIVE_REMOTE = process.env.AIVIDEO_DRIVE_REMOTE || 'grive:';
const DEFAULT_DRIVE_BASE = process.env.AIVIDEO_DRIVE_BASE || 'AI-Video-Production-OS/Test-Artifacts';

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('Usage: node upload-artifact.mjs --project <id> --file <path> [--kind preview|fixture|ir|qc|export] [--label <text>] [--note <text>]\n');
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
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

export async function uploadArtifact(options) {
  const projectId = String(options.projectId || '');
  if (!safeProjectId(projectId)) throw new Error('Invalid projectId');
  const source = path.resolve(String(options.file || ''));
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isFile()) throw new Error(`File not found: ${source}`);

  const dataDir = path.resolve(String(options.dataDir || DEFAULT_DATA_DIR));
  const driveRemote = String(options.driveRemote || DEFAULT_DRIVE_REMOTE);
  const driveBase = String(options.driveBase || DEFAULT_DRIVE_BASE).replace(/^\/+|\/+$/g, '');
  const now = new Date();
  const datePath = now.toISOString().slice(0, 10);
  const filename = path.basename(source).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const remotePath = `${driveBase}/${datePath}/${projectId}/${filename}`;
  const destination = `${driveRemote}${remotePath}`;

  await execFileAsync('rclone', [
    'copyto', source, destination,
    '--retries', '3',
    '--low-level-retries', '5',
    '--checksum',
  ], { timeout: 10 * 60_000, maxBuffer: 2_000_000 });
  const { stdout } = await execFileAsync('rclone', ['link', destination], { timeout: 60_000, maxBuffer: 1_000_000 });
  const url = stdout.trim();
  if (!/^https:\/\//.test(url)) throw new Error(`rclone did not return a share link: ${url}`);

  const manifestFile = path.join(dataDir, 'projects', projectId, 'artifacts.json');
  const manifest = await readJson(manifestFile, { version: 1, artifacts: [] });
  const checksum = await sha256(source);
  const artifact = {
    id: crypto.randomUUID(),
    kind: String(options.kind || 'artifact'),
    label: String(options.label || filename),
    note: String(options.note || ''),
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
  return { ok: true, projectId, artifact, manifestFile };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) usage('Missing --project');
  if (!args.file) usage('Missing --file');
  const result = await uploadArtifact({
    projectId: args.project,
    file: args.file,
    kind: args.kind,
    label: args.label,
    note: args.note,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}

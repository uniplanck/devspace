#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_FFMPEG = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';
const DEFAULT_FFPROBE = process.env.FFPROBE_PATH || '/usr/local/bin/ffprobe';

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('Usage: node mix-retention-audio.mjs --video <input.mp4> --bgm <music.mp3> --sfx-plan <events.json> --sfx-bindings <bindings.json> --output <output.mp4>\n');
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

async function probe(file, ffprobePath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height',
    '-of', 'json',
    file,
  ], { timeout: 30_000, maxBuffer: 2_000_000 });
  const data = JSON.parse(stdout);
  const durationSeconds = Number(data.format?.duration || 0);
  const video = (data.streams || []).find((stream) => stream.codec_type === 'video');
  const audio = (data.streams || []).find((stream) => stream.codec_type === 'audio');
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`Invalid media duration: ${file}`);
  return {
    durationSeconds,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
  };
}

export function buildAudioMixPlan({ durationSeconds, events, bindings, bgmGainDb = -22, bgmAutomation = [], bgmStartSeconds = 0 }) {
  if (!Array.isArray(events)) throw new Error('SFX plan must be an array');
  const normalized = events.map((event, index) => {
    const assetKey = String(event.assetKey || '').trim();
    const timelineIn = finite(event.timelineIn, `event ${index} timelineIn`);
    const gainDb = finite(event.gainDb ?? -11, `event ${index} gainDb`);
    if (!assetKey || !bindings[assetKey]) throw new Error(`Missing SFX binding for ${assetKey || index}`);
    if (timelineIn < 0 || timelineIn >= durationSeconds) throw new Error(`SFX event ${index} is outside the timeline`);
    if (gainDb > 0 || gainDb < -40) throw new Error(`SFX event ${index} gain is outside -40..0 dB`);
    return {
      id: String(event.id || `sfx-${index + 1}`),
      assetKey,
      path: path.resolve(String(bindings[assetKey])),
      timelineIn,
      gainDb,
    };
  });
  if (bgmGainDb > -12 || bgmGainDb < -45) throw new Error('BGM gain must be between -45 and -12 dB');
  const startSeconds = finite(bgmStartSeconds, 'BGM start seconds');
  if (startSeconds < 0) throw new Error('BGM start seconds must be non-negative');
  const automation = (Array.isArray(bgmAutomation) ? bgmAutomation : []).map((row, index) => {
    const timelineIn = finite(row.timelineIn, `BGM automation ${index} timelineIn`);
    const timelineOut = finite(row.timelineOut, `BGM automation ${index} timelineOut`);
    const gainDb = finite(row.gainDb, `BGM automation ${index} gainDb`);
    if (timelineIn < 0 || timelineOut <= timelineIn || timelineOut > durationSeconds + 0.05) {
      throw new Error(`BGM automation ${index} is outside the timeline`);
    }
    if (gainDb > -12 || gainDb < -45) throw new Error(`BGM automation ${index} gain is outside -45..-12 dB`);
    return { timelineIn, timelineOut, gainDb };
  }).sort((left, right) => left.timelineIn - right.timelineIn);
  return { durationSeconds, bgmGainDb, bgmStartSeconds: startSeconds, bgmAutomation: automation, events: normalized };
}

export async function mixRetentionAudio(options) {
  const videoPath = path.resolve(options.video);
  const bgmPath = path.resolve(options.bgm);
  const outputPath = path.resolve(options.output);
  const [video, bgm, sfxPayload, bindings] = await Promise.all([
    probe(videoPath, options.ffprobe || DEFAULT_FFPROBE),
    probe(bgmPath, options.ffprobe || DEFAULT_FFPROBE),
    fs.readFile(path.resolve(options.sfxPlan), 'utf8').then(JSON.parse),
    fs.readFile(path.resolve(options.sfxBindings), 'utf8').then(JSON.parse),
  ]);
  const events = Array.isArray(sfxPayload) ? sfxPayload : sfxPayload?.events;
  const bgmAutomation = Array.isArray(sfxPayload) ? [] : sfxPayload?.bgmAutomation;
  const bgmStartSeconds = Array.isArray(sfxPayload) ? 0 : sfxPayload?.bgmStartSeconds;
  if (!video.hasVideo || !video.hasAudio) throw new Error('Input video must contain video and audio');
  if (!bgm.hasAudio) throw new Error('BGM file has no audio stream');
  const plan = buildAudioMixPlan({
    durationSeconds: video.durationSeconds,
    events,
    bindings,
    bgmGainDb: options.bgmGainDb === undefined ? -22 : Number(options.bgmGainDb),
    bgmAutomation,
    bgmStartSeconds,
  });
  for (const event of plan.events) await fs.access(event.path);

  const uniqueSfx = [...new Map(plan.events.map((event) => [event.assetKey, event.path])).entries()];
  const sfxInputIndex = new Map(uniqueSfx.map(([key], index) => [key, index + 2]));
  const lines = [];
  lines.push('[0:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asplit=2[voice][voicekey]');
  const fadeOutStart = Math.max(0, plan.durationSeconds - 1.2);
  let bgmChain = `[1:a]atrim=start=${round(plan.bgmStartSeconds, 6)}:duration=${round(plan.durationSeconds, 6)},asetpts=PTS-STARTPTS,`
    + `aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,`
    + `highpass=f=100,lowpass=f=14000,volume=${plan.bgmGainDb}dB`;
  for (const row of plan.bgmAutomation) {
    const deltaDb = round(row.gainDb - plan.bgmGainDb, 3);
    if (Math.abs(deltaDb) < 0.001) continue;
    bgmChain += `,volume=${deltaDb}dB:enable='between(t,${round(row.timelineIn, 6)},${round(row.timelineOut, 6)})'`;
  }
  bgmChain += `,afade=t=in:st=0:d=0.8,afade=t=out:st=${round(fadeOutStart, 3)}:d=1.2[bgmraw]`;
  lines.push(bgmChain);
  lines.push('[bgmraw][voicekey]sidechaincompress=threshold=0.06:ratio=3:attack=10:release=260:makeup=1.15[bgmducked]');

  const mixLabels = ['[voice]', '[bgmducked]'];
  for (const [index, event] of plan.events.entries()) {
    const inputIndex = sfxInputIndex.get(event.assetKey);
    const delayMs = Math.round(event.timelineIn * 1000);
    lines.push(
      `[${inputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,`
      + `volume=${event.gainDb}dB,adelay=delays=${delayMs}:all=1[sfx${index}]`,
    );
    mixLabels.push(`[sfx${index}]`);
  }
  lines.push(
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0,`
    + 'loudnorm=I=-15:LRA=7:TP=-2.5,alimiter=limit=0.88[aout]',
  );

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-i', bgmPath];
  for (const [, sfxPath] of uniqueSfx) args.push('-i', sfxPath);
  args.push(
    '-filter_complex', lines.join(';'),
    '-map', '0:v:0', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', outputPath,
  );
  await execFileAsync(options.ffmpeg || DEFAULT_FFMPEG, args, { timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  const rendered = await probe(outputPath, options.ffprobe || DEFAULT_FFPROBE);
  const durationError = Math.abs(rendered.durationSeconds - video.durationSeconds);
  if (!rendered.hasVideo || !rendered.hasAudio || durationError > 0.12) {
    throw new Error(`Mixed output failed validation; duration error=${durationError}`);
  }
  return {
    ok: true,
    output: outputPath,
    durationSeconds: round(rendered.durationSeconds),
    durationErrorSeconds: round(durationError),
    bgm: {
      path: bgmPath,
      gainDb: plan.bgmGainDb,
      startSeconds: plan.bgmStartSeconds,
      automation: plan.bgmAutomation,
      sidechain: { threshold: 0.06, ratio: 3, attackMs: 10, releaseMs: 260 },
    },
    soundEffectCount: plan.events.length,
    soundEffectAssets: uniqueSfx.map(([assetKey, file]) => ({ assetKey, path: file })),
    finalTarget: { integratedLufs: -15, truePeakDbtp: -2.5, loudnessRange: 7 },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) {
    const plan = buildAudioMixPlan({
      durationSeconds: 20,
      bgmGainDb: -28,
      bindings: { sweep: '/tmp/sweep.wav' },
      events: [{ id: 'chapter', assetKey: 'sweep', timelineIn: 5, gainDb: -18 }],
      bgmStartSeconds: 12,
      bgmAutomation: [{ timelineIn: 0, timelineOut: 4, gainDb: -25 }],
    });
    if (plan.events.length !== 1 || plan.bgmGainDb !== -28 || plan.events[0].timelineIn !== 5
      || plan.bgmStartSeconds !== 12 || plan.bgmAutomation[0].gainDb !== -25) {
      throw new Error('retention audio mixer self-test failed');
    }
    process.stdout.write(`${JSON.stringify({ ok: true, test: 'retention-audio-mix-plan' })}\n`);
    return;
  }
  if (!args.video || !args.bgm || !args['sfx-plan'] || !args['sfx-bindings'] || !args.output) usage('Missing required arguments');
  process.stdout.write(`${JSON.stringify(await mixRetentionAudio({
    video: args.video,
    bgm: args.bgm,
    sfxPlan: args['sfx-plan'],
    sfxBindings: args['sfx-bindings'],
    output: args.output,
    bgmGainDb: args['bgm-gain-db'],
    ffmpeg: args.ffmpeg,
    ffprobe: args.ffprobe,
  }), null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
});

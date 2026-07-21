import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseCommandArgs,
  parseTimedText,
  resolveTranscript,
  transcribeWithCommand,
  transcriptSidecarCandidates,
} from './transcription-adapters.mjs';

const root = await fs.mkdtemp(path.join(tmpdir(), 'ai-video-transcription-'));
try {
  const media = path.join(root, 'talk.mp4');
  await fs.writeFile(media, 'fixture');
  const candidates = transcriptSidecarCandidates(media);
  assert.deepEqual(candidates.map((value) => path.basename(value)), [
    'talk.transcript.json',
    'talk.srt',
    'talk.vtt',
    'talk.json',
  ]);

  const srt = `1\n00:00:00,000 --> 00:00:01,200\n今日はテストです。\n\n2\n00:00:01,400 --> 00:00:02,900\n<b>えっと</b> 次へ進みます。\n`;
  const srtPath = path.join(root, 'talk.srt');
  await fs.writeFile(srtPath, srt, 'utf8');
  const auto = await resolveTranscript({ mediaPath: media });
  assert.equal(auto.source, 'sidecar');
  assert.equal(auto.format, 'srt');
  assert.equal(auto.transcript.provider, 'srt');
  assert.equal(auto.transcript.segments.length, 2);
  assert.equal(auto.transcript.segments[1].text, 'えっと 次へ進みます。');

  const vtt = parseTimedText(`WEBVTT\n\n00:00:03.000 --> 00:00:04.250 align:start\n<v A>判断を正本にします。</v>\n`, 'vtt');
  assert.equal(vtt.provider, 'vtt');
  assert.equal(vtt.segments[0].start, 3);
  assert.equal(vtt.segments[0].end, 4.25);
  assert.equal(vtt.segments[0].text, '判断を正本にします。');

  await fs.rm(srtPath);
  const command = await transcribeWithCommand({
    mediaPath: media,
    executable: process.execPath,
    args: [
      '-e',
      'const media=process.argv[1];process.stdout.write(JSON.stringify({language:"ja",segments:[{start:0,end:1.5,text:media.endsWith("talk.mp4")?"外部エンジン成功":"失敗",confidence:0.91}]}));',
      '{media}',
    ],
    format: 'json',
    provider: 'test-command',
    timeoutMs: 10_000,
  });
  assert.equal(command.source, 'command');
  assert.equal(command.transcript.provider, 'test-command');
  assert.equal(command.transcript.segments[0].text, '外部エンジン成功');
  assert.equal(command.transcript.segments[0].confidence, 0.91);

  const resolvedCommand = await resolveTranscript({
    mediaPath: media,
    command: {
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("1\\n00:00:00,000 --> 00:00:00,900\\nコマンド字幕\\n")'],
      format: 'srt',
      provider: 'command-srt',
      timeoutMs: 10_000,
    },
  });
  assert.equal(resolvedCommand.transcript.provider, 'command-srt');
  assert.equal(resolvedCommand.transcript.segments[0].text, 'コマンド字幕');

  assert.deepEqual(parseCommandArgs('["--model","small"]'), ['--model', 'small']);
  assert.throws(() => parseCommandArgs('{"bad":true}'), /JSON array of strings/u);

  const none = await resolveTranscript({ mediaPath: media, autoSidecar: false });
  assert.equal(none.source, 'none');
  assert.equal(none.transcript.segments.length, 0);

  console.log('transcription-adapters tests passed');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

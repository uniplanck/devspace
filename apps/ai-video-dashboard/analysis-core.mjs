import crypto from 'node:crypto';

export const DEFAULT_ANALYSIS_POLICY = Object.freeze({
  silenceRemoveMinSeconds: 0.75,
  silenceHandleSeconds: 0.12,
  minimumKeepSeconds: 0.18,
  fillerMaxSeconds: 1.4,
  falseStartMaxSeconds: 2.8,
  repeatedTakeWindowSeconds: 3.0,
  repeatedTakeSimilarity: 0.68,
  captionMinVisibleSeconds: 0.28,
  captionMinCoverage: 0.7,
});

const FILLER_PATTERN = /(?:えー+|えっと+|あの+|その+|まあ+|なんか|うーん+|んー+|uh+|um+|erm+)/giu;
const RETAKE_PATTERN = /(?:言い直し|やり直し|取り直し|もう一度|違う[、。…]*$|いや[、。…]*$|ごめん[、。…]*$|失礼[、。…]*$)/u;

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizedText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(value) {
  const text = normalizedText(value);
  const result = new Set();
  for (let index = 0; index < text.length - 1; index += 1) result.add(text.slice(index, index + 2));
  return result;
}

function similarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / Math.max(a.size, b.size);
}

function evidenceId(prefix, index) {
  return `${prefix}-${String(index + 1).padStart(3, '0')}`;
}

export function normalizeTranscript(input) {
  const source = input && typeof input === 'object' ? input : {};
  const segments = Array.isArray(source.segments) ? source.segments : [];
  const normalized = segments.flatMap((segment, index) => {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    const text = String(segment?.text ?? '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) return [];
    return [{
      id: String(segment.id || evidenceId('segment', index)),
      start: round(Math.max(0, start)),
      end: round(Math.max(0, end)),
      speaker: String(segment.speaker || 'speaker-1'),
      text,
      confidence: Number.isFinite(Number(segment.confidence)) ? clamp(Number(segment.confidence), 0, 1) : undefined,
      words: Array.isArray(segment.words) ? segment.words : undefined,
    }];
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  return {
    language: String(source.language || 'und'),
    provider: String(source.provider || 'sidecar'),
    segments: normalized,
  };
}

export function normalizeSilences(events, durationSeconds) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  return (Array.isArray(events) ? events : []).flatMap((event, index) => {
    const start = clamp(Number(event?.start) || 0, 0, duration);
    const end = clamp(Number(event?.end) || duration, 0, duration);
    if (end <= start) return [];
    return [{
      id: String(event.id || evidenceId('silence', index)),
      start: round(start),
      end: round(end),
      duration: round(end - start),
      confidence: 0.99,
    }];
  }).sort((left, right) => left.start - right.start);
}

export function analyzeTranscript(transcript, policy = DEFAULT_ANALYSIS_POLICY) {
  const segments = normalizeTranscript(transcript).segments;
  const findings = [];
  const autoRemovalCandidates = [];

  segments.forEach((segment, index) => {
    const normalized = normalizedText(segment.text);
    const stripped = normalizedText(segment.text.replace(FILLER_PATTERN, ''));
    const fillerMatches = [...segment.text.matchAll(FILLER_PATTERN)].map((match) => match[0]);
    const duration = segment.end - segment.start;
    const fillerOnly = fillerMatches.length > 0 && stripped.length <= 2 && duration <= policy.fillerMaxSeconds;
    if (fillerMatches.length) {
      const finding = {
        id: evidenceId('filler', findings.length),
        type: fillerOnly ? 'filler_only' : 'filler_present',
        segmentId: segment.id,
        start: segment.start,
        end: segment.end,
        text: segment.text,
        tokens: fillerMatches,
        confidence: fillerOnly ? 0.97 : 0.78,
        autoRemove: fillerOnly,
      };
      findings.push(finding);
      if (fillerOnly) autoRemovalCandidates.push(finding);
    }

    const explicitRetake = RETAKE_PATTERN.test(segment.text) || /(?:、|\s)(?:いや|違う|ごめん)[、。…]*$/u.test(segment.text);
    const incomplete = /(?:…|\.\.\.|、いや|、違う|、ごめん)[。！？!?]*$/u.test(segment.text);
    if ((explicitRetake || incomplete) && duration <= policy.falseStartMaxSeconds) {
      const finding = {
        id: evidenceId('retake', findings.length),
        type: 'false_start',
        segmentId: segment.id,
        start: segment.start,
        end: segment.end,
        text: segment.text,
        confidence: explicitRetake ? 0.93 : 0.84,
        autoRemove: true,
      };
      findings.push(finding);
      autoRemovalCandidates.push(finding);
    }

    const next = segments[index + 1];
    if (!next) return;
    const gap = next.start - segment.end;
    const score = similarity(segment.text, next.text);
    const prefix = normalized.slice(0, 8);
    const repeatedPrefix = prefix.length >= 5 && normalizedText(next.text).startsWith(prefix);
    if (gap <= policy.repeatedTakeWindowSeconds && (score >= policy.repeatedTakeSimilarity || repeatedPrefix)) {
      const finding = {
        id: evidenceId('repeat', findings.length),
        type: 'repeated_take',
        segmentId: segment.id,
        replacementSegmentId: next.id,
        start: segment.start,
        end: segment.end,
        text: segment.text,
        similarity: round(score),
        confidence: repeatedPrefix ? 0.94 : clamp(0.72 + (score - policy.repeatedTakeSimilarity), 0.72, 0.95),
        autoRemove: true,
      };
      findings.push(finding);
      autoRemovalCandidates.push(finding);
    }
  });

  return { findings, autoRemovalCandidates };
}

function mergeRemovalCandidates(candidates, durationSeconds, mergeGapSeconds = 0.03) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const sorted = candidates
    .map((candidate) => ({
      start: clamp(Number(candidate.start), 0, duration),
      end: clamp(Number(candidate.end), 0, duration),
      reasons: [candidate.reason],
      evidenceIds: [...(candidate.evidenceIds || [])],
      confidence: Number(candidate.confidence) || 0.5,
    }))
    .filter((candidate) => candidate.end > candidate.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const candidate of sorted) {
    const previous = merged.at(-1);
    if (previous && candidate.start <= previous.end + mergeGapSeconds) {
      previous.end = Math.max(previous.end, candidate.end);
      previous.reasons = [...new Set([...previous.reasons, ...candidate.reasons])];
      previous.evidenceIds = [...new Set([...previous.evidenceIds, ...candidate.evidenceIds])];
      previous.confidence = Math.max(previous.confidence, candidate.confidence);
    } else {
      merged.push({ ...candidate });
    }
  }
  return merged.map((range, index) => ({
    id: evidenceId('remove', index),
    start: round(range.start),
    end: round(range.end),
    duration: round(range.end - range.start),
    reason: range.reasons.join(' + '),
    evidenceIds: range.evidenceIds,
    confidence: round(range.confidence),
  }));
}

export function planRemovals({ durationSeconds, silences = [], transcript, policy = DEFAULT_ANALYSIS_POLICY }) {
  const normalizedSilence = normalizeSilences(silences, durationSeconds);
  const transcriptAnalysis = analyzeTranscript(transcript, policy);
  const candidates = [];

  for (const silence of normalizedSilence) {
    if (silence.duration < policy.silenceRemoveMinSeconds) continue;
    const start = silence.start === 0 ? 0 : silence.start + policy.silenceHandleSeconds;
    const end = silence.end === durationSeconds ? durationSeconds : silence.end - policy.silenceHandleSeconds;
    if (end - start < policy.minimumKeepSeconds) continue;
    candidates.push({
      start,
      end,
      reason: 'long_silence',
      evidenceIds: [silence.id],
      confidence: silence.confidence,
    });
  }

  for (const finding of transcriptAnalysis.autoRemovalCandidates) {
    candidates.push({
      start: Math.max(0, finding.start - 0.03),
      end: Math.min(durationSeconds, finding.end + 0.03),
      reason: finding.type,
      evidenceIds: [finding.id, finding.segmentId],
      confidence: finding.confidence,
    });
  }

  return {
    silences: normalizedSilence,
    transcriptFindings: transcriptAnalysis.findings,
    removals: mergeRemovalCandidates(candidates, durationSeconds, policy.minimumKeepSeconds),
  };
}

export function subtractRanges(durationSeconds, removals, minimumKeepSeconds = DEFAULT_ANALYSIS_POLICY.minimumKeepSeconds) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const keeps = [];
  let cursor = 0;
  for (const removal of removals) {
    if (removal.start - cursor >= minimumKeepSeconds) keeps.push({ start: round(cursor), end: round(removal.start) });
    cursor = Math.max(cursor, removal.end);
  }
  if (duration - cursor >= minimumKeepSeconds) keeps.push({ start: round(cursor), end: round(duration) });
  let timelineCursor = 0;
  return keeps.map((range, index) => {
    const result = {
      id: evidenceId('keep', index),
      start: range.start,
      end: range.end,
      duration: round(range.end - range.start),
      timelineIn: round(timelineCursor),
    };
    timelineCursor += result.duration;
    return result;
  });
}

function captionForSegment(segment, keeps, policy) {
  let best;
  for (const keep of keeps) {
    const start = Math.max(segment.start, keep.start);
    const end = Math.min(segment.end, keep.end);
    const visible = end - start;
    if (visible <= 0 || (best && visible <= best.visible)) continue;
    best = { keep, start, end, visible };
  }
  if (!best || best.visible < policy.captionMinVisibleSeconds) return null;
  const coverage = best.visible / (segment.end - segment.start);
  if (coverage < policy.captionMinCoverage) return null;
  return {
    timelineIn: round(best.keep.timelineIn + (best.start - best.keep.start)),
    timelineOut: round(best.keep.timelineIn + (best.end - best.keep.start)),
    coverage: round(coverage),
  };
}

export function buildEditorialIr({ projectId, assetId, media, transcript, plan, policy = DEFAULT_ANALYSIS_POLICY, generatedAt = new Date().toISOString() }) {
  const normalizedTranscript = normalizeTranscript(transcript);
  const keeps = subtractRanges(media.durationSeconds, plan.removals, policy.minimumKeepSeconds);
  const operations = [];
  keeps.forEach((keep, index) => {
    operations.push({
      id: `select-${index + 1}`,
      type: 'select_range',
      assetId,
      sourceIn: keep.start,
      sourceOut: keep.end,
      timelineIn: keep.timelineIn,
      reason: 'analysis_keep_range',
      confidence: 0.96,
    });
  });
  plan.removals.forEach((removal, index) => {
    operations.push({
      id: `remove-${index + 1}`,
      type: 'remove_range',
      assetId,
      sourceIn: removal.start,
      sourceOut: removal.end,
      reason: removal.reason,
      confidence: removal.confidence,
      evidenceIds: removal.evidenceIds,
    });
  });
  const removedSegmentIds = new Set(plan.transcriptFindings.filter((finding) => finding.autoRemove).map((finding) => finding.segmentId));
  normalizedTranscript.segments.forEach((segment, index) => {
    if (removedSegmentIds.has(segment.id)) return;
    const mapped = captionForSegment(segment, keeps, policy);
    if (!mapped) return;
    operations.push({
      id: `caption-${index + 1}`,
      type: 'caption',
      timelineIn: mapped.timelineIn,
      timelineOut: mapped.timelineOut,
      text: segment.text,
      speakerId: segment.speaker,
      role: 'speech',
      styleToken: 'caption.default',
      reason: 'transcript_segment',
      confidence: segment.confidence ?? 0.9,
      sourceSegmentId: segment.id,
    });
  });
  const outputDuration = round(keeps.reduce((sum, keep) => sum + keep.duration, 0));
  return {
    schemaVersion: '0.2.0',
    projectId,
    intent: '高信頼の無音・フィラー・言い直しを除去し、発話内容と根拠を保持する',
    timeline: {
      frameRate: media.frameRate,
      durationSeconds: outputDuration,
      sourceDurationSeconds: media.durationSeconds,
      operations,
    },
    analysis: {
      version: 'analysis.v1',
      assetId,
      keepRangeCount: keeps.length,
      removalCount: plan.removals.length,
      transcriptFindingCount: plan.transcriptFindings.length,
      outputDurationSeconds: outputDuration,
    },
    generatedAt,
  };
}

export function buildQcReport({ media, transcript, plan, editorialIr, sceneChanges = [] }) {
  const selects = editorialIr.timeline.operations.filter((operation) => operation.type === 'select_range');
  const captions = editorialIr.timeline.operations.filter((operation) => operation.type === 'caption');
  const outputDuration = editorialIr.timeline.durationSeconds;
  const removedDuration = round(plan.removals.reduce((sum, removal) => sum + removal.duration, 0));
  const warnings = [];
  if (!normalizeTranscript(transcript).segments.length) warnings.push('文字起こしがないため、フィラー・言い直し・字幕は解析していません。');
  if (!sceneChanges.length) warnings.push('表情・反応の意味判定は未実装です。シーン変化のみ補助信号として扱います。');
  if (plan.transcriptFindings.some((finding) => !finding.autoRemove)) warnings.push('低信頼の発話候補は自動削除せず、人手確認へ残しています。');
  const checks = [
    { id: 'media-duration', status: media.durationSeconds > 0 ? 'pass' : 'fail', value: media.durationSeconds },
    { id: 'keep-ranges', status: selects.length > 0 ? 'pass' : 'fail', value: selects.length },
    { id: 'timeline-duration', status: outputDuration > 0 && outputDuration <= media.durationSeconds ? 'pass' : 'fail', value: outputDuration },
    { id: 'caption-mapping', status: normalizeTranscript(transcript).segments.length ? (captions.length ? 'pass' : 'review') : 'skipped', value: captions.length },
    { id: 'cut-ratio', status: removedDuration / Math.max(media.durationSeconds, 0.001) <= 0.65 ? 'pass' : 'review', value: round(removedDuration / Math.max(media.durationSeconds, 0.001)) },
  ];
  const failed = checks.some((check) => check.status === 'fail');
  const review = warnings.length || checks.some((check) => check.status === 'review');
  return {
    version: 'qc.v1',
    status: failed ? 'fail' : review ? 'review' : 'pass',
    summary: {
      sourceDurationSeconds: media.durationSeconds,
      outputDurationSeconds: outputDuration,
      removedDurationSeconds: removedDuration,
      keepRangeCount: selects.length,
      captionCount: captions.length,
      silenceCount: plan.silences.length,
      transcriptFindingCount: plan.transcriptFindings.length,
      sceneChangeCount: sceneChanges.length,
    },
    checks,
    warnings,
    generatedAt: editorialIr.generatedAt,
  };
}

export function buildAnalysisDocument({ media, transcript, plan, sceneChanges = [], policy = DEFAULT_ANALYSIS_POLICY, generatedAt = new Date().toISOString() }) {
  const normalizedTranscript = normalizeTranscript(transcript);
  return {
    version: 'analysis.v1',
    generatedAt,
    media,
    transcription: {
      status: normalizedTranscript.segments.length ? 'available' : 'not_provided',
      language: normalizedTranscript.language,
      provider: normalizedTranscript.provider,
      segmentCount: normalizedTranscript.segments.length,
    },
    signals: {
      silences: plan.silences,
      transcriptFindings: plan.transcriptFindings,
      sceneChanges,
      semanticVision: { status: 'not_implemented', reason: '表情・反応は映像モデルの根拠が必要なため補助信号と分離' },
    },
    decisions: {
      removals: plan.removals,
      policy,
    },
  };
}

export function stableFingerprint(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

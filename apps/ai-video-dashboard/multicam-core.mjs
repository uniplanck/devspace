const DEFAULT_MULTICAM_POLICY = Object.freeze({
  minimumSyncConfidence: 0.58,
  minimumCorrelationScore: 0.42,
  minimumOverlapFrames: 150,
  maximumOffsetSeconds: 8,
  fallbackToReference: true,
});

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

function normalizedSeries(values) {
  const source = Array.from(values || [], Number).filter(Number.isFinite);
  if (!source.length) return [];
  const mean = source.reduce((sum, value) => sum + value, 0) / source.length;
  const centered = source.map((value) => value - mean);
  const energy = Math.sqrt(centered.reduce((sum, value) => sum + value * value, 0));
  if (energy <= 1e-12) return centered.map(() => 0);
  return centered.map((value) => value / energy);
}

function lagCorrelation(reference, candidate, lag, minimumOverlapFrames) {
  const referenceStart = Math.max(0, -lag);
  const candidateStart = Math.max(0, lag);
  const overlap = Math.min(reference.length - referenceStart, candidate.length - candidateStart);
  if (overlap < minimumOverlapFrames) return null;
  let dot = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = 0; index < overlap; index += 1) {
    const left = reference[referenceStart + index];
    const right = candidate[candidateStart + index];
    dot += left * right;
    leftEnergy += left * left;
    rightEnergy += right * right;
  }
  if (leftEnergy <= 1e-12 || rightEnergy <= 1e-12) return null;
  return { lag, overlap, score: dot / Math.sqrt(leftEnergy * rightEnergy) };
}

export function estimateAudioOffset(referenceEnvelope, candidateEnvelope, frameRate, options = {}) {
  const rate = finiteNumber(frameRate, 'audio envelope frameRate');
  if (rate <= 0) throw new Error('audio envelope frameRate must be positive');
  const policy = { ...DEFAULT_MULTICAM_POLICY, ...options };
  const reference = normalizedSeries(referenceEnvelope);
  const candidate = normalizedSeries(candidateEnvelope);
  const minimumOverlapFrames = Math.max(10, Math.floor(Number(policy.minimumOverlapFrames) || 0));
  if (reference.length < minimumOverlapFrames || candidate.length < minimumOverlapFrames) {
    return {
      method: 'audio_correlation',
      status: 'unavailable',
      sourceOffsetSeconds: 0,
      correlationScore: 0,
      confidence: 0,
      reason: 'insufficient_audio_overlap',
    };
  }

  const maxLag = Math.max(0, Math.round((Number(policy.maximumOffsetSeconds) || 0) * rate));
  const candidates = [];
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const result = lagCorrelation(reference, candidate, lag, minimumOverlapFrames);
    if (result) candidates.push(result);
  }
  candidates.sort((left, right) => right.score - left.score || Math.abs(left.lag) - Math.abs(right.lag));
  const best = candidates[0];
  if (!best) {
    return {
      method: 'audio_correlation',
      status: 'unavailable',
      sourceOffsetSeconds: 0,
      correlationScore: 0,
      confidence: 0,
      reason: 'no_valid_correlation_window',
    };
  }
  const exclusion = Math.max(2, Math.round(rate * 0.12));
  const runnerUp = candidates.find((item) => Math.abs(item.lag - best.lag) > exclusion);
  const uniqueness = clamp((best.score - (runnerUp?.score ?? 0)) / 0.25, 0, 1);
  const scoreConfidence = clamp((best.score - 0.25) / 0.65, 0, 1);
  const overlapConfidence = clamp(best.overlap / Math.max(reference.length, candidate.length), 0, 1);
  const confidence = round(scoreConfidence * 0.65 + uniqueness * 0.25 + overlapConfidence * 0.1);
  const correlationScore = round(best.score, 4);
  const accepted = correlationScore >= Number(policy.minimumCorrelationScore)
    && confidence >= Number(policy.minimumSyncConfidence);
  return {
    method: 'audio_correlation',
    status: accepted ? 'synced' : 'review',
    sourceOffsetSeconds: round(best.lag / rate),
    lagFrames: best.lag,
    envelopeFrameRate: rate,
    correlationScore,
    confidence,
    overlapFrames: best.overlap,
    reason: accepted ? 'audio_envelope_match' : 'low_sync_confidence',
  };
}

export function normalizeCameraPlan(cameraPlan, durationSeconds, referenceAssetId) {
  const duration = finiteNumber(durationSeconds, 'timeline durationSeconds');
  if (duration <= 0) throw new Error('timeline durationSeconds must be positive');
  const source = Array.isArray(cameraPlan) && cameraPlan.length
    ? cameraPlan
    : [{ assetId: referenceAssetId, timelineIn: 0, timelineOut: duration }];
  const normalized = source.map((entry, index) => {
    const timelineIn = finiteNumber(entry?.timelineIn, `cameraPlan ${index} timelineIn`);
    const timelineOut = finiteNumber(entry?.timelineOut, `cameraPlan ${index} timelineOut`);
    const assetId = String(entry?.assetId || '').trim();
    if (!assetId || timelineIn < 0 || timelineOut <= timelineIn || timelineOut > duration + 0.05) {
      throw new Error(`Invalid cameraPlan entry ${index}`);
    }
    return {
      id: String(entry.id || `camera-plan-${index + 1}`),
      assetId,
      timelineIn: round(timelineIn),
      timelineOut: round(Math.min(duration, timelineOut)),
      reason: String(entry.reason || 'explicit_camera_plan'),
    };
  }).sort((left, right) => left.timelineIn - right.timelineIn || left.timelineOut - right.timelineOut);

  let cursor = 0;
  for (const entry of normalized) {
    if (Math.abs(entry.timelineIn - cursor) > 0.05) {
      throw new Error(`cameraPlan is not contiguous at ${entry.timelineIn}; expected ${round(cursor)}`);
    }
    cursor = entry.timelineOut;
  }
  if (Math.abs(cursor - duration) > 0.05) {
    throw new Error(`cameraPlan ends at ${round(cursor)} but timeline duration is ${round(duration)}`);
  }
  return normalized;
}

function mapSelectSegments(baseSelects, cameraPlan, synchronization, assetsById, referenceAssetId, policy) {
  const operations = [];
  const warnings = [];
  let ordinal = 0;
  for (const select of baseSelects) {
    const selectStart = finiteNumber(select.timelineIn, `${select.id} timelineIn`);
    const selectDuration = finiteNumber(select.sourceOut, `${select.id} sourceOut`) - finiteNumber(select.sourceIn, `${select.id} sourceIn`);
    const selectEnd = selectStart + selectDuration;
    for (const camera of cameraPlan) {
      const timelineIn = Math.max(selectStart, camera.timelineIn);
      const timelineOut = Math.min(selectEnd, camera.timelineOut);
      if (timelineOut - timelineIn <= 0.0005) continue;
      const referenceSourceIn = Number(select.sourceIn) + (timelineIn - selectStart);
      const referenceSourceOut = referenceSourceIn + (timelineOut - timelineIn);
      const sync = synchronization[camera.assetId];
      const asset = assetsById.get(camera.assetId);
      let selectedAssetId = camera.assetId;
      let sourceOffsetSeconds = Number(sync?.sourceOffsetSeconds || 0);
      let fallbackReason;
      if (!asset || !sync || (camera.assetId !== referenceAssetId && sync.status !== 'synced')) {
        fallbackReason = !asset ? 'asset_not_found' : !sync ? 'sync_not_found' : 'sync_requires_review';
      }
      let sourceIn = referenceSourceIn + sourceOffsetSeconds;
      let sourceOut = referenceSourceOut + sourceOffsetSeconds;
      if (!fallbackReason && (sourceIn < -0.05 || sourceOut > Number(asset.durationSeconds) + 0.05)) {
        fallbackReason = 'mapped_range_out_of_bounds';
      }
      if (fallbackReason) {
        if (!policy.fallbackToReference) throw new Error(`Camera ${camera.assetId} cannot be used: ${fallbackReason}`);
        selectedAssetId = referenceAssetId;
        sourceOffsetSeconds = 0;
        sourceIn = referenceSourceIn;
        sourceOut = referenceSourceOut;
        warnings.push({
          id: `multicam-warning-${warnings.length + 1}`,
          type: fallbackReason,
          requestedAssetId: camera.assetId,
          fallbackAssetId: referenceAssetId,
          timelineIn: round(timelineIn),
          timelineOut: round(timelineOut),
        });
      }
      ordinal += 1;
      operations.push({
        id: `multicam-select-${ordinal}`,
        type: 'select_range',
        assetId: selectedAssetId,
        sourceIn: round(Math.max(0, sourceIn)),
        sourceOut: round(sourceOut),
        timelineIn: round(timelineIn),
        reason: selectedAssetId === camera.assetId ? camera.reason : 'multicam_reference_fallback',
        confidence: selectedAssetId === referenceAssetId
          ? 0.98
          : round(sync?.confidence ?? 0),
        referenceAssetId,
        referenceSourceIn: round(referenceSourceIn),
        referenceSourceOut: round(referenceSourceOut),
        sourceOffsetSeconds: round(sourceOffsetSeconds),
        requestedAssetId: camera.assetId,
      });
    }
  }
  operations.sort((left, right) => left.timelineIn - right.timelineIn || left.sourceIn - right.sourceIn);
  return { operations, warnings };
}

export function buildMulticamEditorialIr({
  projectId,
  referenceEditorialIr,
  referenceAssetId,
  assets,
  synchronization,
  cameraPlan,
  policy: policyInput = {},
  generatedAt = new Date().toISOString(),
}) {
  const policy = { ...DEFAULT_MULTICAM_POLICY, ...policyInput };
  const baseOperations = referenceEditorialIr?.timeline?.operations;
  if (!Array.isArray(baseOperations)) throw new Error('reference Editorial IR timeline.operations is required');
  const durationSeconds = finiteNumber(referenceEditorialIr.timeline.durationSeconds, 'reference timeline durationSeconds');
  const normalizedPlan = normalizeCameraPlan(cameraPlan, durationSeconds, referenceAssetId);
  const assetsById = new Map((assets || []).map((asset) => [String(asset.id), asset]));
  if (!assetsById.has(referenceAssetId)) throw new Error(`Reference asset not found: ${referenceAssetId}`);
  const baseSelects = baseOperations.filter((operation) => operation?.type === 'select_range' && operation.enabled !== false);
  const passthrough = baseOperations.filter((operation) => operation?.type !== 'select_range');
  const mapped = mapSelectSegments(baseSelects, normalizedPlan, synchronization, assetsById, referenceAssetId, policy);
  const assetIds = [...new Set(mapped.operations.map((operation) => operation.assetId))];
  return {
    editorialIr: {
      ...referenceEditorialIr,
      schemaVersion: '0.3.0',
      projectId,
      intent: `${String(referenceEditorialIr.intent || '').trim()} / 同期済み複数素材を明示カメラプランで切替`.replace(/^ \/ /u, ''),
      timeline: {
        ...referenceEditorialIr.timeline,
        operations: [...mapped.operations, ...passthrough],
      },
      multicam: {
        version: 'multicam.v1',
        referenceAssetId,
        audioStrategy: 'selected_asset',
        assetIds,
        cameraPlan: normalizedPlan,
        synchronization,
        fallbackCount: mapped.warnings.length,
      },
      generatedAt,
    },
    warnings: mapped.warnings,
  };
}

export function buildMulticamQc({ editorialIr, assets, synchronization, warnings = [], minimumSyncConfidence = DEFAULT_MULTICAM_POLICY.minimumSyncConfidence }) {
  const assetIds = new Set((assets || []).map((asset) => String(asset.id)));
  const selected = editorialIr?.timeline?.operations?.filter((operation) => operation?.type === 'select_range') || [];
  const syncRows = Object.entries(synchronization || {}).map(([assetId, sync]) => ({ assetId, ...sync }));
  const checks = [
    {
      id: 'multicam-assets',
      status: assetIds.size >= 2 ? 'pass' : 'fail',
      value: assetIds.size,
    },
    {
      id: 'multicam-selected-assets',
      status: new Set(selected.map((operation) => operation.assetId)).size >= 2 ? 'pass' : 'review',
      value: new Set(selected.map((operation) => operation.assetId)).size,
    },
    {
      id: 'multicam-sync',
      status: syncRows.every((row) => row.status === 'synced' || row.method === 'reference') ? 'pass' : 'review',
      value: syncRows.map((row) => ({ assetId: row.assetId, confidence: row.confidence, status: row.status })),
    },
    {
      id: 'multicam-sync-confidence',
      status: syncRows.filter((row) => row.method !== 'reference').every((row) => Number(row.confidence || 0) >= minimumSyncConfidence) ? 'pass' : 'review',
      value: syncRows.filter((row) => row.method !== 'reference').map((row) => round(row.confidence || 0)),
    },
    {
      id: 'multicam-fallbacks',
      status: warnings.length ? 'review' : 'pass',
      value: warnings.length,
    },
  ];
  const failed = checks.some((check) => check.status === 'fail');
  const review = warnings.length || checks.some((check) => check.status === 'review');
  return {
    version: 'qc.multicam.v1',
    status: failed ? 'fail' : review ? 'review' : 'pass',
    summary: {
      assetCount: assetIds.size,
      selectedAssetCount: new Set(selected.map((operation) => operation.assetId)).size,
      selectCount: selected.length,
      fallbackCount: warnings.length,
      outputDurationSeconds: editorialIr?.timeline?.durationSeconds,
    },
    checks,
    warnings,
    generatedAt: editorialIr?.generatedAt || new Date().toISOString(),
  };
}

export { DEFAULT_MULTICAM_POLICY };

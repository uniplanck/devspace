const DEFAULT_REAL_FOOTAGE_POLICY = Object.freeze({
  minimumSyncWindows: 2,
  minimumSyncConfidence: 0.58,
  passDriftMsPerMinute: 20,
  reviewDriftMsPerMinute: 80,
  passDurationErrorSeconds: 0.12,
  reviewDurationErrorSeconds: 0.35,
  minimumMeanVolumeDb: -35,
  clippingRiskMaxVolumeDb: -0.1,
  maximumBoundarySilenceHits: 0,
});

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function statusScore(status) {
  if (status === 'pass') return 1;
  if (status === 'review') return 0.5;
  return 0;
}

function check(id, label, weight, status, value, recommendation = '') {
  return { id, label, weight, status, value, recommendation };
}

function sourceBounds(editorialIr, assetsById) {
  const invalid = [];
  const selects = editorialIr?.timeline?.operations?.filter((operation) => operation?.type === 'select_range' && operation.enabled !== false) || [];
  for (const operation of selects) {
    const video = assetsById.get(String(operation.assetId || ''));
    const audioAssetId = String(operation.audioAssetId || operation.assetId || '');
    const audio = assetsById.get(audioAssetId);
    const sourceIn = finite(operation.sourceIn, -1);
    const sourceOut = finite(operation.sourceOut, -1);
    const audioIn = finite(operation.audioSourceIn ?? operation.sourceIn, -1);
    const audioOut = finite(operation.audioSourceOut ?? operation.sourceOut, -1);
    if (!video || sourceIn < 0 || sourceOut <= sourceIn || sourceOut > finite(video.durationSeconds) + 0.05) {
      invalid.push({ operationId: operation.id, media: 'video', assetId: operation.assetId, sourceIn, sourceOut });
    }
    if (!audio || audioIn < 0 || audioOut <= audioIn || audioOut > finite(audio.durationSeconds) + 0.05) {
      invalid.push({ operationId: operation.id, media: 'audio', assetId: audioAssetId, sourceIn: audioIn, sourceOut: audioOut });
    }
  }
  return { selectCount: selects.length, invalid };
}

function masterAudioConsistency(editorialIr) {
  const strategy = String(editorialIr?.multicam?.audioStrategy || 'selected_asset');
  const masterAudioAssetId = String(editorialIr?.multicam?.masterAudioAssetId || '');
  const selects = editorialIr?.timeline?.operations?.filter((operation) => operation?.type === 'select_range' && operation.enabled !== false) || [];
  const audioAssetIds = [...new Set(selects.map((operation) => String(operation.audioAssetId || operation.assetId || '')).filter(Boolean))];
  if (strategy !== 'master_audio') return { strategy, masterAudioAssetId: null, audioAssetIds, consistent: true };
  return {
    strategy,
    masterAudioAssetId,
    audioAssetIds,
    consistent: Boolean(masterAudioAssetId) && audioAssetIds.length === 1 && audioAssetIds[0] === masterAudioAssetId,
  };
}

function syncSummary(syncAudit, policy) {
  const rows = Object.entries(syncAudit?.assets || {}).map(([assetId, row]) => ({ assetId, ...row }));
  const nonReference = rows.filter((row) => row.method !== 'reference');
  const available = nonReference.filter((row) => Array.isArray(row.windows) && row.windows.length > 0);
  const minimumWindows = available.length ? Math.min(...available.map((row) => row.windows.length)) : 0;
  const minimumConfidence = available.length
    ? Math.min(...available.flatMap((row) => row.windows.map((window) => finite(window.confidence))))
    : 0;
  const maximumDrift = available.length
    ? Math.max(...available.map((row) => Math.abs(finite(row.driftMsPerMinute))))
    : 0;
  return {
    assetCount: nonReference.length,
    availableAssetCount: available.length,
    minimumWindows,
    minimumConfidence: round(minimumConfidence),
    maximumDriftMsPerMinute: round(maximumDrift),
    windowCoverageStatus: nonReference.length > 0 && available.length === nonReference.length && minimumWindows >= policy.minimumSyncWindows
      ? 'pass'
      : available.length ? 'review' : 'fail',
    confidenceStatus: minimumConfidence >= policy.minimumSyncConfidence ? 'pass' : minimumConfidence > 0 ? 'review' : 'fail',
    driftStatus: maximumDrift <= policy.passDriftMsPerMinute
      ? 'pass'
      : maximumDrift <= policy.reviewDriftMsPerMinute ? 'review' : 'fail',
  };
}

export function buildRealFootageQualityReport({ project, analysis, editorialIr, qc, previewAudit, syncAudit, policy: policyInput = {}, generatedAt = new Date().toISOString() }) {
  const policy = { ...DEFAULT_REAL_FOOTAGE_POLICY, ...policyInput };
  const assets = Array.isArray(analysis?.assets) ? analysis.assets : [];
  const assetsById = new Map(assets.map((asset) => [String(asset.id), asset]));
  const bounds = sourceBounds(editorialIr, assetsById);
  const masterAudio = masterAudioConsistency(editorialIr);
  const sync = syncSummary(syncAudit, policy);
  const expectedDuration = finite(editorialIr?.timeline?.durationSeconds || project?.outputDurationSeconds);
  const renderedDuration = finite(previewAudit?.durationSeconds);
  const durationError = Math.abs(renderedDuration - expectedDuration);
  const durationStatus = !renderedDuration ? 'fail' : durationError <= policy.passDurationErrorSeconds ? 'pass' : durationError <= policy.reviewDurationErrorSeconds ? 'review' : 'fail';
  const audioPresent = Boolean(previewAudit?.hasAudio);
  const meanVolumeDb = finite(previewAudit?.meanVolumeDb, -Infinity);
  const maxVolumeDb = finite(previewAudit?.maxVolumeDb, -Infinity);
  const audioLevelStatus = !audioPresent ? 'fail' : meanVolumeDb < policy.minimumMeanVolumeDb || maxVolumeDb >= policy.clippingRiskMaxVolumeDb ? 'review' : 'pass';
  const boundarySilenceHits = Array.isArray(previewAudit?.boundarySilenceHits) ? previewAudit.boundarySilenceHits : [];
  const boundaryStatus = !audioPresent ? 'fail' : boundarySilenceHits.length <= policy.maximumBoundarySilenceHits ? 'pass' : 'review';
  const fallbackCount = finite(editorialIr?.multicam?.fallbackCount ?? qc?.summary?.fallbackCount);

  const checks = [
    check('sync-window-coverage', '同期監査ウィンドウ', 10, sync.windowCoverageStatus, { assets: sync.availableAssetCount, minimumWindows: sync.minimumWindows }, '素材の冒頭・中央・終端で共通音声を確保してください。'),
    check('sync-confidence', '同期信頼度', 10, sync.confidenceStatus, sync.minimumConfidence, '手動同期点または明瞭なクラップ音を使用してください。'),
    check('sync-drift', '長尺ドリフト', 20, sync.driftStatus, `${sync.maximumDriftMsPerMinute} ms/min`, '可変フレームレートを固定し、区間別リタイムを検討してください。'),
    check('timeline-duration', '出力尺', 15, durationStatus, { expectedSeconds: round(expectedDuration), renderedSeconds: round(renderedDuration), errorSeconds: round(durationError) }, 'rendererのフレーム丸めと末尾音声paddingを確認してください。'),
    check('source-bounds', '素材参照範囲', 10, bounds.invalid.length ? 'fail' : 'pass', { selectCount: bounds.selectCount, invalid: bounds.invalid }, '範囲外のsourceIn/sourceOutを修正してください。'),
    check('audio-present', '出力音声', 10, audioPresent ? 'pass' : 'fail', audioPresent, 'master音声素材とaudio mappingを確認してください。'),
    check('audio-level', '音量・クリッピングリスク', 10, audioLevelStatus, { meanVolumeDb: round(meanVolumeDb), maxVolumeDb: round(maxVolumeDb) }, '音量正規化またはlimiterを適用してください。'),
    check('audio-boundary-continuity', 'カット境界の音声連続性', 10, boundaryStatus, boundarySilenceHits, 'カット境界前後の無音・音切れを手動確認してください。'),
    check('master-audio-consistency', 'Master Audio整合', 3, masterAudio.consistent ? 'pass' : 'fail', masterAudio, '全select_rangeのaudioAssetIdをmasterAudioAssetIdへ統一してください。'),
    check('multicam-fallbacks', 'カメラfallback', 2, fallbackCount === 0 ? 'pass' : 'review', fallbackCount, '同期不良または範囲外になったカメラ区間を確認してください。'),
  ];
  const score = round(checks.reduce((sum, item) => sum + item.weight * statusScore(item.status), 0), 1);
  const hasFail = checks.some((item) => item.status === 'fail');
  const hasReview = checks.some((item) => item.status === 'review');
  const status = hasFail || score < 70 ? 'fail' : hasReview || score < 90 ? 'review' : 'pass';
  const recommendations = checks.filter((item) => item.status !== 'pass' && item.recommendation).map((item) => ({ checkId: item.id, severity: item.status, action: item.recommendation }));
  return {
    version: 'real-footage-quality.v1',
    projectId: project?.id || editorialIr?.projectId || '',
    status,
    score,
    summary: {
      syncDriftMsPerMinute: sync.maximumDriftMsPerMinute,
      syncMinimumConfidence: sync.minimumConfidence,
      durationErrorSeconds: round(durationError),
      meanVolumeDb: round(meanVolumeDb),
      maxVolumeDb: round(maxVolumeDb),
      boundarySilenceHitCount: boundarySilenceHits.length,
      sourceBoundsErrorCount: bounds.invalid.length,
      fallbackCount,
      audioStrategy: masterAudio.strategy,
    },
    checks,
    recommendations,
    syncAudit,
    previewAudit,
    policy,
    generatedAt,
  };
}

export { DEFAULT_REAL_FOOTAGE_POLICY };

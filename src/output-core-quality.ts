export interface TaskFinalizationEvidence {
  finalResult: string;
  changes?: string;
  verification?: string;
  remaining?: string;
  outputSummary: string;
  predictionCount: number;
  taskErrors: number;
  evidence?: string[];
}

export interface TaskFinalizationScore {
  score: number;
  checks: string[];
  missing: string[];
}

function meaningful(value: string | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return Boolean(normalized && !["なし", "none", "n/a", "—", "未確認"].includes(normalized));
}

export function scoreTaskFinalization(input: TaskFinalizationEvidence): TaskFinalizationScore {
  let score = 0;
  const checks: string[] = [];
  const missing: string[] = [];
  const add = (condition: boolean, points: number, label: string) => {
    if (condition) {
      score += points;
      checks.push(label);
    } else {
      missing.push(label);
    }
  };
  add(meaningful(input.finalResult), 15, "final-result");
  add(meaningful(input.changes), 10, "changes");
  add(meaningful(input.verification), 25, "verification");
  add(String(input.remaining ?? "").trim().length > 0, 10, "remaining-explicit");
  add(meaningful(input.outputSummary), 10, "output-summary");
  add(input.predictionCount >= 3, 10, "three-predictions");
  add(input.taskErrors === 0, 10, "zero-tool-errors");
  const evidenceCount = Math.min(5, (input.evidence ?? []).map((item) => item.trim()).filter(Boolean).length);
  score += evidenceCount * 2;
  if (evidenceCount > 0) checks.push(`quality-evidence:${evidenceCount}`);
  else missing.push("quality-evidence");
  return { score: Math.min(100, score), checks, missing };
}

export interface OutputCoreQualityEvidence {
  deterministicFinalStructure: boolean;
  stateMachine: boolean;
  turnPairing: boolean;
  reactionClassification: boolean;
  predictionAnalysis: boolean;
  crossChatPersistence: boolean;
  crossRuntimeSync: boolean;
  cardEconomy: boolean;
  duplicateOutputPrevention: boolean;
  privacyRedaction: boolean;
  boundedStorage: boolean;
  focusedTests: boolean;
  fullTests: boolean;
  macRuntime: boolean;
  ec2Runtime: boolean;
  separateChatExperiment: boolean;
  criticalFailures?: string[];
}

export interface OutputCoreQualityScore {
  score: number;
  passed: boolean;
  target: 95;
  criticalFailures: string[];
  dimensions: Array<{ name: string; score: number; maximum: number }>;
}

export function scoreOutputCoreQuality(evidence: OutputCoreQualityEvidence): OutputCoreQualityScore {
  const dimensions = [
    {
      name: "Deterministic final structure and state machine",
      score: Number(evidence.deterministicFinalStructure) * 10 + Number(evidence.stateMachine) * 10,
      maximum: 20,
    },
    {
      name: "Turn pairing and reaction classification",
      score: Number(evidence.turnPairing) * 10 + Number(evidence.reactionClassification) * 10,
      maximum: 20,
    },
    {
      name: "Prediction and periodic analysis",
      score: Number(evidence.predictionAnalysis) * 15,
      maximum: 15,
    },
    {
      name: "Cross-chat and cross-runtime persistence",
      score: Number(evidence.crossChatPersistence) * 8 + Number(evidence.crossRuntimeSync) * 7,
      maximum: 15,
    },
    {
      name: "Card economy and duplicate-output prevention",
      score: Number(evidence.cardEconomy) * 5 + Number(evidence.duplicateOutputPrevention) * 5,
      maximum: 10,
    },
    {
      name: "Privacy and bounded failure behavior",
      score: Number(evidence.privacyRedaction) * 5 + Number(evidence.boundedStorage) * 5,
      maximum: 10,
    },
    {
      name: "Automated and runtime verification",
      score:
        Number(evidence.focusedTests) * 2
        + Number(evidence.fullTests) * 2
        + Number(evidence.macRuntime) * 2
        + Number(evidence.ec2Runtime) * 2
        + Number(evidence.separateChatExperiment) * 2,
      maximum: 10,
    },
  ];
  const criticalFailures = (evidence.criticalFailures ?? []).map((failure) => failure.trim()).filter(Boolean);
  const score = dimensions.reduce((sum, dimension) => sum + dimension.score, 0);
  return {
    score,
    passed: score >= 95 && criticalFailures.length === 0,
    target: 95,
    criticalFailures,
    dimensions,
  };
}

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeOutputLearning,
  classifyOutputReaction,
  inferNextIntent,
  OutputLearningStore,
  outputConversationKey,
  redactSensitiveText,
} from "./output-learning.js";
import { scoreOutputCoreQuality } from "./output-core-quality.js";

const directory = mkdtempSync(join(tmpdir(), "devspace-output-learning-"));
const path = join(directory, "learning.json");
const previousPath = process.env.DEVSPACE_OUTPUT_LEARNING_PATH;
process.env.DEVSPACE_OUTPUT_LEARNING_PATH = path;

try {
  assert.equal(
    outputConversationKey({ conversationId: "11111111-2222-3333-4444-555555555555" }),
    "conversation:11111111-2222-3333-4444-555555555555",
  );
  assert.match(
    outputConversationKey({ conversationUrl: "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    /^conversation:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee$/u,
  );
  assert.equal(inferNextIntent("これ本番にdeployして"), "publish-or-deploy");
  assert.equal(inferNextIntent("終わり？ちゃんとテストした？"), "verify-completion");
  assert.equal(inferNextIntent("いや違う、何も変わってない"), "correct-result");

  assert.equal(
    classifyOutputReaction({ previousOutputSummary: "実装完了", nextUserInput: "いや違う、反映されてない" }).reaction,
    "correction",
  );
  assert.equal(
    classifyOutputReaction({ previousOutputSummary: "実装完了", nextUserInput: "もっと見やすく調整して" }).reaction,
    "refinement",
  );
  assert.equal(
    classifyOutputReaction({ previousOutputSummary: "実装完了", nextUserInput: "終わり？テスト済み？" }).reaction,
    "verification",
  );
  assert.equal(
    classifyOutputReaction({ previousOutputSummary: "実装完了", nextUserInput: "ありがとう" }).reaction,
    "approval",
  );

  const redacted = redactSensitiveText(
    "api_key=super-secret-value sk-abcdefghijklmnopqrstuvwxyz123456 user@example.com Bearer abcdefghijklmnopqrstuvwxyz",
  );
  assert.doesNotMatch(redacted, /super-secret-value/u);
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnopqrstuvwxyz123456/u);
  assert.doesNotMatch(redacted, /user@example\.com/u);
  assert.doesNotMatch(redacted, /Bearer abcdefghijklmnopqrstuvwxyz/u);

  const store = new OutputLearningStore(path);
  const firstBegin = store.begin({
    conversationId: "chat-a",
    sessionId: "transport-shared",
    userRequest: "UIを修正して",
    taskCategory: "web-development",
    capturedAt: 1_000,
  });
  assert.equal(firstBegin.pairedLoop, undefined);
  assert.equal(firstBegin.predictions.length, 3);

  const finalized = store.finalize({
    conversationId: "chat-a",
    sessionId: "transport-shared",
    taskCategory: "web-development",
    outputSummary: "UI修正を実装し、ブラウザ検証まで完了した。",
    predictions: ["verify-completion", "refine-output", "publish-or-deploy"],
    qualityScore: 97,
    completedAt: 2_000,
  });
  assert.equal(finalized.pending.qualityScore, 97);
  assert.equal(finalized.pending.predictedIntents.length, 3);

  const otherConversation = store.begin({
    conversationId: "chat-b",
    sessionId: "transport-shared",
    userRequest: "別件を調査して",
    taskCategory: "research",
    capturedAt: 2_500,
  });
  assert.equal(otherConversation.pairedLoop, undefined);

  const paired = store.begin({
    conversationId: "chat-a",
    sessionId: "transport-shared",
    userRequest: "終わり？ちゃんとテストした？",
    taskCategory: "web-development",
    capturedAt: 3_000,
  });
  assert.ok(paired.pairedLoop);
  assert.equal(paired.pairedLoop?.reaction, "verification");
  assert.equal(paired.pairedLoop?.matchedPredictionRank, 1);
  assert.equal(paired.pairedLoop?.conversationKey, "conversation:chat-a");

  const afterPairing = store.read({ pullShared: false });
  assert.equal(afterPairing.pending.length, 0);
  assert.equal(afterPairing.consumedPendingIds.length, 1);
  assert.equal(afterPairing.consumedPendingIds[0], finalized.pending.id);
  assert.equal(afterPairing.loops.length, 1);

  const duplicatePairAttempt = store.begin({
    conversationId: "chat-a",
    sessionId: "transport-shared",
    userRequest: "もう一度確認して",
    taskCategory: "web-development",
    capturedAt: 3_500,
  });
  assert.equal(duplicatePairAttempt.pairedLoop, undefined, "consumed output must not be paired twice");

  const transportFinalized = store.finalize({
    sessionId: "transport-old",
    taskCategory: "transport-continuity",
    outputSummary: "会話IDがない接続でも次ターンへ継続する。",
    predictions: ["continue-execution", "verify-completion", "refine-output"],
    qualityScore: 100,
    completedAt: 3_700,
  });
  const transportResumed = store.begin({
    sessionId: "transport-new",
    continuityKey: transportFinalized.pending.conversationKey,
    userRequest: "続けて検証して",
    taskCategory: "transport-continuity",
    capturedAt: 3_800,
  });
  assert.equal(transportResumed.pairedLoop?.outputId, transportFinalized.pending.id);
  assert.equal(transportResumed.conversationKey, transportFinalized.pending.conversationKey);

  const ingest = store.ingestGexLoops([
    {
      conversationKey: "gex-chat",
      prompt: "カードを減らして",
      assistant: "カードをまとめました",
      followup: "もっと少なくして",
      capturedAt: 4_000,
    },
    {
      conversationKey: "gex-chat",
      prompt: "カードを減らして",
      assistant: "カードをまとめました",
      followup: "もっと少なくして",
      capturedAt: 4_000,
    },
  ]);
  assert.equal(ingest.added, 1);
  assert.equal(ingest.total, 3);

  const dedupeFinalized = store.finalize({
    conversationId: "dedupe-chat",
    taskCategory: "dedupe-test",
    outputSummary: "GEXとbegin_taskの重複保存を防ぐ。",
    predictions: ["refine-output", "verify-completion", "continue-execution"],
    qualityScore: 100,
    completedAt: 4_500,
  });
  const beforeGexDedupe = store.read({ pullShared: false }).loops.length;
  const gexDedupe = store.ingestGexLoops([{
    conversationKey: "dedupe-chat",
    prompt: "重複保存を防いで",
    assistant: dedupeFinalized.pending.outputSummary,
    followup: "もっと厳密に改善して",
    capturedAt: 5_000,
  }]);
  assert.equal(gexDedupe.added, 1);
  assert.equal(gexDedupe.total, beforeGexDedupe + 1);
  const toolDedupe = store.begin({
    conversationId: "dedupe-chat",
    userRequest: "もっと厳密に改善して",
    taskCategory: "dedupe-test",
    capturedAt: 5_100,
  });
  assert.equal(toolDedupe.pairedLoop?.source, "gex");
  assert.equal(store.read({ pullShared: false }).loops.length, beforeGexDedupe + 1);

  const loops = store.read({ pullShared: false }).loops;
  const expanded = Array.from({ length: 8 }, (_, index) => ({
    ...loops[0]!,
    id: `synthetic-${index}`,
    reaction: index < 4 ? "correction" as const : "refinement" as const,
    nextIntent: index < 4 ? "correct-result" : "refine-output",
    capturedAt: 5_000 + index,
  }));
  const analysis = analyzeOutputLearning(expanded, 10_000);
  assert.equal(analysis.sampleCount, 8);
  assert.ok(analysis.correctionRate >= 0.5);
  assert.ok(analysis.rules.some((rule) => rule.includes("検証証拠")));

  const raw = readFileSync(path, "utf8");
  assert.doesNotMatch(raw, /super-secret-value|user@example\.com/u);

  const quality = scoreOutputCoreQuality({
    deterministicFinalStructure: true,
    stateMachine: true,
    turnPairing: true,
    reactionClassification: true,
    predictionAnalysis: true,
    crossChatPersistence: true,
    crossRuntimeSync: true,
    cardEconomy: true,
    duplicateOutputPrevention: true,
    privacyRedaction: true,
    boundedStorage: true,
    focusedTests: true,
    fullTests: true,
    macRuntime: true,
    ec2Runtime: true,
    separateChatExperiment: false,
  });
  assert.equal(quality.score, 98);
  assert.equal(quality.passed, true);

  const critical = scoreOutputCoreQuality({
    deterministicFinalStructure: true,
    stateMachine: true,
    turnPairing: true,
    reactionClassification: true,
    predictionAnalysis: true,
    crossChatPersistence: true,
    crossRuntimeSync: true,
    cardEconomy: true,
    duplicateOutputPrevention: true,
    privacyRedaction: true,
    boundedStorage: true,
    focusedTests: true,
    fullTests: true,
    macRuntime: true,
    ec2Runtime: true,
    separateChatExperiment: true,
    criticalFailures: ["conversation isolation failed"],
  });
  assert.equal(critical.score, 100);
  assert.equal(critical.passed, false);

  console.log("output-learning tests: OK");
} finally {
  if (previousPath === undefined) delete process.env.DEVSPACE_OUTPUT_LEARNING_PATH;
  else process.env.DEVSPACE_OUTPUT_LEARNING_PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
}

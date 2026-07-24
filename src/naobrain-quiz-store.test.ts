import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NaoBrainQuizStore, parseGeneratedQuestions } from "./naobrain-quiz-store.js";

const root = await mkdtemp(join(tmpdir(), "naobrain-quiz-test-"));

try {
  const store = new NaoBrainQuizStore({
    dataDir: root,
    promptFile: join(root, "config", "prompt.md"),
    geminiModel: "gemini-test",
    geminiFallbackModel: "gemini-test-flash",
    geminiTertiaryModel: "gemini-test-lite",
    geminiFallbackKeysFile: join(root, "config", "gemini-fallback-keys.json"),
    driveBasePath: "NaoBrain/Quiz",
    sourceRoots: [],
  });

  const generated = parseGeneratedQuestions('{"questions":[{"question":"追加JSONに強い？","choices":["はい","いいえ","不明","無関係"],"answer":0,"explanation":"最初の完全なJSON文書だけを安全に抽出する。","labels":["JSON"],"sourceType":"application","sourceRefs":["parser"],"difficulty":2}]}\n{"ignored":true}', "test-generation");
  assert.equal(generated.length, 1);
  assert.equal(generated[0]?.answer, 0);

  const initial = await store.getState();
  assert.equal(initial.bank.active, 8);
  assert.equal(initial.bank.attempted, 0);
  assert.equal(initial.session, null);

  const started = await store.start("recommended", 2);
  assert.equal(started.session?.total, 2);
  assert.ok(started.currentQuestion);

  const firstQuestion = started.currentQuestion;
  assert.ok(firstQuestion);
  const firstAnswer = await store.answer({
    sessionId: started.session!.id,
    questionId: firstQuestion.id,
    selectedIndex: 3,
    responseMs: 4_500,
    confidence: "high",
  });
  assert.equal(firstAnswer.answer.correct, false);
  assert.equal(firstAnswer.state.bank.wrong, 1);
  assert.equal(firstAnswer.state.session?.currentIndex, 1);

  const resumed = await store.start("resume");
  assert.equal(resumed.session?.id, started.session?.id);
  assert.equal(resumed.session?.currentIndex, 1);

  const wrongSession = await store.start("wrong", 5);
  assert.equal(wrongSession.session?.total, 1);
  assert.equal(wrongSession.currentQuestion?.id, firstQuestion.id);

  const digest = await store.digest();
  assert.match(digest, /Wrong pool: 1/);
  assert.match(digest, /間違えた問題だけ/);

  const prompt = await readFile(join(root, "config", "prompt.md"), "utf8");
  assert.match(prompt, /記憶定着問題設計器/);
  console.log("naobrain-quiz-store.test: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NaoBrainTodayStore } from "./naobrain-today-store.js";

const root = await mkdtemp(join(tmpdir(), "naobrain-today-test-"));

try {
  const store = new NaoBrainTodayStore({
    dataDir: root,
    promptFile: join(root, "config", "prompt.md"),
    geminiModel: "gemini-test",
    geminiFallbackModel: "gemini-test-flash",
    geminiTertiaryModel: "gemini-test-lite",
    geminiFallbackKeysFile: join(root, "secrets", "gemini-fallback-keys.json"),
    driveBasePath: "NaoBrain/Today",
  });

  const project = await store.createProject("uniplanck.com");
  const first = await store.append({
    title: "LP構成を確定",
    body: "ファーストビューとCTAの構成を確定した。",
    status: "done",
    kind: "result",
    projectId: project.id,
    source: "gae",
    startAt: "2026-07-14T01:30:00.000Z",
    endAt: "2026-07-14T02:45:00.000Z",
    startApproximate: true,
    tags: ["LP", "クロさん"],
    runAi: false,
  });

  assert.equal(first.entry.date, "2026-07-14");
  assert.equal(first.entry.version, 1);
  assert.equal(first.entry.project, "uniplanck.com");
  assert.equal(first.snapshot.summary.total, 1);
  assert.equal(first.snapshot.summary.done, 1);
  assert.equal(first.snapshot.summary.trackedMinutes, 75);
  assert.equal(first.drive.configured, false);

  const updated = await store.update({
    id: first.entry.id,
    title: "LP構成とCTAを確定",
    body: "ファーストビューとCTAを確定し、公開前QAへ進んだ。",
    status: "doing",
    revisionNote: "実行状況を更新",
    runAi: false,
  });
  assert.equal(updated.entry.version, 2);
  assert.equal(updated.entry.previousRevisionId, first.entry.revisionId);
  assert.equal(updated.snapshot.summary.total, 1);
  assert.equal(updated.snapshot.summary.doing, 1);

  const history = await store.history(first.entry.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].title, "LP構成を確定");
  assert.equal(history[1].title, "LP構成とCTAを確定");

  const planned = await store.append({
    title: "明日の公開前QA",
    body: "SP幅390pxで見切れを確認する。",
    status: "planned",
    kind: "plan",
    source: "web",
    occurredAt: "2026-07-15T02:00:00.000Z",
    runAi: false,
  });

  const snapshot = await store.list("2026-07-14");
  assert.equal(snapshot.summary.total, 1);
  assert.deepEqual(snapshot.entries.map((entry) => entry.title), ["LP構成とCTAを確定"]);

  const queuedAi = await store.append({
    title: "非同期AI確認",
    body: "記録保存をAI処理より先に完了する。",
    status: "done",
    kind: "result",
    occurredAt: "2026-07-16T01:00:00.000Z",
    runAi: true,
  });
  assert.equal(queuedAi.aiQueued, true);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await store.list("2026-07-16")).entries[0]?.aiError) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await store.history(queuedAi.entry.id)).length, 1);
  assert.match((await store.list("2026-07-16")).entries[0]?.aiError || "", /Gemini|API key/i);

  const deleted = await store.delete(planned.entry.id, "予定を取り消し");
  assert.equal(deleted.entry.version, 2);
  assert.ok(deleted.entry.deletedAt);
  assert.equal(deleted.snapshot.summary.total, 0);
  const deletedHistory = await store.history(planned.entry.id);
  assert.equal(deletedHistory.length, 2);
  assert.equal(deletedHistory[1].revisionNote, "予定を取り消し");
  const deletedAgain = await store.delete(planned.entry.id, "再削除");
  assert.equal(deletedAgain.snapshot.summary.total, 0);
  assert.equal(deletedAgain.entry.version, deleted.entry.version);
  assert.equal((await store.list("2026-07-15")).summary.total, 0);
  assert.equal((await store.listDeleted()).length, 1);
  await assert.rejects(() => store.update({ id: planned.entry.id, title: "復活", runAi: false }), /Deleted entries cannot be edited/);

  const restored = await store.restore(planned.entry.id, undefined, "削除履歴から復元");
  assert.equal(restored.entry.version, 3);
  assert.equal(restored.entry.deletedAt, undefined);
  assert.equal(restored.snapshot.summary.total, 1);
  assert.equal((await store.listDeleted()).length, 0);
  const restoredHistory = await store.history(planned.entry.id);
  assert.equal(restoredHistory.length, 3);
  assert.equal(restoredHistory[2].revisionNote, "削除履歴から復元");

  const reverted = await store.restore(first.entry.id, first.entry.revisionId, "初版へ戻す");
  assert.equal(reverted.entry.version, 3);
  assert.equal(reverted.entry.title, "LP構成を確定");
  assert.equal(reverted.entry.revisionNote, "初版へ戻す");

  const projects = await store.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, "uniplanck.com");
  await store.updateProject(project.id, "uniplanck / Web");
  assert.equal((await store.listProjects())[0].name, "uniplanck / Web");
  await store.deleteProject(project.id);
  assert.equal((await store.listProjects()).length, 0);
  assert.equal((await store.listProjects(true))[0].active, false);

  const importedTags = await store.listTags();
  assert.deepEqual(importedTags.map((tag) => tag.name).sort(), ["LP", "クロさん"]);
  assert.equal(importedTags.find((tag) => tag.name === "LP")?.usageCount, 1);
  const personTag = await store.createTag("クロさん", "関係者", "person");
  await store.updateTag(personTag.id, { name: "クロさん", category: "一緒にいた人", kind: "person" });
  assert.equal((await store.listTags()).find((tag) => tag.name === "クロさん")?.kind, "person");
  assert.equal((await store.listTags()).find((tag) => tag.name === "クロさん")?.category, "一緒にいた人");
  const temporaryTag = await store.createTag("削除予定", "運用", "general");
  await store.deleteTag(temporaryTag.id);
  assert.equal((await store.listTags()).some((tag) => tag.name === "削除予定"), false);
  assert.equal((await store.listTags(true)).find((tag) => tag.name === "削除予定")?.active, false);

  const bulkSavedTags = await store.saveTags([
    { id: personTag.id, name: "クロさん", category: "一緒にいた人", kind: "person" },
    { name: "水春", category: "場所", kind: "general" },
  ]);
  assert.deepEqual(bulkSavedTags.map((tag) => tag.name).sort(), ["クロさん", "水春"]);
  assert.equal((await store.listTags()).some((tag) => tag.name === "LP"), false);
  assert.equal((await store.listTags(true)).find((tag) => tag.name === "LP")?.active, false);

  const settings = await store.updateAiSettings({ fallback2: "test-fallback-key-2" });
  assert.equal(settings.fallback2Configured, true);
  assert.equal(settings.configuredCount, 1);
  const secretsRaw = await readFile(join(root, "secrets", "gemini-fallback-keys.json"), "utf8");
  assert.match(secretsRaw, /test-fallback-key-2/);

  const backup = await store.backupTaskHub([
    {
      id: "task-1",
      type: "todo",
      title: 'CSV "引用符" テスト',
      notes: "販売ページを完成させる, 最終QAまで",
      tags: ["NaoBrain", "販売"],
      dueDate: "2026-07-23",
      priority: 1,
      repeat: "weekly",
      checked: false,
      createdAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T11:00:00.000Z",
    },
    {
      id: "task-2",
      type: "craving",
      cravingKind: "need",
      title: "売上を作る必要がある",
      desireStrength: 92,
      horizonLabel: "直近10日",
      checked: true,
    },
  ]);
  assert.equal(backup.count, 2);
  assert.equal(backup.drive.configured, false);
  const backupCsv = await readFile(backup.csvPath, "utf8");
  const backupJson = JSON.parse(await readFile(backup.jsonPath, "utf8")) as { count: number; records: Array<{ type: string }> };
  assert.equal(backupCsv.charCodeAt(0), 0xFEFF);
  assert.match(backupCsv, /CSV ""引用符"" テスト/);
  assert.match(backupCsv, /NaoBrain \| 販売/);
  assert.equal(backupJson.count, 2);
  assert.deepEqual(backupJson.records.map((record) => record.type), ["todo", "craving"]);

  const digest = await store.digest("2026-07-14");
  assert.match(digest, /# Today \/ 2026-07-14/);
  assert.match(digest, /LP構成を確定/);
  assert.match(digest, /Version: 3/);
  assert.match(digest, /約10:30–11:45/);

  const prompt = await readFile(join(root, "config", "prompt.md"), "utf8");
  assert.match(prompt, /NOW \/ NEXT \/ LATER/);

  console.log("naobrain-today-store.test: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

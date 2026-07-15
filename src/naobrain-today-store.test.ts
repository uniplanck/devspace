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
    driveBasePath: "NaoBrain/Today",
  });

  const first = await store.append({
    title: "LP構成を確定",
    body: "ファーストビューとCTAの構成を確定した。",
    status: "done",
    kind: "result",
    project: "uniplanck.com",
    source: "gae",
    occurredAt: "2026-07-14T01:30:00.000Z",
    runAi: false,
  });

  assert.equal(first.entry.date, "2026-07-14");
  assert.equal(first.snapshot.summary.total, 1);
  assert.equal(first.snapshot.summary.done, 1);
  assert.equal(first.drive.configured, false);

  await store.append({
    title: "公開前QA",
    body: "SP幅390pxで見切れを確認する。",
    status: "planned",
    kind: "plan",
    source: "web",
    occurredAt: "2026-07-14T02:00:00.000Z",
    runAi: false,
  });

  const snapshot = await store.list("2026-07-14");
  assert.equal(snapshot.summary.total, 2);
  assert.equal(snapshot.summary.planned, 1);
  assert.deepEqual(snapshot.entries.map((entry) => entry.title), ["LP構成を確定", "公開前QA"]);

  const digest = await store.digest("2026-07-14");
  assert.match(digest, /# Today \/ 2026-07-14/);
  assert.match(digest, /LP構成を確定/);
  assert.match(digest, /公開前QA/);

  const prompt = await readFile(join(root, "config", "prompt.md"), "utf8");
  assert.match(prompt, /NOW \/ NEXT \/ LATER/);

  console.log("naobrain-today-store.test: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

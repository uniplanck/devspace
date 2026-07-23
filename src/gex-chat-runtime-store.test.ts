import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GexChatRuntimeStore } from "./gex-chat-runtime-store.js";

const root = await mkdtemp(join(tmpdir(), "gex-chat-runtime-"));
const filePath = join(root, "gex-chat-runtime.json");
const store = new GexChatRuntimeStore(filePath);

const first = await store.sync({
  tabId: 10,
  windowId: 2,
  url: "https://chatgpt.com/c/example#fragment",
  title: "First task",
  generating: true,
  visible: false,
  reportedAt: 1_800_000_000_000,
});
assert.equal(first.active, 1);
assert.equal(first.total, 1);

const second = await store.sync({
  tabId: 11,
  windowId: 2,
  url: "https://chatgpt.com/c/second",
  title: "Second task",
  generating: true,
  visible: true,
  reportedAt: 1_800_000_000_100,
});
assert.equal(second.active, 2);
assert.equal(second.total, 2);

await store.sync({
  tabId: 10,
  windowId: 2,
  url: "https://chatgpt.com/c/example",
  title: "First task",
  generating: false,
  visible: false,
  reportedAt: 1_800_000_000_200,
});
const document = JSON.parse(await readFile(filePath, "utf8"));
assert.equal(document.schemaVersion, 1);
assert.equal(document.records.length, 2);
assert.equal(document.records.find((record: { tabId: number }) => record.tabId === 10).generating, false);
assert.equal(document.records.find((record: { tabId: number }) => record.tabId === 11).generating, true);
assert.equal(document.records.find((record: { tabId: number }) => record.tabId === 11).url, "https://chatgpt.com/c/second");

const activation = store.requestActivation({
  tabId: 11,
  windowId: 2,
  url: "https://chatgpt.com/c/second",
});
assert.equal(store.activationCommand()?.id, activation.id);
assert.equal(store.activationCommand()?.tabId, 11);
assert.equal(store.acknowledgeActivation(activation.id), true);
assert.equal(store.activationCommand(), null);
const urlActivation = store.requestActivation({ url: "https://chatgpt.com/c/example" });
assert.equal(urlActivation.tabId, -1);
assert.equal(urlActivation.url, "https://chatgpt.com/c/example");
assert.equal(store.acknowledgeActivation(urlActivation.id), true);

const closed = await store.sync({ tabId: 10, closed: true });
assert.equal(closed.active, 1);
assert.equal(closed.total, 1);

await assert.rejects(
  () => store.sync({ tabId: 12, url: "https://example.com/", generating: true }),
  /valid ChatGPT URL/,
);

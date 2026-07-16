#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NaoBrainTodayStore } from "../dist/naobrain-today-store.js";

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const file = valueAfter("--file");
const entryIndex = Number(valueAfter("--index") ?? 0);
if (!file || !Number.isInteger(entryIndex) || entryIndex < 0) {
  console.error("Usage: node scripts/import-naobrain-legacy-snapshot.mjs --file <snapshot.json> [--index 0]");
  process.exit(2);
}

const snapshot = JSON.parse(await readFile(resolve(file), "utf8"));
const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
const legacy = entries[entryIndex];
if (!legacy || typeof legacy !== "object") {
  console.error(`Legacy entry index ${entryIndex} was not found.`);
  process.exit(3);
}

const dataDir = resolve(
  process.env.DEVSPACE_NAOBRAIN_TODAY_DIR
    || join(homedir(), ".local", "share", "devspace", "naobrain-today"),
);
const stateDir = resolve(
  process.env.DEVSPACE_STATE_DIR
    || join(homedir(), ".local", "share", "devspace"),
);
const store = new NaoBrainTodayStore({
  dataDir,
  promptFile: process.env.DEVSPACE_NAOBRAIN_TODAY_PROMPT_FILE
    || join(dataDir, "config", "prompt.md"),
  geminiModel: process.env.DEVSPACE_NAOBRAIN_GEMINI_MODEL || "gemini-3.1-flash-lite",
  geminiFallbackKeysFile: process.env.DEVSPACE_NAOBRAIN_GEMINI_FALLBACK_KEYS_FILE
    || join(stateDir, "naobrain-secrets", "gemini-fallback-keys.json"),
  driveRemote: process.env.DEVSPACE_NAOBRAIN_DRIVE_REMOTE?.trim() || null,
  driveBasePath: process.env.DEVSPACE_NAOBRAIN_DRIVE_BASE_PATH || "NaoBrain/Today",
});

const occurredAt = String(legacy.occurredAt || legacy.startAt || "").trim();
if (!occurredAt || !legacy.title || !legacy.body) {
  console.error("Legacy entry requires title, body, and occurredAt/startAt.");
  process.exit(4);
}

const date = String(legacy.date || snapshot.date || occurredAt.slice(0, 10));
const current = await store.list(date);
const duplicate = current.entries.find((entry) =>
  entry.title === String(legacy.title)
  && entry.body === String(legacy.body)
  && entry.occurredAt === occurredAt
);

if (duplicate) {
  console.log(JSON.stringify({ ok: true, imported: false, reason: "duplicate", id: duplicate.id, total: current.summary.total }));
  process.exit(0);
}

const result = await store.append({
  title: String(legacy.title),
  body: String(legacy.body),
  status: legacy.status,
  kind: legacy.kind,
  project: typeof legacy.project === "string" ? legacy.project : "",
  tags: Array.isArray(legacy.tags) ? legacy.tags.map(String) : [],
  source: "import",
  occurredAt,
  startAt: legacy.startAt || undefined,
  endAt: legacy.endAt || undefined,
  startApproximate: legacy.startApproximate === true,
  endApproximate: legacy.endApproximate === true,
  runAi: false,
});

console.log(JSON.stringify({
  ok: true,
  imported: true,
  id: result.entry.id,
  title: result.entry.title,
  total: result.snapshot.summary.total,
  driveSynced: result.drive.synced,
}));

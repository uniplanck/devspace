import { statSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UsageContentMode } from "./config.js";

type TextContent = { type: "text"; text: string };
type ToolContent = TextContent | { type: "image"; data: string; mimeType: string };

interface UsageBucket {
  observedTokens: number;
  savedTokens: number;
  calls: number;
}

export interface UsageEntry {
  ts: string;
  sessionPid: number;
  workspaceId?: string;
  workspaceRoot?: string;
  workspaceName?: string;
  tool: string;
  path?: string;
  observedChars: number;
  observedTokens: number;
  savedChars: number;
  savedTokens: number;
  sessionObservedTokens: number;
  sessionSavedTokens: number;
  byTool: Record<string, UsageBucket>;
  note: string;
}

const session = {
  observedTokens: 0,
  savedTokens: 0,
  byTool: new Map<string, UsageBucket>(),
};
let historyWrite = Promise.resolve();

function historyPath(): string {
  return process.env.DEVSPACE_USAGE_HISTORY
    ?? join(homedir(), ".local", "share", "devspace", "usage-history.jsonl");
}

function clampNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(clampNumber(chars) / 4);
}

export function textContentChars(content: ToolContent[]): number {
  return content
    .filter((item): item is TextContent => item?.type === "text" && typeof item.text === "string")
    .reduce((total, item) => total + item.text.length, 0);
}

export function estimateFileChars(path: string): number {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : 0;
  } catch {
    return 0;
  }
}

export function editInputChars(edits: Array<{ oldText?: string; newText?: string }>): number {
  return edits.reduce(
    (total, edit) =>
      total + String(edit.oldText ?? "").length + String(edit.newText ?? "").length,
    0,
  );
}

export function compactTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

function byToolSnapshot(): Record<string, UsageBucket> {
  return Object.fromEntries(
    Array.from(session.byTool.entries()).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function appendHistory(entry: UsageEntry): void {
  const file = historyPath();
  historyWrite = historyWrite.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  }).catch(() => {
    // Diagnostic only. Never break the actual tool result.
  });
}

export function recordObservedToolUsage(input: {
  tool?: string;
  workspaceId?: string;
  workspaceRoot?: string;
  path?: string;
  observedChars: number;
  savedChars: number;
}): UsageEntry {
  const tool = input.tool ?? "unknown";
  const observedChars = clampNumber(input.observedChars);
  const savedChars = clampNumber(input.savedChars);
  const observedTokens = estimateTokensFromChars(observedChars);
  const savedTokens = estimateTokensFromChars(savedChars);
  const current = session.byTool.get(tool) ?? {
    observedTokens: 0,
    savedTokens: 0,
    calls: 0,
  };

  current.observedTokens += observedTokens;
  current.savedTokens += savedTokens;
  current.calls += 1;
  session.byTool.set(tool, current);
  session.observedTokens += observedTokens;
  session.savedTokens += savedTokens;

  const entry: UsageEntry = {
    ts: new Date().toISOString(),
    sessionPid: process.pid,
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    workspaceName: input.workspaceRoot
      ? String(input.workspaceRoot).split("/").filter(Boolean).at(-1)
      : undefined,
    tool,
    path: input.path,
    observedChars,
    observedTokens,
    savedChars,
    savedTokens,
    sessionObservedTokens: session.observedTokens,
    sessionSavedTokens: session.savedTokens,
    byTool: byToolSnapshot(),
    note: "DevSpace observed text estimate only. Not ChatGPT actual model usage.",
  };
  appendHistory(entry);
  return entry;
}

function fullUsageSummaryText(entry: UsageEntry): string {
  const byTool = Object.entries(entry.byTool)
    .map(([tool, value]) => `${tool} ${compactTokenCount(value.observedTokens)}`)
    .join(" / ");

  return [
    "DevSpace token estimate:",
    `Observed this call: ~${compactTokenCount(entry.observedTokens)} / session: ~${compactTokenCount(entry.sessionObservedTokens)}`,
    `Session by tool: ${byTool || "none"}`,
    `Estimated text avoided: ~${compactTokenCount(entry.sessionSavedTokens)} tokens`,
    "Calculated only from text handled by DevSpace. This is not actual model usage or billing data.",
  ].join("\n");
}

function compactUsageSummaryText(entry: UsageEntry): string {
  return `DevSpace token estimate: call ~${compactTokenCount(entry.observedTokens)} / session ~${compactTokenCount(entry.sessionObservedTokens)}`;
}

export function appendUsageToContent<T extends ToolContent>(
  content: T[],
  entry: UsageEntry,
  mode: UsageContentMode,
): ToolContent[] {
  if (mode === "off") return content;
  const text = mode === "full"
    ? fullUsageSummaryText(entry)
    : compactUsageSummaryText(entry);
  return [...content, { type: "text", text }];
}

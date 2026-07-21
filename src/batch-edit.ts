import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { resolveAllowedPath } from "./roots.js";
import {
  isGeneratedOrBinaryPath,
  isSecretLikePath,
  safeRealFile,
} from "./safe-inspection.js";

const MAX_FILES = 12;
const MAX_EDITS_PER_FILE = 30;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export interface BatchEditOperation {
  path: string;
  edits: Array<{
    oldText: string;
    newText: string;
  }>;
}

export interface BatchEditResult {
  status: "applied";
  files: Array<{
    path: string;
    replacements: number;
    charactersBefore: number;
    charactersAfter: number;
  }>;
  totalFiles: number;
  totalReplacements: number;
}

interface PreparedEdit {
  path: string;
  realPath: string;
  content: string;
  nextContent: string;
  replacements: number;
  mode: number;
  temporaryPath?: string;
}

export async function batchEditWorkspace(
  root: string,
  operations: BatchEditOperation[],
): Promise<BatchEditResult> {
  if (operations.length < 1 || operations.length > MAX_FILES) {
    throw new Error(`batch_edit requires between 1 and ${MAX_FILES} files.`);
  }

  const prepared: PreparedEdit[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;

  for (const operation of operations) {
    if (operation.edits.length < 1 || operation.edits.length > MAX_EDITS_PER_FILE) {
      throw new Error(`Each batch_edit file requires between 1 and ${MAX_EDITS_PER_FILE} edits: ${operation.path}`);
    }

    const resolved = resolveAllowedPath(operation.path, root, [root]);
    const realPath = await safeRealFile(resolved, root);
    if (!realPath) throw new Error(`File is unavailable or outside the workspace: ${operation.path}`);
    if (isSecretLikePath(realPath)) throw new Error(`Secret-like files cannot be batch edited: ${operation.path}`);
    if (isGeneratedOrBinaryPath(realPath)) throw new Error(`Generated or binary files cannot be batch edited: ${operation.path}`);
    if (seenPaths.has(realPath)) throw new Error(`Duplicate batch_edit path: ${operation.path}`);
    seenPaths.add(realPath);

    const info = await stat(realPath);
    if (!info.isFile()) throw new Error(`batch_edit target is not a file: ${operation.path}`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`batch_edit target is too large: ${operation.path}`);
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("batch_edit total input exceeds the 8 MiB limit.");

    const content = await readFile(realPath, "utf8");
    if (content.includes("\u0000")) throw new Error(`Binary content is not supported: ${operation.path}`);

    let nextContent = content;
    for (const [index, edit] of operation.edits.entries()) {
      if (!edit.oldText) throw new Error(`oldText must not be empty: ${operation.path} edit ${index + 1}`);
      const occurrences = countOccurrences(nextContent, edit.oldText);
      if (occurrences !== 1) {
        throw new Error(
          `oldText must match exactly once: ${operation.path} edit ${index + 1} matched ${occurrences} times.`,
        );
      }
      nextContent = nextContent.replace(edit.oldText, edit.newText);
    }

    prepared.push({
      path: operation.path,
      realPath,
      content,
      nextContent,
      replacements: operation.edits.length,
      mode: info.mode,
    });
  }

  try {
    for (const item of prepared) {
      item.temporaryPath = `${dirname(item.realPath)}/.${basename(item.realPath)}.devspace-batch-${randomUUID()}`;
      await writeFile(item.temporaryPath, item.nextContent, { encoding: "utf8", mode: item.mode });
    }
    for (const item of prepared) {
      await rename(item.temporaryPath!, item.realPath);
      item.temporaryPath = undefined;
    }
  } finally {
    await Promise.all(prepared.map(async (item) => {
      if (item.temporaryPath) await rm(item.temporaryPath, { force: true });
    }));
  }

  return {
    status: "applied",
    files: prepared.map((item) => ({
      path: item.path,
      replacements: item.replacements,
      charactersBefore: item.content.length,
      charactersAfter: item.nextContent.length,
    })),
    totalFiles: prepared.length,
    totalReplacements: prepared.reduce((sum, item) => sum + item.replacements, 0),
  };
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const index = content.indexOf(needle, offset);
    if (index === -1) break;
    count += 1;
    offset = index + Math.max(1, needle.length);
  }
  return count;
}

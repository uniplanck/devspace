import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import {
  closeBrowserTarget,
  configureBrowserDownloadDirectory,
  downloadChatGptImages,
  resetPreferredChatGptTaskTarget,
  type BrowserApprovalRecord,
} from "./browser-computer.js";
import {
  runChatGptTask,
  type ChatGptTaskState,
} from "./chatgpt-task.js";
import { chromaKeyPng, inspectPngAlpha, type PngAlphaStats } from "./png-chroma-key.js";
import { resolveExecutable } from "./shell-environment.js";

const execFileAsync = promisify(execFile);

export interface ImageToDriveInput {
  prompt: string;
  count?: number;
  transparent?: boolean;
  driveRemote?: string;
  drivePath?: string;
  filePrefix?: string;
  url?: string;
  timeoutMs?: number;
  autoSubmit?: boolean;
  closeWhenDone?: boolean;
}

export interface ImageToDriveFile {
  fileName: string;
  remotePath: string;
  link: string;
  bytes: number;
  alpha?: PngAlphaStats;
}

export interface ImageToDriveState {
  schemaVersion: 1;
  engine: "image-to-drive";
  phase: "generating" | "downloading" | "processing" | "uploading" | "completed";
  chatGpt?: ChatGptTaskState;
  imageUrls?: string[];
  files?: ImageToDriveFile[];
}

export type ImageToDriveResult =
  | {
      status: "waiting-approval";
      state: ImageToDriveState;
      approval: BrowserApprovalRecord;
    }
  | {
      status: "succeeded";
      state: ImageToDriveState;
      files: ImageToDriveFile[];
      conversationUrl: string;
    };

export interface ImageToDriveRuntime {
  taskId: string;
  onPhase?: (phase: ImageToDriveState["phase"], state: ImageToDriveState) => void;
  shouldStop?: () => boolean;
}

export async function runImageToDrive(
  rawInput: ImageToDriveInput,
  initialState: Partial<ImageToDriveState> | undefined,
  runtime: ImageToDriveRuntime,
): Promise<ImageToDriveResult> {
  const input = validateInput(rawInput);
  const state = normalizeState(initialState);
  state.phase = "generating";
  runtime.onPhase?.(state.phase, cloneState(state));
  const generated = await runChatGptTask(
    {
      prompt: buildImagePrompt(input),
      url: input.url,
      expectedImageCount: input.count,
      timeoutMs: input.timeoutMs,
      autoSubmit: input.autoSubmit,
      closeWhenDone: false,
    },
    state.chatGpt,
    {
      onPhase: (_phase, chatGptState) => {
        state.chatGpt = chatGptState;
        runtime.onPhase?.(state.phase, cloneState(state));
      },
      shouldStop: runtime.shouldStop,
    },
  );
  state.chatGpt = generated.state;
  if (generated.status === "waiting-approval") {
    runtime.onPhase?.(state.phase, cloneState(state));
    return { status: "waiting-approval", state, approval: generated.approval };
  }

  const imageUrls = generated.imageUrls.slice(0, input.count);
  if (imageUrls.length !== input.count) {
    throw new Error(`ChatGPT returned ${imageUrls.length} image(s); expected ${input.count}.`);
  }
  state.imageUrls = imageUrls;
  state.phase = "downloading";
  runtime.onPhase?.(state.phase, cloneState(state));
  const downloadDirectory = await configureBrowserDownloadDirectory({
    group: "image-to-drive",
    taskId: runtime.taskId,
  });
  const sourceNames = imageUrls.map((_, index) => `${input.filePrefix}-${String(index + 1).padStart(2, "0")}.png`);

  try {
    const downloaded = await downloadChatGptImages({
      urls: imageUrls,
      directory: downloadDirectory.path,
      fileNames: sourceNames,
      targetId: generated.state.targetId,
      timeoutMs: Math.min(120_000, input.timeoutMs),
    });
    state.phase = input.transparent ? "processing" : "uploading";
    runtime.onPhase?.(state.phase, cloneState(state));
    const uploadSources: Array<{ path: string; fileName: string; alpha?: PngAlphaStats }> = [];
    for (const file of downloaded.files) {
      if (runtime.shouldStop?.()) throw new Error("Image-to-Drive task was cancelled.");
      const source = await readFile(file.path);
      if (input.transparent) {
        const converted = chromaKeyPng(source);
        assertTransparentQuality(converted.stats);
        const transparentName = `${basename(file.fileName, extname(file.fileName))}-transparent.png`;
        const transparentPath = join(dirname(file.path), transparentName);
        await writeFile(transparentPath, converted.buffer, { mode: 0o600 });
        uploadSources.push({ path: transparentPath, fileName: transparentName, alpha: converted.stats });
      } else {
        inspectPngAlpha(source);
        uploadSources.push({ path: file.path, fileName: file.fileName });
      }
    }

    state.phase = "uploading";
    runtime.onPhase?.(state.phase, cloneState(state));
    const files: ImageToDriveFile[] = [];
    for (const source of uploadSources) {
      if (runtime.shouldStop?.()) throw new Error("Image-to-Drive task was cancelled.");
      const remotePath = joinRemotePath(input.drivePath, source.fileName);
      const link = await uploadToDrive(source.path, input.driveRemote, remotePath);
      const bytes = (await readFile(source.path)).byteLength;
      files.push({
        fileName: source.fileName,
        remotePath: `${input.driveRemote}${remotePath}`,
        link,
        bytes,
        ...(source.alpha ? { alpha: source.alpha } : {}),
      });
    }
    state.files = files;
    state.phase = "completed";
    runtime.onPhase?.(state.phase, cloneState(state));
    return {
      status: "succeeded",
      state,
      files,
      conversationUrl: generated.conversationUrl,
    };
  } finally {
    await rm(downloadDirectory.path, { recursive: true, force: true });
    if (input.closeWhenDone && generated.state.targetId) {
      if (generated.state.reusedPreferredTarget) {
        const reset = await resetPreferredChatGptTaskTarget(generated.state.targetId).catch(() => ({
          status: "not-preferred" as const,
        }));
        if (reset.status !== "reset") await closeBrowserTarget(generated.state.targetId).catch(() => undefined);
      } else {
        await closeBrowserTarget(generated.state.targetId).catch(() => undefined);
      }
    }
  }
}

function validateInput(input: ImageToDriveInput): Required<Omit<ImageToDriveInput, "url">> & { url?: string } {
  const prompt = input.prompt?.trim();
  if (!prompt || prompt.length > 3_000) throw new Error("Image-to-Drive prompt must contain 1 to 3000 characters.");
  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error("Image-to-Drive count must be an integer from 1 to 4.");
  const driveRemote = (input.driveRemote ?? process.env.DEVSPACE_IMAGE_DRIVE_REMOTE ?? "grive:").trim();
  if (!/^[A-Za-z0-9_.-]+:$/u.test(driveRemote)) throw new Error("Image-to-Drive driveRemote must be an rclone remote ending in colon.");
  const drivePath = sanitizeRemotePath(input.drivePath ?? process.env.DEVSPACE_IMAGE_DRIVE_PATH ?? "GPT-Agent/Images");
  const filePrefix = sanitizeFileStem(input.filePrefix ?? `chatgpt-image-${new Date().toISOString().slice(0, 10)}`);
  const timeoutMs = input.timeoutMs ?? 600_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 600_000) {
    throw new Error("Image-to-Drive timeoutMs must be from 30000 to 600000.");
  }
  return {
    prompt,
    count,
    transparent: input.transparent ?? false,
    driveRemote,
    drivePath,
    filePrefix,
    ...(input.url ? { url: input.url } : {}),
    timeoutMs,
    autoSubmit: input.autoSubmit ?? true,
    closeWhenDone: input.closeWhenDone ?? true,
  };
}

function buildImagePrompt(input: ReturnType<typeof validateInput>): string {
  const transparency = input.transparent
    ? [
        "The entire background must be one uniform solid chroma-key green #00FF00.",
        "Do not draw a checkerboard, gradient, scenery, floor, texture, green shadow, or green outline.",
        "Do not use green in people, text, icons, UI, borders, or foreground objects.",
      ].join(" ")
    : "Use a normal opaque background appropriate for the requested design.";
  return [
    input.prompt,
    `Generate exactly ${input.count} separate 16:9 PNG image${input.count === 1 ? "" : "s"}; do not combine them into a collage.`,
    transparency,
    "Return the generated image or images without an explanatory text response.",
  ].join("\n");
}

async function uploadToDrive(localPath: string, remote: string, remotePath: string): Promise<string> {
  const rclone = resolveExecutable("rclone");
  if (!rclone) throw new Error("rclone executable was not found.");
  const destination = `${remote}${remotePath}`;
  await runRcloneWithRetry(rclone, [
    "copyto",
    localPath,
    destination,
    "--retries", "5",
    "--retries-sleep", "10s",
    "--low-level-retries", "10",
    "--tpslimit", "8",
    "--tpslimit-burst", "8",
  ], 240_000);
  const linkResult = await runRcloneWithRetry(rclone, [
    "link",
    destination,
    "--tpslimit", "8",
    "--tpslimit-burst", "8",
  ], 90_000);
  const link = String(linkResult.stdout).trim().split(/\r?\n/u).find(Boolean);
  if (!link) throw new Error(`Drive upload succeeded but no share link was returned for ${remotePath}.`);
  return link;
}

async function runRcloneWithRetry(
  executable: string,
  args: string[],
  timeout: number,
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await execFileAsync(executable, args, {
        timeout,
        maxBuffer: 512 * 1024,
      });
    } catch (error) {
      lastError = error;
      const detail = error instanceof Error
        ? `${error.message}\n${String((error as Error & { stderr?: unknown }).stderr ?? "")}`
        : String(error);
      const retryable = /rateLimitExceeded|quota exceeded|userRateLimitExceeded|HTTP 429|temporar|timeout|connection reset/iu.test(detail);
      if (!retryable || attempt >= 5) throw error;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, attempt * 15_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function assertTransparentQuality(stats: PngAlphaStats): void {
  const total = stats.width * stats.height;
  if (stats.transparentPixels / total < 0.05) {
    throw new Error("Generated green-screen image did not produce enough transparent background.");
  }
  if (stats.residualGreenPixels / total > 0.01) {
    throw new Error("Transparent image retains too many green-dominant pixels.");
  }
}

function sanitizeRemotePath(value: string): string {
  const segments = value
    .normalize("NFKC")
    .split(/[\\/]+/u)
    .map((segment) => segment.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/gu, ""))
    .filter((segment) => segment && segment !== "." && segment !== "..");
  if (segments.length < 1 || segments.length > 8) throw new Error("Image-to-Drive drivePath must contain 1 to 8 safe path segments.");
  return segments.join("/");
}

function sanitizeFileStem(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/\.png$/iu, "")
    .slice(0, 80);
  if (!normalized || normalized === "." || normalized === "..") throw new Error("Image-to-Drive filePrefix is invalid.");
  return normalized;
}

function joinRemotePath(directory: string, fileName: string): string {
  return `${directory.replace(/\/+$/u, "")}/${fileName}`;
}

function normalizeState(value?: Partial<ImageToDriveState>): ImageToDriveState {
  return {
    schemaVersion: 1,
    engine: "image-to-drive",
    phase: value?.phase ?? "generating",
    ...(value?.chatGpt ? { chatGpt: value.chatGpt } : {}),
    ...(Array.isArray(value?.imageUrls) ? { imageUrls: value.imageUrls.filter((url): url is string => typeof url === "string") } : {}),
    ...(Array.isArray(value?.files) ? { files: value.files } : {}),
  };
}

function cloneState(state: ImageToDriveState): ImageToDriveState {
  return JSON.parse(JSON.stringify(state)) as ImageToDriveState;
}

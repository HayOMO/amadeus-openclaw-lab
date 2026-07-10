import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { backgroundToolParameters, enqueueBackgroundTool, shouldRunInBackground } from "../imagebot-background-jobs/index.js";
import { mediaReferenceToLocalPath } from "../imagebot-shared/media-uri.mjs";
import { resolveFfmpeg, resolveFfprobe } from "../imagebot-shared/media-runtime.mjs";
import { openclawStatePath } from "../imagebot-shared/openclaw-paths.mjs";

const TOOL_NAME = "video_keyframes";
const MEDIA_BRIEF_TOOL = "media_brief";
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_FRAMES = 12;
const HARD_MAX_FRAMES = 16;
const COMMAND_TIMEOUT_MS = 45_000;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  return typeof value === "string" ? value.trim() : fallback;
}

function readFrameCount(params) {
  const raw = isRecord(params) ? params.maxFrames : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_MAX_FRAMES;
  return Math.max(4, Math.min(HARD_MAX_FRAMES, Math.trunc(value)));
}

function resolveHomePath(...parts) {
  return openclawStatePath(...parts);
}

function resolveAllowedInput(videoPath) {
  const input = mediaReferenceToLocalPath(videoPath);
  if (!input) throw new Error("video path is required");
  const resolved = path.resolve(input);
  const mediaRoot = path.resolve(resolveHomePath("media"));
  const normalizedRoot = mediaRoot.toLowerCase();
  const normalizedPath = resolved.toLowerCase();
  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(normalizedRoot + path.sep.toLowerCase())) {
    throw new Error("video path is outside the bot media directory");
  }
  return resolved;
}

function runCommand(command, args, { signal, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("video command timed out"));
    }, timeoutMs);
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error("video command aborted"));
    };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${path.basename(command)} exited with code ${code}`));
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function probeDurationSeconds(videoPath, signal) {
  const ffprobe = resolveFfprobe(import.meta.url);
  const { stdout } = await runCommand(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    videoPath
  ], { signal, timeoutMs: 15_000 });
  const value = Number(stdout.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function probeMediaJson(videoPath, signal) {
  const ffprobe = resolveFfprobe(import.meta.url);
  const { stdout } = await runCommand(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,avg_frame_rate,duration",
    "-of", "json",
    videoPath
  ], { signal, timeoutMs: 15_000 });
  try {
    return JSON.parse(stdout || "{}");
  } catch {
    return {};
  }
}

function compactProbeSummary(probe = {}) {
  const format = probe.format || {};
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video") || {};
  const audio = streams.find((stream) => stream.codec_type === "audio") || {};
  const duration = Number(format.duration || video.duration || audio.duration);
  const size = Number(format.size);
  const parts = [];
  if (Number.isFinite(duration) && duration > 0) parts.push(`duration=${duration.toFixed(1)}s`);
  if (Number.isFinite(size) && size > 0) parts.push(`size=${(size / 1024 / 1024).toFixed(2)}MB`);
  if (video.codec_name) parts.push(`video=${video.codec_name}${video.width && video.height ? ` ${video.width}x${video.height}` : ""}`);
  if (audio.codec_name) parts.push(`audio=${audio.codec_name}`);
  return parts.join(" | ") || "probe=limited";
}

async function extractContactSheet(params, signal) {
  const videoPath = resolveAllowedInput(readString(params, "video"));
  const stat = await fs.stat(videoPath);
  if (!stat.isFile()) throw new Error("video path is not a file");
  if (stat.size > MAX_VIDEO_BYTES) throw new Error("video is larger than 25 MB; send a smaller clip");
  const durationSeconds = await probeDurationSeconds(videoPath, signal).catch(() => undefined);
  const maxFrames = readFrameCount(params);
  const cols = Math.ceil(Math.sqrt(maxFrames));
  const rows = Math.ceil(maxFrames / cols);
  const outDir = resolveHomePath("media", "video-keyframes");
  await fs.mkdir(outDir, { recursive: true });
  const outputPath = path.join(outDir, `video-keyframes-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`);
  const fps = durationSeconds ? Math.max(0.05, Math.min(2, maxFrames / Math.max(durationSeconds, 1))) : 0.5;
  const vf = [
    `fps=${fps.toFixed(3)}`,
    "scale=360:-1:force_original_aspect_ratio=decrease",
    `tile=${cols}x${rows}:padding=8:margin=8:color=black`
  ].join(",");
  const ffmpeg = resolveFfmpeg(import.meta.url);
  await runCommand(ffmpeg, [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", videoPath,
    "-vf", vf,
    "-frames:v", "1",
    "-q:v", "3",
    outputPath
  ], { signal });
  let samplingMode = "uniform";
  if (!(await fileExists(outputPath))) {
    // Very short Telegram animations can make ffmpeg's fps filter exit cleanly
    // without emitting a frame. Fall back to the first decoded frames.
    const fallbackVf = [
      "select=gte(n\\,0)",
      "scale=360:-1:force_original_aspect_ratio=decrease",
      `tile=${cols}x${rows}:padding=8:margin=8:color=black`
    ].join(",");
    await runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", videoPath,
      "-vf", fallbackVf,
      "-frames:v", "1",
      "-q:v", "3",
      outputPath
    ], { signal });
    samplingMode = "first-frames";
  }
  await fs.stat(outputPath);
  return {
    input: path.basename(videoPath),
    outputPath,
    sizeBytes: stat.size,
    durationSeconds,
    maxFrames,
    grid: `${cols}x${rows}`,
    samplingMode
  };
}

async function buildMediaBrief(params, signal) {
  const videoPath = resolveAllowedInput(readString(params, "video") || readString(params, "input"));
  const stat = await fs.stat(videoPath);
  if (!stat.isFile()) throw new Error("video path is not a file");
  if (stat.size > MAX_VIDEO_BYTES) throw new Error("video is larger than 25 MB; send a smaller clip");
  const probe = await probeMediaJson(videoPath, signal).catch(() => ({}));
  const keyframes = await extractContactSheet({
    video: videoPath,
    maxFrames: params.maxFrames
  }, signal);
  return {
    input: path.basename(videoPath),
    sizeBytes: stat.size,
    probe,
    probeSummary: compactProbeSummary(probe),
    keyframes
  };
}

function formatResult(result) {
  const duration = result.durationSeconds ? `${result.durationSeconds.toFixed(1)}s` : "unknown";
  return [
    "VIDEO_KEYFRAMES ok",
    `Video: ${result.input}`,
    `Duration: ${duration}`,
    `Size: ${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB`,
    `Frames: up to ${result.maxFrames} in a ${result.grid} contact sheet`,
    `Sampling: ${result.samplingMode}`,
    "A contact-sheet image is attached in this tool result. Use it to answer the user. Do not reveal local paths."
  ].join("\n");
}

function formatBriefResult(result) {
  return [
    "MEDIA_BRIEF ok",
    `Input: ${result.input}`,
    `Probe: ${result.probeSummary}`,
    `Keyframes: up to ${result.keyframes.maxFrames} in a ${result.keyframes.grid} contact sheet`,
    `Sampling: ${result.keyframes.samplingMode}`,
    "Use the attached contact sheet plus probe summary to answer the user. Do not reveal local paths."
  ].join("\n");
}

const videoKeyframesTool = {
  name: TOOL_NAME,
  label: "Video Keyframes",
  description:
    "Extract a keyframe contact sheet from a small Telegram-delivered video. " +
    "Use this before summarizing or answering questions about video content.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      video: {
        type: "string",
        description: "Current Telegram video local path, MEDIA line, media:// URI, or current/reply media handle."
      },
      maxFrames: {
        type: "number",
        description: `Number of sampled frames for the contact sheet, 4-${HARD_MAX_FRAMES}. Default ${DEFAULT_MAX_FRAMES}.`
      },
      ...backgroundToolParameters()
    },
    required: ["video"]
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    try {
      const config = videoKeyframesTool.config || {};
      if (shouldRunInBackground(params)) {
        return await enqueueBackgroundTool({
          toolName: TOOL_NAME,
          config,
          params,
          ctx,
          kind: `${TOOL_NAME}.extract`,
          label: `video_keyframes ${path.basename(readString(params, "video"))}`,
          payload: params,
          timeoutMs: COMMAND_TIMEOUT_MS + 15_000,
          handler: async ({ payload, signal: jobSignal, progress }) => {
            await progress({ percent: 5, note: "extracting keyframes" });
            const result = await extractContactSheet(payload, jobSignal);
            await progress({ percent: 95, note: "contact sheet ready" });
            return {
              status: "ok",
              resultText: [
                formatResult(result),
                `MEDIA: \`${result.outputPath}\``
              ].join("\n"),
              outputPath: result.outputPath,
              mediaPath: result.outputPath,
              durationSeconds: result.durationSeconds,
              maxFrames: result.maxFrames,
              grid: result.grid,
              samplingMode: result.samplingMode
            };
          }
        });
      }
      const result = await extractContactSheet(params, signal);
      const imageData = await fs.readFile(result.outputPath);
      return {
        content: [
          { type: "text", text: formatResult(result) },
          {
            type: "image",
            data: imageData.toString("base64"),
            mimeType: "image/jpeg",
            fileName: path.basename(result.outputPath)
          }
        ],
        details: { status: "ok", ...result }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `VIDEO_KEYFRAMES error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

const mediaBriefTool = {
  name: MEDIA_BRIEF_TOOL,
  label: "Media Brief",
  description:
    "Create a compact visual/media brief for a small Telegram-delivered video, animation, or GIF-like clip. " +
    "Returns probe metadata and a keyframe contact sheet.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      video: {
        type: "string",
        description: "Current Telegram video/animation local path, MEDIA line, media:// URI, or current/reply media handle."
      },
      input: {
        type: "string",
        description: "Alias for video."
      },
      maxFrames: {
        type: "number",
        description: `Number of sampled frames for the contact sheet, 4-${HARD_MAX_FRAMES}. Default ${DEFAULT_MAX_FRAMES}.`
      },
      ...backgroundToolParameters()
    },
    required: ["video"]
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    try {
      const config = mediaBriefTool.config || {};
      if (shouldRunInBackground(params)) {
        return await enqueueBackgroundTool({
          toolName: MEDIA_BRIEF_TOOL,
          config,
          params,
          ctx,
          kind: `${MEDIA_BRIEF_TOOL}.extract`,
          label: `media_brief ${path.basename(readString(params, "video") || readString(params, "input"))}`,
          payload: params,
          timeoutMs: COMMAND_TIMEOUT_MS + 25_000,
          handler: async ({ payload, signal: jobSignal, progress }) => {
            await progress({ percent: 5, note: "probing media" });
            const result = await buildMediaBrief(payload, jobSignal);
            await progress({ percent: 95, note: "brief ready" });
            return {
              status: "ok",
              resultText: [
                formatBriefResult(result),
                `MEDIA: \`${result.keyframes.outputPath}\``
              ].join("\n"),
              mediaPath: result.keyframes.outputPath,
              probeSummary: result.probeSummary,
              maxFrames: result.keyframes.maxFrames,
              grid: result.keyframes.grid,
              samplingMode: result.keyframes.samplingMode
            };
          }
        });
      }
      const result = await buildMediaBrief(params, signal);
      const imageData = await fs.readFile(result.keyframes.outputPath);
      return {
        content: [
          { type: "text", text: formatBriefResult(result) },
          {
            type: "image",
            data: imageData.toString("base64"),
            mimeType: "image/jpeg",
            fileName: path.basename(result.keyframes.outputPath)
          }
        ],
        details: { status: "ok", ...result, keyframes: { ...result.keyframes, probe: undefined } }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `MEDIA_BRIEF error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

export const __testing = {
  extractContactSheet,
  buildMediaBrief,
  probeMediaJson,
  resolveAllowedInput
};

export default {
  id: "imagebot-video-utils",
  name: "Imagebot Video Utilities",
  description: "Extracts bounded keyframe contact sheets from Telegram-delivered small videos.",
  register(api) {
    videoKeyframesTool.config = api.config || {};
    mediaBriefTool.config = api.config || {};
    api.registerTool(videoKeyframesTool, { name: TOOL_NAME });
    api.registerTool(mediaBriefTool, { name: MEDIA_BRIEF_TOOL });
  }
};

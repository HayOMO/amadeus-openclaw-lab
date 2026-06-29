import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { backgroundToolParameters, enqueueBackgroundTool, shouldRunInBackground } from "../imagebot-background-jobs/index.js";

const TOOL_NAME = "audio_transcribe";
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_DURATION_SECONDS = 15 * 60;
const COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = "Xenova/whisper-tiny";
const DEFAULT_ALLOWED_MODELS = [DEFAULT_MODEL];
const INPUT_EXTS = new Set([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac", ".mp4", ".mov", ".mkv", ".webm", ".avi"]);
const runtimeRequire = createRequire(import.meta.url);

const asrPipelinePromises = new Map();
let testTranscriber = null;

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function readNumber(params, key, fallback, min, max) {
  const raw = isRecord(params) ? params[key] : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Number(value)));
}

function readStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function allowedAsrModels(config = {}) {
  const configured = [
    ...readStringList(config.allowedModels),
    ...readStringList(config.asrModels)
  ];
  return [...new Set([...DEFAULT_ALLOWED_MODELS, ...configured])];
}

function resolveAsrModel(config = {}, params = {}) {
  const requested = readString(params, "model", DEFAULT_MODEL) || DEFAULT_MODEL;
  const allowed = allowedAsrModels(config);
  if (!allowed.includes(requested)) {
    throw new Error(`audio_transcribe model must be one of: ${allowed.join(", ")}`);
  }
  return requested;
}

function allowRemoteAsrModels(config = {}) {
  return config.allowRemoteModels !== false;
}

function clip(value, max = 600) {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function hash(value, len = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function commandPath(moduleName) {
  const mod = runtimeRequire(moduleName);
  const candidate = mod?.path ?? mod?.default?.path;
  if (!candidate) throw new Error(`${moduleName} did not expose a binary path`);
  return candidate;
}

function mediaRoot(config = {}) {
  const configured = String(config.mediaDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "media", "audio-transcribe"));
}

function storeRoot(config = {}) {
  const configured = String(config.storeDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "audio-transcribe"));
}

function allowedMediaRoots(config = {}) {
  const home = homeDir();
  const defaults = [
    path.join(home, ".openclaw", "media", "inbound"),
    path.join(home, ".openclaw", "media", "downloaded"),
    path.join(home, ".openclaw", "media", "practical-tools"),
    path.join(home, ".openclaw", "media", "video-keyframes"),
    mediaRoot(config)
  ];
  const extra = Array.isArray(config.allowedMediaRoots) ? config.allowedMediaRoots : [];
  return [...defaults, ...extra].map((entry) => path.resolve(String(entry))).filter(Boolean);
}

function isInside(root, target) {
  const rootNorm = path.resolve(root).toLowerCase();
  const targetNorm = path.resolve(target).toLowerCase();
  return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + path.sep);
}

function readMediaPath(raw) {
  const value = String(raw || "").trim().replace(/^`+|`+$/g, "");
  const mediaMatch = value.match(/(?:SPOILER_)?MEDIA:\s*`?([^`\r\n]+)`?/i);
  const unwrapped = mediaMatch ? mediaMatch[1] : value;
  if (/^file:\/\//i.test(unwrapped)) return decodeURIComponent(unwrapped.replace(/^file:\/\//i, ""));
  return unwrapped;
}

async function resolveAllowedInput(config, raw) {
  const input = readMediaPath(raw);
  if (!input) throw new Error("input audio/video path is required");
  if (/^https?:\/\//i.test(input)) throw new Error("audio_transcribe accepts bot-local media paths, not URLs");
  const resolved = path.resolve(input);
  if (!allowedMediaRoots(config).some((root) => isInside(root, resolved))) {
    throw new Error("input path is outside allowed bot media directories");
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("input path is not a file");
  if (stat.size > MAX_MEDIA_BYTES) throw new Error("input media is larger than 100 MB");
  const ext = path.extname(resolved).toLowerCase();
  if (!INPUT_EXTS.has(ext)) throw new Error(`unsupported audio/video type: ${ext || "unknown"}`);
  return { path: resolved, stat, ext };
}

function runProcess(command, args, { timeoutMs = COMMAND_TIMEOUT_MS, signal } = {}) {
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
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(command)} aborted`));
    };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    }
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      reject(error);
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

async function probeMedia(filePath, signal) {
  const ffprobe = commandPath("@ffprobe-installer/ffprobe");
  const { stdout } = await runProcess(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration,size,bit_rate:stream=codec_type,codec_name,channels,sample_rate,duration,width,height",
    "-of", "json",
    filePath
  ], { signal, timeoutMs: 20_000 });
  try {
    return JSON.parse(stdout || "{}");
  } catch {
    return {};
  }
}

function probeSummary(probe = {}) {
  const format = probe.format || {};
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const audio = streams.find((stream) => stream.codec_type === "audio") || {};
  const video = streams.find((stream) => stream.codec_type === "video") || {};
  const duration = Number(format.duration || audio.duration || video.duration);
  const size = Number(format.size);
  return {
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 0,
    sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
    audioCodec: audio.codec_name || "",
    sampleRate: audio.sample_rate || "",
    channels: audio.channels || "",
    videoCodec: video.codec_name || "",
    width: video.width || "",
    height: video.height || "",
    hasAudio: Boolean(audio.codec_name)
  };
}

function formatProbe(summary) {
  const parts = [];
  if (summary.durationSeconds) parts.push(`duration=${summary.durationSeconds.toFixed(1)}s`);
  if (summary.sizeBytes) parts.push(`size=${(summary.sizeBytes / 1024 / 1024).toFixed(2)}MB`);
  if (summary.audioCodec) parts.push(`audio=${summary.audioCodec}${summary.sampleRate ? ` ${summary.sampleRate}Hz` : ""}${summary.channels ? ` ch=${summary.channels}` : ""}`);
  if (summary.videoCodec) parts.push(`video=${summary.videoCodec}${summary.width && summary.height ? ` ${summary.width}x${summary.height}` : ""}`);
  return parts.join(" | ") || "probe=limited";
}

async function extractWav(config, inputPath, signal) {
  const outDir = mediaRoot(config);
  await fs.mkdir(outDir, { recursive: true });
  const outputPath = path.join(outDir, `audio-${Date.now()}-${hash(inputPath, 8)}.wav`);
  const ffmpeg = commandPath("@ffmpeg-installer/ffmpeg");
  await runProcess(ffmpeg, [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    outputPath
  ], { signal });
  await fs.stat(outputPath);
  return outputPath;
}

function readAscii(buffer, start, end) {
  return buffer.subarray(start, end).toString("ascii");
}

async function readWavMono16k(filePath) {
  const buffer = await fs.readFile(filePath);
  if (readAscii(buffer, 0, 4) !== "RIFF" || readAscii(buffer, 8, 12) !== "WAVE") {
    throw new Error("converted audio is not a WAV file");
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = readAscii(buffer, offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      };
    } else if (id === "data") {
      data = buffer.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("converted WAV is missing fmt/data chunks");
  if (fmt.audioFormat !== 1 || fmt.channels !== 1 || fmt.sampleRate !== 16000 || fmt.bitsPerSample !== 16) {
    throw new Error("converted WAV must be mono 16kHz pcm_s16le");
  }
  const samples = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < samples.length; i++) {
    const value = data.readInt16LE(i * 2);
    samples[i] = Math.max(-1, Math.min(1, value / 32768));
  }
  return samples;
}

async function loadAsrPipeline(config = {}, model = DEFAULT_MODEL) {
  if (testTranscriber) return testTranscriber;
  const remote = allowRemoteAsrModels(config);
  const key = `${model}|remote=${remote ? "1" : "0"}`;
  if (!asrPipelinePromises.has(key)) {
    const promise = (async () => {
      const transformers = await import("@xenova/transformers");
      transformers.env.cacheDir = path.join(homeDir(), ".openclaw", "models", "transformers");
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = remote;
      return await transformers.pipeline("automatic-speech-recognition", model || DEFAULT_MODEL);
    })().catch((error) => {
      asrPipelinePromises.delete(key);
      throw error;
    });
    asrPipelinePromises.set(key, promise);
  }
  return await asrPipelinePromises.get(key);
}

async function saveTranscript(config, input, transcript, details) {
  const outDir = storeRoot(config);
  await fs.mkdir(outDir, { recursive: true });
  const id = `tr_${hash(`${Date.now()}:${input}:${transcript}`, 16)}`;
  const outPath = path.join(outDir, `${id}.md`);
  const body = [
    `# Audio Transcript ${id}`,
    "",
    `- created: ${new Date().toISOString()}`,
    `- input: ${path.basename(input)}`,
    `- durationSeconds: ${details.durationSeconds || 0}`,
    `- model: ${details.model || ""}`,
    `- language: ${details.language || ""}`,
    "",
    "## Transcript",
    "",
    transcript || "(empty)"
  ].join("\n");
  await fs.writeFile(outPath, `${body}\n`, "utf8");
  return { id, path: outPath };
}

async function transcribe(config = {}, params = {}, signal) {
  const input = await resolveAllowedInput(config, readString(params, "input") || readString(params, "audio") || readString(params, "video") || readString(params, "media"));
  const probe = await probeMedia(input.path, signal);
  const summary = probeSummary(probe);
  if (!summary.hasAudio) throw new Error("input has no audio stream");
  const maxSeconds = readNumber(params, "maxSeconds", MAX_DURATION_SECONDS, 5, MAX_DURATION_SECONDS);
  if (summary.durationSeconds && summary.durationSeconds > maxSeconds) {
    throw new Error(`audio is ${summary.durationSeconds.toFixed(1)}s; maxSeconds is ${maxSeconds}`);
  }
  const wavPath = await extractWav(config, input.path, signal);
  const audio = await readWavMono16k(wavPath);
  const model = resolveAsrModel(config, params);
  const language = readString(params, "language");
  const task = readString(params, "task", "transcribe");
  const asr = await loadAsrPipeline(config, model);
  const result = await asr(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    language: language || undefined,
    task,
    return_timestamps: false
  });
  const transcript = clip(result?.text || String(result || ""), 16000);
  const saved = await saveTranscript(config, input.path, transcript, {
    durationSeconds: summary.durationSeconds,
    model,
    language: language || "auto"
  });
  return {
    input: path.basename(input.path),
    wavPath,
    transcript,
    transcriptId: saved.id,
    transcriptPath: saved.path,
    probeSummary: formatProbe(summary),
    summary,
    model,
    language: language || "auto"
  };
}

async function probe(config = {}, params = {}, signal) {
  const input = await resolveAllowedInput(config, readString(params, "input") || readString(params, "audio") || readString(params, "video") || readString(params, "media"));
  const raw = await probeMedia(input.path, signal);
  const summary = probeSummary(raw);
  return {
    input: path.basename(input.path),
    probeSummary: formatProbe(summary),
    summary
  };
}

function formatTranscribeResult(result) {
  return [
    "AUDIO_TRANSCRIBE ok",
    `input: ${result.input}`,
    `probe: ${result.probeSummary}`,
    `model: ${result.model}`,
    `language: ${result.language}`,
    `transcript_id: ${result.transcriptId}`,
    "",
    "transcript:",
    result.transcript || "(empty)"
  ].join("\n");
}

function formatProbeResult(result) {
  return [
    "AUDIO_TRANSCRIBE probe",
    `input: ${result.input}`,
    `probe: ${result.probeSummary}`
  ].join("\n");
}

const audioTranscribeTool = {
  name: TOOL_NAME,
  label: "Audio Transcribe",
  description: "Probe or transcribe bot-local Telegram audio/video media. Transcription uses local Whisper through transformers when available.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      input: { type: "string", description: "Bot-local audio/video path or MEDIA line." },
      audio: { type: "string", description: "Alias for input." },
      video: { type: "string", description: "Alias for input." },
      media: { type: "string", description: "Alias for input." },
      action: { type: "string", enum: ["transcribe", "probe"], description: "Default transcribe." },
      language: { type: "string", description: "Optional language hint, e.g. zh, en, ja. Empty means auto." },
      task: { type: "string", enum: ["transcribe", "translate"], description: "Whisper task. Default transcribe." },
      model: { type: "string", description: `Approved ASR model id. Default ${DEFAULT_MODEL}; arbitrary remote models are rejected.` },
      maxSeconds: { type: "number", description: `Reject longer media. Max ${MAX_DURATION_SECONDS}.` },
      ...backgroundToolParameters()
    }
  },
  async execute(_toolCallId, params = {}, signal, _onUpdate, ctx) {
    try {
      const config = audioTranscribeTool.config || {};
      const action = readString(params, "action", "transcribe").toLowerCase();
      if (shouldRunInBackground(params) && action === "transcribe") {
        return await enqueueBackgroundTool({
          toolName: TOOL_NAME,
          config,
          params,
          ctx,
          kind: "audio_transcribe.transcribe",
          label: `audio_transcribe ${path.basename(readString(params, "input") || readString(params, "audio") || readString(params, "video") || "media")}`,
          payload: params,
          timeoutMs: COMMAND_TIMEOUT_MS + 180_000,
          handler: async ({ payload, signal: jobSignal, progress }) => {
            await progress({ percent: 5, note: "probing audio" });
            const result = await transcribe(config, payload, jobSignal);
            await progress({ percent: 95, note: "transcript ready" });
            return {
              status: "ok",
              resultText: formatTranscribeResult(result),
              transcriptId: result.transcriptId,
              transcriptPath: result.transcriptPath
            };
          }
        });
      }
      if (action === "probe") {
        const result = await probe(config, params, signal);
        return { content: [{ type: "text", text: formatProbeResult(result) }], details: { status: "ok", action, ...result } };
      }
      if (action !== "transcribe") throw new Error("action must be transcribe or probe");
      const result = await transcribe(config, params, signal);
      return {
        content: [{ type: "text", text: formatTranscribeResult(result) }],
        details: { status: "ok", action, ...result }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `AUDIO_TRANSCRIBE error: ${clip(message, 600)}` }], details: { status: "failed", error: message } };
    }
  }
};

export const __testing = {
  allowedMediaRoots,
  resolveAllowedInput,
  probeMedia,
  probeSummary,
  readWavMono16k,
  mediaRoot,
  storeRoot,
  allowedAsrModels,
  resolveAsrModel,
  allowRemoteAsrModels,
  setTranscriberForTests(fn) {
    testTranscriber = fn;
    asrPipelinePromises.clear();
  }
};

export default {
  id: "imagebot-audio-transcribe",
  name: "Imagebot Audio Transcribe",
  description: "Bounded local audio/video probe and transcription.",
  register(api) {
    audioTranscribeTool.config = api.config || {};
    api.registerTool(audioTranscribeTool, { name: TOOL_NAME });
  }
};

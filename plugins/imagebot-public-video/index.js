import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { backgroundToolParameters, enqueueBackgroundTool, shouldRunInBackground } from "../imagebot-background-jobs/index.js";
import { assertPublicUrl as assertSharedPublicUrl } from "../imagebot-shared/public-network-guard.mjs";
import { openclawStatePath } from "../imagebot-shared/openclaw-paths.mjs";

const TOOL_NAME = "public_video";
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const HARD_MAX_BYTES = 300 * 1024 * 1024;
const DEFAULT_MAX_DURATION_SECONDS = 20 * 60;
const HARD_MAX_DURATION_SECONDS = 60 * 60;
const DEFAULT_TIMEOUT_MS = 180_000;
const SUBTITLE_MAX_CHARS = 16_000;
const runtimeRequire = createRequire(import.meta.url);

let ytDlpRunner = null;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function readBoolean(params, key, fallback = false) {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(1|true|yes|on)$/i.test(value.trim());
  return fallback;
}

function readNumber(params, key, fallback, min, max) {
  const raw = isRecord(params) ? params[key] : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clip(value, max = 600) {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function hash(value, len = 12) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function mediaRoot(config = {}) {
  const configured = String(config.mediaDir || "").trim();
  return path.resolve(configured || openclawStatePath("media", "public-video"));
}

function storeRoot(config = {}) {
  const configured = String(config.storeDir || "").trim();
  return path.resolve(configured || openclawStatePath("public-video"));
}

function metadataRoot(config = {}) {
  return path.join(storeRoot(config), "metadata");
}

function subtitlesRoot(config = {}) {
  return path.join(storeRoot(config), "subtitles");
}

function sanitizeFilename(value, fallback = "video") {
  const cleaned = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function normalizeUrl(raw) {
  const input = String(raw || "").trim();
  if (!input) throw new Error("url is required");
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error("invalid url");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("only public http/https video URLs are allowed");
  parsed.hash = "";
  return parsed;
}

async function assertPublicUrl(raw, options = {}) {
  const parsed = normalizeUrl(raw);
  await assertSharedPublicUrl(parsed.toString(), options);
  return parsed;
}

function ytdlp() {
  if (ytDlpRunner) return ytDlpRunner;
  return runtimeRequire("youtube-dl-exec");
}

async function runYtDlp(url, options) {
  const runner = ytdlp();
  return await runner(url, options);
}

function publicMetadata(info = {}) {
  return {
    id: info.id || "",
    title: info.title || "",
    uploader: info.uploader || info.channel || "",
    channel: info.channel || "",
    duration: Number(info.duration || 0) || 0,
    webpageUrl: info.webpage_url || info.webpageUrl || "",
    originalUrl: info.original_url || info.originalUrl || "",
    extractor: info.extractor || "",
    liveStatus: info.live_status || "",
    availability: info.availability || "",
    viewCount: info.view_count || 0,
    uploadDate: info.upload_date || "",
    description: clip(info.description || "", 1600),
    thumbnail: info.thumbnail || ""
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function metadata(config = {}, params = {}) {
  const parsed = await assertPublicUrl(readString(params, "url"), config.publicNetworkGuard || {});
  const info = await runYtDlp(parsed.toString(), {
    dumpSingleJson: true,
    skipDownload: true,
    noPlaylist: !readBoolean(params, "allowPlaylist", false),
    noWarnings: true,
    socketTimeout: 20
  });
  const meta = publicMetadata(info);
  const id = meta.id || hash(parsed.toString(), 16);
  const outPath = path.join(metadataRoot(config), `${sanitizeFilename(id)}.json`);
  await writeJson(outPath, info);
  return { url: parsed.toString(), metadata: meta, metadataPath: outPath, raw: info };
}

function maxBytes(config = {}, params = {}) {
  const configured = Number(config.maxBytes || DEFAULT_MAX_BYTES);
  return readNumber(params, "maxBytes", Number.isFinite(configured) ? configured : DEFAULT_MAX_BYTES, 1_000_000, HARD_MAX_BYTES);
}

function maxDurationSeconds(config = {}, params = {}) {
  const configured = Number(config.maxDurationSeconds || DEFAULT_MAX_DURATION_SECONDS);
  return readNumber(params, "maxDurationSeconds", Number.isFinite(configured) ? configured : DEFAULT_MAX_DURATION_SECONDS, 5, HARD_MAX_DURATION_SECONDS);
}

function byteLimitArg(bytes) {
  return `${Math.floor(bytes / 1024 / 1024)}M`;
}

async function listFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(dir, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat?.isFile()) files.push({ filePath, stat });
    }
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    return files;
  } catch {
    return [];
  }
}

async function newestFile(dir, sinceMs, exts = null) {
  const files = await listFiles(dir);
  return files.find((file) => file.stat.mtimeMs >= sinceMs - 2000 && (!exts || exts.has(path.extname(file.filePath).toLowerCase())));
}

async function downloadVideo(config = {}, params = {}) {
  const meta = await metadata(config, params);
  const duration = Number(meta.metadata.duration || 0);
  const maxDuration = maxDurationSeconds(config, params);
  if (duration && duration > maxDuration) throw new Error(`video is ${duration.toFixed(1)}s; maxDurationSeconds is ${maxDuration}`);
  const limitBytes = maxBytes(config, params);
  const outDir = mediaRoot(config);
  await fs.mkdir(outDir, { recursive: true });
  const id = sanitizeFilename(meta.metadata.id || hash(meta.url, 16));
  const title = sanitizeFilename(meta.metadata.title || "video", "video");
  const output = path.join(outDir, `${Date.now()}-${id}-${title}.%(ext)s`);
  const startedAt = Date.now();
  await runYtDlp(meta.url, {
    noPlaylist: !readBoolean(params, "allowPlaylist", false),
    maxFilesize: byteLimitArg(limitBytes),
    matchFilter: `duration <= ${maxDuration}`,
    format: readString(params, "format", "bv*[height<=720]+ba/b[height<=720]/b"),
    mergeOutputFormat: "mp4",
    output,
    restrictFilenames: true,
    noWarnings: true,
    socketTimeout: 20
  });
  const file = await newestFile(outDir, startedAt, new Set([".mp4", ".webm", ".mkv", ".m4a", ".mp3"]));
  if (!file) throw new Error("download completed but no output file was found");
  if (file.stat.size > limitBytes) throw new Error("downloaded file exceeded maxBytes");
  return {
    ...meta,
    mediaPath: file.filePath,
    sizeBytes: file.stat.size,
    format: path.extname(file.filePath).slice(1)
  };
}

function cleanVtt(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const trimmed = line
      .replace(/<[^>]+>/g, "")
      .replace(/\{\\[^}]+\}/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (!trimmed || trimmed === "WEBVTT" || /^\d+$/.test(trimmed) || /-->/i.test(trimmed) || /^Kind:|^Language:/i.test(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return clip(out.join("\n"), SUBTITLE_MAX_CHARS);
}

async function subtitles(config = {}, params = {}) {
  const meta = await metadata(config, params);
  const outDir = subtitlesRoot(config);
  await fs.mkdir(outDir, { recursive: true });
  const base = path.join(outDir, `${Date.now()}-${sanitizeFilename(meta.metadata.id || hash(meta.url, 16))}`);
  const startedAt = Date.now();
  await runYtDlp(meta.url, {
    skipDownload: true,
    writeSubs: true,
    writeAutoSubs: true,
    subLangs: readString(params, "languages", "zh.*,en.*,ja.*"),
    subFormat: "vtt/best",
    noPlaylist: true,
    output: `${base}.%(ext)s`,
    noWarnings: true,
    socketTimeout: 20
  });
  const files = (await listFiles(outDir))
    .filter((file) => file.stat.mtimeMs >= startedAt - 2000 && /\.(vtt|srt)$/i.test(file.filePath))
    .slice(0, 6);
  const parts = [];
  for (const file of files) {
    const raw = await fs.readFile(file.filePath, "utf8").catch(() => "");
    const text = cleanVtt(raw);
    if (text) parts.push({ filePath: file.filePath, text });
  }
  if (!parts.length) throw new Error("no subtitles or auto-captions were found");
  return {
    ...meta,
    subtitles: parts,
    transcript: clip(parts.map((part) => part.text).join("\n\n"), SUBTITLE_MAX_CHARS)
  };
}

async function brief(config = {}, params = {}) {
  const meta = await metadata(config, params);
  let subs = null;
  try {
    subs = await subtitles(config, params);
  } catch {
    subs = null;
  }
  return {
    ...meta,
    transcript: subs?.transcript || "",
    subtitleCount: subs?.subtitles?.length || 0
  };
}

function accountPlaceholder(params = {}) {
  const site = readString(params, "site") || readString(params, "url") || "account-backed site";
  return {
    status: "unavailable",
    site: clip(site, 160),
    reason: "account-backed video download is a placeholder; no account connector, cookies, or owner browser profile access is configured",
    nextStep: "add a dedicated account connector with explicit credentials/session storage and tests"
  };
}

function formatMetadata(result) {
  const m = result.metadata || {};
  return [
    "PUBLIC_VIDEO metadata ok",
    `title: ${m.title || "(unknown)"}`,
    m.uploader ? `uploader: ${m.uploader}` : "",
    m.duration ? `duration: ${m.duration.toFixed(1)}s` : "",
    m.webpageUrl ? `url: ${m.webpageUrl}` : `url: ${result.url || ""}`,
    m.description ? `description: ${clip(m.description, 800)}` : ""
  ].filter(Boolean).join("\n");
}

function formatDownload(result) {
  return [
    "PUBLIC_VIDEO download ok",
    `title: ${result.metadata?.title || "(unknown)"}`,
    result.metadata?.duration ? `duration: ${result.metadata.duration.toFixed(1)}s` : "",
    `size: ${(Number(result.sizeBytes || 0) / 1024 / 1024).toFixed(2)} MB`,
    `MEDIA: \`${result.mediaPath}\``
  ].filter(Boolean).join("\n");
}

function formatSubtitles(result) {
  return [
    "PUBLIC_VIDEO subtitles ok",
    `title: ${result.metadata?.title || "(unknown)"}`,
    `subtitle_files: ${result.subtitles?.length || 0}`,
    "",
    "transcript:",
    result.transcript || "(empty)"
  ].join("\n");
}

function formatBrief(result) {
  return [
    "PUBLIC_VIDEO brief ok",
    `title: ${result.metadata?.title || "(unknown)"}`,
    result.metadata?.uploader ? `uploader: ${result.metadata.uploader}` : "",
    result.metadata?.duration ? `duration: ${result.metadata.duration.toFixed(1)}s` : "",
    result.transcript ? `transcript:\n${result.transcript}` : "transcript: (none found)"
  ].filter(Boolean).join("\n");
}

function formatPlaceholder(result) {
  return [
    "PUBLIC_VIDEO account_placeholder",
    `site: ${result.site}`,
    `status: ${result.status}`,
    `reason: ${result.reason}`,
    `next: ${result.nextStep}`
  ].join("\n");
}

async function runAction(config, params, signal) {
  const action = readString(params, "action", "metadata").toLowerCase();
  if (signal?.aborted) throw new Error("public video operation aborted");
  if (["account_placeholder", "account_download", "account"].includes(action)) return { action: "account_placeholder", result: accountPlaceholder(params) };
  if (action === "metadata" || action === "probe") return { action: "metadata", result: await metadata(config, params) };
  if (action === "download") return { action, result: await downloadVideo(config, params) };
  if (action === "subtitles" || action === "captions" || action === "transcript") return { action: "subtitles", result: await subtitles(config, params) };
  if (action === "brief" || action === "analyze") return { action: "brief", result: await brief(config, params) };
  throw new Error("action must be metadata, download, subtitles, brief, or account_placeholder");
}

function formatResult(action, result) {
  if (action === "metadata") return formatMetadata(result);
  if (action === "download") return formatDownload(result);
  if (action === "subtitles") return formatSubtitles(result);
  if (action === "brief") return formatBrief(result);
  if (action === "account_placeholder") return formatPlaceholder(result);
  return `PUBLIC_VIDEO ${action} ok`;
}

function detailsFor(action, result) {
  const details = { result, status: "ok", action };
  for (const [key, value] of Object.entries(result || {})) {
    if (key === "status") {
      details.resultStatus = value;
    } else {
      details[key] = value;
    }
  }
  return details;
}

const publicVideoTool = {
  name: TOOL_NAME,
  label: "Public Video",
  description: "Fetch public video metadata, subtitles, or bounded downloads. Account-backed site download is a placeholder only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["metadata", "probe", "subtitles", "captions", "transcript", "brief", "analyze", "download", "account_placeholder", "account_download", "account"], description: "Public video operation." },
      url: { type: "string", description: "Public http/https video URL." },
      site: { type: "string", description: "Account-backed site name for placeholder action." },
      languages: { type: "string", description: "Subtitle language pattern for yt-dlp, e.g. zh.*,en.*." },
      format: { type: "string", description: "yt-dlp format selector for download." },
      maxBytes: { type: "number", description: "Download byte cap. Default 100 MB, hard cap 300 MB." },
      maxDurationSeconds: { type: "number", description: "Duration cap. Default 20 minutes, hard cap 60 minutes." },
      allowPlaylist: { type: "boolean", description: "Allow playlist metadata/download. Default false." },
      ...backgroundToolParameters()
    },
    required: ["action"]
  },
  async execute(_toolCallId, params = {}, signal, _onUpdate, ctx) {
    try {
      const config = publicVideoTool.config || {};
      if (shouldRunInBackground(params) && !["metadata", "probe", "account_placeholder", "account_download", "account"].includes(readString(params, "action", "metadata").toLowerCase())) {
        return await enqueueBackgroundTool({
          toolName: TOOL_NAME,
          config,
          params,
          ctx,
          kind: "public_video.run",
          label: `public_video ${readString(params, "action", "metadata")} ${clip(readString(params, "url"), 80)}`,
          payload: params,
          timeoutMs: DEFAULT_TIMEOUT_MS + 120_000,
          handler: async ({ payload, signal: jobSignal, progress }) => {
            await progress({ percent: 5, note: "public video operation started" });
            const { action, result } = await runAction(config, payload, jobSignal);
            await progress({ percent: 95, note: "public video operation completed" });
            return {
              status: "ok",
              resultText: formatResult(action, result),
              action,
              mediaPath: result.mediaPath || "",
              metadata: result.metadata || null
            };
          }
        });
      }
      const { action, result } = await runAction(config, params, signal);
      return { content: [{ type: "text", text: formatResult(action, result) }], details: detailsFor(action, result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `PUBLIC_VIDEO error: ${clip(message, 600)}` }], details: { status: "failed", error: message } };
    }
  }
};

export const __testing = {
  normalizeUrl,
  assertPublicUrl,
  cleanVtt,
  metadata,
  subtitles,
  downloadVideo,
  accountPlaceholder,
  mediaRoot,
  storeRoot,
  setYtDlpRunnerForTests(fn) {
    ytDlpRunner = fn;
  }
};

export default {
  id: "imagebot-public-video",
  name: "Imagebot Public Video",
  description: "Bounded public video metadata, subtitle, and download helpers.",
  register(api) {
    publicVideoTool.config = api.config || {};
    api.registerTool(publicVideoTool, { name: TOOL_NAME });
  }
};

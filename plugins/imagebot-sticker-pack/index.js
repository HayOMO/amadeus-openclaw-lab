import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  bindMutationPlanToContext,
  hasModelSuppliedApprovalFlag,
  hasTrustedMutationApproval,
  mutationTargetFingerprint,
  newMutationApprovalCode,
  newMutationPlanId,
  requireTrustedActorContext,
  requireTrustedMutationApproval,
  trustedMutationContext,
  verifyMutationPlanApproval
} from "../imagebot-shared/mutation-authorization.mjs";
import { registerLifecycleHook } from "../imagebot-shared/openclaw-lifecycle-hooks.mjs";
import { mediaReferenceToLocalPath } from "../imagebot-shared/media-uri.mjs";
import { withStateFileLock, writeJsonAtomic } from "../imagebot-shared/state-file.mjs";

const TOOL_NAME = "sticker_pack";
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const STATIC_STICKER_BYTES = 512 * 1024;
const ANIMATED_STICKER_BYTES = 64 * 1024;
const VIDEO_STICKER_BYTES = 256 * 1024;
const STICKER_SIZE = 512;
const MAX_BATCH_ITEMS = 20;
const MAX_BATCH_CONCURRENCY = 4;
const CONTACT_SHEET_TILE = 176;
const CONTACT_SHEET_PADDING = 16;
const CONTACT_SHEET_MAX_BYTES = 1_500_000;
const MAX_DRAFT_STICKERS = 50;
const DEFAULT_DRAFT_TARGET = 12;
const MAX_PREPARE_BATCH_ITEMS = 20;
const MAX_CREATE_SET_ITEMS = 50;
const MAX_ADD_BATCH_ITEMS = 50;
const MAX_REGULAR_SET_STICKERS = 120;
const MAX_CUSTOM_EMOJI_SET_STICKERS = 200;
const SOURCE_SEARCH_DEFAULT_COUNT = 6;
const SOURCE_SEARCH_MAX_COUNT = 12;
const SOURCE_SEARCH_TEXT_RESULT_COUNT = 12;
const SOURCE_SEARCH_MAX_QUERIES = 4;
const SOURCE_SEARCH_INSPECT_MAX = 6;
const SOURCE_SEARCH_REQUEST_TIMEOUT_MS = 15_000;
const MANAGED_SET_REGISTRY_VERSION = 1;
const TOOL_CONTEXT_TTL_MS = 10 * 60_000;
const DIRECT_IMPORT_APPROVAL_ERROR =
  "copy_set/import_set dryRun:false requires the current Telegram sender to match userId/ownerUserId, a plan_id, or trusted runtime mutation approval; model-supplied approval flags are ignored.";
const EXPOSED_STICKER_ACTIONS = [
  "plan",
  "prepare",
  "prepare_batch",
  "draft",
  "get_draft",
  "review_brief",
  "review_draft",
  "review_sheet",
  "list_managed_sets",
  "set_default_set",
  "forget_managed_set",
  "publish_draft",
  "search_sets",
  "search_sources",
  "source_set",
  "download_set",
  "copy_set",
  "import_set",
  "upload",
  "create",
  "create_batch",
  "add",
  "add_from_sticker",
  "add_batch",
  "get",
  "delete_sticker",
  "set_keywords",
  "set_emoji_list",
  "link"
];
const STICKER_REMOTE_MUTATION_ACTIONS = new Set([
  "upload",
  "create",
  "create_batch",
  "add",
  "add_from_sticker",
  "add_batch",
  "publish_draft",
  "copy_set",
  "import_set",
  "delete_sticker",
  "set_keywords",
  "set_emoji_list"
]);
const DEFAULT_TRUSTED_DIRECT_MUTATION_ACTIONS = new Set([
  "upload",
  "create",
  "create_batch",
  "add",
  "add_from_sticker",
  "add_batch",
  "publish_draft",
  "copy_set",
  "import_set",
  "set_keywords",
  "set_emoji_list"
]);
const ALLOWED_INPUT_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const ALLOWED_STICKER_EXTS = new Set([".webp", ".png", ".tgs", ".webm"]);
const DOWNLOAD_STICKER_EXTS = new Set([".webp", ".png", ".tgs", ".webm"]);
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "Chrome/120.0 Safari/537.36";
const runtimeRequire = createRequire(import.meta.url);

let fetchImpl = globalThis.fetch;
let sharpModulePromise = null;
let preferSharpWorker = false;
const pendingStickerToolContexts = new Map();

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

function readBoolean(params, key, fallback = false) {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(1|true|yes|on)$/i.test(value.trim());
  return fallback;
}

function readBooleanAny(params, keys = [], fallback = false) {
  for (const key of keys) {
    if (isRecord(params) && params[key] !== undefined) return readBoolean(params, key, fallback);
  }
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

function sanitizeTelegramText(value) {
  return String(value ?? "")
    .replace(/https:\/\/api\.telegram\.org\/file\/bot[^/\s<>"']+\/[^\s<>"']+/gi, "https://api.telegram.org/file/[telegram-token-redacted]")
    .replace(/https:\/\/api\.telegram\.org\/bot[^\s<>"']+/gi, "https://api.telegram.org/[telegram-token-redacted]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[telegram-token-redacted]")
    .replace(/\r\n/g, "\n")
    .trim();
}

async function fetchTelegram(url, init, label = "telegram request") {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} failed: ${sanitizeTelegramText(message)}`);
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hash(value, len = 12) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function safeFilePart(value, fallback = "item") {
  const cleaned = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function getSharp() {
  if (!sharpModulePromise) {
    sharpModulePromise = Promise.resolve().then(() => {
      const mod = runtimeRequire("sharp");
      return mod.default || mod;
    });
  }
  return sharpModulePromise;
}

function isSharpNativeLoadError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /Could not load the "sharp" module|ERR_DLOPEN_FAILED|specified procedure could not be found/i.test(message);
}

function sharpWorkerPath() {
  return fileURLToPath(new URL("./sharp-worker.mjs", import.meta.url));
}

async function runSharpWorker(action, payload = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [sharpWorkerPath()], {
      cwd: path.dirname(sharpWorkerPath()),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`sharp worker ${action} failed (${code}): ${clip(stderr || stdout, 800)}`));
        return;
      }
      try {
        const result = JSON.parse(stdout || "{}");
        if (result?.ok === false) {
          reject(new Error(`sharp worker ${action} failed: ${result.error || "unknown error"}`));
          return;
        }
        resolve(result.result ?? result);
      } catch (error) {
        reject(new Error(`sharp worker ${action} returned invalid JSON: ${clip(stdout, 500)}`));
      }
    });
    child.stdin.end(JSON.stringify({ action, payload }));
  });
}

async function withSharpFallback(action, payload, inProcess) {
  if (preferSharpWorker) return await runSharpWorker(action, payload);
  try {
    return await inProcess();
  } catch (error) {
    if (!isSharpNativeLoadError(error)) throw error;
    preferSharpWorker = true;
    sharpModulePromise = null;
    return await runSharpWorker(action, payload);
  }
}

function mediaRoot(config = {}) {
  const configured = String(config.mediaDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "media", "sticker-pack"));
}

function draftRoot(config = {}) {
  const configured = String(config.draftDir || "").trim();
  return path.resolve(configured || path.join(mediaRoot(config), "drafts"));
}

function managedSetsPath(config = {}) {
  const configured = String(config.managedSetsPath || config.managedStickerSetsPath || "").trim();
  return path.resolve(configured || path.join(mediaRoot(config), "managed-sets.json"));
}

function stickerPlansPath(config = {}) {
  const configured = String(config.mutationPlansPath || config.stickerPlansPath || "").trim();
  return path.resolve(configured || path.join(mediaRoot(config), "mutation-plans.json"));
}

async function resolveStickerDownloadDir(config = {}, params = {}, setName = "sticker-set") {
  const root = path.join(mediaRoot(config), "downloads");
  await fs.mkdir(root, { recursive: true });
  const explicit = readString(params, "downloadDir") || readString(params, "outputDir");
  const explicitPath = explicit ? readMediaPath(explicit) : "";
  const dir = explicitPath
    ? (path.isAbsolute(explicitPath) ? path.resolve(explicitPath) : path.resolve(root, explicitPath))
    : path.join(root, `${safeFilePart(setName, "sticker-set")}-${Date.now()}`);
  if (!isInside(root, dir)) throw new Error("downloadDir/outputDir must stay inside the sticker-pack downloads directory");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function stickerByteLimit(extOrFormat = "") {
  const value = String(extOrFormat || "").trim().toLowerCase();
  if (value === "animated" || value === ".tgs") return ANIMATED_STICKER_BYTES;
  if (value === "video" || value === ".webm") return VIDEO_STICKER_BYTES;
  return STATIC_STICKER_BYTES;
}

function stickerMimeType(format = "", filePath = "") {
  const normalized = normalizeStickerFormat(format, filePath);
  if (normalized === "animated") return "application/x-tgsticker";
  if (normalized === "video") return "video/webm";
  return path.extname(filePath).toLowerCase() === ".png" ? "image/png" : "image/webp";
}

function tokenFile(config = {}) {
  const configured = String(config.tokenFile || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "secrets", "telegram-imagebot.token"));
}

async function writeJson(file, value) {
  await writeJsonAtomic(file, value, { space: 2 });
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

function allowedMediaRoots(config = {}) {
  const home = homeDir();
  const defaults = [
    path.join(home, ".openclaw", "media", "inbound"),
    path.join(home, ".openclaw", "media", "downloaded"),
    path.join(home, ".openclaw", "media", "practical-tools"),
    path.join(home, ".openclaw", "media", "meme-tools"),
    path.join(home, ".openclaw", "media", "gallery-resend"),
    path.join(home, ".openclaw", "media", "gacha-archive"),
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

function readMediaPath(raw, config = {}) {
  return mediaReferenceToLocalPath(raw, config);
}

async function resolveAllowedFile(config, raw, { sticker = false } = {}) {
  const input = readMediaPath(raw, config);
  if (!input) throw new Error("media/file path is required");
  if (/^https?:\/\//i.test(input)) throw new Error("sticker_pack accepts bot-local media paths, not URLs");
  const resolved = path.resolve(input);
  if (!allowedMediaRoots(config).some((root) => isInside(root, resolved))) {
    throw new Error("media path is outside allowed bot media directories");
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("media path is not a file");
  const ext = path.extname(resolved).toLowerCase();
  const allowed = sticker ? ALLOWED_STICKER_EXTS : ALLOWED_INPUT_EXTS;
  if (!allowed.has(ext)) throw new Error(`unsupported ${sticker ? "sticker" : "image"} type: ${ext || "unknown"}`);
  const maxBytes = sticker ? stickerByteLimit(ext) : MAX_INPUT_BYTES;
  if (stat.size > maxBytes) {
    throw new Error(`${sticker ? "sticker" : "input"} file is too large`);
  }
  return { path: resolved, stat, ext };
}

function normalizeFraming(value, fallback = "smart") {
  const requested = String(value || fallback).trim().toLowerCase();
  if (["smart", "contain", "cover"].includes(requested)) return requested;
  return fallback;
}

function transparentBackground() {
  return { r: 255, g: 255, b: 255, alpha: 0 };
}

async function normalizeStickerAlphaEdges(sharp, image) {
  const normalized = await image.png().toBuffer();
  const raw = await sharp(normalized)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const data = Buffer.from(raw.data);
  let changed = false;
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3];
    if (alpha === 0) {
      if (data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255) {
        data[offset] = 255;
        data[offset + 1] = 255;
        data[offset + 2] = 255;
        changed = true;
      }
      continue;
    }
    if (alpha < 255) {
      const r = Math.min(255, Math.round((data[offset] * 255) / alpha));
      const g = Math.min(255, Math.round((data[offset + 1] * 255) / alpha));
      const b = Math.min(255, Math.round((data[offset + 2] * 255) / alpha));
      if (r !== data[offset] || g !== data[offset + 1] || b !== data[offset + 2]) {
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        changed = true;
      }
    }
  }
  if (!changed) return normalized;
  return sharp(data, {
    raw: {
      width: raw.info.width,
      height: raw.info.height,
      channels: 4
    }
  })
    .png()
    .toBuffer();
}

async function renderStickerBuffer(inputPath, params = {}) {
  const sharp = await getSharp();
  const framing = normalizeFraming(readString(params, "framing"), readString(params, "defaultFraming", "contain"));
  const padding = readNumber(params, "padding", framing === "cover" ? 0 : 18, 0, 96);
  const target = Math.max(1, STICKER_SIZE - padding * 2);
  const trim = readBoolean(params, "trim", framing === "smart");
  const trimThreshold = readNumber(params, "trimThreshold", 12, 0, 80);
  let image = sharp(inputPath, { animated: false, limitInputPixels: 72_000_000 }).rotate().ensureAlpha();
  if (trim) {
    image = image.trim({ threshold: trimThreshold });
  }
  const normalized = await normalizeStickerAlphaEdges(sharp, image);
  const resized = await sharp(normalized)
    .resize(target, target, {
      fit: framing === "cover" ? "cover" : "inside",
      position: "attention",
      withoutEnlargement: false,
      background: transparentBackground()
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((STICKER_SIZE - resized.info.width) / 2);
  const top = Math.floor((STICKER_SIZE - resized.info.height) / 2);
  return {
    buffer: await sharp({
      create: {
        width: STICKER_SIZE,
        height: STICKER_SIZE,
        channels: 4,
        background: transparentBackground()
      }
    })
      .composite([{ input: resized.data, left, top }])
      .png()
      .toBuffer(),
    framing,
    padding,
    trimmed: trim
  };
}

async function writeStaticStickerInProcess(inputPath, outputPath, params = {}) {
  const requestedQuality = readNumber(params, "quality", 92, 50, 98);
  const attempts = [requestedQuality, 88, 84, 80, 76, 72, 68, 64, 60, 56, 52, 50]
    .filter((value, index, list) => list.indexOf(value) === index)
    .sort((left, right) => right - left);
  const base = await renderStickerBuffer(inputPath, params);
  let lastStat = null;
  for (const quality of attempts) {
    const sharp = await getSharp();
    await sharp(base.buffer)
      .webp({ quality, effort: 5, alphaQuality: Math.min(100, quality + 4) })
      .toFile(outputPath);
    const stat = await fs.stat(outputPath);
    lastStat = stat;
    if (stat.size <= STATIC_STICKER_BYTES) {
      return { ...base, quality, sizeBytes: stat.size };
    }
  }
  throw new Error(`prepared sticker is larger than ${Math.floor(STATIC_STICKER_BYTES / 1024)} KB (${Math.ceil((lastStat?.size || 0) / 1024)} KB)`);
}

async function writeStaticSticker(inputPath, outputPath, params = {}) {
  return await withSharpFallback("writeStaticSticker", { inputPath, outputPath, params }, async () => {
    return await writeStaticStickerInProcess(inputPath, outputPath, params);
  });
}

async function prepareSticker(config = {}, params = {}) {
  const input = await resolveAllowedFile(config, readString(params, "input") || readString(params, "image") || readString(params, "media"));
  const outDir = mediaRoot(config);
  await fs.mkdir(outDir, { recursive: true });
  const outputPath = path.join(outDir, `sticker-${Date.now()}-${hash(input.path)}.webp`);
  const rendered = await writeStaticSticker(input.path, outputPath, params);
  return {
    input: path.basename(input.path),
    outputPath,
    sizeBytes: rendered.sizeBytes,
    width: STICKER_SIZE,
    height: STICKER_SIZE,
    quality: rendered.quality,
    framing: rendered.framing,
    padding: rendered.padding,
    trimmed: rendered.trimmed,
    stickerFormat: "static",
    mimeType: "image/webp"
  };
}

async function buildContactSheet(config = {}, stickers = []) {
  const ok = stickers.filter((item) => item?.status === "ok" && item.outputPath);
  if (!ok.length) return null;
  const columns = Math.min(4, ok.length);
  const rows = Math.ceil(ok.length / columns);
  const width = CONTACT_SHEET_PADDING * 2 + columns * CONTACT_SHEET_TILE;
  const height = CONTACT_SHEET_PADDING * 2 + rows * CONTACT_SHEET_TILE;
  const outDir = mediaRoot(config);
  await fs.mkdir(outDir, { recursive: true });
  const outputPath = path.join(outDir, `sticker-contact-${Date.now()}-${hash(ok.map((item) => item.outputPath).join("|"))}.png`);
  return await withSharpFallback("contactSheet", {
    outputPath,
    width,
    height,
    items: ok.map((item) => ({ outputPath: item.outputPath, index: item.index }))
  }, async () => {
    const sharp = await getSharp();
    const composites = [];
    for (let index = 0; index < ok.length; index += 1) {
      const item = ok[index];
      const col = index % columns;
      const row = Math.floor(index / columns);
      const left = CONTACT_SHEET_PADDING + col * CONTACT_SHEET_TILE;
      const top = CONTACT_SHEET_PADDING + row * CONTACT_SHEET_TILE;
      const sticker = await sharp(item.outputPath)
        .resize(128, 128, { fit: "contain", background: transparentBackground() })
        .png()
        .toBuffer();
      const label = Buffer.from(`<svg width="${CONTACT_SHEET_TILE}" height="${CONTACT_SHEET_TILE}" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="4" width="${CONTACT_SHEET_TILE - 8}" height="${CONTACT_SHEET_TILE - 8}" rx="10" fill="#ffffff" stroke="#d4d4d8"/>
  <text x="14" y="24" font-family="Arial, sans-serif" font-size="18" fill="#18181b">${item.index + 1}</text>
</svg>`);
      composites.push({ input: label, left, top });
      composites.push({ input: sticker, left: left + 24, top: top + 34 });
    }
    await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 244, g: 244, b: 245, alpha: 1 }
      }
    })
      .composite(composites)
      .png()
      .toFile(outputPath);
    const stat = await fs.stat(outputPath);
    return { outputPath, sizeBytes: stat.size, width, height };
  });
}

function decisionStyle(item = {}) {
  if (item.status === "failed") return { label: "FAILED", border: "#71717a", fill: "#f4f4f5" };
  const decision = String(item.decision || "pending").toLowerCase();
  if (decision === "keep") return { label: "KEEP", border: "#16a34a", fill: "#f0fdf4" };
  if (decision === "reject") return { label: "REJECT", border: "#dc2626", fill: "#fef2f2" };
  return { label: "PENDING", border: "#d97706", fill: "#fffbeb" };
}

async function buildReviewSheet(config = {}, draft = {}) {
  const stickers = Array.isArray(draft.stickers) ? draft.stickers : [];
  if (!stickers.length) return null;
  const columns = Math.min(4, stickers.length);
  const rows = Math.ceil(stickers.length / columns);
  const width = CONTACT_SHEET_PADDING * 2 + columns * CONTACT_SHEET_TILE;
  const height = CONTACT_SHEET_PADDING * 2 + rows * CONTACT_SHEET_TILE;
  const outDir = mediaRoot(config);
  await fs.mkdir(outDir, { recursive: true });
  const outputPath = path.join(outDir, `sticker-review-${Date.now()}-${hash(`${draft.id || ""}|${draft.updatedAt || ""}`)}.png`);
  return await withSharpFallback("reviewSheet", {
    outputPath,
    width,
    height,
    items: stickers.map((item, index) => ({
      outputPath: item.outputPath || "",
      index: Number.isInteger(item.index) ? item.index : index,
      status: item.status || "",
      decision: item.decision || "",
      emojiCount: item.emojiList?.length || 0
    }))
  }, async () => {
    const sharp = await getSharp();
    const composites = [];
    for (let index = 0; index < stickers.length; index += 1) {
      const item = stickers[index];
      const col = index % columns;
      const row = Math.floor(index / columns);
      const left = CONTACT_SHEET_PADDING + col * CONTACT_SHEET_TILE;
      const top = CONTACT_SHEET_PADDING + row * CONTACT_SHEET_TILE;
      const style = decisionStyle(item);
      const emojiState = item.emojiList?.length ? `emoji:${item.emojiList.length}` : "emoji:missing";
      const displayIndex = Number.isInteger(item.index) ? item.index + 1 : index + 1;
      const label = Buffer.from(`<svg width="${CONTACT_SHEET_TILE}" height="${CONTACT_SHEET_TILE}" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="4" width="${CONTACT_SHEET_TILE - 8}" height="${CONTACT_SHEET_TILE - 8}" rx="10" fill="${style.fill}" stroke="${style.border}" stroke-width="4"/>
  <text x="14" y="25" font-family="Arial, sans-serif" font-size="17" font-weight="700" fill="#18181b">${displayIndex} ${escapeXml(style.label)}</text>
  <text x="14" y="${CONTACT_SHEET_TILE - 16}" font-family="Arial, sans-serif" font-size="13" fill="#3f3f46">${escapeXml(emojiState)}</text>
</svg>`);
      composites.push({ input: label, left, top });
      if (item.outputPath) {
        try {
          const sticker = await sharp(item.outputPath)
            .resize(128, 128, { fit: "contain", background: transparentBackground() })
            .png()
            .toBuffer();
          composites.push({ input: sticker, left: left + 24, top: top + 34 });
        } catch {
          // The text label above is still useful if a preview file disappeared.
        }
      }
    }
    await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 244, g: 244, b: 245, alpha: 1 }
      }
    })
      .composite(composites)
      .png()
      .toFile(outputPath);
    const stat = await fs.stat(outputPath);
    return { outputPath, sizeBytes: stat.size, width, height };
  });
}

async function prepareStickerBatch(config = {}, params = {}) {
  const items = readInputItems(params, { limit: MAX_PREPARE_BATCH_ITEMS, label: "prepare_batch" });
  if (!items.length) throw new Error("inputs/items are required for prepare_batch");
  const concurrency = readNumber(params, "concurrency", 3, 1, MAX_BATCH_CONCURRENCY);
  const startedAt = Date.now();
  const stickers = await mapLimit(items, concurrency, async (item, index) => {
    try {
      const prepared = await prepareSticker(config, { ...params, framing: readString(params, "framing", "smart"), ...item, input: item.input });
      return {
        status: "ok",
        index,
        input: prepared.input,
        outputPath: prepared.outputPath,
        sizeBytes: prepared.sizeBytes,
        width: prepared.width,
        height: prepared.height,
        quality: prepared.quality,
        framing: prepared.framing,
        padding: prepared.padding,
        trimmed: prepared.trimmed,
        emojiList: normalizeEmojiList(item),
        keywords: normalizeKeywords(item)
      };
    } catch (error) {
      return {
        status: "failed",
        index,
        input: path.basename(readMediaPath(item.input || "")),
        error: clip(error instanceof Error ? error.message : String(error), 240)
      };
    }
  });
  const contactSheet = readBoolean(params, "contactSheet", true) ? await buildContactSheet(config, stickers) : null;
  const okCount = stickers.filter((item) => item.status === "ok").length;
  return {
    status: okCount === stickers.length ? "ok" : "partial",
    total: stickers.length,
    okCount,
    failedCount: stickers.length - okCount,
    concurrency,
    durationMs: Date.now() - startedAt,
    stickers,
    contactSheet
  };
}

function normalizeOwnerUserId(value, ctx = {}) {
  const raw = String(value || ctx.userId || ctx.senderId || "").trim();
  const match = raw.match(/\d+/);
  return match ? match[0] : "";
}

function contextRequesterUserId(ctx = {}) {
  const trusted = trustedMutationContext(ctx);
  if (trusted.senderId) return trusted.senderId;
  const candidates = [
    ctx.userId,
    ctx.senderId,
    ctx.fromUserId,
    ctx.telegramUserId,
    ctx.sender?.id,
    ctx.from?.id,
    ctx.message?.from?.id,
    ctx.event?.from?.id
  ];
  for (const value of candidates) {
    const id = normalizeOwnerUserId(value);
    if (id) return id;
  }
  return "";
}

function assertOwnerMatchesContext(ownerUserId, ctx = {}, { dryRun = true, action = "sticker mutation" } = {}) {
  if (dryRun) return;
  const requester = contextRequesterUserId(ctx);
  if (!requester) {
    throw new Error(`${action} owner-check failed: trusted requester context is required for dryRun:false`);
  }
  if (String(ownerUserId) !== requester) {
    throw new Error(`${action} owner-check failed: userId/ownerUserId must match the current Telegram sender for dryRun:false`);
  }
}

function ownerMatchesCurrentRequester(ownerUserId, ctx = {}) {
  const owner = normalizeOwnerUserId(ownerUserId, ctx);
  const requester = contextRequesterUserId(ctx);
  return Boolean(owner && requester && owner === requester);
}

function addDefaultsToRealMutation(params = {}, ctx = {}) {
  if (params.dryRun !== undefined) return false;
  const owner = readString(params, "userId") || readString(params, "ownerUserId");
  return ownerMatchesCurrentRequester(owner, ctx);
}

function trustedDirectMutationActions(config = {}) {
  const raw = isRecord(config.trustedDirectMutations) ? config.trustedDirectMutations : {};
  const configured = Array.isArray(raw.actions)
    ? raw.actions
    : Array.isArray(config.trustedDirectMutationActions)
      ? config.trustedDirectMutationActions
      : [];
  const source = raw.replaceDefaults === true || config.replaceTrustedDirectMutationDefaults === true
    ? configured
    : [...DEFAULT_TRUSTED_DIRECT_MUTATION_ACTIONS, ...configured];
  return new Set(source
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => STICKER_REMOTE_MUTATION_ACTIONS.has(value) && value !== "delete_sticker"));
}

function allowsTrustedDirectMutation(config = {}, action = "", ctx = {}) {
  if (String(action || "").trim().toLowerCase() === "delete_sticker") return false;
  const raw = isRecord(config.trustedDirectMutations) ? config.trustedDirectMutations : {};
  const disabled = raw.enabled === false || config.allowTrustedDirectMutations === false;
  const enabled = raw.enabled === true || config.allowTrustedDirectMutations === true;
  if (disabled || !enabled) return false;
  if (!contextRequesterUserId(ctx)) return false;
  return trustedDirectMutationActions(config).has(String(action || "").trim().toLowerCase());
}

function readToolName(event = {}) {
  return readString(event, "toolName") ||
    readString(event, "tool_name") ||
    readString(event, "name") ||
    readString(event?.tool, "name") ||
    readString(event?.tool, "id") ||
    readString(event, "tool");
}

function stickerToolCallId(event = {}, ctx = {}, explicit = "") {
  return String(explicit ||
    readString(event, "toolCallId") ||
    readString(event, "tool_call_id") ||
    readString(event, "callId") ||
    readString(event, "id") ||
    readString(ctx, "toolCallId") ||
    readString(ctx, "tool_call_id") ||
    "").trim();
}

function stickerToolContextKeys(toolCallId = "", event = {}, ctx = {}) {
  const id = stickerToolCallId(event, ctx, toolCallId);
  const runId = readString(event, "runId") || readString(event, "run_id") || readString(ctx, "runId") || readString(ctx, "run_id");
  const sessionKey = readString(event, "sessionKey") || readString(event, "session_key") || readString(ctx, "sessionKey") || readString(ctx, "session_key");
  const keys = [];
  if (id) keys.push(`tool:${id}`);
  if (id && runId) keys.push(`run:${runId}:tool:${id}`);
  if (id && sessionKey) keys.push(`session:${sessionKey}:tool:${id}`);
  return [...new Set(keys)];
}

function pruneStickerToolContexts(now = Date.now()) {
  for (const [key, record] of pendingStickerToolContexts) {
    if (!record || Number(record.expiresAt || 0) <= now) pendingStickerToolContexts.delete(key);
  }
}

function mergeStickerRuntimeContext(cached = {}, provided = {}) {
  return {
    ...cached,
    ...provided,
    mutationAuthorization: {
      ...(isRecord(cached.mutationAuthorization) ? cached.mutationAuthorization : {}),
      ...(isRecord(provided.mutationAuthorization) ? provided.mutationAuthorization : {})
    }
  };
}

function rememberStickerToolContext(event = {}, ctx = {}) {
  const toolName = readToolName(event);
  if (toolName !== TOOL_NAME) return;
  if (ctx?.agentId && ctx.agentId !== "imagebot") return;
  const id = stickerToolCallId(event, ctx);
  if (!id) return;
  pruneStickerToolContexts();
  const record = {
    expiresAt: Date.now() + TOOL_CONTEXT_TTL_MS,
    ctx: {
      ...ctx,
      toolCallId: id,
      runId: readString(event, "runId") || readString(event, "run_id") || readString(ctx, "runId"),
      sessionKey: readString(event, "sessionKey") || readString(event, "session_key") || readString(ctx, "sessionKey") || readString(ctx, "session_key")
    }
  };
  for (const key of stickerToolContextKeys(id, event, ctx)) pendingStickerToolContexts.set(key, record);
}

function forgetStickerToolContext(event = {}, ctx = {}, explicit = "") {
  for (const key of stickerToolContextKeys(explicit, event, ctx)) pendingStickerToolContexts.delete(key);
}

function resolveStickerToolContext(toolCallId = "", ctx = {}) {
  const provided = isRecord(ctx) ? ctx : {};
  pruneStickerToolContexts();
  for (const key of stickerToolContextKeys(toolCallId, {}, provided)) {
    const record = pendingStickerToolContexts.get(key);
    if (record?.ctx) return mergeStickerRuntimeContext(record.ctx, provided);
  }
  if (contextRequesterUserId(provided) || hasTrustedMutationApproval(provided)) return provided;
  return provided;
}

function readStickerTargetAction(params = {}, fallback = "") {
  return (readString(params, "targetAction") ||
    readString(params, "target_action") ||
    readString(params, "forAction") ||
    fallback).toLowerCase();
}

function compactPlanItems(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (!isRecord(item)) return String(item || "").trim();
    return {
      index: Number.isFinite(Number(item.index)) ? Number(item.index) : undefined,
      input: readString(item, "input") || readString(item, "image") || readString(item, "media") || readString(item, "stickerPath"),
      fileId: readString(item, "fileId") || readString(item, "stickerFileId") || readString(item, "sticker"),
      format: readString(item, "format") || readString(item, "stickerFormat"),
      emoji: readString(item, "emoji"),
      emojiList: Array.isArray(item.emojiList) ? item.emojiList.map((value) => String(value || "").trim()).filter(Boolean) : undefined,
      keywords: Array.isArray(item.keywords) ? item.keywords.map((value) => String(value || "").trim()).filter(Boolean) : readString(item, "keywords"),
      decision: readString(item, "decision")
    };
  });
}

function stickerMutationFingerprint(action, params = {}) {
  const inputs = Array.isArray(params.inputs)
    ? params.inputs.map((value) => String(value || "").trim()).filter(Boolean)
    : readString(params, "inputs");
  return mutationTargetFingerprint({
    tool: TOOL_NAME,
    action,
    userId: normalizeOwnerUserId(readString(params, "userId") || readString(params, "ownerUserId")),
    name: readString(params, "name") || readString(params, "setName"),
    targetName: readString(params, "targetName"),
    sourceSet: readString(params, "sourceSet") || readString(params, "sourceName") || readString(params, "fromSet") || readString(params, "source") || readString(params, "url"),
    draftId: readString(params, "draftId"),
    draftPath: readMediaPath(readString(params, "draftPath")),
    fileId: readString(params, "fileId") || readString(params, "sticker"),
    input: readMediaPath(readString(params, "input") || readString(params, "image") || readString(params, "media") || readString(params, "stickerPath")),
    inputs,
    items: compactPlanItems(params.items),
    mode: readString(params, "mode") || readString(params, "publishMode"),
    stickerType: readString(params, "stickerType"),
    format: readString(params, "format") || readString(params, "stickerFormat"),
    emoji: readString(params, "emoji"),
    emojiList: Array.isArray(params.emojiList) ? params.emojiList.map((value) => String(value || "").trim()).filter(Boolean) : undefined,
    keywords: readString(params, "keywords")
  });
}

function stickerMutationTargetParams(action, params = {}) {
  const target = { targetAction: String(action || "").trim().toLowerCase() };
  const stringKeys = [
    "userId", "ownerUserId", "name", "setName", "targetName", "sourceSet",
    "sourceName", "fromSet", "source", "url", "draftId", "draftPath",
    "fileId", "sticker", "input", "image", "media", "stickerPath",
    "mode", "publishMode", "stickerType", "format", "stickerFormat",
    "emoji", "keywords", "title", "botUsername"
  ];
  for (const key of stringKeys) {
    const value = readString(params, key);
    if (value) target[key] = value;
  }
  if (Array.isArray(params.inputs)) {
    const inputs = params.inputs.map((value) => String(value || "").trim()).filter(Boolean);
    if (inputs.length) target.inputs = inputs;
  }
  if (Array.isArray(params.items)) {
    const items = compactPlanItems(params.items);
    if (items.length) target.items = items;
  }
  if (Array.isArray(params.emojiList)) {
    const emojiList = params.emojiList.map((value) => String(value || "").trim()).filter(Boolean);
    if (emojiList.length) target.emojiList = emojiList;
  }
  return target;
}

function mergeStickerPlanTargetParams(params = {}, plan = {}) {
  const target = isRecord(plan.targetParams) ? plan.targetParams : {};
  return {
    ...target,
    ...params
  };
}

async function loadStickerPlans(config = {}) {
  try {
    const loaded = await readJson(stickerPlansPath(config));
    if (isRecord(loaded) && isRecord(loaded.plans)) return loaded;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { version: 1, plans: {} };
}

async function saveStickerPlans(config = {}, plans = {}) {
  plans.version = 1;
  plans.updatedAt = new Date().toISOString();
  await writeJson(stickerPlansPath(config), plans);
}

async function makeStickerMutationPlan(config = {}, params = {}, ctx = {}) {
  const targetAction = readStickerTargetAction(params);
  if (!targetAction || !STICKER_REMOTE_MUTATION_ACTIONS.has(targetAction)) {
    throw new Error("sticker_pack plan requires targetAction for a Telegram mutation action");
  }
  return await withStateFileLock(stickerPlansPath(config), async () => {
    const plans = await loadStickerPlans(config);
    const plan = bindMutationPlanToContext({
      id: newMutationPlanId("sticker_plan"),
      kind: "sticker_pack",
      targetAction,
      t: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      reason: clip(readString(params, "reason"), 500),
      fingerprint: stickerMutationFingerprint(targetAction, params),
      targetParams: stickerMutationTargetParams(targetAction, params),
      ...(targetAction === "delete_sticker" ? { approvalCode: newMutationApprovalCode("DELETE-STICKER") } : {}),
      used: false
    }, ctx, { label: "sticker_pack plan" });
    plans.plans[plan.id] = plan;
    const entries = Object.entries(plans.plans).filter(([, entry]) => Date.parse(entry.expiresAt || 0) > Date.now() && entry.used !== true);
    plans.plans = Object.fromEntries(entries.slice(-120));
    await saveStickerPlans(config, plans);
    return plan;
  });
}

async function planStickerMutation(config = {}, params = {}, ctx = {}) {
  const plan = await makeStickerMutationPlan(config, params, ctx);
  return {
    status: "planned",
    plan,
    planId: plan.id,
    targetAction: plan.targetAction,
    expiresAt: plan.expiresAt,
    approvalCode: plan.approvalCode,
    fingerprint: plan.fingerprint,
    dryRun: true
  };
}

function verifyTrustedStickerPlanActor(plan = {}, ctx = {}, label = "sticker_pack") {
  let context;
  try {
    context = requireTrustedActorContext(ctx, { label });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (plan.scopeKey && plan.scopeKey !== context.scopeKey) {
    return { ok: false, reason: `${label} confirmation scope does not match the original request` };
  }
  if (plan.actorKey && plan.actorKey !== context.actorKey) {
    return { ok: false, reason: `${label} confirmation must come from the original requester` };
  }
  return { ok: true, context };
}

async function consumeStickerMutationPlan(config = {}, action = "", params = {}, ctx = {}) {
  const planId = readString(params, "plan_id") || readString(params, "planId");
  if (!planId) return { ok: false, reason: `${action} dryRun:false requires confirmation plan_id or trusted runtime mutation approval` };
  return await withStateFileLock(stickerPlansPath(config), async () => {
    const plans = await loadStickerPlans(config);
    const plan = plans.plans[planId];
    if (!plan || plan.kind !== "sticker_pack") return { ok: false, reason: "No matching active sticker_pack mutation plan." };
    if (plan.used === true || Date.parse(plan.expiresAt || 0) <= Date.now()) return { ok: false, reason: "Sticker mutation plan expired or already used." };
    if (plan.targetAction !== action) return { ok: false, reason: "Sticker mutation plan does not match the requested action." };
    if (plan.fingerprint !== stickerMutationFingerprint(action, params)) {
      return { ok: false, reason: "Sticker mutation plan does not match the requested target." };
    }
    const approval = action === "delete_sticker"
      ? (plan.approvalCode
          ? verifyMutationPlanApproval({
              plan,
              ctx,
              approvalCode: plan.approvalCode,
              label: "sticker delete"
            })
          : { ok: false, reason: "delete_sticker approval plan is missing an approval code; create a new delete plan" })
      : verifyTrustedStickerPlanActor(plan, ctx, "sticker_pack");
    if (!approval.ok) return approval;
    plan.used = true;
    plan.usedAt = new Date().toISOString();
    plan.usedBy = approval.context ? {
      accountId: approval.context.accountId,
      chatId: approval.context.chatId,
      threadId: approval.context.threadId,
      sessionKey: approval.context.sessionKey,
      windowId: approval.context.windowId,
      senderId: approval.context.senderId,
      messageId: approval.context.messageId
    } : undefined;
    await saveStickerPlans(config, plans);
    return { ok: true, plan };
  });
}

async function hydrateStickerParamsFromPlan(config = {}, action = "", params = {}) {
  const planId = readString(params, "plan_id") || readString(params, "planId");
  if (!planId) return params;
  const plans = await loadStickerPlans(config);
  const plan = plans.plans?.[planId];
  if (!isRecord(plan) || plan.kind !== "sticker_pack" || plan.targetAction !== action) return params;
  return mergeStickerPlanTargetParams(params, plan);
}

async function requireDirectApproval(config = {}, params = {}, keys = [], label = "mutation", ctx = {}) {
  const hasLegacyFlag = hasModelSuppliedApprovalFlag(params, keys);
  if (readString(params, "plan_id") || readString(params, "planId")) {
    const approval = await consumeStickerMutationPlan(config, label, params, ctx);
    if (!approval.ok) throw new Error(approval.reason);
    return approval;
  }
  if (allowsTrustedDirectMutation(config, label, ctx)) {
    return { ok: true, plan: null, directTrusted: true };
  }
  if (label !== "delete_sticker") {
    requireTrustedActorContext(ctx, { label });
    if (hasLegacyFlag) {
      throw new Error(`${label} dryRun:false ignores model-supplied approval flags (${keys.join(", ")}); userId/ownerUserId must match the current Telegram sender`);
    }
    return { ok: true, plan: null, userAligned: true };
  }
  if (hasTrustedMutationApproval(ctx)) {
    requireTrustedMutationApproval(ctx, { label });
    return { ok: true, plan: null };
  }
  if (label === "delete_sticker") {
    throw new Error("delete_sticker dryRun:false requires an explicit delete confirmation plan_id or trusted runtime mutation approval");
  }
  if (hasLegacyFlag) {
    throw new Error(`${label} dryRun:false ignores model-supplied approval flags (${keys.join(", ")}); use plan_id, trusted runtime mutation approval, or explicitly enabled trustedDirectMutations`);
  }
  throw new Error(`${label} dryRun:false requires plan_id, trusted runtime mutation approval, or explicitly enabled trustedDirectMutations`);
}

let graphemeSegmenter = null;

function splitGraphemes(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    graphemeSegmenter ||= new Intl.Segmenter("und", { granularity: "grapheme" });
    return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
  } catch {
    return Array.from(text);
  }
}

function isEmojiGrapheme(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /\p{Extended_Pictographic}/u.test(text) ||
    /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(text) ||
    /^[0-9#*]\uFE0F?\u20E3$/u.test(text);
}

function emojiListFromValue(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const parts = text.split(/[,\s]+/u).filter(Boolean);
  const tokens = parts.length ? parts : [text];
  const out = [];
  for (const token of tokens) {
    for (const grapheme of splitGraphemes(token)) {
      if (isEmojiGrapheme(grapheme)) out.push(grapheme);
    }
  }
  return out;
}

function normalizeEmojiList(params = {}) {
  const raw = params.emojiList ?? params.emojis ?? params.emoji ?? "\uD83D\uDE42";
  const values = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const value of values) out.push(...emojiListFromValue(value));
  return out.slice(0, 20).length ? out.slice(0, 20) : ["\uD83D\uDE42"];
}

function optionalEmojiList(params = {}) {
  if (params.emojiList === undefined && params.emojis === undefined && params.emoji === undefined) return [];
  return normalizeEmojiList(params);
}

function normalizeKeywords(params = {}) {
  const raw = params.keywords ?? params.tags ?? "";
  const values = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/u);
  return values.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20);
}

function hasValue(params, key) {
  if (!isRecord(params) || params[key] === undefined || params[key] === null) return false;
  return String(params[key]).trim() !== "";
}

function emptyManagedSetsState() {
  return {
    version: MANAGED_SET_REGISTRY_VERSION,
    updatedAt: "",
    sets: {},
    defaults: {}
  };
}

function normalizeManagedSetEntry(entry = {}) {
  const name = readStickerSetName(readString(entry, "name") || readString(entry, "setName"));
  if (!name) return null;
  const ownerUserId = normalizeOwnerUserId(readString(entry, "ownerUserId") || readString(entry, "userId"));
  const stickerType = normalizeStickerType(readString(entry, "stickerType"));
  const createdByBot = entry.createdByBot === undefined ? false : Boolean(entry.createdByBot);
  const permissionSource = readString(entry, "permissionSource") || (createdByBot ? "created_by_this_bot" : "local_record_only");
  return {
    name,
    title: clip(readString(entry, "title"), 64),
    ownerUserId,
    stickerType,
    link: readString(entry, "link") || `https://t.me/addstickers/${name}`,
    createdByBot,
    permissionSource,
    addedAt: readString(entry, "addedAt"),
    updatedAt: readString(entry, "updatedAt"),
    lastAction: readString(entry, "lastAction")
  };
}

function normalizeManagedSetsState(raw = {}) {
  const state = emptyManagedSetsState();
  state.updatedAt = readString(raw, "updatedAt");
  if (isRecord(raw.sets)) {
    for (const [name, entry] of Object.entries(raw.sets)) {
      const normalized = normalizeManagedSetEntry({ name, ...(isRecord(entry) ? entry : {}) });
      if (normalized) state.sets[normalized.name] = normalized;
    }
  }
  if (isRecord(raw.defaults)) {
    for (const [key, value] of Object.entries(raw.defaults)) {
      const name = readStickerSetName(String(value || ""));
      if (name) state.defaults[String(key)] = name;
    }
  }
  return state;
}

async function readManagedSets(config = {}) {
  try {
    return normalizeManagedSetsState(await readJson(managedSetsPath(config)));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyManagedSetsState();
    throw error;
  }
}

async function writeManagedSets(config = {}, state = emptyManagedSetsState()) {
  const normalized = normalizeManagedSetsState(state);
  normalized.updatedAt = new Date().toISOString();
  await writeJson(managedSetsPath(config), normalized);
  return normalized;
}

function managedDefaultKey(ownerUserId, stickerType = "regular") {
  const owner = normalizeOwnerUserId(ownerUserId);
  if (!owner) return "";
  return `${owner}:${normalizeStickerType(stickerType)}`;
}

function publicManagedSet(entry = {}) {
  return {
    name: entry.name || "",
    title: entry.title || "",
    ownerUserId: entry.ownerUserId || "",
    stickerType: normalizeStickerType(entry.stickerType),
    link: entry.link || (entry.name ? `https://t.me/addstickers/${entry.name}` : ""),
    createdByBot: Boolean(entry.createdByBot),
    permissionSource: entry.permissionSource || (entry.createdByBot ? "created_by_this_bot" : "local_record_only"),
    addedAt: entry.addedAt || "",
    updatedAt: entry.updatedAt || "",
    lastAction: entry.lastAction || ""
  };
}

async function rememberManagedSet(config = {}, entry = {}, options = {}) {
  const name = readStickerSetName(readString(entry, "name") || readString(entry, "setName"));
  if (!name) throw new Error("managed sticker set name is required");
  return await withStateFileLock(managedSetsPath(config), async () => {
    const state = await readManagedSets(config);
    const now = new Date().toISOString();
    const previous = isRecord(state.sets[name]) ? state.sets[name] : {};
    const ownerUserId = normalizeOwnerUserId(
      readString(entry, "ownerUserId") || readString(entry, "userId") || previous.ownerUserId || ""
    );
    const stickerType = normalizeStickerType(readString(entry, "stickerType") || previous.stickerType || "regular");
    const createdByBot = entry.createdByBot === undefined
      ? Boolean(previous.createdByBot)
      : Boolean(entry.createdByBot);
    const permissionSource = readString(entry, "permissionSource") ||
      previous.permissionSource ||
      (createdByBot ? "created_by_this_bot" : "local_record_only");
    const next = {
      name,
      title: clip(readString(entry, "title") || previous.title || "", 64),
      ownerUserId,
      stickerType,
      link: readString(entry, "link") || previous.link || `https://t.me/addstickers/${name}`,
      createdByBot,
      permissionSource,
      addedAt: previous.addedAt || now,
      updatedAt: now,
      lastAction: readString(entry, "lastAction") || previous.lastAction || ""
    };
    state.sets[name] = next;
    if (options.makeDefault && ownerUserId) {
      state.defaults[managedDefaultKey(ownerUserId, stickerType)] = name;
    }
    const written = await writeManagedSets(config, state);
    return publicManagedSet(written.sets[name]);
  });
}

async function listManagedStickerSets(config = {}, params = {}, ctx = {}) {
  const state = await readManagedSets(config);
  const includeAll = readBoolean(params, "includeAll", false);
  const owner = includeAll ? "" : normalizeOwnerUserId(readString(params, "userId") || readString(params, "ownerUserId"), ctx);
  const requestedType = readString(params, "stickerType");
  const stickerType = requestedType ? normalizeStickerType(requestedType) : "";
  const sets = Object.values(state.sets)
    .filter((entry) => !owner || entry.ownerUserId === owner)
    .filter((entry) => !stickerType || normalizeStickerType(entry.stickerType) === stickerType)
    .map(publicManagedSet)
    .sort((left, right) => left.name.localeCompare(right.name));
  const defaultKey = owner ? managedDefaultKey(owner, stickerType || "regular") : "";
  const defaultSet = defaultKey ? state.defaults[defaultKey] || "" : "";
  return {
    status: "ok",
    registryPath: managedSetsPath(config),
    count: sets.length,
    ownerUserId: owner,
    stickerType: stickerType || "any",
    defaultSet,
    managedSets: sets
  };
}

async function setDefaultManagedSet(config = {}, params = {}, ctx = {}) {
  const owner = normalizeOwnerUserId(readString(params, "userId") || readString(params, "ownerUserId"), ctx);
  if (!owner) throw new Error("userId/ownerUserId is required to set a managed sticker-set default");
  const name = readStickerSetName(readString(params, "name") || readString(params, "setName") || readString(params, "targetName"));
  if (!name) throw new Error("name/setName is required to set a managed sticker-set default");
  const stickerType = normalizeStickerType(readString(params, "stickerType"));
  const dryRun = readBoolean(params, "dryRun", false);
  assertOwnerMatchesContext(owner, ctx, { dryRun, action: "set_default_set" });
  const preview = {
    status: dryRun ? "set_default_dry_run" : "default_set_recorded",
    registryPath: managedSetsPath(config),
    ownerUserId: owner,
    name,
    title: clip(readString(params, "title"), 64),
    link: `https://t.me/addstickers/${name}`,
    stickerType,
    defaultSet: name,
    dryRun,
    permissionSource: "local_record_only"
  };
  if (dryRun) return preview;
  const remembered = await rememberManagedSet(config, {
    ...preview,
    ownerUserId: owner,
    lastAction: "set_default_set"
  }, { makeDefault: true });
  return { ...preview, ...remembered, status: "default_set_recorded", defaultSet: remembered.name, dryRun: false };
}

async function forgetManagedSet(config = {}, params = {}, ctx = {}) {
  const name = readStickerSetName(readString(params, "name") || readString(params, "setName") || readString(params, "targetName"));
  if (!name) throw new Error("name/setName is required to forget a managed sticker set");
  const owner = normalizeOwnerUserId(readString(params, "userId") || readString(params, "ownerUserId"), ctx);
  const dryRun = readBoolean(params, "dryRun", false);
  assertOwnerMatchesContext(owner, ctx, { dryRun, action: "forget_managed_set" });
  return await withStateFileLock(managedSetsPath(config), async () => {
    const state = await readManagedSets(config);
    const existing = state.sets[name] || null;
    if (owner && existing?.ownerUserId && existing.ownerUserId !== owner) {
      throw new Error("forget_managed_set owner-check failed: recorded owner does not match userId/ownerUserId");
    }
    if (dryRun) {
      return {
        status: "forget_managed_dry_run",
        registryPath: managedSetsPath(config),
        name,
        ownerUserId: owner,
        found: Boolean(existing),
        dryRun
      };
    }
    delete state.sets[name];
    for (const [key, value] of Object.entries(state.defaults)) {
      if (value === name && (!owner || key.startsWith(`${owner}:`))) delete state.defaults[key];
    }
    await writeManagedSets(config, state);
    return {
      status: "managed_set_forgotten",
      registryPath: managedSetsPath(config),
      name,
      ownerUserId: owner,
      found: Boolean(existing),
      dryRun: false
    };
  });
}

async function resolveManagedSetForAdd(config = {}, params = {}, ownerUserId = "", stickerType = "regular") {
  const explicit = readStickerSetName(readString(params, "name") || readString(params, "setName") || readString(params, "targetName"));
  const state = await readManagedSets(config);
  if (explicit) {
    return {
      name: explicit,
      fromDefault: false,
      entry: state.sets[explicit] ? publicManagedSet(state.sets[explicit]) : null
    };
  }
  const key = managedDefaultKey(ownerUserId, stickerType);
  const defaultName = key ? state.defaults[key] : "";
  if (defaultName && state.sets[defaultName]) {
    return { name: defaultName, fromDefault: true, entry: publicManagedSet(state.sets[defaultName]) };
  }
  throw new Error("name/setName is required unless set_default_set has recorded a managed default for this user and stickerType");
}

function normalizeDraftTarget(params = {}, total = 0) {
  if (hasValue(params, "targetCount")) return readNumber(params, "targetCount", DEFAULT_DRAFT_TARGET, 1, MAX_DRAFT_STICKERS);
  if (hasValue(params, "count")) return readNumber(params, "count", DEFAULT_DRAFT_TARGET, 1, MAX_DRAFT_STICKERS);
  const preparedTotal = Math.max(1, Number(total) || 1);
  return Math.min(DEFAULT_DRAFT_TARGET, preparedTotal, MAX_DRAFT_STICKERS);
}

function normalizeReviewMode(value) {
  const mode = String(value || "balanced").trim().toLowerCase();
  if (["strict", "balanced", "generous"].includes(mode)) return mode;
  return "balanced";
}

function draftProfileFromParams(params = {}, preparedTotal = 0) {
  return {
    theme: clip(readString(params, "theme") || readString(params, "sourceQuery") || readString(params, "query"), 120),
    audience: clip(readString(params, "audience") || "chat reactions", 80),
    style: clip(readString(params, "style") || readString(params, "packStyle"), 120),
    reviewMode: normalizeReviewMode(readString(params, "reviewMode")),
    targetCount: normalizeDraftTarget(params, preparedTotal)
  };
}

function reviewTemplateForDraft(draft = {}) {
  const stickers = Array.isArray(draft.stickers) ? draft.stickers : [];
  return stickers
    .filter((item) => item?.status === "prepared")
    .slice(0, MAX_DRAFT_STICKERS)
    .map((item) => ({
      index: item.index + 1,
      decision: "keep",
      emoji: "",
      keywords: "",
      notes: ""
    }));
}

function buildDraftReviewBrief(draft = {}) {
  const stickers = Array.isArray(draft.stickers) ? draft.stickers : [];
  const preparedCount = stickers.filter((item) => item.status === "prepared").length;
  const profile = isRecord(draft.profile) ? draft.profile : {};
  const targetCount = preparedCount
    ? Math.min(Math.max(1, Number(profile.targetCount) || Math.min(preparedCount, DEFAULT_DRAFT_TARGET)), preparedCount, MAX_DRAFT_STICKERS)
    : 0;
  const theme = clip(profile.theme || draft.sourceQuery || "(user-provided images)", 120);
  const style = clip(profile.style || "(infer from sources)", 120);
  const mode = normalizeReviewMode(profile.reviewMode);
  const rubric = [
    "Keep stickers that read clearly at small chat size, have an obvious reaction or punchline, and still look good in a 512x512 square.",
    "Reject weak, duplicate, off-theme, unreadable, badly cropped, mostly-text, or low-signal images.",
    "Prefer variety across emotion, pose, composition, and color so the pack feels useful instead of repetitive.",
    "Assign 1-3 Unicode emoji that match the actual reaction, not just the pictured object.",
    "Use short keywords for Telegram search: emotion, character, action, meme phrase, or theme."
  ];
  const instruction = [
    `Review contract for sticker draft ${draft.id || ""}.`,
    `Theme: ${theme}.`,
    `Style: ${style}.`,
    `Mode: ${mode}; target about ${targetCount} kept sticker(s) from ${preparedCount}.`,
    "review_draft accepts one item per prepared sticker with decision keep/reject, emoji or emojiList for kept stickers, keywords, and notes.",
    "review_sheet renders a visual keep/reject/pending map for the draft.",
    "publish_draft publishes kept draft items and defaults to dryRun:true."
  ].join(" ");
  return {
    preparedCount,
    targetCount,
    theme,
    style,
    reviewMode: mode,
    rubric,
    reviewTemplate: reviewTemplateForDraft(draft),
    instruction
  };
}

function readInputItems(params = {}, options = {}) {
  const limit = Math.max(1, Math.trunc(Number(options.limit) || MAX_PREPARE_BATCH_ITEMS));
  const label = String(options.label || "items");
  const rawItems = Array.isArray(params.items) ? params.items : [];
  const out = [];
  for (const item of rawItems) {
    if (!isRecord(item)) continue;
    const stickerObject = isRecord(item.stickerObject) ? item.stickerObject : isRecord(item.telegramSticker) ? item.telegramSticker : isRecord(item.sticker) ? item.sticker : null;
    const objectFileId = stickerObject ? readString(stickerObject, "file_id") || readString(stickerObject, "fileId") : "";
    const input = readString(item, "input") || readString(item, "image") || readString(item, "media") || readString(item, "stickerPath") || readString(item, "prepared") || readString(item, "file") || readString(item, "fileId") || readString(item, "stickerFileId") || readString(item, "sticker") || objectFileId;
    if (input) {
      out.push({
        ...item,
        ...(objectFileId ? {
          fileId: objectFileId,
          emoji: hasValue(item, "emoji") ? item.emoji : readString(stickerObject, "emoji"),
          isAnimated: item.isAnimated ?? Boolean(stickerObject?.is_animated),
          isVideo: item.isVideo ?? Boolean(stickerObject?.is_video)
        } : {}),
        input
      });
    }
  }
  const rawInputs = Array.isArray(params.inputs) ? params.inputs : [];
  for (const input of rawInputs) {
    if (isRecord(input)) {
      const stickerObject = isRecord(input.stickerObject) ? input.stickerObject : isRecord(input.telegramSticker) ? input.telegramSticker : isRecord(input.sticker) ? input.sticker : null;
      const objectFileId = stickerObject ? readString(stickerObject, "file_id") || readString(stickerObject, "fileId") : "";
      const value = readString(input, "input") || readString(input, "image") || readString(input, "media") || readString(input, "stickerPath") || readString(input, "prepared") || readString(input, "file") || readString(input, "fileId") || readString(input, "stickerFileId") || readString(input, "sticker") || objectFileId;
      if (value) {
        out.push({
          ...input,
          ...(objectFileId ? {
            fileId: objectFileId,
            emoji: hasValue(input, "emoji") ? input.emoji : readString(stickerObject, "emoji"),
            isAnimated: input.isAnimated ?? Boolean(stickerObject?.is_animated),
            isVideo: input.isVideo ?? Boolean(stickerObject?.is_video)
          } : {}),
          input: value
        });
      }
    } else if (String(input || "").trim()) {
      out.push({ input: String(input).trim() });
    }
  }
  const text = readString(params, "inputs") || readString(params, "input") || readString(params, "media") || readString(params, "image") || "";
  if (text && out.length === 0) {
    const mediaMatches = [...text.matchAll(/(?:SPOILER_)?MEDIA:\s*`?([^`\r\n]+)`?/gi)].map((match) => match[1].trim()).filter(Boolean);
    const values = mediaMatches.length ? mediaMatches : text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const value of values) out.push({ input: value });
  }
  const seen = new Set();
  const unique = out.filter((item) => {
    const key = String(item.input || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length > limit) {
    throw new Error(`${label} accepts up to ${limit} item(s); received ${unique.length}. Split the request into multiple batches.`);
  }
  return unique;
}

async function mapLimit(items = [], limit = 1, mapper) {
  const list = Array.isArray(items) ? items : [];
  const workerCount = Math.max(1, Math.min(Math.trunc(limit) || 1, list.length || 1));
  const results = new Array(list.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(list[index], index);
    }
  }));
  return results;
}

function normalizeStickerFormat(value, filePath = "") {
  const requested = String(value || "").trim().toLowerCase();
  if (["static", "animated", "video"].includes(requested)) return requested;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".tgs") return "animated";
  if (ext === ".webm") return "video";
  return "static";
}

function stickerFormatFromParams(params = {}, filePath = "") {
  const explicit = readString(params, "stickerFormat") || readString(params, "format");
  if (explicit) return normalizeStickerFormat(explicit, filePath);
  if (readBoolean(params, "isVideo", false) || readBoolean(params, "video", false)) return "video";
  if (readBoolean(params, "isAnimated", false) || readBoolean(params, "animated", false)) return "animated";
  return normalizeStickerFormat("", filePath);
}

function stickerFormatFromTelegramSticker(sticker = {}) {
  if (sticker?.is_video) return "video";
  if (sticker?.is_animated) return "animated";
  return "static";
}

function telegramStickerFromParams(params = {}) {
  if (isRecord(params.stickerObject)) return params.stickerObject;
  if (isRecord(params.telegramSticker)) return params.telegramSticker;
  if (isRecord(params.sticker)) return params.sticker;
  return null;
}

function withTelegramStickerAliases(params = {}) {
  const sticker = telegramStickerFromParams(params);
  if (!sticker) return params;
  const next = { ...params };
  const fileId = readString(sticker, "file_id") || readString(sticker, "fileId");
  if (fileId && !hasValue(next, "fileId") && !hasValue(next, "stickerFileId")) next.fileId = fileId;
  const emoji = readString(sticker, "emoji");
  if (emoji && !hasValue(next, "emoji") && !hasValue(next, "emojiList")) next.emoji = emoji;
  const sourceSet = readString(sticker, "set_name") || readString(sticker, "setName");
  if (sourceSet && !hasValue(next, "sourceSet")) next.sourceSet = sourceSet;
  if (sticker.is_animated !== undefined && !hasValue(next, "isAnimated")) next.isAnimated = Boolean(sticker.is_animated);
  if (sticker.is_video !== undefined && !hasValue(next, "isVideo")) next.isVideo = Boolean(sticker.is_video);
  if (!hasValue(next, "format") && !hasValue(next, "stickerFormat")) next.format = stickerFormatFromTelegramSticker(sticker);
  return next;
}

function normalizeStickerType(value) {
  const requested = String(value || "regular").trim().toLowerCase();
  return ["regular", "mask", "custom_emoji"].includes(requested) ? requested : "regular";
}

function stickerSetApiOptions(params = {}) {
  const stickerType = normalizeStickerType(readString(params, "stickerType"));
  const needsRepainting = readBoolean(params, "needsRepainting", false);
  if (needsRepainting && stickerType !== "custom_emoji") {
    throw new Error("needsRepainting is only valid for stickerType=custom_emoji");
  }
  const body = {};
  if (stickerType !== "regular") body.sticker_type = stickerType;
  if (stickerType === "custom_emoji" && needsRepainting) body.needs_repainting = true;
  return { body, stickerType, needsRepainting };
}

function maxStickersForSetType(value) {
  return normalizeStickerType(value) === "custom_emoji" ? MAX_CUSTOM_EMOJI_SET_STICKERS : MAX_REGULAR_SET_STICKERS;
}

function readStickerSetName(raw = "") {
  const value = String(raw || "").trim();
  if (!value) return "";
  const link = value.match(/(?:https?:\/\/)?t\.me\/addstickers\/([A-Za-z0-9_]+)/i);
  if (link) return link[1];
  const addstickers = value.match(/addstickers\/([A-Za-z0-9_]+)/i);
  if (addstickers) return addstickers[1];
  return value.replace(/^@/, "").replace(/^`+|`+$/g, "");
}

function readSourceSetName(params = {}) {
  return readStickerSetName(
    readString(params, "sourceSet") ||
    readString(params, "sourceName") ||
    readString(params, "fromSet") ||
    readString(params, "source") ||
    readString(params, "url")
  );
}

function formatCounts(items = []) {
  const counts = { static: 0, animated: 0, video: 0 };
  for (const item of items) {
    const format = normalizeStickerFormat(item?.format || item?.stickerFormat);
    counts[format] = (counts[format] || 0) + 1;
  }
  return counts;
}

function normalizeFormatFilter(params = {}) {
  const raw = params.sourceFormats ?? params.formats ?? params.formatFilter ?? "";
  const values = Array.isArray(raw) ? raw : String(raw || "").split(/[,\s]+/u);
  const set = new Set();
  for (const item of values) {
    const value = String(item || "").trim().toLowerCase();
    if (!value || value === "all" || value === "*") return null;
    if (["static", "animated", "video"].includes(value)) set.add(value);
  }
  if (!set.size || (set.has("static") && set.has("animated") && set.has("video"))) return null;
  return set;
}

function normalizeSafeSearch(raw) {
  const value = String(raw || "moderate").trim().toLowerCase();
  if (value === "off" || value === "strict") return value;
  return "moderate";
}

function safeSearchParam(value) {
  return value === "off" ? "-1" : "1";
}

function normalizePublicHttpUrl(raw = "") {
  const value = decodeHtmlEntities(String(raw || "").trim());
  if (!value) return "";
  try {
    const absolute = value.startsWith("//") ? `https:${value}` : value;
    const url = new URL(absolute, "https://duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    if (redirected) return normalizePublicHttpUrl(redirected);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

async function fetchPublicText(url, { signal, timeoutMs = SOURCE_SEARCH_REQUEST_TIMEOUT_MS } = {}) {
  if (!fetchImpl) throw new Error("fetch is unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
  let removeParentListener = () => {};
  if (signal) {
    const abortFromParent = () => controller.abort(signal.reason);
    if (signal.aborted) abortFromParent();
    else {
      signal.addEventListener("abort", abortFromParent, { once: true });
      removeParentListener = () => signal.removeEventListener("abort", abortFromParent);
    }
  }
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
    removeParentListener();
  }
}

function parseDuckDuckGoTextResults(html = "", count = SOURCE_SEARCH_TEXT_RESULT_COUNT) {
  const blocks = String(html || "").split(/<div[^>]+class=["'][^"']*\bresult\b[^"']*["'][^>]*>/gi).slice(1);
  const results = [];
  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]+class=["'][^"']*\bresult__a\b[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = normalizePublicHttpUrl(linkMatch[1]);
    if (!url) continue;
    const title = stripHtml(linkMatch[2]);
    const snippetMatch = block.match(/<a[^>]+class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<div[^>]+class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";
    results.push({ title, url, snippet });
    if (results.length >= count) break;
  }
  return results;
}

async function searchPublicText(query, params = {}, signal) {
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);
  url.searchParams.set("kl", readString(params, "region", "wt-wt") || "wt-wt");
  url.searchParams.set("kp", safeSearchParam(normalizeSafeSearch(readString(params, "safeSearch", "moderate"))));
  const html = await fetchPublicText(url.toString(), { signal });
  const count = readNumber(params, "searchResultCount", SOURCE_SEARCH_TEXT_RESULT_COUNT, 1, 30);
  return parseDuckDuckGoTextResults(html, count);
}

function readStickerSearchQuery(params = {}) {
  return readString(params, "query") ||
    readString(params, "q") ||
    readString(params, "sourceQuery") ||
    readString(params, "theme") ||
    readString(params, "keyword");
}

function buildStickerSourceQueries(query, params = {}) {
  const explicit = readString(params, "searchQuery");
  if (explicit) return [explicit].slice(0, SOURCE_SEARCH_MAX_QUERIES);
  const cleaned = String(query || "").replace(/(?:https?:\/\/|\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/addstickers\/[A-Za-z0-9_]+/giu, " ").replace(/\s+/g, " ").trim();
  const base = cleaned || query;
  const candidates = [
    `site:t.me/addstickers ${base} telegram stickers`,
    `"t.me/addstickers" ${base} telegram sticker pack`,
    `site:combot.org/telegram/stickers ${base} telegram stickers`,
    `${base} telegram sticker pack addstickers`
  ];
  const seen = new Set();
  return candidates.filter((item) => {
    const key = item.toLowerCase();
    if (!item.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, SOURCE_SEARCH_MAX_QUERIES);
}

function stickerCandidatesFromText(text = "", meta = {}) {
  const normalized = decodeHtmlEntities(String(text || "").replace(/\\\//g, "/"));
  const regex = /(?:https?:\/\/|\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/addstickers\/([A-Za-z0-9_]+)/giu;
  const out = [];
  for (const match of normalized.matchAll(regex)) {
    const name = readStickerSetName(match[0]);
    if (!name) continue;
    out.push({
      name,
      link: `https://t.me/addstickers/${name}`,
      sourceUrl: meta.sourceUrl || "",
      sourceTitle: meta.sourceTitle || "",
      snippet: meta.snippet || "",
      query: meta.query || ""
    });
  }
  return out;
}

function dedupeStickerSourceCandidates(candidates = []) {
  const seen = new Set();
  const out = [];
  for (const item of candidates) {
    const name = readStickerSetName(item?.name || item?.link);
    const key = name.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, name, link: `https://t.me/addstickers/${name}` });
  }
  return out;
}

async function discoverStickerSourceCandidates(params = {}, signal) {
  const query = readStickerSearchQuery(params);
  if (!query) throw new Error("query/sourceQuery/theme is required for sticker source search");
  const searchQueries = buildStickerSourceQueries(query, params);
  const failures = [];
  const direct = stickerCandidatesFromText(query, { query, sourceTitle: "user query" });
  const searchBatches = await mapLimit(searchQueries, 2, async (searchQuery) => {
    try {
      const results = await searchPublicText(searchQuery, params, signal);
      return { searchQuery, results };
    } catch (error) {
      failures.push({ query: searchQuery, error: error instanceof Error ? error.message : String(error) });
      return { searchQuery, results: [] };
    }
  });
  const candidates = [...direct];
  const resultPages = [];
  for (const batch of searchBatches) {
    for (const result of batch.results) {
      resultPages.push({ ...result, query: batch.searchQuery });
      candidates.push(...stickerCandidatesFromText(`${result.url} ${result.title} ${result.snippet}`, {
        query: batch.searchQuery,
        sourceUrl: result.url,
        sourceTitle: result.title,
        snippet: result.snippet
      }));
    }
  }
  if (readBoolean(params, "inspectPages", true)) {
    const inspectLimit = readNumber(params, "inspectPagesLimit", SOURCE_SEARCH_INSPECT_MAX, 0, SOURCE_SEARCH_INSPECT_MAX);
    const pages = resultPages
      .filter((item) => item.url && !/\/\/(?:t\.me|telegram\.me|telegram\.dog)\//i.test(item.url))
      .slice(0, inspectLimit);
    const pageCandidates = await mapLimit(pages, 2, async (page) => {
      try {
        const html = await fetchPublicText(page.url, { signal });
        return stickerCandidatesFromText(html, {
          query: page.query,
          sourceUrl: page.url,
          sourceTitle: page.title,
          snippet: page.snippet
        });
      } catch (error) {
        failures.push({ url: page.url, error: error instanceof Error ? error.message : String(error) });
        return [];
      }
    });
    for (const list of pageCandidates) candidates.push(...list);
  }
  return {
    query,
    searchQueries,
    resultPageCount: resultPages.length,
    failures,
    candidates: dedupeStickerSourceCandidates(candidates)
  };
}

function normalizeSetName(raw, botUsername) {
  const bot = String(botUsername || "YOUR_BOT_USERNAME").replace(/^@/, "");
  const original = String(raw || "").trim();
  const source = original || "amaduse_pack";
  const lostNonAscii = /[^\x00-\x7F]/.test(source);
  let base = source
    .trim()
    .replace(/_by_[A-Za-z0-9_]+$/i, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base && original) base = `pack_${hash(original, 8)}`;
  else if (base && lostNonAscii) base = `${base}_${hash(source, 6)}`;
  if (!/^[A-Za-z]/.test(base)) base = `a_${base || "pack"}`;
  const suffix = `_by_${bot}`;
  const maxBase = Math.max(1, 64 - suffix.length);
  base = base.slice(0, maxBase).replace(/_+$/g, "") || "pack";
  return `${base}${suffix}`;
}

function stripStickerPlanParams(params = {}) {
  const next = { ...params };
  delete next.plan_id;
  delete next.planId;
  return next;
}

function trustedNestedStickerMutationContext(ctx = {}, source = "sticker_pack") {
  return {
    ...ctx,
    mutationApproved: true,
    mutationAuthorization: {
      ...(isRecord(ctx.mutationAuthorization) ? ctx.mutationAuthorization : {}),
      approved: true,
      source
    }
  };
}

async function readToken(config = {}) {
  const raw = await fs.readFile(tokenFile(config), "utf8");
  const token = raw.trim();
  if (!token) throw new Error("Telegram bot token file is empty");
  return token;
}

async function botApi(config, method, body = {}, files = {}) {
  if (!fetchImpl) throw new Error("fetch is unavailable");
  const token = await readToken(config);
  const url = `https://api.telegram.org/bot${token}/${method}`;
  let response;
  if (Object.keys(files).length) {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null || value === "") continue;
      form.append(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    for (const [key, file] of Object.entries(files)) {
      const data = await fs.readFile(file.path);
      const blob = new Blob([data], { type: file.mimeType || "application/octet-stream" });
      form.append(key, blob, file.fileName || path.basename(file.path));
    }
    response = await fetchTelegram(url, { method: "POST", body: form }, method);
  } else {
    response = await fetchTelegram(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }, method);
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    parsed = { ok: false, description: clip(text, 500) };
  }
  if (!response.ok || parsed.ok === false) {
    throw new Error(parsed.description || `${method} failed with HTTP ${response.status}`);
  }
  return parsed.result;
}

function stickerDownloadExtension(item = {}, file = {}) {
  const fromPath = path.extname(String(file.file_path || "")).toLowerCase();
  if (DOWNLOAD_STICKER_EXTS.has(fromPath)) return fromPath;
  const format = normalizeStickerFormat(item.format || item.stickerFormat);
  if (format === "animated") return ".tgs";
  if (format === "video") return ".webm";
  return ".webp";
}

async function downloadTelegramStickerFile(config = {}, item = {}, outputDir = "") {
  const fileId = item.fileId || item.sticker;
  if (!fileId) throw new Error("sticker file_id is required");
  const file = await botApi(config, "getFile", { file_id: fileId });
  const filePath = String(file?.file_path || "").trim();
  if (!filePath) throw new Error("Telegram getFile did not return file_path");
  const token = await readToken(config);
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const response = await fetchTelegram(url, { method: "GET" }, "download sticker file");
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) throw new Error("downloaded sticker file is empty");
  const ext = stickerDownloadExtension(item, file);
  const outputPath = path.join(
    outputDir,
    `${String((item.index ?? 0) + 1).padStart(3, "0")}-${safeFilePart(item.fileUniqueId || hash(fileId, 10), "sticker")}${ext}`
  );
  await fs.writeFile(outputPath, data);
  const stat = await fs.stat(outputPath);
  return {
    ...item,
    status: "downloaded",
    outputPath,
    filePath,
    sizeBytes: stat.size,
    stickerFormat: item.stickerFormat || item.format || normalizeStickerFormat("", outputPath),
    format: item.format || normalizeStickerFormat("", outputPath)
  };
}

async function resolveBotUsername(config = {}, params = {}) {
  const explicit = readString(params, "botUsername") || String(config.botUsername || "").trim();
  if (explicit) return explicit.replace(/^@/, "");
  const me = await botApi(config, "getMe", {});
  return String(me?.username || "YOUR_BOT_USERNAME").replace(/^@/, "");
}

async function stickerFileForInput(config, params) {
  params = withTelegramStickerAliases(params);
  const fileId = readString(params, "fileId") || readString(params, "stickerFileId") || readString(params, "sticker");
  if (fileId && !/[\\/:]/.test(fileId)) {
    return { fileId, format: stickerFormatFromParams(params), source: "file_id" };
  }
  const rawPath = readString(params, "stickerPath") || readString(params, "prepared") || readString(params, "file") || readString(params, "input") || readString(params, "image") || readString(params, "media");
  let file;
  try {
    file = await resolveAllowedFile(config, rawPath, { sticker: true });
  } catch (error) {
    if (readBoolean(params, "autoPrepare", true)) {
      const prepared = await prepareSticker(config, { input: rawPath });
      file = await resolveAllowedFile(config, prepared.outputPath, { sticker: true });
    } else {
      throw error;
    }
  }
  return {
    path: file.path,
    fileName: path.basename(file.path),
    format: stickerFormatFromParams(params, file.path),
    source: "upload"
  };
}

function inputSticker(stickerRef, params) {
  const item = {
    sticker: stickerRef,
    format: stickerFormatFromParams(params),
    emoji_list: normalizeEmojiList(params)
  };
  const keywords = normalizeKeywords(params);
  if (keywords.length) item.keywords = keywords;
  return item;
}

async function stickerInputsForItems(config, params = {}, options = {}) {
  const items = readInputItems(params, {
    limit: options.limit || MAX_CREATE_SET_ITEMS,
    label: options.label || "sticker inputs"
  });
  if (!items.length) throw new Error("items/inputs are required");
  if (items.length > MAX_CREATE_SET_ITEMS) throw new Error(`Telegram createNewStickerSet accepts up to ${MAX_CREATE_SET_ITEMS} initial stickers`);
  const stickers = [];
  const files = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const sticker = await stickerFileForInput(config, { ...params, ...item, autoPrepare: item.autoPrepare ?? params.autoPrepare });
    const itemParams = { ...params, ...item, stickerFormat: sticker.format };
    if (sticker.path) {
      const key = `sticker${index}`;
      stickers.push(inputSticker(`attach://${key}`, itemParams));
      files[key] = { path: sticker.path, fileName: sticker.fileName, mimeType: stickerMimeType(sticker.format, sticker.path) };
    } else {
      stickers.push(inputSticker(sticker.fileId, itemParams));
    }
  }
  return { stickers, files, count: stickers.length };
}

async function uploadSticker(config, params, ctx) {
  const owner = normalizeOwnerUserId(readString(params, "userId") || readString(params, "ownerUserId"), ctx);
  if (!owner) throw new Error("userId/ownerUserId is required for sticker upload");
  const sticker = await stickerFileForInput(config, { ...params, autoPrepare: false });
  if (!sticker.path) throw new Error("upload requires a bot-local sticker file, not a file_id");
  const dryRun = params.dryRun === undefined ? true : readBoolean(params, "dryRun", true);
  assertOwnerMatchesContext(owner, ctx, { dryRun, action: "upload" });
  if (dryRun) {
    return {
      status: "upload_dry_run",
      ownerUserId: owner,
      dryRun,
      stickerFormat: sticker.format,
      input: sticker.fileName,
      mimeType: stickerMimeType(sticker.format, sticker.path)
    };
  }
  await requireDirectApproval(config, params, ["directUploadApproved", "uploadApproved", "explicitUserApproval"], "upload", ctx);
  const result = await botApi(config, "uploadStickerFile", {
    user_id: Number(owner),
    sticker_format: sticker.format
  }, {
    sticker: { path: sticker.path, fileName: sticker.fileName, mimeType: stickerMimeType(sticker.format, sticker.path) }
  });
  return { ownerUserId: owner, fileId: result.file_id, fileUniqueId: result.file_unique_id || "", stickerFormat: sticker.format, dryRun };
}

async function createStickerSet(config, params, ctx) {
  const owner = normalizeOwnerUserId(readString(params, "userId") || readString(params, "ownerUserId"), ctx);
  if (!owner) throw new Error("userId/ownerUserId is required to create a sticker set");
  const botUsername = await resolveBotUsername(config, params);
  const name = normalizeSetName(readString(params, "name") || readString(params, "setName"), botUsername);
  const title = clip(readString(params, "title") || "Amaduse Stickers", 64);
  const sticker = await stickerFileForInput(config, params);
  const stickerSetOptions = stickerSetApiOptions(params);
  const body = {
    user_id: Number(owner),
    name,
    title,
    ...stickerSetOptions.body
  };
  const files = {};
  if (sticker.path) {
    body.stickers = [inputSticker("attach://sticker0", { ...params, stickerFormat: sticker.format })];
    files.sticker0 = { path: sticker.path, fileName: sticker.fileName, mimeType: stickerMimeType(sticker.format, sticker.path) };
  } else {
    body.stickers = [inputSticker(sticker.fileId, { ...params, stickerFormat: sticker.format })];
  }
  const dryRun = params.dryRun === undefined ? true : readBoolean(params, "dryRun", true);
  assertOwnerMatchesContext(owner, ctx, { dryRun, action: "create" });
  if (!dryRun) {
    await requireDirectApproval(config, params, ["createApproved", "directUploadApproved", "explicitUserApproval"], "create", ctx);
    await botApi(config, "createNewStickerSet", body, files);
    await rememberManagedSet(config, {
      ownerUserId: owner,
      name,
      title,
      stickerType: stickerSetOptions.stickerType,
      link: `https://t.me/addstickers/${name}`,
      createdByBot: true,
      permissionSource: "created_by_this_bot",
      lastAction: "create"
    }, { makeDefault: true });
  }
  return {
    ownerUserId: owner,
    name,
    title,
    link: `https://t.me/addstickers/${name}`,
    dryRun,
    stickerFormat: sticker.format
  };
}

async function createStickerSetBatch(config, params, ctx) {
  const owner = normalizeOwnerUserId(readString(params, "userId") || readString(params, "ownerUserId"), ctx);
  if (!owner) throw new Error("userId/ownerUserId is required to create a sticker set");
  const botUsername = await resolveBotUsername(config, params);
  const name = normalizeSetName(readString(params, "name") || readString(params, "setName"), botUsername);
  const title = clip(readString(params, "title") || "Amaduse Stickers", 64);
  const batch = await stickerInputsForItems(config, params, { limit: MAX_CREATE_SET_ITEMS, label: "create_batch" });
  const dryRun = params.dryRun === undefined ? true : readBoolean(params, "dryRun", true);
  assertOwnerMatchesContext(owner, ctx, { dryRun, action: "create_batch" });
  const stickerSetOptions = stickerSetApiOptions(params);
  const body = {
    user_id: Number(owner),
    name,
    title,
    stickers: batch.stickers,
    ...stickerSetOptions.body
  };
  if (!dryRun) {
    await requireDirectApproval(config, params, ["createBatchApproved", "directUploadApproved", "explicitUserApproval"], "create_batch", ctx);
    await botApi(config, "createNewStickerSet", body, batch.files);
    await rememberManagedSet(config, {
      ownerUserId: owner,
      name,
      title,
      stickerType: stickerSetOptions.stickerType,
      link: `https://t.me/addstickers/${name}`,
      createdByBot: true,
      permissionSource: "created_by_this_bot",
      lastAction: "create_batch"
    }, { makeDefault: true });
  }
  return {
    ownerUserId: owner,
    name,
    title,
    count: batch.count,
    link: `https://t.me/addstickers/${name}`,
    dryRun,
    stickerFormat: normalizeStickerFormat(readString(params, "stickerFormat") || readString(params, "format"))
  };
}

async function addSticker(config, params, ctx) {
  const owner = normalizeOwnerUserId(readString(params, "userId") || readString(params, "ownerUserId"), ctx);
  if (!owner) throw new Error("userId/ownerUserId is required to add a sticker");
  const stickerType = normalizeStickerType(readString(params, "stickerType"));
  let name = readString(params, "name") || readString(params, "setName");
  let managed = null;
  if (!name) {
    managed = await resolveManagedSetForAdd(config, params, owner, stickerType);
    name = managed.name;
  }
  const sticker = await stickerFileForInput(config, params);
  const body = {
    user_id: Number(owner),
    name
  };
  const files = {};
  if (sticker.path) {
    body.sticker = inputSticker("attach://sticker0", { ...params, stickerFormat: sticker.format });
    files.sticker0 = { path: sticker.path, fileName: sticker.fileName, mimeType: stickerMimeType(sticker.format, sticker.path) };
  } else {
    body.sticker = inputSticker(sticker.fileId, { ...params, stickerFormat: sticker.format });
  }
  const dryRun = params.dryRun === undefined ? !addDefaultsToRealMutation(params, ctx) : readBoolean(params, "dryRun", true);
  assertOwnerMatchesContext(owner, ctx, { dryRun, action: "add" });
  if (!dryRun) {
    await requireDirectApproval(config, params, ["addApproved", "directUploadApproved", "explicitUserApproval"], "add", ctx);
    await botApi(config, "addStickerToSet", body, files);
    await rememberManagedSet(config, {
      ownerUserId: owner,
      name,
      stickerType,
      link: `https://t.me/addstickers/${name}`,
      createdByBot: true,
      permissionSource: "bot_api_add_succeeded",
      lastAction: "add"
    }, { makeDefault: false });
  }
  return {
    ownerUserId: owner,
    name,
    link: `https://t.me/addstickers/${name}`,
    dryRun,
    stickerFormat: sticker.format,
    ...(managed ? { managedSet: managed.name, defaultUsed: managed.fromDefault } : {})
  };
}

async function addStickerFromSentSticker(config, params, ctx) {
  const normalized = withTelegramStickerAliases(params);
  const owner = normalizeOwnerUserId(readString(normalized, "userId") || readString(normalized, "ownerUserId"), ctx);
  if (!owner) throw new Error("userId/ownerUserId is required to add a sent sticker");
  const stickerType = normalizeStickerType(readString(normalized, "stickerType"));
  const managed = await resolveManagedSetForAdd(config, normalized, owner, stickerType);
  const result = await addSticker(config, {
    ...normalized,
    userId: owner,
    name: managed.name,
    stickerType
  }, ctx);
  return {
    ...result,
    status: result.dryRun ? "add_from_sticker_dry_run" : "added_from_sticker",
    managedSet: managed.name,
    defaultUsed: managed.fromDefault,
    permissionSource: managed.entry?.permissionSource || "telegram_add_attempt",
    sourceSet: readSourceSetName(normalized),
    source: "sent_sticker"
  };
}

async function addStickerBatch(config, params, ctx) {
  const items = readInputItems(params, { limit: MAX_ADD_BATCH_ITEMS, label: "add_batch" });
  if (!items.length) throw new Error("items/inputs are required for add_batch");
  const concurrency = readNumber(params, "apiConcurrency", 1, 1, 2);
  const dryRun = params.dryRun === undefined ? !addDefaultsToRealMutation(params, ctx) : readBoolean(params, "dryRun", true);
  const results = await mapLimit(items, concurrency, async (item, index) => {
    try {
      const result = await addSticker(config, { ...params, ...item, input: item.input, dryRun }, ctx);
      return { status: "ok", index, name: result.name, link: result.link, dryRun: result.dryRun };
    } catch (error) {
      return { status: "failed", index, input: path.basename(readMediaPath(item.input || "")), error: clip(error instanceof Error ? error.message : String(error), 240) };
    }
  });
  const okCount = results.filter((item) => item.status === "ok").length;
  return {
    status: okCount === results.length ? "ok" : "partial",
    name: readString(params, "name") || readString(params, "setName"),
    count: okCount,
    total: results.length,
    failedCount: results.length - okCount,
    dryRun,
    results
  };
}

function safeDraftId(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || `draft-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

async function resolveDraftPath(config = {}, raw = "") {
  const root = draftRoot(config);
  await fs.mkdir(root, { recursive: true });
  const value = String(raw || "").trim();
  const file = value
    ? (/[\\/:]/.test(value) ? path.resolve(readMediaPath(value)) : path.join(root, `${safeDraftId(value)}.json`))
    : path.join(root, `${safeDraftId()}.json`);
  if (!isInside(root, file)) throw new Error("draft path is outside sticker draft directory");
  return file;
}

function draftItemsFromPrepared(batch, sourceItems = []) {
  return (Array.isArray(batch.stickers) ? batch.stickers : []).map((item) => {
    const source = sourceItems[item.index] || {};
    if (item.status !== "ok") {
      return {
        index: item.index,
        status: "failed",
        input: item.input || source.input || "",
        error: item.error || "prepare failed",
        decision: "reject",
        emojiList: [],
        keywords: [],
        notes: ""
      };
    }
    const emojiList = optionalEmojiList(source);
    return {
      index: item.index,
      status: "prepared",
      decision: "pending",
      input: item.input,
      sourceInput: source.input || "",
      sourceUrl: readString(source, "sourceUrl") || readString(source, "url"),
      sourceTitle: readString(source, "sourceTitle") || readString(source, "title"),
      outputPath: item.outputPath,
      sizeBytes: item.sizeBytes,
      width: item.width,
      height: item.height,
      framing: item.framing,
      padding: item.padding,
      quality: item.quality,
      emojiList,
      keywords: normalizeKeywords(source),
      notes: readString(source, "notes") || readString(source, "note")
    };
  });
}

async function createStickerDraft(config = {}, params = {}, ctx) {
  const sourceItems = readInputItems(params, { limit: MAX_PREPARE_BATCH_ITEMS, label: "draft" });
  if (!sourceItems.length) throw new Error("inputs/items are required for draft");
  const batch = await prepareStickerBatch(config, { ...params, contactSheet: true });
  const botUsername = readString(params, "botUsername") || String(config.botUsername || "").trim() || "YOUR_BOT_USERNAME";
  const name = normalizeSetName(readString(params, "name") || readString(params, "setName") || readString(params, "title") || "sticker_draft", botUsername);
  const now = new Date().toISOString();
  const draftPath = await resolveDraftPath(config, readString(params, "draftPath") || readString(params, "draftId") || readString(params, "name") || readString(params, "title"));
  const stickers = draftItemsFromPrepared(batch, sourceItems);
  const profile = draftProfileFromParams(params, stickers.filter((item) => item.status === "prepared").length);
  const draft = {
    kind: "imagebot.stickerDraft",
    version: 2,
    id: path.basename(draftPath, ".json"),
    createdAt: now,
    updatedAt: now,
    status: "awaiting_review",
    ownerUserId: normalizeOwnerUserId(readString(params, "userId") || readString(params, "ownerUserId"), ctx),
    name,
    title: clip(readString(params, "title") || "Amaduse Stickers", 64),
    sourceQuery: readString(params, "sourceQuery") || readString(params, "query"),
    sourceKind: readString(params, "sourceKind") || (readString(params, "sourceQuery") ? "collected" : "user_upload"),
    profile,
    contactSheet: batch.contactSheet,
    stickers,
    guidance: {
      reviewState: "Draft candidates start pending; review_draft writes keep/reject decisions plus emoji/keywords.",
      reviewSheet: "review_sheet renders the draft's current keep/reject/pending map.",
      publishState: "publish_draft uses kept draft items and defaults to dryRun true."
    }
  };
  draft.reviewBrief = buildDraftReviewBrief(draft);
  await writeJson(draftPath, draft);
  return {
    status: "awaiting_review",
    draftPath,
    draftId: draft.id,
    name: draft.name,
    title: draft.title,
    total: draft.stickers.length,
    okCount: draft.stickers.filter((item) => item.status === "prepared").length,
    pendingCount: draft.stickers.filter((item) => item.decision === "pending").length,
    failedCount: draft.stickers.filter((item) => item.status === "failed").length,
    contactSheet: draft.contactSheet,
    stickers: draft.stickers,
    profile: draft.profile,
    reviewBrief: draft.reviewBrief
  };
}

async function readStickerDraft(config = {}, params = {}) {
  const draftPath = await resolveDraftPath(config, readString(params, "draftPath") || readString(params, "draftId") || readString(params, "name"));
  const draft = await readJson(draftPath);
  return { draftPath, draft };
}

function hasStickerDraftSelector(params = {}) {
  return Boolean(readString(params, "draftPath") || readString(params, "draftId") || readString(params, "name"));
}

async function readLatestStickerDraftForOwner(config = {}, ctx = {}) {
  const ownerUserId = contextRequesterUserId(ctx);
  if (!ownerUserId) return null;
  const root = draftRoot(config);
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const draftPath = path.join(root, entry.name);
      try {
        const stat = await fs.stat(draftPath);
        const draft = await readJson(draftPath);
        if (normalizeOwnerUserId(draft.ownerUserId) !== ownerUserId) continue;
        candidates.push({
          draftPath,
          draft,
          time: Date.parse(draft.updatedAt || draft.createdAt || "") || stat.mtimeMs
        });
      } catch {
        // Ignore corrupt or partial draft files.
      }
    }
    candidates.sort((a, b) => b.time - a.time);
    return candidates[0] || null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readStickerDraftForPublish(config = {}, params = {}, ctx = {}) {
  if (hasStickerDraftSelector(params)) return readStickerDraft(config, params);
  const latest = await readLatestStickerDraftForOwner(config, ctx);
  if (latest) return latest;
  return readStickerDraft(config, params);
}

function normalizeDraftIndex(value, stickers = []) {
  const n = Number(value);
  if (!Number.isInteger(n)) return -1;
  if (n >= 1 && n <= stickers.length) return n - 1;
  if (n >= 0 && n < stickers.length) return n;
  return -1;
}

async function reviewStickerDraft(config = {}, params = {}) {
  const { draftPath, draft } = await readStickerDraft(config, params);
  const updates = Array.isArray(params.items) ? params.items : [];
  if (!updates.length) throw new Error("items are required for review_draft");
  for (const update of updates) {
    if (!isRecord(update)) continue;
    const index = normalizeDraftIndex(update.index ?? update.stickerIndex ?? update.id, draft.stickers);
    if (index < 0) continue;
    const item = draft.stickers[index];
    if (!item || item.status === "failed") continue;
    if (update.keep !== undefined) item.decision = readBoolean(update, "keep", false) ? "keep" : "reject";
    const decision = readString(update, "decision").toLowerCase();
    if (["keep", "reject", "pending"].includes(decision)) item.decision = decision;
    const emojiList = optionalEmojiList(update);
    if (emojiList.length) item.emojiList = emojiList;
    if (update.keywords !== undefined || update.tags !== undefined) item.keywords = normalizeKeywords(update);
    const note = readString(update, "notes") || readString(update, "note") || readString(update, "reason");
    if (note) item.notes = clip(note, 240);
    item.reviewedAt = new Date().toISOString();
  }
  draft.updatedAt = new Date().toISOString();
  const kept = draft.stickers.filter((item) => item.decision === "keep");
  draft.status = kept.length ? (kept.some((item) => !item.emojiList?.length) ? "needs_emoji" : "reviewed") : "awaiting_review";
  const summary = readString(params, "summary") || readString(params, "packNotes");
  if (summary) draft.reviewSummary = clip(summary, 600);
  draft.reviewBrief = buildDraftReviewBrief(draft);
  await writeJson(draftPath, draft);
  return {
    status: draft.status,
    draftPath,
    draftId: draft.id,
    name: draft.name,
    title: draft.title,
    total: draft.stickers.length,
    keptCount: kept.length,
    rejectedCount: draft.stickers.filter((item) => item.decision === "reject").length,
    pendingCount: draft.stickers.filter((item) => item.decision === "pending").length,
    missingEmojiCount: kept.filter((item) => !item.emojiList?.length).length,
    contactSheet: draft.contactSheet,
    reviewBrief: draft.reviewBrief,
    stickers: draft.stickers
  };
}

async function getStickerDraft(config = {}, params = {}) {
  const { draftPath, draft } = await readStickerDraft(config, params);
  const reviewBrief = buildDraftReviewBrief(draft);
  const kept = draft.stickers.filter((item) => item.decision === "keep");
  return {
    status: draft.status || "ok",
    draftPath,
    draftId: draft.id,
    name: draft.name,
    title: draft.title,
    sourceQuery: draft.sourceQuery || "",
    sourceKind: draft.sourceKind || "",
    total: draft.stickers.length,
    keptCount: kept.length,
    rejectedCount: draft.stickers.filter((item) => item.decision === "reject").length,
    pendingCount: draft.stickers.filter((item) => item.decision === "pending").length,
    missingEmojiCount: kept.filter((item) => !item.emojiList?.length).length,
    contactSheet: draft.contactSheet,
    reviewSheet: draft.reviewSheet || null,
    stickers: draft.stickers,
    profile: draft.profile || {},
    reviewBrief
  };
}

async function getStickerReviewBrief(config = {}, params = {}) {
  const { draftPath, draft } = await readStickerDraft(config, params);
  const reviewBrief = buildDraftReviewBrief(draft);
  return {
    status: draft.status || "ok",
    draftPath,
    draftId: draft.id,
    name: draft.name,
    title: draft.title,
    total: Array.isArray(draft.stickers) ? draft.stickers.length : 0,
    contactSheet: draft.contactSheet,
    stickers: draft.stickers || [],
    reviewBrief
  };
}

async function createStickerReviewSheet(config = {}, params = {}) {
  const { draftPath, draft } = await readStickerDraft(config, params);
  const reviewSheet = await buildReviewSheet(config, draft);
  if (!reviewSheet) throw new Error("draft has no stickers for review sheet");
  draft.reviewSheet = reviewSheet;
  draft.updatedAt = new Date().toISOString();
  await writeJson(draftPath, draft);
  const kept = Array.isArray(draft.stickers) ? draft.stickers.filter((item) => item.decision === "keep") : [];
  return {
    status: "ok",
    draftPath,
    draftId: draft.id,
    name: draft.name,
    title: draft.title,
    keptCount: kept.length,
    rejectedCount: Array.isArray(draft.stickers) ? draft.stickers.filter((item) => item.decision === "reject").length : 0,
    pendingCount: Array.isArray(draft.stickers) ? draft.stickers.filter((item) => item.decision === "pending").length : 0,
    missingEmojiCount: kept.filter((item) => !item.emojiList?.length).length,
    contactSheet: reviewSheet,
    reviewSheet,
    stickers: draft.stickers || []
  };
}

async function publishStickerDraft(config = {}, params = {}, ctx) {
  let hydratedParams = await hydrateStickerParamsFromPlan(config, "publish_draft", params);
  const { draftPath, draft } = await readStickerDraftForPublish(config, hydratedParams, ctx);
  if (!hasStickerDraftSelector(hydratedParams) && draft.id) {
    hydratedParams = {
      ...hydratedParams,
      draftId: draft.id,
      userId: readString(hydratedParams, "userId") || readString(hydratedParams, "ownerUserId") || draft.ownerUserId
    };
  }
  const selected = draft.stickers.filter((item) => item.status === "prepared" && item.decision === "keep");
  if (!selected.length) throw new Error("draft has no kept stickers to publish");
  const missingEmoji = selected.filter((item) => !item.emojiList?.length);
  if (missingEmoji.length && readBoolean(hydratedParams, "requireEmoji", true)) {
    throw new Error(`draft has ${missingEmoji.length} kept sticker(s) without emoji`);
  }
  const mode = (readString(hydratedParams, "publishMode") || readString(hydratedParams, "mode") || "create").toLowerCase();
  const dryRun = hydratedParams.dryRun === undefined ? true : readBoolean(hydratedParams, "dryRun", true);
  const ownerForCheck = normalizeOwnerUserId(readString(hydratedParams, "userId") || readString(hydratedParams, "ownerUserId") || draft.ownerUserId, ctx);
  assertOwnerMatchesContext(ownerForCheck, ctx, { dryRun, action: "publish_draft" });
  let nestedCtx = ctx;
  let nestedParams = hydratedParams;
  if (!dryRun) {
    const approval = await requireDirectApproval(config, hydratedParams, ["publishApproved", "publishDraftApproved", "explicitUserApproval"], "publish_draft", ctx);
    nestedCtx = trustedNestedStickerMutationContext(ctx, approval.plan?.id ? `publish_draft:${approval.plan.id}` : approval.directTrusted ? "publish_draft:trusted_direct" : "publish_draft");
    nestedParams = stripStickerPlanParams(hydratedParams);
    if (!draft.reviewSheet?.outputPath) {
      const reviewSheet = await buildReviewSheet(config, draft);
      if (!reviewSheet?.outputPath) throw new Error("publish_draft dryRun:false could not create a review_sheet for the current draft");
      draft.reviewSheet = reviewSheet;
      draft.contactSheet ||= reviewSheet;
    }
  }
  const items = selected.slice(0, MAX_DRAFT_STICKERS).map((item) => ({
    input: item.outputPath,
    emojiList: item.emojiList?.length ? item.emojiList : ["\uD83D\uDE42"],
    keywords: item.keywords || []
  }));
  const common = {
    ...nestedParams,
    name: readString(nestedParams, "name") || draft.name,
    title: readString(nestedParams, "title") || draft.title,
    userId: readString(nestedParams, "userId") || readString(nestedParams, "ownerUserId") || draft.ownerUserId,
    items,
    dryRun
  };
  const result = mode === "add"
    ? await addStickerBatch(config, common, nestedCtx)
    : await createStickerSetBatch(config, common, nestedCtx);
  draft.updatedAt = new Date().toISOString();
  draft.status = result.dryRun ? "publish_dry_run" : "published";
  draft.lastPublish = {
    at: draft.updatedAt,
    mode,
    dryRun: result.dryRun,
    count: result.count,
    name: result.name || common.name,
    link: result.link || `https://t.me/addstickers/${common.name}`
  };
  await writeJson(draftPath, draft);
  return {
    ...result,
    status: draft.status,
    draftPath,
    draftId: draft.id,
    contactSheet: draft.contactSheet,
    reviewSheet: draft.reviewSheet,
    selectedCount: selected.length,
    missingEmojiCount: missingEmoji.length
  };
}

function stickerItemFromTelegramSticker(sticker = {}, index = 0) {
  const format = stickerFormatFromTelegramSticker(sticker);
  const emoji = String(sticker.emoji || "").trim() || "\uD83D\uDE42";
  return {
    index,
    status: "source",
    fileId: sticker.file_id || "",
    sticker: sticker.file_id || "",
    fileUniqueId: sticker.file_unique_id || "",
    emoji,
    emojiList: [emoji],
    format,
    stickerFormat: format,
    stickerType: sticker.type || "",
    width: sticker.width,
    height: sticker.height,
    isAnimated: Boolean(sticker.is_animated),
    isVideo: Boolean(sticker.is_video),
    sourceSetName: sticker.set_name || ""
  };
}

function importableStickersFromSet(stickerSet = {}, params = {}) {
  const stickers = Array.isArray(stickerSet.stickers) ? stickerSet.stickers : [];
  const offset = readNumber(params, "offset", 0, 0, Math.max(0, stickers.length));
  const limit = readNumber(params, "limit", readNumber(params, "count", stickers.length, 1, Math.max(1, stickers.length || 1)), 1, maxStickersForSetType(stickerSet.sticker_type));
  const filter = normalizeFormatFilter(params);
  return stickers
    .map((item, index) => stickerItemFromTelegramSticker({ ...item, set_name: stickerSet.name }, index))
    .filter((item) => !filter || filter.has(item.format))
    .slice(offset, offset + limit);
}

async function loadStickerSet(config, rawName) {
  const name = readStickerSetName(rawName);
  if (!name) throw new Error("sticker set name or t.me/addstickers link is required");
  return botApi(config, "getStickerSet", { name });
}

async function sourceStickerSet(config, params = {}) {
  const name = readSourceSetName(params) || readStickerSetName(readString(params, "name") || readString(params, "setName"));
  const result = await loadStickerSet(config, name);
  const stickers = importableStickersFromSet(result, params);
  return {
    status: "ok",
    sourceName: result.name,
    name: result.name,
    title: result.title,
    stickerType: result.sticker_type || "",
    count: Array.isArray(result.stickers) ? result.stickers.length : 0,
    selectedCount: stickers.length,
    formatCounts: formatCounts(stickers),
    link: `https://t.me/addstickers/${result.name}`,
    stickers
  };
}

async function downloadStickerSet(config = {}, params = {}) {
  const startedAt = Date.now();
  const name = readSourceSetName(params) || readStickerSetName(readString(params, "name") || readString(params, "setName"));
  const result = await loadStickerSet(config, name);
  const selected = importableStickersFromSet(result, params);
  if (!selected.length) throw new Error("sticker set has no selected stickers to download");
  const outputDir = await resolveStickerDownloadDir(config, params, result.name);
  const concurrency = readNumber(params, "concurrency", 3, 1, 4);
  const stickers = await mapLimit(selected, concurrency, async (item, index) => {
    try {
      return await downloadTelegramStickerFile(config, { ...item, index: item.index ?? index }, outputDir);
    } catch (error) {
      return {
        ...item,
        status: "failed",
        error: clip(error instanceof Error ? error.message : String(error), 240)
      };
    }
  });
  const ok = stickers.filter((item) => item.status === "downloaded");
  const manifest = {
    kind: "imagebot.stickerSetDownload",
    version: 1,
    downloadedAt: new Date().toISOString(),
    sourceName: result.name,
    title: result.title,
    stickerType: result.sticker_type || "",
    link: `https://t.me/addstickers/${result.name}`,
    count: ok.length,
    total: stickers.length,
    formatCounts: formatCounts(ok),
    stickers
  };
  const manifestPath = path.join(outputDir, "manifest.json");
  await writeJson(manifestPath, manifest);
  return {
    status: ok.length === stickers.length ? "downloaded" : "partial",
    sourceName: result.name,
    name: result.name,
    title: result.title,
    stickerType: result.sticker_type || "",
    link: `https://t.me/addstickers/${result.name}`,
    count: ok.length,
    total: stickers.length,
    failedCount: stickers.length - ok.length,
    selectedCount: selected.length,
    formatCounts: manifest.formatCounts,
    outputDir,
    manifestPath,
    concurrency,
    durationMs: Date.now() - startedAt,
    stickers
  };
}

async function verifyStickerSourceCandidate(config = {}, candidate = {}, params = {}) {
  try {
    const result = await loadStickerSet(config, candidate.name);
    const allItems = (Array.isArray(result.stickers) ? result.stickers : [])
      .map((item, index) => stickerItemFromTelegramSticker({ ...item, set_name: result.name }, index));
    const selectionParams = { ...params, limit: maxStickersForSetType(result.sticker_type), count: undefined };
    const selectedItems = importableStickersFromSet(result, selectionParams);
    if (normalizeFormatFilter(params) && !selectedItems.length) {
      throw new Error("no stickers matching requested source format filter");
    }
    const emojiPreview = [...new Set(selectedItems.map((item) => item.emoji).filter(Boolean))].slice(0, 12);
    return {
      status: "ok",
      name: result.name,
      title: result.title,
      stickerType: result.sticker_type || "",
      count: allItems.length,
      selectedCount: selectedItems.length,
      formatCounts: formatCounts(selectedItems),
      totalFormatCounts: formatCounts(allItems),
      emojiPreview,
      link: `https://t.me/addstickers/${result.name}`,
      sourceUrl: candidate.sourceUrl || candidate.link || "",
      sourceTitle: candidate.sourceTitle || "",
      snippet: candidate.snippet || "",
      query: candidate.query || ""
    };
  } catch (error) {
    return {
      status: "failed",
      name: candidate.name || "",
      link: candidate.link || "",
      sourceUrl: candidate.sourceUrl || "",
      sourceTitle: candidate.sourceTitle || "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function searchStickerSources(config = {}, params = {}, signal) {
  const requestedCount = readNumber(params, "count", SOURCE_SEARCH_DEFAULT_COUNT, 1, SOURCE_SEARCH_MAX_COUNT);
  const verify = readBoolean(params, "verify", true);
  const discovered = await discoverStickerSourceCandidates(params, signal);
  const candidateLimit = readNumber(params, "candidateLimit", Math.max(requestedCount * 4, requestedCount), 1, 40);
  const candidates = discovered.candidates.slice(0, candidateLimit);
  if (!verify) {
    const sources = candidates.slice(0, requestedCount).map((item) => ({ status: "candidate", ...item }));
    return {
      status: sources.length ? "ok" : "empty",
      query: discovered.query,
      searchQueries: discovered.searchQueries,
      resultPageCount: discovered.resultPageCount,
      candidateCount: discovered.candidates.length,
      count: sources.length,
      verify: false,
      failures: discovered.failures.slice(0, 8),
      sources
    };
  }
  const checked = await mapLimit(candidates, 3, (candidate) => verifyStickerSourceCandidate(config, candidate, params));
  const sources = checked.filter((item) => item.status === "ok").slice(0, requestedCount);
  return {
    status: sources.length ? "ok" : "empty",
    query: discovered.query,
    searchQueries: discovered.searchQueries,
    resultPageCount: discovered.resultPageCount,
    candidateCount: discovered.candidates.length,
    checkedCount: checked.length,
    rejectedCount: checked.filter((item) => item.status !== "ok").length,
    count: sources.length,
    verify: true,
    failures: [...discovered.failures, ...checked.filter((item) => item.status !== "ok").slice(0, 8)],
    sources
  };
}

function chunkItems(items = [], size = 50) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function copyStickerSet(config = {}, params = {}, ctx) {
  const sourceName = readSourceSetName(params);
  if (!sourceName) throw new Error("sourceSet/sourceName/fromSet or t.me/addstickers URL is required");
  const source = await loadStickerSet(config, sourceName);
  const sourceItems = importableStickersFromSet(source, params);
  if (!sourceItems.length) throw new Error("source sticker set has no selected stickers");
  const owner = normalizeOwnerUserId(readString(params, "userId") || readString(params, "ownerUserId"), ctx);
  if (!owner) throw new Error("userId/ownerUserId is required to copy a sticker set");
  const mode = (readString(params, "publishMode") || readString(params, "mode") || "create").toLowerCase();
  const botUsername = await resolveBotUsername(config, params);
  const targetName = mode === "add"
    ? readString(params, "name") || readString(params, "setName") || readString(params, "targetName")
    : normalizeSetName(readString(params, "targetName") || readString(params, "name") || readString(params, "setName") || `${source.name}_copy`, botUsername);
  if (!targetName) throw new Error("name/setName/targetName is required when adding to an existing set");
  const stickerType = normalizeStickerType(readString(params, "stickerType") || source.sticker_type || "regular");
  const maxTotal = maxStickersForSetType(stickerType);
  const selected = sourceItems.slice(0, maxTotal);
  const dryRun = params.dryRun === undefined ? true : readBoolean(params, "dryRun", true);
  const mutationAction = readStickerTargetAction(params, readString(params, "action") || "copy_set");
  assertOwnerMatchesContext(owner, ctx, { dryRun, action: "copy_set/import_set" });
  if (!dryRun) {
    try {
      await requireDirectApproval(config, params, ["directImportApproved", "copyApproved", "importApproved", "explicitUserApproval"], mutationAction, ctx);
    } catch (error) {
      if (error instanceof Error && /trusted mutation approval|model-supplied approval/.test(error.message)) {
        throw new Error(DIRECT_IMPORT_APPROVAL_ERROR);
      }
      throw error;
    }
  }
  const chunks = [];
  let created = null;
  let remaining = selected;
  if (mode !== "add") {
    const first = remaining.slice(0, MAX_CREATE_SET_ITEMS);
    created = await createStickerSetBatch(config, {
      ...params,
      userId: owner,
      name: targetName,
      title: readString(params, "title") || source.title || "Imported Stickers",
      stickerType,
      items: first,
      dryRun
    }, ctx);
    chunks.push({ action: "create_batch", count: first.length, status: created.status || "ok", dryRun: created.dryRun });
    remaining = remaining.slice(MAX_CREATE_SET_ITEMS);
  }
  for (const chunk of chunkItems(remaining, MAX_ADD_BATCH_ITEMS)) {
    const added = await addStickerBatch(config, {
      ...params,
      userId: owner,
      name: created?.name || targetName,
      stickerType,
      items: chunk,
      dryRun
    }, ctx);
    chunks.push({ action: "add_batch", count: chunk.length, status: added.status || "ok", dryRun: added.dryRun, failedCount: added.failedCount || 0 });
  }
  const failedCount = chunks.reduce((sum, item) => sum + (item.failedCount || 0), 0);
  return {
    status: dryRun ? "copy_dry_run" : (failedCount ? "partial" : "copied"),
    sourceName: source.name,
    name: created?.name || targetName,
    title: readString(params, "title") || source.title || "Imported Stickers",
    stickerType,
    link: `https://t.me/addstickers/${created?.name || targetName}`,
    count: selected.length - failedCount,
    total: selected.length,
    selectedCount: selected.length,
    failedCount,
    dryRun,
    formatCounts: formatCounts(selected),
    importPolicy: dryRun
      ? "dry-run; no Telegram mutation was performed"
      : "copy/import mutation completed with trusted runtime approval",
    chunks,
    stickers: selected.slice(0, MAX_BATCH_ITEMS)
  };
}

async function getStickerSet(config, params) {
  const name = readStickerSetName(readString(params, "name") || readString(params, "setName") || readString(params, "url"));
  if (!name) throw new Error("name/setName is required");
  const result = await botApi(config, "getStickerSet", { name });
  const stickers = importableStickersFromSet(result, params);
  return {
    name: result.name,
    title: result.title,
    stickerType: result.sticker_type || "",
    count: Array.isArray(result.stickers) ? result.stickers.length : 0,
    selectedCount: stickers.length,
    formatCounts: formatCounts(stickers),
    link: `https://t.me/addstickers/${result.name}`,
    stickers
  };
}

async function deleteSticker(config, params, ctx = {}) {
  const sticker = readString(params, "fileId") || readString(params, "sticker");
  if (!sticker) throw new Error("fileId/sticker is required");
  const dryRun = params.dryRun === undefined ? true : readBoolean(params, "dryRun", true);
  if (!dryRun) {
    await requireDirectApproval(config, params, ["directManagementApproved", "deleteApproved", "explicitUserApproval"], "delete_sticker", ctx);
    await botApi(config, "deleteStickerFromSet", { sticker });
  }
  return { status: dryRun ? "delete_dry_run" : "ok", fileId: sticker, dryRun };
}

async function setStickerKeywords(config, params, ctx = {}) {
  const sticker = readString(params, "fileId") || readString(params, "sticker");
  if (!sticker) throw new Error("fileId/sticker is required");
  const owner = normalizeOwnerUserId(readString(params, "userId") || readString(params, "ownerUserId"), ctx);
  const keywords = normalizeKeywords(params);
  const dryRun = params.dryRun === undefined ? true : readBoolean(params, "dryRun", true);
  if (!dryRun) {
    if (!owner) throw new Error("userId/ownerUserId is required to edit sticker keywords");
    assertOwnerMatchesContext(owner, ctx, { dryRun, action: "set_keywords" });
    await requireDirectApproval(config, params, ["directManagementApproved", "setKeywordsApproved", "explicitUserApproval"], "set_keywords", ctx);
    await botApi(config, "setStickerKeywords", { sticker, keywords });
  }
  return { status: dryRun ? "set_keywords_dry_run" : "ok", ownerUserId: owner, fileId: sticker, keywords, dryRun };
}

async function setStickerEmojiList(config, params, ctx = {}) {
  const sticker = readString(params, "fileId") || readString(params, "sticker");
  if (!sticker) throw new Error("fileId/sticker is required");
  const owner = normalizeOwnerUserId(readString(params, "userId") || readString(params, "ownerUserId"), ctx);
  const emojiList = normalizeEmojiList(params);
  const dryRun = params.dryRun === undefined ? true : readBoolean(params, "dryRun", true);
  if (!dryRun) {
    if (!owner) throw new Error("userId/ownerUserId is required to edit sticker emoji list");
    assertOwnerMatchesContext(owner, ctx, { dryRun, action: "set_emoji_list" });
    await requireDirectApproval(config, params, ["directManagementApproved", "setEmojiApproved", "explicitUserApproval"], "set_emoji_list", ctx);
    await botApi(config, "setStickerEmojiList", { sticker, emoji_list: emojiList });
  }
  return { status: dryRun ? "set_emoji_list_dry_run" : "ok", ownerUserId: owner, fileId: sticker, emojiList, dryRun };
}

function formatResult(action, result) {
  const lines = [`STICKER_PACK ${action} ${result.status || "ok"}`];
  if (result.planId) lines.push(`plan_id: ${result.planId}`);
  if (result.approvalCode) lines.push(`approval_code: ${result.approvalCode}`);
  if (result.targetAction) lines.push(`target_action: ${result.targetAction}`);
  if (result.expiresAt) lines.push(`expires_at: ${result.expiresAt}`);
  if (result.draftId) lines.push(`draft_id: ${result.draftId}`);
  if (result.draftPath) lines.push(`draft_path: ${result.draftPath}`);
  if (result.sourceName) lines.push(`source_set: ${result.sourceName}`);
  if (result.registryPath) lines.push(`registry: ${result.registryPath}`);
  if (result.defaultSet) lines.push(`default_set: ${result.defaultSet}`);
  if (result.managedSet) lines.push(`managed_set: ${result.managedSet}`);
  if (result.name) lines.push(`set: ${result.name}`);
  if (result.title) lines.push(`title: ${result.title}`);
  if (result.link) lines.push(`link: ${result.link}`);
  if (result.outputDir) lines.push(`output_dir: ${result.outputDir}`);
  if (result.manifestPath) lines.push(`manifest: ${result.manifestPath}`);
  if (result.outputPath) lines.push(`MEDIA: \`${result.outputPath}\``);
  if (result.contactSheet?.outputPath) lines.push(`contact_sheet: MEDIA: \`${result.contactSheet.outputPath}\``);
  if (result.reviewSheet?.outputPath && result.reviewSheet.outputPath !== result.contactSheet?.outputPath) lines.push(`review_sheet: MEDIA: \`${result.reviewSheet.outputPath}\``);
  if (result.fileId) lines.push(`file_id: ${clip(result.fileId, 160)}`);
  if (result.count !== undefined) lines.push(`stickers: ${result.count}`);
  if (result.total !== undefined) lines.push(`batch: ok=${result.okCount ?? result.count ?? 0}/${result.total} failed=${result.failedCount || 0}`);
  if (result.keptCount !== undefined) lines.push(`review: keep=${result.keptCount} reject=${result.rejectedCount || 0} pending=${result.pendingCount || 0} missingEmoji=${result.missingEmojiCount || 0}`);
  if (result.selectedCount !== undefined) lines.push(`selected: ${result.selectedCount}`);
  if (result.formatCounts) lines.push(`formats: static=${result.formatCounts.static || 0} animated=${result.formatCounts.animated || 0} video=${result.formatCounts.video || 0}`);
  if (result.query) lines.push(`query: ${result.query}`);
  if (Array.isArray(result.searchQueries) && result.searchQueries.length) lines.push(`search_queries: ${result.searchQueries.map((item) => `"${clip(item, 80)}"`).join(" | ")}`);
  if (result.candidateCount !== undefined) lines.push(`candidates: ${result.candidateCount}${result.checkedCount !== undefined ? ` checked=${result.checkedCount}` : ""}${result.rejectedCount !== undefined ? ` rejected=${result.rejectedCount}` : ""}`);
  if (result.durationMs !== undefined) lines.push(`duration_ms: ${result.durationMs}`);
  if (result.dryRun) lines.push("dry_run: true");
  if (result.keywords) lines.push(`keywords: ${result.keywords.join(", ") || "(none)"}`);
  if (result.emojiList) lines.push(`emoji_list: ${result.emojiList.join(" ")}`);
  if (result.importPolicy) lines.push(`import_policy: ${result.importPolicy}`);
  if (result.reviewBrief?.reviewTemplate?.length) {
    const template = result.reviewBrief.reviewTemplate.slice(0, MAX_BATCH_ITEMS);
    lines.push(`review_template_json: ${JSON.stringify(template)}`);
  }
  if (Array.isArray(result.stickers)) {
    for (const item of result.stickers.slice(0, MAX_BATCH_ITEMS)) {
      if (item.status === "failed") {
        lines.push(`${item.index + 1}. failed ${item.input || item.fileId || "(input)"} error=${item.error}`);
      } else if (item.status === "downloaded") {
        const emoji = item.emojiList?.length ? item.emojiList.join(" ") : item.emoji || "(needs emoji)";
        const format = item.format || item.stickerFormat || "static";
        lines.push(`${item.index + 1}. downloaded format=${format} emoji=${emoji} ${Math.ceil((item.sizeBytes || 0) / 1024)}KB`);
        lines.push(`MEDIA: \`${item.outputPath}\``);
      } else if (item.status === "source" || item.fileId) {
        const emoji = item.emojiList?.length ? item.emojiList.join(" ") : item.emoji || "(needs emoji)";
        const format = item.format || item.stickerFormat || "static";
        lines.push(`${item.index + 1}. source format=${format} emoji=${emoji} file_id=${clip(item.fileId || item.sticker || "", 72)}`);
      } else if (item.status === "ok" || item.status === "prepared") {
        const decision = item.decision ? ` decision=${item.decision}` : "";
        const emoji = item.emojiList?.length ? item.emojiList.join(" ") : "(needs emoji)";
        lines.push(`${item.index + 1}. ${item.status}${decision} ${item.input} ${Math.ceil((item.sizeBytes || 0) / 1024)}KB framing=${item.framing || ""} emoji=${emoji}`);
        lines.push(`MEDIA: \`${item.outputPath}\``);
      } else {
        lines.push(`${item.index + 1}. failed ${item.input || "(input)"} error=${item.error}`);
      }
    }
  }
  if (Array.isArray(result.sources)) {
    for (const [index, item] of result.sources.slice(0, SOURCE_SEARCH_MAX_COUNT).entries()) {
      const counts = item.formatCounts || {};
      const title = item.title ? ` title="${clip(item.title, 80)}"` : "";
      const selected = item.selectedCount !== undefined && item.selectedCount !== item.count ? ` selected=${item.selectedCount}` : "";
      const emoji = item.emojiPreview?.length ? ` emoji=${item.emojiPreview.join(" ")}` : "";
      lines.push(`${index + 1}. source ${item.name}${title} stickers=${item.count ?? "?"}${selected} formats=${counts.static || 0}/${counts.animated || 0}/${counts.video || 0}${emoji}`);
      lines.push(`   link: ${item.link || `https://t.me/addstickers/${item.name}`}`);
      if (item.sourceUrl) lines.push(`   found_at: ${clip(item.sourceUrl, 160)}`);
      lines.push(`   source_set: ${item.name}`);
    }
  }
  if (Array.isArray(result.managedSets)) {
    for (const [index, item] of result.managedSets.slice(0, MAX_BATCH_ITEMS).entries()) {
      const flags = [
        item.createdByBot ? "created_by_bot" : "local_record",
        item.permissionSource || ""
      ].filter(Boolean).join("/");
      const title = item.title ? ` title="${clip(item.title, 80)}"` : "";
      lines.push(`${index + 1}. managed ${item.name}${title} owner=${item.ownerUserId || "?"} type=${item.stickerType || "regular"} ${flags}`);
      if (item.link) lines.push(`   link: ${item.link}`);
    }
  }
  if (Array.isArray(result.results)) {
    for (const item of result.results.slice(0, MAX_BATCH_ITEMS)) {
      lines.push(`${item.index + 1}. ${item.status}${item.error ? ` error=${item.error}` : ""}`);
    }
  }
  if (Array.isArray(result.chunks)) {
    for (const [index, item] of result.chunks.entries()) {
      lines.push(`chunk ${index + 1}: ${item.action} count=${item.count} status=${item.status}${item.dryRun ? " dryRun=true" : ""}${item.failedCount ? ` failed=${item.failedCount}` : ""}`);
    }
  }
  return lines.join("\n");
}

function mediaPathsForResult(result = {}) {
  const paths = [];
  if (result.outputPath) paths.push(result.outputPath);
  if (result.contactSheet?.outputPath) paths.push(result.contactSheet.outputPath);
  if (result.reviewSheet?.outputPath) paths.push(result.reviewSheet.outputPath);
  if (Array.isArray(result.stickers)) {
    for (const item of result.stickers) {
      if (item?.outputPath) paths.push(item.outputPath);
    }
  }
  return [...new Set(paths)];
}

async function imageBlockForPath(filePath, mimeType = "image/webp") {
  if (!filePath) return null;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > CONTACT_SHEET_MAX_BYTES) return null;
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return {
      type: "image",
      data: data.toString("base64"),
      mimeType: ext === ".png" ? "image/png" : mimeType,
      fileName: path.basename(filePath)
    };
  } catch {
    return null;
  }
}

const stickerPackTool = {
  name: TOOL_NAME,
  label: "Sticker Pack",
  description: "Telegram sticker-set workbench: prepare files, draft/review/publish bot-created sets, inspect/download known sets, copy/import on request, add ordinary image media, and add already sent Telegram stickers by file_id.",
  parameters: {
    type: "object",
    additionalProperties: true,
    properties: {
      action: { type: "string", enum: EXPOSED_STICKER_ACTIONS, description: "Operation name. Replied Telegram sticker: use add_from_sticker with a Telegram sticker file_id/sticker object. Ordinary image media: use add; default set may omit name/setName." },
      targetAction: { type: "string", description: "For action=plan, the Telegram mutation action to confirm. Prefer this only for delete_sticker." },
      plan_id: { type: "string", description: "Sticker mutation plan id returned by action=plan." },
      confirmation_text: { type: "string", description: "Legacy hint only; confirmation is inferred from the trusted chat turn, not from this field." },
      input: { type: "string", description: "Bot-local image/sticker path, MEDIA line, media:// URI, or current/reply media handle resolved by runtime." },
      inputs: { type: "array", items: { type: "string" }, description: "Bot-local paths, MEDIA lines, media:// URIs, or current/reply media handles for batch operations." },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            input: { type: "string" },
            fileId: { type: "string" },
            format: { type: "string", enum: ["static", "animated", "video"] },
            index: { type: "number" },
            decision: { type: "string", enum: ["keep", "reject", "pending"] },
            keep: { type: "boolean" },
            emoji: { type: "string" },
            emojiList: { type: "array", items: { type: "string" } },
            keywords: { type: "string" },
            notes: { type: "string" }
          }
        },
        description: "Per-sticker inputs or review decisions. Extra aliases are accepted; see manual."
      },
      fileId: { type: "string", description: "Telegram sticker file_id; preferred for add_from_sticker when the source is an already sent/replied sticker." },
      telegramSticker: { type: "object", additionalProperties: true, description: "Telegram Sticker object from current/reply context. add_from_sticker extracts file_id, emoji, set_name, is_animated, and is_video." },
      stickerObject: { type: "object", additionalProperties: true, description: "Alias for telegramSticker." },
      sticker: {
        anyOf: [{ type: "object", additionalProperties: true }, { type: "string" }],
        description: "Telegram Sticker object for add_from_sticker, or a sticker file_id/local sticker path where the action accepts one."
      },
      userId: { type: "string", description: "Telegram owner user id for publishing." },
      name: { type: "string", description: "Sticker set name or base name. add/add_from_sticker can omit this when the user has a managed default set." },
      setName: { type: "string", description: "Sticker set name alias. add/add_from_sticker can omit this when the user has a managed default set." },
      sourceSet: { type: "string", description: "Existing Telegram set name or addstickers URL." },
      targetName: { type: "string", description: "Target sticker set name for copy_set/import_set." },
      title: { type: "string", description: "Sticker set title." },
      url: { type: "string", description: "Telegram addstickers URL." },
      query: { type: "string", description: "Search or draft theme text." },
      draftId: { type: "string", description: "Sticker draft id." },
      draftPath: { type: "string", description: "Sticker draft path inside draft storage." },
      emoji: { type: "string", description: "Primary emoji list string." },
      emojiList: { type: "array", items: { type: "string" }, description: "Emoji list." },
      keywords: { type: "string", description: "Sticker search keywords." },
      format: { type: "string", enum: ["static", "animated", "video"], description: "Sticker file format." },
      stickerType: { type: "string", enum: ["regular", "mask", "custom_emoji"], description: "Sticker set type." },
      botUsername: { type: "string", description: "Bot username for set-name suffix." },
      framing: { type: "string", enum: ["smart", "contain", "cover"], description: "Static-sticker framing." },
      quality: { type: "number", description: "Static WebP quality." },
      concurrency: { type: "number", description: "Local/API batch concurrency." },
      count: { type: "number", description: "Maximum source/download/search count." },
      limit: { type: "number", description: "Maximum source/download/search count." },
      offset: { type: "number", description: "Sticker offset for source/download actions." },
      sourceFormats: { type: "string", description: "Existing-set format filter." },
      downloadDir: { type: "string", description: "download_set output directory under sticker downloads." },
      mode: { type: "string", enum: ["create", "add"], description: "Create new set or add to existing set." },
      contactSheet: { type: "boolean", description: "Return contact sheet where supported." },
      autoPrepare: { type: "boolean", description: "Prepare ordinary images before upload." },
      dryRun: { type: "boolean", description: "Do not mutate Telegram when true. For user-aligned add/add_from_sticker/add_batch, omit or set false to perform the requested add; set true for preview only." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params = {}, _signal, _onUpdate, ctx) {
    try {
      const config = stickerPackTool.config || {};
      const action = readString(params, "action", "prepare").toLowerCase();
      const runtimeCtx = resolveStickerToolContext(_toolCallId, ctx);
      let result;
      if (action === "plan") result = await planStickerMutation(config, params, runtimeCtx);
      else if (action === "prepare") result = await prepareSticker(config, params);
      else if (action === "prepare_batch") result = await prepareStickerBatch(config, params);
      else if (action === "draft") result = await createStickerDraft(config, params, runtimeCtx);
      else if (action === "get_draft") result = await getStickerDraft(config, params);
      else if (action === "review_brief") result = await getStickerReviewBrief(config, params);
      else if (action === "review_draft") result = await reviewStickerDraft(config, params);
      else if (action === "review_sheet") result = await createStickerReviewSheet(config, params);
      else if (action === "list_managed_sets") result = await listManagedStickerSets(config, params, runtimeCtx);
      else if (action === "set_default_set") result = await setDefaultManagedSet(config, params, runtimeCtx);
      else if (action === "forget_managed_set") result = await forgetManagedSet(config, params, runtimeCtx);
      else if (action === "publish_draft") result = await publishStickerDraft(config, params, runtimeCtx);
      else if (action === "search_sources" || action === "search_sets") result = await searchStickerSources(config, params, _signal);
      else if (action === "source_set") result = await sourceStickerSet(config, params);
      else if (action === "download_set") result = await downloadStickerSet(config, params);
      else if (action === "copy_set" || action === "import_set") result = await copyStickerSet(config, params, runtimeCtx);
      else if (action === "upload") result = await uploadSticker(config, params, runtimeCtx);
      else if (action === "create") result = await createStickerSet(config, params, runtimeCtx);
      else if (action === "create_batch") result = await createStickerSetBatch(config, params, runtimeCtx);
      else if (action === "add") result = await addSticker(config, params, runtimeCtx);
      else if (action === "add_from_sticker") result = await addStickerFromSentSticker(config, params, runtimeCtx);
      else if (action === "add_batch") result = await addStickerBatch(config, params, runtimeCtx);
      else if (action === "get") result = await getStickerSet(config, params);
      else if (action === "delete_sticker") result = await deleteSticker(config, params, runtimeCtx);
      else if (action === "set_keywords") result = await setStickerKeywords(config, params, runtimeCtx);
      else if (action === "set_emoji_list") result = await setStickerEmojiList(config, params, runtimeCtx);
      else if (action === "link") {
        const botUsername = await resolveBotUsername(config, params);
        const name = normalizeSetName(readString(params, "name") || readString(params, "setName"), botUsername);
        result = { name, link: `https://t.me/addstickers/${name}` };
      } else {
        throw new Error("unknown sticker_pack action");
      }
      const previewPath = result.contactSheet?.outputPath || result.outputPath || "";
      const preview = await imageBlockForPath(previewPath, result.mimeType || "image/webp");
      return {
        content: [{ type: "text", text: formatResult(action, result) }, ...(preview ? [preview] : [])],
        details: {
          status: result.status || "ok",
          action,
          ...result,
          media: {
            mediaUrls: mediaPathsForResult(result),
            trustedLocalMedia: true,
            outbound: false
          }
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `STICKER_PACK error: ${clip(message, 600)}` }], details: { status: "failed", error: message } };
    }
  }
};

export const __testing = {
  allowedMediaRoots,
  resolveAllowedFile,
  prepareSticker,
  prepareStickerBatch,
  buildContactSheet,
  buildReviewSheet,
  createStickerDraft,
  getStickerDraft,
  getStickerReviewBrief,
  reviewStickerDraft,
  createStickerReviewSheet,
  publishStickerDraft,
  listManagedStickerSets,
  setDefaultManagedSet,
  forgetManagedSet,
  addStickerFromSentSticker,
  searchStickerSources,
  sourceStickerSet,
  downloadStickerSet,
  copyStickerSet,
  discoverStickerSourceCandidates,
  stickerCandidatesFromText,
  resolveDraftPath,
  draftRoot,
  stickerInputsForItems,
  createStickerSetBatch,
  addStickerBatch,
  readManagedSets,
  rememberManagedSet,
  managedSetsPath,
  readInputItems,
  imageBlockForPath,
  stickerByteLimit,
  stickerMimeType,
  normalizeStickerFormat,
  stickerFormatFromParams,
  normalizeSetName,
  normalizeEmojiList,
  normalizeKeywords,
  stickerFormatFromTelegramSticker,
  readStickerSetName,
  mediaRoot,
  tokenFile,
  sanitizeTelegramText,
  setFetchForTests(fn) {
    fetchImpl = fn;
  }
};

export default {
  id: "imagebot-sticker-pack",
  name: "Imagebot Sticker Pack",
  description: "Telegram sticker-file preparation and bot-created sticker-set management for selected Telegram/bot media. Sent sticker copying uses Telegram file_id directly; ordinary images use local media paths or handles.",
  register(api) {
    stickerPackTool.config = api.config || {};
    api.registerTool(stickerPackTool, { name: TOOL_NAME });
    registerLifecycleHook(api, "before_tool_call", async (event, ctx) => {
      rememberStickerToolContext(event, ctx);
    }, { name: "imagebot-sticker-pack-before-tool-call" });
    registerLifecycleHook(api, "after_tool_call", async (event, ctx) => {
      const toolName = readToolName(event);
      if (toolName !== TOOL_NAME) return;
      forgetStickerToolContext(event, ctx);
    }, { name: "imagebot-sticker-pack-after-tool-call" });
  }
};

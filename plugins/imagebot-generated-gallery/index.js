import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { mutationScopeKey, trustedMutationContext } from "../imagebot-shared/mutation-authorization.mjs";
import { withStateFileLock, writeJsonAtomic } from "../imagebot-shared/state-file.mjs";
import { openclawStatePath } from "../imagebot-shared/openclaw-paths.mjs";

const RECENT_TOOL_NAME = "generated_gallery_recent";
const SEARCH_TOOL_NAME = "generated_gallery_search";
const RESEND_TOOL_NAME = "generated_gallery_resend";
const STATS_TOOL_NAME = "generated_gallery_stats";
const GALLERY_TOOL_NAME = "generated_gallery";

const DEFAULT_COUNT = 6;
const MAX_COUNT = 12;
const MAX_RESEND_COUNT = 10;
const MAX_MANIFEST_LINES = 2000;
const MAX_MANIFEST_READ_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const PREVIEW_CELL_WIDTH = 220;
const PREVIEW_CELL_HEIGHT = 252;
const PREVIEW_IMAGE_EDGE = 190;
const PREVIEW_MAX_ITEMS = 12;
const PREVIEW_MAX_BYTES = 1_200_000;
const VISUAL_HASH_SIZE = 8;
const VISUAL_DHASH_WIDTH = 9;
const VISUAL_DHASH_HEIGHT = 8;
const MAX_VISUAL_INDEX_ENTRIES = 2000;
const MAX_VISUAL_DISTANCE = 128;
const pluginRequire = createRequire(import.meta.url);
let sharpModulePromise = null;
let runtimeConfig = {};

function configuredPath(key, fallback) {
  const value = String(runtimeConfig?.[key] || "").trim();
  return path.resolve(value || fallback);
}

function archiveRoot() {
  const configured = String(process.env.TELEGRAM_IMAGEBOT_MEDIA_ARCHIVE_DIR || "").trim();
  return configured
    ? path.resolve(configured)
    : configuredPath("archiveRoot", openclawStatePath("media", "archive"));
}

function sendCacheRoot() {
  return configuredPath("resendDir", openclawStatePath("media", "gallery-resend"));
}

function previewCacheRoot() {
  return configuredPath("previewDir", openclawStatePath("media", "gallery-preview"));
}

function galleryStateRoot() {
  return configuredPath("storeDir", openclawStatePath("generated-gallery"));
}

function visualHashIndexPath() {
  return path.join(galleryStateRoot(), `visual-hashes-${hash(archiveRoot(), 12)}.json`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  return typeof value === "string" ? value.trim() : fallback;
}

function readBoolean(params, key, fallback = false) {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(1|true|yes)$/i.test(value.trim());
  return fallback;
}

function readCount(params, fallback = DEFAULT_COUNT, max = MAX_COUNT) {
  const raw = isRecord(params) ? params.count : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function readNumber(params, key, fallback, min, max) {
  const raw = isRecord(params) ? params[key] : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function readConfigNumber(key, fallback, min, max) {
  const value = Number(runtimeConfig?.[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function manifestLineLimit() {
  return readConfigNumber("maxManifestLines", MAX_MANIFEST_LINES, 100, 5_000_000);
}

function manifestReadBytesLimit() {
  return readConfigNumber("maxManifestReadBytes", MAX_MANIFEST_READ_BYTES, 1 * 1024 * 1024, 1024 * 1024 * 1024);
}

function visualIndexEntryLimit() {
  return readConfigNumber("maxVisualIndexEntries", MAX_VISUAL_INDEX_ENTRIES, 100, 500_000);
}

function readPreviewFlag(params) {
  const value = isRecord(params) ? params.preview : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return !/^(0|false|no|off)$/i.test(value.trim());
  return true;
}

function readVisualQuery(params) {
  return readString(params, "image")
    || readString(params, "media")
    || readString(params, "path")
    || readString(params, "similarTo")
    || readString(params, "similar_to")
    || "";
}

function clip(value, max) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function hash(value, len = 20) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getSharp() {
  if (!sharpModulePromise) {
    sharpModulePromise = Promise.resolve().then(() => {
      const mod = pluginRequire("sharp");
      return mod.default || mod;
    });
  }
  return sharpModulePromise;
}

function isInside(root, target) {
  const rootNorm = path.resolve(root).toLowerCase();
  const targetNorm = path.resolve(target).toLowerCase();
  return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + path.sep);
}

function normalizeSource(value) {
  const source = String(value || "generated").trim().toLowerCase();
  if (source === "all" || source === "downloaded") return source;
  return "generated";
}

function normalizeRelativePath(value) {
  const rel = String(value || "").trim().replace(/^`+|`+$/g, "");
  if (!rel || path.isAbsolute(rel) || rel.includes("\0")) return "";
  const normalized = path.normalize(rel);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) return "";
  return normalized;
}

function parseManifestLine(line) {
  try {
    const record = JSON.parse(line);
    if (!isRecord(record)) return null;
    const rel = normalizeRelativePath(record.archivedRelativePath);
    const sha = typeof record.sha256 === "string" ? record.sha256.trim().toLowerCase() : "";
    const t = typeof record.t === "string" ? record.t : "";
    const timeMs = Date.parse(t);
    const ext = path.extname(rel).toLowerCase();
    if (!rel || !sha || !Number.isFinite(timeMs) || !ALLOWED_EXTS.has(ext)) return null;
    return {
      id: sha.slice(0, 16),
      t,
      timeMs,
      tool: typeof record.tool === "string" ? record.tool : "",
      sourceKind: typeof record.sourceKind === "string" ? record.sourceKind : "",
      sourceName: typeof record.sourceName === "string" ? record.sourceName : "",
      sizeBytes: Number(record.sizeBytes) || 0,
      sha256: sha,
      archivedRelativePath: rel,
      scopeKey: typeof record.scopeKey === "string" ? record.scopeKey.trim() : "",
      scopeHash: typeof record.scopeHash === "string" ? record.scopeHash.trim().toLowerCase() : "",
      chatId: typeof record.chatId === "string" || typeof record.chatId === "number" ? String(record.chatId).trim() : "",
      threadId: typeof record.threadId === "string" || typeof record.threadId === "number" ? String(record.threadId).trim() : "",
      sessionKey: typeof record.sessionKey === "string" ? record.sessionKey.trim() : "",
      sessionKeyHash: typeof record.sessionKeyHash === "string" ? record.sessionKeyHash.trim().toLowerCase() : "",
      windowId: typeof record.windowId === "string" || typeof record.windowId === "number" ? String(record.windowId).trim() : "",
      copied: record.copied === true,
      ext
    };
  } catch {
    return null;
  }
}

function runtimeGalleryScope(ctx = {}) {
  const context = trustedMutationContext(ctx);
  if (!context.chatId && !context.sessionKey && !context.windowId) return { enabled: false, context };
  const scopeKey = mutationScopeKey(context);
  return {
    enabled: true,
    context,
    scopeKey,
    scopeHash: hash(scopeKey, 20)
  };
}

function hashedValueMatches(rawHash, value) {
  const expected = String(rawHash || "").trim().toLowerCase();
  if (!expected || !value) return false;
  return hash(value, expected.length) === expected;
}

function entryHasScopeProvenance(entry = {}) {
  return Boolean(entry.scopeKey || entry.scopeHash || entry.chatId || entry.sessionKey || entry.sessionKeyHash || entry.windowId);
}

function entryMatchesRuntimeScope(entry = {}, scope = runtimeGalleryScope()) {
  if (!scope.enabled) return true;
  if (!entryHasScopeProvenance(entry)) return runtimeConfig.allowUnscopedRuntimeGallery === true;
  const context = scope.context || {};
  if (entry.scopeKey && entry.scopeKey === scope.scopeKey) return true;
  if (entry.scopeHash && entry.scopeHash === scope.scopeHash) return true;
  if (entry.sessionKey && context.sessionKey && entry.sessionKey === context.sessionKey) return true;
  if (entry.sessionKeyHash && hashedValueMatches(entry.sessionKeyHash, context.sessionKey)) return true;
  if (entry.windowId && context.windowId && entry.windowId === context.windowId) return true;
  if (entry.chatId && context.chatId && entry.chatId === context.chatId) {
    return !entry.threadId || !context.threadId || entry.threadId === context.threadId;
  }
  return false;
}

function scopeFilteredEntries(entries = [], ctx = {}) {
  const scope = runtimeGalleryScope(ctx);
  if (!scope.enabled) return entries;
  return entries.filter((entry) => entryMatchesRuntimeScope(entry, scope));
}

async function readManifestEntries() {
  const manifestPath = path.join(archiveRoot(), "manifest.jsonl");
  const raw = await readManifestTail(manifestPath);
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter(Boolean).slice(-manifestLineLimit());
  const latestByKey = new Map();
  for (const line of lines) {
    const entry = parseManifestLine(line);
    if (!entry) continue;
    const key = entry.sha256 || entry.archivedRelativePath;
    latestByKey.set(key, entry);
  }
  const entries = [...latestByKey.values()];
  entries.sort((left, right) => right.timeMs - left.timeMs);
  return entries;
}

async function readManifestTail(manifestPath, maxBytes = manifestReadBytesLimit()) {
  let stat;
  try {
    stat = await fs.stat(manifestPath);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
  if (!stat.isFile() || stat.size <= 0) return "";
  if (stat.size <= maxBytes) return await fs.readFile(manifestPath, "utf8");
  const length = maxBytes;
  const position = Math.max(0, stat.size - length);
  const handle = await fs.open(manifestPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const result = await handle.read(buffer, 0, length, position);
    let text = buffer.subarray(0, result.bytesRead).toString("utf8");
    if (position > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

function matchesSource(entry, source) {
  if (source === "all") return true;
  if (source === "downloaded") return entry.tool === "download_image_url" || entry.tool === "download_image_urls" || entry.sourceKind === "downloaded";
  return entry.tool === "image_generate" || entry.sourceKind === "tool-image-generation";
}

function addTerm(terms, value) {
  const term = String(value || "").trim().toLowerCase();
  if (term.length < 2) return;
  terms.add(term);
}

function extractTerms(query) {
  const terms = new Set();
  for (const match of String(query || "").matchAll(/[a-z0-9_.-]{2,64}/gi)) addTerm(terms, match[0]);
  for (const match of String(query || "").matchAll(/[\u4e00-\u9fff]{2,14}/g)) addTerm(terms, match[0]);
  return [...terms];
}

function scoreEntry(entry, terms) {
  if (terms.length === 0) return 1;
  const haystack = [
    entry.id,
    entry.sha256,
    entry.tool,
    entry.sourceKind,
    entry.sourceName,
    entry.archivedRelativePath
  ].join("\n").toLowerCase();
  let score = 0;
  for (const term of terms) {
    const count = haystack.split(term).length - 1;
    if (count > 0) score += count * (4 + Math.min(term.length, 12));
  }
  return score;
}

function formatSize(sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "unknown";
  return `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatEntry(entry, index) {
  const visual = Number.isFinite(entry.visualDistance)
    ? `visualDistance=${entry.visualDistance} similarity=${Math.round(Number(entry.visualSimilarity || 0) * 100)}%`
    : "";
  return [
    `${index + 1}. gallery_id=${entry.id}`,
    visual,
    `time=${entry.t}`,
    `tool=${entry.tool || "unknown"}`,
    `size=${formatSize(entry.sizeBytes)}`,
    `name=${clip(entry.sourceName || path.basename(entry.archivedRelativePath), 120)}`
  ].filter(Boolean).join(" | ");
}

function publicEntry(entry) {
  return {
    galleryId: entry.id,
    time: entry.t,
    tool: entry.tool,
    sourceKind: entry.sourceKind,
    sourceName: entry.sourceName,
    sizeBytes: entry.sizeBytes,
    sha256Prefix: entry.sha256.slice(0, 16),
    relativePath: entry.archivedRelativePath,
    scoped: entryHasScopeProvenance(entry),
    ...(Number.isFinite(entry.visualDistance) ? { visualDistance: entry.visualDistance } : {}),
    ...(Number.isFinite(entry.visualSimilarity) ? { visualSimilarity: entry.visualSimilarity } : {}),
    ...(entry.visualHash ? { visualHash: entry.visualHash } : {})
  };
}

function normalizeMediaPath(value) {
  let text = String(value || "").trim();
  const mediaMatch = text.match(/(?:MEDIA|SPOILER_MEDIA):\s*`?([^`\r\n]+)`?/i);
  if (mediaMatch) text = mediaMatch[1].trim();
  return text.replace(/^`+|`+$/g, "").replace(/^<|>$/g, "").trim();
}

async function resolveVisualQueryImagePath(params, entries = null) {
  const raw = normalizeMediaPath(readVisualQuery(params));
  if (!raw) return "";
  const source = normalizeSource(readString(params, "source", "all"));
  const available = entries ?? (await readManifestEntries()).filter((entry) => matchesSource(entry, source));
  const byId = findById(available, raw);
  if (byId) return await resolveArchivePath(byId);

  const root = archiveRoot();
  const rel = normalizeRelativePath(raw);
  if (rel) {
    const candidate = path.resolve(root, rel);
    if (isInside(root, candidate)) {
      try {
        return await ensureVisualQueryPathAllowed(candidate);
      } catch {}
    }
  }
  if (!path.isAbsolute(raw) || raw.includes("\0")) throw new Error("visual gallery search image must be a bot-local media path, archive relative path, or gallery id");
  return await ensureVisualQueryPathAllowed(raw);
}

async function ensureVisualQueryPathAllowed(filePath) {
  const candidate = path.resolve(filePath);
  const allowedRoots = [
    archiveRoot(),
    openclawStatePath("media")
  ].map((root) => path.resolve(root));
  if (!allowedRoots.some((root) => isInside(root, candidate))) {
    throw new Error("visual gallery search only accepts archive or bot media paths");
  }
  const realRoots = await Promise.all(allowedRoots.map((root) => fs.realpath(root).catch(() => root)));
  const realPath = await fs.realpath(candidate);
  if (!realRoots.some((root) => isInside(root, realPath))) {
    throw new Error("visual gallery search real path escaped allowed roots");
  }
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new Error("visual gallery search image is not a file");
  if (stat.size <= 0 || stat.size > MAX_MEDIA_BYTES) throw new Error(`visual gallery search image size is not supported (${stat.size} bytes)`);
  const ext = path.extname(realPath).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) throw new Error(`visual gallery search image extension is not supported (${ext})`);
  return realPath;
}

function bitsToHex(bits) {
  let hex = "";
  for (let index = 0; index < bits.length; index += 4) {
    let value = 0;
    for (let offset = 0; offset < 4; offset += 1) {
      value = value * 2 + (bits[index + offset] ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
}

function popcountBigInt(value) {
  let count = 0;
  let current = value;
  while (current > 0n) {
    count += Number(current & 1n);
    current >>= 1n;
  }
  return count;
}

function hammingHex(left, right) {
  if (!left || !right || left.length !== right.length) return MAX_VISUAL_DISTANCE;
  return popcountBigInt(BigInt(`0x${left}`) ^ BigInt(`0x${right}`));
}

async function rawGreyscalePixels(sharp, filePath, width, height) {
  const { data, info } = await sharp(filePath, {
    animated: false,
    limitInputPixels: 72_000_000
  })
    .rotate()
    .resize(width, height, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels < 1) {
    throw new Error("unexpected visual hash pixel shape");
  }
  return data;
}

async function computeVisualHashes(filePath) {
  const sharp = await getSharp();
  const averagePixels = await rawGreyscalePixels(sharp, filePath, VISUAL_HASH_SIZE, VISUAL_HASH_SIZE);
  const avg = averagePixels.reduce((sum, value) => sum + value, 0) / averagePixels.length;
  const ahash = bitsToHex([...averagePixels].map((value) => value >= avg));

  const diffPixels = await rawGreyscalePixels(sharp, filePath, VISUAL_DHASH_WIDTH, VISUAL_DHASH_HEIGHT);
  const dBits = [];
  for (let y = 0; y < VISUAL_DHASH_HEIGHT; y += 1) {
    const row = y * VISUAL_DHASH_WIDTH;
    for (let x = 0; x < VISUAL_DHASH_WIDTH - 1; x += 1) {
      dBits.push(diffPixels[row + x] > diffPixels[row + x + 1]);
    }
  }
  const dhash = bitsToHex(dBits);
  return { ahash, dhash, algorithm: "ahash8+dhash8" };
}

async function readVisualHashIndex() {
  try {
    const parsed = JSON.parse(await fs.readFile(visualHashIndexPath(), "utf8"));
    return isRecord(parsed) && isRecord(parsed.entries) ? parsed : { schema: 1, entries: {} };
  } catch {
    return { schema: 1, entries: {} };
  }
}

async function writeVisualHashIndex(index) {
  const filePath = visualHashIndexPath();
  await writeJsonAtomic(filePath, { schema: 1, entries: index.entries || {} }, { space: 2 });
}

function visualIndexKey(entry) {
  return `${entry.sha256}:${entry.sizeBytes}:${entry.archivedRelativePath}`;
}

async function visualHashesForEntry(entry, index) {
  const key = visualIndexKey(entry);
  const cached = index.entries?.[key];
  if (isRecord(cached) && cached.ahash && cached.dhash) {
    return { ahash: cached.ahash, dhash: cached.dhash, algorithm: cached.algorithm || "ahash8+dhash8", cached: true };
  }
  const filePath = await resolveArchivePath(entry);
  const hashes = await computeVisualHashes(filePath);
  index.entries[key] = {
    ahash: hashes.ahash,
    dhash: hashes.dhash,
    algorithm: hashes.algorithm,
    timeMs: entry.timeMs,
    id: entry.id,
    updatedAt: new Date().toISOString()
  };
  return { ...hashes, cached: false };
}

async function listVisualSimilarEntries(params, sourceEntries) {
  const count = readCount(params);
  const maxDistance = readNumber(params, "maxDistance", MAX_VISUAL_DISTANCE, 0, MAX_VISUAL_DISTANCE);
  const queryPath = await resolveVisualQueryImagePath(params, sourceEntries);
  if (!queryPath) throw new Error("visual gallery search requires image, media, path, similarTo, or gallery id");
  const queryHashes = await computeVisualHashes(queryPath);
  return await withStateFileLock(visualHashIndexPath(), async () => {
    const index = await readVisualHashIndex();
    let dirty = false;
    const scored = [];
    for (const entry of sourceEntries.slice(0, visualIndexEntryLimit())) {
      try {
        const before = Object.keys(index.entries || {}).length;
        const hashes = await visualHashesForEntry(entry, index);
        const after = Object.keys(index.entries || {}).length;
        dirty ||= after !== before || hashes.cached === false;
        const ahashDistance = hammingHex(queryHashes.ahash, hashes.ahash);
        const dhashDistance = hammingHex(queryHashes.dhash, hashes.dhash);
        const visualDistance = ahashDistance + dhashDistance;
        if (visualDistance <= maxDistance) {
          scored.push({
            entry: {
              ...entry,
              visualDistance,
              visualSimilarity: Number(Math.max(0, 1 - visualDistance / MAX_VISUAL_DISTANCE).toFixed(4)),
              visualHash: `${hashes.ahash}:${hashes.dhash}`
            },
            score: MAX_VISUAL_DISTANCE - visualDistance
          });
        }
      } catch {
        // Skip unreadable archive items; text search/resend can still handle them.
      }
    }
    if (dirty) await writeVisualHashIndex(index);
    scored.sort((left, right) => left.entry.visualDistance - right.entry.visualDistance || right.entry.timeMs - left.entry.timeMs);
    return scored.slice(0, count).map((item) => item.entry);
  });
}

function previewCacheKey(entries, label = "gallery") {
  const payload = entries.map((entry) => [
    entry.id,
    entry.sha256,
    entry.archivedRelativePath,
    entry.timeMs
  ].join(":")).join("|");
  return `${label}-${hash(payload || "empty", 24)}.jpg`;
}

async function cachedPreviewPath(entries, label) {
  const root = previewCacheRoot();
  await fs.mkdir(root, { recursive: true });
  return path.join(root, previewCacheKey(entries, label));
}

async function buildEntryTile(sharp, entry, index) {
  const sourcePath = await resolveArchivePath(entry);
  const image = await sharp(sourcePath, {
    animated: false,
    limitInputPixels: 72_000_000
  })
    .rotate()
    .resize(PREVIEW_IMAGE_EDGE, PREVIEW_IMAGE_EDGE, {
      fit: "inside",
      withoutEnlargement: true,
      background: "#f4f4f5"
    })
    .flatten({ background: "#f4f4f5" })
    .png()
    .toBuffer();
  const meta = await sharp(image).metadata();
  const imageLeft = Math.max(0, Math.floor((PREVIEW_CELL_WIDTH - (meta.width || PREVIEW_IMAGE_EDGE)) / 2));
  const imageTop = 10 + Math.max(0, Math.floor((PREVIEW_IMAGE_EDGE - (meta.height || PREVIEW_IMAGE_EDGE)) / 2));
  const name = clip(entry.sourceName || path.basename(entry.archivedRelativePath), 28);
  const label = `${index + 1}. ${entry.id.slice(0, 8)}`;
  const caption = `${entry.tool || entry.sourceKind || "media"} | ${formatSize(entry.sizeBytes)}`;
  const svg = Buffer.from(`
    <svg width="${PREVIEW_CELL_WIDTH}" height="${PREVIEW_CELL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${PREVIEW_CELL_WIDTH}" height="${PREVIEW_CELL_HEIGHT}" rx="10" fill="#f7f7f8"/>
      <rect x="9" y="9" width="${PREVIEW_CELL_WIDTH - 18}" height="${PREVIEW_IMAGE_EDGE + 2}" rx="8" fill="#ffffff" stroke="#d4d4d8"/>
      <text x="12" y="${PREVIEW_IMAGE_EDGE + 36}" font-family="Arial, Microsoft YaHei, sans-serif" font-size="16" font-weight="700" fill="#18181b">${escapeXml(label)}</text>
      <text x="12" y="${PREVIEW_IMAGE_EDGE + 58}" font-family="Arial, Microsoft YaHei, sans-serif" font-size="12" fill="#52525b">${escapeXml(name)}</text>
      <text x="12" y="${PREVIEW_IMAGE_EDGE + 78}" font-family="Arial, Microsoft YaHei, sans-serif" font-size="11" fill="#71717a">${escapeXml(caption)}</text>
    </svg>
  `);
  return await sharp({
    create: {
      width: PREVIEW_CELL_WIDTH,
      height: PREVIEW_CELL_HEIGHT,
      channels: 4,
      background: "#ffffff"
    }
  })
    .composite([
      { input: svg, left: 0, top: 0 },
      { input: image, left: imageLeft, top: imageTop }
    ])
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();
}

async function buildGalleryPreview(entries, label = "gallery") {
  const selected = entries.slice(0, PREVIEW_MAX_ITEMS);
  if (!selected.length) return null;
  let sharp;
  try {
    sharp = await getSharp();
  } catch {
    return null;
  }
  const outputPath = await cachedPreviewPath(selected, label);
  try {
    const stat = await fs.stat(outputPath);
    if (stat.isFile() && stat.size > 0 && stat.size <= PREVIEW_MAX_BYTES) {
      const data = await fs.readFile(outputPath);
      return {
        type: "image",
        data: data.toString("base64"),
        mimeType: "image/jpeg",
        fileName: path.basename(outputPath),
        previewed: selected.length,
        cached: true
      };
    }
  } catch {}

  const tiles = [];
  for (const [index, entry] of selected.entries()) {
    try {
      tiles.push({ input: await buildEntryTile(sharp, entry, index), entry });
    } catch {
      // Broken or non-decodable archive items should not break text lookup/resend.
    }
  }
  if (!tiles.length) return null;
  const cols = Math.min(4, Math.ceil(Math.sqrt(tiles.length)));
  const rows = Math.ceil(tiles.length / cols);
  const width = cols * PREVIEW_CELL_WIDTH;
  const height = rows * PREVIEW_CELL_HEIGHT;
  const composite = tiles.map((tile, index) => ({
    input: tile.input,
    left: (index % cols) * PREVIEW_CELL_WIDTH,
    top: Math.floor(index / cols) * PREVIEW_CELL_HEIGHT
  }));
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#ffffff"
    }
  })
    .composite(composite)
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
  if (buffer.length <= PREVIEW_MAX_BYTES) {
    await fs.writeFile(outputPath, buffer);
  }
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType: "image/jpeg",
    fileName: path.basename(outputPath),
    previewed: tiles.length,
    cached: false
  };
}

function incrementCounter(map, key, amount = 1) {
  const normalized = String(key || "unknown").trim() || "unknown";
  map[normalized] = Number(map[normalized] || 0) + amount;
}

function topEntries(counter, count = 8) {
  return Object.entries(counter)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([key, value]) => ({ key, value }));
}

async function galleryStats(params = {}, ctx = {}) {
  const source = normalizeSource(readString(params, "source", "all"));
  const entries = scopeFilteredEntries(await readManifestEntries(), ctx).filter((entry) => matchesSource(entry, source));
  const byTool = {};
  const byExt = {};
  const byMonth = {};
  let totalBytes = 0;
  let newest = null;
  let oldest = null;
  for (const entry of entries) {
    incrementCounter(byTool, entry.tool || entry.sourceKind || "unknown");
    incrementCounter(byExt, entry.ext || "unknown");
    incrementCounter(byMonth, String(entry.t || "").slice(0, 7) || "unknown");
    totalBytes += Number(entry.sizeBytes || 0);
    if (!newest || entry.timeMs > newest.timeMs) newest = entry;
    if (!oldest || entry.timeMs < oldest.timeMs) oldest = entry;
  }
  return {
    source,
    total: entries.length,
    totalBytes,
    totalSize: formatSize(totalBytes),
    byTool: topEntries(byTool, 12),
    byExt: topEntries(byExt, 12),
    byMonth: topEntries(byMonth, 12),
    newest: newest ? publicEntry(newest) : null,
    oldest: oldest ? publicEntry(oldest) : null
  };
}

function formatStatsResult(stats) {
  const lines = [
    `GENERATED_GALLERY_STATS ok source=${stats.source} total=${stats.total} size=${stats.totalSize}`,
    `tools: ${stats.byTool.map((entry) => `${entry.key}=${entry.value}`).join(" | ") || "none"}`,
    `ext: ${stats.byExt.map((entry) => `${entry.key}=${entry.value}`).join(" | ") || "none"}`,
    `months: ${stats.byMonth.map((entry) => `${entry.key}=${entry.value}`).join(" | ") || "none"}`
  ];
  if (stats.newest) lines.push(`newest: gallery_id=${stats.newest.galleryId} time=${stats.newest.time} name=${clip(stats.newest.sourceName, 120)}`);
  if (stats.oldest) lines.push(`oldest: gallery_id=${stats.oldest.galleryId} time=${stats.oldest.time} name=${clip(stats.oldest.sourceName, 120)}`);
  return lines.join("\n");
}

async function listEntries(params, mode, ctx = {}) {
  const source = normalizeSource(readString(params, "source", "generated"));
  const count = readCount(params);
  const query = mode === "search" ? readString(params, "query") : "";
  const visualQuery = mode === "search" ? readVisualQuery(params) : "";
  const terms = extractTerms(query);
  const entries = scopeFilteredEntries(await readManifestEntries(), ctx).filter((entry) => matchesSource(entry, source));
  if (visualQuery) return await listVisualSimilarEntries(params, entries);
  const scored = entries.map((entry) => ({ entry, score: scoreEntry(entry, terms) }));
  scored.sort((left, right) => right.score - left.score || right.entry.timeMs - left.entry.timeMs);
  const filtered = mode === "search" && terms.length > 0 ? scored.filter((item) => item.score > 0) : scored;
  return filtered.slice(0, count).map((item) => item.entry);
}

function formatListResult(kind, entries, query = "", preview = null, options = {}) {
  const lines = [
    `${kind} ok results=${entries.length}${query ? ` query="${clip(query, 80)}"` : ""}${options.visual ? " mode=visual" : ""}`,
    "Use generated_gallery_resend with gallery_id to resend an archived image. Do not call image_generate when the user only wants a previous generated image resent.",
    `visualPreview: ${preview ? `${preview.previewed}/${entries.length} attached as contact sheet` : "none"}`
  ];
  if (options.visual) lines.push(`visualSearch: ahash8+dhash8 hamming distance, lower is more similar${Number.isFinite(options.maxDistance) ? `, maxDistance=${options.maxDistance}` : ""}`);
  for (const [index, entry] of entries.entries()) lines.push(formatEntry(entry, index));
  if (entries.length === 0) lines.push("No matching archived generated images were found.");
  return lines.join("\n");
}

async function resolveArchivePath(entry) {
  const root = archiveRoot();
  const candidate = path.resolve(root, entry.archivedRelativePath);
  if (!isInside(root, candidate)) throw new Error("gallery path escaped archive root");
  const realRoot = await fs.realpath(root).catch(() => root);
  const realPath = await fs.realpath(candidate);
  if (!isInside(realRoot, realPath)) throw new Error("gallery real path escaped archive root");
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new Error("gallery entry is not a file");
  if (stat.size <= 0 || stat.size > MAX_MEDIA_BYTES) throw new Error(`gallery entry size is not sendable (${stat.size} bytes)`);
  const ext = path.extname(realPath).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) throw new Error(`gallery entry extension is not sendable (${ext})`);
  return realPath;
}

function safeResendName(entry) {
  const base = path.basename(entry.archivedRelativePath).replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, "-").slice(0, 140);
  return base || `${entry.id}${entry.ext}`;
}

async function copyForSend(entry) {
  const sourcePath = await resolveArchivePath(entry);
  const targetDir = path.join(sendCacheRoot(), entry.t.slice(0, 7) || "unknown");
  await fs.mkdir(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, safeResendName(entry));
  try {
    await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return targetPath;
}

function readIds(params) {
  const ids = [];
  const rawIds = isRecord(params) ? params.ids : undefined;
  if (Array.isArray(rawIds)) {
    for (const raw of rawIds) {
      if (typeof raw === "string" && raw.trim()) ids.push(raw.trim());
    }
  }
  const rawId = readString(params, "id") || readString(params, "galleryId");
  if (rawId) ids.unshift(rawId);
  return [...new Set(ids)].slice(0, MAX_RESEND_COUNT);
}

function findById(entries, rawId) {
  const id = String(rawId || "").trim().toLowerCase().replace(/^gallery[_-]?id[:=]?/i, "");
  if (!id) return null;
  const rel = normalizeRelativePath(rawId);
  return entries.find((entry) => {
    return (
      entry.id.startsWith(id) ||
      entry.sha256.startsWith(id) ||
      entry.archivedRelativePath.toLowerCase() === id ||
      (rel && entry.archivedRelativePath.toLowerCase() === rel.toLowerCase())
    );
  }) || null;
}

async function selectResendEntries(params, ctx = {}) {
  const source = normalizeSource(readString(params, "source", "generated"));
  const entries = scopeFilteredEntries(await readManifestEntries(), ctx).filter((entry) => matchesSource(entry, source));
  const ids = readIds(params);
  if (ids.length > 0) {
    const selected = [];
    for (const id of ids) {
      const entry = findById(entries, id);
      if (entry) selected.push(entry);
    }
    return selected;
  }
  const query = readString(params, "query");
  if (query) return (await listEntries({ ...params, count: readCount(params, 1, MAX_RESEND_COUNT) }, "search", ctx)).slice(0, MAX_RESEND_COUNT);
  if (readBoolean(params, "latest", true)) return entries.slice(0, Math.min(1, MAX_RESEND_COUNT));
  return [];
}

async function resendEntries(params, ctx = {}) {
  const entries = await selectResendEntries(params, ctx);
  if (entries.length === 0) {
    return {
      entries: [],
      mediaUrls: []
    };
  }
  const mediaUrls = [];
  const copiedEntries = [];
  for (const entry of entries.slice(0, MAX_RESEND_COUNT)) {
    const mediaPath = await copyForSend(entry);
    mediaUrls.push(mediaPath);
    copiedEntries.push(entry);
  }
  return { entries: copiedEntries, mediaUrls };
}

function formatResendResult(entries, mediaUrls) {
  const lines = [
    `GENERATED_GALLERY_RESEND ok media=${mediaUrls.length}`,
    "This is an archived generated image resend, not a new image generation. Telegram can attach the structured media automatically."
  ];
  for (const [index, entry] of entries.entries()) lines.push(formatEntry(entry, index));
  for (const mediaUrl of mediaUrls) lines.push(`MEDIA:${mediaUrl}`);
  return lines.join("\n");
}

const generatedGalleryRecentTool = {
  name: RECENT_TOOL_NAME,
  label: "Generated Gallery Recent",
  description: "List recent archived imagebot generated images. Use before resending a previous generated image.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      count: {
        type: "number",
        description: `Number of recent entries, 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.`
      },
      source: {
        type: "string",
        enum: ["generated", "downloaded", "all"],
        description: "Gallery source to list. Default generated."
      },
      preview: {
        type: "boolean",
        description: "Attach a compact contact-sheet preview for the listed images. Default true."
      }
    }
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const entries = await listEntries(params, "recent", ctx);
      const preview = readPreviewFlag(params) ? await buildGalleryPreview(entries, "recent") : null;
      return {
        content: [{ type: "text", text: formatListResult("GENERATED_GALLERY_RECENT", entries, "", preview) }, ...(preview ? [preview] : [])],
        details: { status: "ok", results: entries.map(publicEntry) }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `GENERATED_GALLERY_RECENT error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

const generatedGallerySearchTool = {
  name: SEARCH_TOOL_NAME,
  label: "Generated Gallery Search",
  description: "Search archived imagebot generated images by id, filename, tool, manifest text, or visual similarity to a bot-local/archive image. Use before resending older generated media.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Search terms, filename fragment, gallery id, sha prefix, or user wording such as 'last generated image'. Optional when image/media/path/similarTo is supplied."
      },
      image: {
        type: "string",
        description: "Bot-local media path, MEDIA line, archive relative path, or gallery id to use as the visual-similarity query image."
      },
      media: {
        type: "string",
        description: "Alias for image."
      },
      path: {
        type: "string",
        description: "Alias for image."
      },
      similarTo: {
        type: "string",
        description: "Alias for image; accepts a gallery id or bot-local media path."
      },
      maxDistance: {
        type: "number",
        description: `Maximum combined aHash+dHash Hamming distance, 0-${MAX_VISUAL_DISTANCE}. Default ${MAX_VISUAL_DISTANCE} returns nearest matches. Lower is stricter.`
      },
      count: {
        type: "number",
        description: `Number of results, 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.`
      },
      source: {
        type: "string",
        enum: ["generated", "downloaded", "all"],
        description: "Gallery source to search. Default generated."
      },
      preview: {
        type: "boolean",
        description: "Attach a compact contact-sheet preview for matched images. Default true."
      }
    }
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const query = readString(params, "query");
      const visualQuery = readVisualQuery(params);
      if (!query && !visualQuery) throw new Error("generated_gallery action=search requires query or image/media/path/similarTo");
      const entries = await listEntries(params, "search", ctx);
      const preview = readPreviewFlag(params) ? await buildGalleryPreview(entries, "search") : null;
      const visual = Boolean(visualQuery);
      return {
        content: [{ type: "text", text: formatListResult("GENERATED_GALLERY_SEARCH", entries, query, preview, {
          visual,
          maxDistance: visual ? readNumber(params, "maxDistance", MAX_VISUAL_DISTANCE, 0, MAX_VISUAL_DISTANCE) : undefined
        }) }, ...(preview ? [preview] : [])],
        details: { status: "ok", query, visual, results: entries.map(publicEntry) }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `GENERATED_GALLERY_SEARCH error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

const generatedGalleryResendTool = {
  name: RESEND_TOOL_NAME,
  label: "Generated Gallery Resend",
  description: "Resend one or more archived generated images without calling image_generate again. Use for 'resend', 'send the previous image', or image delivery recovery.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "string",
        description: "Gallery id or sha prefix returned by generated_gallery action=recent/search."
      },
      galleryId: {
        type: "string",
        description: "Alias for id."
      },
      ids: {
        type: "array",
        items: { type: "string" },
        description: `Multiple gallery ids to resend as an album, max ${MAX_RESEND_COUNT}.`
      },
      query: {
        type: "string",
        description: "Optional search query if an id was not supplied. The first matching generated image is resent."
      },
      latest: {
        type: "boolean",
        description: "If true or omitted and no id/query is supplied, resend the latest generated image."
      },
      count: {
        type: "number",
        description: `Only used with query, 1-${MAX_RESEND_COUNT}.`
      },
      source: {
        type: "string",
        enum: ["generated", "downloaded", "all"],
        description: "Gallery source to resend from. Default generated."
      }
    }
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const { entries, mediaUrls } = await resendEntries(params, ctx);
      if (mediaUrls.length === 0) {
        return {
          content: [{ type: "text", text: "GENERATED_GALLERY_RESEND no_match: no archived generated image matched the request." }],
          details: { status: "no_match", media: { mediaUrls: [] } }
        };
      }
      return {
        content: [{ type: "text", text: formatResendResult(entries, mediaUrls) }],
        details: {
          status: "ok",
          results: entries.map(publicEntry),
          media: {
            mediaUrls,
            trustedLocalMedia: true,
            outbound: false
          }
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `GENERATED_GALLERY_RESEND error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

const generatedGalleryStatsTool = {
  name: STATS_TOOL_NAME,
  label: "Generated Gallery Stats",
  description: "Summarize the local imagebot media archive by source, tool, extension, month, size, newest, and oldest entries.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      source: {
        type: "string",
        enum: ["generated", "downloaded", "all"],
        description: "Gallery source to summarize. Default all."
      }
    }
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const stats = await galleryStats(params, ctx);
      return {
        content: [{ type: "text", text: formatStatsResult(stats) }],
        details: { status: "ok", stats }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `GENERATED_GALLERY_STATS error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

const generatedGalleryTool = {
  name: GALLERY_TOOL_NAME,
  label: "Generated Gallery",
  description: "Read archived generated/downloaded images through action=recent, search, or stats. Resend remains generated_gallery_resend.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["recent", "search", "stats"],
        description: "Gallery read action. Default recent unless query/image is supplied."
      },
      query: {
        type: "string",
        description: "Search terms, filename fragment, gallery id, sha prefix, or user wording such as 'last generated image'."
      },
      image: {
        type: "string",
        description: "Bot-local media path, MEDIA line, archive relative path, or gallery id for visual similarity search."
      },
      media: { type: "string", description: "Alias for image." },
      path: { type: "string", description: "Alias for image." },
      similarTo: { type: "string", description: "Alias for image." },
      maxDistance: {
        type: "number",
        description: `Maximum visual Hamming distance, 0-${MAX_VISUAL_DISTANCE}.`
      },
      count: {
        type: "number",
        description: `Number of results, 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.`
      },
      source: {
        type: "string",
        enum: ["generated", "downloaded", "all"],
        description: "Gallery source. Default generated for recent/search; all for stats."
      },
      preview: {
        type: "boolean",
        description: "Attach a compact contact-sheet preview for list/search. Default true."
      }
    }
  },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const requested = readString(params, "action").toLowerCase();
    const action = requested || (readString(params, "query") || readVisualQuery(params) ? "search" : "recent");
    if (action === "recent") return generatedGalleryRecentTool.execute(toolCallId, params, signal, onUpdate, ctx);
    if (action === "search") return generatedGallerySearchTool.execute(toolCallId, params, signal, onUpdate, ctx);
    if (action === "stats") return generatedGalleryStatsTool.execute(toolCallId, params, signal, onUpdate, ctx);
    return {
      content: [{ type: "text", text: "GENERATED_GALLERY error: action must be recent, search, or stats. Use generated_gallery_resend for resend." }],
      details: { status: "failed", error: "invalid action" }
    };
  }
};

export const __testing = {
  parseManifestLine,
  readManifestTail,
  readManifestEntries,
  listEntries,
  resendEntries,
  galleryStats,
  runtimeGalleryScope,
  entryMatchesRuntimeScope,
  scopeFilteredEntries,
  buildGalleryPreview,
  computeVisualHashes,
  hammingHex
};

export default {
  id: "imagebot-generated-gallery",
  name: "Imagebot Generated Gallery",
  description: "Lists and resends generated imagebot media from the local archive.",
  register(api) {
    runtimeConfig = api.config || {};
    api.registerTool(generatedGalleryTool, { name: GALLERY_TOOL_NAME });
    api.registerTool(generatedGalleryRecentTool, { name: RECENT_TOOL_NAME });
    api.registerTool(generatedGallerySearchTool, { name: SEARCH_TOOL_NAME });
    api.registerTool(generatedGalleryResendTool, { name: RESEND_TOOL_NAME });
    api.registerTool(generatedGalleryStatsTool, { name: STATS_TOOL_NAME });
  }
};

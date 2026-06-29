import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const TOOL_NAME = "pixiv_resource";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_COUNT = 30;
const MAX_DOWNLOAD_COUNT = 10;
const MAX_FILE_BYTES = 120 * 1024 * 1024;
const DEFAULT_RANKING_DOWNLOAD_CONCURRENCY = 2;
const MAX_RANKING_DOWNLOAD_CONCURRENCY = 3;
const DEFAULT_VISION_IMAGE_COUNT = 3;
const MAX_VISION_IMAGE_COUNT = 4;
const MAX_VISION_IMAGE_BYTES = 1_500_000;
const ALLOWED_MEDIA_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".ugoira", ".zip"]);
const VISION_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const IMAGE_MIME_BY_EXT = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"]
]);
const DEFAULT_BLOCKED_SAFETY_TAGS = new Set(["loli"]);
const WEB_RANKING_ALIASES = {
  day: "daily",
  daily: "daily",
  week: "weekly",
  weekly: "weekly",
  month: "monthly",
  monthly: "monthly",
  day_male: "male",
  male: "male",
  day_female: "female",
  female: "female",
  week_original: "original",
  original: "original",
  week_rookie: "rookie",
  rookie: "rookie",
  day_ai: "daily_ai",
  daily_ai: "daily_ai",
  day_r18: "daily_r18",
  daily_r18: "daily_r18",
  day_r18_ai: "daily_r18_ai",
  daily_r18_ai: "daily_r18_ai",
  day_male_r18: "male_r18",
  male_r18: "male_r18",
  day_female_r18: "female_r18",
  female_r18: "female_r18",
  week_r18: "weekly_r18",
  weekly_r18: "weekly_r18",
  week_r18g: "r18g",
  r18g: "r18g"
};

let spawnImpl = spawn;

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
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function rankingDownloadConcurrency(config = {}, params = {}) {
  const configured = readNumber(config, "rankingDownloadConcurrency", DEFAULT_RANKING_DOWNLOAD_CONCURRENCY, 1, MAX_RANKING_DOWNLOAD_CONCURRENCY);
  return readNumber(params, "downloadConcurrency", configured, 1, MAX_RANKING_DOWNLOAD_CONCURRENCY);
}

function visionImageCount(config = {}, params = {}) {
  const configured = readNumber(config, "visionImageCount", DEFAULT_VISION_IMAGE_COUNT, 0, MAX_VISION_IMAGE_COUNT);
  return readNumber(params, "visionCount", configured, 0, MAX_VISION_IMAGE_COUNT);
}

function clip(value, max = 600) {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function hash(value, len = 12) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function safePart(value, fallback = "pixiv") {
  const cleaned = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function secretPath(config = {}) {
  return path.resolve(String(config.refreshTokenFile || "").trim() || path.join(homeDir(), ".openclaw", "secrets", "pixiv-refresh.token"));
}

function storeRoot(config = {}) {
  return path.resolve(String(config.storeDir || "").trim() || path.join(homeDir(), ".openclaw", "resources", "pixiv"));
}

function mediaRoot(config = {}) {
  return path.resolve(String(config.mediaDir || "").trim() || path.join(homeDir(), ".openclaw", "media", "pixiv-resource"));
}

async function readRefreshToken(config = {}) {
  const envToken = String(process.env.PIXIV_REFRESH_TOKEN || process.env.OPENCLAW_PIXIV_REFRESH_TOKEN || "").trim();
  if (envToken) return envToken;
  const file = secretPath(config);
  let raw;
  try {
    raw = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "").trim();
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Pixiv refresh token missing: ${file}`);
    throw error;
  }
  if (!raw) throw new Error(`Pixiv refresh token file is empty: ${file}`);
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    const token = String(parsed.refreshToken || parsed.refresh_token || parsed.token || "").trim();
    if (token) return token;
  }
  return raw;
}

async function createGalleryDlConfig(config = {}) {
  const token = await readRefreshToken(config);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-pixiv-gallery-dl-"));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "gallery-dl-pixiv.json");
  const payload = {
    extractor: {
      pixiv: {
        "refresh-token": token
      },
      "pixiv-novel": {
        "refresh-token": token
      }
    }
  };
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return {
    file,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

function cleanStderr(value) {
  return String(value || "")
    .replace(/refresh-token['": ]+[A-Za-z0-9_.~+/=-]+/gi, "refresh-token=<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9_.~+/=-]+/gi, "Bearer <redacted>")
    .trim();
}

async function runGalleryDl(config = {}, args = [], options = {}) {
  const runtimeConfig = await createGalleryDlConfig(config);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const finalArgs = [
    "-m",
    "gallery_dl",
    "--config-ignore",
    "--config-json",
    runtimeConfig.file,
    "--no-input",
    "--no-colors",
    "--http-timeout",
    "45",
    "-R",
    "2",
    ...args
  ];
  return await new Promise((resolve, reject) => {
    const child = spawnImpl("python", finalArgs, {
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
      runtimeConfig.cleanup();
      reject(new Error(`gallery-dl timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runtimeConfig.cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runtimeConfig.cleanup();
      if (code === 0) {
        resolve({ stdout, stderr: cleanStderr(stderr), code });
      } else {
        reject(new Error(`gallery-dl exited ${code}: ${cleanStderr(stderr) || stdout.slice(0, 500)}`));
      }
    });
  });
}

function rankingMode(raw) {
  const value = String(raw || "daily").trim().toLowerCase();
  const mode = WEB_RANKING_ALIASES[value] || value;
  if (!/^[a-z0-9_]+$/i.test(mode)) throw new Error("Pixiv ranking mode must be alphanumeric/underscore");
  return mode;
}

function rankingDate(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.replace(/-/g, "");
  if (/^\d{8}$/.test(value)) return value;
  throw new Error("date must be YYYY-MM-DD or YYYYMMDD");
}

function rankingUrl(params = {}) {
  const url = new URL("https://www.pixiv.net/ranking.php");
  url.searchParams.set("mode", rankingMode(readString(params, "mode", "daily")));
  const date = rankingDate(readString(params, "date"));
  if (date) url.searchParams.set("date", date);
  const content = readString(params, "content");
  if (content) url.searchParams.set("content", content);
  return url.toString();
}

function artworkUrl(params = {}) {
  const raw = readString(params, "url") || readString(params, "artworkUrl");
  if (raw) return normalizePixivUrl(raw);
  const id = Number(readString(params, "illustId") || readString(params, "postId") || readString(params, "id"));
  if (!Number.isInteger(id) || id <= 0) throw new Error("illustId/postId/url is required");
  return `https://www.pixiv.net/artworks/${id}`;
}

function normalizePixivUrl(raw) {
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error("Pixiv URL must be https");
  if (parsed.hostname !== "www.pixiv.net" && parsed.hostname !== "pixiv.net") throw new Error("only pixiv.net URLs are allowed");
  parsed.hash = "";
  return parsed.toString();
}

function parseJsonPayload(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {}
  const values = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      values.push(JSON.parse(line));
    } catch {}
  }
  return values;
}

function collectGalleryDlEvents(payload) {
  const events = [];
  function visit(value) {
    if (Array.isArray(value) && typeof value[0] === "number") {
      events.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    }
  }
  visit(payload);
  return events;
}

function metadataFromEvent(event) {
  if (!Array.isArray(event)) return null;
  if (event[0] === -1) {
    const err = isRecord(event[1]) ? event[1] : {};
    throw new Error(`${err.error || "gallery-dl error"}: ${err.message || "unknown error"}`);
  }
  if (event[0] === 2 && isRecord(event[1])) return event[1];
  if (event[0] === 3 && isRecord(event[2])) return event[2];
  return null;
}

function publicItem(meta = {}, rank = null) {
  const id = Number(meta.id || meta.illust_id || meta.work_id || 0);
  const author = meta.user?.name || meta.user_name || meta.author || meta.member_name || meta.account || "";
  const authorId = meta.user?.id || meta.user_id || meta.member_id || "";
  const tags = Array.isArray(meta.tags)
    ? meta.tags
    : String(meta.tag_string || meta.tags || "").split(/\s+/).filter(Boolean);
  return {
    id,
    rank,
    title: String(meta.title || meta.illust_title || meta.caption_title || ""),
    author: String(author || ""),
    authorId: String(authorId || ""),
    type: String(meta.type || meta.category || "pixiv"),
    tags: tags.map(String).filter(Boolean).slice(0, 16),
    bookmarkCount: Number(meta.bookmark_count || meta.total_bookmarks || meta.bookmarks || 0),
    viewCount: Number(meta.view_count || meta.total_view || meta.views || 0),
    pageCount: Number(meta.page_count || meta.count || 1),
    date: String(meta.date || meta.create_date || ""),
    url: id ? `https://www.pixiv.net/artworks/${id}` : String(meta.url || meta.webpage_url || ""),
    raw: meta
  };
}

function normalizeSafetyTag(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/^#+/, "");
}

function configuredBlockedSafetyTags(config = {}) {
  const configured = Array.isArray(config.blockedTags) ? config.blockedTags : [];
  const extra = Array.isArray(config.additionalBlockedTags) ? config.additionalBlockedTags : [];
  return new Set([...DEFAULT_BLOCKED_SAFETY_TAGS, ...configured, ...extra].map(normalizeSafetyTag).filter(Boolean));
}

function isAdultPixivMode(value) {
  return /(?:^|[_-])r(?:-)?18(?:g)?(?:$|[_-])/i.test(String(value || "").trim());
}

function isAdultPixivUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return isAdultPixivMode(parsed.searchParams.get("mode") || "") || /r(?:-)?18/i.test(parsed.pathname);
  } catch {
    return isAdultPixivMode(value);
  }
}

function isAdultPixivItem(item = {}, context = {}) {
  if (context.adult === true || isAdultPixivUrl(context.url) || isAdultPixivMode(context.mode)) return true;
  const raw = isRecord(item.raw) ? item.raw : {};
  const rating = String(raw.rating || item.rating || "").trim();
  if (/r(?:-)?18/i.test(rating)) return true;
  const xRestrict = Number(raw.x_restrict ?? raw.xRestrict ?? item.x_restrict ?? item.xRestrict ?? 0);
  if (Number.isFinite(xRestrict) && xRestrict > 0) return true;
  const sanityLevel = Number(raw.sanity_level ?? raw.sanityLevel ?? item.sanity_level ?? item.sanityLevel ?? 0);
  if (Number.isFinite(sanityLevel) && sanityLevel >= 6) return true;
  return itemSafetyTagValues(item).some((tag) => /^(r-?18|r18g)$/i.test(String(tag || "").trim()));
}

function isAdultPixivContext(context = {}) {
  return context.adult === true || isAdultPixivUrl(context.url) || isAdultPixivMode(context.mode);
}

function hasAdultPixivItems(items = [], context = {}) {
  if (isAdultPixivContext(context)) return true;
  return (Array.isArray(items) ? items : []).some((item) => isAdultPixivItem(item, context));
}

function itemSafetyTagValues(item = {}) {
  const raw = isRecord(item.raw) ? item.raw : {};
  const values = [];
  const add = (value) => {
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    if (isRecord(value)) {
      for (const entry of Object.values(value)) add(entry);
      return;
    }
    const text = String(value || "").trim();
    if (text) values.push(text);
  };
  add(item.tags);
  add(raw.tags);
  add(raw.tag_string);
  add(raw.tags_original);
  add(raw.tags_translated);
  add(raw.tags_translations);
  add(raw["tags-en"]);
  return values;
}

function hasBlockedSafetyTag(item, config = {}, context = {}) {
  if (!isAdultPixivItem(item, context)) return false;
  const blocked = configuredBlockedSafetyTags(config);
  for (const tag of itemSafetyTagValues(item)) {
    const normalized = normalizeSafetyTag(tag);
    if (!normalized) continue;
    if (blocked.has(normalized)) return true;
  }
  return false;
}

function filterSafetyItems(config = {}, items = [], context = {}) {
  const allowed = [];
  let skippedBlocked = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (hasBlockedSafetyTag(item, config, context)) {
      skippedBlocked += 1;
      continue;
    }
    allowed.push(item);
  }
  return { allowed, skippedBlocked, rawCount: Array.isArray(items) ? items.length : 0 };
}

async function readJsonMaybe(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function annotateDownloadedMedia(files = [], context = {}) {
  const adultContext = isAdultPixivContext(context);
  const annotated = [];
  for (const file of Array.isArray(files) ? files : []) {
    const sidecar = await readJsonMaybe(`${file.path}.json`);
    const sidecarItem = isRecord(sidecar) ? publicItem(sidecar, 1) : null;
    const sensitiveMedia = adultContext || (sidecarItem ? isAdultPixivItem(sidecarItem, context) : false);
    annotated.push(sensitiveMedia ? { ...file, sensitiveMedia: true } : file);
  }
  return annotated;
}

function hasSensitiveMediaFiles(files = []) {
  return (Array.isArray(files) ? files : []).some((file) => file?.sensitiveMedia === true);
}

function parseItemsFromJson(stdout, maxCount = MAX_COUNT) {
  const payload = parseJsonPayload(stdout);
  const events = collectGalleryDlEvents(payload);
  const items = [];
  const seen = new Set();
  for (const event of events) {
    const meta = metadataFromEvent(event);
    if (!meta) continue;
    const item = publicItem(meta, items.length + 1);
    const key = item.id ? `id:${item.id}` : hash(JSON.stringify(meta), 16);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= maxCount) break;
  }
  return items;
}

async function metadataList(config, url, count) {
  const result = await runGalleryDl(config, [
    "-j",
    "-s",
    "--post-range",
    `1-${count}`,
    url
  ]);
  const rawItems = parseItemsFromJson(result.stdout, count);
  const filtered = filterSafetyItems(config, rawItems, { url });
  await writeJson(path.join(storeRoot(config), "metadata", `${Date.now()}-${hash(url, 10)}.json`), {
    fetchedAt: new Date().toISOString(),
    url,
    stderr: result.stderr,
    rawCount: filtered.rawCount,
    skippedBlocked: filtered.skippedBlocked,
    items: filtered.allowed
  });
  return { items: filtered.allowed, rawCount: filtered.rawCount, skippedBlocked: filtered.skippedBlocked, stderr: result.stderr };
}

async function listDownloadedMedia(root) {
  const files = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_MEDIA_EXTS.has(ext)) continue;
        const stat = await fs.stat(full).catch(() => null);
        if (!stat?.isFile()) continue;
        if (stat.size > 0 && stat.size <= MAX_FILE_BYTES) {
          files.push({ path: full, sizeBytes: stat.size, ext, mtimeMs: stat.mtimeMs });
        }
      }
    }
  }
  await walk(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
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

async function downloadWithGalleryDl(config, url, params = {}, context = {}) {
  const count = readNumber(params, "downloadCount", readNumber(params, "count", 1, 1, MAX_DOWNLOAD_COUNT), 1, MAX_DOWNLOAD_COUNT);
  const outDir = path.join(mediaRoot(config), `${Date.now()}-${safePart(readString(params, "mode", "pixiv"))}-${hash(url, 8)}-${crypto.randomBytes(3).toString("hex")}`);
  await fs.mkdir(outDir, { recursive: true });
  const args = [
    "-D",
    outDir,
    "-f",
    "/O",
    "--write-metadata",
    "--no-mtime",
    "--post-range",
    `1-${count}`
  ];
  const range = readString(params, "range", `1-${count}`);
  args.push("--range", range);
  args.push(url);
  const result = await runGalleryDl(config, args, { timeoutMs: DEFAULT_TIMEOUT_MS + 120_000 });
  const files = await listDownloadedMedia(outDir);
  const annotatedFiles = await annotateDownloadedMedia(files.slice(0, count), { ...context, url, mode: readString(params, "mode", context.mode || "") });
  return { files: annotatedFiles, stderr: result.stderr, outDir };
}

async function downloadRankingMedia(config, items = [], params = {}, context = {}) {
  const requested = Math.max(0, Math.min(MAX_DOWNLOAD_COUNT, Math.trunc(Number(context.downloadCount || 0))));
  if (requested <= 0) return { files: [], diagnostics: { downloadConcurrency: 0, attemptedWorks: 0, failedWorks: 0, downloadMs: 0, errors: [] } };
  const concurrency = rankingDownloadConcurrency(config, params);
  const candidates = (Array.isArray(items) ? items : []).filter((item) => item?.id);
  const startedAt = Date.now();
  const errors = [];
  const outputs = [];
  const downloadOne = async (item, index) => {
    try {
      const download = await downloadWithGalleryDl(config, item.url || `https://www.pixiv.net/artworks/${item.id}`, {
        ...params,
        downloadCount: 1,
        count: 1,
        range: "1-1"
      }, {
        adult: context.adult === true || isAdultPixivItem(item, { url: context.sourceUrl, mode: context.mode }),
        mode: context.mode,
        sourceUrl: context.sourceUrl
      });
      const file = download.files[0] ? {
        ...download.files[0],
        sourceRank: item.rank || index + 1,
        sourceIllustId: item.id,
        sourceTitle: item.title || ""
      } : null;
      return { item, file, stderr: download.stderr || "" };
    } catch (error) {
      errors.push({
        id: item.id,
        rank: item.rank || index + 1,
        error: clip(error instanceof Error ? error.message : String(error), 240)
      });
      return { item, file: null, stderr: "" };
    }
  };
  let cursor = 0;
  let collected = 0;
  while (cursor < candidates.length && collected < requested) {
    const remaining = requested - collected;
    const batch = candidates.slice(cursor, cursor + remaining);
    const batchStart = cursor;
    cursor += batch.length;
    const batchOutputs = await mapLimit(batch, Math.min(concurrency, batch.length || 1), (item, index) => downloadOne(item, batchStart + index));
    outputs.push(...batchOutputs);
    collected += batchOutputs.filter((entry) => entry?.file).length;
  }
  const files = outputs.map((entry) => entry?.file).filter(Boolean).slice(0, requested);
  return {
    files,
    diagnostics: {
      downloadConcurrency: concurrency,
      attemptedWorks: outputs.length,
      failedWorks: errors.length,
      downloadMs: Date.now() - startedAt,
      errors
    }
  };
}

async function ranking(config, params = {}) {
  const count = readNumber(params, "count", 10, 1, MAX_COUNT);
  const downloadCount = readNumber(params, "downloadCount", 0, 0, Math.min(MAX_DOWNLOAD_COUNT, count));
  const url = rankingUrl(params);
  const mode = rankingMode(readString(params, "mode", "daily"));
  const metadataStartedAt = Date.now();
  const metadata = await metadataList(config, url, count);
  const metadataMs = Date.now() - metadataStartedAt;
  const sensitiveSource = hasAdultPixivItems(metadata.items, { url, mode });
  let media = [];
  let downloadDiagnostics = { downloadConcurrency: 0, attemptedWorks: 0, failedWorks: 0, downloadMs: 0, errors: [] };
  if (downloadCount > 0) {
    const downloaded = await downloadRankingMedia(config, metadata.items, params, {
      downloadCount,
      adult: sensitiveSource,
      mode,
      sourceUrl: url
    });
    media = downloaded.files;
    downloadDiagnostics = downloaded.diagnostics;
  }
  return {
    url,
    mode,
    date: rankingDate(readString(params, "date")),
    items: metadata.items,
    media,
    sensitiveMedia: hasSensitiveMediaFiles(media),
    rawCount: metadata.rawCount,
    skippedBlocked: metadata.skippedBlocked,
    stderr: metadata.stderr,
    diagnostics: {
      metadataMs,
      ...downloadDiagnostics
    }
  };
}

async function detail(config, params = {}) {
  const url = artworkUrl(params);
  const count = readNumber(params, "count", 1, 1, MAX_COUNT);
  const metadata = await metadataList(config, url, count);
  return { url, items: metadata.items, rawCount: metadata.rawCount, skippedBlocked: metadata.skippedBlocked, blocked: metadata.rawCount > 0 && metadata.items.length === 0 && metadata.skippedBlocked > 0, stderr: metadata.stderr };
}

async function download(config, params = {}) {
  const url = readString(params, "url") || readString(params, "artworkUrl")
    ? normalizePixivUrl(readString(params, "url") || readString(params, "artworkUrl"))
    : artworkUrl(params);
  const metadata = await metadataList(config, url, readNumber(params, "count", 1, 1, MAX_COUNT));
  if (metadata.rawCount > 0 && metadata.items.length === 0 && metadata.skippedBlocked > 0) {
    return { url, items: [], media: [], rawCount: metadata.rawCount, skippedBlocked: metadata.skippedBlocked, blocked: true, stderr: metadata.stderr };
  }
  if (metadata.items.length === 0) {
    return { url, items: [], media: [], rawCount: metadata.rawCount, skippedBlocked: metadata.skippedBlocked, blocked: false, stderr: metadata.stderr };
  }
  const sensitiveSource = hasAdultPixivItems(metadata.items, { url });
  const media = await downloadWithGalleryDl(config, url, params, { adult: sensitiveSource });
  return { url, items: metadata.items, media: media.files, sensitiveMedia: hasSensitiveMediaFiles(media.files), rawCount: metadata.rawCount, skippedBlocked: metadata.skippedBlocked, blocked: false, stderr: media.stderr };
}

async function recent(config = {}, params = {}) {
  const count = readNumber(params, "count", 10, 1, 30);
  const root = mediaRoot(config);
  const files = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && ALLOWED_MEDIA_EXTS.has(path.extname(entry.name).toLowerCase())) {
        const stat = await fs.stat(full).catch(() => null);
        if (stat?.isFile()) files.push({ path: full, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await walk(root);
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const annotatedFiles = await annotateDownloadedMedia(files.slice(0, count));
  return { files: annotatedFiles, sensitiveMedia: hasSensitiveMediaFiles(annotatedFiles) };
}

async function authCheck(config = {}) {
  const url = rankingUrl({ mode: "daily" });
  const result = await metadataList(config, url, 5);
  return {
    ok: result.items.length > 0,
    tokenFile: secretPath(config),
    sample: result.items[0] || null,
    skippedBlocked: result.skippedBlocked || 0,
    stderr: result.stderr
  };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatSize(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function imageMimeForPath(filePath) {
  return IMAGE_MIME_BY_EXT.get(path.extname(String(filePath || "")).toLowerCase()) || "image/jpeg";
}

async function loadSharpMaybe() {
  try {
    const mod = await import("sharp");
    return mod.default || mod;
  } catch {
    return null;
  }
}

async function buildVisionImageBlock(file) {
  if (!file?.path) return null;
  const ext = path.extname(file.path).toLowerCase();
  if (!VISION_IMAGE_EXTS.has(ext)) return null;
  try {
    const stat = await fs.stat(file.path);
    if (!stat.isFile() || stat.size <= 0) return null;
    if (stat.size <= MAX_VISION_IMAGE_BYTES) {
      const data = await fs.readFile(file.path);
      return { type: "image", data: data.toString("base64"), mimeType: imageMimeForPath(file.path), fileName: path.basename(file.path) };
    }
    const sharp = await loadSharpMaybe();
    if (!sharp) return null;
    const data = await sharp(file.path)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    if (data.length <= 0 || data.length > MAX_VISION_IMAGE_BYTES) return null;
    return { type: "image", data: data.toString("base64"), mimeType: "image/jpeg", fileName: `${path.parse(file.path).name}.preview.jpg` };
  } catch {
    return null;
  }
}

async function buildVisionImageBlocks(files = [], limit = DEFAULT_VISION_IMAGE_COUNT) {
  const maxBlocks = Math.max(0, Math.min(MAX_VISION_IMAGE_COUNT, Math.trunc(Number(limit) || 0)));
  const blocks = [];
  if (maxBlocks <= 0) return blocks;
  const list = Array.isArray(files) ? files : [];
  for (let index = 0; index < list.length && blocks.length < maxBlocks; index += maxBlocks) {
    const batch = list.slice(index, index + maxBlocks);
    const built = await Promise.all(batch.map((file) => buildVisionImageBlock(file)));
    for (const block of built) {
      if (block) blocks.push(block);
      if (blocks.length >= maxBlocks) break;
    }
  }
  return blocks;
}

function formatItem(item, index) {
  const rank = item.rank ? `#${item.rank}` : `${index + 1}.`;
  const parts = [
    `${rank} id=${item.id || "unknown"}`,
    `title=${clip(item.title, 90) || "(untitled)"}`,
    `artist=${clip(item.author, 70) || "unknown"}`,
    item.bookmarkCount ? `bookmarks=${item.bookmarkCount}` : "",
    item.viewCount ? `views=${item.viewCount}` : "",
    item.pageCount ? `pages=${item.pageCount}` : "",
    item.url ? `url=${item.url}` : ""
  ].filter(Boolean);
  const tags = item.tags?.length ? `tags=${item.tags.slice(0, 8).join(", ")}` : "";
  return [parts.join(" | "), tags].filter(Boolean).join("\n");
}

function formatMedia(files = [], options = {}) {
  return files.flatMap((file, index) => [
    `media${index + 1}: size=${formatSize(file.sizeBytes)}`,
    `${options.sensitive === true || file?.sensitiveMedia === true ? "SPOILER_MEDIA" : "MEDIA"}: \`${file.path}\``
  ]);
}

function formatRanking(result) {
  const lines = [
    `PIXIV_RESOURCE ranking ok mode=${result.mode} date=${result.date || "latest"} results=${result.items.length} media=${result.media.length}`,
    `source: ${result.url}`
  ];
  if (result.diagnostics?.attemptedWorks || result.diagnostics?.downloadMs) {
    lines.push(`download_diag: concurrency=${result.diagnostics.downloadConcurrency || 0} attempted=${result.diagnostics.attemptedWorks || 0} failed=${result.diagnostics.failedWorks || 0} metadataMs=${result.diagnostics.metadataMs || 0} downloadMs=${result.diagnostics.downloadMs || 0}`);
  }
  if (result.skippedBlocked) lines.push(`safety_filter: skipped=${result.skippedBlocked}`);
  result.items.forEach((item, index) => lines.push(formatItem(item, index)));
  lines.push(...formatMedia(result.media, { sensitive: result.sensitiveMedia === true }));
  return lines.join("\n");
}

function formatDetail(result) {
  const lines = [`PIXIV_RESOURCE detail ok results=${result.items.length}`, `source: ${result.url}`];
  if (result.skippedBlocked) lines.push(`safety_filter: skipped=${result.skippedBlocked}`);
  result.items.forEach((item, index) => lines.push(formatItem(item, index)));
  return lines.join("\n");
}

function formatDownload(result) {
  const lines = [
    `PIXIV_RESOURCE download ${result.blocked ? "blocked" : "ok"} results=${result.items.length} media=${result.media.length}`,
    `source: ${result.url}`
  ];
  if (result.skippedBlocked) lines.push(`safety_filter: skipped=${result.skippedBlocked}`);
  result.items.forEach((item, index) => lines.push(formatItem(item, index)));
  lines.push(...formatMedia(result.media, { sensitive: result.sensitiveMedia === true }));
  return lines.join("\n");
}

function formatRecent(result) {
  const lines = [`PIXIV_RESOURCE recent ok files=${result.files.length}`];
  lines.push(...formatMedia(result.files, { sensitive: result.sensitiveMedia === true }));
  return lines.join("\n");
}

function formatAuthCheck(result) {
  return [
    `PIXIV_RESOURCE auth_check ${result.ok ? "ok" : "empty"}`,
    `tokenFile: ${result.tokenFile}`,
    result.sample ? formatItem(result.sample, 0) : "sample: none"
  ].join("\n");
}

async function runAction(config, params = {}) {
  const action = readString(params, "action", "ranking").toLowerCase();
  if (action === "ranking" || action === "rank") return { action: "ranking", result: await ranking(config, params) };
  if (action === "detail" || action === "show") return { action: "detail", result: await detail(config, params) };
  if (action === "download") return { action: "download", result: await download(config, params) };
  if (action === "recent") return { action: "recent", result: await recent(config, params) };
  if (action === "auth_check" || action === "auth") return { action: "auth_check", result: await authCheck(config) };
  throw new Error("action must be ranking, detail, download, recent, or auth_check");
}

function formatResult(action, result) {
  if (action === "ranking") return formatRanking(result);
  if (action === "detail") return formatDetail(result);
  if (action === "download") return formatDownload(result);
  if (action === "recent") return formatRecent(result);
  if (action === "auth_check") return formatAuthCheck(result);
  return `PIXIV_RESOURCE ${action} ok`;
}

function mediaUrlsFor(action, result) {
  if (action === "ranking" || action === "download") return result.media.map((file) => file.path);
  if (action === "recent") return result.files.map((file) => file.path);
  return [];
}

function mediaFilesFor(action, result) {
  if (action === "ranking" || action === "download") return result.media;
  if (action === "recent") return result.files;
  return [];
}

function resultHasSensitiveMedia(action, result) {
  if (result?.sensitiveMedia === true) return true;
  if (action === "ranking" || action === "download") return hasSensitiveMediaFiles(result?.media);
  if (action === "recent") return hasSensitiveMediaFiles(result?.files);
  return false;
}

const pixivResourceTool = {
  name: TOOL_NAME,
  label: "Pixiv Resource",
  description: "Read-only Pixiv ranking/detail/download helper backed by gallery-dl and a Pixiv refresh token.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["ranking", "rank", "detail", "show", "download", "recent", "auth_check", "auth"], description: "Pixiv operation." },
      mode: { type: "string", description: "Pixiv web ranking mode. Examples: daily, weekly, monthly, male, female, original, rookie, daily_ai, daily_r18, male_r18, female_r18, weekly_r18, r18g. Other pixiv-supported mode strings are passed through." },
      date: { type: "string", description: "Optional ranking date, YYYY-MM-DD or YYYYMMDD." },
      content: { type: "string", description: "Optional Pixiv ranking content parameter, such as illust or manga." },
      count: { type: "number", description: `Metadata/result count, max ${MAX_COUNT}.` },
      downloadCount: { type: "number", description: `Download top N works/images for ranking or URL, max ${MAX_DOWNLOAD_COUNT}.` },
      illustId: { type: "number", description: "Pixiv illustration/artwork ID." },
      postId: { type: "number", description: "Alias for illustId." },
      id: { type: "number", description: "Alias for illustId." },
      url: { type: "string", description: "Pixiv ranking/artwork/search/user URL." },
      artworkUrl: { type: "string", description: "Alias for url." },
      range: { type: "string", description: "Optional gallery-dl file range for downloads, e.g. 1-3. Use sparingly." },
      downloadConcurrency: { type: "number", description: `Ranking media download concurrency, 1-${MAX_RANKING_DOWNLOAD_CONCURRENCY}. Default ${DEFAULT_RANKING_DOWNLOAD_CONCURRENCY}.` },
      visionCount: { type: "number", description: `Inline image context count, 0-${MAX_VISION_IMAGE_COUNT}. Default ${DEFAULT_VISION_IMAGE_COUNT}.` }
    }
  },
  async execute(_toolCallId, params = {}) {
    try {
      const config = pixivResourceTool.config || {};
      const { action, result } = await runAction(config, params);
      const status = result?.blocked ? "blocked" : "ok";
      const sensitiveMedia = resultHasSensitiveMedia(action, result);
      const text = formatResult(action, result);
      const visionLimit = visionImageCount(config, params);
      const visionImages = await buildVisionImageBlocks(mediaFilesFor(action, result), visionLimit);
      return {
        content: [{ type: "text", text }, ...visionImages],
        details: {
          status,
          action,
          result,
          media: {
            mediaUrls: mediaUrlsFor(action, result),
            trustedLocalMedia: true,
            outbound: false,
            visionContextImages: visionImages.length,
            visionContextLimit: visionLimit,
            ...(sensitiveMedia ? { sensitiveMedia: true } : {})
          }
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `PIXIV_RESOURCE error: ${clip(message, 800)}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

export const __testing = {
  rankingMode,
  rankingDate,
  rankingUrl,
  normalizePixivUrl,
  parseJsonPayload,
  collectGalleryDlEvents,
  parseItemsFromJson,
  publicItem,
  normalizeSafetyTag,
  isAdultPixivMode,
  isAdultPixivUrl,
  isAdultPixivItem,
  isAdultPixivContext,
  hasAdultPixivItems,
  hasBlockedSafetyTag,
  filterSafetyItems,
  annotateDownloadedMedia,
  hasSensitiveMediaFiles,
  rankingDownloadConcurrency,
  visionImageCount,
  mapLimit,
  downloadRankingMedia,
  buildVisionImageBlocks,
  listDownloadedMedia,
  secretPath,
  storeRoot,
  mediaRoot,
  readRefreshToken,
  runGalleryDl,
  ranking,
  detail,
  download,
  recent,
  setSpawnForTests(fn) {
    spawnImpl = fn;
  },
  resetForTests() {
    spawnImpl = spawn;
  }
};

export default {
  id: "imagebot-pixiv-resource",
  name: "Imagebot Pixiv Resource",
  description: "Read-only Pixiv rankings and media downloads via gallery-dl.",
  register(api) {
    pixivResourceTool.config = api.config || {};
    api.registerTool(pixivResourceTool, { name: TOOL_NAME });
  }
};

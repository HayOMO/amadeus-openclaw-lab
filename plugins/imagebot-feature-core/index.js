import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { backgroundToolParameters, enqueueBackgroundTool, shouldRunInBackground } from "../imagebot-background-jobs/index.js";

const FEATURE_CATALOG_TOOL = "feature_catalog";
const FEATURE_ACTION_TOOL = "feature_action";
const GACHA_ARCHIVE_TOOL = "gacha_archive";
const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;
const MAX_TEXT = 5000;
const DANBOORU_ENDPOINT = "https://safebooru.donmai.us/posts.json";
const DANBOORU_POST_BASE = "https://safebooru.donmai.us/posts";
const DANBOORU_TIMEOUT_MS = 20000;
const DANBOORU_RETRIES = 1;
const DANBOORU_USER_AGENT = "AmaduseImagebot/0.1 (+private Telegram bot)";
const DEFAULT_DANBOORU_SAFETY_BLOCKED_TAGS = [];
const GACHA_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
const ARCHIVE_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const ARCHIVE_MIME = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"]
]);

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginDir, "..", "..");

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

function readNumber(params, key, fallback, min, max) {
  const raw = isRecord(params) ? params[key] : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function readCount(params, fallback = DEFAULT_COUNT, max = MAX_COUNT) {
  return readNumber(params, "count", fallback, 1, max);
}

function readObject(params, key) {
  const value = isRecord(params) ? params[key] : undefined;
  return isRecord(value) ? value : {};
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[telegram-token-redacted]")
    .replace(/https:\/\/api\.telegram\.org\/bot[^\s<>"']+/gi, "https://api.telegram.org/[telegram-token-redacted]")
    .replace(/[A-Za-z]:\\[^\s<>"']+/g, "[local-path-redacted]")
    .replace(/\\\\[^\\\s]+\\[^\s<>"']+/g, "[unc-path-redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip-redacted]")
    .replace(/[A-Za-z0-9_][A-Za-z0-9_-]{63,}/g, "[long-token-redacted]")
    .replace(/\r\n/g, "\n")
    .trim();
}

function clip(value, max = 600) {
  const text = sanitizeText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function hash(value, len = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function storeRoot(config) {
  const configured = String(config?.storeDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "feature-core"));
}

function featuresRoot(config) {
  const configured = String(config?.featuresDir || "").trim();
  return path.resolve(configured || path.join(repoRoot, "features"));
}

function featureStatePath(config, featureId) {
  return path.join(storeRoot(config), "features", safeId(featureId), "state.json");
}

function cooldownPath(config) {
  return path.join(storeRoot(config), "cooldowns.json");
}

function auditLogPath(config) {
  return path.join(storeRoot(config), "feature-events.jsonl");
}

function gachaDrawEventsPath(config) {
  return path.join(storeRoot(config), "gacha-draw-events.jsonl");
}

function gachaArchiveConfig(config) {
  if (isRecord(config?.gachaArchive)) return config.gachaArchive;
  if (isRecord(config) && (
    config.channelChatId !== undefined
    || config.channelId !== undefined
    || config.localDir !== undefined
    || config.sendDir !== undefined
    || config.tokenFile !== undefined
  )) return config;
  return gachaArchiveConfigFromOpenClawConfig();
}

let cachedOpenClawGachaArchiveConfig;

function gachaArchiveConfigFromOpenClawConfig() {
  if (cachedOpenClawGachaArchiveConfig !== undefined) return cachedOpenClawGachaArchiveConfig;
  cachedOpenClawGachaArchiveConfig = {};
  try {
    const configPath = path.join(homeDir(), ".openclaw", "openclaw.json");
    const rootConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const pluginConfig = rootConfig?.plugins?.entries?.["imagebot-feature-core"]?.config;
    if (isRecord(pluginConfig?.gachaArchive)) cachedOpenClawGachaArchiveConfig = pluginConfig.gachaArchive;
  } catch {
    cachedOpenClawGachaArchiveConfig = {};
  }
  return cachedOpenClawGachaArchiveConfig;
}

function gachaRequestLocksDir(config) {
  return path.join(storeRoot(config), "gacha-request-locks");
}

function gachaRequestLockPath(config, requestKey) {
  return path.join(gachaRequestLocksDir(config), `${archiveSafeName(requestKey, "request")}.lock.json`);
}

function gachaArchiveRoot(config) {
  const archiveConfig = gachaArchiveConfig(config);
  const configured = String(archiveConfig.localDir || "").trim();
  return path.resolve(configured || path.join(storeRoot(config), "gacha-archive"));
}

function gachaArchiveSendRoot(config) {
  const archiveConfig = gachaArchiveConfig(config);
  const configured = String(archiveConfig.sendDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "media", "gacha-archive"));
}

function gachaArchiveIndexPath(config) {
  return path.join(gachaArchiveRoot(config), "gacha-archive-index.jsonl");
}

const GACHA_ARCHIVE_TELEGRAM_RETRY_DELAYS_MS = [5000, 10000, 15000];

function nowIso() {
  return new Date().toISOString();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function safeId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").slice(0, 80);
}

function archiveSafeName(value, fallback = "gacha") {
  const raw = String(value || fallback).trim().replace(/\.[a-z0-9]{1,8}$/i, "");
  const cleaned = raw
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function normalizedIdentity(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("tg:") ? raw : `tg:${raw}`;
}

function isInside(root, target) {
  const rootNorm = path.resolve(root).toLowerCase();
  const targetNorm = path.resolve(target).toLowerCase();
  return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + path.sep);
}

function readMediaPath(value) {
  const raw = String(value || "").trim();
  const mediaMatch = raw.match(/MEDIA:\s*`?([^`\r\n]+)`?/i);
  const unwrapped = mediaMatch ? mediaMatch[1] : raw.replace(/^`+|`+$/g, "");
  if (/^file:\/\//i.test(unwrapped)) return decodeURIComponent(unwrapped.replace(/^file:\/\//i, ""));
  return unwrapped;
}

function allowedArchiveMediaRoots(config) {
  const home = homeDir();
  const defaults = [
    path.join(home, ".openclaw", "media", "inbound"),
    path.join(home, ".openclaw", "media", "tool-image-generation"),
    path.join(home, ".openclaw", "media", "downloaded"),
    path.join(home, ".openclaw", "media", "gallery-resend"),
    path.join(home, ".openclaw", "media", "practical-tools"),
    gachaArchiveSendRoot(config),
    gachaArchiveRoot(config)
  ];
  const archiveConfig = gachaArchiveConfig(config);
  const extra = Array.isArray(archiveConfig.allowedMediaRoots) ? archiveConfig.allowedMediaRoots : [];
  return [...defaults, ...extra].map((entry) => path.resolve(String(entry))).filter(Boolean);
}

async function resolveArchiveMediaInput(config, raw) {
  const input = readMediaPath(raw);
  if (!input) throw new Error("media path is required");
  if (/^https?:\/\//i.test(input)) throw new Error("gacha_archive accepts bot-local media paths, not URLs");
  const resolved = path.resolve(input);
  if (!allowedArchiveMediaRoots(config).some((root) => isInside(root, resolved))) {
    throw new Error("media path is outside allowed bot media directories");
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("media path is not a file");
  if (stat.size > GACHA_ARCHIVE_MAX_BYTES) throw new Error("media file is larger than 50 MB");
  const ext = path.extname(resolved).toLowerCase();
  if (!ARCHIVE_IMAGE_EXTS.has(ext)) throw new Error(`unsupported media type: ${ext || "unknown"}`);
  return { path: resolved, stat, ext, mimeType: ARCHIVE_MIME.get(ext) || "application/octet-stream" };
}

async function sha256File(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function publicFeature(feature) {
  return {
    id: String(feature?.id || ""),
    title: String(feature?.title || feature?.id || ""),
    version: String(feature?.version || ""),
    enabled: feature?.enabled !== false,
    category: String(feature?.category || "misc"),
    tags: Array.isArray(feature?.tags) ? feature.tags.map(String) : [],
    triggers: Array.isArray(feature?.triggers) ? feature.triggers.map(String) : [],
    description: String(feature?.description || ""),
    actions: Array.isArray(feature?.actions) ? feature.actions.map(publicAction) : [],
    notes: Array.isArray(feature?.notes) ? feature.notes.map(String) : []
  };
}

function publicAction(action) {
  return {
    id: String(action?.id || ""),
    description: String(action?.description || ""),
    risk: String(action?.risk || "read"),
    permission: String(action?.permission || "member"),
    cooldown: isRecord(action?.cooldown) ? action.cooldown : {},
    modelWrap: action?.modelWrap !== false
  };
}

function ok(toolName, lines, details = {}) {
  return {
    content: [{ type: "text", text: lines.filter(Boolean).join("\n").slice(0, MAX_TEXT) }],
    details: { status: "ok", ...details }
  };
}

function compactFeatureResultForText(result) {
  if (!isRecord(result)) return result;
  if (!String(result.kind || "").startsWith("waifu_gacha")) return result;
  const albumMedia = Array.isArray(result.albumMedia) ? result.albumMedia : [];
  const compact = {
    kind: result.kind,
    batchId: result.batchId || "",
    today: result.today || "",
    count: result.count || (result.draw ? 1 : 0),
    alreadyDrawn: result.alreadyDrawn,
    duplicateRequest: result.duplicateRequest,
    suppressFinalReply: result.suppressFinalReply,
    requestLimit: result.requestLimit,
    replyText: result.replyText || "",
    archive: result.archive ? {
      status: result.archive.status,
      ok: result.archive.ok,
      failed: result.archive.failed,
      skipped: result.archive.skipped,
      channelOk: result.archive.channelOk
    } : undefined,
    albumMedia,
    resultImages: !albumMedia.length && Array.isArray(result.resultImages)
      ? result.resultImages.map((image) => ({
        index: image.index,
        name: image.name,
        rarity: image.rarity,
        postId: image.postId,
        score: image.score,
        pageUrl: image.pageUrl,
        imageUrl: image.imageUrl
      }))
      : undefined,
    results: !albumMedia.length && Array.isArray(result.results)
      ? result.results.map((draw, index) => ({
        index: index + 1,
        name: draw?.card?.name || "",
        rarity: draw?.card?.rarity || "",
        postId: draw?.image?.postId || null,
        score: draw?.image?.score ?? null,
        isNew: draw?.isNew,
        duplicateCount: draw?.duplicateCount
      }))
      : undefined
  };
  return Object.fromEntries(Object.entries(compact).filter(([, value]) => value !== undefined && value !== ""));
}

function fail(toolName, error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `${toolName.toUpperCase()} error: ${clip(message, 500)}` }],
    details: { status: "failed", error: message }
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomSeed().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EEXIST"].includes(error?.code)) break;
      if (attempt >= 2) await fs.rm(filePath, { force: true }).catch(() => {});
      await wait(20 * (attempt + 1));
    }
  }
  await fs.unlink(tmp).catch(() => {});
  throw lastError;
}

async function appendJsonLine(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function listFeatureFiles(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

async function loadFeatures(config) {
  const files = await listFeatureFiles(featuresRoot(config));
  const features = [];
  for (const file of files) {
    const raw = await readJson(file, null);
    if (!isRecord(raw) || !raw.id) continue;
    features.push({ ...raw, _sourceFile: file });
  }
  return features.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function findFeature(features, id) {
  const normalized = safeId(id);
  return features.find((feature) => safeId(feature.id) === normalized) || null;
}

function findAction(feature, id) {
  const normalized = safeId(id || "checkin");
  return (Array.isArray(feature?.actions) ? feature.actions : []).find((action) => safeId(action.id) === normalized) || null;
}

function extractTerms(text) {
  const terms = new Set();
  const source = String(text || "").toLowerCase();
  for (const match of source.matchAll(/[a-z0-9_.-]{2,64}/gi)) terms.add(match[0]);
  for (const match of source.matchAll(/[\u4e00-\u9fff]{2,14}/g)) {
    const seq = match[0];
    for (let size = Math.min(4, seq.length); size >= 2; size--) {
      for (let i = 0; i <= seq.length - size; i++) terms.add(seq.slice(i, i + size));
    }
  }
  return [...terms].slice(0, 60);
}

function scoreText(haystack, terms) {
  const text = String(haystack || "").toLowerCase();
  let score = 0;
  const hits = [];
  for (const term of terms) {
    const count = text.split(term).length - 1;
    if (count > 0) {
      score += count * (4 + Math.min(term.length, 12));
      hits.push(term);
    }
  }
  return { score, hits: [...new Set(hits)].slice(0, 10) };
}

function routeFeatures(features, query, count) {
  const terms = extractTerms(query);
  const scored = features.map((feature) => {
    const haystack = [
      feature.id,
      feature.title,
      feature.description,
      feature.category,
      ...(feature.tags || []),
      ...(feature.triggers || []),
      ...(feature.notes || []),
      ...(feature.actions || []).flatMap((action) => [action.id, action.description])
    ].join("\n");
    const scored = scoreText(haystack, terms);
    return { feature: publicFeature(feature), score: scored.score, hits: scored.hits };
  }).sort((a, b) => b.score - a.score || a.feature.id.localeCompare(b.feature.id));
  const positive = scored.filter((entry) => entry.score > 0);
  return (positive.length ? positive : scored).slice(0, count);
}

function configuredIds(config, key) {
  const value = config?.[key];
  if (!Array.isArray(value)) return new Set();
  return new Set(value.map(normalizedIdentity).filter(Boolean));
}

function checkPermission(config, action, identity) {
  const permission = String(action?.permission || "member").toLowerCase();
  if (permission === "public" || permission === "member") return;
  const userId = normalizedIdentity(identity.userId);
  const owners = configuredIds(config, "ownerIds");
  const trusted = configuredIds(config, "trustedIds");
  if (permission === "trusted" && (trusted.has(userId) || owners.has(userId))) return;
  if (permission === "owner" && owners.has(userId)) return;
  throw new Error(`feature action requires ${permission} permission`);
}

function cooldownKey(feature, action, identity) {
  const scope = String(action?.cooldown?.scope || "user").toLowerCase();
  if (scope === "chat") return `${feature.id}:${action.id}:chat:${identity.chatId || "unknown"}`;
  if (scope === "global") return `${feature.id}:${action.id}:global`;
  return `${feature.id}:${action.id}:user:${identity.userId || "unknown"}`;
}

async function checkCooldown(config, feature, action, identity) {
  const seconds = Number(action?.cooldown?.seconds || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return { ok: true };
  const key = cooldownKey(feature, action, identity);
  const state = await readJson(cooldownPath(config), { version: 1, entries: {} });
  const previous = Number(state.entries?.[key] || 0);
  const now = Date.now();
  const waitMs = previous + seconds * 1000 - now;
  if (waitMs > 0) {
    return { ok: false, waitSeconds: Math.ceil(waitMs / 1000) };
  }
  state.version = 1;
  state.entries = isRecord(state.entries) ? state.entries : {};
  state.entries[key] = now;
  const cutoff = now - 24 * 60 * 60 * 1000;
  for (const [entryKey, t] of Object.entries(state.entries)) {
    if (Number(t) < cutoff) delete state.entries[entryKey];
  }
  await writeJsonAtomic(cooldownPath(config), state);
  return { ok: true };
}

function dateKey(config, date = new Date()) {
  const offset = Number.isFinite(Number(config?.timezoneOffsetMinutes)) ? Number(config.timezoneOffsetMinutes) : 480;
  const shifted = new Date(date.getTime() + offset * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function yesterdayKey(config, date = new Date()) {
  return dateKey(config, new Date(date.getTime() - 24 * 60 * 60 * 1000));
}

function deterministicPoints(userId, day) {
  const value = parseInt(hash(`${userId}:${day}`, 8), 16);
  return 5 + (value % 11);
}

function deterministicMood(userId, day) {
  const moods = [
    "stable",
    "sharp",
    "sleepy",
    "overclocked",
    "suspiciously functional",
    "quietly chaotic",
    "research-grade",
    "low-latency"
  ];
  const value = parseInt(hash(`mood:${userId}:${day}`, 8), 16);
  return moods[value % moods.length];
}

function seededPick(list, seed, fallback = "") {
  const values = Array.isArray(list) ? list.filter((item) => item !== undefined && item !== null && String(item).trim()) : [];
  if (!values.length) return fallback;
  const index = Math.floor(seededUnit(seed) * values.length) % values.length;
  return values[index];
}

function publicFortuneRecord(record) {
  return {
    userId: record.userId,
    userName: record.userName,
    displayName: record.displayName,
    totalDraws: record.totalDraws || 0,
    scoreSum: record.scoreSum || 0,
    averageScore: record.totalDraws ? Math.round((Number(record.scoreSum || 0) / Number(record.totalDraws || 1)) * 10) / 10 : 0,
    bestScore: record.bestScore || 0,
    lastDate: record.lastDate || "",
    lastTitle: record.lastTitle || ""
  };
}

function dailyFortuneFor(userId, today) {
  const score = 1 + Math.floor(seededUnit(`fortune:${userId}:${today}:score`) * 100);
  const stability = 1 + Math.floor(seededUnit(`fortune:${userId}:${today}:stability`) * 100);
  const title = seededPick([
    "low-latency experiment",
    "quiet overfit",
    "controlled chaos",
    "suspiciously lucky branch",
    "coffee-stained hypothesis",
    "unexpected convergence",
    "minor timeline drift",
    "statistically cute anomaly"
  ], `fortune:${userId}:${today}:title`, "daily experiment");
  const keyword = seededPick([
    "prompt hygiene",
    "cache hit",
    "source control",
    "visual evidence",
    "group entropy",
    "image prior",
    "thread routing",
    "model patience"
  ], `fortune:${userId}:${today}:keyword`, "experiment");
  const caution = seededPick([
    "do not trust the first sample",
    "check the hidden variable",
    "avoid recursive arguments",
    "save the good screenshot",
    "do not anger the queue",
    "keep one clean reference image"
  ], `fortune:${userId}:${today}:caution`, "check assumptions");
  return {
    date: today,
    title,
    score,
    stability,
    keyword,
    caution,
    seed: hash(`${userId}:${today}:fortune`, 10)
  };
}

function formatDailyFortuneText(result, user) {
  return [
    `${user.displayName || user.userId} today's lab omen`,
    `score ${result.score}/100 | stability ${result.stability}/100`,
    `theme: ${result.title}`,
    `keyword: ${result.keyword}`,
    `note: ${result.caution}`
  ].join("\n");
}

function formatDailyFortuneLeaderboardText(users) {
  const lines = ["daily experiment board"];
  users.forEach((user, index) => {
    lines.push(`${index + 1}. ${user.displayName || user.userName || user.userId}: avg ${user.averageScore} | best ${user.bestScore} | draws ${user.totalDraws}`);
  });
  return lines.join("\n");
}

async function runDailyFortune(config, feature, action, identity, payload) {
  const filePath = featureStatePath(config, feature.id);
  const state = await readJson(filePath, { version: 1, users: {}, days: {} });
  state.version = 1;
  state.users = isRecord(state.users) ? state.users : {};
  state.days = isRecord(state.days) ? state.days : {};

  if (action.id === "leaderboard") {
    const users = Object.values(state.users).filter(isRecord).map(publicFortuneRecord)
      .sort((a, b) => b.averageScore - a.averageScore || b.bestScore - a.bestScore || b.totalDraws - a.totalDraws);
    const count = readNumber({ count: payload.count }, "count", 10, 1, 20);
    const selected = users.slice(0, count);
    return {
      kind: "daily_fortune_leaderboard",
      count: selected.length,
      users: selected,
      replyText: formatDailyFortuneLeaderboardText(selected),
      modelInstruction: "Use replyText as factual daily-fortune leaderboard data. Natural comments are fine; do not change scores."
    };
  }

  const userId = normalizedIdentity(identity.userId || payload.userId);
  if (!userId) throw new Error("daily fortune requires userId");
  const userName = String(identity.userName || payload.userName || "").trim();
  const displayName = String(identity.displayName || payload.displayName || userName || userId).trim();
  const today = dateKey(config);
  const current = isRecord(state.users[userId]) ? state.users[userId] : {
    userId,
    userName,
    displayName,
    totalDraws: 0,
    scoreSum: 0,
    bestScore: 0,
    history: []
  };
  current.userName = userName || current.userName || "";
  current.displayName = displayName || current.displayName || current.userName || userId;
  current.history = Array.isArray(current.history) ? current.history : [];

  if (action.id === "status") {
    return {
      kind: "daily_fortune_status",
      today,
      alreadyDrawn: current.lastDate === today,
      user: publicFortuneRecord(current),
      lastResult: current.lastResult || null,
      replyText: current.lastResult ? formatDailyFortuneText(current.lastResult, current) : `${current.displayName || current.userId} has no daily fortune yet.`
    };
  }

  if (current.lastDate === today && isRecord(current.lastResult)) {
    return {
      kind: "daily_fortune_result",
      today,
      alreadyDrawn: true,
      result: current.lastResult,
      user: publicFortuneRecord(current),
      replyText: formatDailyFortuneText(current.lastResult, current),
      modelInstruction: "This is today's already-recorded fortune. Preserve the exact score/theme."
    };
  }

  const result = dailyFortuneFor(userId, today);
  current.lastDate = today;
  current.lastTitle = result.title;
  current.lastResult = result;
  current.totalDraws = Number(current.totalDraws || 0) + 1;
  current.scoreSum = Number(current.scoreSum || 0) + result.score;
  current.bestScore = Math.max(Number(current.bestScore || 0), result.score);
  current.history.push({ t: nowIso(), ...result });
  current.history = current.history.slice(-120);
  state.users[userId] = current;
  state.days[today] = isRecord(state.days[today]) ? state.days[today] : { users: [], count: 0, scoreSum: 0 };
  if (!state.days[today].users.includes(userId)) state.days[today].users.push(userId);
  state.days[today].count = state.days[today].users.length;
  state.days[today].scoreSum = Number(state.days[today].scoreSum || 0) + result.score;
  state.updatedAt = nowIso();
  await writeJsonAtomic(filePath, state);
  return {
    kind: "daily_fortune_result",
    today,
    alreadyDrawn: false,
    result,
    user: publicFortuneRecord(current),
    groupTodayCount: state.days[today].count,
    replyText: formatDailyFortuneText(result, current),
    modelInstruction: "Use replyText as factual daily-fortune data. Add a short in-character reaction if useful; do not change score/theme."
  };
}

function seededUnit(seed) {
  const value = parseInt(hash(seed, 12), 16);
  return value / 0xffffffffffff;
}

function randomSeed() {
  return crypto.randomBytes(16).toString("hex");
}

function publicUserRecord(record) {
  return {
    userId: record.userId,
    userName: record.userName,
    displayName: record.displayName,
    totalCheckins: record.totalCheckins || 0,
    streak: record.streak || 0,
    bestStreak: record.bestStreak || 0,
    points: record.points || 0,
    lastDate: record.lastDate || "",
    lastMood: record.lastMood || ""
  };
}

async function runCheckin(config, feature, action, identity, payload) {
  const filePath = featureStatePath(config, feature.id);
  const state = await readJson(filePath, { version: 1, users: {}, days: {} });
  state.version = 1;
  state.users = isRecord(state.users) ? state.users : {};
  state.days = isRecord(state.days) ? state.days : {};

  if (action.id === "leaderboard") {
    const users = Object.values(state.users).filter(isRecord).map(publicUserRecord);
    users.sort((a, b) => b.points - a.points || b.streak - a.streak || b.totalCheckins - a.totalCheckins);
    const count = readNumber({ count: payload.count }, "count", 10, 1, 20);
    return {
      kind: "checkin_leaderboard",
      today: dateKey(config),
      count: Math.min(users.length, count),
      users: users.slice(0, count)
    };
  }

  const userId = normalizedIdentity(identity.userId || payload.userId);
  if (!userId) throw new Error("checkin requires userId");
  const userName = String(identity.userName || payload.userName || "").trim();
  const displayName = String(identity.displayName || payload.displayName || userName || userId).trim();
  const today = dateKey(config);
  const yesterday = yesterdayKey(config);
  const current = isRecord(state.users[userId]) ? state.users[userId] : {
    userId,
    userName,
    displayName,
    totalCheckins: 0,
    streak: 0,
    bestStreak: 0,
    points: 0,
    history: []
  };
  current.userName = userName || current.userName || "";
  current.displayName = displayName || current.displayName || current.userName || userId;

  if (action.id === "status") {
    return {
      kind: "checkin_status",
      today,
      alreadyCheckedIn: current.lastDate === today,
      user: publicUserRecord(current)
    };
  }

  if (current.lastDate === today) {
    const users = Object.values(state.users).filter(isRecord).map(publicUserRecord).sort((a, b) => b.points - a.points);
    const rank = users.findIndex((user) => user.userId === userId) + 1;
    return {
      kind: "checkin_result",
      today,
      alreadyCheckedIn: true,
      gainedPoints: 0,
      mood: current.lastMood || deterministicMood(userId, today),
      rank,
      user: publicUserRecord(current),
      modelInstruction: "Tell the user they have already checked in today. Keep it brief; do not invent extra points."
    };
  }

  const basePoints = deterministicPoints(userId, today);
  const streak = current.lastDate === yesterday ? Number(current.streak || 0) + 1 : 1;
  const streakBonus = Math.min(10, Math.floor(streak / 5));
  const points = basePoints + streakBonus;
  const mood = deterministicMood(userId, today);
  current.lastDate = today;
  current.lastMood = mood;
  current.streak = streak;
  current.bestStreak = Math.max(Number(current.bestStreak || 0), streak);
  current.totalCheckins = Number(current.totalCheckins || 0) + 1;
  current.points = Number(current.points || 0) + points;
  current.history = Array.isArray(current.history) ? current.history : [];
  current.history.push({ date: today, points, basePoints, streakBonus, mood, t: nowIso() });
  current.history = current.history.slice(-90);
  state.users[userId] = current;
  state.days[today] = isRecord(state.days[today]) ? state.days[today] : { users: [], count: 0 };
  if (!state.days[today].users.includes(userId)) state.days[today].users.push(userId);
  state.days[today].count = state.days[today].users.length;
  state.updatedAt = nowIso();
  await writeJsonAtomic(filePath, state);
  const users = Object.values(state.users).filter(isRecord).map(publicUserRecord).sort((a, b) => b.points - a.points);
  const rank = users.findIndex((user) => user.userId === userId) + 1;
  return {
    kind: "checkin_result",
    today,
    alreadyCheckedIn: false,
    gainedPoints: points,
    basePoints,
    streakBonus,
    mood,
    rank,
    user: publicUserRecord(current),
    groupTodayCount: state.days[today].count,
    modelInstruction: "Write a concise check-in reply in character. You may lightly comment on mood/streak, but do not alter points, streak, or rank."
  };
}

const DEFAULT_WAIFU_POOL = [
  { id: "quantum_researcher", name: "量子研究员", rarity: "SSR", archetype: "冷静毒舌的实验室白衣科学家", element: "science", quote: "先把变量固定，不然心动也没有统计意义。", danbooruTags: ["labcoat", "glasses"] },
  { id: "moon_vampire_princess", name: "月下吸血姬", rarity: "SSR", archetype: "优雅又任性的夜色贵族少女", element: "moon", quote: "把夜晚交给我。白天？那是低效时段。", danbooruTags: ["vampire", "dress"] },
  { id: "starlight_songstress", name: "星光歌姬", rarity: "SSR", archetype: "舞台感极强的银河系偶像", element: "star", quote: "安静，下一段副歌会改变概率。", danbooruTags: ["idol", "microphone"] },
  { id: "clockwork_witch", name: "钟表魔女", rarity: "SSR", archetype: "操纵时间感的机械魔法师", element: "time", quote: "迟到不是问题，问题是你没有备份时间线。", danbooruTags: ["witch", "hat"] },
  { id: "library_senpai", name: "图书馆前辈", rarity: "SR", archetype: "安静可靠但吐槽精准的知识系前辈", element: "book", quote: "借书可以，借脑子不行。", danbooruTags: ["book", "glasses"] },
  { id: "cyber_miko", name: "赛博巫女", rarity: "SR", archetype: "会写脚本的电子神社值守者", element: "cyber", quote: "祈福已提交，等待 API 返回。", danbooruTags: ["miko"] },
  { id: "mecha_mechanic", name: "机甲整备师", rarity: "SR", archetype: "拿扳手比拿花熟练的工程少女", element: "steel", quote: "浪漫？先把螺丝拧紧。", danbooruTags: ["mechanic", "tools"] },
  { id: "rainy_detective", name: "雨夜侦探", rarity: "SR", archetype: "冷淡敏锐的都市推理系搭档", element: "rain", quote: "你撒谎的方式很有初学者气息。", danbooruTags: ["detective"] },
  { id: "alchemy_apprentice", name: "炼金术学徒", rarity: "SR", archetype: "实验经常炸但结论很可爱的炼金少女", element: "alchemy", quote: "这不是爆炸，是高能反馈。", danbooruTags: ["witch", "bottle"] },
  { id: "arcade_champion", name: "街机厅冠军", rarity: "R", archetype: "反应速度很快的游戏系少女", element: "game", quote: "投币吧，菜也要有仪式感。", danbooruTags: ["video_game", "arcade"] },
  { id: "astronomy_club", name: "天文社观测员", rarity: "R", archetype: "温柔认真、喜欢星图和夜风", element: "sky", quote: "今晚云层很薄，适合确认愿望是否离谱。", danbooruTags: ["starry_sky"] },
  { id: "tea_heir", name: "茶会大小姐", rarity: "R", archetype: "礼仪端正但嘴上不饶人的大小姐", element: "tea", quote: "坐姿。先从坐姿开始修正。", danbooruTags: ["tea", "ojou-sama_pose"] },
  { id: "keyboard_bandmate", name: "轻音部键盘手", rarity: "R", archetype: "有点散漫但旋律感很好的社团少女", element: "music", quote: "排练可以迟到，拍子不可以。", danbooruTags: ["keyboard_(instrument)"] },
  { id: "night_shift_clerk", name: "便利店夜班少女", rarity: "R", archetype: "现实感很强的深夜吐槽役", element: "neon", quote: "欢迎光临。别把人生也放进微波炉。", danbooruTags: ["convenience_store"] },
  { id: "transfer_classmate", name: "同桌转学生", rarity: "N", archetype: "普通但展开很多的校园系同桌", element: "school", quote: "课本借你，作业不借。", danbooruTags: ["school_uniform"] },
  { id: "student_council_scribe", name: "学生会书记", rarity: "N", archetype: "记录一切的认真派少女", element: "order", quote: "这句话我会写进会议纪要。", danbooruTags: ["school_uniform", "student_council"] },
  { id: "art_club_model", name: "美术部模特", rarity: "N", archetype: "安静、审美好、偶尔语出惊人", element: "paint", quote: "别动，你现在的尴尬很有构图价值。", danbooruTags: ["paintbrush"] },
  { id: "coffee_newbie", name: "咖啡店新人", rarity: "N", archetype: "努力营业但经常记错菜单", element: "coffee", quote: "苦一点比较醒脑，也比较符合现实。", danbooruTags: ["cafe", "apron"] }
];

const RARITY_ORDER = ["N", "R", "SR", "SSR", "UR"];
const RARITY_POINTS = { N: 5, R: 15, SR: 45, SSR: 120, UR: 360 };
const DEFAULT_POPULARITY_THRESHOLDS = { R: 45, SR: 120, SSR: 300, UR: 900 };
const DEFAULT_GACHA_RATES = { N: 0.4, R: 0.5, SR: 0.08, SSR: 0.0167, UR: 0.0033 };
const DEFAULT_GACHA_PITY = {
  urHard: 300,
  ssrSoftStart: 50,
  ssrBonusPerMiss: 0.02
};
const DEFAULT_SCORE_BANDS = {
  N: { min: 20, max: 30, randomPages: 1000 },
  R: { min: 31, max: 50, randomPages: 1000 },
  SR: { min: 51, max: 100, randomPages: 400 },
  SSR: { min: 101, max: 299, randomPages: 100 },
  UR: { min: 300, max: null, randomPages: 20 }
};
const MAX_GACHA_DRAWS_PER_REQUEST = 10;
const GACHA_DUPLICATE_REQUEST_TTL_MS = 12 * 60 * 1000;
const GACHA_REQUEST_LOCK_STALE_MS = GACHA_DUPLICATE_REQUEST_TTL_MS;
const RARITY_EMOJI = { N: "▫️", R: "🌟", SR: "🔮", SSR: "💎", UR: "🌈👑" };
const DANBOORU_ELEMENT_TAGS = {
  science: ["labcoat", "glasses"],
  moon: ["vampire", "dress"],
  star: ["idol", "microphone"],
  time: ["witch_hat", "clock"],
  book: ["book", "library"],
  cyber: ["miko", "cyberpunk"],
  steel: ["mechanic", "tools"],
  rain: ["detective", "umbrella"],
  alchemy: ["bottle", "witch"],
  game: ["arcade", "video_game"],
  sky: ["starry_sky", "telescope"],
  tea: ["tea", "ojou-sama_pose"],
  music: ["keyboard_(instrument)", "music"],
  neon: ["convenience_store", "neon_lights"],
  school: ["school_uniform"],
  order: ["student_council", "school_uniform"],
  paint: ["paintbrush", "artist"],
  coffee: ["cafe", "apron"]
};
const DANBOORU_FALLBACK_TAGS = ["solo", "smile", "looking_at_viewer", "school_uniform", "dress"];

function normalizeRarity(value) {
  const rarity = String(value || "N").trim().toUpperCase();
  return RARITY_ORDER.includes(rarity) ? rarity : "N";
}

function waifuPool(feature) {
  const pool = Array.isArray(feature?.config?.pool) ? feature.config.pool : DEFAULT_WAIFU_POOL;
  const normalized = pool
    .filter(isRecord)
    .map((card) => ({
      id: safeId(card.id || card.name),
      name: String(card.name || card.id || "Unknown").trim(),
      rarity: normalizeRarity(card.rarity),
      archetype: String(card.archetype || "").trim(),
      element: String(card.element || "").trim(),
      quote: String(card.quote || "").trim(),
      danbooruTags: Array.isArray(card.danbooruTags) ? card.danbooruTags.map((tag) => String(tag || "").trim()).filter(Boolean).slice(0, 4) : []
    }))
    .filter((card) => card.id && card.name);
  return normalized.length ? normalized : DEFAULT_WAIFU_POOL;
}

function clamp01(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function readRate(raw, fallback, percentMode = false) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const text = String(raw).trim();
  const number = Number(raw);
  if (!Number.isFinite(number)) return fallback;
  return clamp01(percentMode || text.endsWith("%") || number > 1 ? number / 100 : number, fallback);
}

function normalizeGachaRates(rawRates = {}) {
  const rates = {};
  let configuredTotal = 0;
  const configuredValues = RARITY_ORDER
    .filter((rarity) => rawRates[rarity] !== undefined && rawRates[rarity] !== null && rawRates[rarity] !== "")
    .map((rarity) => rawRates[rarity]);
  const percentMode = configuredValues.some((value) => String(value).trim().endsWith("%") || Number(value) > 1);
  for (const rarity of RARITY_ORDER) {
    if (rarity === "N") continue;
    rates[rarity] = readRate(rawRates[rarity], DEFAULT_GACHA_RATES[rarity], percentMode);
    configuredTotal += rates[rarity];
  }
  const fallbackN = DEFAULT_GACHA_RATES.N;
  rates.N = rawRates.N === undefined
    ? Math.max(0, 1 - configuredTotal)
    : readRate(rawRates.N, fallbackN, percentMode);
  const total = RARITY_ORDER.reduce((sum, rarity) => sum + Number(rates[rarity] || 0), 0);
  if (total <= 0) return { ...DEFAULT_GACHA_RATES };
  for (const rarity of RARITY_ORDER) rates[rarity] = Number(rates[rarity] || 0) / total;
  return rates;
}

function normalizeScoreBand(raw, fallback) {
  const source = isRecord(raw) ? raw : {};
  const min = Math.max(0, Math.trunc(Number(source.min ?? fallback.min ?? 0)));
  const maxRaw = source.max ?? fallback.max;
  const max = maxRaw === null || maxRaw === undefined || maxRaw === "" ? null : Math.max(min, Math.trunc(Number(maxRaw)));
  const randomPages = Math.max(1, Math.min(1000, Math.trunc(Number(source.randomPages ?? fallback.randomPages ?? 50))));
  return { min, max, randomPages };
}

function danbooruConfig(feature) {
  const raw = isRecord(feature?.config?.danbooru) ? feature.config.danbooru : {};
  const baseTags = Array.isArray(raw.baseTags) ? raw.baseTags.map(String) : ["1girl"];
  const excludeTags = Array.isArray(raw.excludeTags) ? raw.excludeTags.map(String) : [
    "-animated",
    "-comic",
    "-manga",
    "-multiple_girls",
    "-text_focus"
  ];
  const fallbackTags = Array.isArray(raw.fallbackTags) ? raw.fallbackTags.map(String) : DANBOORU_FALLBACK_TAGS;
  const quality = isRecord(raw.quality) ? raw.quality : {};
  const thresholds = isRecord(raw.popularityThresholds) ? raw.popularityThresholds : {};
  const rates = normalizeGachaRates(isRecord(raw.rates) ? raw.rates : {});
  const pity = isRecord(raw.pity) ? raw.pity : {};
  const scoreBandsRaw = isRecord(raw.scoreBands) ? raw.scoreBands : {};
  const scoreBands = {};
  for (const rarity of RARITY_ORDER) scoreBands[rarity] = normalizeScoreBand(scoreBandsRaw[rarity], DEFAULT_SCORE_BANDS[rarity]);
  return {
    enabled: raw.enabled !== false,
    cardMode: String(raw.cardMode || "danbooru_post").trim().toLowerCase(),
    endpoint: String(raw.endpoint || raw.apiUrl || DANBOORU_ENDPOINT).trim(),
    postBase: String(raw.postBase || DANBOORU_POST_BASE).trim().replace(/\/+$/, ""),
    useRandomOrder: raw.useRandomOrder !== false,
    baseTags: baseTags.map((tag) => tag.trim()).filter(Boolean).slice(0, 1),
    fallbackTags: fallbackTags.map((tag) => tag.trim()).filter(Boolean).slice(0, 8),
    blockedTags: [...excludeTags, ...DEFAULT_DANBOORU_SAFETY_BLOCKED_TAGS]
      .map((tag) => normalizeDanbooruSafetyTag(tag.trim().replace(/^-/, "")))
      .filter((tag) => tag && !tag.startsWith("rating:"))
      .filter((tag, index, tags) => tags.indexOf(tag) === index)
      .slice(0, 80),
    preferTags: Array.isArray(raw.preferTags) ? raw.preferTags.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 6) : ["solo"],
    limit: Math.max(1, Math.min(50, Number(raw.limit || 20))),
    timeoutMs: Math.max(1000, Math.min(30000, Number(raw.timeoutMs || DANBOORU_TIMEOUT_MS))),
    retries: Math.max(0, Math.min(3, Math.trunc(Number(raw.retries ?? DANBOORU_RETRIES)))),
    minScore: Math.max(0, Number(quality.minScore ?? raw.minScore ?? 20)),
    minFavCount: Math.max(0, Number(quality.minFavCount ?? raw.minFavCount ?? 0)),
    minWidth: Math.max(1, Number(quality.minWidth ?? raw.minWidth ?? 512)),
    minHeight: Math.max(1, Number(quality.minHeight ?? raw.minHeight ?? 512)),
    minPixels: Math.max(1, Number(quality.minPixels ?? raw.minPixels ?? 300_000)),
    maxAspectRatio: Math.max(1, Number(quality.maxAspectRatio ?? raw.maxAspectRatio ?? 4)),
    minTagCount: Math.max(0, Number(quality.minTagCount ?? raw.minTagCount ?? 12)),
    popularityThresholds: {
      R: Math.max(0, Number(thresholds.R ?? DEFAULT_POPULARITY_THRESHOLDS.R)),
      SR: Math.max(0, Number(thresholds.SR ?? DEFAULT_POPULARITY_THRESHOLDS.SR)),
      SSR: Math.max(0, Number(thresholds.SSR ?? DEFAULT_POPULARITY_THRESHOLDS.SSR)),
      UR: Math.max(0, Number(thresholds.UR ?? DEFAULT_POPULARITY_THRESHOLDS.UR))
    },
    rates,
    pity: {
      urHard: Math.max(1, Math.trunc(Number(pity.urHard ?? DEFAULT_GACHA_PITY.urHard))),
      ssrSoftStart: Math.max(1, Math.trunc(Number(pity.ssrSoftStart ?? DEFAULT_GACHA_PITY.ssrSoftStart))),
      ssrBonusPerMiss: readRate(pity.ssrBonusPerMiss, DEFAULT_GACHA_PITY.ssrBonusPerMiss)
    },
    scoreBands
  };
}

function normalizeDanbooruTag(tag) {
  const value = String(tag || "").trim();
  if (!value || value.startsWith("-") || value.startsWith("rating:") || value.startsWith("score:")) return "";
  return value;
}

function normalizeDanbooruSafetyTag(tag) {
  return String(tag || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/^#+/, "");
}

function danbooruPostTagSet(post) {
  const tags = new Set();
  for (const field of [
    "tag_string",
    "tag_string_general",
    "tag_string_character",
    "tag_string_copyright",
    "tag_string_artist",
    "tag_string_meta"
  ]) {
    for (const tag of String(post?.[field] || "").split(/\s+/).filter(Boolean)) {
      const normalized = normalizeDanbooruSafetyTag(tag);
      if (normalized) tags.add(normalized);
    }
  }
  return tags;
}

function uniqueTagList(tags, max = 4) {
  const seen = new Set();
  const selected = [];
  for (const tag of tags) {
    const value = String(tag || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    selected.push(value);
    if (selected.length >= max) break;
  }
  return selected;
}

function scoreFloorForMinimumRarity(minRarity, thresholds) {
  const popularity = rarityMinimumPopularity(minRarity, thresholds);
  if (popularity <= 0) return 0;
  return Math.max(20, Math.floor(popularity * 0.45));
}

function baseTagsWithScoreFloor(baseTags, scoreFloor = 0) {
  const tags = Array.isArray(baseTags) ? baseTags : [];
  let replaced = false;
  const mapped = tags.map((tag) => {
    const value = String(tag || "").trim();
    if (/^score:>/i.test(value) && scoreFloor > 0) {
      replaced = true;
      return `score:>${scoreFloor}`;
    }
    return value;
  }).filter(Boolean);
  if (scoreFloor > 0 && !replaced) mapped.push(`score:>${scoreFloor}`);
  return mapped;
}

function danbooruTagPlansForCard(feature, card, options = {}) {
  const config = danbooruConfig(feature);
  const scoreFloor = scoreFloorForMinimumRarity(options.minRarity, config.popularityThresholds);
  const baseTags = baseTagsWithScoreFloor(config.baseTags, scoreFloor);
  const elementTags = DANBOORU_ELEMENT_TAGS[String(card?.element || "").trim().toLowerCase()] || [];
  const candidateTags = [
    ...(Array.isArray(card?.danbooruTags) ? card.danbooruTags : []),
    ...elementTags,
    ...config.fallbackTags
  ].map(normalizeDanbooruTag).filter(Boolean);
  const plans = [];
  const seen = new Set();
  const addPlan = (extraTag = "") => {
    const tags = uniqueTagList(extraTag ? [...baseTags, extraTag] : baseTags, 4);
    const key = tags.join(" ");
    if (!key || seen.has(key)) return;
    seen.add(key);
    plans.push(tags);
  };
  for (const tag of candidateTags) addPlan(tag);
  addPlan("");
  return plans;
}

function danbooruTagsForCard(feature, card) {
  return danbooruTagPlansForCard(feature, card)[0] || danbooruConfig(feature).baseTags;
}

function postDimension(post, field) {
  const value = Number(post?.[field] || 0);
  return Number.isFinite(value) ? value : 0;
}

function danbooruPopularityScore(input) {
  const score = Number(input?.score || 0);
  const favCount = Number(input?.favCount ?? input?.fav_count ?? 0);
  const downScore = Number(input?.downScore ?? input?.down_score ?? 0);
  const width = Number(input?.width ?? input?.image_width ?? 0);
  const height = Number(input?.height ?? input?.image_height ?? 0);
  const megapixels = width > 0 && height > 0 ? width * height / 1_000_000 : 0;
  const resolutionBonus = Math.min(60, Math.floor(Math.sqrt(Math.max(0, megapixels)) * 18));
  return Math.max(0, Math.round(score + favCount * 2 - downScore * 2 + resolutionBonus));
}

function rarityFromPopularity(popularity, thresholds = DEFAULT_POPULARITY_THRESHOLDS) {
  const value = Number(popularity || 0);
  if (value >= Number(thresholds.UR ?? DEFAULT_POPULARITY_THRESHOLDS.UR)) return "UR";
  if (value >= Number(thresholds.SSR ?? DEFAULT_POPULARITY_THRESHOLDS.SSR)) return "SSR";
  if (value >= Number(thresholds.SR ?? DEFAULT_POPULARITY_THRESHOLDS.SR)) return "SR";
  if (value >= Number(thresholds.R ?? DEFAULT_POPULARITY_THRESHOLDS.R)) return "R";
  return "N";
}

function rarityMinimumPopularity(rarity, thresholds = DEFAULT_POPULARITY_THRESHOLDS) {
  const normalized = normalizeRarity(rarity);
  if (normalized === "UR") return Number(thresholds.UR ?? DEFAULT_POPULARITY_THRESHOLDS.UR);
  if (normalized === "SSR") return Number(thresholds.SSR ?? DEFAULT_POPULARITY_THRESHOLDS.SSR);
  if (normalized === "SR") return Number(thresholds.SR ?? DEFAULT_POPULARITY_THRESHOLDS.SR);
  if (normalized === "R") return Number(thresholds.R ?? DEFAULT_POPULARITY_THRESHOLDS.R);
  return 0;
}

function scoreBandForRarity(feature, rarity) {
  const config = danbooruConfig(feature);
  return config.scoreBands[normalizeRarity(rarity)] || config.scoreBands.N || DEFAULT_SCORE_BANDS.N;
}

function scoreBandTag(band) {
  const min = Math.max(0, Math.trunc(Number(band?.min || 0)));
  const max = band?.max === null || band?.max === undefined ? null : Math.max(min, Math.trunc(Number(band.max)));
  return max === null ? `score:>=${min}` : `score:${min}..${max}`;
}

function scoreInBand(score, band) {
  const value = Number(score || 0);
  if (value < Number(band?.min || 0)) return false;
  if (band?.max !== null && band?.max !== undefined && value > Number(band.max)) return false;
  return true;
}

function danbooruQueryPlansForRarity(feature, rarity, seed = "") {
  const config = danbooruConfig(feature);
  const band = scoreBandForRarity(feature, rarity);
  const primary = (config.baseTags[0] || "1girl").trim();
  const base = uniqueTagList([primary, scoreBandTag(band)], 2);
  const plans = [];
  if (config.useRandomOrder) plans.push({ tags: [...base, "order:random"], page: "" });
  const randomPage = 1 + Math.floor(seededUnit(`${seed}:${rarity}:score-page`) * Math.max(1, band.randomPages || 1));
  plans.push({ tags: base, page: String(randomPage) });
  plans.push({ tags: base, page: "1" });
  return plans;
}

function postHasTags(post, tags) {
  const tagSet = new Set(String(post?.tag_string || "").split(/\s+/).filter(Boolean));
  return tags.every((tag) => tagSet.has(tag));
}

function isSafeDanbooruPost(post, configOrBlockedTags = []) {
  if (!isRecord(post)) return false;
  if (post.rating !== "g") return false;
  if (post.is_deleted || post.is_banned || post.is_flagged) return false;
  const ext = String(post.file_ext || "").toLowerCase();
  if (!["jpg", "jpeg", "png", "webp"].includes(ext)) return false;
  const config = Array.isArray(configOrBlockedTags) ? { blockedTags: configOrBlockedTags } : configOrBlockedTags;
  const width = postDimension(post, "image_width");
  const height = postDimension(post, "image_height");
  if (width < Number(config.minWidth || 1) || height < Number(config.minHeight || 1)) return false;
  if (width * height < Number(config.minPixels || 1)) return false;
  const aspect = width > 0 && height > 0 ? Math.max(width / height, height / width) : 1;
  if (aspect > Number(config.maxAspectRatio || 99)) return false;
  if (Number(post.score || 0) < Number(config.minScore || 0)) return false;
  if (Number(post.fav_count || 0) < Number(config.minFavCount || 0)) return false;
  if (Number(post.tag_count || 0) < Number(config.minTagCount || 0)) return false;
  const tagSet = danbooruPostTagSet(post);
  for (const tag of config.blockedTags || []) {
    if (tagSet.has(normalizeDanbooruSafetyTag(tag))) return false;
  }
  return Boolean(post.file_url || post.large_file_url || post.preview_file_url || post.media_asset?.variants);
}

function selectedVariantMeta(variant, fallbackExt = "") {
  return {
    url: variant?.url || "",
    fileExt: variant?.file_ext || fallbackExt || "",
    width: Number(variant?.width || 0),
    height: Number(variant?.height || 0)
  };
}

function pickDanbooruImage(post, configOrFeature = {}) {
  const config = configOrFeature?.scoreBands ? configOrFeature : danbooruConfig(configOrFeature);
  const variants = Array.isArray(post.media_asset?.variants) ? post.media_asset.variants : [];
  const byType = (type) => variants.find((variant) => variant?.type === type && variant.url);
  const sample = byType("sample") || byType("720x720") || byType("360x360") || null;
  const originalUrl = post.file_url || "";
  const largeUrl = post.large_file_url || "";
  const url = originalUrl || largeUrl || sample?.url || post.preview_file_url || "";
  if (!url) return null;
  const chosen = originalUrl
    ? { url: originalUrl, file_ext: post.file_ext, width: post.image_width, height: post.image_height, type: "original" }
    : largeUrl
      ? { url: largeUrl, file_ext: post.file_ext, width: post.image_width, height: post.image_height, type: "large" }
      : sample;
  return {
    provider: "danbooru",
    postId: post.id,
    pageUrl: `${config.postBase || DANBOORU_POST_BASE}/${post.id}`,
    imageUrl: url,
    imageQuality: chosen?.type || (originalUrl ? "original" : largeUrl ? "large" : "fallback"),
    originalUrl,
    largeUrl,
    sampleUrl: sample?.url || "",
    previewUrl: post.preview_file_url || "",
    createdAt: post.created_at || "",
    uploaderId: post.uploader_id || null,
    md5: post.md5 || "",
    rating: post.rating,
    score: post.score || 0,
    upScore: post.up_score || 0,
    downScore: post.down_score || 0,
    favCount: post.fav_count || 0,
    tagCount: post.tag_count || 0,
    source: post.source || "",
    fileExt: chosen?.file_ext || post.file_ext || "",
    width: chosen?.width || post.image_width || 0,
    height: chosen?.height || post.image_height || 0,
    originalWidth: post.image_width || 0,
    originalHeight: post.image_height || 0,
    selectedVariant: selectedVariantMeta(chosen, post.file_ext),
    sampleVariant: selectedVariantMeta(sample, post.file_ext),
    popularity: danbooruPopularityScore(post),
    tagString: String(post.tag_string || ""),
    tags: {
      character: String(post.tag_string_character || "").split(/\s+/).filter(Boolean).slice(0, 6),
      copyright: String(post.tag_string_copyright || "").split(/\s+/).filter(Boolean).slice(0, 4),
      artist: String(post.tag_string_artist || "").split(/\s+/).filter(Boolean).slice(0, 4),
      general: String(post.tag_string_general || "").split(/\s+/).filter(Boolean).slice(0, 12)
    }
  };
}

function compactTagLabel(tags, fallback) {
  const selected = Array.isArray(tags) ? tags.filter(Boolean) : [];
  if (!selected.length) return fallback;
  return selected.slice(0, 2).map((tag) => String(tag).replace(/_/g, " ")).join(" / ");
}

function danbooruImageDisplayName(image) {
  const tags = image?.tags || {};
  const character = compactTagLabel(tags.character, "");
  const copyright = compactTagLabel(tags.copyright, "");
  const artist = compactTagLabel(tags.artist, "");
  if (character && copyright) {
    return character.toLowerCase().includes(copyright.toLowerCase()) ? character : `${character} (${copyright})`;
  }
  if (character) return character;
  if (copyright) return `${copyright} illustration`;
  if (artist) return `${artist} original`;
  return `Danbooru #${image?.postId || "unknown"}`;
}

function archiveSafeTag(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function buildDanbooruArchiveTags(image, rarity) {
  const tags = new Set(["waifu_gacha", `rarity_${archiveSafeTag(rarity)}`, `post_${image?.postId || "unknown"}`]);
  const score = Number(image?.score || 0);
  if (score >= 300) tags.add("score_300_plus");
  else if (score >= 101) tags.add("score_101_299");
  else if (score >= 51) tags.add("score_51_100");
  else if (score >= 31) tags.add("score_31_50");
  else tags.add("score_20_30");
  for (const tag of image?.tags?.character || []) tags.add(`character_${archiveSafeTag(tag)}`);
  for (const tag of image?.tags?.copyright || []) tags.add(`series_${archiveSafeTag(tag)}`);
  for (const tag of image?.tags?.artist || []) tags.add(`artist_${archiveSafeTag(tag)}`);
  return [...tags].filter(Boolean).slice(0, 24);
}

function danbooruImageToCard(image, feature, forcedRarity = "") {
  const config = danbooruConfig(feature);
  const rarity = normalizeRarity(forcedRarity || image?.rarity || rarityFromPopularity(image?.popularity, config.popularityThresholds));
  const tags = image?.tags || {};
  const artist = Array.isArray(tags.artist) ? tags.artist[0] || "" : "";
  const copyright = Array.isArray(tags.copyright) ? tags.copyright[0] || "" : "";
  const character = Array.isArray(tags.character) ? tags.character[0] || "" : "";
  return {
    id: `danbooru:${image.postId}`,
    name: danbooruImageDisplayName(image),
    rarity,
    archetype: copyright || character || compactTagLabel(tags.general, "Danbooru image card"),
    element: copyright || "danbooru",
    quote: artist ? `artist: ${artist}` : `post: ${image.postId}`,
    sourceKind: "danbooru_post",
    danbooru: image
  };
}

function chooseDanbooruPost(posts, seed) {
  const ranked = [...posts].sort((a, b) => danbooruPopularityScore(b) - danbooruPopularityScore(a));
  const top = ranked.slice(0, Math.max(1, Math.min(8, ranked.length)));
  const weighted = top.map((post) => ({
    post,
    weight: Math.max(1, Math.sqrt(danbooruPopularityScore(post) + 1))
  }));
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let cursor = seededUnit(`${seed}:danbooru-weighted`) * total;
  for (const item of weighted) {
    cursor -= item.weight;
    if (cursor <= 0) return item.post;
  }
  return weighted[weighted.length - 1]?.post || posts[0] || null;
}

function chooseDanbooruPostFromBand(posts, seed, config) {
  const safePosts = Array.isArray(posts) ? posts.filter((post) => isSafeDanbooruPost(post, config)) : [];
  const preferred = safePosts.filter((post) => postHasTags(post, config.preferTags || []));
  const pool = preferred.length ? preferred : safePosts;
  if (!pool.length) return null;
  const index = Math.floor(seededUnit(`${seed}:post-index`) * pool.length) % pool.length;
  return pool[index];
}

async function fetchDanbooruPosts(url, config) {
  const retries = Math.max(0, Math.min(3, Number(config?.retries ?? DANBOORU_RETRIES)));
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Math.min(30000, Number(config?.timeoutMs || DANBOORU_TIMEOUT_MS)));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "accept": "application/json",
          "user-agent": DANBOORU_USER_AGENT
        }
      });
      if (!response.ok) {
        const error = new Error(`Danbooru API ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      const message = controller.signal.aborted
        ? `danbooru request timeout after ${timeoutMs}ms`
        : clip(error instanceof Error ? error.message : String(error), 180);
      lastError = message;
      const status = Number(error?.status || 0);
      const retryable = controller.signal.aborted
        || status === 429
        || status >= 500
        || /fetch failed|network|timeout|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(message);
      if (attempt >= retries || !retryable) throw new Error(message);
      await wait(300 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError || "Danbooru API request failed");
}

async function fetchDanbooruImageForRarity(feature, rarity, seed, options = {}) {
  const config = danbooruConfig(feature);
  if (!config.enabled) return null;
  const normalized = normalizeRarity(rarity);
  const band = scoreBandForRarity(feature, normalized);
  const plans = danbooruQueryPlansForRarity(feature, normalized, seed);
  let lastError = "";
  const attempted = [];
  try {
    for (const plan of plans) {
      attempted.push({ tags: plan.tags, page: plan.page || "" });
      const url = new URL(config.endpoint || DANBOORU_ENDPOINT);
      url.searchParams.set("tags", plan.tags.join(" "));
      url.searchParams.set("limit", String(config.limit));
      if (plan.page) url.searchParams.set("page", plan.page);
      try {
        const posts = await fetchDanbooruPosts(url, config);
        const candidates = Array.isArray(posts)
          ? posts.filter((post) => scoreInBand(post.score, band))
          : [];
        const post = chooseDanbooruPostFromBand(candidates, `${seed}:${normalized}:${plan.tags.join(" ")}:${plan.page || "random"}`, config);
        const image = post ? pickDanbooruImage(post, config) : null;
        if (image) {
          return {
            ...image,
            rarity: normalized,
            scoreBand: { ...band },
            queryTags: plan.tags,
            queryPage: plan.page || "",
            queryAttempts: attempted,
            archiveTags: buildDanbooruArchiveTags(image, normalized)
          };
        }
      } catch (error) {
        lastError = clip(error instanceof Error ? error.message : String(error), 180);
      }
    }
    if (lastError) {
      return {
        provider: "danbooru",
        rarity: normalized,
        error: lastError,
        scoreBand: { ...band },
        queryTags: plans[0]?.tags || [],
        queryAttempts: attempted
      };
    }
    return null;
  } catch (error) {
    return {
      provider: "danbooru",
      rarity: normalized,
      error: clip(error instanceof Error ? error.message : String(error), 180),
      scoreBand: { ...band },
      queryTags: plans[0]?.tags || [],
      queryAttempts: attempted
    };
  }
}

async function fetchDanbooruImage(feature, card, seed, options = {}) {
  const config = danbooruConfig(feature);
  if (!config.enabled) return null;
  const tagPlans = danbooruTagPlansForCard(feature, card, options);
  const minPopularity = Math.max(
    0,
    Number(options.minPopularity || 0),
    rarityMinimumPopularity(options.minRarity, config.popularityThresholds)
  );
  let lastError = "";
  const attempted = [];
  try {
    for (const tags of tagPlans) {
      attempted.push(tags);
      const url = new URL(config.endpoint || DANBOORU_ENDPOINT);
      url.searchParams.set("tags", tags.join(" "));
      url.searchParams.set("limit", String(config.limit));
      try {
        const posts = await fetchDanbooruPosts(url, config);
        const safePosts = Array.isArray(posts)
          ? posts
            .filter((post) => isSafeDanbooruPost(post, config))
            .filter((post) => danbooruPopularityScore(post) >= minPopularity)
          : [];
        if (!safePosts.length) continue;
        const post = chooseDanbooruPost(safePosts, `${seed}:${tags.join(" ")}`);
        const image = post ? pickDanbooruImage(post) : null;
        if (image) {
          const rarity = rarityFromPopularity(image.popularity, config.popularityThresholds);
          return { ...image, rarity, queryTags: tags, queryAttempts: attempted };
        }
      } catch (error) {
        lastError = clip(error instanceof Error ? error.message : String(error), 180);
      }
    }
    if (lastError) {
      return {
        provider: "danbooru",
        error: lastError,
        queryTags: tagPlans[0] || [],
        queryAttempts: attempted
      };
    }
    return null;
  } catch (error) {
    return {
      provider: "danbooru",
      error: clip(error instanceof Error ? error.message : String(error), 180),
      queryTags: tagPlans[0] || [],
      queryAttempts: attempted
    };
  }
}

function effectiveSsrRate(user, config) {
  const rates = config?.rates || DEFAULT_GACHA_RATES;
  const pity = config?.pity || DEFAULT_GACHA_PITY;
  const misses = Math.max(0, Number(user?.pitySSR || 0));
  const softStart = Math.max(1, Number(pity.ssrSoftStart || DEFAULT_GACHA_PITY.ssrSoftStart));
  const bonusPerMiss = Math.max(0, readRate(pity.ssrBonusPerMiss, DEFAULT_GACHA_PITY.ssrBonusPerMiss));
  const bonus = misses >= softStart ? (misses - softStart + 1) * bonusPerMiss : 0;
  return Math.max(0, Math.min(1, Number(rates.SSR || 0) + bonus));
}

function chooseRarity(user, seed, forceSrPlus = false, config = {}) {
  const rates = config.rates || DEFAULT_GACHA_RATES;
  const pity = config.pity || DEFAULT_GACHA_PITY;
  if (Number(user.pityUR || 0) >= Math.max(1, Number(pity.urHard || DEFAULT_GACHA_PITY.urHard)) - 1) return "UR";
  const roll = seededUnit(`${seed}:rarity`);
  const urRate = Math.max(0, Math.min(1, Number(rates.UR || 0)));
  const ssrRate = effectiveSsrRate(user, config);
  if (roll < urRate) return "UR";
  if (roll < urRate + ssrRate) return "SSR";
  if (forceSrPlus) return "SR";
  if (roll < urRate + ssrRate + Number(rates.SR || 0)) return "SR";
  if (roll < urRate + ssrRate + Number(rates.SR || 0) + Number(rates.R || 0)) return "R";
  return "N";
}

function chooseCard(pool, rarity, seed) {
  let candidates = pool.filter((card) => card.rarity === rarity);
  if (!candidates.length) candidates = pool;
  const index = Math.floor(seededUnit(`${seed}:card`) * candidates.length) % candidates.length;
  return candidates[index];
}

function rarityRank(rarity) {
  return Math.max(0, RARITY_ORDER.indexOf(normalizeRarity(rarity)));
}

function isRarityAtLeast(rarity, minimum) {
  return rarityRank(rarity) >= rarityRank(minimum);
}

function publicWaifuCard(card) {
  const result = {
    id: card.id,
    name: card.name,
    rarity: card.rarity,
    archetype: card.archetype,
    element: card.element,
    quote: card.quote,
    points: RARITY_POINTS[card.rarity] || 0
  };
  if (card.sourceKind) result.sourceKind = card.sourceKind;
  if (card.danbooru) {
    result.danbooru = {
      postId: card.danbooru.postId,
      pageUrl: card.danbooru.pageUrl,
      imageUrl: card.danbooru.imageUrl,
      imageQuality: card.danbooru.imageQuality,
      originalUrl: card.danbooru.originalUrl,
      largeUrl: card.danbooru.largeUrl,
      sampleUrl: card.danbooru.sampleUrl,
      previewUrl: card.danbooru.previewUrl,
      createdAt: card.danbooru.createdAt,
      uploaderId: card.danbooru.uploaderId,
      md5: card.danbooru.md5,
      score: card.danbooru.score,
      favCount: card.danbooru.favCount,
      popularity: card.danbooru.popularity,
      width: card.danbooru.width,
      height: card.danbooru.height,
      scoreBand: card.danbooru.scoreBand,
      primaryTags: primaryImageTags(card.danbooru)
    };
  }
  return result;
}

function publicGachaUser(record) {
  const collection = isRecord(record.collection) ? record.collection : {};
  const uniqueCards = Object.keys(collection).length;
  return {
    userId: record.userId,
    userName: record.userName,
    displayName: record.displayName,
    totalDraws: record.totalDraws || 0,
    uniqueCards,
    score: record.score || 0,
    shards: record.shards || 0,
    pitySR: record.pitySR || 0,
    pitySSR: record.pitySSR || 0,
    pityUR: record.pityUR || 0,
    lastDailyDate: record.lastDailyDate || ""
  };
}

function publicGachaCollectionCard(card) {
  return {
    id: card?.id || "",
    name: card?.name || "",
    rarity: card?.rarity || "",
    count: Number(card?.count || 0),
    sourceKind: card?.sourceKind || "",
    danbooruPostId: card?.danbooruPostId || null,
    pageUrl: card?.pageUrl || "",
    imageQuality: card?.imageQuality || "",
    scoreBand: card?.scoreBand || null,
    popularity: card?.popularity || 0,
    primaryTags: primaryImageTags({
      tags: {
        character: card?.characterTags || [],
        copyright: card?.copyrightTags || [],
        artist: card?.artistTags || [],
        general: []
      }
    })
  };
}

function ensureGachaUser(state, identity, payload) {
  const userId = normalizedIdentity(identity.userId || payload.userId);
  if (!userId) throw new Error("waifu gacha requires userId");
  const userName = String(identity.userName || payload.userName || "").trim();
  const displayName = String(identity.displayName || payload.displayName || userName || userId).trim();
  const current = isRecord(state.users[userId]) ? state.users[userId] : {
    userId,
    userName,
    displayName,
    totalDraws: 0,
    score: 0,
    shards: 0,
    pitySR: 0,
    pitySSR: 0,
    pityUR: 0,
    collection: {},
    history: []
  };
  current.userName = userName || current.userName || "";
  current.displayName = displayName || current.displayName || current.userName || userId;
  current.collection = isRecord(current.collection) ? current.collection : {};
  current.history = Array.isArray(current.history) ? current.history : [];
  state.users[userId] = current;
  return current;
}

function recordGachaDraw(user, card, seed, t) {
  const owned = isRecord(user.collection[card.id]) ? user.collection[card.id] : {
    id: card.id,
    name: card.name,
    rarity: card.rarity,
    sourceKind: card.sourceKind || "fictional",
    danbooruPostId: card.danbooru?.postId || null,
    pageUrl: card.danbooru?.pageUrl || "",
    imageUrl: card.danbooru?.imageUrl || "",
    imageQuality: card.danbooru?.imageQuality || "",
    originalUrl: card.danbooru?.originalUrl || "",
    largeUrl: card.danbooru?.largeUrl || "",
    sampleUrl: card.danbooru?.sampleUrl || "",
    artistTags: card.danbooru?.tags?.artist || [],
    characterTags: card.danbooru?.tags?.character || [],
    copyrightTags: card.danbooru?.tags?.copyright || [],
    archiveTags: card.danbooru?.archiveTags || [],
    tagString: card.danbooru?.tagString || "",
    scoreBand: card.danbooru?.scoreBand || null,
    popularity: card.danbooru?.popularity || 0,
    count: 0,
    firstAt: t,
    lastAt: t
  };
  const isNew = Number(owned.count || 0) <= 0;
  owned.count = Number(owned.count || 0) + 1;
  owned.lastAt = t;
  owned.name = card.name;
  owned.rarity = card.rarity;
  owned.sourceKind = card.sourceKind || owned.sourceKind || "fictional";
  if (card.danbooru) {
    owned.danbooruPostId = card.danbooru.postId;
    owned.pageUrl = card.danbooru.pageUrl;
    owned.imageUrl = card.danbooru.imageUrl;
    owned.imageQuality = card.danbooru.imageQuality || "";
    owned.originalUrl = card.danbooru.originalUrl || "";
    owned.largeUrl = card.danbooru.largeUrl || "";
    owned.sampleUrl = card.danbooru.sampleUrl || "";
    owned.artistTags = card.danbooru.tags?.artist || [];
    owned.characterTags = card.danbooru.tags?.character || [];
    owned.copyrightTags = card.danbooru.tags?.copyright || [];
    owned.archiveTags = card.danbooru.archiveTags || [];
    owned.tagString = card.danbooru.tagString || "";
    owned.scoreBand = card.danbooru.scoreBand || null;
    owned.popularity = card.danbooru.popularity || 0;
  }
  user.collection[card.id] = owned;
  user.totalDraws = Number(user.totalDraws || 0) + 1;
  user.score = Number(user.score || 0) + (isNew ? RARITY_POINTS[card.rarity] || 0 : Math.max(1, Math.floor((RARITY_POINTS[card.rarity] || 0) / 6)));
  user.shards = Number(user.shards || 0) + (isNew ? 0 : Math.max(1, RARITY_ORDER.indexOf(card.rarity) + 1));
  if (card.rarity === "UR") user.pityUR = 0;
  else user.pityUR = Number(user.pityUR || 0) + 1;
  if (card.rarity === "SSR" || card.rarity === "UR") user.pitySSR = 0;
  else user.pitySSR = Number(user.pitySSR || 0) + 1;
  if (card.rarity === "UR" || card.rarity === "SSR" || card.rarity === "SR") user.pitySR = 0;
  else user.pitySR = Number(user.pitySR || 0) + 1;
  const result = {
    card: publicWaifuCard(card),
    isNew,
    duplicateCount: owned.count,
    affinity: 1 + Math.floor(seededUnit(`${user.userId}:${card.id}:affinity`) * 100),
    seed: hash(seed, 10)
  };
  if (card.danbooru) result.image = card.danbooru;
  user.history.push({ t, cardId: card.id, rarity: card.rarity, sourceKind: card.sourceKind || "fictional", danbooruPostId: card.danbooru?.postId || null, isNew, seed: result.seed });
  user.history = user.history.slice(-120);
  return result;
}

async function drawOneWaifu(user, feature, pool, seed, forceSrPlus = false) {
  const config = danbooruConfig(feature);
  const rarity = chooseRarity(user, seed, forceSrPlus, config);
  const themeCard = chooseCard(pool, rarity, seed);
  if (config.enabled && config.cardMode !== "fictional") {
    const image = await fetchDanbooruImageForRarity(feature, rarity, seed);
    if (image?.imageUrl) {
      const card = danbooruImageToCard(image, feature, rarity);
      const draw = recordGachaDraw(user, card, seed, nowIso());
      draw.queryTheme = publicWaifuCard(themeCard);
      draw.scoreBand = image.scoreBand || null;
      draw.archiveTags = image.archiveTags || [];
      draw.modelImageInstruction = `The card itself is a Danbooru post selected from the rolled rarity score band. ${GACHA_IMAGE_DELIVERY_RULE}`;
      return draw;
    }
    const fallback = recordGachaDraw(user, themeCard, seed, nowIso());
    if (image?.error) fallback.imageError = image.error;
    fallback.queryTheme = publicWaifuCard(themeCard);
    fallback.scoreBand = scoreBandForRarity(feature, rarity);
    fallback.modelInstruction = "Danbooru score-band post-card draw failed, so this result used the local fallback card pool.";
    return fallback;
  }
  return recordGachaDraw(user, themeCard, seed, nowIso());
}

function findWaifuCard(pool, id) {
  return pool.find((card) => card.id === id) || pool[0];
}

function bestWaifuDraw(results) {
  return [...results].sort((a, b) => {
    const rarity = RARITY_ORDER.indexOf(b.card.rarity) - RARITY_ORDER.indexOf(a.card.rarity);
    if (rarity !== 0) return rarity;
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
    return Number(b.affinity || 0) - Number(a.affinity || 0);
  })[0] || null;
}

async function attachDanbooruToDraw(feature, pool, draw) {
  if (draw?.image?.imageUrl || draw?.card?.sourceKind === "danbooru_post") return draw;
  const card = findWaifuCard(pool, draw?.card?.id);
  if (!card || !draw) return draw;
  const image = await fetchDanbooruImageForRarity(feature, draw?.card?.rarity || card.rarity || "N", `${draw.seed}:${card.id}`);
  if (image?.imageUrl) {
    draw.image = image;
    draw.modelImageInstruction = GACHA_IMAGE_DELIVERY_RULE;
  } else if (image?.error) {
    draw.imageError = image.error;
  }
  return draw;
}

function scoreBandLabel(band) {
  if (!isRecord(band)) return "";
  const min = Number(band.min || 0);
  const max = band.max === null || band.max === undefined ? null : Number(band.max);
  if (!Number.isFinite(min)) return "";
  return max === null || !Number.isFinite(max) ? `${min}+` : `${min}-${max}`;
}

function firstTags(tags, key, max = 2) {
  const values = Array.isArray(tags?.[key]) ? tags[key] : [];
  return values.map((tag) => String(tag || "").replace(/_/g, " ")).filter(Boolean).slice(0, max);
}

function cleanTagLabel(tag) {
  return String(tag || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function primaryImageTags(image, max = 3) {
  const tags = image?.tags || {};
  const generalStop = new Set([
    "1girl",
    "solo",
    "looking at viewer",
    "smile",
    "closed mouth",
    "simple background",
    "white background",
    "upper body",
    "portrait"
  ]);
  const selected = [];
  const add = (value) => {
    const label = cleanTagLabel(value);
    if (!label || generalStop.has(label.toLowerCase())) return;
    if (selected.some((item) => item.toLowerCase() === label.toLowerCase())) return;
    selected.push(label);
  };
  for (const tag of tags.character || []) add(tag);
  for (const tag of tags.copyright || []) add(tag);
  for (const tag of tags.artist || []) add(tag);
  for (const tag of tags.general || []) add(tag);
  return selected.slice(0, max);
}

function formatPrimaryTagLine(draw) {
  const tags = primaryImageTags(drawImage(draw));
  return tags.length ? `tag: ${tags.join(" / ")}` : "";
}

function rarityBadge(rarity) {
  const normalized = normalizeRarity(rarity);
  return `${RARITY_EMOJI[normalized] || ""} ${normalized}`.trim();
}

function drawImage(draw) {
  return draw?.image || draw?.card?.danbooru || {};
}

function drawScoreBand(draw) {
  return draw?.scoreBand || drawImage(draw)?.scoreBand || draw?.card?.danbooru?.scoreBand || null;
}

function formatDrawStatus(draw) {
  if (!draw) return "";
  return draw.isNew ? "NEW" : `重复 x${Math.max(1, Number(draw.duplicateCount || 1))}`;
}

function formatDrawTags(draw) {
  const image = drawImage(draw);
  const tags = image.tags || {};
  const parts = [];
  const characters = firstTags(tags, "character");
  const series = firstTags(tags, "copyright");
  const artists = firstTags(tags, "artist", 1);
  if (characters.length) parts.push(`角色: ${characters.join(" / ")}`);
  if (series.length) parts.push(`作品: ${series.join(" / ")}`);
  if (artists.length) parts.push(`画师: ${artists.join(" / ")}`);
  return parts.join(" | ");
}

function formatDrawLine(draw, index = 0) {
  const card = draw?.card || {};
  const image = drawImage(draw);
  const prefix = index > 0 ? `${String(index).padStart(2, "0")}. ` : "";
  const score = Number.isFinite(Number(image.score)) ? `score ${Number(image.score)}` : "";
  const post = image.postId ? `#${image.postId}` : "";
  const details = [score, post, formatDrawStatus(draw)].filter(Boolean).join(" | ");
  return `${prefix}${rarityBadge(card.rarity)} ${card.name || card.id || "Unknown"}${details ? ` | ${details}` : ""}`;
}

function formatSingleDrawText(draw, title = "你这次抽到的老婆是：") {
  const image = drawImage(draw);
  const card = draw?.card || {};
  const lines = [
    `${title}`,
    `${rarityBadge(card.rarity)} ${card.name || card.id || "Unknown"}`,
    [Number.isFinite(Number(image.score)) ? `score ${Number(image.score)}` : "", formatDrawStatus(draw), image.postId ? `#${image.postId}` : ""].filter(Boolean).join(" | "),
    formatPrimaryTagLine(draw),
    `亲和度 ${Number(draw?.affinity || 0) || "-"}`
  ].filter(Boolean);
  if (draw?.imageError) lines.push(`图片检索失败: ${draw.imageError}`);
  return lines.join("\n");
}

function formatMultiPullText(results, featured) {
  const count = Array.isArray(results) ? results.length : 0;
  const summary = Object.fromEntries(RARITY_ORDER.map((rarity) => [rarity, 0]));
  for (const draw of results || []) summary[normalizeRarity(draw?.card?.rarity)] += 1;
  const lines = [
    count === MAX_GACHA_DRAWS_PER_REQUEST ? "✨ 十连结果" : `✨ ${count} 抽结果`,
    RARITY_ORDER.slice().reverse().map((rarity) => `${RARITY_EMOJI[rarity]} ${rarity} x${summary[rarity] || 0}`).join("   "),
    "",
    ...results.map((draw, index) => formatDrawLine(draw, index + 1))
  ];
  if (featured) {
    lines.push(
      "",
      `本轮老婆：${formatDrawLine(featured).trim()}`,
      formatPrimaryTagLine(featured)
    );
  }
  return lines.join("\n");
}

function formatGachaCollectionText(user, cards) {
  const lines = [
    `${user.displayName || user.userId} 的图鉴`,
    `总抽数: ${user.totalDraws} | 独立卡: ${user.uniqueCards} | 分数: ${user.score} | 碎片: ${user.shards}`,
    ...cards.slice(0, 12).map((card, index) => `${index + 1}. [${card.rarity || "?"}] ${card.name || card.id} x${card.count || 1}${card.danbooruPostId ? ` #${card.danbooruPostId}` : ""}`)
  ];
  return lines.join("\n");
}

function formatGachaLeaderboardText(users) {
  const lines = [
    "老婆图鉴榜",
    ...users.map((user, index) => `${index + 1}. ${user.displayName || user.userName || user.userId}: ${user.score}分 / ${user.uniqueCards}卡 / ${user.totalDraws}抽`)
  ];
  return lines.join("\n");
}

function gachaRarityCountsFromCollection(collection) {
  const counts = Object.fromEntries(RARITY_ORDER.map((rarity) => [rarity, 0]));
  for (const card of Object.values(isRecord(collection) ? collection : {})) {
    const rarity = normalizeRarity(card?.rarity);
    counts[rarity] = Number(counts[rarity] || 0) + 1;
  }
  return counts;
}

function gachaRecentHistory(record, count = 8) {
  const history = Array.isArray(record?.history) ? record.history : [];
  return history.slice(-count).reverse().map((item) => ({
    t: item.t || "",
    cardId: item.cardId || "",
    rarity: item.rarity || "",
    sourceKind: item.sourceKind || "",
    danbooruPostId: item.danbooruPostId || null,
    isNew: Boolean(item.isNew)
  }));
}

function gachaHighestRarity(record) {
  const counts = gachaRarityCountsFromCollection(record?.collection);
  return RARITY_ORDER.slice().reverse().find((rarity) => Number(counts[rarity] || 0) > 0) || "";
}

function publicGachaProfile(record) {
  const user = publicGachaUser(record);
  return {
    ...user,
    rarityCounts: gachaRarityCountsFromCollection(record?.collection),
    highestRarity: gachaHighestRarity(record),
    recent: gachaRecentHistory(record, 8)
  };
}

function formatGachaProfileText(profile) {
  const counts = profile.rarityCounts || {};
  return [
    `${profile.displayName || profile.userName || profile.userId} gacha profile`,
    `draws ${profile.totalDraws} | unique ${profile.uniqueCards} | score ${profile.score} | shards ${profile.shards}`,
    `pity SSR ${profile.pitySSR} | pity UR ${profile.pityUR}`,
    `rarity: ${RARITY_ORDER.slice().reverse().map((rarity) => `${rarity} x${counts[rarity] || 0}`).join(" / ")}`,
    profile.highestRarity ? `highest: ${profile.highestRarity}` : "",
    profile.recent?.length ? `recent: ${profile.recent.map((item) => `${item.rarity}:${item.cardId || "?"}${item.isNew ? ":NEW" : ""}`).join(", ")}` : ""
  ].filter(Boolean).join("\n");
}

function publicGachaStats(state) {
  const users = Object.values(isRecord(state?.users) ? state.users : {}).filter(isRecord);
  const rarityCounts = Object.fromEntries(RARITY_ORDER.map((rarity) => [rarity, 0]));
  let totalDraws = 0;
  let totalUniqueCards = 0;
  let totalScore = 0;
  let totalShards = 0;
  for (const user of users) {
    totalDraws += Number(user.totalDraws || 0);
    totalUniqueCards += Object.keys(isRecord(user.collection) ? user.collection : {}).length;
    totalScore += Number(user.score || 0);
    totalShards += Number(user.shards || 0);
    const counts = gachaRarityCountsFromCollection(user.collection);
    for (const rarity of RARITY_ORDER) rarityCounts[rarity] += Number(counts[rarity] || 0);
  }
  const history = Array.isArray(state?.history) ? state.history : [];
  const recent = history.slice(-12).reverse().map((item) => ({
    t: item.t || "",
    userId: item.userId || "",
    action: item.action || "",
    count: Number(item.count || 0),
    topRarity: item.topRarity || ""
  }));
  return {
    users: users.length,
    totalDraws,
    totalUniqueCards,
    totalScore,
    totalShards,
    rarityCounts,
    recent
  };
}

function formatGachaStatsText(stats) {
  return [
    "gacha lab stats",
    `users ${stats.users} | draws ${stats.totalDraws} | unique-owned ${stats.totalUniqueCards}`,
    `score ${stats.totalScore} | shards ${stats.totalShards}`,
    `rarity: ${RARITY_ORDER.slice().reverse().map((rarity) => `${rarity} x${stats.rarityCounts?.[rarity] || 0}`).join(" / ")}`,
    stats.recent?.length ? `recent batches: ${stats.recent.map((item) => `${item.topRarity || "?"}x${item.count || 0}`).join(", ")}` : ""
  ].filter(Boolean).join("\n");
}

function archiveCaptionForDraw(draw) {
  const image = drawImage(draw);
  const card = draw?.card || {};
  const tags = Array.isArray(image.archiveTags) ? image.archiveTags : Array.isArray(draw?.archiveTags) ? draw.archiveTags : [];
  const hashTags = tags.map((tag) => `#${archiveSafeTag(tag)}`).filter((tag) => tag.length > 1).slice(0, 18).join(" ");
  return [
    `[${card.rarity || "?"}] ${card.name || card.id || "Unknown"}`,
    `post ${image.postId || "unknown"} | score ${image.score ?? "?"} | band ${scoreBandLabel(drawScoreBand(draw)) || "?"}`,
    formatDrawTags(draw),
    hashTags
  ].filter(Boolean).join("\n");
}

function publicDanbooruImage(image) {
  if (!image?.imageUrl) return null;
  return {
    provider: image.provider || "danbooru",
    postId: image.postId || null,
    pageUrl: image.pageUrl || "",
    imageUrl: image.imageUrl,
    imageQuality: image.imageQuality || "",
    score: image.score ?? null,
    favCount: image.favCount ?? null,
    width: image.width || 0,
    height: image.height || 0,
    scoreBand: image.scoreBand || null,
    primaryTags: primaryImageTags(image),
    characterTags: image.tags?.character || [],
    copyrightTags: image.tags?.copyright || [],
    artistTags: image.tags?.artist || [],
    archiveTags: image.archiveTags || [],
    tagString: image.tagString || ""
  };
}

function publicGachaDraw(draw) {
  if (!isRecord(draw)) return draw;
  const result = {
    card: publicWaifuCard(draw.card || {}),
    isNew: Boolean(draw.isNew),
    duplicateCount: Number(draw.duplicateCount || 0),
    affinity: Number(draw.affinity || 0),
    seed: draw.seed || ""
  };
  const image = publicDanbooruImage(drawImage(draw));
  if (image) result.image = image;
  if (draw.scoreBand) result.scoreBand = draw.scoreBand;
  if (draw.imageError) result.imageError = draw.imageError;
  if (draw.modelImageInstruction) result.modelImageInstruction = draw.modelImageInstruction;
  return result;
}

function deliveryImageForDraw(draw, index = 0) {
  const image = drawImage(draw);
  if (!image?.imageUrl) return null;
  return {
    index: index + 1,
    name: draw?.card?.name || draw?.card?.id || "",
    rarity: draw?.card?.rarity || "",
    imageUrl: image.imageUrl,
    pageUrl: image.pageUrl || "",
    postId: image.postId || null,
    score: image.score ?? null,
    scoreBand: drawScoreBand(draw),
    imageQuality: image.imageQuality || "",
    primaryTags: primaryImageTags(image),
    characterTags: image.tags?.character || [],
    copyrightTags: image.tags?.copyright || [],
    artistTags: image.tags?.artist || [],
    archiveTags: image.archiveTags || [],
    tagString: image.tagString || ""
  };
}

function gachaResultImages(draws) {
  const list = Array.isArray(draws) ? draws : [draws];
  return list.map((draw, index) => deliveryImageForDraw(draw, index)).filter(Boolean);
}

function gachaDeliveryReview(resultImages = [], archive = null) {
  return {
    mode: "script_cache",
    policy: "Gacha media caching and channel archival are handled by the feature tool. Use albumMedia/MEDIA lines when present.",
    fallback: "If archiveMedia is empty, send the returned image URL(s) or explain the image fetch/archive failure briefly.",
    archiveTool: GACHA_ARCHIVE_TOOL,
    imageCount: resultImages.length,
    archivedCount: Number(archive?.ok || 0),
    channelOk: Number(archive?.channelOk || 0)
  };
}

const GACHA_IMAGE_DELIVERY_RULE =
  "For gacha images, use replyText as the factual body and albumMedia/MEDIA lines as the sendable image output. The feature tool handles local/channel cache. Do not use image_generate for gacha art unless the user asks to redraw or make a derivative.";

function readMergedString(params, metadata, key, fallback = "") {
  return readString(params, key) || readString(metadata, key, fallback);
}

function readMergedBoolean(params, metadata, key, fallback = false) {
  if (isRecord(params) && params[key] !== undefined) return readBoolean(params, key, fallback);
  return readBoolean(metadata, key, fallback);
}

function readMergedNumber(params, metadata, key, fallback = null) {
  const source = isRecord(params) && params[key] !== undefined ? params : metadata;
  return readNumber(source, key, fallback, -1_000_000_000, 1_000_000_000);
}

function readArchiveTagList(params, metadata, key = "primaryTags", limit = 8) {
  const raw = isRecord(params) && params[key] !== undefined ? params[key] : metadata?.[key];
  if (Array.isArray(raw)) return raw.map((tag) => String(tag || "").trim()).filter(Boolean).slice(0, limit);
  if (typeof raw === "string") return raw.split(/[,\s|/#]+/g).map((tag) => tag.trim()).filter(Boolean).slice(0, limit);
  return [];
}

function telegramCaption(text) {
  const value = String(text || "").replace(/\r\n/g, "\n").trim();
  return value.length <= 950 ? value : `${value.slice(0, 940).trimEnd()}...`;
}

function isExplicitSafeStatus(value) {
  return /(^|[-_\s])(r18|nsfw|explicit|adult|porn)([-_\s]|$)/i.test(String(value || ""));
}

function buildGachaArchiveCaption(meta, archiveId) {
  const scoreValue = Number(meta.score);
  const scoreHashTag = Number.isFinite(scoreValue)
    ? scoreValue >= 300 ? "score_300_plus"
      : scoreValue >= 101 ? "score_101_299"
        : scoreValue >= 51 ? "score_51_100"
          : scoreValue >= 31 ? "score_31_50"
            : "score_20_30"
    : "";
  const title = [
    meta.rarity ? `[${meta.rarity}]` : "",
    meta.name || "Waifu Gacha"
  ].filter(Boolean).join(" ");
  const facts = [
    meta.postId ? `Post ${meta.postId}` : "",
    Number.isFinite(scoreValue) ? `Score ${scoreValue}` : "",
    meta.spoiler ? "Spoiler" : meta.safeStatus ? `Status ${meta.safeStatus}` : ""
  ].filter(Boolean).join(" | ");
  const humanTags = (label, tags) => Array.isArray(tags) && tags.length
    ? `${label}: ${tags.slice(0, 8).join(" / ")}`
    : "";
  const archiveTags = Array.isArray(meta.archiveTags)
    ? meta.archiveTags.filter((tag) => /^[a-z0-9_]/i.test(String(tag || "").trim()))
    : [];
  const autoTags = [
    "waifu_gacha",
    meta.rarity ? `rarity_${meta.rarity}` : "",
    meta.postId ? `post_${meta.postId}` : "",
    scoreHashTag,
    ...(Array.isArray(meta.characterTags) ? meta.characterTags.map((tag) => `character_${tag}`) : []),
    ...(Array.isArray(meta.copyrightTags) ? meta.copyrightTags.map((tag) => `series_${tag}`) : []),
    ...(Array.isArray(meta.artistTags) ? meta.artistTags.map((tag) => `artist_${tag}`) : []),
    ...(Array.isArray(meta.primaryTags) ? meta.primaryTags : []),
    ...archiveTags
  ];
  const tags = [...new Set(autoTags.map(archiveSafeTag).filter(Boolean))]
    .slice(0, 22)
    .map((tag) => `#${tag}`)
    .join(" ");
  return telegramCaption([
    "Waifu Gacha Archive",
    title,
    facts,
    humanTags("Character", meta.characterTags),
    humanTags("Series", meta.copyrightTags),
    humanTags("Artist", meta.artistTags),
    humanTags("Tags", meta.primaryTags),
    meta.pageUrl ? `Post URL: ${meta.pageUrl}` : "",
    meta.sourceUrl ? `Source: ${meta.sourceUrl}` : "",
    tags,
    `Archive ID: ${archiveId}`
  ].filter(Boolean).join("\n"));
}

function telegramArchiveFileId(result) {
  if (Array.isArray(result?.photo) && result.photo.length) {
    return result.photo[result.photo.length - 1]?.file_id || "";
  }
  return result?.document?.file_id || result?.animation?.file_id || "";
}

function parseRetryDelaysMs(value, fallback = GACHA_ARCHIVE_TELEGRAM_RETRY_DELAYS_MS) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[,\s]+/).filter(Boolean);
  const parsed = raw
    .map((entry) => Math.trunc(Number(entry)))
    .filter((entry) => Number.isFinite(entry) && entry >= 0)
    .map((entry) => Math.min(120000, entry));
  return parsed.length ? parsed.slice(0, 8) : fallback;
}

function telegramArchiveRetryDelays(config) {
  const archiveConfig = gachaArchiveConfig(config);
  return parseRetryDelaysMs(
    archiveConfig.telegramRetryDelaysMs ?? archiveConfig.retryDelaysMs,
    GACHA_ARCHIVE_TELEGRAM_RETRY_DELAYS_MS
  );
}

function telegramArchiveRetryAfterMs(payload, fallbackMs) {
  const retryAfter = Number(payload?.parameters?.retry_after);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(120000, Math.max(0, Math.ceil(retryAfter * 1000)));
  }
  return fallbackMs;
}

function isRetryableTelegramArchiveFailure({ status = 0, message = "", aborted = false } = {}) {
  if (aborted) return true;
  if (status === 408 || status === 409 || status === 421 || status === 425 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return /network request.*failed|fetch failed|network|timeout|timed out|ECONN|ETIMEDOUT|EAI_AGAIN|ECONNRESET|socket hang up/i.test(String(message || ""));
}

function archiveChannelId(config) {
  const archiveConfig = gachaArchiveConfig(config);
  return String(archiveConfig.channelChatId || archiveConfig.channelId || "").trim();
}

function archiveTokenFile(config) {
  const archiveConfig = gachaArchiveConfig(config);
  const configured = String(archiveConfig.tokenFile || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "secrets", "telegram-imagebot.token"));
}

async function sendGachaArchiveToTelegram(config, archive) {
  const archiveConfig = gachaArchiveConfig(config);
  if (archiveConfig.enabled === false) return { status: "skipped:disabled" };
  const chatId = archiveChannelId(config);
  if (!chatId) return { status: "skipped:not_configured" };
  let token = "";
  try {
    token = (await fs.readFile(archiveTokenFile(config), "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "skipped:no_token" };
    return { status: "failed", error: clip(error.message || error) };
  }
  if (!token) return { status: "skipped:no_token" };

  const sendMode = String(archiveConfig.sendMode || "auto").trim().toLowerCase();
  const canSendPhoto = archive.sizeBytes <= 10 * 1024 * 1024 && archive.mimeType !== "image/gif";
  const method = sendMode === "document" || (!canSendPhoto && sendMode !== "photo") ? "sendDocument" : "sendPhoto";
  const field = method === "sendDocument" ? "document" : "photo";
  const timeoutMs = Math.max(5000, Math.min(120000, Number(archiveConfig.telegramTimeoutMs || 30000)));
  const retryDelays = telegramArchiveRetryDelays(config);
  const errors = [];
  const data = await fs.readFile(archive.localPath);
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    const attemptNumber = attempt + 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("telegram archive send timeout")), timeoutMs);
    try {
      const form = new FormData();
      form.set("chat_id", chatId);
      form.set("caption", telegramCaption(archive.caption || ""));
      form.set("disable_notification", "true");
      if (archive.spoiler === true && method === "sendPhoto") form.set("has_spoiler", "true");
      form.set(field, new Blob([data], { type: archive.mimeType || "application/octet-stream" }), path.basename(archive.localPath));
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        body: form,
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        const errorMessage = clip(payload?.description || response.statusText || `HTTP ${response.status}`);
        errors.push({ attempt: attemptNumber, status: response.status, error: errorMessage });
        const retryable = isRetryableTelegramArchiveFailure({
          status: response.status,
          message: errorMessage
        });
        if (attempt < retryDelays.length && retryable) {
          clearTimeout(timer);
          await wait(telegramArchiveRetryAfterMs(payload, retryDelays[attempt]));
          continue;
        }
        return {
          status: "failed",
          method,
          attempts: attemptNumber,
          errors,
          error: errorMessage
        };
      }
      return {
        status: "ok",
        method,
        chatId,
        messageId: payload?.result?.message_id || null,
        fileId: telegramArchiveFileId(payload?.result),
        attempts: attemptNumber
      };
    } catch (error) {
      const errorMessage = clip(error?.message || error);
      errors.push({ attempt: attemptNumber, error: errorMessage });
      const retryable = isRetryableTelegramArchiveFailure({
        message: errorMessage,
        aborted: controller.signal.aborted
      });
      if (attempt < retryDelays.length && retryable) {
        clearTimeout(timer);
        await wait(retryDelays[attempt]);
        continue;
      }
      return {
        status: "failed",
        method,
        attempts: attemptNumber,
        errors,
        error: errorMessage
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    status: "failed",
    method,
    attempts: retryDelays.length + 1,
    errors,
    error: "telegram archive send failed"
  };
}

function archiveMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function archiveRecordMonthKey(archive) {
  const candidate = archive?.t ? new Date(archive.t) : new Date();
  return Number.isNaN(candidate.getTime()) ? archiveMonthKey() : archiveMonthKey(candidate);
}

async function ensureGachaArchiveSendCopy(config, archive) {
  if (!isRecord(archive) || !archive.localPath) throw new Error("archive localPath is required");
  const existing = String(archive.sendPath || "").trim();
  if (existing) {
    try {
      await fs.access(existing);
      return existing;
    } catch {
      // Rebuild the sendable copy below.
    }
  }
  const ext = path.extname(archive.localPath).toLowerCase() || ".jpg";
  const sendDir = path.join(gachaArchiveSendRoot(config), archiveRecordMonthKey(archive));
  const baseName = archiveSafeName([
    archive.rarity,
    archive.postId ? `post-${archive.postId}` : "",
    archive.name || archive.archiveId || "waifu"
  ].filter(Boolean).join("-"), "waifu");
  const suffix = String(archive.sha256 || archive.archiveId || "media").slice(0, 10);
  const sendPath = path.join(sendDir, `${baseName}-${suffix}${ext}`);
  await fs.mkdir(sendDir, { recursive: true });
  if (path.resolve(archive.localPath).toLowerCase() !== path.resolve(sendPath).toLowerCase()) {
    await fs.copyFile(archive.localPath, sendPath);
  }
  archive.sendPath = sendPath;
  return sendPath;
}

async function runGachaArchive(config, params) {
  const metadata = readObject(params, "metadata");
  const archiveConfig = gachaArchiveConfig(config);
  const sendToChannelDefault = archiveConfig.sendToChannelDefault === true;
  const rawMedia = readString(params, "media") || readString(params, "path") || readString(params, "image");
  const media = await resolveArchiveMediaInput(config, rawMedia);
  const digest = await sha256File(media.path);
  const postId = readMergedString(params, metadata, "postId");
  const name = readMergedString(params, metadata, "name") || readMergedString(params, metadata, "title");
  const rarity = normalizeRarity(readMergedString(params, metadata, "rarity", ""));
  const safeStatus = readMergedString(params, metadata, "safeStatus", "unknown").toLowerCase();
  const censored = readMergedBoolean(params, metadata, "censored", false);
  const spoiler = readMergedBoolean(params, metadata, "spoiler", isExplicitSafeStatus(safeStatus));

  const primaryTags = readArchiveTagList(params, metadata);
  const archiveTags = readArchiveTagList(params, metadata, "archiveTags", 24);
  const characterTags = readArchiveTagList(params, metadata, "characterTags", 12);
  const copyrightTags = readArchiveTagList(params, metadata, "copyrightTags", 8);
  const artistTags = readArchiveTagList(params, metadata, "artistTags", 8);
  const score = readMergedNumber(params, metadata, "score", null);
  const batchId = readMergedString(params, metadata, "batchId");
  const archiveId = postId
    ? `danbooru-${archiveSafeName(postId, "post")}-${digest.slice(0, 10)}`
    : `media-${digest.slice(0, 16)}`;
  const root = gachaArchiveRoot(config);
  const recordsDir = path.join(root, "records");
  const recordPath = path.join(recordsDir, `${archiveId}.json`);
  const destinationDir = path.join(root, "media", archiveMonthKey());
  const baseName = archiveSafeName([rarity, postId ? `post-${postId}` : "", name || "waifu"].filter(Boolean).join("-"), "waifu");
  const destination = path.join(destinationDir, `${baseName}-${digest.slice(0, 10)}${media.ext}`);

  let previous = await readJson(recordPath, null);
  if (isRecord(previous) && previous.localPath) {
    try {
      await fs.access(previous.localPath);
    } catch {
      previous = null;
    }
  }
  if (isRecord(previous) && previous.localPath) {
    previous.duplicate = true;
    if (previous.spoiler !== true && isExplicitSafeStatus(previous.safeStatus)) previous.spoiler = true;
    const sendPathBefore = previous.sendPath || "";
    await ensureGachaArchiveSendCopy(config, previous);
    let shouldPersistPrevious = previous.sendPath !== sendPathBefore;
    if (readMergedBoolean(params, metadata, "sendToChannel", sendToChannelDefault) && previous.channel?.status !== "ok") {
      const resent = await sendGachaArchiveToTelegram(config, previous);
      previous.channel = resent;
      shouldPersistPrevious = true;
    }
    if (shouldPersistPrevious) {
      previous.updatedAt = nowIso();
      await writeJsonAtomic(recordPath, previous);
      await appendJsonLine(gachaArchiveIndexPath(config), previous);
    }
    return previous;
  }

  await fs.mkdir(destinationDir, { recursive: true });
  if (path.resolve(media.path).toLowerCase() !== path.resolve(destination).toLowerCase()) {
    await fs.copyFile(media.path, destination);
  }
  const finalStat = await fs.stat(destination);
  const archive = {
    archiveId,
    t: nowIso(),
    batchId,
    postId: postId || null,
    name: name || "",
    rarity,
    score,
    pageUrl: readMergedString(params, metadata, "pageUrl"),
    sourceUrl: readMergedString(params, metadata, "sourceUrl") || readMergedString(params, metadata, "imageUrl"),
    primaryTags,
    archiveTags,
    characterTags,
    copyrightTags,
    artistTags,
    tagString: readMergedString(params, metadata, "tagString"),
    safeStatus,
    censored,
    spoiler,
    userId: normalizedIdentity(readMergedString(params, metadata, "userId")),
    chatId: readMergedString(params, metadata, "chatId"),
    displayName: readMergedString(params, metadata, "displayName"),
    originalPath: media.path,
    localPath: destination,
    sendPath: "",
    sizeBytes: finalStat.size,
    mimeType: media.mimeType,
    sha256: digest,
    caption: telegramCaption(readMergedString(params, metadata, "caption") || buildGachaArchiveCaption({
      postId,
      name,
      rarity,
      score,
      pageUrl: readMergedString(params, metadata, "pageUrl"),
      sourceUrl: readMergedString(params, metadata, "sourceUrl") || readMergedString(params, metadata, "imageUrl"),
      primaryTags,
      archiveTags,
      characterTags,
      copyrightTags,
      artistTags,
      tagString: readMergedString(params, metadata, "tagString"),
      safeStatus,
      censored,
      spoiler
    }, archiveId))
  };
  await ensureGachaArchiveSendCopy(config, archive);
  archive.channel = readMergedBoolean(params, metadata, "sendToChannel", sendToChannelDefault)
    ? await sendGachaArchiveToTelegram(config, archive)
    : { status: "skipped:send_disabled" };
  await writeJsonAtomic(recordPath, archive);
  await appendJsonLine(gachaArchiveIndexPath(config), archive);
  return archive;
}

function mediaLine(filePath) {
  return filePath ? `MEDIA: \`${filePath}\`` : "";
}

function extFromUrl(value) {
  try {
    return path.extname(new URL(String(value || "")).pathname);
  } catch {
    return "";
  }
}

function archiveInputExtFromImage(image) {
  const candidates = [
    image?.fileExt,
    image?.selectedVariant?.fileExt,
    extFromUrl(image?.imageUrl),
    extFromUrl(image?.originalUrl)
  ];
  for (const candidate of candidates) {
    const ext = String(candidate || "").trim().toLowerCase();
    const normalized = ext.startsWith(".") ? ext : ext ? `.${ext}` : "";
    if (ARCHIVE_IMAGE_EXTS.has(normalized)) return normalized;
  }
  return ".jpg";
}

function archiveInputMimeFromResponse(response, ext) {
  const contentType = String(response?.headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType === "image/jpeg" || contentType === "image/png" || contentType === "image/webp" || contentType === "image/gif") {
    return contentType;
  }
  return ARCHIVE_MIME.get(ext) || "image/jpeg";
}

async function downloadGachaArchiveInput(config, draw, batchId, index) {
  const image = drawImage(draw);
  const url = String(image?.imageUrl || "").trim();
  if (!url) throw new Error("gacha draw has no imageUrl");
  const controller = new AbortController();
  const archiveConfig = gachaArchiveConfig(config);
  const timeoutMs = Math.max(5000, Math.min(120000, Number(archiveConfig.downloadTimeoutMs || 30000)));
  const timer = setTimeout(() => controller.abort(new Error("gacha archive download timeout")), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": DANBOORU_USER_AGENT,
        ...(image.pageUrl ? { Referer: image.pageUrl } : {})
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`download failed HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > GACHA_ARCHIVE_MAX_BYTES) throw new Error("downloaded image is larger than 50 MB");
    const ext = archiveInputExtFromImage(image);
    const mimeType = archiveInputMimeFromResponse(response, ext);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > GACHA_ARCHIVE_MAX_BYTES) throw new Error("downloaded image is larger than 50 MB");
    const dir = path.join(gachaArchiveRoot(config), "incoming", archiveMonthKey());
    await fs.mkdir(dir, { recursive: true });
    const baseName = archiveSafeName([
      batchId,
      String(index + 1).padStart(2, "0"),
      draw?.card?.rarity || "",
      image.postId ? `post-${image.postId}` : "",
      draw?.card?.name || "waifu"
    ].filter(Boolean).join("-"), "waifu");
    const filePath = path.join(dir, `${baseName}${ext}`);
    await fs.writeFile(filePath, data);
    return { path: filePath, mimeType, sizeBytes: data.length };
  } finally {
    clearTimeout(timer);
  }
}

function gachaArchiveParamsForDraw(draw, batchId, identity, mediaPath) {
  const image = drawImage(draw);
  const card = draw?.card || {};
  return {
    media: mediaPath,
    batchId,
    postId: image.postId ? String(image.postId) : "",
    name: card.name || "",
    rarity: card.rarity || "",
    score: Number.isFinite(Number(image.score)) ? Number(image.score) : undefined,
    pageUrl: image.pageUrl || "",
    sourceUrl: image.imageUrl || image.originalUrl || image.largeUrl || "",
    imageUrl: image.imageUrl || "",
    primaryTags: primaryImageTags(image),
    archiveTags: image.archiveTags || buildDanbooruArchiveTags(image, card.rarity),
    characterTags: image.tags?.character || [],
    copyrightTags: image.tags?.copyright || [],
    artistTags: image.tags?.artist || [],
    tagString: image.tagString || "",
    safeStatus: image.rating === "g" || !image.rating ? "clear" : String(image.rating),
    spoiler: image.rating !== "g" && Boolean(image.rating),
    censored: false,
    sendToChannel: true,
    userId: identity.userId || "",
    displayName: identity.displayName || "",
    chatId: identity.chatId || ""
  };
}

async function mapLimit(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(list[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length || 1)) }, worker));
  return results;
}

async function archiveOneGachaDraw(config, draw, batchId, identity, index) {
  const image = drawImage(draw);
  if (!image?.imageUrl) {
    return {
      index: index + 1,
      status: "skipped:no_image",
      name: draw?.card?.name || "",
      rarity: draw?.card?.rarity || ""
    };
  }
  try {
    const downloaded = await downloadGachaArchiveInput(config, draw, batchId, index);
    const archive = await runGachaArchive(config, gachaArchiveParamsForDraw(draw, batchId, identity, downloaded.path));
    return {
      index: index + 1,
      status: "ok",
      archiveId: archive.archiveId,
      name: archive.name || draw?.card?.name || "",
      rarity: archive.rarity || draw?.card?.rarity || "",
      postId: archive.postId || image.postId || null,
      score: archive.score ?? image.score ?? null,
      media: mediaLine(archive.sendPath || archive.localPath),
      localPath: archive.sendPath || archive.localPath,
      channelStatus: archive.channel?.status || "unknown",
      channelMessageId: archive.channel?.messageId || null,
      duplicate: Boolean(archive.duplicate)
    };
  } catch (error) {
    return {
      index: index + 1,
      status: "failed",
      name: draw?.card?.name || "",
      rarity: draw?.card?.rarity || "",
      postId: image.postId || null,
      error: clip(error?.message || error)
    };
  }
}

async function archiveGachaDraws(config, draws, batchId, identity) {
  const list = Array.isArray(draws) ? draws : [draws];
  const archiveConfig = gachaArchiveConfig(config);
  if (archiveConfig.enabled === false) {
    return { mode: "script_cache", status: "skipped:disabled", items: [], media: [], ok: 0, failed: 0, channelOk: 0 };
  }
  const concurrency = Math.max(1, Math.min(4, Math.trunc(Number(archiveConfig.drawArchiveConcurrency || 3))));
  const items = await mapLimit(list, concurrency, (draw, index) => archiveOneGachaDraw(config, draw, batchId, identity, index));
  const okItems = items.filter((item) => item?.status === "ok");
  const failedItems = items.filter((item) => item && item.status !== "ok" && !String(item.status || "").startsWith("skipped"));
  return {
    mode: "script_cache",
    status: failedItems.length ? "partial" : "ok",
    ok: okItems.length,
    failed: failedItems.length,
    skipped: items.filter((item) => String(item?.status || "").startsWith("skipped")).length,
    channelOk: okItems.filter((item) => item.channelStatus === "ok").length,
    media: okItems.map((item) => item.media).filter(Boolean),
    items
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function gachaRequestKey(identity, action, requestLimit, payload) {
  return hash(stableJson({
    feature: "waifu_gacha",
    action: action.id,
    userId: normalizedIdentity(identity.userId),
    chatId: identity.chatId || "",
    requestedCount: requestLimit?.requestedCount || 1,
    appliedCount: requestLimit?.appliedCount || 1,
    payload: payload || {}
  }), 24);
}

function isDuplicateControlledGacha(action, requestLimit) {
  if (!action || !requestLimit) return false;
  return action.id === "ten_pull" || Number(requestLimit.requestedCount || 1) > 1 || Number(requestLimit.appliedCount || 1) > 1;
}

function pruneRecentGachaRequests(state, now = Date.now()) {
  state.recentRequests = isRecord(state.recentRequests) ? state.recentRequests : {};
  for (const [key, entry] of Object.entries(state.recentRequests)) {
    if (!isRecord(entry) || now - Number(entry.t || 0) > GACHA_DUPLICATE_REQUEST_TTL_MS) delete state.recentRequests[key];
  }
}

function cachedDuplicateGachaResult(state, requestKey, now = Date.now()) {
  pruneRecentGachaRequests(state, now);
  const entry = state.recentRequests?.[requestKey];
  if (!isRecord(entry) || !isRecord(entry.result)) return null;
  const ageSeconds = Math.max(0, Math.round((now - Number(entry.t || now)) / 1000));
  return {
    kind: "waifu_gacha_duplicate_request",
    batchId: entry.result.batchId || "",
    count: Number(entry.result.count || 0),
    duplicateRequest: true,
    suppressFinalReply: true,
    requestLimit: entry.result.requestLimit || null,
    requestControl: {
      duplicate: true,
      ageSeconds,
      ttlSeconds: Math.round(GACHA_DUPLICATE_REQUEST_TTL_MS / 1000),
      message: "Same gacha multi-draw request was already executed recently; duplicate tool call suppressed without drawing or returning media again."
    },
    replyText: "Duplicate multi-draw request suppressed. Do not repeat the previous pull result.",
    modelInstruction: "Duplicate gacha tool call suppressed. Do not repeat the previous pull text or media. If the user needs a resend after delivery failure, use archive/gallery resend instead of drawing again."
  };
}

function duplicateGachaRequestResultFromLock(lock, now = Date.now()) {
  const ageSeconds = Math.max(0, Math.round((now - Number(lock?.t || now)) / 1000));
  return {
    kind: "waifu_gacha_duplicate_request",
    batchId: "",
    count: 0,
    duplicateRequest: true,
    suppressFinalReply: true,
    requestLimit: lock?.requestLimit || null,
    requestControl: {
      duplicate: true,
      inProgress: lock?.status === "in_progress",
      ageSeconds,
      ttlSeconds: Math.round(GACHA_DUPLICATE_REQUEST_TTL_MS / 1000),
      message: "Same gacha multi-draw request is already running or was already accepted recently; duplicate tool call suppressed before drawing."
    },
    replyText: "Duplicate multi-draw request suppressed. Do not call the gacha tool again for the same request.",
    modelInstruction: "Duplicate gacha tool call suppressed by the tool-layer request lock. Stop calling feature_action for this gacha request."
  };
}

async function claimGachaRequest(config, requestKey, meta = {}, now = Date.now()) {
  const dir = gachaRequestLocksDir(config);
  const lockPath = gachaRequestLockPath(config, requestKey);
  await fs.mkdir(dir, { recursive: true });
  const payload = {
    t: now,
    status: "in_progress",
    requestKey,
    ...meta
  };
  try {
    const handle = await fs.open(lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(payload, null, 2), "utf8");
    } finally {
      await handle.close();
    }
    return { claimed: true, lockPath, lock: payload };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readJson(lockPath, null);
    const age = now - Number(existing?.t || 0);
    if (!isRecord(existing) || age > GACHA_REQUEST_LOCK_STALE_MS) {
      await fs.unlink(lockPath).catch(() => {});
      return claimGachaRequest(config, requestKey, meta, now);
    }
    return { claimed: false, lockPath, lock: existing };
  }
}

async function completeGachaRequestClaim(lockPath) {
  const existing = await readJson(lockPath, null);
  if (!isRecord(existing)) return;
  existing.status = "complete";
  existing.completedAt = nowIso();
  await writeJsonAtomic(lockPath, existing);
}

async function releaseGachaRequestClaim(lockPath) {
  if (lockPath) await fs.unlink(lockPath).catch(() => {});
}

function rememberGachaRequest(state, requestKey, result, now = Date.now()) {
  pruneRecentGachaRequests(state, now);
  state.recentRequests[requestKey] = {
    t: now,
    result
  };
}

function gachaBatchId(identity, action, count) {
  return hash(`${identity.userId || "unknown"}:${identity.chatId || ""}:${action.id}:${count}:${Date.now()}:${randomSeed()}`, 18);
}

async function appendGachaDrawEvents(config, { batchId, actionId, identity, requestLimit, results }) {
  const draws = Array.isArray(results) ? results : [results].filter(Boolean);
  for (let index = 0; index < draws.length; index += 1) {
    const draw = draws[index];
    const image = drawImage(draw);
    await appendJsonLine(gachaDrawEventsPath(config), {
      t: nowIso(),
      batchId,
      action: actionId,
      index: index + 1,
      count: draws.length,
      userId: identity.userId || "",
      userName: identity.userName || "",
      displayName: identity.displayName || "",
      chatId: identity.chatId || "",
      requestedCount: requestLimit?.requestedCount || draws.length,
      appliedCount: requestLimit?.appliedCount || draws.length,
      limited: Boolean(requestLimit?.limited),
      cardId: draw?.card?.id || "",
      cardName: draw?.card?.name || "",
      rarity: draw?.card?.rarity || "",
      isNew: Boolean(draw?.isNew),
      duplicateCount: Number(draw?.duplicateCount || 0),
      affinity: Number(draw?.affinity || 0),
      seed: draw?.seed || "",
      score: image.score ?? null,
      scoreBand: drawScoreBand(draw),
      postId: image.postId || null,
      pageUrl: image.pageUrl || "",
      imageUrl: image.imageUrl || "",
      imageQuality: image.imageQuality || "",
      width: image.width || 0,
      height: image.height || 0,
      primaryTags: primaryImageTags(image),
      characterTags: image.tags?.character || [],
      copyrightTags: image.tags?.copyright || [],
      artistTags: image.tags?.artist || [],
      archiveTags: image.archiveTags || [],
      sourceKind: draw?.card?.sourceKind || "fictional"
    });
  }
}

function readGachaDrawRequest(action, payload) {
  const requested = action.id === "ten_pull"
    ? Math.max(MAX_GACHA_DRAWS_PER_REQUEST, readNumber({ count: payload.count }, "count", MAX_GACHA_DRAWS_PER_REQUEST, 1, 9999))
    : readNumber({ count: payload.count }, "count", 1, 1, 9999);
  const count = Math.min(MAX_GACHA_DRAWS_PER_REQUEST, Math.max(1, requested));
  return {
    requestedCount: requested,
    appliedCount: count,
    maxDraws: MAX_GACHA_DRAWS_PER_REQUEST,
    limited: requested > MAX_GACHA_DRAWS_PER_REQUEST,
    reason: requested > MAX_GACHA_DRAWS_PER_REQUEST ? "single feature_action execution is capped at one ten-pull" : ""
  };
}

function requestLimitNotice(limit) {
  return limit?.limited ? `本次最多十连，已按 ${limit.appliedCount}/${limit.requestedCount} 抽处理。` : "";
}

async function runWaifuGacha(config, feature, action, identity, payload) {
  const filePath = featureStatePath(config, feature.id);
  const state = await readJson(filePath, { version: 1, users: {}, history: [] });
  state.version = 1;
  state.users = isRecord(state.users) ? state.users : {};
  state.history = Array.isArray(state.history) ? state.history : [];
  state.recentRequests = isRecord(state.recentRequests) ? state.recentRequests : {};
  const pool = waifuPool(feature);

  if (action.id === "leaderboard") {
    const users = Object.values(state.users).filter(isRecord).map(publicGachaUser)
      .sort((a, b) => b.score - a.score || b.uniqueCards - a.uniqueCards || b.totalDraws - a.totalDraws);
    const count = readNumber({ count: payload.count }, "count", 10, 1, 20);
    const selected = users.slice(0, count);
    return {
      kind: "waifu_gacha_leaderboard",
      count: Math.min(users.length, count),
      users: selected,
      replyText: formatGachaLeaderboardText(selected),
      modelInstruction: "Use replyText as the factual leaderboard body. You may react naturally in character, but do not alter score, uniqueCards, or totalDraws."
    };
  }

  if (action.id === "stats") {
    const stats = publicGachaStats(state);
    return {
      kind: "waifu_gacha_stats",
      stats,
      replyText: formatGachaStatsText(stats),
      modelInstruction: "Use replyText as factual gacha stats. Natural comments are fine; do not change counts."
    };
  }

  const user = ensureGachaUser(state, identity, payload);

  if (action.id === "profile") {
    const profile = publicGachaProfile(user);
    return {
      kind: "waifu_gacha_profile",
      user: profile,
      replyText: formatGachaProfileText(profile),
      modelInstruction: "Use replyText as factual gacha profile data. Natural comments are fine; do not alter pity, score, or collection counts."
    };
  }

  if (action.id === "collection") {
    const cards = Object.values(user.collection).filter(isRecord)
      .sort((a, b) => (RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity)) || String(a.name).localeCompare(String(b.name)))
      .slice(0, readNumber({ count: payload.count }, "count", 20, 1, 50));
    const publicCards = cards.map(publicGachaCollectionCard);
    return {
      kind: "waifu_gacha_collection",
      user: publicGachaUser(user),
      cards: publicCards,
      poolSize: pool.length,
      replyText: formatGachaCollectionText(publicGachaUser(user), publicCards),
      modelInstruction: "Use replyText as the factual collection body. You may react naturally in character, but do not expose local storage or invent hidden cards."
    };
  }

  if (action.id === "daily") {
    const today = dateKey(config);
    if (user.lastDailyDate === today && isRecord(user.lastDailyResult)) {
      if (!user.lastDailyResult.image && !user.lastDailyResult.imageError) {
        await attachDanbooruToDraw(feature, pool, user.lastDailyResult);
        state.updatedAt = nowIso();
        await writeJsonAtomic(filePath, state);
      }
      const resultImages = gachaResultImages(user.lastDailyResult);
      const batchId = gachaBatchId(identity, action, 1);
      const archive = await archiveGachaDraws(config, [user.lastDailyResult], batchId, identity);
      return {
        kind: "waifu_gacha_daily",
        today,
        alreadyDrawn: true,
        batchId,
        draw: publicGachaDraw(user.lastDailyResult),
        resultImages,
        albumMedia: archive.media,
        archive,
        deliveryReview: gachaDeliveryReview(resultImages, archive),
        user: publicGachaUser(user),
        replyText: formatSingleDrawText(user.lastDailyResult, "今日已抽过"),
        modelInstruction: `Use replyText as the factual draw body. You may react naturally in character, but keep the same result exactly, including rarity, score, and Danbooru post id. ${GACHA_IMAGE_DELIVERY_RULE}`
      };
    }
    const seed = `${user.userId}:${today}:daily-waifu`;
    const draw = await drawOneWaifu(user, feature, pool, seed, false);
    await attachDanbooruToDraw(feature, pool, draw);
    const batchId = gachaBatchId(identity, action, 1);
    await appendGachaDrawEvents(config, { batchId, actionId: action.id, identity, requestLimit: { requestedCount: 1, appliedCount: 1, limited: false }, results: [draw] });
    user.lastDailyDate = today;
    user.lastDailyResult = draw;
    state.updatedAt = nowIso();
    await writeJsonAtomic(filePath, state);
    const resultImages = gachaResultImages(draw);
    const archive = await archiveGachaDraws(config, [draw], batchId, identity);
    return {
      kind: "waifu_gacha_daily",
      today,
      alreadyDrawn: false,
      batchId,
      draw: publicGachaDraw(draw),
      resultImages,
      albumMedia: archive.media,
      archive,
      deliveryReview: gachaDeliveryReview(resultImages, archive),
      user: publicGachaUser(user),
      replyText: formatSingleDrawText(draw, "今日老婆"),
      modelInstruction: `Use replyText as the factual daily draw body. You may react naturally in character, but preserve rarity, name, affinity, score, Danbooru post id, and new/duplicate state exactly. ${GACHA_IMAGE_DELIVERY_RULE}`
    };
  }

  const requestLimit = readGachaDrawRequest(action, payload);
  const nowMs = Date.now();
  const requestKey = gachaRequestKey(identity, action, requestLimit, payload);
  let requestClaim = null;
  if (isDuplicateControlledGacha(action, requestLimit)) {
    const duplicate = cachedDuplicateGachaResult(state, requestKey, nowMs);
    if (duplicate) return duplicate;
    requestClaim = await claimGachaRequest(config, requestKey, {
      feature: feature.id,
      action: action.id,
      userId: user.userId,
      chatId: identity.chatId || "",
      requestLimit
    }, nowMs);
    if (!requestClaim.claimed) return duplicateGachaRequestResultFromLock(requestClaim.lock, nowMs);
  }
  try {
    const count = requestLimit.appliedCount;
    const results = [];
    let hasSrPlus = false;
    for (let i = 0; i < count; i++) {
      const forceSrPlus = action.id === "ten_pull" && i === count - 1 && !hasSrPlus;
      const seed = `${user.userId}:${Date.now()}:${i}:${randomSeed()}`;
      const draw = await drawOneWaifu(user, feature, pool, seed, forceSrPlus);
      if (isRarityAtLeast(draw.card.rarity, "SR")) hasSrPlus = true;
      results.push(draw);
    }
    const featured = bestWaifuDraw(results);
    if (featured) await attachDanbooruToDraw(feature, pool, featured);
    const batchId = gachaBatchId(identity, action, count);
    await appendGachaDrawEvents(config, { batchId, actionId: action.id, identity, requestLimit, results });
    state.history.push({ t: nowIso(), userId: user.userId, action: action.id, count, topRarity: results.map((item) => item.card.rarity).sort((a, b) => RARITY_ORDER.indexOf(b) - RARITY_ORDER.indexOf(a))[0] });
    state.history = state.history.slice(-200);
    state.updatedAt = nowIso();
    await writeJsonAtomic(filePath, state);
    const resultImages = gachaResultImages(results);
    const archive = await archiveGachaDraws(config, results, batchId, identity);
    const result = {
      kind: action.id === "ten_pull" ? "waifu_gacha_ten_pull" : "waifu_gacha_draw",
      batchId,
      count,
      requestLimit,
      resultImages,
      albumMedia: archive.media,
      archive,
      deliveryReview: gachaDeliveryReview(resultImages, archive),
      featuredImage: publicDanbooruImage(featured?.image || null),
      results: results.map(publicGachaDraw),
      user: publicGachaUser(user),
      replyText: [
        requestLimitNotice(requestLimit),
        action.id === "ten_pull" || count > 1 ? formatMultiPullText(results, featured) : formatSingleDrawText(results[0])
      ].filter(Boolean).join("\n"),
      modelInstruction: `Use replyText as the factual gacha body. You may react naturally in character, but do not alter requestLimit, rarity, score, new/duplicate state, or Danbooru post ids. For ten-pull or multi-draw, send albumMedia/MEDIA lines in one reply/album when possible. ${GACHA_IMAGE_DELIVERY_RULE}`
    };
    if (isDuplicateControlledGacha(action, requestLimit)) rememberGachaRequest(state, requestKey, result, nowMs);
    await writeJsonAtomic(filePath, state);
    if (requestClaim?.claimed) await completeGachaRequestClaim(requestClaim.lockPath);
    return result;
  } catch (error) {
    if (requestClaim?.claimed) await releaseGachaRequestClaim(requestClaim.lockPath);
    throw error;
  }
}

const HANDLERS = {
  "builtin.checkin": runCheckin,
  "builtin.daily_fortune": runDailyFortune,
  "builtin.waifu_gacha": runWaifuGacha
};

function readIdentity(params) {
  const user = readObject(params, "user");
  const chat = readObject(params, "chat");
  return {
    userId: normalizedIdentity(readString(params, "userId") || readString(user, "id") || readString(user, "userId")),
    userName: readString(params, "userName") || readString(user, "username") || readString(user, "userName"),
    displayName: readString(params, "displayName") || readString(user, "displayName") || readString(user, "name"),
    chatId: readString(params, "chatId") || readString(chat, "id") || readString(chat, "chatId"),
    chatTitle: readString(params, "chatTitle") || readString(chat, "title") || readString(chat, "name")
  };
}

const VALID_ACTION_RISKS = new Set(["read", "local-write", "network-read", "network-write", "external-write"]);
const VALID_ACTION_PERMISSIONS = new Set(["public", "member", "trusted", "owner"]);
const VALID_COOLDOWN_SCOPES = new Set(["user", "chat", "global"]);

function validationIssue(featureId, severity, code, message, extra = {}) {
  return { featureId: featureId || "", severity, code, message, ...extra };
}

function validateFeatureManifests(features) {
  const issues = [];
  const featureIds = new Map();
  const triggerOwners = new Map();
  for (const feature of features) {
    const featureId = String(feature?.id || "").trim();
    if (!featureId) {
      issues.push(validationIssue("", "error", "missing_feature_id", "Feature manifest is missing id.", { sourceFile: feature?._sourceFile || "" }));
      continue;
    }
    if (featureIds.has(featureId)) {
      issues.push(validationIssue(featureId, "error", "duplicate_feature_id", `Duplicate feature id: ${featureId}.`, {
        firstSourceFile: featureIds.get(featureId),
        sourceFile: feature._sourceFile || ""
      }));
    } else {
      featureIds.set(featureId, feature._sourceFile || "");
    }
    if (safeId(featureId) !== featureId) {
      issues.push(validationIssue(featureId, "warn", "non_canonical_feature_id", "Feature id should already be safeId-normalized."));
    }
    if (!String(feature.title || "").trim()) issues.push(validationIssue(featureId, "warn", "missing_title", "Feature title is missing."));
    if (!String(feature.description || "").trim()) issues.push(validationIssue(featureId, "warn", "missing_description", "Feature description is missing."));
    if (feature.enabled === false) issues.push(validationIssue(featureId, "info", "feature_disabled", "Feature is disabled."));
    const handler = String(feature.handler || "").trim();
    if (!handler) issues.push(validationIssue(featureId, "error", "missing_handler", "Feature handler is missing."));
    else if (!HANDLERS[handler]) issues.push(validationIssue(featureId, "error", "unknown_handler", `Unsupported feature handler: ${handler}.`));
    const actions = Array.isArray(feature.actions) ? feature.actions : [];
    if (!actions.length) issues.push(validationIssue(featureId, "error", "missing_actions", "Feature has no actions."));
    const actionIds = new Set();
    for (const action of actions) {
      const actionId = String(action?.id || "").trim();
      if (!actionId) {
        issues.push(validationIssue(featureId, "error", "missing_action_id", "Feature action is missing id."));
        continue;
      }
      if (actionIds.has(actionId)) issues.push(validationIssue(featureId, "error", "duplicate_action_id", `Duplicate action id: ${actionId}.`, { actionId }));
      actionIds.add(actionId);
      if (!String(action.description || "").trim()) issues.push(validationIssue(featureId, "warn", "missing_action_description", `Action ${actionId} description is missing.`, { actionId }));
      const risk = String(action.risk || "read").trim();
      if (!VALID_ACTION_RISKS.has(risk)) issues.push(validationIssue(featureId, "warn", "unknown_action_risk", `Action ${actionId} has unknown risk: ${risk}.`, { actionId, risk }));
      const permission = String(action.permission || "member").trim();
      if (!VALID_ACTION_PERMISSIONS.has(permission)) issues.push(validationIssue(featureId, "warn", "unknown_action_permission", `Action ${actionId} has unknown permission: ${permission}.`, { actionId, permission }));
      if (isRecord(action.cooldown)) {
        const scope = String(action.cooldown.scope || "user").trim();
        const seconds = Number(action.cooldown.seconds || 0);
        if (!VALID_COOLDOWN_SCOPES.has(scope)) issues.push(validationIssue(featureId, "warn", "unknown_cooldown_scope", `Action ${actionId} has unknown cooldown scope: ${scope}.`, { actionId, scope }));
        if (!Number.isFinite(seconds) || seconds < 0) issues.push(validationIssue(featureId, "warn", "invalid_cooldown_seconds", `Action ${actionId} cooldown seconds must be >= 0.`, { actionId }));
      }
    }
    for (const trigger of Array.isArray(feature.triggers) ? feature.triggers : []) {
      const key = String(trigger || "").trim().toLowerCase();
      if (!key) continue;
      const owner = triggerOwners.get(key);
      if (owner && owner !== featureId) {
        issues.push(validationIssue(featureId, "warn", "duplicate_trigger", `Trigger "${trigger}" is also used by ${owner}.`, { trigger, otherFeatureId: owner }));
      } else {
        triggerOwners.set(key, featureId);
      }
    }
  }
  const summary = {
    features: features.length,
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warn").length,
    info: issues.filter((issue) => issue.severity === "info").length
  };
  return {
    ok: summary.errors === 0,
    summary,
    issues
  };
}

const featureCatalogTool = {
  name: FEATURE_CATALOG_TOOL,
  label: "Feature Catalog",
  description: "List, inspect, and route manifest-driven mixed bot features. Use for feature discovery; ordinary feature execution uses feature_action.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "get", "search", "route", "validate"], description: "List all features, get one feature, route/search a natural-language feature request, or validate feature manifests." },
      feature: { type: "string", description: "Feature id." },
      query: { type: "string", description: "Search/routing query." },
      includeDisabled: { type: "boolean", description: "Include disabled features." },
      count: { type: "number", description: "Max results." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params) {
    try {
      const config = featureCatalogTool.config || {};
      const action = readString(params, "action").toLowerCase();
      const includeDisabled = readBoolean(params, "includeDisabled", false);
      const features = (await loadFeatures(config)).filter((feature) => includeDisabled || feature.enabled !== false);
      if (action === "list") {
        const selected = features.map(publicFeature);
        return ok(FEATURE_CATALOG_TOOL, [
          `features=${selected.length}`,
          ...selected.map((feature) => `${feature.id}: ${feature.title} | actions=${feature.actions.map((item) => item.id).join(", ")}`)
        ], { action, features: selected });
      }
      if (action === "validate") {
        const validation = validateFeatureManifests(features);
        return ok(FEATURE_CATALOG_TOOL, [
          `validate: ${validation.ok ? "ok" : "failed"}`,
          `features=${validation.summary.features} errors=${validation.summary.errors} warnings=${validation.summary.warnings} info=${validation.summary.info}`,
          ...validation.issues.slice(0, 30).map((issue) => `${issue.severity.toUpperCase()} ${issue.featureId || "(unknown)"} ${issue.code}: ${issue.message}`)
        ], { action, validation });
      }
      if (action === "get") {
        const feature = findFeature(features, readString(params, "feature") || readString(params, "query"));
        if (!feature) throw new Error("feature not found");
        return ok(FEATURE_CATALOG_TOOL, [
          `${feature.id}: ${feature.title}`,
          feature.description,
          `triggers: ${(feature.triggers || []).join(", ")}`,
          `actions: ${(feature.actions || []).map((item) => item.id).join(", ")}`
        ], { action, feature: publicFeature(feature) });
      }
      if (action === "search" || action === "route") {
        const query = readString(params, "query") || readString(params, "feature");
        const results = routeFeatures(features, query, readCount(params));
        return ok(FEATURE_CATALOG_TOOL, [
          `results=${results.length}`,
          ...results.map((entry) => `${entry.feature.id}: ${entry.feature.title} | score=${entry.score}`)
        ], { action, query, results });
      }
      throw new Error("unknown action");
    } catch (error) {
      return fail(FEATURE_CATALOG_TOOL, error);
    }
  }
};

const featureActionTool = {
  name: FEATURE_ACTION_TOOL,
  label: "Feature Action",
  description: "Execute deterministic manifest-driven bot features, such as daily check-in. The tool updates/reads local state and returns structured results for the model to wrap.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      feature: { type: "string", description: "Feature id, e.g. checkin." },
      action: { type: "string", description: "Action id, e.g. checkin/status/leaderboard." },
      userId: { type: "string", description: "Telegram user id. Prefer tg:<id> when available." },
      userName: { type: "string", description: "Telegram username or visible alias." },
      displayName: { type: "string", description: "Visible display name." },
      chatId: { type: "string", description: "Telegram chat id." },
      chatTitle: { type: "string", description: "Telegram chat title." },
      user: { type: "object", description: "Optional structured user identity." },
      chat: { type: "object", description: "Optional structured chat identity." },
      payload: { type: "object", description: "Feature-specific payload." },
      dryRun: { type: "boolean", description: "Validate routing/permission without mutating state." },
      ...backgroundToolParameters()
    },
    required: ["feature", "action"]
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const config = featureActionTool.config || {};
      if (shouldRunInBackground(params)) {
        return await enqueueBackgroundTool({
          toolName: FEATURE_ACTION_TOOL,
          config,
          params,
          ctx,
          kind: `${FEATURE_ACTION_TOOL}.execute`,
          label: `feature_action ${readString(params, "feature")}/${readString(params, "action")}`,
          payload: { ...(params || {}), background: false, async: false },
          timeoutMs: 240_000,
          handler: async ({ payload, progress }) => {
            await progress({ percent: 5, note: "running feature action" });
            const output = await featureActionTool.execute("background-feature-action", payload);
            const status = output?.details?.status || "unknown";
            if (status === "failed") throw new Error(output?.details?.error || output?.content?.[0]?.text || "feature action failed");
            await progress({ percent: 95, note: "feature action completed" });
            return {
              status,
              resultText: output?.content?.[0]?.text || "",
              feature: output?.details?.feature?.id || readString(payload, "feature"),
              action: output?.details?.featureAction?.id || readString(payload, "action"),
              resultKind: output?.details?.result?.kind || ""
            };
          }
        });
      }
      const features = (await loadFeatures(config)).filter((feature) => feature.enabled !== false);
      const feature = findFeature(features, readString(params, "feature"));
      if (!feature) throw new Error("feature not found or disabled");
      const action = findAction(feature, readString(params, "action"));
      if (!action) throw new Error("feature action not found");
      const identity = readIdentity(params);
      const payload = readObject(params, "payload");
      checkPermission(config, action, identity);
      if (readBoolean(params, "dryRun", false)) {
        return ok(FEATURE_ACTION_TOOL, ["dryRun ok"], { action: "dryRun", feature: publicFeature(feature), featureAction: publicAction(action), identity });
      }
      const cooldown = await checkCooldown(config, feature, action, identity);
      if (!cooldown.ok) throw new Error(`feature cooldown active; retry in ${cooldown.waitSeconds}s`);
      const handler = HANDLERS[String(feature.handler || "")];
      if (!handler) throw new Error(`unsupported feature handler: ${feature.handler || "(empty)"}`);
      const result = await handler(config, feature, action, identity, payload);
      await appendJsonLine(auditLogPath(config), {
        t: nowIso(),
        feature: feature.id,
        action: action.id,
        risk: action.risk || "read",
        userId: identity.userId,
        chatId: identity.chatId,
        resultKind: result?.kind || ""
      });
      return ok(FEATURE_ACTION_TOOL, [
        "FEATURE_RESULT",
        `feature: ${feature.id}`,
        `action: ${action.id}`,
        `kind: ${result?.kind || "result"}`,
        result?.modelInstruction ? `modelInstruction: ${result.modelInstruction}` : "",
        `json: ${JSON.stringify(compactFeatureResultForText(result))}`
      ], { action: "execute", feature: publicFeature(feature), featureAction: publicAction(action), identity, result });
    } catch (error) {
      return fail(FEATURE_ACTION_TOOL, error);
    }
  }
};

const gachaArchiveTool = {
  name: GACHA_ARCHIVE_TOOL,
  label: "Gacha Archive",
  description: "Archive final sendable gacha media to local cache and the configured Telegram channel. Use Telegram native spoiler for sensitive media; do not pixel-censor the original.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      media: { type: "string", description: "Final sendable bot-local media path or MEDIA line." },
      path: { type: "string", description: "Alias for media." },
      image: { type: "string", description: "Alias for media." },
      batchId: { type: "string", description: "Gacha batch id." },
      postId: { type: "string", description: "Danbooru/Safebooru post id if available." },
      name: { type: "string", description: "Card/display name." },
      rarity: { type: "string", description: "N/R/SR/SSR/UR." },
      score: { type: "number", description: "Source post score." },
      pageUrl: { type: "string", description: "Source post page URL." },
      sourceUrl: { type: "string", description: "Original source image URL." },
      imageUrl: { type: "string", description: "Alias source image URL." },
      primaryTags: { type: "array", items: { type: "string" }, description: "Compact visible/source tags." },
      archiveTags: { type: "array", items: { type: "string" }, description: "Broader source tags to turn into Telegram hashtags." },
      characterTags: { type: "array", items: { type: "string" }, description: "Danbooru character tags." },
      copyrightTags: { type: "array", items: { type: "string" }, description: "Danbooru series/copyright tags." },
      artistTags: { type: "array", items: { type: "string" }, description: "Danbooru artist tags." },
      tagString: { type: "string", description: "Full original Danbooru tag string, for local metadata only." },
      safeStatus: { type: "string", description: "clear, unknown, or explicit/R18 after inspection." },
      spoiler: { type: "boolean", description: "True to send archived Telegram media with native spoiler blur/cover. Original media is unchanged." },
      censored: { type: "boolean", description: "Deprecated legacy flag; do not use for new sends." },
      userId: { type: "string", description: "Telegram user id." },
      displayName: { type: "string", description: "Telegram display name." },
      chatId: { type: "string", description: "Telegram chat id." },
      caption: { type: "string", description: "Optional archive/channel caption." },
      sendToChannel: { type: "boolean", description: "Set true to also send to the configured archive channel. Default is local-cache only for direct calls." },
      metadata: { type: "object", description: "Optional nested metadata; top-level fields win." },
      ...backgroundToolParameters()
    }
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const config = gachaArchiveTool.config || {};
      if (shouldRunInBackground(params)) {
        return await enqueueBackgroundTool({
          toolName: GACHA_ARCHIVE_TOOL,
          config,
          params,
          ctx,
          kind: `${GACHA_ARCHIVE_TOOL}.archive`,
          label: `gacha_archive ${readString(params, "name") || readString(params, "postId") || "media"}`,
          payload: { ...(params || {}), background: false, async: false },
          timeoutMs: 180_000,
          handler: async ({ payload, progress }) => {
            await progress({ percent: 5, note: "archiving gacha media" });
            const archive = await runGachaArchive(config, payload || {});
            await progress({ percent: 95, note: archive.channel?.status ? `channel ${archive.channel.status}` : "archive ready" });
            return {
              status: "ok",
              archiveId: archive.archiveId,
              mediaPath: archive.sendPath || archive.localPath,
              channelStatus: archive.channel?.status || "unknown",
              channelMessageId: archive.channel?.messageId || "",
              duplicate: archive.duplicate === true,
              resultText: [
                "GACHA_ARCHIVE ok",
                `archiveId: ${archive.archiveId}`,
                `MEDIA: \`${archive.sendPath || archive.localPath}\``,
                `channelStatus: ${archive.channel?.status || "unknown"}`,
                archive.channel?.messageId ? `channelMessageId: ${archive.channel.messageId}` : "",
                archive.duplicate ? "duplicate: true" : ""
              ].filter(Boolean).join("\n")
            };
          }
        });
      }
      const archive = await runGachaArchive(config, params || {});
      return ok(GACHA_ARCHIVE_TOOL, [
        "GACHA_ARCHIVE ok",
        `archiveId: ${archive.archiveId}`,
        `localStatus: ok`,
        `MEDIA: \`${archive.sendPath || archive.localPath}\``,
        `channelStatus: ${archive.channel?.status || "unknown"}`,
        archive.channel?.messageId ? `channelMessageId: ${archive.channel.messageId}` : "",
        archive.duplicate ? "duplicate: true" : ""
      ], { action: "archive", archive, channel: archive.channel || null });
    } catch (error) {
      return fail(GACHA_ARCHIVE_TOOL, error);
    }
  }
};

export const __testing = {
  loadFeatures,
  routeFeatures,
  dateKey,
  deterministicPoints,
  danbooruTagPlansForCard,
  danbooruTagsForCard,
  danbooruConfig,
  normalizeDanbooruSafetyTag,
  gachaArchiveConfig,
  normalizeGachaRates,
  danbooruQueryPlansForRarity,
  scoreBandForRarity,
  scoreBandTag,
  scoreInBand,
  danbooruPopularityScore,
  fetchDanbooruImageForRarity,
  rarityFromPopularity,
  isSafeDanbooruPost,
  pickDanbooruImage,
  danbooruImageToCard,
  isRarityAtLeast,
  chooseRarity,
  effectiveSsrRate,
  runCheckin,
  runDailyFortune,
  runWaifuGacha,
  publicGachaProfile,
  publicGachaStats,
  runGachaArchive,
  buildGachaArchiveCaption,
  validateFeatureManifests,
  publicFeature
};

export default {
  id: "imagebot-feature-core",
  name: "Imagebot Feature Core",
  description: "Manifest-driven feature registry and deterministic mixed feature executor.",
  register(api) {
    const config = api.config || {};
    featureCatalogTool.config = config;
    featureActionTool.config = config;
    gachaArchiveTool.config = config;
    api.registerTool(featureCatalogTool, { name: FEATURE_CATALOG_TOOL });
    api.registerTool(featureActionTool, { name: FEATURE_ACTION_TOOL });
    api.registerTool(gachaArchiveTool, { name: GACHA_ARCHIVE_TOOL });
  }
};

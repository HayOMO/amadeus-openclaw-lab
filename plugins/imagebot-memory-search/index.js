import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { registerLifecycleHook } from "../imagebot-shared/openclaw-lifecycle-hooks.mjs";

const TOOL_NAME = "memory_search";
const DEFAULT_COUNT = 4;
const MAX_COUNT = 8;
const MAX_FILE_BYTES = 220_000;
const MAX_WINDOW_FILES = 80;
const RECALL_GATE_QUERY_CHARS = 360;
const SEMANTIC_MODEL = process.env.IMAGEBOT_MEMORY_EMBEDDING_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const SEMANTIC_INDEX_VERSION = 2;
const CHUNK_CHARS = 950;
const CHUNK_OVERLAP = 120;
const MAX_CHUNKS_PER_DOC = 48;
const AUTO_RECALL_TRIGGER_RE =
  /\b(?:remember|memory|previous|before|last time|nickname|inside joke|group lore|meme|impression)\b|(?:记得|记忆|上次|之前|以前|前面|外号|绰号|印象|群友|群里|老梗|烂梗|什么梗|啥梗|梗|典|名场面|怎么回事|什么来着|是谁|谁是|叫法)/iu;

const LEGACY_TELEGRAM_ROUTING_CONTEXT = ["[Telegram", "routing context]"].join(" ");

let extractorPromise = null;
let cachedSemanticIndex = null;
let cachedSemanticIndexMtimeMs = 0;
let semanticBuildPromise = null;
let lastSemanticBuildError = null;
let knownUsersCache = null;

const STOPWORDS = new Set([
  "ask", "draw", "edit", "read", "describe", "search", "dream", "failures", "help",
  "image", "picture", "photo", "prompt", "reference", "generate", "create", "memory",
  "你", "我", "他", "她", "它", "谁", "什么", "怎么", "怎样", "如何", "感觉",
  "印象", "看法", "评价", "记忆", "之前", "以前", "上次", "为什么", "图",
  "图片", "图像", "生成", "生图", "画图", "搜图", "这个", "那个", "一下"
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  return typeof value === "string" ? value.trim() : fallback;
}

function readCount(params) {
  const raw = isRecord(params) ? params.count : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_COUNT;
  return Math.max(1, Math.min(MAX_COUNT, Math.trunc(value)));
}

function normalizeScope(value) {
  const scope = String(value || "all").trim().toLowerCase();
  return new Set(["all", "users", "group", "windows"]).has(scope) ? scope : "all";
}

function normalizeMode(value) {
  const mode = String(value || "hybrid").trim().toLowerCase();
  return new Set(["hybrid", "semantic", "keyword"]).has(mode) ? mode : "hybrid";
}

function memoryRoot() {
  return path.join(os.homedir(), ".openclaw", "agents", "imagebot", "sessions", "sessions.json.telegram-imagebot-memory");
}

function semanticIndexPath() {
  return path.join(memoryRoot(), "semantic-index.json");
}

function semanticCacheDir() {
  return path.join(os.homedir(), ".openclaw", "models", "transformers");
}

function windowStorePath() {
  return path.join(os.homedir(), ".openclaw", "agents", "imagebot", "sessions", "sessions.json.telegram-imagebot-windows.json");
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[telegram-token-redacted]")
    .replace(/[A-Za-z]:\\[^\s<>"']+/g, "[local-path-redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip-redacted]")
    .replace(/[A-Za-z0-9_-]{48,}/g, "[long-token-redacted]")
    .replace(/\r\n/g, "\n")
    .trim();
}

function clip(value, max) {
  const text = sanitizeText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 20)).trimEnd()}...`;
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizeTerm(term) {
  return String(term || "").trim().replace(/^@/, "").toLowerCase();
}

function addTerm(terms, term) {
  const normalized = normalizeTerm(term);
  if (normalized.length < 2 || STOPWORDS.has(normalized)) return;
  if (normalized.includes("某") || normalized.includes("看看")) return;
  if (/^(什么|怎么|怎样|如何|之前|以前|上次|说过|感觉|印象|评价|看法)/.test(normalized)) return;
  if (/(什么|怎么|怎样|如何|说过|说啥|说了)$/.test(normalized)) return;
  terms.add(normalized);
}

function extractTerms(text) {
  const terms = new Set();
  const normalized = String(text || "").toLowerCase();
  for (const match of normalized.matchAll(/@?[a-z0-9_]{3,64}/gi)) addTerm(terms, match[0]);
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]{2,12}/g)) {
    const seq = match[0];
    for (let size = Math.min(4, seq.length); size >= 2; size--) {
      for (let i = 0; i <= seq.length - size; i++) addTerm(terms, seq.slice(i, i + size));
    }
  }
  return [...terms].sort((a, b) => b.length - a.length).slice(0, 40);
}

function readKnownUsers() {
  try {
    const filePath = windowStorePath();
    const stat = fsSync.statSync(filePath);
    if (!stat.isFile()) return new Map();
    const signature = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    if (knownUsersCache?.signature === signature) {
      return new Map(knownUsersCache.users);
    }
    const parsed = JSON.parse(fsSync.readFileSync(filePath, "utf-8"));
    const users = new Map();
    for (const [userKey, data] of Object.entries(parsed.users || {})) {
      const names = Array.isArray(data?.names) ? data.names.map((name) => String(name || "").trim()).filter(Boolean) : [];
      if (names.length) users.set(userKey, names);
    }
    for (const windowEntry of Object.values(parsed.activeByUser || {})) {
      if (windowEntry?.ownerUserKey && windowEntry?.ownerName) {
        const names = users.get(windowEntry.ownerUserKey) || [];
        if (!names.some((name) => name.toLowerCase() === String(windowEntry.ownerName).toLowerCase())) names.push(String(windowEntry.ownerName));
        users.set(windowEntry.ownerUserKey, names);
      }
      for (const [userKey, participant] of Object.entries(windowEntry?.participants || {})) {
        const names = users.get(userKey) || [];
        const name = String(participant?.name || "").trim();
        if (name && !names.some((item) => item.toLowerCase() === name.toLowerCase())) names.push(name);
        if (names.length) users.set(userKey, names);
      }
    }
    knownUsersCache = { signature, users };
    return new Map(users);
  } catch {
    return new Map();
  }
}

function clearKnownUsersCache() {
  knownUsersCache = null;
}

function knownUsersCacheStats() {
  return {
    cached: Boolean(knownUsersCache),
    users: knownUsersCache?.users?.size || 0
  };
}

async function safeReadFile(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) return "";
  const handle = await fs.open(filePath, "r");
  try {
    const length = Math.min(stat.size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString("utf-8");
  } finally {
    await handle.close();
  }
}

async function listMemoryDocs(scope) {
  const root = memoryRoot();
  const docs = [];
  const addDir = async (kind, dir, limit = Infinity) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const filePath = path.join(dir, entry.name);
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat?.isFile()) files.push({ name: entry.name, filePath, mtimeMs: stat.mtimeMs, size: stat.size });
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const file of files.slice(0, limit)) docs.push({ kind, fileName: file.name, filePath: file.filePath, mtimeMs: file.mtimeMs, size: file.size });
    } catch {}
  };
  if (scope === "all" || scope === "users") await addDir("user", path.join(root, "users"));
  if (scope === "all" || scope === "group") await addDir("group", path.join(root, "group"));
  if (scope === "all" || scope === "windows") await addDir("window", path.join(root, "windows"), MAX_WINDOW_FILES);
  return docs;
}

function docSignature(docs) {
  return hash(JSON.stringify({
    version: SEMANTIC_INDEX_VERSION,
    model: SEMANTIC_MODEL,
    docs: docs.map((doc) => ({
      kind: doc.kind,
      fileName: doc.fileName,
      mtimeMs: Math.trunc(doc.mtimeMs || 0),
      size: doc.size || 0
    }))
  }));
}

function labelForDoc(doc, knownUsers) {
  if (doc.kind === "user") {
    const userKey = doc.fileName.replace(/\.md$/i, "");
    const names = knownUsers.get(userKey) || [];
    return names.length ? `user:${names.join("/")}` : `user:${userKey.slice(0, 6)}`;
  }
  if (doc.kind === "group") return "shared-group-memory";
  return `window:${doc.fileName.replace(/\.md$/i, "").slice(0, 24)}`;
}

function scoreText(text, terms, targetTerms, label) {
  const lowered = text.toLowerCase();
  const loweredLabel = label.toLowerCase();
  let score = 0;
  const hits = [];
  for (const term of terms) {
    const count = lowered.split(term).length - 1;
    if (count > 0) {
      score += Math.min(30, count * (2 + Math.min(term.length, 10)));
      hits.push(term);
    }
    if (loweredLabel.includes(term)) {
      score += 35;
      hits.push(term);
    }
  }
  for (const term of targetTerms) {
    if (lowered.includes(term) || loweredLabel.includes(term)) score += 45;
  }
  return { score, hits: [...new Set(hits)].slice(0, 8) };
}

function snippetAround(text, terms, maxChars = 850) {
  const lowered = text.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const found = lowered.indexOf(term.toLowerCase());
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) return clip(text.slice(-maxChars), maxChars);
  const start = Math.max(0, index - Math.floor(maxChars / 2));
  return clip(text.slice(start, start + maxChars), maxChars);
}

function chunkText(text, maxChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  const cleaned = sanitizeText(text).replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) return [];
  const chunks = [];
  const sections = cleaned.split(/(?=\n#{1,3}\s+|\n##\s+\d{4}-\d{2}-\d{2}|\nWindow:\s+)/g).map((part) => part.trim()).filter(Boolean);
  for (const section of sections.length ? sections : [cleaned]) {
    if (section.length <= maxChars) {
      chunks.push(section);
      continue;
    }
    let cursor = 0;
    while (cursor < section.length) {
      const end = Math.min(section.length, cursor + maxChars);
      chunks.push(section.slice(cursor, end).trim());
      if (end >= section.length) break;
      cursor = Math.max(cursor + 1, end - overlap);
    }
  }
  return chunks.filter(isUsefulChunk).slice(-MAX_CHUNKS_PER_DOC);
}

function isUsefulChunk(text) {
  const cleaned = sanitizeText(text).trim();
  if (cleaned.length < 80) return false;
  if (/^#\s+Telegram Imagebot Window Memory\s*$/i.test(cleaned)) return false;
  const information = cleaned
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[`*_~>\-|:[\]\(\)\s.。,:，]+/g, "")
    .trim();
  return information.length >= 36;
}

async function loadFeatureExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const transformers = await import("@xenova/transformers");
      transformers.env.cacheDir = semanticCacheDir();
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = true;
      return await transformers.pipeline("feature-extraction", SEMANTIC_MODEL);
    })();
  }
  return extractorPromise;
}

async function embedText(text) {
  const extractor = await loadFeatureExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data || output.tolist?.()[0] || []);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  return aNorm > 0 && bNorm > 0 ? dot / Math.sqrt(aNorm * bNorm) : 0;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value), "utf-8");
  await fs.rename(tempPath, filePath);
}

function isUsableSemanticIndex(index) {
  return index?.version === SEMANTIC_INDEX_VERSION &&
    index?.model === SEMANTIC_MODEL &&
    Array.isArray(index?.chunks);
}

function isFreshSemanticIndex(index, signature) {
  return isUsableSemanticIndex(index) && index.signature === signature;
}

async function loadCachedSemanticIndex() {
  const filePath = semanticIndexPath();
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    cachedSemanticIndex = null;
    cachedSemanticIndexMtimeMs = 0;
    return null;
  }
  if (cachedSemanticIndex && cachedSemanticIndexMtimeMs === stat.mtimeMs) {
    return cachedSemanticIndex;
  }
  const parsed = await readJson(filePath);
  if (!isUsableSemanticIndex(parsed)) {
    cachedSemanticIndex = null;
    cachedSemanticIndexMtimeMs = stat.mtimeMs;
    return null;
  }
  cachedSemanticIndex = parsed;
  cachedSemanticIndexMtimeMs = stat.mtimeMs;
  return parsed;
}

async function buildSemanticIndexInternal(options = {}) {
  const docs = options.docs || await listMemoryDocs("all");
  const signature = options.signature || docSignature(docs);
  const cached = await loadCachedSemanticIndex();
  if (!options.force && isFreshSemanticIndex(cached, signature)) return cached;
  const knownUsers = readKnownUsers();
  const chunks = [];
  for (const doc of docs) {
    const raw = await safeReadFile(doc.filePath).catch(() => "");
    const text = sanitizeText(raw);
    if (!text) continue;
    const label = labelForDoc(doc, knownUsers);
    const parts = chunkText(text);
    for (let i = 0; i < parts.length; i++) {
      chunks.push({
        id: hash(`${doc.kind}:${doc.fileName}:${i}:${parts[i].slice(0, 80)}`).slice(0, 16),
        kind: doc.kind,
        label,
        fileName: doc.fileName,
        chunkIndex: i,
        text: parts[i]
      });
    }
  }
  for (const chunk of chunks) {
    chunk.embedding = await embedText(`${chunk.label}\n${chunk.text.slice(0, 1500)}`);
  }
  const index = {
    version: SEMANTIC_INDEX_VERSION,
    model: SEMANTIC_MODEL,
    signature,
    builtAt: new Date().toISOString(),
    chunks
  };
  await writeJsonAtomic(semanticIndexPath(), index);
  const stat = await fs.stat(semanticIndexPath()).catch(() => null);
  cachedSemanticIndex = index;
  cachedSemanticIndexMtimeMs = stat?.mtimeMs || Date.now();
  lastSemanticBuildError = null;
  return index;
}

async function buildSemanticIndex(options = {}) {
  if (semanticBuildPromise) return semanticBuildPromise;
  semanticBuildPromise = buildSemanticIndexInternal(options)
    .catch((error) => {
      lastSemanticBuildError = error;
      throw error;
    })
    .finally(() => {
      semanticBuildPromise = null;
    });
  return semanticBuildPromise;
}

function scheduleSemanticIndexRebuild(options = {}) {
  if (semanticBuildPromise) return false;
  semanticBuildPromise = buildSemanticIndexInternal({ ...options, force: true })
    .catch((error) => {
      lastSemanticBuildError = error;
      return null;
    })
    .finally(() => {
      semanticBuildPromise = null;
    });
  return true;
}

async function resolveSemanticIndexForSearch(options = {}) {
  const docs = await listMemoryDocs("all");
  const signature = docSignature(docs);
  const cached = await loadCachedSemanticIndex();
  if (isFreshSemanticIndex(cached, signature)) {
    return { index: cached, stale: false, warming: false };
  }
  if (isUsableSemanticIndex(cached) && (cached.chunks || []).length > 0) {
    const scheduled = scheduleSemanticIndexRebuild({ docs, signature, reason: options.reason || "stale-search" });
    return { index: cached, stale: true, warming: scheduled || Boolean(semanticBuildPromise) };
  }
  if (options.waitForFresh) {
    return { index: await buildSemanticIndex({ docs, signature }), stale: false, warming: false };
  }
  const scheduled = scheduleSemanticIndexRebuild({ docs, signature, reason: options.reason || "missing-search" });
  return { index: null, stale: false, warming: scheduled || Boolean(semanticBuildPromise) };
}

async function prewarmSemanticIndex(options = {}) {
  const startedAt = Date.now();
  const index = await buildSemanticIndex({ force: options.force === true });
  await embedText("imagebot memory semantic search prewarm");
  return {
    status: "ok",
    model: SEMANTIC_MODEL,
    chunks: Array.isArray(index?.chunks) ? index.chunks.length : 0,
    builtAt: index?.builtAt || "",
    durationMs: Date.now() - startedAt
  };
}

function inScope(kind, scope) {
  return scope === "all" || scope === "users" && kind === "user" || scope === "group" && kind === "group" || scope === "windows" && kind === "window";
}

async function semanticMatches(query, target, scope, count, options = {}) {
  const searchText = [target, query].filter(Boolean).join(" ");
  const resolved = await resolveSemanticIndexForSearch({
    waitForFresh: options.waitForFresh === true,
    reason: "memory-search"
  });
  if (!resolved.index) {
    const suffix = lastSemanticBuildError ? ` Last error: ${lastSemanticBuildError instanceof Error ? lastSemanticBuildError.message : String(lastSemanticBuildError)}` : "";
    throw new Error(`semantic memory index is warming; keyword memory search can be used now.${suffix}`);
  }
  const queryEmbedding = await embedText(searchText);
  return (resolved.index.chunks || [])
    .filter((chunk) => inScope(chunk.kind, scope) && Array.isArray(chunk.embedding))
    .map((chunk) => {
      const similarity = cosine(queryEmbedding, chunk.embedding);
      return {
        kind: chunk.kind,
        label: chunk.label,
        score: Math.round(60 + similarity * 120),
        semanticScore: Number(similarity.toFixed(4)),
        hits: [`semantic:${similarity.toFixed(2)}`, ...(resolved.stale ? ["stale-index"] : [])],
        snippet: clip(chunk.text, 900),
        mode: resolved.stale ? "semantic-stale" : "semantic"
      };
    })
    .filter((result) => result.semanticScore > 0.18)
    .sort((a, b) => b.semanticScore - a.semanticScore)
    .slice(0, Math.max(count * 2, count + 2));
}

async function searchMemory(params) {
  const query = readString(params, "query");
  if (!query) throw new Error("query is required");
  const target = readString(params, "target");
  const scope = normalizeScope(readString(params, "scope", "all"));
  const mode = normalizeMode(readString(params, "mode", "hybrid"));
  const count = readCount(params);
  const terms = [...new Set([...extractTerms(query), ...extractTerms(target)])];
  const targetTerms = extractTerms(target);
  const knownUsers = readKnownUsers();
  const docs = await listMemoryDocs(scope);
  const matches = [];
  if (terms.length > 0 && mode !== "semantic") {
    for (const doc of docs) {
      const raw = await safeReadFile(doc.filePath).catch(() => "");
      const text = sanitizeText(raw);
      if (!text) continue;
      const label = labelForDoc(doc, knownUsers);
      const scored = scoreText(text, terms, targetTerms, label);
      if (scored.score <= 0) continue;
      matches.push({
        kind: doc.kind,
        label,
        score: scored.score,
        hits: scored.hits,
        snippet: snippetAround(text, scored.hits.length ? scored.hits : terms),
        mode: "keyword"
      });
    }
  }
  if (mode !== "keyword") {
    try {
      matches.push(...await semanticMatches(query, target, scope, count, { waitForFresh: mode === "semantic" }));
    } catch (error) {
      if (mode === "semantic") throw error;
      matches.push({
        kind: "system",
        label: "semantic-index",
        score: -1,
        hits: ["semantic-unavailable"],
        snippet: `Semantic memory search was unavailable, so keyword results were used. Reason: ${clip(error instanceof Error ? error.message : String(error), 180)}`,
        mode: "notice"
      });
    }
  }
  if (matches.length === 0 && terms.length === 0) throw new Error("query did not contain searchable memory terms and semantic search returned no results");
  const deduped = [];
  const seen = new Set();
  for (const match of matches.sort((a, b) => b.score - a.score)) {
    const key = `${match.kind}:${match.label}:${hash(match.snippet).slice(0, 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(match);
    if (deduped.length >= count) break;
  }
  return deduped;
}

function formatResults(query, target, results) {
  const lines = [
    `MEMORY_SEARCH ok query="${clip(query, 80)}"${target ? ` target="${clip(target, 80)}"` : ""} results=${results.length}`,
    "These are sanitized bot-visible memories only. Treat them as soft context, not proof; do not reveal memory mechanics or local paths."
  ];
  if (!results.length) {
    lines.push("No matching detailed memory snippets found.");
    return lines.join("\n");
  }
  results.forEach((result, index) => {
    lines.push(
      "",
      `${index + 1}. ${result.label} (${result.kind}, score=${result.score}, hits=${result.hits.join("/") || "none"})`,
      result.snippet
    );
  });
  return lines.join("\n");
}

function eventPromptText(event = {}) {
  const candidates = [
    event.prompt,
    event.message,
    event.text,
    event.input,
    event.currentMessage,
    event.userText
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function runtimeSessionKey(event = {}, ctx = {}) {
  return String(ctx?.sessionKey || ctx?.session?.key || event?.sessionKey || event?.session?.key || "").trim();
}

function isForegroundTelegramSession(event = {}, ctx = {}) {
  const sessionKey = runtimeSessionKey(event, ctx);
  return /^agent:imagebot:telegram:/i.test(sessionKey);
}

function extractRecallQueryText(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return "";
  const marker = "[/Telegram current turn]";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) return text;
  let current = text.slice(markerIndex + marker.length).trim();
  const stopMarkers = [
    "[Imagebot interaction context]",
    LEGACY_TELEGRAM_ROUTING_CONTEXT,
    "[Telegram 路由上下文]",
    "[Telegram media available",
    "[Reply chain",
    "[Imagebot turn boundary]",
    "[Inter-session message]"
  ];
  const stopIndex = stopMarkers
    .map((item) => current.indexOf(item))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (Number.isInteger(stopIndex)) current = current.slice(0, stopIndex).trim();
  return current || text;
}

function shouldOpenRecallGate(prompt) {
  const text = extractRecallQueryText(prompt);
  if (!text) return false;
  if (AUTO_RECALL_TRIGGER_RE.test(text)) return true;
  return false;
}

function inferRecallScope(prompt = "") {
  const text = extractRecallQueryText(prompt);
  if (/(?:群友|群里|群聊|老梗|烂梗|什么梗|啥梗|梗|group lore|inside joke|meme)/iu.test(text)) return "group";
  if (/(?:外号|绰号|印象|谁是|是谁|nickname|impression)/iu.test(text)) return "users";
  return "all";
}

function formatRecallGate(prompt = "") {
  const query = clip(extractRecallQueryText(prompt), RECALL_GATE_QUERY_CHARS);
  const scope = inferRecallScope(prompt);
  const lines = [
    "Imagebot 记忆召回提示：",
    "记忆层：中性的 bot 可见事实、偏好、别名和过去事件；不带角色语气。",
    `建议调用：memory_search({ query: ${JSON.stringify(query)}, scope: "${scope}", mode: "hybrid", count: 4 })`,
    "空结果或弱结果表示未知。"
  ];
  return lines.join("\n");
}

async function recallGatePromptContext(config = {}, event = {}, ctx = {}) {
  if (config.appendPromptContext === false) return "";
  if (ctx?.agentId && ctx.agentId !== "imagebot") return "";
  if (!isForegroundTelegramSession(event, ctx)) return "";
  const prompt = eventPromptText(event);
  if (!shouldOpenRecallGate(prompt)) return "";
  return formatRecallGate(prompt);
}

const memorySearchTool = {
  name: TOOL_NAME,
  label: "Memory Search",
  description:
    "Search detailed bot-visible user, group, and window memories. " +
    "Use when the user asks about prior conversations, group-member impressions, preferences, recurring jokes, or 'what did we say before'.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Search query with names/nicknames and event keywords from the current Telegram question."
      },
      target: {
        type: "string",
        description: "Optional group member nickname/name if the question is about a specific person."
      },
      scope: {
        type: "string",
        enum: ["all", "users", "group", "windows"],
        description: "Memory scope. Default all. Use users for member impressions/preferences, group for shared lore, windows for detailed prior turns."
      },
      count: {
        type: "number",
        description: `Number of snippets to return, 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.`
      },
      mode: {
        type: "string",
        enum: ["hybrid", "semantic", "keyword"],
        description: "Search mode. Default hybrid uses semantic embeddings plus keyword matching. Use semantic for fuzzy recall, keyword for exact names/phrases."
      }
    },
    required: []
  },
  async execute(_toolCallId, params) {
    try {
      const query = readString(params, "query");
      if (!query) {
        return {
          content: [{
            type: "text",
            text: "MEMORY_SEARCH skipped: query is required. Do not retry memory_search in this turn unless you can form a concrete query from the user's current message."
          }],
          details: { status: "skipped", reason: "missing_query" }
        };
      }
      const target = readString(params, "target");
      const results = await searchMemory(params);
      return {
        content: [{ type: "text", text: formatResults(query, target, results) }],
        details: { status: "ok", query, target, count: results.length, results }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `MEMORY_SEARCH error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

export const __testing = {
  buildSemanticIndex,
  eventPromptText,
  extractTerms,
  extractRecallQueryText,
  formatRecallGate,
  inferRecallScope,
  isForegroundTelegramSession,
  knownUsersCacheStats,
  loadCachedSemanticIndex,
  prewarmSemanticIndex,
  resolveSemanticIndexForSearch,
  recallGatePromptContext,
  readKnownUsers,
  clearKnownUsersCache,
  shouldOpenRecallGate,
  searchMemory,
  sanitizeText
};

export default {
  id: "imagebot-memory-search",
  name: "Imagebot Memory Search",
  description: "Searches detailed bot-visible memories for group/person recall.",
  register(api) {
    const config = api.config || {};
    api.registerTool(memorySearchTool, { name: TOOL_NAME });
    registerLifecycleHook(api, "before_prompt_build", async (event, ctx) => {
      const appendContext = await recallGatePromptContext(config, event, ctx);
      return appendContext ? { appendContext } : undefined;
    }, { name: "imagebot-memory-search-before-prompt-build" });
  }
};

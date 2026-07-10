import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  bindMutationPlanToContext,
  mutationActorKey,
  mutationScopeKey,
  mutationTargetFingerprint,
  newMutationApprovalCode,
  newMutationPlanId,
  trustedMutationContext,
  verifyMutationPlanApproval
} from "../imagebot-shared/mutation-authorization.mjs";
import { appendFileLocked, withStateFileLock, writeJsonAtomic as writeSharedJsonAtomic } from "../imagebot-shared/state-file.mjs";
import { openclawStatePath } from "../imagebot-shared/openclaw-paths.mjs";

const SOURCES_TOOL = "knowledge_sources";
const SEARCH_TOOL = "knowledge_search";
const RECENT_TOOL = "knowledge_recent";
const INGEST_TOOL = "knowledge_ingest";
const KNOWLEDGE_TOOL = "knowledge";

const MAX_FILE_BYTES = 1_500_000;
const MAX_TEXT_BYTES = 600_000;
const MAX_RESULTS = 10;
const MAX_INGEST_BYTES = 4 * 1024 * 1024;
const TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".log", ".js", ".mjs", ".ts", ".py", ".ps1", ".html", ".htm", ".css"]);
const SEMANTIC_MODEL = process.env.IMAGEBOT_KNOWLEDGE_EMBEDDING_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const SEMANTIC_INDEX_VERSION = 1;
const CHUNK_CHARS = 1100;
const CHUNK_OVERLAP = 140;
const MAX_CHUNKS_PER_DOC = 36;
const MIN_SEMANTIC_SCORE = 0.18;
const INGEST_PLAN_TTL_MS = 15 * 60 * 1000;
const KNOWLEDGE_FILE_INVENTORY_CACHE_MS = 1000;
const KNOWLEDGE_FILE_TEXT_CACHE_MAX_ENTRIES = 256;

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(pluginDir, "..", "..");
let extractorPromise = null;
let cachedSemanticIndex = null;
let cachedSemanticIndexMtimeMs = 0;
let semanticBuildPromise = null;
let lastSemanticBuildError = null;
const knowledgeFileInventoryCache = new Map();
const knowledgeFileInventoryPromises = new Map();
const knowledgeFileTextCache = new Map();
let knowledgeFileTextCacheHits = 0;
let knowledgeFileTextCacheMisses = 0;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function readCount(params, fallback = 6) {
  const raw = isRecord(params) ? params.count : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_RESULTS, Math.trunc(value)));
}

function readBoolean(params, key, fallback = false) {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(1|true|yes|on)$/i.test(value.trim());
  return fallback;
}

function clip(value, max = 900) {
  const text = sanitizeText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
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

function hash(value, len = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function fullHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function repoRoot(config = {}) {
  return path.resolve(String(config.repoRoot || "").trim() || defaultRepoRoot);
}

function storeRoot(config = {}) {
  const configured = String(config.storeDir || "").trim();
  return path.resolve(configured || openclawStatePath("knowledge-library"));
}

function userDocsRoot(config = {}) {
  return path.join(storeRoot(config), "user-docs");
}

function ingestIndexPath(config = {}) {
  return path.join(storeRoot(config), "ingest-index.jsonl");
}

function ingestPlansPath(config = {}) {
  return path.join(storeRoot(config), "ingest-plans.json");
}

function semanticIndexPath(config = {}) {
  return path.join(storeRoot(config), "semantic-index.json");
}

function semanticCacheDir() {
  return openclawStatePath("models", "transformers");
}

function memoryRoot() {
  return openclawStatePath("agents", "imagebot", "sessions", "sessions.json.telegram-imagebot-memory");
}

function sourceDefinitions(config = {}) {
  const root = repoRoot(config);
  return [
    { id: "persona", kind: "repo_docs", root: path.join(root, "persona"), privacy: "bot-persona", exts: [".md"] },
    { id: "prompt_library", kind: "repo_docs", root: path.join(root, "prompt_library"), privacy: "bot-persona", exts: [".md"] },
    { id: "tool_manuals", kind: "repo_docs", root: path.join(root, "tool_manuals"), privacy: "tool-contract", exts: [".md"] },
    { id: "memory_users", kind: "memory", root: path.join(memoryRoot(), "users"), privacy: "group-memory", exts: [".md"] },
    { id: "memory_group", kind: "memory", root: path.join(memoryRoot(), "group"), privacy: "group-memory", exts: [".md"] },
    { id: "memory_windows", kind: "memory", root: path.join(memoryRoot(), "windows"), privacy: "group-memory", exts: [".md"], limit: 80 },
    { id: "user_docs", kind: "ingested", root: userDocsRoot(config), privacy: "bot-workspace", exts: [...TEXT_EXTS] }
  ];
}

function normalizeKnowledgeContext(ctx = {}) {
  if (!isRecord(ctx)) return {};
  const trusted = trustedMutationContext(ctx);
  const out = {};
  for (const key of ["agentId", "accountId", "channel", "chatId", "threadId", "sessionKey", "windowId", "senderId", "messageId"]) {
    if (trusted[key] !== undefined && trusted[key] !== null && String(trusted[key]).trim()) out[key] = String(trusted[key]);
  }
  if (out.chatId || out.sessionKey || out.windowId) out.scopeKey = mutationScopeKey(trusted);
  if (out.scopeKey && out.senderId) out.actorKey = mutationActorKey(trusted);
  return out;
}

function scopeHash(scopeKey) {
  return hash(scopeKey || "admin", 20);
}

function scopeFilterFromContext(ctx = {}) {
  const context = normalizeKnowledgeContext(ctx);
  return context.scopeKey ? { scopeKey: context.scopeKey, scopeHash: scopeHash(context.scopeKey), actorKey: context.actorKey || "" } : {};
}

function docScopeHash(def, filePath) {
  if (def.id !== "user_docs") return "";
  const rel = path.relative(def.root, filePath).replace(/\\/g, "/");
  const match = rel.match(/^scopes\/([a-f0-9]{8,64})\//i);
  if (match) return match[1].toLowerCase();
  if (rel.startsWith("admin/")) return "admin";
  return "";
}

function docMatchesRuntimeScope(doc, scopeFilter = {}) {
  if (!scopeFilter.scopeHash || doc.kind !== "ingested") return true;
  return doc.scopeHash === scopeFilter.scopeHash;
}

function normalizeSourceFilter(value) {
  const raw = String(value || "all").trim();
  if (!raw || raw === "all") return null;
  return new Set(raw.split(/[,，;；|\s]+/).map((item) => item.trim()).filter(Boolean));
}

function normalizeMode(value) {
  const mode = String(value || "hybrid").trim().toLowerCase();
  return new Set(["hybrid", "semantic", "keyword"]).has(mode) ? mode : "hybrid";
}

function cloneFileList(files) {
  return files.map((file) => ({ ...file }));
}

function fileInventoryCacheKey(root, { exts = [], limit = 200 } = {}) {
  return JSON.stringify({
    root: path.resolve(root),
    exts: [...exts].map((ext) => ext.toLowerCase()).sort(),
    limit
  });
}

async function walkFiles(root, options = {}) {
  const key = fileInventoryCacheKey(root, options);
  const now = Date.now();
  const cached = knowledgeFileInventoryCache.get(key);
  if (cached && now - cached.checkedAt < KNOWLEDGE_FILE_INVENTORY_CACHE_MS) return cloneFileList(cached.files);
  if (knowledgeFileInventoryPromises.has(key)) return cloneFileList(await knowledgeFileInventoryPromises.get(key));
  const promise = walkFilesUncached(root, options).then((files) => {
    knowledgeFileInventoryCache.set(key, { checkedAt: now, files: cloneFileList(files) });
    return files;
  }).finally(() => {
    knowledgeFileInventoryPromises.delete(key);
  });
  knowledgeFileInventoryPromises.set(key, promise);
  return cloneFileList(await promise);
}

async function walkFilesUncached(root, { exts = [], limit = 200 } = {}) {
  const out = [];
  const stack = [root];
  const extSet = new Set(exts.map((ext) => ext.toLowerCase()));
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!extSet.size || extSet.has(ext)) {
          const stat = await fs.stat(full).catch(() => null);
          if (stat?.isFile()) out.push({ filePath: full, mtimeMs: stat.mtimeMs, size: stat.size });
        }
      }
      if (out.length >= limit) break;
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

async function safeRead(filePath, maxBytes = MAX_FILE_BYTES) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) return "";
  const cacheKey = `${path.resolve(filePath)}:${stat.size}:${Math.trunc(stat.mtimeMs)}:${maxBytes}`;
  const cached = knowledgeFileTextCache.get(cacheKey);
  if (cached !== undefined) {
    knowledgeFileTextCacheHits++;
    knowledgeFileTextCache.delete(cacheKey);
    knowledgeFileTextCache.set(cacheKey, cached);
    return cached;
  }
  knowledgeFileTextCacheMisses++;
  const length = Math.min(stat.size, maxBytes);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const text = buffer.toString("utf8");
    knowledgeFileTextCache.set(cacheKey, text);
    while (knowledgeFileTextCache.size > KNOWLEDGE_FILE_TEXT_CACHE_MAX_ENTRIES) {
      const oldest = knowledgeFileTextCache.keys().next().value;
      if (!oldest) break;
      knowledgeFileTextCache.delete(oldest);
    }
    return text;
  } finally {
    await handle.close();
  }
}

function sourceForFile(def, file) {
  const rel = path.relative(def.root, file.filePath);
  const publicTitle = rel
    .replace(/\\/g, "/")
    .replace(/^scopes\/[a-f0-9]{8,64}\//i, "")
    .replace(/^admin\//i, "");
  return {
    sourceId: def.id,
    kind: def.kind,
    privacy: def.privacy,
    title: publicTitle || path.basename(file.filePath),
    fileName: path.basename(file.filePath),
    filePath: file.filePath,
    scopeHash: docScopeHash(def, file.filePath),
    mtimeMs: file.mtimeMs,
    size: file.size
  };
}

async function listDocs(config = {}, filter = null, scopeFilter = {}) {
  const docs = [];
  for (const def of sourceDefinitions(config)) {
    if (filter && !filter.has(def.id) && !filter.has(def.kind)) continue;
    const files = await walkFiles(def.root, { exts: def.exts, limit: def.limit || 240 });
    for (const file of files) {
      const doc = sourceForFile(def, file);
      if (docMatchesRuntimeScope(doc, scopeFilter)) docs.push(doc);
    }
  }
  return docs;
}

function extractTerms(query) {
  const terms = new Set();
  const text = String(query || "").toLowerCase();
  for (const match of text.matchAll(/[a-z0-9_.-]{2,64}/gi)) terms.add(match[0].toLowerCase());
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,12}/g)) terms.add(match[0]);
  return [...terms].slice(0, 40);
}

function scoreText(doc, text, terms) {
  if (!terms.length) return 1;
  const haystack = `${doc.sourceId}\n${doc.title}\n${text}`.toLowerCase();
  let score = 0;
  const hits = [];
  for (const term of terms) {
    const count = haystack.split(term).length - 1;
    if (count > 0) {
      score += Math.min(60, count * (2 + Math.min(term.length, 12)));
      hits.push(term);
    }
  }
  return { score, hits: [...new Set(hits)].slice(0, 8) };
}

function docSignature(docs) {
  return fullHash(JSON.stringify({
    version: SEMANTIC_INDEX_VERSION,
    model: SEMANTIC_MODEL,
    docs: docs.map((doc) => ({
      sourceId: doc.sourceId,
      kind: doc.kind,
      title: doc.title,
      scopeHash: doc.scopeHash || "",
      mtimeMs: Math.trunc(doc.mtimeMs || 0),
      size: doc.size || 0
    }))
  }));
}

function chunkText(text, maxChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  const clean = sanitizeText(text).replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const chunks = [];
  const sections = clean
    .split(/(?=\n#{1,3}\s+|\n##\s+\d{4}-\d{2}-\d{2}|^---$)/gm)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const section of sections.length ? sections : [clean]) {
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
  return chunks.filter((chunk) => chunk.replace(/\s+/g, "").length >= 50).slice(0, MAX_CHUNKS_PER_DOC);
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
  const output = await extractor(String(text || "").slice(0, 1800), { pooling: "mean", normalize: true });
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
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath, value) {
  await writeSharedJsonAtomic(filePath, value, { space: 0 });
}

function isUsableSemanticIndex(index) {
  return index?.version === SEMANTIC_INDEX_VERSION &&
    index?.model === SEMANTIC_MODEL &&
    Array.isArray(index?.chunks);
}

function isFreshSemanticIndex(index, signature) {
  return isUsableSemanticIndex(index) && index.signature === signature;
}

async function loadCachedSemanticIndex(config = {}) {
  const filePath = semanticIndexPath(config);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    cachedSemanticIndex = null;
    cachedSemanticIndexMtimeMs = 0;
    return null;
  }
  if (cachedSemanticIndex && cachedSemanticIndexMtimeMs === stat.mtimeMs) return cachedSemanticIndex;
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

async function buildSemanticIndexInternal(config = {}, options = {}) {
  const docs = options.docs || await listDocs(config, null);
  const signature = options.signature || docSignature(docs);
  const cached = await loadCachedSemanticIndex(config);
  if (!options.force && isFreshSemanticIndex(cached, signature)) return cached;
  const chunks = [];
  for (const doc of docs) {
    if (doc.size > MAX_TEXT_BYTES && !["memory", "repo_docs", "ingested"].includes(doc.kind)) continue;
    const raw = await safeRead(doc.filePath).catch(() => "");
    const text = sanitizeText(raw);
    if (!text) continue;
    for (const [chunkIndex, chunk] of chunkText(text).entries()) {
      chunks.push({
        id: hash(`${doc.sourceId}:${doc.title}:${chunkIndex}:${chunk.slice(0, 80)}`, 16),
        sourceId: doc.sourceId,
        kind: doc.kind,
        privacy: doc.privacy,
        title: doc.title,
        fileName: doc.fileName,
        scopeHash: doc.scopeHash || "",
        mtimeMs: doc.mtimeMs,
        size: doc.size,
        chunkIndex,
        text: chunk
      });
    }
  }
  for (const chunk of chunks) {
    chunk.embedding = await embedText(`${chunk.sourceId} ${chunk.title}\n${chunk.text}`);
  }
  const index = {
    version: SEMANTIC_INDEX_VERSION,
    model: SEMANTIC_MODEL,
    signature,
    builtAt: new Date().toISOString(),
    chunks
  };
  await writeJsonAtomic(semanticIndexPath(config), index);
  const stat = await fs.stat(semanticIndexPath(config)).catch(() => null);
  cachedSemanticIndex = index;
  cachedSemanticIndexMtimeMs = stat?.mtimeMs || Date.now();
  lastSemanticBuildError = null;
  return index;
}

async function buildSemanticIndex(config = {}, options = {}) {
  if (semanticBuildPromise) return semanticBuildPromise;
  semanticBuildPromise = buildSemanticIndexInternal(config, options)
    .catch((error) => {
      lastSemanticBuildError = error;
      throw error;
    })
    .finally(() => {
      semanticBuildPromise = null;
    });
  return semanticBuildPromise;
}

function scheduleSemanticIndexRebuild(config = {}, options = {}) {
  if (semanticBuildPromise) return false;
  semanticBuildPromise = buildSemanticIndexInternal(config, { ...options, force: true })
    .catch((error) => {
      lastSemanticBuildError = error;
      return null;
    })
    .finally(() => {
      semanticBuildPromise = null;
    });
  return true;
}

async function resolveSemanticIndexForSearch(config = {}, options = {}) {
  const docs = await listDocs(config, null);
  const signature = docSignature(docs);
  const cached = await loadCachedSemanticIndex(config);
  if (isFreshSemanticIndex(cached, signature)) {
    return { index: cached, stale: false, warming: false };
  }
  if (isUsableSemanticIndex(cached) && (cached.chunks || []).length > 0) {
    const scheduled = scheduleSemanticIndexRebuild(config, { docs, signature, reason: options.reason || "stale-search" });
    return { index: cached, stale: true, warming: scheduled || Boolean(semanticBuildPromise) };
  }
  if (options.waitForFresh) {
    return { index: await buildSemanticIndex(config, { docs, signature }), stale: false, warming: false };
  }
  const scheduled = scheduleSemanticIndexRebuild(config, { docs, signature, reason: options.reason || "missing-search" });
  return { index: null, stale: false, warming: scheduled || Boolean(semanticBuildPromise) };
}

function filterMatches(filter, item, scopeFilter = {}) {
  if (filter && !filter.has(item.sourceId) && !filter.has(item.kind)) return false;
  if (scopeFilter.scopeHash && item.kind === "ingested" && item.scopeHash !== scopeFilter.scopeHash) return false;
  return true;
}

async function semanticMatches(config, query, filter, count, options = {}) {
  const resolved = await resolveSemanticIndexForSearch(config, {
    waitForFresh: options.waitForFresh === true,
    reason: "knowledge-search"
  });
  if (!resolved.index) {
    const suffix = lastSemanticBuildError ? ` Last error: ${lastSemanticBuildError instanceof Error ? lastSemanticBuildError.message : String(lastSemanticBuildError)}` : "";
    throw new Error(`semantic knowledge index is warming; keyword knowledge search can be used now.${suffix}`);
  }
  const queryEmbedding = await embedText(query);
  return (resolved.index.chunks || [])
    .filter((chunk) => Array.isArray(chunk.embedding) && filterMatches(filter, chunk, options.scopeFilter || {}))
    .map((chunk) => {
      const similarity = cosine(queryEmbedding, chunk.embedding);
      return {
        ...chunk,
        score: Math.round(60 + similarity * 120),
        semanticScore: Number(similarity.toFixed(4)),
        hits: [`semantic:${similarity.toFixed(2)}`, ...(resolved.stale ? ["stale-index"] : [])],
        snippet: clip(chunk.text, 900),
        mode: resolved.stale ? "semantic-stale" : "semantic"
      };
    })
    .filter((result) => result.semanticScore > MIN_SEMANTIC_SCORE)
    .sort((a, b) => b.semanticScore - a.semanticScore || b.mtimeMs - a.mtimeMs)
    .slice(0, count);
}

function snippetAround(text, terms, max = 900) {
  const clean = sanitizeText(text);
  const lower = clean.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const found = lower.indexOf(term.toLowerCase());
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) return clip(clean, max);
  const start = Math.max(0, index - Math.floor(max / 2));
  return clip(clean.slice(start, start + max), max);
}

async function knowledgeSources(config = {}) {
  const sources = [];
  for (const def of sourceDefinitions(config)) {
    const files = await walkFiles(def.root, { exts: def.exts, limit: def.limit || 500 });
    sources.push({
      id: def.id,
      kind: def.kind,
      privacy: def.privacy,
      root: def.root,
      fileCount: files.length,
      latest: files[0] ? new Date(files[0].mtimeMs).toISOString() : ""
    });
  }
  return {
    content: [{
      type: "text",
      text: [
        `KNOWLEDGE_SOURCES results=${sources.length}`,
        ...sources.map((source) => `${source.id} | ${source.kind} | files=${source.fileCount} | privacy=${source.privacy}`)
      ].join("\n")
    }],
    details: { status: "ok", sources }
  };
}

async function knowledgeSearch(config = {}, params = {}, ctx = {}) {
  const query = readString(params, "query");
  if (!query) throw new Error("query is required");
  const count = readCount(params, 6);
  const mode = normalizeMode(readString(params, "mode"));
  const fresh = readBoolean(params, "fresh", false);
  const filter = normalizeSourceFilter(readString(params, "sources") || readString(params, "source"));
  const scopeFilter = scopeFilterFromContext(ctx);
  const terms = extractTerms(query);
  const docs = await listDocs(config, filter, scopeFilter);
  const results = [];
  let semanticStatus = "not_requested";
  if (mode !== "semantic") {
    for (const doc of docs) {
      if (doc.size > MAX_TEXT_BYTES && !["memory", "repo_docs", "ingested"].includes(doc.kind)) continue;
      const raw = await safeRead(doc.filePath).catch(() => "");
      if (!raw) continue;
      const scored = scoreText(doc, raw, terms);
      if (scored.score <= 0) continue;
      results.push({
        ...doc,
        score: scored.score,
        hits: scored.hits,
        snippet: snippetAround(raw, terms),
        mode: "keyword"
      });
    }
  }
  if (mode !== "keyword") {
    try {
      const semantic = await semanticMatches(config, query, filter, Math.max(count, 6), {
        waitForFresh: mode === "semantic" || fresh,
        scopeFilter
      });
      semanticStatus = semantic.some((item) => item.mode === "semantic-stale") ? "stale" : "ok";
      results.push(...semantic);
    } catch (error) {
      semanticStatus = `warming:${error instanceof Error ? error.message : String(error)}`;
      if (mode === "semantic") throw error;
    }
  }
  const seen = new Set();
  const deduped = [];
  for (const item of results.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs)) {
    const key = `${item.sourceId}:${item.title}:${hash(item.snippet || item.chunkIndex || "", 8)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  const selected = deduped.slice(0, count);
  return {
    content: [{
      type: "text",
      text: [
        `KNOWLEDGE_SEARCH query=${query} mode=${mode} semantic=${semanticStatus} results=${selected.length}`,
        ...selected.map((item, index) => [
          `${index + 1}. source=${item.sourceId} | title=${item.title} | mode=${item.mode || "keyword"} | score=${item.score} | privacy=${item.privacy}`,
          `hits=${item.hits.join(",") || "-"}`,
          `snippet: ${item.snippet}`
        ].join("\n"))
      ].join("\n")
    }],
    details: {
      status: "ok",
      query,
      mode,
      semanticStatus,
      results: selected.map(publicResult),
      sources: selected.map(publicSource)
    }
  };
}

function publicResult(item) {
  return {
    sourceId: item.sourceId,
    kind: item.kind,
    privacy: item.privacy,
    title: item.title,
    fileName: item.fileName,
    score: item.score,
    semanticScore: item.semanticScore,
    mode: item.mode || "",
    hits: item.hits || [],
    snippet: item.snippet || "",
    mtime: item.mtimeMs ? new Date(item.mtimeMs).toISOString() : "",
    size: item.size
  };
}

function publicSource(item) {
  return {
    sourceId: item.sourceId,
    kind: item.kind,
    privacy: item.privacy,
    title: item.title,
    fileName: item.fileName,
    mode: item.mode || "",
    score: item.score,
    semanticScore: item.semanticScore,
    mtime: item.mtimeMs ? new Date(item.mtimeMs).toISOString() : ""
  };
}

async function knowledgeRecent(config = {}, params = {}, ctx = {}) {
  const count = readCount(params, 8);
  const filter = normalizeSourceFilter(readString(params, "sources") || readString(params, "source"));
  const docs = await listDocs(config, filter, scopeFilterFromContext(ctx));
  const selected = docs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, count);
  return {
    content: [{
      type: "text",
      text: [
        `KNOWLEDGE_RECENT results=${selected.length}`,
        ...selected.map((item, index) => `${index + 1}. source=${item.sourceId} | title=${item.title} | mtime=${new Date(item.mtimeMs).toISOString()} | privacy=${item.privacy}`)
      ].join("\n")
    }],
    details: { status: "ok", results: selected.map(publicResult) }
  };
}

function clearKnowledgeFileInventoryCache() {
  knowledgeFileInventoryCache.clear();
  knowledgeFileInventoryPromises.clear();
}

function clearKnowledgeFileTextCache() {
  knowledgeFileTextCache.clear();
  knowledgeFileTextCacheHits = 0;
  knowledgeFileTextCacheMisses = 0;
}

function clearKnowledgeCaches() {
  clearKnowledgeFileInventoryCache();
  clearKnowledgeFileTextCache();
}

function knowledgeFileInventoryCacheStats() {
  return {
    entries: knowledgeFileInventoryCache.size,
    pending: knowledgeFileInventoryPromises.size,
    recheckMs: KNOWLEDGE_FILE_INVENTORY_CACHE_MS
  };
}

function knowledgeFileTextCacheStats() {
  return {
    entries: knowledgeFileTextCache.size,
    hits: knowledgeFileTextCacheHits,
    misses: knowledgeFileTextCacheMisses,
    maxEntries: KNOWLEDGE_FILE_TEXT_CACHE_MAX_ENTRIES
  };
}

function allowedIngestRoots(config = {}) {
  const defaults = [
    openclawStatePath("media", "inbound"),
    openclawStatePath("media", "downloaded"),
    openclawStatePath("media", "practical-tools"),
    userDocsRoot(config)
  ];
  const extra = Array.isArray(config.allowedFileRoots) ? config.allowedFileRoots : [];
  return [...defaults, ...extra].map((entry) => path.resolve(String(entry))).filter(Boolean);
}

function isInside(root, target) {
  const rootNorm = path.resolve(root).toLowerCase();
  const targetNorm = path.resolve(target).toLowerCase();
  return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + path.sep);
}

function safeFileName(value, fallback = "note") {
  const raw = String(value || fallback).trim().replace(/\.[a-z0-9]{1,12}$/i, "");
  const cleaned = raw.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return cleaned || fallback;
}

async function appendJsonLine(filePath, record) {
  await appendFileLocked(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function buildIngestPayload(config = {}, params = {}) {
  const raw = readString(params, "file") || readString(params, "path");
  if (raw) {
    const input = raw.replace(/^`+|`+$/g, "");
    if (/^https?:\/\//i.test(input)) throw new Error("knowledge_ingest accepts bot-local files or text, not URLs");
    const resolved = path.resolve(input);
    if (!allowedIngestRoots(config).some((root) => isInside(root, resolved))) {
      throw new Error("file is outside allowed bot/local ingest directories");
    }
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error("file is not a file");
    if (stat.size > MAX_INGEST_BYTES) throw new Error("file is larger than 4 MB");
    const ext = path.extname(resolved).toLowerCase();
    if (!TEXT_EXTS.has(ext)) throw new Error(`unsupported knowledge text file type: ${ext || "unknown"}`);
    const text = await safeRead(resolved, MAX_INGEST_BYTES);
    return {
      title: readString(params, "title") || path.basename(resolved),
      text,
      tags: readString(params, "tags"),
      sourcePath: resolved,
      contentHash: fullHash(text),
      size: Buffer.byteLength(text, "utf8")
    };
  }
  const text = readString(params, "text") || readString(params, "content");
  if (!text) throw new Error("text/content is required");
  return {
    title: readString(params, "title") || "note",
    text,
    tags: readString(params, "tags"),
    sourcePath: "",
    contentHash: fullHash(text),
    size: Buffer.byteLength(text, "utf8")
  };
}

async function readIngestPlans(config = {}) {
  const parsed = await readJson(ingestPlansPath(config));
  return isRecord(parsed) && parsed.schema === 1 && isRecord(parsed.plans) ? parsed : { schema: 1, plans: {} };
}

async function writeIngestPlans(config = {}, store) {
  await writeJsonAtomic(ingestPlansPath(config), store);
}

async function withIngestPlanLock(config = {}, fn) {
  return await withStateFileLock(ingestPlansPath(config), fn);
}

function pruneIngestPlans(store, now = Date.now()) {
  const plans = {};
  for (const [id, plan] of Object.entries(store.plans || {})) {
    const expires = Date.parse(plan.expiresAt || "");
    if (plan.usedAt) continue;
    if (Number.isFinite(expires) && expires <= now) continue;
    plans[id] = plan;
  }
  return { schema: 1, plans };
}

async function makeIngestDraft(config = {}, params = {}, ctx = {}) {
  const payload = await buildIngestPayload(config, params);
  const approvalCode = newMutationApprovalCode("SAVE-KNOWLEDGE");
  const planId = newMutationPlanId("knowledge_ingest");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INGEST_PLAN_TTL_MS).toISOString();
  const targetFingerprint = mutationTargetFingerprint({
    title: payload.title,
    tags: payload.tags,
    sourcePath: payload.sourcePath,
    contentHash: payload.contentHash
  });
  const plan = bindMutationPlanToContext({
    id: planId,
    action: "knowledge_ingest.commit",
    createdAt: now.toISOString(),
    expiresAt,
    approvalCode,
    targetFingerprint,
    payload: {
      ...payload,
      text: clip(payload.text, MAX_INGEST_BYTES)
    },
    payloadSummary: {
      title: payload.title,
      tags: payload.tags,
      sourcePath: payload.sourcePath,
      size: payload.size,
      contentHash: payload.contentHash.slice(0, 16)
    }
  }, ctx, { label: "knowledge ingest draft" });
  await withIngestPlanLock(config, async () => {
    const store = pruneIngestPlans(await readIngestPlans(config));
    store.plans[plan.id] = plan;
    await writeIngestPlans(config, store);
  });
  return {
    content: [{
      type: "text",
      text: [
        "KNOWLEDGE_INGEST draft",
        `plan_id: ${plan.id}`,
        `title: ${payload.title}`,
        `size: ${payload.size}`,
        `approval_code: ${approvalCode}`,
        "To persist this note, the original requester must send the approval code in a later message, then call action=commit with plan_id."
      ].join("\n")
    }],
    details: { status: "draft", plan_id: plan.id, approval_code: approvalCode, title: payload.title, size: payload.size, expiresAt }
  };
}

function scopedUserDocsRoot(config = {}, scopeKey = "") {
  if (!scopeKey) return path.join(userDocsRoot(config), "admin");
  return path.join(userDocsRoot(config), "scopes", scopeHash(scopeKey));
}

async function writeIngestPayload(config = {}, payload = {}, auth = {}) {
  const title = payload.title || "note";
  const tags = payload.tags || "";
  const id = `doc_${hash(`${auth.scopeKey || "admin"}:${Date.now()}:${title}:${payload.contentHash}`, 16)}`;
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeFileName(title)}.md`;
  const outDir = scopedUserDocsRoot(config, auth.scopeKey || "");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, filename);
  const body = [
    `# ${title}`,
    "",
    `- id: ${id}`,
    `- created: ${new Date().toISOString()}`,
    tags ? `- tags: ${tags}` : "",
    payload.sourcePath ? `- source: ${payload.sourcePath}` : "",
    "",
    clip(payload.text, MAX_INGEST_BYTES)
  ].filter(Boolean).join("\n");
  await fs.writeFile(outPath, `${body}\n`, "utf8");
  await appendJsonLine(ingestIndexPath(config), {
    type: "knowledge_ingest",
    id,
    t: new Date().toISOString(),
    title,
    path: outPath,
    tags,
    sourcePath: payload.sourcePath || "",
    scopeKey: auth.scopeKey || "",
    actorKey: auth.actorKey || "",
    scopeHash: auth.scopeKey ? scopeHash(auth.scopeKey) : "admin",
    contentHash: payload.contentHash || fullHash(payload.text || ""),
    size: Buffer.byteLength(body, "utf8")
  });
  clearKnowledgeCaches();
  return {
    content: [{ type: "text", text: `KNOWLEDGE_INGEST ok\nid: ${id}\ntitle: ${title}\nsource: user_docs` }],
    details: { status: "ok", id, title, path: outPath, sourceId: "user_docs" }
  };
}

async function commitIngestDraft(config = {}, params = {}, ctx = {}) {
  const planId = readString(params, "plan_id") || readString(params, "planId") || readString(params, "id");
  if (!planId) throw new Error("plan_id is required for knowledge_ingest commit");
  return await withIngestPlanLock(config, async () => {
    const store = pruneIngestPlans(await readIngestPlans(config));
    const plan = store.plans[planId];
    if (!plan) throw new Error("knowledge ingest plan not found or expired");
    const verified = verifyMutationPlanApproval({
      plan,
      ctx,
      approvalCode: plan.approvalCode,
      label: "knowledge ingest"
    });
    if (!verified.ok) throw new Error(verified.reason);
    const result = await writeIngestPayload(config, plan.payload, {
      scopeKey: plan.scopeKey || verified.context.scopeKey,
      actorKey: plan.actorKey || verified.context.actorKey
    });
    store.plans[planId] = { ...plan, usedAt: new Date().toISOString(), documentId: result.details.id };
    await writeIngestPlans(config, store);
    return result;
  });
}

async function readIngestEvents(config = {}) {
  let raw = "";
  try {
    raw = await fs.readFile(ingestIndexPath(config), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed)) out.push(parsed);
    } catch {}
  }
  return out;
}

async function listIngestedRecords(config = {}, ctx = {}) {
  const filter = scopeFilterFromContext(ctx);
  const records = new Map();
  for (const event of await readIngestEvents(config)) {
    if (event.event === "delete" && event.id) {
      records.delete(event.id);
      continue;
    }
    if (event.type !== "knowledge_ingest" || !event.id) continue;
    if (filter.scopeHash && event.scopeHash !== filter.scopeHash) continue;
    records.set(event.id, event);
  }
  return [...records.values()].sort((a, b) => String(b.t || "").localeCompare(String(a.t || "")));
}

async function listIngestedTool(config = {}, params = {}, ctx = {}) {
  const count = readCount(params, 8);
  const records = (await listIngestedRecords(config, ctx)).slice(0, count);
  return {
    content: [{
      type: "text",
      text: [
        `KNOWLEDGE_INGEST list results=${records.length}`,
        ...records.map((item, index) => `${index + 1}. id=${item.id} | title=${item.title} | size=${item.size || 0} | tags=${item.tags || "-"}`)
      ].join("\n")
    }],
    details: { status: "ok", records: records.map((item) => ({ id: item.id, title: item.title, tags: item.tags || "", size: item.size || 0, createdAt: item.t || "" })) }
  };
}

async function deleteIngestedTool(config = {}, params = {}, ctx = {}) {
  const id = readString(params, "id") || readString(params, "doc_id") || readString(params, "document_id");
  if (!id) throw new Error("id is required for knowledge_ingest delete");
  const dryRun = params.dryRun === undefined ? true : readBoolean(params, "dryRun", true);
  const reason = clip(readString(params, "reason") || readString(params, "note"), 300);
  const records = await listIngestedRecords(config, ctx);
  const record = records.find((item) => item.id === id);
  if (!record) {
    return { content: [{ type: "text", text: "KNOWLEDGE_INGEST delete no_match" }], details: { status: "no_match", id } };
  }
  if (dryRun) {
    return { content: [{ type: "text", text: `KNOWLEDGE_INGEST delete dryRun\nid: ${id}\ntitle: ${record.title}` }], details: { status: "dry_run", id, record } };
  }
  const context = normalizeKnowledgeContext(ctx);
  if (!context.actorKey) throw new Error("knowledge_ingest delete dryRun:false requires trusted runtime actor context");
  await fs.rm(record.path, { force: true }).catch(() => {});
  await appendJsonLine(ingestIndexPath(config), {
    type: "knowledge_ingest",
    event: "delete",
    id,
    t: new Date().toISOString(),
    reason,
    targetFingerprint: mutationTargetFingerprint({
      id,
      title: record.title || "",
      path: record.path || "",
      scopeHash: record.scopeHash || "",
      contentHash: record.contentHash || ""
    }),
    scopeKey: record.scopeKey || "",
    actorKey: context.actorKey,
    scopeHash: record.scopeHash || "",
    deletedBy: {
      accountId: context.accountId || "",
      chatId: context.chatId || "",
      threadId: context.threadId || "",
      sessionKey: context.sessionKey || "",
      windowId: context.windowId || "",
      senderId: context.senderId || "",
      messageId: context.messageId || ""
    }
  });
  clearKnowledgeCaches();
  return { content: [{ type: "text", text: `KNOWLEDGE_INGEST delete ok\nid: ${id}` }], details: { status: "ok", id } };
}

async function ingestDirectForAdmin(config = {}, params = {}) {
  const payload = await buildIngestPayload(config, params);
  return await writeIngestPayload(config, payload, {});
}

async function knowledgeIngest(config = {}, params = {}, ctx = {}) {
  const action = readString(params, "action", readString(params, "plan_id") || readString(params, "planId") ? "commit" : "draft").toLowerCase();
  if (action === "draft" || action === "plan") return await makeIngestDraft(config, params, ctx);
  if (action === "commit" || action === "save") return await commitIngestDraft(config, params, ctx);
  if (action === "list") return await listIngestedTool(config, params, ctx);
  if (action === "delete") return await deleteIngestedTool(config, params, ctx);
  if (action === "admin_direct" && config.allowAdminDirectKnowledgeIngest === true) return await ingestDirectForAdmin(config, params);
  throw new Error("action must be draft, commit, list, or delete");
}

function tool(name, label, description, parameters, fn) {
  return { name, label, description, parameters, execute: async (_id, params, _signal, _onUpdate, ctx) => {
    try {
      return await fn(params || {}, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `${name.toUpperCase()} error: ${clip(message, 500)}` }], details: { status: "failed", error: message } };
    }
  } };
}

const sourcesTool = tool(SOURCES_TOOL, "Knowledge Sources", "List registered lightweight knowledge sources.", {
  type: "object",
  additionalProperties: false,
  properties: {}
}, (params) => knowledgeSources(sourcesTool.config || {}, params));

const searchTool = tool(SEARCH_TOOL, "Knowledge Search", "Search persona, prompt library, tool manuals, memory, and user-ingested docs.", {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Search query." },
    sources: { type: "string", description: "Optional comma-separated source ids or kinds." },
    source: { type: "string", description: "Alias for sources." },
    count: { type: "number", description: `Max results 1-${MAX_RESULTS}.` },
    mode: { type: "string", enum: ["hybrid", "semantic", "keyword"], description: "hybrid is default; semantic waits for the embedding index only when explicitly requested." },
    fresh: { type: "boolean", description: "If true, wait for a fresh semantic index in hybrid mode." }
  },
  required: ["query"]
}, (params, ctx) => knowledgeSearch(searchTool.config || {}, params, ctx));

const recentTool = tool(RECENT_TOOL, "Knowledge Recent", "List recent documents from registered knowledge sources.", {
  type: "object",
  additionalProperties: false,
  properties: {
    sources: { type: "string", description: "Optional comma-separated source ids or kinds." },
    source: { type: "string", description: "Alias for sources." },
    count: { type: "number", description: `Max results 1-${MAX_RESULTS}.` }
  }
}, (params, ctx) => knowledgeRecent(recentTool.config || {}, params, ctx));

const ingestTool = tool(INGEST_TOOL, "Knowledge Ingest", "Draft, commit, list, or delete scoped user_docs notes from text or bot-local text files.", {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["draft", "commit", "list", "delete"], description: "Default draft; commit persists an approved draft." },
    plan_id: { type: "string", description: "Draft plan id for commit." },
    id: { type: "string", description: "Document id for delete." },
    reason: { type: "string", description: "Optional model/operator reason for a delete tombstone." },
    title: { type: "string", description: "Document title." },
    text: { type: "string", description: "Text to save." },
    content: { type: "string", description: "Alias for text." },
    file: { type: "string", description: "Bot-local text file path." },
    path: { type: "string", description: "Alias for file." },
    tags: { type: "string", description: "Optional comma-separated tags." },
    dryRun: { type: "boolean", description: "For delete, true by default." },
    count: { type: "number", description: `For list, max results 1-${MAX_RESULTS}.` }
  }
}, (params, ctx) => knowledgeIngest(ingestTool.config || {}, params, ctx));

const knowledgeTool = tool(KNOWLEDGE_TOOL, "Knowledge", "Read local knowledge sources through action=sources, search, or recent. Ingest remains knowledge_ingest.", {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["sources", "search", "recent"],
      description: "Read action. Default search when query is supplied; otherwise sources."
    },
    query: { type: "string", description: "Search query." },
    sources: { type: "string", description: "Optional comma-separated source ids or kinds." },
    source: { type: "string", description: "Alias for sources." },
    count: { type: "number", description: `Max results 1-${MAX_RESULTS}.` },
    mode: { type: "string", enum: ["hybrid", "semantic", "keyword"], description: "hybrid is default; semantic waits only when explicitly requested." },
    fresh: { type: "boolean", description: "If true, wait for a fresh semantic index in hybrid mode." }
  }
}, async (params, ctx) => {
  const requested = readString(params, "action").toLowerCase();
  const action = requested || (readString(params, "query") ? "search" : "sources");
  if (action === "sources") return knowledgeSources(knowledgeTool.config || {});
  if (action === "search") return knowledgeSearch(knowledgeTool.config || {}, params, ctx);
  if (action === "recent") return knowledgeRecent(knowledgeTool.config || {}, params, ctx);
  throw new Error("action must be sources, search, or recent");
});

export const __testing = {
  sourceDefinitions,
  listDocs,
  knowledgeSources,
  knowledgeSearch,
  knowledgeRecent,
  knowledgeIngest,
  clearKnowledgeCaches,
  clearKnowledgeFileInventoryCache,
  clearKnowledgeFileTextCache,
  knowledgeFileInventoryCacheStats,
  knowledgeFileTextCacheStats,
  extractTerms,
  normalizeMode,
  chunkText,
  docSignature,
  semanticIndexPath,
  allowedIngestRoots,
  storeRoot,
  userDocsRoot
};

export default {
  id: "imagebot-knowledge-library",
  name: "Imagebot Knowledge Library",
  description: "Unified lightweight knowledge source registry and search.",
  register(api) {
    const config = api.config || {};
    for (const item of [knowledgeTool, sourcesTool, searchTool, recentTool, ingestTool]) item.config = config;
    api.registerTool(knowledgeTool, { name: KNOWLEDGE_TOOL });
    api.registerTool(sourcesTool, { name: SOURCES_TOOL });
    api.registerTool(searchTool, { name: SEARCH_TOOL });
    api.registerTool(recentTool, { name: RECENT_TOOL });
    api.registerTool(ingestTool, { name: INGEST_TOOL });
  }
};

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { screenVisionContextImage, buildSafetyReviewPrompt } from "../imagebot-shared/vision-context-gate.mjs";
import { registerLifecycleHook } from "../imagebot-shared/openclaw-lifecycle-hooks.mjs";
import { resolveExistingMediaUriToLocalPath, resolveMediaReferencePaths, stripMediaUriDecorations } from "../imagebot-shared/media-uri.mjs";
import { openclawStatePath } from "../imagebot-shared/openclaw-paths.mjs";

const RECENT_TOOL = "media_artifact_recent";
const LINEAGE_TOOL = "media_artifact_lineage";
const MEDIA_ARTIFACT_TOOL = "media_artifact";

const MAX_CONTEXT_ITEMS = 16;
const MAX_LINEAGE_SOURCES = 8;
const MAX_RECENT = 20;
const MAX_INDEX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_TOOL_RESULT_IMAGE_CONTEXT_MAX_IMAGES = 6;
const DEFAULT_TOOL_RESULT_IMAGE_CONTEXT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TOOL_RESULT_IMAGE_CONTEXT_PREVIEW_MAX_BYTES = 1250 * 1024;
const DEFAULT_TOOL_RESULT_IMAGE_CONTEXT_PREVIEW_MAX_EDGE = 1536;
const GENERATED_RE = /(?:^|[\\/])tool-image-generation(?:[\\/]|$)|media:\/\/tool-image-generation\//i;
const INBOUND_RE = /(?:^|[\\/])inbound(?:[\\/]|$)|media:\/\/inbound\//i;
const DOWNLOADED_RE = /(?:^|[\\/])downloaded(?:[\\/]|$)|media:\/\/downloaded\//i;
const MEDIA_LINE_RE = /\bMEDIA:([^\r\n]+)/g;
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);

const contextsByRun = new Map();
const contextsBySession = new Map();
const pendingByToolCall = new Map();
const pendingQueuesBySession = new Map();
const knownArtifactKeys = new Set();
const HANDLE_RE = /^(?:current|reply)\.(?:image|generated)\.\d+(?:\.source\.\d+)?$/i;
const TOOL_MEDIA_INPUT_SPECS = new Map([
  ["media_transform", { fields: ["input", "image"] }],
  ["meme_transform", { fields: ["input", "image"] }],
  ["sticker_pack", { fields: ["input", "image", "media", "stickerPath", "prepared", "file"], arrays: ["inputs"], itemArrays: ["items"], itemFields: ["input", "image", "media", "stickerPath", "prepared", "file"] }],
  ["audio_transcribe", { fields: ["input", "audio", "video", "media"] }],
  ["telegram_media_spoiler", { fields: ["media", "path"], arrays: ["mediaUrls"] }],
  ["qr_tool", { fields: ["image", "input"] }],
  ["pdf_render", { fields: ["pdf", "input", "document"] }],
  ["av_media", { fields: ["input", "media", "video", "audio"] }],
  ["video_keyframes", { fields: ["video", "input", "media"] }],
  ["media_brief", { fields: ["video", "input", "media"] }],
  ["reverse_image_search", { fields: ["image", "imagePath", "url"] }],
  ["browser", { arrays: ["paths"] }],
  ["image_skill_save_reference", { fields: ["media", "image", "path"] }]
]);

function nowIso() {
  return new Date().toISOString();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  return typeof value === "string" ? value.trim() : fallback;
}

function readCount(params, fallback = 8, max = MAX_RECENT) {
  const raw = isRecord(params) ? params.count : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function clip(value, max = 220) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 12)).trimEnd()}...`;
}

function hashText(value, len = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function normalizePathKey(value) {
  const raw = String(value || "").trim().replace(/^`+|`+$/g, "");
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^media:\/\//i.test(raw)) return raw.toLowerCase();
  if (/^file:\/\//i.test(raw)) {
    try {
      return path.resolve(decodeURIComponent(raw.replace(/^file:\/\//i, ""))).toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw)) {
    return path.resolve(raw).toLowerCase();
  }
  return raw.toLowerCase();
}

function artifactIdForPath(value) {
  return `ma_${hashText(normalizePathKey(value) || value, 18)}`;
}

function classifyPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "unknown";
  if (/^https?:\/\//i.test(raw)) return "public_url";
  if (GENERATED_RE.test(raw)) return "generated";
  if (INBOUND_RE.test(raw)) return "telegram_inbound";
  if (DOWNLOADED_RE.test(raw)) return "downloaded";
  if (/^data:image\//i.test(raw)) return "data_image";
  return "local_or_media";
}

function isGeneratedPath(value) {
  return classifyPath(value) === "generated";
}

function storeRoot(config) {
  const configured = String(config?.storeDir || "").trim();
  return path.resolve(configured || openclawStatePath("media-artifacts"));
}

function artifactLogPath(config) {
  return path.join(storeRoot(config), "artifacts.jsonl");
}

async function appendJsonLine(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function readTail(filePath, maxBytes = MAX_INDEX_READ_BYTES) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
  if (!stat.isFile() || stat.size <= 0) return "";
  if (stat.size <= maxBytes) return await fs.readFile(filePath, "utf8");
  const length = maxBytes;
  const position = Math.max(0, stat.size - length);
  const handle = await fs.open(filePath, "r");
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

async function loadArtifactEntries(config) {
  const raw = await readTail(artifactLogPath(config));
  if (!raw) return [];
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (isRecord(record) && record.type === "artifact") entries.push(record);
    } catch {
      // Keep the store append-only and salvage-friendly.
    }
  }
  return entries;
}

async function loadLatestArtifactByPath(config) {
  const latest = new Map();
  for (const entry of await loadArtifactEntries(config)) {
    const key = normalizePathKey(entry.path);
    if (key) latest.set(key, entry);
    const localPath = await resolveExistingMediaUriToLocalPath(entry.path, config);
    const localKey = normalizePathKey(localPath);
    if (localKey) latest.set(localKey, entry);
  }
  return latest;
}

function splitPathList(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const compact = text.replace(/\s+\|\s+.+$/, "").trim();
  const delimited = compact.split(/[,\t]/).map((item) => item.trim()).filter(Boolean);
  if (delimited.length > 1) return delimited;
  if (/^[A-Za-z]:[\\/]/.test(compact) || /^media:\/\//i.test(compact) || /^https?:\/\//i.test(compact)) {
    return [compact];
  }
  return delimited;
}

function addUniquePath(list, value) {
  const raw = String(value || "").trim().replace(/^`+|`+$/g, "");
  if (!raw) return;
  const key = normalizePathKey(raw);
  if (!key || list.some((item) => normalizePathKey(item) === key)) return;
  list.push(raw);
}

function extractMediaPathsFromText(text) {
  const source = String(text || "");
  const current = [];
  const reply = [];
  const recent = [];
  const generated = [];

  for (const match of source.matchAll(/^(ReplyMediaPaths|CurrentMediaPaths|WindowRecentMediaPaths):\s*(.+)$/gim)) {
    const target = match[1] === "ReplyMediaPaths" ? reply : match[1] === "CurrentMediaPaths" ? current : recent;
    for (const item of splitPathList(match[2])) addUniquePath(target, item);
  }

  for (const match of source.matchAll(/\[media attached:\s*([^\]\|\r\n]+)/gi)) {
    addUniquePath(current, match[1]);
  }

  for (const match of source.matchAll(MEDIA_LINE_RE)) {
    const media = match[1].trim();
    if (isGeneratedPath(media)) addUniquePath(generated, media);
  }

  return { current, reply, recent, generated };
}

function makeArtifact({ pathValue, sourceKind, handle, sessionKey, runId, lineage = [], prompt = "", extra = {} }) {
  return {
    type: "artifact",
    artifactId: artifactIdForPath(pathValue),
    t: nowIso(),
    kind: "image",
    sourceKind,
    handle,
    path: pathValue,
    pathKey: normalizePathKey(pathValue),
    sessionKey,
    runId,
    lineage,
    promptPreview: clip(prompt, 300),
    promptHash: prompt ? hashText(prompt, 20) : "",
    ...extra
  };
}

function addContextItem(items, handleMap, item) {
  if (!item?.handle || !item?.path) return;
  const key = normalizePathKey(item.path);
  if (!key) return;
  if (items.some((existing) => existing.handle === item.handle || normalizePathKey(existing.path) === key)) return;
  items.push(item);
  handleMap.set(item.handle, item);
}

async function buildMediaContext(config, event, ctx) {
  const prompt = String(event?.prompt || "");
  const parsed = extractMediaPathsFromText(prompt);
  const latestByPath = await loadLatestArtifactByPath(config);
  const currentPaths = await resolveMediaReferencePaths(parsed.current, config);
  const replyPaths = await resolveMediaReferencePaths(parsed.reply, config);
  const generatedPaths = await resolveMediaReferencePaths(parsed.generated, config);
  const items = [];
  const handleMap = new Map();
  const sessionKey = ctx?.sessionKey;
  const runId = ctx?.runId;

  const addPaths = (paths, prefix, sourceFallback) => {
    let index = 0;
    for (const pathValue of paths.slice(0, MAX_CONTEXT_ITEMS)) {
      const sourceKind = classifyPath(pathValue) === "generated" ? "generated" : sourceFallback;
      const handle = `${prefix}.${index++}`;
      addContextItem(items, handleMap, {
        handle,
        path: pathValue,
        pathKey: normalizePathKey(pathValue),
        sourceKind,
        artifactId: artifactIdForPath(pathValue),
        lineage: []
      });
    }
  };

  addPaths(currentPaths, "current.image", "telegram_current");
  addPaths(replyPaths.filter((entry) => !isGeneratedPath(entry)), "reply.image", "telegram_reply");
  addPaths(replyPaths.filter((entry) => isGeneratedPath(entry)), "reply.generated", "generated");
  addPaths(generatedPaths, "reply.generated", "generated");

  for (const item of [...items]) {
    if (item.sourceKind !== "generated") continue;
    const previous = latestByPath.get(item.pathKey);
    const lineage = Array.isArray(previous?.lineage) ? previous.lineage : [];
    item.lineage = lineage;
    let sourceIndex = 0;
    for (const source of lineage.slice(0, MAX_LINEAGE_SOURCES)) {
      const sourcePath = typeof source === "string" ? source : source?.path;
      if (!sourcePath) continue;
      addContextItem(items, handleMap, {
        handle: `${item.handle}.source.${sourceIndex++}`,
        path: sourcePath,
        pathKey: normalizePathKey(sourcePath),
        sourceKind: classifyPath(sourcePath),
        artifactId: artifactIdForPath(sourcePath),
        lineage: []
      });
    }
  }

  for (const item of items) {
    if (item.sourceKind === "generated") continue;
    await rememberArtifact(config, makeArtifact({
      pathValue: item.path,
      sourceKind: item.sourceKind,
      handle: item.handle,
      sessionKey,
      runId,
      prompt
    }));
  }

  return {
    sessionKey,
    runId,
    promptHash: hashText(prompt, 20),
    createdAt: Date.now(),
    items,
    handleMap
  };
}

async function rememberArtifact(config, artifact) {
  const key = `${artifact.artifactId}:${artifact.sessionKey || ""}:${artifact.runId || ""}:${artifact.handle || ""}:${artifact.sourceKind || ""}`;
  if (knownArtifactKeys.has(key)) return;
  knownArtifactKeys.add(key);
  await appendJsonLine(artifactLogPath(config), artifact);
}

function formatContextForPrompt(context) {
  if (!context?.items?.length) return "";
  const lines = [
    "[Imagebot 媒体句柄]",
    "这些句柄可用于 image_generate.image/images，也可用于 media_transform、meme_transform、sticker_pack add、pdf_render、av_media、audio_transcribe、video_keyframes、media_brief、qr_tool decode 等媒体参数；运行时会解析成真实路径。不要编造未列出的句柄。旧生成图只有列在这里时才有效。"
  ];
  for (const item of context.items.slice(0, MAX_CONTEXT_ITEMS)) {
    const label = item.sourceKind === "generated" ? "bot 生成图" :
      item.sourceKind.includes("reply") ? "回复中的 Telegram 图像" :
      item.sourceKind.includes("current") ? "当前 Telegram 图像" :
      item.sourceKind;
    lines.push(`- ${item.handle}: ${label}`);
  }
  lines.push("如果回复的是生成图，`reply.generated.N` 只用于编辑那张生成图本身；要从原始来源重做，用 `reply.generated.N.source.M`。");
  lines.push("[/Imagebot 媒体句柄]");
  return lines.join("\n");
}

function getContext(event, ctx) {
  const runId = event?.runId || ctx?.runId;
  const sessionKey = ctx?.sessionKey;
  return (runId && contextsByRun.get(runId)) || (sessionKey && contextsBySession.get(sessionKey)) || null;
}

function readImageInputs(params) {
  const refs = [];
  const image = readString(params, "image");
  if (image) refs.push({ key: "image", value: image });
  if (Array.isArray(params?.images)) {
    for (const value of params.images) {
      if (typeof value === "string" && value.trim()) refs.push({ key: "images", value: value.trim() });
    }
  }
  return refs;
}

function resolveImageInputs(params, context) {
  const next = { ...params };
  const resolvedRefs = [];
  const resolveOne = (value) => {
    const raw = String(value || "").trim();
    const handle = context?.handleMap?.get(raw);
    if (handle) {
      return { value: handle.path, viaHandle: true, handle: raw, sourceKind: handle.sourceKind };
    }
    return { value: raw, viaHandle: false, handle: "", sourceKind: classifyPath(raw) };
  };

  if (typeof next.image === "string" && next.image.trim()) {
    const resolved = resolveOne(next.image);
    next.image = resolved.value;
    resolvedRefs.push(resolved);
  }
  if (Array.isArray(next.images)) {
    next.images = next.images.map((entry) => {
      if (typeof entry !== "string") return entry;
      const resolved = resolveOne(entry);
      resolvedRefs.push(resolved);
      return resolved.value;
    });
  }
  return { params: next, resolvedRefs };
}

function resolveMediaHandleString(value, context) {
  const raw = String(value || "").trim();
  const unwrapped = stripMediaUriDecorations(raw);
  const handle = context?.handleMap?.get(unwrapped) || context?.handleMap?.get(raw);
  if (handle) {
    return {
      value: handle.path,
      resolved: { value: handle.path, viaHandle: true, handle: unwrapped, sourceKind: handle.sourceKind },
      changed: true
    };
  }
  return {
    value,
    resolved: { value: unwrapped || raw, viaHandle: false, handle: "", sourceKind: classifyPath(unwrapped || raw) },
    changed: false
  };
}

function resolveMediaHandleFields(target, fields, context, resolvedRefs) {
  if (!isRecord(target)) return { value: target, changed: false };
  let next = target;
  let changed = false;
  const set = (key, value) => {
    if (!changed) next = { ...target };
    next[key] = value;
    changed = true;
  };
  for (const key of fields || []) {
    if (typeof target[key] !== "string" || !target[key].trim()) continue;
    const resolved = resolveMediaHandleString(target[key], context);
    resolvedRefs.push(resolved.resolved);
    if (resolved.changed) set(key, resolved.value);
  }
  return { value: next, changed };
}

function resolveMediaHandleArray(entries, itemFields, context, resolvedRefs) {
  if (!Array.isArray(entries)) return { value: entries, changed: false };
  let changed = false;
  const next = entries.map((entry) => {
    if (typeof entry === "string") {
      const resolved = resolveMediaHandleString(entry, context);
      resolvedRefs.push(resolved.resolved);
      if (resolved.changed) changed = true;
      return resolved.value;
    }
    if (isRecord(entry)) {
      const resolved = resolveMediaHandleFields(entry, itemFields, context, resolvedRefs);
      if (resolved.changed) changed = true;
      return resolved.value;
    }
    return entry;
  });
  return { value: changed ? next : entries, changed };
}

function resolveToolMediaInputs(params, context, spec = {}) {
  const original = isRecord(params) ? params : {};
  let next = original;
  let changed = false;
  const resolvedRefs = [];
  const set = (key, value) => {
    if (!changed) next = { ...original };
    next[key] = value;
    changed = true;
  };

  const topLevel = resolveMediaHandleFields(original, spec.fields || [], context, resolvedRefs);
  if (topLevel.changed) {
    next = topLevel.value;
    changed = true;
  }
  for (const key of spec.arrays || []) {
    const source = changed ? next[key] : original[key];
    const resolved = resolveMediaHandleArray(source, spec.itemFields || [], context, resolvedRefs);
    if (resolved.changed) set(key, resolved.value);
  }
  for (const key of spec.itemArrays || []) {
    const source = changed ? next[key] : original[key];
    const resolved = resolveMediaHandleArray(source, spec.itemFields || [], context, resolvedRefs);
    if (resolved.changed) set(key, resolved.value);
  }

  return { params: changed ? next : original, resolvedRefs, changed };
}

function findBadGeneratedRefs(resolvedRefs, strictGeneratedRefs) {
  if (!strictGeneratedRefs) return [];
  return resolvedRefs.filter((ref) => isGeneratedPath(ref.value) && !ref.viaHandle);
}

function findUnavailableHandleRefs(resolvedRefs) {
  return resolvedRefs.filter((ref) => {
    if (ref.viaHandle) return false;
    return HANDLE_RE.test(String(ref.value || "").trim());
  });
}

function pendingKey(event, ctx) {
  return event?.toolCallId || ctx?.toolCallId || `${ctx?.runId || event?.runId || "run"}:${Date.now()}:${Math.random()}`;
}

function queuePending(sessionKey, pending) {
  if (!sessionKey) return;
  const queue = pendingQueuesBySession.get(sessionKey) || [];
  queue.push(pending);
  while (queue.length > 20) queue.shift();
  pendingQueuesBySession.set(sessionKey, queue);
}

function popPendingForSession(sessionKey) {
  if (!sessionKey) return null;
  const queue = pendingQueuesBySession.get(sessionKey);
  if (!queue?.length) return null;
  const pending = queue.find((item) => !item.consumed) || queue[0];
  pending.consumed = true;
  return pending;
}

function collectStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) collectStrings(child, out);
  }
  return out;
}

function collectGeneratedMediaPaths(value) {
  const found = [];
  for (const text of collectStrings(value)) {
    for (const match of text.matchAll(MEDIA_LINE_RE)) {
      if (isGeneratedPath(match[1])) addUniquePath(found, match[1]);
    }
    for (const match of text.matchAll(/[A-Za-z]:[\\/][^\r\n"']*?[\\/]tool-image-generation[\\/][^\r\n"']+\.(?:png|jpe?g|webp|gif)/gi)) {
      addUniquePath(found, match[0]);
    }
  }
  return found;
}

function readPositiveInteger(value, fallback, min, max) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function toolResultImageContextConfig(config = {}) {
  const raw = isRecord(config.toolResultImageContext) ? config.toolResultImageContext : {};
  return {
    enabled: raw.enabled !== false,
    maxImages: readPositiveInteger(raw.maxImages, DEFAULT_TOOL_RESULT_IMAGE_CONTEXT_MAX_IMAGES, 1, 20),
    maxSourceBytes: readPositiveInteger(raw.maxSourceBytes, DEFAULT_TOOL_RESULT_IMAGE_CONTEXT_MAX_BYTES, 64 * 1024, 100 * 1024 * 1024),
    previewMaxBytes: readPositiveInteger(raw.previewMaxBytes, DEFAULT_TOOL_RESULT_IMAGE_CONTEXT_PREVIEW_MAX_BYTES, 64 * 1024, 5 * 1024 * 1024),
    previewMaxEdge: readPositiveInteger(raw.previewMaxEdge, DEFAULT_TOOL_RESULT_IMAGE_CONTEXT_PREVIEW_MAX_EDGE, 256, 4096)
  };
}

function moduleCandidateBases(config = {}) {
  const bases = [];
  const add = (value) => {
    const text = String(value || "").trim();
    if (text) bases.push(path.resolve(text));
  };
  if (Array.isArray(config.dependencyDirs)) config.dependencyDirs.forEach(add);
  add(config.dependencyDir);
  add(path.join(process.cwd(), "plugins", "imagebot-practical-tools"));
  add(path.join(process.cwd(), "plugins", "web-image-search"));
  add(path.join(process.cwd(), "plugins", "imagebot-generated-gallery"));
  add(path.join(process.cwd(), "plugins", "imagebot-sticker-pack"));
  return [...new Set(bases)];
}

function requireFromCandidates(moduleName, config = {}) {
  const errors = [];
  for (const base of moduleCandidateBases(config)) {
    try {
      return createRequire(path.join(base, "index.js"))(moduleName);
    } catch (error) {
      errors.push(`${base}: ${error?.message || error}`);
    }
  }
  throw new Error(`Unable to load ${moduleName}; tried ${errors.join(" | ")}`);
}

function getSharp(config = {}) {
  const mod = requireFromCandidates("sharp", config);
  return mod?.default || mod;
}

function defaultMediaRoots(config = {}) {
  const roots = [
    openclawStatePath("media")
  ];
  if (Array.isArray(config.allowedMediaRoots)) {
    for (const root of config.allowedMediaRoots) if (typeof root === "string" && root.trim()) roots.push(root);
  }
  return roots.map((root) => path.resolve(root));
}

function isInsidePath(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || Boolean(rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function isAllowedLocalMediaPath(filePath, config = {}) {
  const resolved = path.resolve(filePath);
  return defaultMediaRoots(config).some((root) => isInsidePath(root, resolved));
}

function supportedImageMimeFromPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return "";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  return "image/*";
}

function cleanMediaPathCandidate(value) {
  let text = String(value || "").trim().replace(/^`+|`+$/g, "");
  if (!text) return "";
  const mediaMatch = text.match(/(?:SPOILER_)?MEDIA:\s*`?([^`\r\n]+)`?/i);
  if (mediaMatch) text = mediaMatch[1].trim();
  text = text.replace(/\s+\|\s+.+$/, "").trim().replace(/^`+|`+$/g, "");
  if (/^file:\/\//i.test(text)) {
    try {
      return decodeURIComponent(text.replace(/^file:\/\//i, ""));
    } catch {
      return "";
    }
  }
  return text;
}

function collectToolResultImagePaths(value, out = []) {
  if (typeof value === "string") {
    for (const match of value.matchAll(MEDIA_LINE_RE)) addUniquePath(out, cleanMediaPathCandidate(match[1]));
    const cleaned = cleanMediaPathCandidate(value);
    if (/^[A-Za-z]:[\\/]/.test(cleaned) || /^\\\\/.test(cleaned)) addUniquePath(out, cleaned);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectToolResultImagePaths(item, out);
    return out;
  }
  if (!isRecord(value)) return out;
  for (const [key, child] of Object.entries(value)) {
    if (/^(path|filePath|mediaPath|mediaUrl|outputPath|imagePath)$/i.test(key)) collectToolResultImagePaths(child, out);
    else if (/^(content|details|media|mediaUrls|attachments|images|files|result|results|contactSheet|reviewSheet)$/i.test(key)) collectToolResultImagePaths(child, out);
  }
  return out;
}

function resultHasImageContent(result = {}) {
  return Array.isArray(result.content) && result.content.some((block) => block?.type === "image");
}

async function buildToolResultImagePreview(filePath, config = {}) {
  const ctxConfig = toolResultImageContextConfig(config);
  const resolved = path.resolve(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size <= 0 || stat.size > ctxConfig.maxSourceBytes) return null;
  if (!isAllowedLocalMediaPath(resolved, config)) return null;
  const sourceMime = supportedImageMimeFromPath(resolved);
  if (!sourceMime) return null;
  const sharp = getSharp(config);
  const ext = path.extname(resolved);
  const base = path.basename(resolved, ext);
  const attempts = [
    { edge: ctxConfig.previewMaxEdge, quality: 82 },
    { edge: Math.min(ctxConfig.previewMaxEdge, 1280), quality: 76 },
    { edge: Math.min(ctxConfig.previewMaxEdge, 960), quality: 70 }
  ];
  for (const attempt of attempts) {
    const buffer = await sharp(resolved, { animated: false, limitInputPixels: false })
      .rotate()
      .resize(attempt.edge, attempt.edge, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: attempt.quality, mozjpeg: true })
      .toBuffer();
    if (buffer.length <= ctxConfig.previewMaxBytes) {
      return {
        type: "image",
        data: buffer.toString("base64"),
        mimeType: "image/jpeg",
        fileName: `${base}-context-preview.jpg`
      };
    }
  }
  return null;
}

function visionContextGateConfig(config = {}) {
  const nested = isRecord(config.visionContextGate) ? config.visionContextGate : {};
  const directLoliVisionGuard = isRecord(config.loliVisionGuard) ? config.loliVisionGuard :
    isRecord(config.loliNsfwVisionGuard) ? config.loliNsfwVisionGuard : {};
  const nestedLoliVisionGuard = isRecord(nested.loliVisionGuard) ? nested.loliVisionGuard :
    isRecord(nested.loliGuard) ? nested.loliGuard :
      isRecord(nested.loliNsfwVisionGuard) ? nested.loliNsfwVisionGuard : {};
  const loliVisionGuard = { ...directLoliVisionGuard, ...nestedLoliVisionGuard };
  return {
    ...config,
    ...nested,
    loliVisionGuard: {
      ...loliVisionGuard,
      dependencyDirs: Array.isArray(loliVisionGuard.dependencyDirs) ? loliVisionGuard.dependencyDirs : config.dependencyDirs
    }
  };
}

async function toolResultImageContextMiddleware(event, _ctx, config = {}) {
  const result = event?.result;
  const ctxConfig = toolResultImageContextConfig(config);
  if (event?.toolName === "tool_call") return { result };
  if (!ctxConfig.enabled || event?.isError || !isRecord(result) || !Array.isArray(result.content)) return { result };
  if (resultHasImageContent(result)) return { result };
  const candidates = collectToolResultImagePaths(result).filter((candidate) => {
    const cleaned = cleanMediaPathCandidate(candidate);
    return cleaned && supportedImageMimeFromPath(cleaned) && isAllowedLocalMediaPath(cleaned, config);
  });
  const unique = [];
  for (const candidate of candidates) addUniquePath(unique, cleanMediaPathCandidate(candidate));
  if (unique.length === 0) return { result };

  const content = [...result.content];
  const attached = [];
  const withheld = [];
  const skipped = [];
  const gateConfig = visionContextGateConfig(config);
  const contextText = result.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n").slice(0, 4000);
  for (const filePath of unique.slice(0, ctxConfig.maxImages)) {
    try {
      const gate = await screenVisionContextImage(filePath, {
        text: `${event.toolName || "tool_result"}\n${contextText}`,
        filename: path.basename(filePath)
      }, gateConfig);
      if (gate.blocked) {
        withheld.push({ pathHash: hashText(filePath, 16), reason: gate.reason });
        continue;
      }
      const preview = await buildToolResultImagePreview(filePath, config);
      if (!preview) {
        skipped.push({ pathHash: hashText(filePath, 16), reason: "preview_unavailable" });
        continue;
      }
      content.push(preview);
      attached.push({ pathHash: hashText(filePath, 16), mimeType: preview.mimeType });
    } catch (error) {
      skipped.push({ pathHash: hashText(filePath, 16), reason: String(error?.message || error).slice(0, 160) });
    }
  }
  if (withheld.length > 0) {
    content.push({ type: "text", text: buildSafetyReviewPrompt({ blockedCount: withheld.length }) });
  }
  if (attached.length === 0 && withheld.length === 0) return { result };
  return {
    result: {
      ...result,
      content,
      details: {
        ...(isRecord(result.details) ? result.details : {}),
        toolResultImageContext: {
          attachedCount: attached.length,
          withheldCount: withheld.length,
          skippedCount: skipped.length,
          attached,
          withheld
        }
      }
    }
  };
}

function parseTaskId(value) {
  const text = collectStrings(value).join("\n");
  const match = text.match(/image generation \(([0-9a-f-]{16,})\)/i) || text.match(/task(?:Id)?[=:]\s*([0-9a-f-]{16,})/i);
  return match?.[1] || "";
}

async function recordGeneratedPaths(config, paths, pending, ctx, source = "unknown") {
  for (const mediaPath of paths) {
    const artifact = makeArtifact({
      pathValue: mediaPath,
      sourceKind: "generated",
      handle: "",
      sessionKey: ctx?.sessionKey || pending?.sessionKey,
      runId: ctx?.runId || pending?.runId,
      lineage: (pending?.resolvedRefs || []).slice(0, MAX_LINEAGE_SOURCES).map((ref) => ({
        path: ref.value,
        sourceKind: ref.sourceKind || classifyPath(ref.value),
        handle: ref.handle || "",
        artifactId: artifactIdForPath(ref.value)
      })),
      prompt: pending?.prompt || "",
      extra: {
        source,
        toolCallId: pending?.toolCallId || ctx?.toolCallId || "",
        taskId: pending?.taskId || "",
        model: pending?.model || ""
      }
    });
    await rememberArtifact(config, artifact);
  }
}

async function listRecentArtifacts(config, params) {
  const count = readCount(params, 8);
  const source = readString(params, "source", "generated");
  const entries = (await loadArtifactEntries(config)).reverse();
  const filtered = entries.filter((entry) => {
    if (source === "all") return true;
    if (source === "input") return entry.sourceKind !== "generated";
    return entry.sourceKind === "generated";
  });
  return filtered.slice(0, count);
}

function findArtifact(entries, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  const rel = normalizePathKey(q);
  return entries.find((entry) => {
    return String(entry.artifactId || "").toLowerCase().includes(q) ||
      String(entry.promptHash || "").toLowerCase().startsWith(q) ||
      String(entry.pathKey || "").toLowerCase() === rel ||
      String(entry.path || "").toLowerCase().includes(q);
  }) || null;
}

function formatRecent(entries) {
  const lines = [
    `MEDIA_ARTIFACT_RECENT ok results=${entries.length}`,
    "Use current-turn media handles when they are listed in the current context. For older input attachments, pass the selected details.results[n].path to the target media tool. Use generated_gallery_resend for sending old generated images."
  ];
  entries.forEach((entry, index) => {
    lines.push(`${index + 1}. artifact_id=${entry.artifactId} | time=${entry.t} | source=${entry.sourceKind} | lineage=${Array.isArray(entry.lineage) ? entry.lineage.length : 0} | prompt=${clip(entry.promptPreview, 100)}`);
  });
  if (entries.length === 0) lines.push("No media artifacts recorded yet.");
  return lines.join("\n");
}

function formatLineage(entry) {
  if (!entry) return "MEDIA_ARTIFACT_LINEAGE no_match";
  const lines = [
    `MEDIA_ARTIFACT_LINEAGE ok artifact_id=${entry.artifactId}`,
    `time=${entry.t} source=${entry.sourceKind} lineage=${Array.isArray(entry.lineage) ? entry.lineage.length : 0}`,
    `prompt=${clip(entry.promptPreview, 220)}`
  ];
  for (const [index, source] of (entry.lineage || []).entries()) {
    lines.push(`${index + 1}. source=${source.sourceKind || classifyPath(source.path)} handle_at_generation=${source.handle || "n/a"} artifact_id=${source.artifactId || artifactIdForPath(source.path)}`);
  }
  return lines.join("\n");
}

function toolConfig(event, api) {
  return event?.context?.pluginConfig ?? api.config ?? {};
}

const mediaArtifactRecentTool = {
  name: RECENT_TOOL,
  label: "Media Artifact Recent",
  description: "List recently recorded imagebot media artifacts and generation lineage metadata.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      count: { type: "number", description: `Number of entries, 1-${MAX_RECENT}.` },
      source: { type: "string", enum: ["generated", "input", "all"], description: "Artifact source filter. Default generated." }
    }
  },
  async execute(_toolCallId, params) {
    try {
      const entries = await listRecentArtifacts(mediaArtifactRecentTool.config || {}, params);
      return { content: [{ type: "text", text: formatRecent(entries) }], details: { status: "ok", results: entries } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `MEDIA_ARTIFACT_RECENT error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const mediaArtifactLineageTool = {
  name: LINEAGE_TOOL,
  label: "Media Artifact Lineage",
  description: "Inspect recorded source references for a generated image artifact.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      artifact_id: { type: "string", description: "Artifact id returned by media_artifact action=recent." },
      id: { type: "string", description: "Alias for artifact_id." },
      path: { type: "string", description: "Optional exact media path to inspect." }
    }
  },
  async execute(_toolCallId, params) {
    try {
      const entries = (await loadArtifactEntries(mediaArtifactLineageTool.config || {})).reverse();
      const query = readString(params, "artifact_id") || readString(params, "id") || readString(params, "path");
      const entry = findArtifact(entries, query);
      return { content: [{ type: "text", text: formatLineage(entry) }], details: { status: entry ? "ok" : "no_match", result: entry || null } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `MEDIA_ARTIFACT_LINEAGE error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const mediaArtifactTool = {
  name: MEDIA_ARTIFACT_TOOL,
  label: "Media Artifact",
  description: "Inspect imagebot media artifacts through action=recent or lineage.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["recent", "lineage"],
        description: "Artifact action. Default lineage when an id/path is supplied; otherwise recent."
      },
      count: { type: "number", description: `For recent, number of entries, 1-${MAX_RECENT}.` },
      source: { type: "string", enum: ["generated", "input", "all"], description: "For recent, artifact source filter. Default generated." },
      artifact_id: { type: "string", description: "Artifact id returned by media_artifact action=recent." },
      id: { type: "string", description: "Alias for artifact_id." },
      path: { type: "string", description: "Optional exact media path to inspect." }
    }
  },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const requested = readString(params, "action").toLowerCase();
    const hasLineageQuery = readString(params, "artifact_id") || readString(params, "id") || readString(params, "path");
    const action = requested || (hasLineageQuery ? "lineage" : "recent");
    if (action === "recent") return mediaArtifactRecentTool.execute(toolCallId, params, signal, onUpdate, ctx);
    if (action === "lineage") return mediaArtifactLineageTool.execute(toolCallId, params, signal, onUpdate, ctx);
    return {
      content: [{ type: "text", text: "MEDIA_ARTIFACT error: action must be recent or lineage." }],
      details: { status: "failed", error: "invalid action" }
    };
  }
};

export const __testing = {
  extractMediaPathsFromText,
  buildMediaContext,
  resolveImageInputs,
  resolveToolMediaInputs,
  findBadGeneratedRefs,
  findUnavailableHandleRefs,
  collectGeneratedMediaPaths,
  collectToolResultImagePaths,
  buildToolResultImagePreview,
  toolResultImageContextMiddleware,
  classifyPath,
  normalizePathKey,
  resolveMediaReferencePaths
};

export default {
  id: "imagebot-media-artifacts",
  name: "Imagebot Media Artifacts",
  description: "Tracks Telegram media handles and generation lineage.",
  register(api) {
    const baseConfig = api.config || {};
    mediaArtifactRecentTool.config = baseConfig;
    mediaArtifactLineageTool.config = baseConfig;
    mediaArtifactTool.config = baseConfig;

    api.registerTool(mediaArtifactTool, { name: MEDIA_ARTIFACT_TOOL });
    api.registerTool(mediaArtifactRecentTool, { name: RECENT_TOOL });
    api.registerTool(mediaArtifactLineageTool, { name: LINEAGE_TOOL });

    api.registerAgentToolResultMiddleware?.(async (event, ctx) => {
      return await toolResultImageContextMiddleware(event, ctx, baseConfig);
    }, { runtimes: ["openclaw", "codex"] });

    registerLifecycleHook(api, "before_prompt_build", async (event, ctx) => {
      const config = baseConfig;
      if (ctx?.agentId && ctx.agentId !== "imagebot") return;
      const context = await buildMediaContext(config, event, ctx);
      if (context.runId) contextsByRun.set(context.runId, context);
      if (context.sessionKey) contextsBySession.set(context.sessionKey, context);
      if (config.appendPromptContext === false) return;
      const appendContext = formatContextForPrompt(context);
      return appendContext ? { appendContext } : undefined;
    }, { name: "imagebot-media-artifacts-before-prompt-build" });

    registerLifecycleHook(api, "before_tool_call", async (event, ctx) => {
      if (ctx?.agentId && ctx.agentId !== "imagebot") return;

      const config = toolConfig(event, api);
      if (event.toolName !== "image_generate") {
        const spec = TOOL_MEDIA_INPUT_SPECS.get(event.toolName);
        if (!spec) return;
        const context = getContext(event, ctx);
        const { params, resolvedRefs, changed } = resolveToolMediaInputs(event.params, context, spec);
        const unavailableHandleRefs = findUnavailableHandleRefs(resolvedRefs);
        if (unavailableHandleRefs.length > 0) {
          const handles = unavailableHandleRefs.map((ref) => ref.value).join(", ");
          return {
            block: true,
            blockReason:
              `Unavailable media handle for ${event.toolName}: ${handles}. Use a handle listed in the current media context, call media_artifact action=recent for older media, or ask the user to resend it.`
          };
        }
        return changed ? { params } : undefined;
      }

      const strictGeneratedRefs = config.strictGeneratedRefs !== false;
      const context = getContext(event, ctx);
      const originalRefs = readImageInputs(event.params);
      const { params, resolvedRefs } = resolveImageInputs(event.params, context);
      const unavailableHandleRefs = findUnavailableHandleRefs(resolvedRefs);
      if (unavailableHandleRefs.length > 0) {
        const handles = unavailableHandleRefs.map((ref) => ref.value).join(", ");
        return {
          block: true,
          blockReason:
            `当前回合不可用的媒体句柄：${handles}。只能使用 [Imagebot 媒体句柄] 里列出的句柄。要处理近期附件，调用 media_artifact action=recent，并把返回的 details.results[n].path 传给 image_generate；或者让用户重发图片。`
        };
      }
      const badGeneratedRefs = findBadGeneratedRefs(resolvedRefs, strictGeneratedRefs);
      if (badGeneratedRefs.length > 0) {
        return {
          block: true,
          blockReason:
            "Generated image files cannot be used as raw image_generate references. Use a current-turn media handle such as reply.generated.0, or use reply.generated.0.source.0 to redo from the original source."
        };
      }

      const key = pendingKey(event, ctx);
      const pending = {
        toolCallId: key,
        runId: event.runId || ctx?.runId || "",
        sessionKey: ctx?.sessionKey || "",
        prompt: readString(params, "prompt"),
        model: readString(params, "model"),
        originalRefs,
        resolvedRefs,
        startedAt: Date.now()
      };
      pendingByToolCall.set(key, pending);
      queuePending(pending.sessionKey, pending);
      await appendJsonLine(artifactLogPath(config), {
        type: "image_generate_request",
        t: nowIso(),
        sessionKey: pending.sessionKey,
        runId: pending.runId,
        toolCallId: key,
        promptHash: pending.prompt ? hashText(pending.prompt, 20) : "",
        promptPreview: clip(pending.prompt, 300),
        refs: resolvedRefs.map((ref) => ({
          path: ref.value,
          sourceKind: ref.sourceKind || classifyPath(ref.value),
          handle: ref.handle || "",
          viaHandle: ref.viaHandle === true,
          artifactId: artifactIdForPath(ref.value)
        }))
      });
      return { params };
    }, { name: "imagebot-media-artifacts-before-tool-call" });

    registerLifecycleHook(api, "after_tool_call", async (event, ctx) => {
      if (event.toolName !== "image_generate") return;
      if (ctx?.agentId && ctx.agentId !== "imagebot") return;
      const config = toolConfig(event, api);
      const key = event.toolCallId || ctx?.toolCallId || "";
      const pending = pendingByToolCall.get(key) || popPendingForSession(ctx?.sessionKey);
      if (!pending) return;
      const taskId = parseTaskId(event.result);
      if (taskId) pending.taskId = taskId;
      if (event.error) {
        await appendJsonLine(artifactLogPath(config), {
          type: "image_generate_error",
          t: nowIso(),
          sessionKey: ctx?.sessionKey || pending.sessionKey,
          runId: ctx?.runId || pending.runId,
          toolCallId: key,
          taskId,
          error: String(event.error).slice(0, 500)
        });
        return;
      }
      const generatedPaths = collectGeneratedMediaPaths(event.result);
      if (generatedPaths.length > 0) await recordGeneratedPaths(config, generatedPaths, pending, ctx, "after_tool_call");
    }, { name: "imagebot-media-artifacts-after-tool-call" });

    registerLifecycleHook(api, "before_message_write", (event, ctx) => {
      if (ctx?.agentId && ctx.agentId !== "imagebot") return;
      const config = baseConfig;
      const generatedPaths = collectGeneratedMediaPaths(event.message);
      if (generatedPaths.length === 0) return;
      const pending = popPendingForSession(event.sessionKey || ctx?.sessionKey);
      recordGeneratedPaths(config, generatedPaths, pending, {
        sessionKey: event.sessionKey || ctx?.sessionKey,
        runId: ctx?.runId
      }, "before_message_write").catch(() => {});
    }, { name: "imagebot-media-artifacts-before-message-write" });
  }
};

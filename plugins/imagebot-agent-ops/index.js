import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { registerLifecycleHook } from "../imagebot-shared/openclaw-lifecycle-hooks.mjs";

const AGENT_MODE_TOOL = "agent_mode";
const PERSONA_CONFIG_TOOL = "persona_config";
const LEARNED_SKILL_TOOL = "learned_skill";
const FAILURE_MEMORY_TOOL = "failure_memory";
const EVIDENCE_PACK_TOOL = "evidence_pack";
const GITHUB_LOOKUP_TOOL = "github_lookup";
const DATA_TOOL = "data_tool";
const BOT_BOARD_TOOL = "bot_board";

const MAX_LOG_READ_BYTES = 4 * 1024 * 1024;
const MAX_TEXT = 5000;
const MAX_PERSONA_CARD = 9000;
const MAX_PERSONA_LANGUAGE_RULES = 3000;
const MAX_PERSONA_LOREBOOK = 6000;
const MAX_PERSONA_EXAMPLES = 3000;
const MAX_COUNT = 20;
const DEFAULT_COUNT = 6;
const DEFAULT_FAILURE_SLOW_MS = 25_000;
const GITHUB_TIMEOUT_MS = 15_000;
const USER_AGENT = "AmaduseImagebot/agent-ops (+https://github.com)";
const MAX_SKILL_FILE_MEDIA = 6;
const MAX_SKILL_MEDIA_BYTES = 50 * 1024 * 1024;
const ALLOWED_SKILL_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

const MODE_DEFS = {
  casual: "短而自然的群聊。只有用户确实需要时才用工具。",
  media: "优先处理已发送/回复媒体、视觉检查、变换、相册重发和简洁媒体交付。",
  web: "优先使用公共网页证据、来源、网页截图和 artifact 笔记。",
  research: "先定义术语，需要时搜索/引用公共来源，区分事实和假设，保留证据链。",
  debug: "用最近工具事件、工具暴露的日志和最小可复现检查来诊断失败。",
  creative: "优先处理提示词、图像方向、参考图、变体和简洁创意迭代。"
};

const pendingToolCalls = new Map();
const jsonFileCache = new Map();
const personaFileCache = new Map();
const personaFileCacheCounters = { hits: 0, misses: 0 };

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storeRoot(config) {
  const configured = String(config?.storeDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "agent-ops"));
}

function repoRoot(config) {
  const configured = String(config?.repoRoot || "").trim();
  return path.resolve(configured || process.cwd());
}

function modePath(config) {
  return path.join(storeRoot(config), "modes.json");
}

function personaStatePath(config) {
  return path.join(storeRoot(config), "personas.json");
}

function windowStorePath(config) {
  const configured = String(config?.windowStorePath || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "agents", "imagebot", "sessions", "sessions.json.telegram-imagebot-windows.json"));
}

function personaCatalogPath(config) {
  const configured = String(config?.personaCatalogPath || "").trim();
  return configured ? path.resolve(configured) : path.join(repoRoot(config), "persona", "persona_overlays.json");
}

function skillLogPath(config) {
  return path.join(storeRoot(config), "skills.jsonl");
}

function skillFilesRoot(config) {
  return path.join(storeRoot(config), "skill-files");
}

function failureLogPath(config) {
  return path.join(storeRoot(config), "tool-events.jsonl");
}

function evidenceLogPath(config) {
  return path.join(storeRoot(config), "evidence-packs.jsonl");
}

function botBoardLogPath(config) {
  return path.join(storeRoot(config), "bot-board.jsonl");
}

function personaHookDebugPath(config) {
  return path.join(storeRoot(config), "persona-hook-debug.jsonl");
}

function nowIso() {
  return new Date().toISOString();
}

function hash(value, len = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

async function sha256File(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function clip(value, max = 600) {
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

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  return typeof value === "string" ? value.trim() : fallback;
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

function readArrayStrings(params, key) {
  const raw = isRecord(params) ? params[key] : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item || "").trim()).filter(Boolean);
}

function readStringList(params, key) {
  const raw = isRecord(params) ? params[key] : undefined;
  if (Array.isArray(raw)) return raw.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}

function safeIdPart(value, fallback = "skill") {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function yamlString(value) {
  return JSON.stringify(String(value || ""));
}

function isInside(root, target) {
  const rootNorm = path.resolve(root).toLowerCase();
  const targetNorm = path.resolve(target).toLowerCase();
  return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + path.sep);
}

function allowedSkillMediaRoots(config = {}) {
  const home = homeDir();
  const defaults = [
    path.join(home, ".openclaw", "media", "inbound"),
    path.join(home, ".openclaw", "media", "tool-image-generation"),
    path.join(home, ".openclaw", "media", "downloaded"),
    path.join(home, ".openclaw", "media", "gallery-resend"),
    path.join(home, ".openclaw", "media", "gacha-archive"),
    path.join(home, ".openclaw", "media", "practical-tools"),
    path.join(home, ".openclaw", "media", "archive"),
    skillFilesRoot(config)
  ];
  const extra = Array.isArray(config.allowedMediaRoots) ? config.allowedMediaRoots : [];
  return [...defaults, ...extra].map((entry) => path.resolve(String(entry))).filter(Boolean);
}

function readMediaPath(raw) {
  const value = String(raw || "").trim().replace(/^`+|`+$/g, "");
  const mediaMatch = value.match(/(?:SPOILER_)?MEDIA:\s*`?([^`\r\n]+)`?/i);
  const unwrapped = mediaMatch ? mediaMatch[1] : value;
  if (/^file:\/\//i.test(unwrapped)) return decodeURIComponent(unwrapped.replace(/^file:\/\//i, ""));
  return unwrapped;
}

async function resolveAllowedSkillMedia(config, raw) {
  const input = readMediaPath(raw);
  if (!input) throw new Error("media path is required");
  if (/^https?:\/\//i.test(input)) throw new Error("learned_skill media must be bot-local media, not external URLs");
  const resolved = path.resolve(input);
  if (!allowedSkillMediaRoots(config).some((root) => isInside(root, resolved))) {
    throw new Error("media path is outside allowed bot media directories");
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("media path is not a file");
  if (stat.size > MAX_SKILL_MEDIA_BYTES) throw new Error("media file is larger than 50 MB");
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_SKILL_IMAGE_EXTS.has(ext)) throw new Error(`unsupported skill media type: ${ext || "unknown"}`);
  return { path: resolved, stat, ext };
}

async function appendJsonLine(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function readTail(filePath, maxBytes = MAX_LOG_READ_BYTES) {
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

async function readJsonLines(filePath) {
  const raw = await readTail(filePath);
  if (!raw) return [];
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (isRecord(record)) records.push(record);
    } catch {
      // Append-only stores may have truncated/corrupt tail fragments. Ignore them.
    }
  }
  return records;
}

async function readJson(filePath, fallback) {
  const resolved = path.resolve(filePath);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return fallback;
    const signature = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    const cached = jsonFileCache.get(resolved);
    if (cached?.signature === signature) return cached.value;
    const value = JSON.parse(await fs.readFile(resolved, "utf8"));
    jsonFileCache.set(resolved, { signature, value });
    return value;
  } catch {
    return fallback;
  }
}

async function readTextCached(filePath, maxBytes, transform = (raw) => raw) {
  const resolved = path.resolve(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) return "";
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = personaFileCache.get(resolved);
  if (cached?.signature === signature) {
    personaFileCacheCounters.hits += 1;
    if (Object.hasOwn(cached, "value")) return cached.value;
    if (cached.promise) return await cached.promise;
  }
  personaFileCacheCounters.misses += 1;
  const promise = fs.readFile(resolved, "utf8").then((raw) => clip(transform(raw, resolved), maxBytes));
  personaFileCache.set(resolved, { signature, promise });
  try {
    const value = await promise;
    personaFileCache.set(resolved, { signature, value });
    return value;
  } catch (error) {
    if (personaFileCache.get(resolved)?.promise === promise) personaFileCache.delete(resolved);
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const tempPath = `${resolved}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tempPath, resolved);
  jsonFileCache.delete(resolved);
}

function ok(toolName, lines, details = {}) {
  return {
    content: [{ type: "text", text: [toolName.toUpperCase(), ...lines].filter(Boolean).join("\n") }],
    details: { status: "ok", ...details }
  };
}

function fail(toolName, error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `${toolName.toUpperCase()} error: ${clip(message, 500)}` }],
    details: { status: "failed", error: message }
  };
}

function normalizeMode(value) {
  const mode = String(value || "casual").trim().toLowerCase();
  return Object.hasOwn(MODE_DEFS, mode) ? mode : "casual";
}

function normalizeScope(value) {
  const scope = String(value || "session").trim().toLowerCase();
  if (scope === "session" || scope === "group" || scope === "global") return scope;
  return "session";
}

function contextSessionKey(params, ctx) {
  return readString(params, "sessionKey") ||
    readString(params, "session_key") ||
    String(ctx?.sessionKey || ctx?.session?.key || ctx?.threadKey || "").trim();
}

function eventPromptText(event = {}) {
  const candidates = [
    event?.prompt,
    event?.message,
    event?.text,
    event?.input,
    event?.currentMessage,
    event?.userText
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function contextWindowId(params = {}, event = {}, ctx = {}) {
  const explicit = readString(params, "windowId") ||
    readString(params, "window_id") ||
    String(event?.windowId || event?.window_id || ctx?.windowId || ctx?.window_id || "").trim();
  if (explicit) return explicit;
  const text = eventPromptText(event);
  const match = text.match(/(?:^|\n)window_id=([A-Za-z0-9_-]+)/);
  return match ? match[1] : "";
}

function contextGroupKey(params, event, ctx) {
  return readString(params, "groupKey") ||
    readString(params, "group_key") ||
    String(event?.chatId || event?.groupId || ctx?.chatId || ctx?.groupId || ctx?.channelId || "telegram-group").trim();
}

async function resolveSessionKeyForContext(config, params = {}, event = {}, ctx = {}) {
  const direct = contextSessionKey(params, ctx) || String(event?.sessionKey || event?.session?.key || "").trim();
  if (direct) return direct;
  const windowId = contextWindowId(params, event, ctx);
  if (!windowId) return "";
  const store = await loadWindowStore(config);
  const fromWindow = String(store.windows?.[windowId]?.sessionKey || "").trim();
  if (fromWindow) return fromWindow;
  for (const entry of Object.values(store.activeByUser || {})) {
    if (String(entry?.windowId || "") === windowId && entry?.sessionKey) return String(entry.sessionKey);
  }
  return "";
}

async function latestOpenPersonaRecord(config, state) {
  const store = await loadWindowStore(config);
  const openWindowIds = new Set(Object.values(store.activeByUser || {}).map((entry) => String(entry?.windowId || "")).filter(Boolean));
  const records = Object.values(state.active || {})
    .filter((record) => record?.personaId && record.personaId !== "default")
    .filter((record) => !record.windowId || openWindowIds.has(String(record.windowId)))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return records[0] || null;
}

function modeStorageKey(scope, params, event, ctx) {
  if (scope === "global") return "global";
  if (scope === "group") return `group:${contextGroupKey(params, event, ctx) || "telegram-group"}`;
  const sessionKey = contextSessionKey(params, ctx);
  if (!sessionKey) throw new Error("session scope requires sessionKey from runtime or params");
  return `session:${sessionKey}`;
}

function resolveRepoPath(config, relativePath) {
  const root = repoRoot(config);
  const target = path.resolve(root, String(relativePath || ""));
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("persona card path must stay under repoRoot");
  }
  return target;
}

async function loadModes(config) {
  const loaded = await readJson(modePath(config), null);
  if (isRecord(loaded) && isRecord(loaded.active)) return loaded;
  return { version: 1, active: {} };
}

async function saveModes(config, modes) {
  modes.version = 1;
  modes.updatedAt = nowIso();
  await writeJsonAtomic(modePath(config), modes);
}

async function setMode(config, params, ctx) {
  const scope = normalizeScope(readString(params, "scope", "session"));
  const mode = normalizeMode(readString(params, "mode", "casual"));
  const modes = await loadModes(config);
  const key = modeStorageKey(scope, params, null, ctx);
  const record = {
    scope,
    key,
    mode,
    note: clip(readString(params, "note"), 240),
    updatedAt: nowIso()
  };
  modes.active[key] = record;
  await saveModes(config, modes);
  return record;
}

async function getActiveModesForContext(config, event, ctx) {
  const modes = await loadModes(config);
  const sessionKey = await resolveSessionKeyForContext(config, {}, event, ctx);
  const groupKey = contextGroupKey({}, event, ctx);
  const candidates = [
    sessionKey ? `session:${sessionKey}` : "",
    groupKey ? `group:${groupKey}` : "",
    "global"
  ].filter(Boolean);
  const active = [];
  for (const key of candidates) {
    const record = modes.active[key];
    if (record) active.push(record);
  }
  return active;
}

function formatModeRecord(record, index = 0) {
  const prefix = index ? `${index}. ` : "";
  return `${prefix}${record.key} -> ${record.mode}${record.note ? ` (${clip(record.note, 100)})` : ""}`;
}

function formatModePrompt(active) {
  if (!active.length) return "";
  const selected = active[0];
  return [
    "[Imagebot 活跃模式]",
    `mode: ${selected.mode}`,
    `指引: ${MODE_DEFS[selected.mode]}`,
    selected.note ? `note: ${clip(selected.note, 180)}` : "",
    "[/Imagebot 活跃模式]"
  ].filter(Boolean).join("\n");
}

const agentModeTool = {
  name: AGENT_MODE_TOOL,
  label: "Agent Mode",
  description: "Set, get, list, or clear lightweight task modes for the current imagebot session/group/global context.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["get", "set", "list", "clear"], description: "Mode operation." },
      mode: { type: "string", enum: Object.keys(MODE_DEFS), description: "Mode to set." },
      scope: { type: "string", enum: ["session", "group", "global"], description: "Default session." },
      note: { type: "string", description: "Short optional note for this mode." },
      sessionKey: { type: "string", description: "Optional explicit session key if runtime context is unavailable." },
      groupKey: { type: "string", description: "Optional explicit group key if runtime context is unavailable." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const config = agentModeTool.config || {};
      const action = readString(params, "action", "get").toLowerCase();
      if (action === "set") {
        const record = await setMode(config, params, ctx);
        return ok(AGENT_MODE_TOOL, [
          `set ${formatModeRecord(record)}`,
          `available modes: ${Object.keys(MODE_DEFS).join(", ")}`
        ], { action, record });
      }
      const modes = await loadModes(config);
      if (action === "clear") {
        const scope = normalizeScope(readString(params, "scope", "session"));
        const key = modeStorageKey(scope, params, null, ctx);
        const existed = Boolean(modes.active[key]);
        delete modes.active[key];
        await saveModes(config, modes);
        return ok(AGENT_MODE_TOOL, [`cleared ${key} existed=${existed}`], { action, key, existed });
      }
      if (action === "list") {
        const records = Object.values(modes.active || {}).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
        const lines = [
          "definitions:",
          ...Object.entries(MODE_DEFS).map(([mode, text]) => `- ${mode}: ${text}`),
          "active:",
          ...(records.length ? records.slice(0, MAX_COUNT).map(formatModeRecord) : ["none"])
        ];
        return ok(AGENT_MODE_TOOL, lines, { action, modes: MODE_DEFS, active: records });
      }
      const scope = normalizeScope(readString(params, "scope", "session"));
      const key = modeStorageKey(scope, params, null, ctx);
      const record = modes.active[key] || null;
      return ok(AGENT_MODE_TOOL, [record ? formatModeRecord(record) : `no active mode for ${key}`], { action, key, record });
    } catch (error) {
      return fail(AGENT_MODE_TOOL, error);
    }
  }
};

function normalizeLookup(value) {
  return String(value || "").trim().toLowerCase();
}

function fallbackPersonaCatalog() {
  return {
    version: 1,
    personas: [{
      id: "default",
      label: "Amaduse",
      aliases: ["default", "base", "amaduse", "amadesu", "amadeus"],
      description: "Amaduse 默认说话角色。",
      cardPath: "persona/active_system.md"
    }]
  };
}

function normalizePersonaRecord(record) {
  if (!isRecord(record)) return null;
  const id = String(record.id || "").trim();
  if (!id) return null;
  const label = String(record.label || record.name || id).trim();
  const aliases = Array.isArray(record.aliases) ? record.aliases.map((item) => String(item || "").trim()).filter(Boolean) : [];
  return {
    id,
    label,
    aliases,
    description: String(record.description || "").trim(),
    cardPath: String(record.cardPath || record.personaPath || "").trim(),
    languageRulesPath: String(record.languageRulesPath || record.voicePath || "").trim(),
    lorebookPath: String(record.lorebookPath || "").trim(),
    examplePath: String(record.examplePath || record.examplesPath || "").trim(),
    sourceUrls: Array.isArray(record.sourceUrls) ? record.sourceUrls.map((item) => String(item || "").trim()).filter(Boolean) : []
  };
}

async function loadPersonaCatalog(config) {
  const loaded = await readJson(personaCatalogPath(config), null);
  const source = isRecord(loaded) && Array.isArray(loaded.personas) ? loaded : fallbackPersonaCatalog();
  const personas = source.personas.map(normalizePersonaRecord).filter(Boolean);
  if (!personas.some((persona) => persona.id === "default")) {
    personas.unshift(fallbackPersonaCatalog().personas[0]);
  }
  return { version: 1, personas };
}

function publicPersona(persona) {
  return {
    id: persona.id,
    label: persona.label,
    aliases: persona.aliases,
    description: persona.description,
    hasCard: Boolean(persona.cardPath),
    hasLanguageRules: Boolean(persona.languageRulesPath),
    hasLorebook: Boolean(persona.lorebookPath),
    hasExamples: Boolean(persona.examplePath),
    sourceUrls: persona.sourceUrls || []
  };
}

function findPersona(catalog, query) {
  const needle = normalizeLookup(query);
  if (!needle) return null;
  for (const persona of catalog.personas || []) {
    const keys = [persona.id, persona.label, ...(persona.aliases || [])].map(normalizeLookup);
    if (keys.includes(needle)) return persona;
  }
  return null;
}

async function loadPersonaState(config) {
  const loaded = await readJson(personaStatePath(config), null);
  if (isRecord(loaded)) {
    return {
      ...loaded,
      version: 1,
      active: isRecord(loaded.active) ? loaded.active : {},
      userDefaults: isRecord(loaded.userDefaults) ? loaded.userDefaults : {}
    };
  }
  return { version: 1, active: {}, userDefaults: {} };
}

async function savePersonaState(config, state) {
  state.version = 1;
  state.updatedAt = nowIso();
  state.active = isRecord(state.active) ? state.active : {};
  state.userDefaults = isRecord(state.userDefaults) ? state.userDefaults : {};
  await writeJsonAtomic(personaStatePath(config), state);
}

function normalizePersonaWindowMode(value) {
  const mode = String(value || "current_session").trim().toLowerCase();
  if (mode === "current_session" || mode === "same_session" || mode === "session") return "current_session";
  return "new_window";
}

function telegramUserKey(value) {
  const id = String(value || "").trim();
  return id ? `tg:${id}` : "";
}

function contextSenderId(params, ctx, event = {}) {
  return readString(params, "senderId") ||
    readString(params, "userId") ||
    readString(params, "fromUserId") ||
    String(ctx?.senderId || ctx?.userId || ctx?.fromUserId || event?.senderId || event?.userId || event?.fromUserId || "").trim();
}

function contextSenderName(params, ctx) {
  return readString(params, "senderName") ||
    readString(params, "userName") ||
    readString(params, "displayName") ||
    String(ctx?.senderName || ctx?.userName || ctx?.displayName || ctx?.username || "").trim();
}

function formatPersonaWindowId(now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/\D/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function createWindowStore() {
  return { version: 3, activeByUser: {}, byBotMessage: {}, users: {}, windows: {} };
}

function normalizeWindowStore(raw) {
  const store = isRecord(raw) ? raw : {};
  return {
    ...store,
    version: 3,
    activeByUser: isRecord(store.activeByUser) ? store.activeByUser : {},
    byBotMessage: isRecord(store.byBotMessage) ? store.byBotMessage : {},
    users: isRecord(store.users) ? store.users : {},
    windows: isRecord(store.windows) ? store.windows : {}
  };
}

async function loadWindowStore(config) {
  const loaded = await readJson(windowStorePath(config), null);
  return normalizeWindowStore(loaded || createWindowStore());
}

async function saveWindowStore(config, store) {
  await writeJsonAtomic(windowStorePath(config), normalizeWindowStore(store));
}

function fallbackPersona(catalog) {
  return findPersona(catalog, "default") || fallbackPersonaCatalog().personas[0];
}

function personaStateRecord(scope, key, persona, details = {}) {
  return {
    scope,
    key,
    sessionKey: details.sessionKey || "",
    windowId: details.windowId || "",
    personaId: persona.id,
    label: persona.label,
    note: clip(details.note, 240),
    source: details.source || "",
    updatedAt: nowIso()
  };
}

function personaFromStateRecord(catalog, record) {
  const persona = record ? findPersona(catalog, record.personaId) : null;
  return persona ? { key: record.key || "", record, persona } : null;
}

function personaForDefaultRecord(catalog, details = {}) {
  const persona = fallbackPersona(catalog);
  const key = details.key || (details.windowId ? `window:${details.windowId}` : "default");
  const record = personaStateRecord(details.scope || "default", key, persona, {
    sessionKey: details.sessionKey || "",
    windowId: details.windowId || "",
    note: details.note || "implicit default",
    source: details.source || "default"
  });
  return { key, record, persona };
}

async function resolveWindowEntryForContext(config, params = {}, event = {}, ctx = {}) {
  const windowId = contextWindowId(params, event, ctx);
  const sessionKey = contextSessionKey(params, ctx) || String(event?.sessionKey || event?.session?.key || "").trim();
  const groupKey = contextGroupKey(params, event, ctx);
  const senderId = contextSenderId(params, ctx, event);
  if (!windowId && !sessionKey && (!groupKey || !senderId)) return null;
  const store = await loadWindowStore(config);
  if (windowId && isRecord(store.windows?.[windowId])) return store.windows[windowId];
  if (windowId) {
    for (const entry of Object.values(store.activeByUser || {})) {
      if (String(entry?.windowId || "").trim() === windowId) return entry;
    }
  }
  if (sessionKey) {
    for (const entry of Object.values(store.windows || {})) {
      if (String(entry?.sessionKey || "").trim() === sessionKey) return entry;
    }
    for (const entry of Object.values(store.activeByUser || {})) {
      if (String(entry?.sessionKey || "").trim() === sessionKey) return entry;
    }
  }
  const userKey = telegramUserKey(senderId);
  const active = userKey ? store.activeByUser?.[userKey] : null;
  const activeWindowId = String(active?.windowId || "").trim();
  const activeEntry = activeWindowId && isRecord(store.windows?.[activeWindowId]) ? store.windows[activeWindowId] : active;
  if (isRecord(activeEntry) && !activeEntry.closedAt && String(activeEntry.chatId || groupKey) === String(groupKey)) {
    return activeEntry;
  }
  return null;
}

async function updateWindowPersona(config, windowEntry, persona, source = "persona_config") {
  if (!windowEntry?.windowId) return null;
  const store = await loadWindowStore(config);
  const windowId = String(windowEntry.windowId || "").trim();
  const entry = isRecord(store.windows?.[windowId]) ? store.windows[windowId] : { ...windowEntry };
  const iso = nowIso();
  entry.personaId = persona.id;
  entry.personaLabel = persona.label;
  entry.personaUpdatedAt = iso;
  entry.personaSource = source;
  entry.lastActivityAt = iso;
  const recent = Array.isArray(entry.recent) ? entry.recent : [];
  entry.recent = recent.concat([{
    at: iso,
    role: "system",
    sender: source,
    text: `已切换角色卡：${persona.label}。`
  }]).slice(-20);
  store.windows[windowId] = entry;
  for (const [userKey, active] of Object.entries(store.activeByUser || {})) {
    if (String(active?.windowId || "").trim() === windowId) {
      store.activeByUser[userKey] = entry;
    }
  }
  await saveWindowStore(config, store);
  return entry;
}

async function clearWindowPersona(config, windowEntry) {
  if (!windowEntry?.windowId) return null;
  const store = await loadWindowStore(config);
  const windowId = String(windowEntry.windowId || "").trim();
  const entry = isRecord(store.windows?.[windowId]) ? store.windows[windowId] : null;
  if (!entry) return null;
  delete entry.personaId;
  delete entry.personaLabel;
  delete entry.personaUpdatedAt;
  delete entry.personaSource;
  entry.lastActivityAt = nowIso();
  store.windows[windowId] = entry;
  for (const [userKey, active] of Object.entries(store.activeByUser || {})) {
    if (String(active?.windowId || "").trim() === windowId) {
      store.activeByUser[userKey] = entry;
    }
  }
  await saveWindowStore(config, store);
  return entry;
}

function canOpenPersonaWindow(params, ctx) {
  return Boolean(contextSessionKey(params, ctx) && contextGroupKey(params, null, ctx) && contextSenderId(params, ctx));
}

async function openPersonaWindow(config, params, ctx, persona) {
  const baseSessionKey = contextSessionKey(params, ctx);
  const chatId = contextGroupKey(params, null, ctx);
  const senderId = contextSenderId(params, ctx);
  if (!baseSessionKey || !chatId || !senderId) throw new Error("new persona window requires sessionKey, chatId, and senderId");
  const userKey = telegramUserKey(senderId);
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const windowId = formatPersonaWindowId(now);
  const sessionKey = `${baseSessionKey.replace(/:window:[^:]+$/i, "")}:window:${windowId}`;
  const store = await loadWindowStore(config);
  const previousActive = isRecord(store.activeByUser?.[userKey]) ? store.activeByUser[userKey] : null;
  const previousWindowId = String(previousActive?.windowId || "").trim();
  if (previousWindowId) {
    const previousWindow = isRecord(store.windows?.[previousWindowId]) ? store.windows[previousWindowId] : previousActive;
    if (previousWindow && !previousWindow.closedAt) {
      previousWindow.closedAt = iso;
      previousWindow.closedReason = "replaced-by-persona-switch";
      previousWindow.replacedByWindowId = windowId;
      store.windows[previousWindowId] = previousWindow;
    }
    for (const [messageKey, ref] of Object.entries(store.byBotMessage || {})) {
      if (String(ref?.windowId || "").trim() === previousWindowId) delete store.byBotMessage[messageKey];
    }
  }
  const senderName = clip(contextSenderName(params, ctx) || senderId || userKey, 80);
  const previousUser = isRecord(store.users?.[userKey]) ? store.users[userKey] : {};
  const names = [...new Set([...(Array.isArray(previousUser.names) ? previousUser.names : []), senderName].filter(Boolean))];
  store.users[userKey] = {
    ...previousUser,
    id: senderId,
    currentName: senderName,
    names,
    lastSeenAt: iso
  };
  const entry = {
    windowId,
    ownerUserKey: userKey,
    ownerSenderId: senderId,
    ownerName: senderName,
    accountId: String(ctx?.accountId || params?.accountId || "imagebot"),
    chatId: String(chatId),
    sessionKey,
    openedAt: iso,
    lastActivityAt: iso,
    personaId: persona.id,
    personaLabel: persona.label,
    participants: {
      [userKey]: {
        id: senderId,
        name: senderName,
        lastSeenAt: iso
      }
    },
    recent: [{
      at: iso,
      role: "system",
      sender: "persona_config",
      text: `已打开角色窗口：${persona.label}。`
    }]
  };
  store.activeByUser[userKey] = entry;
  store.windows[windowId] = entry;
  await saveWindowStore(config, store);
  return entry;
}

async function setPersona(config, params, ctx) {
  const scope = normalizeScope(readString(params, "scope", "session"));
  const queries = [readString(params, "persona"), readString(params, "id"), readString(params, "name")].filter(Boolean);
  if (!queries.length) throw new Error("persona/id/name is required for set");
  const catalog = await loadPersonaCatalog(config);
  const persona = queries.map((query) => findPersona(catalog, query)).find(Boolean);
  if (!persona) throw new Error(`未知角色卡：${queries[0]}`);
  const state = await loadPersonaState(config);
  let windowEntry = null;
  const requestedWindowMode = readString(params, "windowMode");
  const windowMode = requestedWindowMode ? normalizePersonaWindowMode(requestedWindowMode) : canOpenPersonaWindow(params, ctx) ? "new_window" : "current_session";
  if (scope === "session" && windowMode === "new_window" && canOpenPersonaWindow(params, ctx)) {
    windowEntry = await openPersonaWindow(config, params, ctx, persona);
  } else if (scope === "session") {
    windowEntry = await resolveWindowEntryForContext(config, params, null, ctx);
  }
  const sessionKey = windowEntry?.sessionKey || await resolveSessionKeyForContext(config, params, null, ctx);
  let key;
  if (scope === "global") key = "global";
  else if (scope === "group") key = `group:${contextGroupKey(params, null, ctx) || "telegram-group"}`;
  else {
    if (!sessionKey) throw new Error("session scope requires sessionKey from runtime, params, or windowId");
    key = `session:${sessionKey}`;
  }
  if (scope === "session" && windowEntry) {
    windowEntry = await updateWindowPersona(config, windowEntry, persona);
  }
  const record = personaStateRecord(scope, key, persona, {
    sessionKey: scope === "session" ? sessionKey : "",
    windowId: windowEntry?.windowId || "",
    note: readString(params, "note"),
    source: "persona_config"
  });
  state.active[key] = record;
  const senderId = contextSenderId(params, ctx);
  const userKey = telegramUserKey(senderId);
  const rememberDefault = readBoolean(params, "rememberDefault", scope === "session" && Boolean(userKey));
  let userDefault = null;
  if (rememberDefault && userKey) {
    userDefault = personaStateRecord("user", `user:${userKey}`, persona, {
      note: "default for new windows",
      source: "persona_config"
    });
    state.userDefaults[userKey] = userDefault;
  }
  await savePersonaState(config, state);
  return {
    persona,
    key,
    record,
    existed: true,
    cleared: false,
    window: windowEntry,
    windowMode: windowMode === "new_window" && windowEntry ? "new_window" : "current_session",
    userDefault
  };
}

async function clearPersona(config, params, ctx) {
  const scope = normalizeScope(readString(params, "scope", "session"));
  const windowEntry = scope === "session" ? await resolveWindowEntryForContext(config, params, null, ctx) : null;
  const sessionKey = windowEntry?.sessionKey || await resolveSessionKeyForContext(config, params, null, ctx);
  let key;
  if (scope === "global") key = "global";
  else if (scope === "group") key = `group:${contextGroupKey(params, null, ctx) || "telegram-group"}`;
  else {
    if (!sessionKey) throw new Error("session scope requires sessionKey from runtime, params, or windowId");
    key = `session:${sessionKey}`;
  }
  const state = await loadPersonaState(config);
  const existed = Boolean(state.active[key]);
  delete state.active[key];
  if (windowEntry) await clearWindowPersona(config, windowEntry);
  await savePersonaState(config, state);
  return { key, existed };
}

async function getActivePersonaForContext(config, event, ctx, options = {}) {
  const state = await loadPersonaState(config);
  const catalog = await loadPersonaCatalog(config);
  const windowEntry = await resolveWindowEntryForContext(config, {}, event, ctx);
  const sessionKey = await resolveSessionKeyForContext(config, {}, event, ctx);
  const groupKey = contextGroupKey({}, event, ctx);
  if (windowEntry?.personaId) {
    const persona = findPersona(catalog, windowEntry.personaId);
    if (persona) {
      const key = `window:${windowEntry.windowId}`;
      const record = personaStateRecord("window", key, persona, {
        sessionKey: String(windowEntry.sessionKey || ""),
        windowId: String(windowEntry.windowId || ""),
        note: "window persona lock",
        source: "window"
      });
      return { key, record, persona };
    }
  }
  const candidates = [
    sessionKey ? `session:${sessionKey}` : ""
  ].filter(Boolean);
  for (const key of candidates) {
    const active = personaFromStateRecord(catalog, state.active[key]);
    if (active) return active;
  }
  if (windowEntry) {
    return personaForDefaultRecord(catalog, {
      scope: "window",
      key: `window:${windowEntry.windowId}`,
      sessionKey: String(windowEntry.sessionKey || sessionKey || ""),
      windowId: String(windowEntry.windowId || ""),
      note: "window fallback default",
      source: "window-default"
    });
  }
  const senderId = contextSenderId({}, ctx, event);
  const userKey = telegramUserKey(senderId);
  const userDefault = userKey ? personaFromStateRecord(catalog, state.userDefaults[userKey]) : null;
  if (userDefault) return userDefault;
  for (const key of [groupKey ? `group:${groupKey}` : "", "global"].filter(Boolean)) {
    const active = personaFromStateRecord(catalog, state.active[key]);
    if (active) return active;
  }
  if (options.allowLatestFallback && !sessionKey && !contextWindowId({}, event, ctx)) {
    const record = await latestOpenPersonaRecord(config, state);
    const persona = record ? findPersona(catalog, record.personaId) : null;
    if (record && persona) return { key: record.key, record, persona };
  }
  return personaForDefaultRecord(catalog);
}

async function readPersonaCard(config, persona) {
  if (!persona?.cardPath) return "";
  const target = resolveRepoPath(config, persona.cardPath);
  return await readTextCached(target, MAX_PERSONA_CARD);
}

function formatPersonaLorebookJson(value) {
  const entries = Array.isArray(value?.entries) ? value.entries : [];
  const lines = [];
  for (const entry of entries) {
    if (entry?.enabled === false) continue;
    const name = String(entry?.name || entry?.id || "").trim();
    const keys = Array.isArray(entry?.keys) ? entry.keys.map((item) => String(item || "").trim()).filter(Boolean) : [];
    const content = String(entry?.content || "").trim();
    if (!content) continue;
    if (name) lines.push(`### ${name}`);
    if (keys.length) lines.push(`关键词：${keys.join(", ")}`);
    lines.push(content);
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function readPersonaSupplement(config, filePath, maxBytes) {
  if (!filePath) return "";
  const target = resolveRepoPath(config, filePath);
  return await readTextCached(target, maxBytes, (raw, resolved) => {
    if (!/\.json$/i.test(resolved)) return raw;
    try {
      const parsed = JSON.parse(raw);
      const formatted = formatPersonaLorebookJson(parsed);
      return formatted || raw;
    } catch {
      return raw;
    }
  });
}

async function readPersonaProfile(config, persona) {
  const [card, languageRules, lorebook, examples] = await Promise.all([
    readPersonaCard(config, persona),
    readPersonaSupplement(config, persona?.languageRulesPath, MAX_PERSONA_LANGUAGE_RULES),
    readPersonaSupplement(config, persona?.lorebookPath, MAX_PERSONA_LOREBOOK),
    readPersonaSupplement(config, persona?.examplePath, MAX_PERSONA_EXAMPLES)
  ]);
  return {
    card,
    languageRules,
    lorebook,
    examples
  };
}

function formatPersonaPrompt(active, profile) {
  if (!active || !profile?.card) return "";
  const chunks = [profile.card];
  if (profile.languageRules) chunks.push(["## 语言规则", profile.languageRules].join("\n\n"));
  if (profile.lorebook) chunks.push(["## 设定补充", profile.lorebook].join("\n\n"));
  if (profile.examples) chunks.push(["## 对话示例", profile.examples].join("\n\n"));
  return chunks.join("\n\n");
}

async function formatActivePersonaPrompt(config, event, ctx) {
  const active = await getActivePersonaForContext(config, event, ctx);
  if (!active) return "";
  const profile = await readPersonaProfile(config, active.persona);
  return formatPersonaPrompt(active, profile);
}

async function recordPersonaHookDebug(config, event, ctx, result) {
  if (config.personaHookDebug !== true) return;
  const active = await getActivePersonaForContext(config, event, ctx).catch(() => null);
  const windowEntry = await resolveWindowEntryForContext(config, {}, event, ctx).catch(() => null);
  await appendJsonLine(personaHookDebugPath(config), {
    at: nowIso(),
    agentId: String(ctx?.agentId || ""),
    sessionKey: String(ctx?.sessionKey || ""),
    chatId: String(ctx?.chatId || ""),
    senderId: String(ctx?.senderId || ""),
    eventSessionKey: String(event?.sessionKey || event?.session?.key || ""),
    eventHasWindowId: Boolean(contextWindowId({}, event, ctx)),
    resolvedWindowId: String(windowEntry?.windowId || ""),
    resolvedWindowSessionKey: String(windowEntry?.sessionKey || ""),
    activeKey: String(active?.key || ""),
    activePersonaId: String(active?.persona?.id || ""),
    prependSystemContext: Boolean(result?.prependSystemContext),
    prependContext: Boolean(result?.prependContext),
    systemContextHash: result?.prependSystemContext ? hash(result.prependSystemContext, 16) : ""
  });
}

function formatPersonaRecord(record, persona) {
  if (!record || !persona) return "当前未激活角色卡";
  return `${record.key} -> ${persona.id} (${persona.label})${record.note ? ` (${clip(record.note, 100)})` : ""}`;
}

const personaConfigTool = {
  name: PERSONA_CONFIG_TOOL,
  label: "Persona Config",
  description: "List, inspect, set, or clear the persona profile selected for Telegram session windows, sender defaults, group scope, or global scope.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "status", "get", "set", "clear"], description: "Persona operation." },
      persona: { type: "string", description: "Persona id, label, or alias for set/get, such as chihaya_anon or 千早爱音." },
      id: { type: "string", description: "Alias for persona." },
      name: { type: "string", description: "Alias for persona." },
      scope: { type: "string", enum: ["session", "group", "global"], description: "Default session." },
      windowMode: { type: "string", enum: ["new_window", "current_session"], description: "For session set, default new_window when Telegram window context is available; current_session is available when an in-place experimental switch is explicitly requested." },
      rememberDefault: { type: "boolean", description: "For session set, persist this persona as the sender's default for later new windows. Defaults true when sender id is available." },
      note: { type: "string", description: "Short optional note for this switch." },
      sessionKey: { type: "string", description: "Optional explicit session key if runtime context is unavailable." },
      windowId: { type: "string", description: "Optional Telegram imagebot window id if runtime context lacks sessionKey." },
      groupKey: { type: "string", description: "Optional explicit group key if runtime context is unavailable." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const config = personaConfigTool.config || {};
      const action = readString(params, "action", "status").toLowerCase();
      const catalog = await loadPersonaCatalog(config);
      if (action === "list") {
        const active = await getActivePersonaForContext(config, null, ctx, { allowLatestFallback: true });
        const lines = [
          "available:",
          ...catalog.personas.map((persona) => `- ${persona.id}: ${persona.label}${persona.description ? ` — ${clip(persona.description, 140)}` : ""}`),
          "active:",
          active ? formatPersonaRecord(active.record, active.persona) : "当前未激活角色卡"
        ];
        return ok(PERSONA_CONFIG_TOOL, lines, { action, personas: catalog.personas.map(publicPersona), active });
      }
      if (action === "set") {
        const result = await setPersona(config, params, ctx);
        if (result.cleared) {
          return ok(PERSONA_CONFIG_TOOL, [
            result.window ? `opened persona window ${result.window.windowId} -> ${result.persona.label}` : `set ${formatPersonaRecord(result.record, result.persona)}`
          ], { action, ...result, persona: publicPersona(result.persona) });
        }
        return ok(PERSONA_CONFIG_TOOL, [
          result.windowMode === "new_window" ? `opened new persona window ${result.window.windowId} -> ${result.persona.label}` : `set ${formatPersonaRecord(result.record, result.persona)}`
        ], { action, record: result.record, persona: publicPersona(result.persona), window: result.window, windowMode: result.windowMode, userDefault: result.userDefault });
      }
      if (action === "clear") {
        const result = await clearPersona(config, params, ctx);
        return ok(PERSONA_CONFIG_TOOL, [`cleared ${result.key} existed=${result.existed}`], { action, ...result });
      }
      if (action === "get") {
        const query = readString(params, "persona") || readString(params, "id") || readString(params, "name");
        if (query) {
          const persona = findPersona(catalog, query);
          if (!persona) return { content: [{ type: "text", text: `PERSONA_CONFIG no_match persona=${query}` }], details: { status: "no_match", action, query } };
          const profile = await readPersonaProfile(config, persona);
          const card = profile.card;
          const lines = [
            `${persona.id}: ${persona.label}`,
            persona.description ? `description: ${persona.description}` : "",
            persona.aliases?.length ? `aliases: ${persona.aliases.join(", ")}` : "",
            card ? "card:" : "",
            card,
            profile.languageRules ? "language rules:" : "",
            profile.languageRules,
            profile.lorebook ? "lorebook:" : "",
            profile.lorebook,
            profile.examples ? "examples:" : "",
            profile.examples
          ].filter(Boolean);
          return ok(PERSONA_CONFIG_TOOL, lines, { action, persona: publicPersona(persona), ...profile });
        }
      }
      const active = await getActivePersonaForContext(config, null, ctx, { allowLatestFallback: true });
      return ok(PERSONA_CONFIG_TOOL, [active ? formatPersonaRecord(active.record, active.persona) : "当前未激活角色卡"], { action: "status", active });
    } catch (error) {
      return fail(PERSONA_CONFIG_TOOL, error);
    }
  }
};

function extractTerms(text) {
  const terms = new Set();
  const source = String(text || "").toLowerCase();
  for (const match of source.matchAll(/[a-z0-9_.-]{2,64}/gi)) terms.add(match[0].replace(/^@/, ""));
  for (const match of source.matchAll(/[\u4e00-\u9fff]{2,12}/g)) {
    const seq = match[0];
    for (let size = Math.min(4, seq.length); size >= 2; size--) {
      for (let i = 0; i <= seq.length - size; i++) terms.add(seq.slice(i, i + size));
    }
  }
  return [...terms].filter((term) => term.length >= 2).slice(0, 48);
}

function scoreTextRecord(record, terms) {
  if (!terms.length) return 1;
  const haystack = [
    record.id,
    record.title,
    record.trigger,
    record.problem,
    record.instructions,
    Array.isArray(record.tags) ? record.tags.join(" ") : ""
  ].join("\n").toLowerCase();
  let score = 0;
  const hits = [];
  for (const term of terms) {
    const count = haystack.split(term).length - 1;
    if (count > 0) {
      score += count * (4 + Math.min(term.length, 12));
      hits.push(term);
    }
  }
  return { score, hits: [...new Set(hits)].slice(0, 8) };
}

function normalizeSkillStatus(value) {
  const status = String(value || "approved").trim().toLowerCase();
  if (status === "pending" || status === "approved" || status === "rejected" || status === "all") return status;
  return "approved";
}

function normalizeSkillFileId(value, title, trigger, instructions) {
  const explicit = safeIdPart(value);
  if (value && explicit) return explicit.startsWith("skill_") ? explicit : `skill_${explicit}`;
  const slug = safeIdPart(title, "learned");
  return `skill_file_${slug}_${hash(`${title}:${trigger}:${instructions}`, 12)}`;
}

function deriveSkillTitle(instructions) {
  const line = String(instructions || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean) || "Learned workflow";
  return clip(line.replace(/^[-*#\d.\s]+/, ""), 80) || "Learned workflow";
}

function buildSkillMarkdown(record) {
  const media = Array.isArray(record.media) ? record.media : [];
  const lines = [
    "---",
    `id: ${record.id}`,
    `title: ${yamlString(record.title)}`,
    "type: learned_skill",
    "status: approved",
    `created_at: ${yamlString(record.t)}`,
    `updated_at: ${yamlString(record.updatedAt || record.t)}`,
    record.trigger ? `trigger: ${yamlString(record.trigger)}` : "",
    record.tags?.length ? `tags: [${record.tags.map((tag) => yamlString(tag)).join(", ")}]` : "",
    "---",
    "",
    `# ${record.title}`,
    "",
    record.trigger ? "## Trigger" : "",
    record.trigger ? record.trigger : "",
    record.problem ? "" : "",
    record.problem ? "## Problem" : "",
    record.problem ? record.problem : "",
    "",
    "## Instructions",
    "",
    record.instructions,
    media.length ? "" : "",
    media.length ? "## Media" : "",
    ...media.map((item) => `- ${item.relPath}${item.note ? ` - ${item.note}` : ""}`)
  ];
  return `${lines.filter((line, index, all) => line || all[index - 1] !== "").join("\n")}\n`;
}

async function copySkillMedia(config, skillDir, inputs) {
  const assetsDir = path.join(skillDir, "assets");
  const selected = inputs.slice(0, MAX_SKILL_FILE_MEDIA);
  const media = [];
  for (const input of selected) {
    const source = await resolveAllowedSkillMedia(config, input);
    const digest = await sha256File(source.path);
    const ext = source.ext === ".jpeg" ? ".jpg" : source.ext;
    await fs.mkdir(assetsDir, { recursive: true });
    const target = path.join(assetsDir, `${digest.slice(0, 20)}${ext}`);
    await fs.copyFile(source.path, target);
    media.push({
      relPath: path.relative(skillDir, target).replace(/\\/g, "/"),
      path: target,
      sha256: digest,
      bytes: source.stat.size
    });
  }
  return media;
}

async function saveSkillFile(config, params) {
  const rawInstructions = readString(params, "instructions") || readString(params, "content") || readString(params, "note");
  const instructions = clip(rawInstructions, 2500);
  if (!instructions) throw new Error("instructions or content is required for save");
  const title = clip(readString(params, "title") || deriveSkillTitle(instructions), 160);
  const trigger = clip(readString(params, "trigger"), 500);
  const id = normalizeSkillFileId(readString(params, "id"), title, trigger, instructions);
  const root = skillFilesRoot(config);
  const skillDir = path.join(root, id);
  if (!isInside(root, skillDir)) throw new Error("skill file path escaped skill store");
  await fs.mkdir(skillDir, { recursive: true });
  const mediaInputs = [
    ...readStringList(params, "media"),
    ...readStringList(params, "images")
  ];
  const media = await copySkillMedia(config, skillDir, mediaInputs);
  const record = {
    type: "skill_file",
    id,
    t: nowIso(),
    updatedAt: nowIso(),
    status: "approved",
    title,
    trigger,
    problem: clip(readString(params, "problem"), 800),
    instructions,
    tags: readArrayStrings(params, "tags").map((tag) => clip(tag, 40)).slice(0, 12),
    file: path.join(skillDir, "SKILL.md"),
    media
  };
  await fs.writeFile(record.file, buildSkillMarkdown(record), "utf8");
  await appendJsonLine(skillLogPath(config), record);
  return record;
}

async function loadSkillState(config) {
  const records = await readJsonLines(skillLogPath(config));
  const byId = new Map();
  for (const record of records) {
    if (record.type === "skill_proposal" && record.id) {
      byId.set(record.id, { ...record, status: record.status || "pending" });
    }
    if (record.type === "skill_file" && record.id) {
      byId.set(record.id, { ...record, status: "approved" });
    }
    if (record.type === "skill_decision" && record.id && byId.has(record.id)) {
      const current = byId.get(record.id);
      current.status = record.status;
      current.decisionAt = record.t;
      current.decisionNote = record.note || "";
      byId.set(record.id, current);
    }
  }
  const skills = [...byId.values()];
  skills.sort((a, b) => String(b.t || "").localeCompare(String(a.t || "")));
  return skills;
}

function publicSkill(record) {
  return {
    id: record.id,
    title: record.title,
    trigger: record.trigger,
    status: record.status,
    tags: record.tags || [],
    createdAt: record.t,
    decisionAt: record.decisionAt || "",
    problem: record.problem || "",
    instructions: record.instructions || "",
    file: record.file || "",
    media: Array.isArray(record.media) ? record.media.map((item) => ({
      relPath: item.relPath || "",
      path: item.path || "",
      bytes: item.bytes || 0
    })) : []
  };
}

function formatSkillLine(record, index = 0) {
  const prefix = index ? `${index}. ` : "";
  return `${prefix}id=${record.id} | status=${record.status} | title=${clip(record.title, 120)} | trigger=${clip(record.trigger || "n/a", 100)}`;
}

function filterSkills(skills, params) {
  const status = normalizeSkillStatus(readString(params, "status", "approved"));
  const query = readString(params, "query");
  const terms = extractTerms(query);
  let selected = skills.filter((skill) => status === "all" || skill.status === status);
  if (query) {
    selected = selected.map((record) => {
      const scored = scoreTextRecord(record, terms);
      return { record, score: scored.score, hits: scored.hits };
    }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).map((entry) => ({ ...entry.record, hits: entry.hits, score: entry.score }));
  }
  return selected.slice(0, readCount(params));
}

function formatSkillDetails(record) {
  if (!record) return "LEARNED_SKILL no_match";
  const media = Array.isArray(record.media) ? record.media : [];
  return [
    `LEARNED_SKILL ok id=${record.id}`,
    `status: ${record.status}`,
    `title: ${clip(record.title, 180)}`,
    record.trigger ? `trigger: ${clip(record.trigger, 240)}` : "",
    record.problem ? `problem: ${clip(record.problem, 500)}` : "",
    record.file ? `file: ${record.file}` : "",
    media.length ? `media: ${media.map((item) => item.relPath || item.path).join(", ")}` : "",
    "instructions:",
    clip(record.instructions, 1800),
    record.tags?.length ? `tags: ${record.tags.join(", ")}` : ""
  ].filter(Boolean).join("\n");
}

async function relevantApprovedSkills(config, prompt, count = 3) {
  const terms = extractTerms(prompt);
  if (!terms.length) return [];
  return (await loadSkillState(config))
    .filter((skill) => skill.status === "approved")
    .map((skill) => {
      const scored = scoreTextRecord(skill, terms);
      return { ...skill, score: scored.score, hits: scored.hits };
    })
    .filter((skill) => skill.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

function formatSkillsForPrompt(skills) {
  if (!skills.length) return "";
  const lines = [
    "[Imagebot 活跃工作流笔记]",
    "这些只作为本地工作流提示；对用户可见的自然回复仍然优先。"
  ];
  for (const skill of skills) {
    lines.push(`- ${skill.title}: ${clip(skill.instructions, 260)}`);
    const media = Array.isArray(skill.media) ? skill.media.slice(0, 2).map((item) => item.path).filter(Boolean) : [];
    if (media.length) lines.push(`  参考媒体: ${media.map((item) => `MEDIA: \`${item}\``).join(" ")}`);
  }
  lines.push("[/Imagebot 活跃工作流笔记]");
  return lines.join("\n");
}

const learnedSkillTool = {
  name: LEARNED_SKILL_TOOL,
  label: "Learned Skill",
  description: "Save, propose, approve, reject, list, get, or search local workflow skill notes.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["save", "propose", "list", "get", "approve", "reject", "search"], description: "Skill operation." },
      id: { type: "string", description: "Skill id for save/get/approve/reject." },
      title: { type: "string", description: "Short skill title for save/propose." },
      trigger: { type: "string", description: "When this workflow should be considered." },
      problem: { type: "string", description: "Problem or failure this skill fixes." },
      instructions: { type: "string", description: "Concrete concise workflow instructions." },
      content: { type: "string", description: "Alias for instructions when saving a text-file skill." },
      media: { type: "array", items: { type: "string" }, description: "Optional bot-local image media paths to copy into a saved skill." },
      images: { type: "array", items: { type: "string" }, description: "Alias for media." },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
      status: { type: "string", enum: ["pending", "approved", "rejected", "all"], description: "Filter for list/search. Default approved." },
      query: { type: "string", description: "Search query." },
      note: { type: "string", description: "Approval/rejection note." },
      count: { type: "number", description: `Count 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.` }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params) {
    try {
      const config = learnedSkillTool.config || {};
      const action = readString(params, "action").toLowerCase();
      if (action === "save") {
        const record = await saveSkillFile(config, params);
        return ok(LEARNED_SKILL_TOOL, [
          "saved approved text-file skill.",
          formatSkillLine(record),
          `file=${record.file}`,
          record.media.length ? `media=${record.media.length}` : ""
        ], { action, skill: publicSkill(record) });
      }
      if (action === "propose") {
        const title = clip(readString(params, "title"), 160);
        const instructions = clip(readString(params, "instructions"), 2500);
        if (!title || !instructions) throw new Error("title and instructions are required for propose");
        const record = {
          type: "skill_proposal",
          id: `skill_${hash(`${Date.now()}:${title}:${instructions}`, 18)}`,
          t: nowIso(),
          status: "pending",
          title,
          trigger: clip(readString(params, "trigger"), 500),
          problem: clip(readString(params, "problem"), 800),
          instructions,
          tags: readArrayStrings(params, "tags").map((tag) => clip(tag, 40)).slice(0, 12)
        };
        await appendJsonLine(skillLogPath(config), record);
        return ok(LEARNED_SKILL_TOOL, [
          "proposal created; it is not active until approved.",
          formatSkillLine(record)
        ], { action, skill: publicSkill(record) });
      }

      const skills = await loadSkillState(config);
      if (action === "approve" || action === "reject") {
        const id = readString(params, "id");
        const existing = skills.find((skill) => skill.id === id);
        if (!existing) return { content: [{ type: "text", text: `LEARNED_SKILL no_match id=${id}` }], details: { status: "no_match", id } };
        const status = action === "approve" ? "approved" : "rejected";
        await appendJsonLine(skillLogPath(config), {
          type: "skill_decision",
          id,
          t: nowIso(),
          status,
          note: clip(readString(params, "note"), 500)
        });
        return ok(LEARNED_SKILL_TOOL, [`${status} ${formatSkillLine({ ...existing, status })}`], { action, skill: publicSkill({ ...existing, status }) });
      }

      if (action === "get") {
        const id = readString(params, "id");
        const record = skills.find((skill) => skill.id === id || skill.id.startsWith(id));
        if (!record) return { content: [{ type: "text", text: `LEARNED_SKILL no_match id=${id}` }], details: { status: "no_match", id } };
        return { content: [{ type: "text", text: formatSkillDetails(record) }], details: { status: "ok", action, skill: publicSkill(record) } };
      }

      if (action === "list" || action === "search") {
        const selected = filterSkills(skills, { ...params, status: readString(params, "status", action === "list" ? "all" : "approved") });
        const lines = [`results=${selected.length}`, ...selected.map(formatSkillLine)];
        if (!selected.length) lines.push("No matching skills.");
        return ok(LEARNED_SKILL_TOOL, lines, { action, results: selected.map(publicSkill) });
      }

      throw new Error("unknown action");
    } catch (error) {
      return fail(LEARNED_SKILL_TOOL, error);
    }
  }
};

function toolEventKey(event, ctx) {
  return event?.toolCallId || ctx?.toolCallId || `${ctx?.runId || event?.runId || "run"}:${event?.toolName || "tool"}`;
}

function summarizeParams(params) {
  if (!isRecord(params)) return "";
  const keys = Object.keys(params).slice(0, 12);
  const summary = {};
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string") summary[key] = clip(value, 160);
    else if (typeof value === "number" || typeof value === "boolean") summary[key] = value;
    else if (Array.isArray(value)) summary[key] = `[array:${value.length}]`;
    else if (isRecord(value)) summary[key] = "[object]";
  }
  return JSON.stringify(summary);
}

async function recordToolEvent(config, event, ctx, pending) {
  const slowMs = Number(config?.failureSlowMs) || DEFAULT_FAILURE_SLOW_MS;
  const startedAt = pending?.startedAt || Date.now();
  const durationMs = Math.max(0, Math.trunc(Number(event?.durationMs) || Date.now() - startedAt));
  const error = event?.error ? sanitizeText(event.error instanceof Error ? event.error.message : String(event.error)) : "";
  const status = error ? "failed" : durationMs >= slowMs ? "slow" : "ok";
  if (status === "ok" && config?.recordSuccessfulToolEvents !== true) return null;
  const record = {
    type: "tool_event",
    t: nowIso(),
    status,
    toolName: String(event?.toolName || pending?.toolName || "unknown"),
    durationMs,
    sessionKey: String(ctx?.sessionKey || event?.sessionKey || pending?.sessionKey || ""),
    runId: String(ctx?.runId || event?.runId || pending?.runId || ""),
    error: clip(error, 800),
    params: clip(pending?.paramsSummary || summarizeParams(event?.params), 1000)
  };
  await appendJsonLine(failureLogPath(config), record);
  return record;
}

async function loadToolEvents(config) {
  return (await readJsonLines(failureLogPath(config)))
    .filter((record) => record.type === "tool_event")
    .sort((a, b) => String(b.t || "").localeCompare(String(a.t || "")));
}

function formatToolEvent(record, index = 0) {
  const prefix = index ? `${index}. ` : "";
  return `${prefix}${record.t} | ${record.status} | ${record.toolName} | ${record.durationMs}ms${record.error ? ` | ${clip(record.error, 180)}` : ""}`;
}

function filterToolEvents(records, params) {
  const status = readString(params, "status", "all").toLowerCase();
  const query = readString(params, "query");
  const terms = extractTerms(query);
  let selected = records.filter((record) => status === "all" || record.status === status);
  if (query) {
    selected = selected.map((record) => {
      const scored = scoreTextRecord({
        ...record,
        title: record.toolName,
        instructions: `${record.error}\n${record.params}`,
        tags: [record.status]
      }, terms);
      return { record, score: scored.score };
    }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).map((entry) => entry.record);
  }
  return selected.slice(0, readCount(params));
}

function summarizeToolEvents(records, params) {
  const hours = readNumber(params, "hours", 24, 1, 720);
  const cutoff = Date.now() - hours * 3600_000;
  const selected = records.filter((record) => Date.parse(record.t || 0) >= cutoff);
  const byTool = new Map();
  for (const record of selected) {
    const key = record.toolName || "unknown";
    const stat = byTool.get(key) || { toolName: key, failed: 0, slow: 0, ok: 0, total: 0, maxDurationMs: 0, lastError: "" };
    stat.total += 1;
    stat[record.status] = (stat[record.status] || 0) + 1;
    stat.maxDurationMs = Math.max(stat.maxDurationMs, Number(record.durationMs) || 0);
    if (record.error) stat.lastError = record.error;
    byTool.set(key, stat);
  }
  return [...byTool.values()].sort((a, b) => b.total - a.total || b.maxDurationMs - a.maxDurationMs);
}

const failureMemoryTool = {
  name: FAILURE_MEMORY_TOOL,
  label: "Failure Memory",
  description: "Inspect recent tool failures and slow tool calls recorded by hooks.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["recent", "search", "summary"], description: "Failure-memory operation." },
      status: { type: "string", enum: ["failed", "slow", "ok", "all"], description: "Filter. Default all." },
      query: { type: "string", description: "Search failure text, tool names, or params summary." },
      count: { type: "number", description: `Count 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.` },
      hours: { type: "number", description: "Summary window in hours. Default 24." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params) {
    try {
      const config = failureMemoryTool.config || {};
      const action = readString(params, "action", "recent").toLowerCase();
      const records = await loadToolEvents(config);
      if (action === "summary") {
        const stats = summarizeToolEvents(records, params);
        const lines = [`summary tools=${stats.length}`, ...stats.slice(0, readCount(params, 10)).map((stat, index) => `${index + 1}. ${stat.toolName} total=${stat.total} failed=${stat.failed || 0} slow=${stat.slow || 0} max=${stat.maxDurationMs}ms${stat.lastError ? ` last=${clip(stat.lastError, 140)}` : ""}`)];
        if (!stats.length) lines.push("No recent failure/slow tool events recorded.");
        return ok(FAILURE_MEMORY_TOOL, lines, { action, stats });
      }
      const selected = filterToolEvents(records, params);
      const lines = [`results=${selected.length}`, ...selected.map(formatToolEvent)];
      if (!selected.length) lines.push("No matching tool events.");
      return ok(FAILURE_MEMORY_TOOL, lines, { action, results: selected });
    } catch (error) {
      return fail(FAILURE_MEMORY_TOOL, error);
    }
  }
};

function normalizeTags(tags) {
  return tags.map((tag) => clip(tag, 40).replace(/\s+/g, "-")).filter(Boolean).slice(0, 12);
}

function normalizePublicUrlOrBlank(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let parsed;
  try {
    parsed = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error("invalid evidence URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("only public http/https evidence URLs are allowed");
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("local/internal evidence URLs are blocked");
  parsed.hash = "";
  return parsed.toString();
}

async function loadEvidenceState(config) {
  const records = await readJsonLines(evidenceLogPath(config));
  const packs = new Map();
  for (const record of records) {
    if (record.type === "evidence_pack" && record.id) {
      packs.set(record.id, { ...record, items: [] });
    }
    if (record.type === "evidence_item" && record.packId && packs.has(record.packId)) {
      packs.get(record.packId).items.push(record);
    }
  }
  const result = [...packs.values()];
  result.sort((a, b) => String(b.t || "").localeCompare(String(a.t || "")));
  return result;
}

function publicEvidencePack(pack) {
  return {
    id: pack.id,
    title: pack.title,
    summary: pack.summary,
    tags: pack.tags || [],
    createdAt: pack.t,
    itemCount: Array.isArray(pack.items) ? pack.items.length : 0,
    items: (pack.items || []).map((item) => ({
      title: item.title,
      url: item.url,
      artifactId: item.artifactId,
      note: item.note,
      quote: item.quote,
      kind: item.kind,
      t: item.t
    }))
  };
}

function formatEvidenceLine(pack, index = 0) {
  const prefix = index ? `${index}. ` : "";
  return `${prefix}id=${pack.id} | items=${pack.items?.length || 0} | title=${clip(pack.title, 140)}`;
}

function scoreEvidence(pack, terms) {
  return scoreTextRecord({
    id: pack.id,
    title: pack.title,
    trigger: Array.isArray(pack.tags) ? pack.tags.join(" ") : "",
    problem: pack.summary,
    instructions: (pack.items || []).map((item) => `${item.title}\n${item.url}\n${item.note}\n${item.quote}`).join("\n")
  }, terms).score;
}

const evidencePackTool = {
  name: EVIDENCE_PACK_TOOL,
  label: "Evidence Pack",
  description: "Create and query lightweight evidence packs for public web/research tasks.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["create", "add", "list", "get", "search"], description: "Evidence operation." },
      pack_id: { type: "string", description: "Evidence pack id." },
      id: { type: "string", description: "Alias for pack_id." },
      title: { type: "string", description: "Pack or item title." },
      summary: { type: "string", description: "Pack summary." },
      tags: { type: "array", items: { type: "string" }, description: "Pack tags." },
      url: { type: "string", description: "Public evidence URL." },
      artifact_id: { type: "string", description: "Related artifact id from other tools." },
      note: { type: "string", description: "Short evidence note." },
      quote: { type: "string", description: "Short quote or paraphrase." },
      kind: { type: "string", description: "Evidence kind, e.g. source, screenshot, release, issue, note." },
      query: { type: "string", description: "Search query." },
      count: { type: "number", description: `Count 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.` }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params) {
    try {
      const config = evidencePackTool.config || {};
      const action = readString(params, "action").toLowerCase();
      if (action === "create") {
        const title = clip(readString(params, "title"), 180);
        if (!title) throw new Error("title is required for create");
        const record = {
          type: "evidence_pack",
          id: `pack_${hash(`${Date.now()}:${title}`, 16)}`,
          t: nowIso(),
          title,
          summary: clip(readString(params, "summary"), 900),
          tags: normalizeTags(readArrayStrings(params, "tags"))
        };
        await appendJsonLine(evidenceLogPath(config), record);
        return ok(EVIDENCE_PACK_TOOL, ["created", formatEvidenceLine({ ...record, items: [] })], { action, pack: publicEvidencePack({ ...record, items: [] }) });
      }
      const packs = await loadEvidenceState(config);
      if (action === "add") {
        const packId = readString(params, "pack_id") || readString(params, "id");
        const pack = packs.find((entry) => entry.id === packId || entry.id.startsWith(packId));
        if (!pack) return { content: [{ type: "text", text: `EVIDENCE_PACK no_match id=${packId}` }], details: { status: "no_match", id: packId } };
        const item = {
          type: "evidence_item",
          packId: pack.id,
          t: nowIso(),
          title: clip(readString(params, "title"), 180),
          url: normalizePublicUrlOrBlank(readString(params, "url")),
          artifactId: clip(readString(params, "artifact_id"), 120),
          note: clip(readString(params, "note"), 900),
          quote: clip(readString(params, "quote"), 900),
          kind: clip(readString(params, "kind", "note"), 80)
        };
        if (!item.title && !item.url && !item.artifactId && !item.note && !item.quote) throw new Error("add requires title, url, artifact_id, note, or quote");
        await appendJsonLine(evidenceLogPath(config), item);
        return ok(EVIDENCE_PACK_TOOL, [`added to ${pack.id}`, `${item.kind}: ${clip(item.title || item.url || item.note, 220)}`], { action, item });
      }
      if (action === "get") {
        const id = readString(params, "pack_id") || readString(params, "id");
        const pack = packs.find((entry) => entry.id === id || entry.id.startsWith(id));
        if (!pack) return { content: [{ type: "text", text: `EVIDENCE_PACK no_match id=${id}` }], details: { status: "no_match", id } };
        const lines = [
          `id=${pack.id}`,
          `title=${clip(pack.title, 180)}`,
          pack.summary ? `summary=${clip(pack.summary, 500)}` : "",
          `items=${pack.items.length}`,
          ...pack.items.slice(0, MAX_COUNT).map((item, index) => `${index + 1}. ${item.kind || "item"} | ${clip(item.title || item.url || item.artifactId, 140)}${item.note ? ` | ${clip(item.note, 200)}` : ""}${item.url ? ` | ${item.url}` : ""}`)
        ].filter(Boolean);
        return ok(EVIDENCE_PACK_TOOL, lines, { action, pack: publicEvidencePack(pack) });
      }
      let selected = packs;
      if (action === "search") {
        const terms = extractTerms(readString(params, "query"));
        selected = packs.map((pack) => ({ pack, score: scoreEvidence(pack, terms) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.pack);
      }
      selected = selected.slice(0, readCount(params));
      const lines = [`results=${selected.length}`, ...selected.map(formatEvidenceLine)];
      if (!selected.length) lines.push("No matching evidence packs.");
      return ok(EVIDENCE_PACK_TOOL, lines, { action, results: selected.map(publicEvidencePack) });
    } catch (error) {
      return fail(EVIDENCE_PACK_TOOL, error);
    }
  }
};

function boardScopeKey(scope, params, ctx) {
  if (scope === "global") return "global";
  if (scope === "group") return `group:${contextGroupKey(params, null, ctx) || "telegram-group"}`;
  const sessionKey = contextSessionKey(params, ctx);
  if (!sessionKey) throw new Error("session scope requires sessionKey from runtime or params");
  return `session:${sessionKey}`;
}

function normalizeBoardScope(value) {
  return normalizeScope(value || "group");
}

function normalizeBoardStatus(kind, value) {
  const text = String(value || "").trim().toLowerCase();
  if (kind === "rule") return ["active", "disabled"].includes(text) ? text : "active";
  if (kind === "ticket") return ["open", "doing", "blocked", "done", "closed"].includes(text) ? text : "open";
  if (kind === "schedule") return ["draft", "ready", "sent", "cancelled"].includes(text) ? text : "draft";
  if (kind === "flow") return ["draft", "active", "disabled"].includes(text) ? text : "draft";
  if (kind === "preset") return ["active", "disabled"].includes(text) ? text : "active";
  return text || "open";
}

function normalizePriority(value) {
  const priority = String(value || "normal").trim().toLowerCase();
  return ["low", "normal", "high"].includes(priority) ? priority : "normal";
}

function boardKeywords(params) {
  const values = [
    ...readStringList(params, "keyword"),
    ...readStringList(params, "keywords")
  ];
  return [...new Set(values.map((item) => clip(item, 80)).filter(Boolean))].slice(0, 12);
}

function normalizeDueAt(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new Error("dueAt must be an ISO-like date/time");
  return new Date(ms).toISOString();
}

function readObjectParam(params, key) {
  const value = isRecord(params) ? params[key] : undefined;
  return isRecord(value) ? value : {};
}

function boardConditions(params) {
  const raw = readObjectParam(params, "conditions");
  const conditions = {};
  const copyString = (sourceKey, targetKey = sourceKey, allowRoot = true) => {
    const hasRaw = Object.hasOwn(raw, sourceKey);
    const value = String(hasRaw ? raw[sourceKey] : (allowRoot ? readString(params, sourceKey) : "")).trim();
    if (value) conditions[targetKey] = clip(value, 120);
  };
  copyString("chatId");
  copyString("groupKey", "groupKey", false);
  copyString("userId");
  const hasMediaRaw = raw.hasMedia ?? (isRecord(params) ? params.hasMedia : undefined);
  if (typeof hasMediaRaw === "boolean") conditions.hasMedia = hasMediaRaw;
  if (typeof hasMediaRaw === "string" && hasMediaRaw.trim()) conditions.hasMedia = /^(1|true|yes|on)$/i.test(hasMediaRaw.trim());
  const fromHour = Number(raw.fromHour ?? (isRecord(params) ? params.fromHour : undefined));
  const toHour = Number(raw.toHour ?? (isRecord(params) ? params.toHour : undefined));
  if (Number.isInteger(fromHour) && fromHour >= 0 && fromHour <= 23) conditions.fromHour = fromHour;
  if (Number.isInteger(toHour) && toHour >= 0 && toHour <= 23) conditions.toHour = toHour;
  return conditions;
}

function hourInWindow(hour, fromHour, toHour) {
  if (!Number.isInteger(fromHour) && !Number.isInteger(toHour)) return true;
  const current = Number.isInteger(hour) ? hour : new Date().getHours();
  const from = Number.isInteger(fromHour) ? fromHour : 0;
  const to = Number.isInteger(toHour) ? toHour : 23;
  if (from <= to) return current >= from && current <= to;
  return current >= from || current <= to;
}

function boardConditionMatch(item, params, ctx) {
  const conditions = isRecord(item.conditions) ? item.conditions : {};
  const misses = [];
  const chatId = readString(params, "chatId") || String(ctx?.chatId || ctx?.groupId || "");
  const groupKey = readString(params, "groupKey") || contextGroupKey(params, null, ctx);
  const userId = readString(params, "userId") || String(ctx?.senderId || ctx?.userId || "");
  if (conditions.chatId && String(conditions.chatId) !== String(chatId)) misses.push("chatId");
  if (conditions.groupKey && String(conditions.groupKey) !== String(groupKey)) misses.push("groupKey");
  if (conditions.userId && String(conditions.userId) !== String(userId)) misses.push("userId");
  if (typeof conditions.hasMedia === "boolean") {
    const hasMedia = readBoolean(params, "hasMedia", Boolean(ctx?.hasMedia));
    if (conditions.hasMedia !== hasMedia) misses.push("hasMedia");
  }
  if (Number.isInteger(conditions.fromHour) || Number.isInteger(conditions.toHour)) {
    const hour = readNumber(params, "hour", new Date().getHours(), 0, 23);
    if (!hourInWindow(hour, conditions.fromHour, conditions.toHour)) misses.push("hour");
  }
  return { ok: misses.length === 0, misses };
}

function boardSamples(params) {
  const values = [
    ...readStringList(params, "samples"),
    ...readStringList(params, "sampleUtterances"),
    ...readStringList(params, "examples")
  ];
  return [...new Set(values.map((item) => clip(item, 180)).filter(Boolean))].slice(0, 20);
}

function boardSlots(params) {
  const values = [
    ...readStringList(params, "slots"),
    ...readStringList(params, "requiredSlots")
  ];
  return [...new Set(values.map((item) => safeIdPart(item, "").replace(/^-+|-+$/g, "") || clip(item, 60)).filter(Boolean))].slice(0, 20);
}

function boardSteps(params) {
  const raw = isRecord(params) ? params.steps : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((step, index) => {
    if (typeof step === "string") {
      return { id: `step_${index + 1}`, text: clip(step, 500) };
    }
    if (!isRecord(step)) return null;
    return {
      id: safeIdPart(step.id || `step_${index + 1}`, `step_${index + 1}`),
      title: clip(step.title || "", 120),
      text: clip(step.text || step.prompt || step.instruction || "", 500),
      expect: clip(step.expect || step.expected || "", 240)
    };
  }).filter((step) => step && (step.text || step.title));
}

function validateBoardFlow(item) {
  const issues = [];
  const warnings = [];
  if (!item.title) issues.push("title is required");
  if (!item.intent && !(item.keywords || []).length && !(item.samples || []).length) {
    warnings.push("add intent, keywords, or sample utterances for routing");
  }
  if (!Array.isArray(item.steps) || !item.steps.length) issues.push("at least one step is required");
  if ((item.steps || []).length > 12) warnings.push("flow has many steps; keep chat flows compact");
  if ((item.slots || []).length > 8) warnings.push("many required slots can make group chat brittle");
  return { ok: issues.length === 0, issues, warnings };
}

async function loadBotBoardState(config) {
  const records = await readJsonLines(botBoardLogPath(config));
  const byId = new Map();
  for (const record of records) {
    if (record.type === "bot_board_item" && record.id) {
      byId.set(record.id, { ...record, history: [] });
      continue;
    }
    if (record.type !== "bot_board_update" || !record.id || !byId.has(record.id)) continue;
    const current = byId.get(record.id);
    for (const key of ["status", "title", "body", "response", "message", "audience", "owner", "priority", "dueAt", "intent", "trigger", "instructions", "source"]) {
      if (record[key] !== undefined && record[key] !== "") current[key] = record[key];
    }
    if (Array.isArray(record.keywords) && record.keywords.length) current.keywords = record.keywords;
    if (Array.isArray(record.samples) && record.samples.length) current.samples = record.samples;
    if (Array.isArray(record.slots) && record.slots.length) current.slots = record.slots;
    if (Array.isArray(record.steps) && record.steps.length) current.steps = record.steps;
    if (Array.isArray(record.tags) && record.tags.length) current.tags = record.tags;
    if (isRecord(record.conditions)) current.conditions = record.conditions;
    current.updatedAt = record.t;
    current.history.push({ t: record.t, status: record.status || "", note: record.note || "" });
    byId.set(record.id, current);
  }
  return [...byId.values()].sort((a, b) => String(b.updatedAt || b.t || "").localeCompare(String(a.updatedAt || a.t || "")));
}

function publicBoardItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    scope: item.scope,
    key: item.key,
    title: item.title || "",
    body: item.body || "",
    keywords: item.keywords || [],
    conditions: isRecord(item.conditions) ? item.conditions : {},
    intent: item.intent || "",
    samples: item.samples || [],
    slots: item.slots || [],
    steps: item.steps || [],
    trigger: item.trigger || "",
    instructions: item.instructions || "",
    source: item.source || "",
    response: item.response || "",
    message: item.message || "",
    dueAt: item.dueAt || "",
    audience: item.audience || "",
    priority: item.priority || "",
    owner: item.owner || "",
    note: item.note || "",
    tags: item.tags || [],
    createdAt: item.t,
    updatedAt: item.updatedAt || item.t,
    history: item.history || []
  };
}

function formatBoardLine(item, index = 0) {
  const prefix = index ? `${index}. ` : "";
  const label = item.kind === "rule"
    ? `${(item.keywords || []).join(", ")} -> ${clip(item.response, 90)}`
    : item.kind === "schedule"
      ? `${clip(item.title || item.message, 90)} @ ${item.dueAt || "no dueAt"}`
      : item.kind === "flow"
        ? `${clip(item.title, 90)} intent=${item.intent || "n/a"} steps=${item.steps?.length || 0}`
        : item.kind === "preset"
          ? `${clip(item.title, 90)} trigger=${clip(item.trigger || "n/a", 60)}`
          : `${clip(item.title, 100)} priority=${item.priority || "normal"}`;
  return `${prefix}id=${item.id} | ${item.kind} | ${item.status} | ${label}`;
}

function boardTextScore(item, terms) {
  return scoreTextRecord({
    id: item.id,
    title: item.title || item.kind,
    trigger: [item.intent, item.trigger, ...(item.keywords || []), ...(item.samples || [])].join(" "),
    problem: item.body || item.note || item.audience || item.source || "",
    instructions: [
      item.response,
      item.message,
      item.instructions,
      item.owner,
      item.priority,
      item.status,
      ...(item.slots || []),
      ...(item.steps || []).map((step) => `${step.title || ""} ${step.text || ""} ${step.expect || ""}`),
      ...(item.tags || [])
    ].join("\n"),
    tags: item.tags || []
  }, terms).score;
}

function filterBoardItems(items, params, ctx, kind) {
  const status = readString(params, "status").toLowerCase();
  const query = readString(params, "query");
  const scopeText = readString(params, "scope");
  const terms = extractTerms(query);
  let selected = items.filter((item) => item.kind === kind);
  if (status) selected = selected.filter((item) => item.status === status);
  if (scopeText) {
    const scope = normalizeBoardScope(scopeText);
    const key = boardScopeKey(scope, params, ctx);
    selected = selected.filter((item) => item.scope === scope && item.key === key);
  }
  if (query) {
    selected = selected.map((item) => ({ item, score: boardTextScore(item, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);
  }
  return selected.slice(0, readCount(params, DEFAULT_COUNT, 30));
}

async function createBoardItem(config, item) {
  await appendJsonLine(botBoardLogPath(config), item);
  return item;
}

async function updateBoardItem(config, item, params) {
  const patch = {
    type: "bot_board_update",
    id: item.id,
    kind: item.kind,
    t: nowIso(),
    note: clip(readString(params, "note"), 500)
  };
  if (readString(params, "status")) patch.status = normalizeBoardStatus(item.kind, readString(params, "status"));
  if (readString(params, "title")) patch.title = clip(readString(params, "title"), 180);
  if (readString(params, "body")) patch.body = clip(readString(params, "body"), 1800);
  if (readString(params, "response")) patch.response = clip(readString(params, "response"), 900);
  if (readString(params, "message")) patch.message = clip(readString(params, "message"), 1200);
  if (readString(params, "audience")) patch.audience = clip(readString(params, "audience"), 180);
  if (readString(params, "owner")) patch.owner = clip(readString(params, "owner"), 120);
  if (readString(params, "intent")) patch.intent = clip(readString(params, "intent"), 120);
  if (readString(params, "trigger")) patch.trigger = clip(readString(params, "trigger"), 300);
  if (readString(params, "instructions") || readString(params, "content")) patch.instructions = clip(readString(params, "instructions") || readString(params, "content"), 1800);
  if (readString(params, "source")) patch.source = clip(readString(params, "source"), 240);
  if (readString(params, "priority")) patch.priority = normalizePriority(readString(params, "priority"));
  if (readString(params, "dueAt")) patch.dueAt = normalizeDueAt(readString(params, "dueAt"));
  const keywords = boardKeywords(params);
  if (keywords.length) patch.keywords = keywords;
  const conditions = boardConditions(params);
  if (Object.keys(conditions).length) patch.conditions = conditions;
  const samples = boardSamples(params);
  if (samples.length) patch.samples = samples;
  const slots = boardSlots(params);
  if (slots.length) patch.slots = slots;
  const steps = boardSteps(params);
  if (steps.length) patch.steps = steps;
  const tags = normalizeTags(readArrayStrings(params, "tags"));
  if (tags.length) patch.tags = tags;
  await appendJsonLine(botBoardLogPath(config), patch);
  return { ...item, ...patch, updatedAt: patch.t, history: [...(item.history || []), { t: patch.t, status: patch.status || "", note: patch.note || "" }] };
}

function findBoardItem(items, id, kind = "") {
  const text = String(id || "").trim();
  if (!text) return null;
  return items.find((item) => (!kind || item.kind === kind) && (item.id === text || item.id.startsWith(text))) || null;
}

const botBoardTool = {
  name: BOT_BOARD_TOOL,
  label: "Bot Board",
  description: "Save and query low-authority bot rules, tickets, and scheduled-message drafts. It never sends messages or runs admin actions.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: [
          "rule_add", "rule_match", "rule_list", "rule_update",
          "ticket_create", "ticket_update", "ticket_list", "ticket_get",
          "schedule_create", "schedule_update", "schedule_list", "schedule_due",
          "flow_create", "flow_update", "flow_get", "flow_list", "flow_validate", "flow_match",
          "preset_save", "preset_update", "preset_get", "preset_list", "preset_match"
        ],
        description: "Board operation."
      },
      id: { type: "string", description: "Rule, ticket, schedule, flow, or preset id." },
      scope: { type: "string", enum: ["session", "group", "global"], description: "Storage scope. Default group." },
      sessionKey: { type: "string", description: "Session key for session scope." },
      groupKey: { type: "string", description: "Group key for group scope." },
      chatId: { type: "string", description: "Optional chat id for conditional rule matching." },
      userId: { type: "string", description: "Optional user id for conditional rule matching." },
      hasMedia: { type: "boolean", description: "Whether the current turn has media, for conditional rule matching." },
      hour: { type: "number", description: "Current local hour 0-23 for conditional rule dry-runs." },
      keyword: { type: "string", description: "Single keyword for rule_add/update." },
      keywords: { type: "array", items: { type: "string" }, description: "Keywords for rule matching." },
      conditions: { type: "object", additionalProperties: true, description: "Optional rule conditions: chatId, groupKey, userId, hasMedia, fromHour, toHour." },
      text: { type: "string", description: "Text to match against active keyword rules." },
      response: { type: "string", description: "Suggested reply text for keyword rules." },
      title: { type: "string", description: "Ticket, schedule, flow, or preset title." },
      body: { type: "string", description: "Ticket body." },
      message: { type: "string", description: "Scheduled-message draft body." },
      dueAt: { type: "string", description: "ISO-like due date/time for schedule records." },
      before: { type: "string", description: "ISO-like cutoff for schedule_due. Default now." },
      audience: { type: "string", description: "Human-readable schedule audience/channel." },
      status: { type: "string", description: "Rule active/disabled, ticket open/doing/blocked/done/closed, schedule draft/ready/sent/cancelled, flow draft/active/disabled, or preset active/disabled." },
      intent: { type: "string", description: "Flow intent label." },
      samples: { type: "array", items: { type: "string" }, description: "Flow sample utterances." },
      sampleUtterances: { type: "array", items: { type: "string" }, description: "Alias for flow samples." },
      examples: { type: "array", items: { type: "string" }, description: "Alias for flow samples." },
      slots: { type: "array", items: { type: "string" }, description: "Required flow slots." },
      requiredSlots: { type: "array", items: { type: "string" }, description: "Alias for slots." },
      steps: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }] }, description: "Flow steps with id/title/text/expect, or plain step text." },
      trigger: { type: "string", description: "Preset trigger or routing cue." },
      instructions: { type: "string", description: "Preset instructions or flow notes." },
      content: { type: "string", description: "Alias for instructions." },
      source: { type: "string", description: "Optional source/reference for a flow or preset." },
      priority: { type: "string", enum: ["low", "normal", "high"], description: "Ticket priority." },
      owner: { type: "string", description: "Optional human owner label." },
      note: { type: "string", description: "Short update note." },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
      query: { type: "string", description: "List/search query." },
      count: { type: "number", description: "Count 1-30. Default 6." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params, _signal, _progress, ctx = {}) {
    try {
      const config = botBoardTool.config || {};
      const action = readString(params, "action").toLowerCase();
      if (action === "rule_add") {
        const keywords = boardKeywords(params);
        const response = clip(readString(params, "response"), 900);
        if (!keywords.length || !response) throw new Error("rule_add requires keywords and response");
        const scope = normalizeBoardScope(readString(params, "scope", "group"));
        const item = {
          type: "bot_board_item",
          kind: "rule",
          id: `rule_${hash(`${Date.now()}:${keywords.join("|")}:${response}`, 14)}`,
          t: nowIso(),
          updatedAt: nowIso(),
          scope,
          key: boardScopeKey(scope, params, ctx),
          status: normalizeBoardStatus("rule", readString(params, "status")),
          keywords,
          conditions: boardConditions(params),
          response,
          note: clip(readString(params, "note"), 500),
          tags: normalizeTags(readArrayStrings(params, "tags"))
        };
        await createBoardItem(config, item);
        return ok(BOT_BOARD_TOOL, ["created keyword rule", formatBoardLine(item)], { action, item: publicBoardItem(item) });
      }
      const items = await loadBotBoardState(config);
      if (action === "rule_match") {
        const text = readString(params, "text") || readString(params, "query");
        if (!text) throw new Error("rule_match requires text or query");
        const lowered = text.toLowerCase();
        const matched = items.filter((item) => item.kind === "rule" && item.status === "active")
          .map((item) => ({
            item,
            hits: (item.keywords || []).filter((keyword) => lowered.includes(String(keyword).toLowerCase())),
            conditions: boardConditionMatch(item, params, ctx)
          }))
          .filter((entry) => entry.hits.length && entry.conditions.ok)
          .slice(0, readCount(params, DEFAULT_COUNT, 30));
        const lines = [`matches=${matched.length}`, ...matched.map((entry, index) => `${index + 1}. ${formatBoardLine(entry.item)} | hits=${entry.hits.join(", ")}`)];
        if (!matched.length) lines.push("No active keyword rules matched.");
        return ok(BOT_BOARD_TOOL, lines, { action, matches: matched.map((entry) => ({ ...publicBoardItem(entry.item), hits: entry.hits })) });
      }
      if (action === "rule_list") {
        const selected = filterBoardItems(items, params, ctx, "rule");
        return ok(BOT_BOARD_TOOL, [`results=${selected.length}`, ...selected.map(formatBoardLine)], { action, results: selected.map(publicBoardItem) });
      }
      if (action === "rule_update") {
        const item = findBoardItem(items, readString(params, "id"), "rule");
        if (!item) return { content: [{ type: "text", text: `BOT_BOARD no_match id=${readString(params, "id")}` }], details: { status: "no_match", id: readString(params, "id") } };
        const updated = await updateBoardItem(config, item, params);
        return ok(BOT_BOARD_TOOL, ["updated rule", formatBoardLine(updated)], { action, item: publicBoardItem(updated) });
      }
      if (action === "ticket_create") {
        const title = clip(readString(params, "title"), 180);
        if (!title) throw new Error("ticket_create requires title");
        const scope = normalizeBoardScope(readString(params, "scope", "group"));
        const item = {
          type: "bot_board_item",
          kind: "ticket",
          id: `ticket_${hash(`${Date.now()}:${title}`, 14)}`,
          t: nowIso(),
          updatedAt: nowIso(),
          scope,
          key: boardScopeKey(scope, params, ctx),
          status: normalizeBoardStatus("ticket", readString(params, "status")),
          title,
          body: clip(readString(params, "body"), 1800),
          priority: normalizePriority(readString(params, "priority")),
          owner: clip(readString(params, "owner"), 120),
          note: clip(readString(params, "note"), 500),
          tags: normalizeTags(readArrayStrings(params, "tags"))
        };
        await createBoardItem(config, item);
        return ok(BOT_BOARD_TOOL, ["created ticket", formatBoardLine(item)], { action, item: publicBoardItem(item) });
      }
      if (action === "ticket_update") {
        const item = findBoardItem(items, readString(params, "id"), "ticket");
        if (!item) return { content: [{ type: "text", text: `BOT_BOARD no_match id=${readString(params, "id")}` }], details: { status: "no_match", id: readString(params, "id") } };
        const updated = await updateBoardItem(config, item, params);
        return ok(BOT_BOARD_TOOL, ["updated ticket", formatBoardLine(updated)], { action, item: publicBoardItem(updated) });
      }
      if (action === "ticket_get") {
        const item = findBoardItem(items, readString(params, "id"), "ticket");
        if (!item) return { content: [{ type: "text", text: `BOT_BOARD no_match id=${readString(params, "id")}` }], details: { status: "no_match", id: readString(params, "id") } };
        return ok(BOT_BOARD_TOOL, [
          formatBoardLine(item),
          item.body ? `body: ${clip(item.body, 800)}` : "",
          item.note ? `note: ${clip(item.note, 400)}` : ""
        ], { action, item: publicBoardItem(item) });
      }
      if (action === "ticket_list") {
        const selected = filterBoardItems(items, params, ctx, "ticket");
        return ok(BOT_BOARD_TOOL, [`results=${selected.length}`, ...selected.map(formatBoardLine)], { action, results: selected.map(publicBoardItem) });
      }
      if (action === "schedule_create") {
        const message = clip(readString(params, "message"), 1200);
        if (!message) throw new Error("schedule_create requires message");
        const scope = normalizeBoardScope(readString(params, "scope", "group"));
        const item = {
          type: "bot_board_item",
          kind: "schedule",
          id: `schedule_${hash(`${Date.now()}:${message}`, 14)}`,
          t: nowIso(),
          updatedAt: nowIso(),
          scope,
          key: boardScopeKey(scope, params, ctx),
          status: normalizeBoardStatus("schedule", readString(params, "status")),
          title: clip(readString(params, "title"), 180),
          message,
          dueAt: normalizeDueAt(readString(params, "dueAt")),
          audience: clip(readString(params, "audience"), 180),
          note: clip(readString(params, "note"), 500) || "Draft only: bot_board does not send scheduled messages.",
          tags: normalizeTags(readArrayStrings(params, "tags"))
        };
        await createBoardItem(config, item);
        return ok(BOT_BOARD_TOOL, ["created scheduled-message draft", formatBoardLine(item), "delivery: not scheduled by this tool"], { action, item: publicBoardItem(item) });
      }
      if (action === "schedule_update") {
        const item = findBoardItem(items, readString(params, "id"), "schedule");
        if (!item) return { content: [{ type: "text", text: `BOT_BOARD no_match id=${readString(params, "id")}` }], details: { status: "no_match", id: readString(params, "id") } };
        const updated = await updateBoardItem(config, item, params);
        return ok(BOT_BOARD_TOOL, ["updated schedule", formatBoardLine(updated), "delivery: not scheduled by this tool"], { action, item: publicBoardItem(updated) });
      }
      if (action === "schedule_due") {
        const cutoff = normalizeDueAt(readString(params, "before") || new Date().toISOString());
        const selected = items.filter((item) => item.kind === "schedule" && item.status === "ready" && item.dueAt && item.dueAt <= cutoff)
          .slice(0, readCount(params, DEFAULT_COUNT, 30));
        return ok(BOT_BOARD_TOOL, [`due=${selected.length}`, ...selected.map(formatBoardLine), "delivery: inspect only; no messages were sent"], { action, results: selected.map(publicBoardItem), before: cutoff });
      }
      if (action === "schedule_list") {
        const selected = filterBoardItems(items, params, ctx, "schedule");
        return ok(BOT_BOARD_TOOL, [`results=${selected.length}`, ...selected.map(formatBoardLine), "delivery: inspect only; no messages were sent"], { action, results: selected.map(publicBoardItem) });
      }
      if (action === "flow_create") {
        const title = clip(readString(params, "title"), 180);
        const steps = boardSteps(params);
        const scope = normalizeBoardScope(readString(params, "scope", "group"));
        const item = {
          type: "bot_board_item",
          kind: "flow",
          id: `flow_${hash(`${Date.now()}:${title}:${readString(params, "intent")}`, 14)}`,
          t: nowIso(),
          updatedAt: nowIso(),
          scope,
          key: boardScopeKey(scope, params, ctx),
          status: normalizeBoardStatus("flow", readString(params, "status")),
          title,
          intent: clip(readString(params, "intent"), 120),
          keywords: boardKeywords(params),
          samples: boardSamples(params),
          slots: boardSlots(params),
          steps,
          instructions: clip(readString(params, "instructions") || readString(params, "content"), 1800),
          source: clip(readString(params, "source"), 240),
          note: clip(readString(params, "note"), 500),
          tags: normalizeTags(readArrayStrings(params, "tags"))
        };
        const validation = validateBoardFlow(item);
        if (!validation.ok) throw new Error(`invalid flow: ${validation.issues.join("; ")}`);
        await createBoardItem(config, item);
        return ok(BOT_BOARD_TOOL, ["created flow definition", formatBoardLine(item), validation.warnings.length ? `warnings: ${validation.warnings.join("; ")}` : ""], { action, item: publicBoardItem(item), validation });
      }
      if (action === "flow_update") {
        const item = findBoardItem(items, readString(params, "id"), "flow");
        if (!item) return { content: [{ type: "text", text: `BOT_BOARD no_match id=${readString(params, "id")}` }], details: { status: "no_match", id: readString(params, "id") } };
        const updated = await updateBoardItem(config, item, params);
        const validation = validateBoardFlow(updated);
        return ok(BOT_BOARD_TOOL, ["updated flow", formatBoardLine(updated), validation.ok ? "validation: ok" : `validation: ${validation.issues.join("; ")}`], { action, item: publicBoardItem(updated), validation });
      }
      if (action === "flow_get") {
        const item = findBoardItem(items, readString(params, "id"), "flow");
        if (!item) return { content: [{ type: "text", text: `BOT_BOARD no_match id=${readString(params, "id")}` }], details: { status: "no_match", id: readString(params, "id") } };
        const validation = validateBoardFlow(item);
        return ok(BOT_BOARD_TOOL, [
          formatBoardLine(item),
          item.samples?.length ? `samples: ${item.samples.join(" | ")}` : "",
          item.slots?.length ? `slots: ${item.slots.join(", ")}` : "",
          ...(item.steps || []).slice(0, 12).map((step, index) => `${index + 1}. ${clip(step.title || step.id || "", 80)} ${clip(step.text || "", 240)}`),
          validation.ok ? "validation: ok" : `validation: ${validation.issues.join("; ")}`
        ], { action, item: publicBoardItem(item), validation });
      }
      if (action === "flow_validate") {
        const existing = findBoardItem(items, readString(params, "id"), "flow");
        const draft = existing || {
          kind: "flow",
          title: clip(readString(params, "title"), 180),
          intent: clip(readString(params, "intent"), 120),
          keywords: boardKeywords(params),
          samples: boardSamples(params),
          slots: boardSlots(params),
          steps: boardSteps(params),
          instructions: clip(readString(params, "instructions") || readString(params, "content"), 1800)
        };
        const validation = validateBoardFlow(draft);
        return ok(BOT_BOARD_TOOL, [
          validation.ok ? "flow validation ok" : "flow validation has issues",
          ...validation.issues.map((issue) => `issue: ${issue}`),
          ...validation.warnings.map((warning) => `warning: ${warning}`)
        ], { action, validation, item: existing ? publicBoardItem(existing) : draft });
      }
      if (action === "flow_list") {
        const selected = filterBoardItems(items, params, ctx, "flow");
        return ok(BOT_BOARD_TOOL, [`results=${selected.length}`, ...selected.map(formatBoardLine)], { action, results: selected.map(publicBoardItem) });
      }
      if (action === "flow_match") {
        const text = readString(params, "text") || readString(params, "query");
        if (!text) throw new Error("flow_match requires text or query");
        const lowered = text.toLowerCase();
        const matched = items.filter((item) => item.kind === "flow" && item.status === "active")
          .map((item) => {
            const cues = [item.intent, ...(item.keywords || []), ...(item.samples || [])].filter(Boolean);
            const hits = cues.filter((cue) => lowered.includes(String(cue).toLowerCase()));
            return { item, hits };
          })
          .filter((entry) => entry.hits.length)
          .slice(0, readCount(params, DEFAULT_COUNT, 30));
        const lines = [`matches=${matched.length}`, ...matched.map((entry, index) => `${index + 1}. ${formatBoardLine(entry.item)} | hits=${entry.hits.join(", ")}`)];
        if (!matched.length) lines.push("No active flow definitions matched.");
        return ok(BOT_BOARD_TOOL, lines, { action, matches: matched.map((entry) => ({ ...publicBoardItem(entry.item), hits: entry.hits })) });
      }
      if (action === "preset_save") {
        const title = clip(readString(params, "title"), 180);
        const instructions = clip(readString(params, "instructions") || readString(params, "content") || readString(params, "response"), 1800);
        if (!title || !instructions) throw new Error("preset_save requires title and instructions/content");
        const scope = normalizeBoardScope(readString(params, "scope", "group"));
        const item = {
          type: "bot_board_item",
          kind: "preset",
          id: `preset_${hash(`${Date.now()}:${title}:${instructions}`, 14)}`,
          t: nowIso(),
          updatedAt: nowIso(),
          scope,
          key: boardScopeKey(scope, params, ctx),
          status: normalizeBoardStatus("preset", readString(params, "status")),
          title,
          trigger: clip(readString(params, "trigger"), 300),
          keywords: boardKeywords(params),
          instructions,
          source: clip(readString(params, "source"), 240),
          note: clip(readString(params, "note"), 500),
          tags: normalizeTags(readArrayStrings(params, "tags"))
        };
        await createBoardItem(config, item);
        return ok(BOT_BOARD_TOOL, ["saved chat preset", formatBoardLine(item)], { action, item: publicBoardItem(item) });
      }
      if (action === "preset_update") {
        const item = findBoardItem(items, readString(params, "id"), "preset");
        if (!item) return { content: [{ type: "text", text: `BOT_BOARD no_match id=${readString(params, "id")}` }], details: { status: "no_match", id: readString(params, "id") } };
        const updated = await updateBoardItem(config, item, params);
        return ok(BOT_BOARD_TOOL, ["updated preset", formatBoardLine(updated)], { action, item: publicBoardItem(updated) });
      }
      if (action === "preset_get") {
        const item = findBoardItem(items, readString(params, "id"), "preset");
        if (!item) return { content: [{ type: "text", text: `BOT_BOARD no_match id=${readString(params, "id")}` }], details: { status: "no_match", id: readString(params, "id") } };
        return ok(BOT_BOARD_TOOL, [
          formatBoardLine(item),
          item.trigger ? `trigger: ${clip(item.trigger, 300)}` : "",
          item.instructions ? `instructions: ${clip(item.instructions, 1000)}` : "",
          item.source ? `source: ${clip(item.source, 240)}` : ""
        ], { action, item: publicBoardItem(item) });
      }
      if (action === "preset_list") {
        const selected = filterBoardItems(items, params, ctx, "preset");
        return ok(BOT_BOARD_TOOL, [`results=${selected.length}`, ...selected.map(formatBoardLine)], { action, results: selected.map(publicBoardItem) });
      }
      if (action === "preset_match") {
        const text = readString(params, "text") || readString(params, "query");
        if (!text) throw new Error("preset_match requires text or query");
        const lowered = text.toLowerCase();
        const matched = items.filter((item) => item.kind === "preset" && item.status === "active")
          .map((item) => {
            const cues = [item.title, item.trigger, ...(item.keywords || [])].filter(Boolean);
            const hits = cues.filter((cue) => lowered.includes(String(cue).toLowerCase()));
            return { item, hits };
          })
          .filter((entry) => entry.hits.length)
          .slice(0, readCount(params, DEFAULT_COUNT, 30));
        const lines = [`matches=${matched.length}`, ...matched.map((entry, index) => `${index + 1}. ${formatBoardLine(entry.item)} | hits=${entry.hits.join(", ")}`)];
        if (!matched.length) lines.push("No active chat presets matched.");
        return ok(BOT_BOARD_TOOL, lines, { action, matches: matched.map((entry) => ({ ...publicBoardItem(entry.item), hits: entry.hits })) });
      }
      throw new Error("unknown action");
    } catch (error) {
      return fail(BOT_BOARD_TOOL, error);
    }
  }
};

function parseRepo(value) {
  const text = String(value || "").trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/+$/g, "");
  const parts = text.split("/");
  if (parts.length < 2) throw new Error("repo must look like owner/name");
  const owner = parts[0];
  const repo = parts[1];
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw new Error("invalid GitHub repo owner/name");
  return { owner, repo };
}

function githubCount(params) {
  return readNumber(params, "count", 5, 1, 10);
}

async function fetchJson(url, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("GitHub request timed out")), GITHUB_TIMEOUT_MS);
  const abortParent = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abortParent();
    else signal.addEventListener("abort", abortParent, { once: true });
  }
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/vnd.github+json",
        "user-agent": USER_AGENT
      }
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    if (!response.ok) {
      const message = parsed?.message || response.statusText || `HTTP ${response.status}`;
      throw new Error(`GitHub API ${response.status}: ${message}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortParent);
  }
}

function repoUrl(owner, repo, suffix = "") {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

function formatRepoInfo(repo) {
  return [
    `repo: ${repo.full_name}`,
    `description: ${clip(repo.description || "", 240)}`,
    `stars: ${repo.stargazers_count ?? 0} | forks: ${repo.forks_count ?? 0} | open_issues: ${repo.open_issues_count ?? 0}`,
    `language: ${repo.language || "unknown"} | license: ${repo.license?.spdx_id || "unknown"}`,
    `updated: ${repo.updated_at || ""}`,
    `url: ${repo.html_url || ""}`
  ].filter(Boolean).join("\n");
}

function formatRelease(release, index) {
  return `${index + 1}. ${release.tag_name || release.name || "release"} | ${release.published_at || release.created_at || ""} | prerelease=${release.prerelease === true} | ${release.html_url || ""}`;
}

function formatIssue(issue, index) {
  const type = issue.pull_request ? "PR" : "issue";
  return `${index + 1}. ${type} #${issue.number} ${clip(issue.title, 140)} | state=${issue.state} | updated=${issue.updated_at || ""} | ${issue.html_url || ""}`;
}

const githubLookupTool = {
  name: GITHUB_LOOKUP_TOOL,
  label: "GitHub Lookup",
  description: "Read public GitHub repository metadata, releases, issues, pulls, or repository search results. No private account access.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["repo", "releases", "issues", "pulls", "search_repos"], description: "GitHub lookup operation." },
      repo: { type: "string", description: "owner/name or GitHub URL for repo actions." },
      query: { type: "string", description: "Repository search query." },
      state: { type: "string", enum: ["open", "closed", "all"], description: "Issue/PR state. Default open." },
      count: { type: "number", description: "Count 1-10. Default 5." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params, signal) {
    try {
      const action = readString(params, "action").toLowerCase();
      const count = githubCount(params);
      if (action === "search_repos") {
        const query = readString(params, "query");
        if (!query) throw new Error("query is required for search_repos");
        const data = await fetchJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${count}`, signal);
        const items = Array.isArray(data?.items) ? data.items : [];
        const lines = [`results=${items.length}`, ...items.map((repo, index) => `${index + 1}. ${repo.full_name} | stars=${repo.stargazers_count ?? 0} | ${clip(repo.description || "", 160)} | ${repo.html_url || ""}`)];
        return ok(GITHUB_LOOKUP_TOOL, lines, { action, results: items });
      }
      const { owner, repo } = parseRepo(readString(params, "repo"));
      if (action === "repo") {
        const data = await fetchJson(repoUrl(owner, repo), signal);
        return ok(GITHUB_LOOKUP_TOOL, [formatRepoInfo(data)], { action, repo: data });
      }
      if (action === "releases") {
        const data = await fetchJson(repoUrl(owner, repo, `/releases?per_page=${count}`), signal);
        const releases = Array.isArray(data) ? data : [];
        return ok(GITHUB_LOOKUP_TOOL, [`results=${releases.length}`, ...releases.map(formatRelease)], { action, releases });
      }
      if (action === "issues") {
        const state = readString(params, "state", "open");
        const data = await fetchJson(repoUrl(owner, repo, `/issues?state=${encodeURIComponent(state)}&per_page=${count}`), signal);
        const issues = (Array.isArray(data) ? data : []).filter((issue) => !issue.pull_request);
        return ok(GITHUB_LOOKUP_TOOL, [`results=${issues.length}`, ...issues.map(formatIssue)], { action, issues });
      }
      if (action === "pulls") {
        const state = readString(params, "state", "open");
        const data = await fetchJson(repoUrl(owner, repo, `/pulls?state=${encodeURIComponent(state)}&per_page=${count}`), signal);
        const pulls = Array.isArray(data) ? data : [];
        return ok(GITHUB_LOOKUP_TOOL, [`results=${pulls.length}`, ...pulls.map(formatIssue)], { action, pulls });
      }
      throw new Error("unknown action");
    } catch (error) {
      return fail(GITHUB_LOOKUP_TOOL, error);
    }
  }
};

function parseCsv(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/\r\n/g, "\n");
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (quoted) {
      if (ch === "\"" && next === "\"") {
        cell += "\"";
        i++;
      } else if (ch === "\"") {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === "\"") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((value) => value !== "") || rows.length === 0) rows.push(row);
  return rows.filter((entry) => entry.some((value) => String(value).trim() !== ""));
}

function numberValues(params) {
  const raw = isRecord(params) ? params.values : undefined;
  if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
  return String(readString(params, "text") || readString(params, "input") || "")
    .match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number).filter(Number.isFinite) || [];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) throw new Error("no numeric values found");
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const mean = sum / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variance = sorted.reduce((acc, value) => acc + (value - mean) ** 2, 0) / n;
  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    sum,
    mean,
    median,
    stdev: Math.sqrt(variance)
  };
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "NaN";
  if (Math.abs(value) >= 1000 || Math.abs(value) < 0.001 && value !== 0) return value.toExponential(4);
  return Number(value.toFixed(6)).toString();
}

function csvSummary(text, delimiter) {
  const rows = parseCsv(text, delimiter);
  if (!rows.length) throw new Error("empty table");
  const header = rows[0].map((cell, index) => cell.trim() || `col_${index + 1}`);
  const body = rows.slice(1);
  const columns = header.map((name, index) => {
    const values = body.map((row) => row[index] ?? "");
    const numeric = values.map((value) => Number(String(value).trim())).filter(Number.isFinite);
    return {
      name,
      nonEmpty: values.filter((value) => String(value).trim()).length,
      numeric: numeric.length,
      unique: new Set(values.map((value) => String(value).trim())).size,
      stats: numeric.length ? stats(numeric) : null
    };
  });
  return { rows: body.length, columns };
}

function markdownTable(rows, maxRows = 12) {
  if (!rows.length) return "";
  const header = rows[0];
  const body = rows.slice(1, maxRows + 1);
  const esc = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
  return [
    `| ${header.map(esc).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${header.map((_, index) => esc(row[index] ?? "")).join(" | ")} |`)
  ].join("\n");
}

function histogram(values, bins) {
  const s = stats(values);
  if (s.min === s.max) return [`${formatNumber(s.min)}: ${values.length}`];
  const width = (s.max - s.min) / bins;
  const counts = Array.from({ length: bins }, () => 0);
  for (const value of values) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor((value - s.min) / width)));
    counts[index] += 1;
  }
  const maxCount = Math.max(...counts, 1);
  return counts.map((count, index) => {
    const left = s.min + index * width;
    const right = index === bins - 1 ? s.max : left + width;
    const bar = "#".repeat(Math.max(1, Math.round(count / maxCount * 24)));
    return `${formatNumber(left)}..${formatNumber(right)} | ${bar} ${count}`;
  });
}

function readTextInput(params) {
  return clip(readString(params, "text") || readString(params, "csv") || readString(params, "input"), MAX_TEXT);
}

const dataTool = {
  name: DATA_TOOL,
  label: "Data Tool",
  description: "Safe text/table utilities: CSV summary, Markdown table, number stats, histogram, and simple group counts. No code execution.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["csv_summary", "table_markdown", "numbers_summary", "histogram", "group_count"], description: "Data operation." },
      text: { type: "string", description: "Input text/CSV/numbers." },
      csv: { type: "string", description: "Alias for text." },
      input: { type: "string", description: "Alias for text." },
      values: { type: "array", items: { type: "number" }, description: "Numeric values for numbers_summary/histogram." },
      delimiter: { type: "string", description: "CSV delimiter, default comma." },
      column: { type: "string", description: "Column name for group_count." },
      bins: { type: "number", description: "Histogram bins, 2-30. Default 8." },
      maxRows: { type: "number", description: "Max Markdown rows, 1-30. Default 12." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params) {
    try {
      const action = readString(params, "action").toLowerCase();
      const delimiter = (readString(params, "delimiter", ",") || ",")[0];
      if (action === "numbers_summary") {
        const result = stats(numberValues(params));
        const lines = Object.entries(result).map(([key, value]) => `${key}: ${formatNumber(value)}`);
        return ok(DATA_TOOL, lines, { action, result });
      }
      if (action === "histogram") {
        const bins = readNumber(params, "bins", 8, 2, 30);
        const lines = histogram(numberValues(params), bins);
        return ok(DATA_TOOL, lines, { action, bins });
      }
      const text = readTextInput(params);
      if (!text) throw new Error("text/csv/input is required");
      if (action === "csv_summary") {
        const result = csvSummary(text, delimiter);
        const lines = [
          `rows: ${result.rows}`,
          `columns: ${result.columns.length}`,
          ...result.columns.slice(0, 20).map((col) => `${col.name}: nonEmpty=${col.nonEmpty} unique=${col.unique} numeric=${col.numeric}${col.stats ? ` mean=${formatNumber(col.stats.mean)} min=${formatNumber(col.stats.min)} max=${formatNumber(col.stats.max)}` : ""}`)
        ];
        return ok(DATA_TOOL, lines, { action, result });
      }
      if (action === "table_markdown") {
        const rows = parseCsv(text, delimiter);
        const table = markdownTable(rows, readNumber(params, "maxRows", 12, 1, 30));
        return ok(DATA_TOOL, [table], { action, table });
      }
      if (action === "group_count") {
        const rows = parseCsv(text, delimiter);
        const header = rows[0]?.map((cell) => cell.trim()) || [];
        const column = readString(params, "column");
        const index = header.findIndex((name) => name.toLowerCase() === column.toLowerCase());
        if (index < 0) throw new Error("column not found");
        const counts = new Map();
        for (const row of rows.slice(1)) {
          const key = String(row[index] ?? "").trim() || "(blank)";
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
        return ok(DATA_TOOL, entries.map(([key, count]) => `${key}: ${count}`), { action, counts: Object.fromEntries(entries) });
      }
      throw new Error("unknown action");
    } catch (error) {
      return fail(DATA_TOOL, error);
    }
  }
};

export const __testing = {
  sanitizeText,
  extractTerms,
  parseRepo,
  parseCsv,
  stats,
  histogram,
  loadPersonaCatalog,
  loadPersonaState,
  loadWindowStore,
  findPersona,
  readPersonaProfile,
  formatPersonaPrompt,
  loadSkillState,
  loadToolEvents,
  loadEvidenceState,
  loadBotBoardState,
  getActiveModesForContext,
  skillFilesRoot,
  allowedSkillMediaRoots,
  jsonCacheStats: () => ({ entries: jsonFileCache.size }),
  clearJsonCache: () => jsonFileCache.clear(),
  personaFileCacheStats: () => ({
    entries: personaFileCache.size,
    hits: personaFileCacheCounters.hits,
    misses: personaFileCacheCounters.misses
  }),
  clearPersonaFileCache: () => {
    personaFileCache.clear();
    personaFileCacheCounters.hits = 0;
    personaFileCacheCounters.misses = 0;
  }
};

export default {
  id: "imagebot-agent-ops",
  name: "Imagebot Agent Ops",
  description: "Task modes, persona profile selection, saved learned workflows, failure memory, evidence packs, bot board notes, public GitHub lookup, and data utilities.",
  register(api) {
    const config = api.config || {};
    agentModeTool.config = config;
    personaConfigTool.config = config;
    learnedSkillTool.config = config;
    failureMemoryTool.config = config;
    evidencePackTool.config = config;
    botBoardTool.config = config;
    githubLookupTool.config = config;
    dataTool.config = config;

    api.registerTool(agentModeTool, { name: AGENT_MODE_TOOL });
    api.registerTool(personaConfigTool, { name: PERSONA_CONFIG_TOOL });
    api.registerTool(learnedSkillTool, { name: LEARNED_SKILL_TOOL });
    api.registerTool(failureMemoryTool, { name: FAILURE_MEMORY_TOOL });
    api.registerTool(evidencePackTool, { name: EVIDENCE_PACK_TOOL });
    api.registerTool(botBoardTool, { name: BOT_BOARD_TOOL });
    api.registerTool(githubLookupTool, { name: GITHUB_LOOKUP_TOOL });
    api.registerTool(dataTool, { name: DATA_TOOL });

    registerLifecycleHook(api, "before_prompt_build", async (event, ctx) => {
      if (ctx?.agentId && ctx.agentId !== "imagebot") return;
      const systemChunks = [];
      const contextChunks = [];
      const [personaContext, modeContext, skillContext] = await Promise.all([
        config.appendPersonaContext !== false ? formatActivePersonaPrompt(config, event, ctx) : "",
        config.appendModeContext !== false
          ? getActiveModesForContext(config, event, ctx).then((modes) => formatModePrompt(modes))
          : "",
        config.appendRelevantSkills !== false
          ? relevantApprovedSkills(config, String(event?.prompt || ""), 3).then((skills) => formatSkillsForPrompt(skills))
          : ""
      ]);
      if (personaContext) systemChunks.push(personaContext);
      if (modeContext) contextChunks.push(modeContext);
      if (skillContext) contextChunks.push(skillContext);
      const result = {
        prependSystemContext: systemChunks.length ? systemChunks.join("\n\n") : undefined,
        prependContext: contextChunks.length ? contextChunks.join("\n\n") : undefined
      };
      await recordPersonaHookDebug(config, event, ctx, result).catch(() => {});
      if (!systemChunks.length && !contextChunks.length) return undefined;
      return result;
    }, { name: "imagebot-agent-ops-before-prompt-build" });

    registerLifecycleHook(api, "before_tool_call", async (event, ctx) => {
      if (ctx?.agentId && ctx.agentId !== "imagebot") return;
      const toolName = String(event?.toolName || "");
      if (!toolName || toolName === FAILURE_MEMORY_TOOL) return;
      pendingToolCalls.set(toolEventKey(event, ctx), {
        startedAt: Date.now(),
        toolName,
        sessionKey: String(ctx?.sessionKey || event?.sessionKey || ""),
        runId: String(ctx?.runId || event?.runId || ""),
        paramsSummary: summarizeParams(event?.params)
      });
    }, { name: "imagebot-agent-ops-before-tool-call" });

    registerLifecycleHook(api, "after_tool_call", async (event, ctx) => {
      if (ctx?.agentId && ctx.agentId !== "imagebot") return;
      const key = toolEventKey(event, ctx);
      const pending = pendingToolCalls.get(key);
      pendingToolCalls.delete(key);
      await recordToolEvent(config, event, ctx, pending);
    }, { name: "imagebot-agent-ops-after-tool-call" });
  }
};

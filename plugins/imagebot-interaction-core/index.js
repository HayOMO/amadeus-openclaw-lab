import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { registerLifecycleHook } from "../imagebot-shared/openclaw-lifecycle-hooks.mjs";

const TOOL_NAME = "interaction_pipeline";
const MARS_FORWARD_LOOKUP_TOOL = "mars_forward_lookup";
const MAX_TEXT = 5000;

const DEFAULT_TRIGGER_PREFIXES = [
  "助手",
  "amadeus",
  "amaduse",
  "makise kurisu",
  "makise",
  "kurisu",
  "牧濑",
  "红莉栖",
  "红莉西"
];

const CONTROL_COMMANDS = [
  "/amnew",
  "/amhelp",
  "/amstatus",
  "/amdeepstatus",
  "/ammodel",
  "/amtools",
  "/ambackup",
  "/amarchive"
];

const PIPELINE_VERSION = "middleware-v2";
const RATE_EVENTS = new Map();

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

function readNumber(params, key, fallback, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const value = isRecord(params) ? params[key] : undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function readArrayStrings(params, key) {
  const value = isRecord(params) ? params[key] : undefined;
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function readObject(params, key) {
  const value = isRecord(params) ? params[key] : undefined;
  return isRecord(value) ? value : {};
}

function configArray(config, key, fallback) {
  const value = Array.isArray(config?.[key]) ? config[key] : fallback;
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function configObject(config, key, fallback = {}) {
  return isRecord(config?.[key]) ? config[key] : fallback;
}

function hash(value, len = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function clip(value, max = 600) {
  const text = String(value ?? "")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[telegram-token-redacted]")
    .replace(/[A-Za-z]:\\[^\s<>"']+/g, "[local-path-redacted]")
    .replace(/\r\n/g, "\n")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function normalizedUserId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("tg:") ? raw : `tg:${raw}`;
}

function normalizedAllowSet(values) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizedUserId(value) || String(value || "").trim().toLowerCase())
    .filter(Boolean));
}

function stage(name, status, detail = {}) {
  return { name, status, ...detail };
}

function normalizedBotName(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function stripBotMention(text, botNames) {
  let remaining = String(text || "").trim();
  let matched = "";
  for (const botName of botNames) {
    if (!botName) continue;
    const pattern = new RegExp(`^@${botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(remaining)) {
      matched = botName;
      remaining = remaining.replace(pattern, "").trim();
      break;
    }
  }
  return { matched, text: remaining };
}

function parseCommand(text, botNames) {
  const source = String(text || "").trim();
  const match = source.match(/^\/([a-z][a-z0-9_]*)(?:@([A-Za-z0-9_]+))?(?=\s|$)/i);
  if (!match) return { command: "", addressedToBot: false, text: source };
  const command = `/${match[1].toLowerCase()}`;
  const target = normalizedBotName(match[2] || "");
  const addressedToBot = !target || botNames.includes(target);
  return {
    command,
    target,
    addressedToBot,
    text: source.slice(match[0].length).trim()
  };
}

function stripTriggerPrefix(text, prefixes) {
  const source = String(text || "").trim();
  const lowered = source.toLowerCase();
  const sorted = [...prefixes].sort((a, b) => b.length - a.length);
  for (const prefix of sorted) {
    const normalized = String(prefix || "").trim();
    if (!normalized) continue;
    const lowerPrefix = normalized.toLowerCase();
    if (lowered === lowerPrefix) return { matched: normalized, text: "" };
    if (lowered.startsWith(`${lowerPrefix} `)) return { matched: normalized, text: source.slice(normalized.length).trim() };
    if (/[\u4e00-\u9fff]/.test(normalized) && lowered.startsWith(lowerPrefix)) {
      return { matched: normalized, text: source.slice(normalized.length).trim() };
    }
  }
  return { matched: "", text: source };
}

function readIdentity(params) {
  const user = isRecord(params.user) ? params.user : {};
  const chat = isRecord(params.chat) ? params.chat : {};
  const userId = normalizedUserId(readString(params, "userId") || readString(user, "id") || readString(user, "userId"));
  const chatId = readString(params, "chatId") || readString(chat, "id") || readString(chat, "chatId");
  const userName = readString(params, "userName") || readString(user, "username") || readString(user, "userName");
  const displayName = readString(params, "displayName") || readString(user, "displayName") || readString(user, "name") || userName || userId;
  return {
    userId,
    userName,
    displayName,
    chatId,
    chatTitle: readString(params, "chatTitle") || readString(chat, "title") || readString(chat, "name"),
    identityKey: userId || (userName ? `name:${userName.toLowerCase()}` : ""),
    publicLabel: displayName || userName || userId || "unknown"
  };
}

function rateLimitOptions(config, params) {
  const raw = { ...configObject(config, "rateLimit"), ...readObject(params, "rateLimit") };
  return {
    enabled: readBoolean(raw, "enabled", false),
    enforce: readBoolean(params, "enforceRateLimit", readBoolean(raw, "enforce", false)),
    record: readBoolean(params, "recordRateLimit", readBoolean(raw, "record", false)),
    windowMs: readNumber(raw, "windowMs", 10_000, 1_000, 24 * 60 * 60 * 1000),
    maxPerUser: Math.trunc(readNumber(raw, "maxPerUser", 6, 1, 1000)),
    maxPerChat: Math.trunc(readNumber(raw, "maxPerChat", 30, 1, 10000))
  };
}

function checkRateLimit(config, params, identity) {
  const options = rateLimitOptions(config, params);
  if (!options.enabled) return { skipped: true, reason: "disabled", options };
  const now = Date.now();
  const cutoff = now - options.windowMs;
  for (const [key, timestamps] of RATE_EVENTS.entries()) {
    const kept = timestamps.filter((t) => t >= cutoff);
    if (kept.length) RATE_EVENTS.set(key, kept);
    else RATE_EVENTS.delete(key);
  }
  const userKey = `user:${identity.userId || identity.identityKey || "unknown"}`;
  const chatKey = `chat:${identity.chatId || "unknown"}`;
  const userEvents = RATE_EVENTS.get(userKey) || [];
  const chatEvents = RATE_EVENTS.get(chatKey) || [];
  const allowed = userEvents.length < options.maxPerUser && chatEvents.length < options.maxPerChat;
  if (options.record) {
    RATE_EVENTS.set(userKey, [...userEvents, now]);
    RATE_EVENTS.set(chatKey, [...chatEvents, now]);
  }
  return {
    skipped: false,
    allowed,
    userCount: userEvents.length,
    chatCount: chatEvents.length,
    options: {
      windowMs: options.windowMs,
      maxPerUser: options.maxPerUser,
      maxPerChat: options.maxPerChat,
      enforce: options.enforce,
      record: options.record
    }
  };
}

function permissionDecision(config, params, identity) {
  const allowFrom = [
    ...configArray(config, "allowFrom", []),
    ...configArray(config, "senderAllowlist", []),
    ...readArrayStrings(params, "allowFrom")
  ];
  if (!allowFrom.length) return { configured: false, allowed: true };
  const allowed = normalizedAllowSet(allowFrom);
  const keys = [
    identity.userId,
    identity.identityKey,
    identity.userName ? String(identity.userName).toLowerCase() : ""
  ].filter(Boolean);
  return {
    configured: true,
    allowed: keys.some((key) => allowed.has(normalizedUserId(key)) || allowed.has(String(key).toLowerCase())),
    keys
  };
}

function sessionRecommendation(params, identity, reason) {
  const replySessionKey = readString(params, "replySessionKey");
  if (reason === "new_window") {
    return {
      mode: "new_window",
      key: `tg:${identity.chatId || "chat"}:user:${identity.userId || "unknown"}:new:${hash(`${Date.now()}:${Math.random()}`)}`,
      note: "Open a fresh model window for this sender."
    };
  }
  if (readBoolean(params, "isReplyToBot") && replySessionKey) {
    return {
      mode: "reply_window",
      key: replySessionKey,
      note: "Use the replied bot message's existing window, even if the current sender is different."
    };
  }
  return {
    mode: "sender_window",
    key: `tg:${identity.chatId || "chat"}:user:${identity.userId || identity.userName || "unknown"}`,
    note: "Use the sender's own window. Ignore activeSessionKey unless this message replies to a bot message with replySessionKey."
  };
}

function evaluateMessage(config, params) {
  const identity = readIdentity(params);
  const botNames = [
    ...configArray(config, "botUsernames", []),
    ...readArrayStrings(params, "botUsernames"),
    readString(params, "botUsername")
  ].map(normalizedBotName).filter(Boolean);
  const prefixes = [
    ...DEFAULT_TRIGGER_PREFIXES,
    ...configArray(config, "triggerPrefixes", []),
    ...readArrayStrings(params, "triggerPrefixes")
  ].filter(Boolean);
  const originalText = readString(params, "text") || readString(params, "message");
  const isPrivate = readBoolean(params, "isPrivate", false);
  const isGroup = readBoolean(params, "isGroup", !isPrivate);
  const isReplyToBot = readBoolean(params, "isReplyToBot", false) || readBoolean(params, "replyToBot", false);
  const explicitMention = readBoolean(params, "mentionsBot", false) || readBoolean(params, "mentionedBot", false);
  const hasMedia = readBoolean(params, "hasMedia", false);
  const command = parseCommand(originalText, botNames);
  const mention = stripBotMention(command.text, botNames);
  const prefix = stripTriggerPrefix(mention.text, prefixes);
  const stages = [];
  const pipeline = [];
  let shouldRespond = false;
  let reason = "ignored";
  let normalizedText = originalText.trim();

  stages.push({ stage: "identity", userId: identity.userId, chatId: identity.chatId });
  pipeline.push(stage("receive", "ok", { chatType: isPrivate ? "private" : "group", hasText: Boolean(originalText.trim()), hasMedia }));
  pipeline.push(stage("identity", identity.userId || identity.identityKey ? "ok" : "missing", {
    userId: identity.userId,
    chatId: identity.chatId,
    displayName: identity.publicLabel
  }));

  if (command.command) {
    stages.push({ stage: "command", command: command.command, target: command.target || "", addressedToBot: command.addressedToBot });
    pipeline.push(stage("command", command.addressedToBot ? "matched" : "ignored", {
      command: command.command,
      target: command.target || "",
      addressedToBot: command.addressedToBot
    }));
    if (command.addressedToBot && CONTROL_COMMANDS.includes(command.command)) {
      shouldRespond = true;
      reason = command.command === "/amnew" ? "new_window" : "control_command";
      normalizedText = command.text;
    } else if (command.addressedToBot && command.command === "/start") {
      shouldRespond = true;
      reason = "control_command";
      normalizedText = command.text;
    }
  } else {
    pipeline.push(stage("command", "skipped"));
  }

  if (!shouldRespond && isPrivate) {
    shouldRespond = true;
    reason = "private_chat";
    normalizedText = command.command ? command.text : originalText.trim();
  }
  pipeline.push(stage("private_policy", isPrivate ? "matched" : "skipped"));

  if (!shouldRespond && isReplyToBot) {
    shouldRespond = true;
    reason = "reply_to_bot";
    normalizedText = command.command ? command.text : originalText.trim();
  }
  pipeline.push(stage("reply_to_bot", isReplyToBot ? "matched" : "skipped", {
    hasReplySessionKey: Boolean(readString(params, "replySessionKey"))
  }));

  if (!shouldRespond && (explicitMention || mention.matched)) {
    shouldRespond = true;
    reason = "bot_mention";
    normalizedText = mention.text;
    stages.push({ stage: "mention", matched: explicitMention ? "(runtime)" : mention.matched });
  }
  pipeline.push(stage("mention", explicitMention || mention.matched ? "matched" : "skipped", {
    matched: explicitMention ? "(runtime)" : mention.matched
  }));

  if (!shouldRespond && prefix.matched) {
    shouldRespond = true;
    reason = "trigger_prefix";
    normalizedText = prefix.text;
    stages.push({ stage: "prefix", matched: prefix.matched });
  }
  pipeline.push(stage("trigger_prefix", prefix.matched ? "matched" : "skipped", {
    matched: prefix.matched
  }));

  if (!shouldRespond && hasMedia && isReplyToBot) {
    shouldRespond = true;
    reason = "reply_media";
  }
  pipeline.push(stage("media", hasMedia ? (isReplyToBot ? "matched" : "seen_not_triggering") : "skipped"));

  const permission = permissionDecision(config, params, identity);
  if (permission.configured && !permission.allowed) {
    shouldRespond = false;
    reason = "sender_not_allowed";
  }
  pipeline.push(stage("permission", permission.configured ? (permission.allowed ? "allowed" : "blocked") : "not_configured"));

  const rateLimit = checkRateLimit(config, params, identity);
  if (!rateLimit.skipped && !rateLimit.allowed && rateLimit.options.enforce) {
    shouldRespond = false;
    reason = "rate_limited";
  }
  pipeline.push(stage("rate_limit", rateLimit.skipped ? "not_configured" : (rateLimit.allowed ? "allowed" : "limited"), rateLimit.skipped ? {} : {
    userCount: rateLimit.userCount,
    chatCount: rateLimit.chatCount,
    windowMs: rateLimit.options.windowMs,
    enforce: rateLimit.options.enforce,
    record: rateLimit.options.record
  }));

  const window = sessionRecommendation(params, identity, reason);
  pipeline.push(stage("window_route", window.mode, { key: window.key, note: window.note }));
  pipeline.push(stage("decision", shouldRespond ? "respond" : "ignore", { reason }));
  return {
    version: PIPELINE_VERSION,
    shouldRespond,
    reason,
    isGroup,
    isPrivate,
    isReplyToBot,
    command: command.command,
    normalizedText: clip(normalizedText, 1200),
    identity,
    window,
    stages,
    pipeline,
    permission,
    rateLimit,
    policy: {
      respondOnlyWhenTriggeredInGroups: true,
      groupTriggers: ["control_command", "reply_to_bot", "bot_mention", "trigger_prefix"],
      defaultIgnoredReason: "No command, mention, reply-to-bot, or configured prefix."
    }
  };
}

function ok(lines, details = {}) {
  return {
    content: [{ type: "text", text: ["INTERACTION_PIPELINE", ...lines].filter(Boolean).join("\n").slice(0, MAX_TEXT) }],
    details: { status: "ok", ...details }
  };
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `INTERACTION_PIPELINE error: ${clip(message, 500)}` }],
    details: { status: "failed", error: message }
  };
}

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function marsConfig(config = {}) {
  return configObject(config, "marsForwardDetector", {});
}

function marsStatePath(config = {}) {
  const configured = readString(marsConfig(config), "statePath");
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "imagebot", "mars-forward-detector.json"));
}

function marsSqlitePath(config = {}) {
  const detector = marsConfig(config);
  const configured = readString(detector, "sqlitePath");
  if (configured) return path.resolve(configured);
  return marsStatePath(config).replace(/\.json$/i, ".sqlite");
}

function marsTokenFile(config = {}) {
  const detector = marsConfig(config);
  const configured = readString(detector, "tokenFile") || readString(config, "tokenFile");
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "secrets", "telegram-imagebot.token"));
}

async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeChatId(value) {
  const text = String(value ?? "").trim();
  return text || "";
}

function normalizeMessageId(value) {
  const text = String(value ?? "").trim();
  return text || "";
}

function scopeMatches(scopeKey, chatId, threadId = "") {
  if (!chatId) return true;
  const base = String(scopeKey || "").split(":topic:")[0];
  if (base !== chatId) return false;
  if (!threadId) return true;
  const scope = String(scopeKey || "");
  return scope === `${chatId}:topic:${threadId}` || scope === chatId;
}

function recordLastSeen(record) {
  return Number(record?.lastSeenAt ?? record?.last?.timestampMs ?? record?.first?.timestampMs ?? 0);
}

function marsMessageLink(snapshot = {}) {
  const chatId = normalizeChatId(snapshot.chatId);
  const messageId = normalizeMessageId(snapshot.messageId);
  if (!chatId || !messageId) return "";
  if (chatId.startsWith("-100")) return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
  return "";
}

function publicMarsSnapshot(snapshot = {}) {
  return {
    chatId: normalizeChatId(snapshot.chatId),
    threadId: normalizeMessageId(snapshot.threadId),
    messageId: normalizeMessageId(snapshot.messageId),
    timestamp: snapshot.timestamp || "",
    senderId: snapshot.senderId || "",
    senderUsername: snapshot.senderUsername || "",
    senderName: snapshot.senderName || "",
    preview: snapshot.preview || "",
    link: marsMessageLink(snapshot),
    media: Array.isArray(snapshot.media) ? snapshot.media.map((item) => ({
      kind: item?.kind || "",
      fileUniqueId: item?.fileUniqueId || "",
      fileId: item?.fileId || "",
      localPath: item?.localPath || "",
      cacheStatus: item?.cacheStatus || "",
      cacheError: item?.cacheError || "",
      cachedAt: item?.cachedAt || "",
      visualHashStatus: item?.visualHashStatus || "",
      visualHash: item?.visualHash ? {
        algorithm: item.visualHash.algorithm || "",
        ahash: item.visualHash.ahash || "",
        dhash: item.visualHash.dhash || "",
        phash: item.visualHash.phash || ""
      } : undefined,
      mimeType: item?.mimeType || "",
      fileName: item?.fileName || "",
      fileSize: item?.fileSize || undefined,
      width: item?.width || undefined,
      height: item?.height || undefined
    })).slice(0, 5) : [],
    match: isRecord(snapshot.match) ? {
      kind: snapshot.match.kind || "",
      confidence: snapshot.match.confidence || "",
      key: snapshot.match.key || "",
      keys: Array.isArray(snapshot.match.keys) ? snapshot.match.keys.slice(0, 12) : [],
      urls: Array.isArray(snapshot.match.urls) ? snapshot.match.urls.slice(0, 5) : [],
      mediaIds: Array.isArray(snapshot.match.mediaIds) ? snapshot.match.mediaIds.slice(0, 5) : []
    } : undefined,
    source: isRecord(snapshot.source) ? {
      from: snapshot.source.from || "",
      fromType: snapshot.source.fromType || "",
      fromId: snapshot.source.fromId || "",
      fromUsername: snapshot.source.fromUsername || "",
      fromTitle: snapshot.source.fromTitle || "",
      fromMessageId: snapshot.source.fromMessageId || ""
    } : undefined
  };
}

function publicMarsRecord(record = {}) {
  return {
    key: record.key || record.matchKey || record.first?.match?.key || record.last?.match?.key || "",
    matchKeys: Array.isArray(record.matchKeys) ? record.matchKeys.slice(0, 32) : [],
    hitCount: Number(record.hitCount || 0),
    lastSeenAt: recordLastSeen(record),
    first: publicMarsSnapshot(record.first || {}),
    last: record.last ? publicMarsSnapshot(record.last) : undefined
  };
}

function loadMarsSqliteRecords(config = {}) {
  const filePath = marsSqlitePath(config);
  if (!fsSync.existsSync(filePath)) return null;
  let db = null;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
    const rows = db.prepare(`
      SELECT
        scope_key AS scopeKey,
        record_key AS recordKey,
        record_json AS recordJson,
        MAX(last_seen_at) AS lastSeenAt
      FROM mars_forward_records
      GROUP BY scope_key, record_key
      ORDER BY lastSeenAt DESC
    `).all();
    const records = [];
    for (const row of rows) {
      try {
        const record = JSON.parse(row.recordJson || "{}");
        if (!isRecord(record) || !isRecord(record.first)) continue;
        records.push({
          ...record,
          key: record.key || record.matchKey || record.first?.match?.key || row.recordKey || "",
          scopeKey: row.scopeKey || ""
        });
      } catch {
        // Skip corrupt rows; the JSON fallback below handles legacy state.
      }
    }
    records.sort((left, right) => recordLastSeen(right) - recordLastSeen(left));
    return records;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Read-only lookup should never make tool execution fail on close.
    }
  }
}

async function loadMarsRecords(config = {}) {
  const sqliteRecords = loadMarsSqliteRecords(config);
  if (sqliteRecords) return sqliteRecords;
  const store = await readJsonFile(marsStatePath(config), { schema: 1, scopes: {} });
  const records = [];
  const scopes = isRecord(store?.scopes) ? store.scopes : {};
  for (const [scopeKey, scope] of Object.entries(scopes)) {
    if (!isRecord(scope)) continue;
    for (const [key, record] of Object.entries(scope)) {
      if (!isRecord(record) || !isRecord(record.first)) continue;
      records.push({ ...record, key, scopeKey });
    }
  }
  records.sort((left, right) => recordLastSeen(right) - recordLastSeen(left));
  return records;
}

function marsHaystack(record = {}) {
  return [
    record.key,
    record.scopeKey,
    record.first?.preview,
    record.last?.preview,
    record.first?.senderName,
    record.last?.senderName,
    record.first?.senderUsername,
    record.last?.senderUsername,
    record.first?.source?.from,
    record.first?.source?.fromTitle,
    record.first?.source?.fromUsername,
    ...(Array.isArray(record.matchKeys) ? record.matchKeys : []),
    ...(Array.isArray(record.first?.match?.keys) ? record.first.match.keys : []),
    ...(Array.isArray(record.first?.match?.urls) ? record.first.match.urls : []),
    ...(Array.isArray(record.last?.match?.urls) ? record.last.match.urls : []),
    ...(Array.isArray(record.first?.match?.mediaIds) ? record.first.match.mediaIds : []),
    ...(Array.isArray(record.last?.match?.mediaIds) ? record.last.match.mediaIds : [])
  ].filter(Boolean).join("\n").toLowerCase();
}

function selectMarsRecords(records, params = {}, ctx = {}) {
  const chatId = normalizeChatId(readString(params, "chatId") || ctx?.chatId || ctx?.groupId);
  const threadId = normalizeMessageId(readString(params, "threadId") || ctx?.threadId || ctx?.messageThreadId);
  const explicitMessageId = normalizeMessageId(readString(params, "messageId") || readString(params, "sourceMessageId"));
  const contextMessageId = normalizeMessageId(ctx?.messageId);
  const query = readString(params, "query").toLowerCase();
  let selected = records
    .filter((record) => scopeMatches(record.scopeKey, chatId, threadId))
    .filter((record) => !query || marsHaystack(record).includes(query))
    .sort((left, right) => recordLastSeen(right) - recordLastSeen(left));
  const messageId = explicitMessageId || contextMessageId;
  if (!messageId) return selected;
  const byMessage = selected.filter((record) => normalizeMessageId(record.first?.messageId) === messageId
    || normalizeMessageId(record.last?.messageId) === messageId);
  if (byMessage.length || explicitMessageId) return byMessage;
  return selected;
}

function formatMarsRecordLine(record, index = 0) {
  const first = record.first || {};
  const last = record.last || {};
  const link = marsMessageLink(first);
  return [
    `${index + 1}. key=${record.key || first.match?.key || "unknown"} hits=${record.hitCount || 1}`,
    Array.isArray(record.matchKeys) && record.matchKeys.length ? `keys=${record.matchKeys.slice(0, 4).join(",")}` : "",
    `first=${first.chatId || "?"}/${first.messageId || "?"} ${first.timestamp || ""}`,
    first.senderName || first.senderUsername ? `by=${first.senderName || first.senderUsername}` : "",
    first.preview ? `preview=${clip(first.preview, 160)}` : "",
    Array.isArray(first.match?.urls) && first.match.urls.length ? `url=${clip(first.match.urls[0], 120)}` : "",
    Array.isArray(first.match?.mediaIds) && first.match.mediaIds.length ? `media=${first.match.mediaIds.slice(0, 2).join(",")}` : "",
    Array.isArray(first.media) && first.media.some((item) => item?.cacheStatus) ? `cache=${first.media.map((item) => item.cacheStatus || "unknown").join(",")}` : "",
    Array.isArray(first.media) && first.media.some((item) => item?.visualHashStatus) ? `visual=${first.media.map((item) => item.visualHashStatus || "unknown").join(",")}` : "",
    last.messageId ? `last=${last.chatId || "?"}/${last.messageId} ${last.timestamp || ""}` : "",
    link ? `link=${link}` : ""
  ].filter(Boolean).join(" | ");
}

function marsToolResult(lines, details = {}) {
  return {
    content: [{ type: "text", text: ["MARS_FORWARD_LOOKUP", ...lines].filter(Boolean).join("\n").slice(0, MAX_TEXT) }],
    details: { status: "ok", ...details }
  };
}

function marsToolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `MARS_FORWARD_LOOKUP error: ${clip(message, 500)}` }],
    details: { status: "failed", error: message }
  };
}

async function telegramBotApi(config, method, payload) {
  const token = (await fs.readFile(marsTokenFile(config), "utf8")).trim();
  if (!token) throw new Error("Telegram token is empty");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) {
    const description = String(data?.description || response.statusText || "Telegram request failed")
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[telegram-token-redacted]");
    throw new Error(description);
  }
  return data;
}

async function forwardFirstMarsMessage(config, record, params = {}, ctx = {}) {
  const first = record?.first || {};
  const targetChatId = normalizeChatId(readString(params, "targetChatId") || readString(params, "chatId") || ctx?.chatId || ctx?.groupId);
  const targetThreadId = normalizeMessageId(readString(params, "targetThreadId") || readString(params, "threadId") || ctx?.threadId || ctx?.messageThreadId);
  const fromChatId = normalizeChatId(first.chatId);
  const messageId = normalizeMessageId(first.messageId);
  if (!targetChatId) throw new Error("target chat id is required");
  if (!fromChatId || !messageId) throw new Error("stored first message is missing chatId/messageId");
  if (fromChatId !== targetChatId) throw new Error("refusing to forward a Mars first message into a different chat");
  const payload = {
    chat_id: targetChatId,
    from_chat_id: fromChatId,
    message_id: Number.isFinite(Number(messageId)) ? Number(messageId) : messageId,
    disable_notification: true
  };
  if (targetThreadId && Number.isFinite(Number(targetThreadId))) payload.message_thread_id = Number(targetThreadId);
  if (readBoolean(params, "dryRun", false)) {
    return { method: "dry_run", payload, result: null };
  }
  try {
    return { method: "forwardMessage", payload, result: await telegramBotApi(config, "forwardMessage", payload) };
  } catch (forwardError) {
    const copyResult = await telegramBotApi(config, "copyMessage", payload);
    return {
      method: "copyMessage",
      payload,
      result: copyResult,
      forwardError: forwardError instanceof Error ? forwardError.message : String(forwardError)
    };
  }
}

const marsForwardLookupTool = {
  name: MARS_FORWARD_LOOKUP_TOOL,
  label: "Mars Forward Lookup",
  description: "Find the first same-group Telegram message for a Mars duplicate and optionally forward that first group message back into the current chat.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["lookup", "forward_first"], description: "Use lookup to inspect records; use forward_first to show the first group post." },
      query: { type: "string", description: "Optional source, sender, or preview text filter." },
      messageId: { type: "string", description: "First or duplicate Telegram message id. If omitted, lookup uses the latest matching record in the current chat." },
      sourceMessageId: { type: "string", description: "Alias for messageId." },
      chatId: { type: "string", description: "Telegram chat id. Defaults to the current chat." },
      threadId: { type: "string", description: "Telegram topic/thread id. Defaults to the current topic when available." },
      targetChatId: { type: "string", description: "Target Telegram chat for forward_first. Defaults to current chat; must match the stored first message chat." },
      targetThreadId: { type: "string", description: "Target topic/thread for forward_first. Defaults to current topic." },
      count: { type: "number", description: "Lookup result count, 1-10. Default 3." },
      dryRun: { type: "boolean", description: "For forward_first, show what would be forwarded without calling Telegram." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params = {}, _signal, _onUpdate, ctx) {
    try {
      const config = marsForwardLookupTool.config || {};
      const action = readString(params, "action", "lookup");
      const records = await loadMarsRecords(config);
      const selected = selectMarsRecords(records, params, ctx);
      if (!selected.length) {
        return {
          content: [{ type: "text", text: "MARS_FORWARD_LOOKUP no_match: no Mars records matched the current chat/message/query." }],
          details: { status: "no_match", action, statePath: marsStatePath(config) }
        };
      }
      if (action === "lookup") {
        const count = Math.trunc(readNumber(params, "count", 3, 1, 10));
        const results = selected.slice(0, count);
        return marsToolResult([
          `results=${results.length}`,
          ...results.map(formatMarsRecordLine)
        ], { action, statePath: marsStatePath(config), results: results.map(publicMarsRecord) });
      }
      if (action !== "forward_first") throw new Error("unknown action");
      const record = selected[0];
      const delivery = await forwardFirstMarsMessage(config, record, params, ctx);
      const first = publicMarsSnapshot(record.first || {});
      return marsToolResult([
        `forwarded=${delivery.method}`,
        formatMarsRecordLine(record, 0),
        first.link ? `firstLink=${first.link}` : "",
        delivery.forwardError ? `forwardFallbackReason=${clip(delivery.forwardError, 240)}` : ""
      ], {
        action,
        delivered: delivery.method !== "dry_run",
        method: delivery.method,
        first,
        result: delivery.result,
        selected: publicMarsRecord(record)
      });
    } catch (error) {
      return marsToolError(error);
    }
  }
};

const interactionPipelineTool = {
  name: TOOL_NAME,
  label: "Interaction Pipeline",
  description: "Evaluate Telegram group trigger, stable user identity, and model-window routing rules. No message sending and no hidden chat access.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["evaluate", "identity", "rules"], description: "Pipeline operation." },
      text: { type: "string", description: "Message text." },
      message: { type: "string", description: "Alias for text." },
      userId: { type: "string", description: "Telegram sender id." },
      userName: { type: "string", description: "Telegram username." },
      displayName: { type: "string", description: "Visible sender name." },
      chatId: { type: "string", description: "Telegram chat id." },
      chatTitle: { type: "string", description: "Telegram chat title." },
      user: { type: "object", description: "Optional structured Telegram user." },
      chat: { type: "object", description: "Optional structured Telegram chat." },
      botUsername: { type: "string", description: "Bot username without or with @." },
      botUsernames: { type: "array", items: { type: "string" }, description: "Accepted bot usernames." },
      triggerPrefixes: { type: "array", items: { type: "string" }, description: "Extra group trigger prefixes." },
      isGroup: { type: "boolean", description: "Whether message came from a group." },
      isPrivate: { type: "boolean", description: "Whether message came from a private chat." },
      isReplyToBot: { type: "boolean", description: "Whether message replies to a bot message." },
      replyToBot: { type: "boolean", description: "Alias for isReplyToBot." },
      mentionsBot: { type: "boolean", description: "Runtime says message mentions bot." },
      mentionedBot: { type: "boolean", description: "Alias for mentionsBot." },
      hasMedia: { type: "boolean", description: "Whether message has media." },
      replySessionKey: { type: "string", description: "Window key attached to replied bot message, if known." },
      activeSessionKey: { type: "string", description: "Current runtime session key, if known." },
      allowFrom: { type: "array", items: { type: "string" }, description: "Optional sender allowlist for diagnostic evaluation." },
      rateLimit: { type: "object", description: "Optional diagnostic rate limit config: enabled/windowMs/maxPerUser/maxPerChat." },
      recordRateLimit: { type: "boolean", description: "Record this evaluation in the in-memory diagnostic rate limiter." },
      enforceRateLimit: { type: "boolean", description: "If rate limited, set shouldRespond=false in this evaluation." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params) {
    try {
      const config = interactionPipelineTool.config || {};
      const action = readString(params, "action", "evaluate").toLowerCase();
      if (action === "rules") {
        const prefixes = [...DEFAULT_TRIGGER_PREFIXES, ...configArray(config, "triggerPrefixes", [])];
        const botNames = configArray(config, "botUsernames", []);
        return ok([
          "rules:",
          `version: ${PIPELINE_VERSION}`,
          "middleware: receive -> identity -> command -> private_policy -> reply_to_bot -> mention -> trigger_prefix -> media -> permission -> rate_limit -> window_route -> decision",
          "- private chat: respond",
          "- group: respond to /am* controls, reply-to-bot, @bot mention, or configured prefix",
          "- reply-to-bot with a replySessionKey enters the replied bot window",
          "- /amnew opens a fresh sender window",
          "- sender allowlist and rate-limit checks are diagnostic unless configured/enforced",
          `controlCommands: ${CONTROL_COMMANDS.join(", ")}`,
          `triggerPrefixes: ${prefixes.join(", ")}`,
          botNames.length ? `botUsernames: ${botNames.join(", ")}` : "botUsernames: runtime/config supplied"
        ], { action, controlCommands: CONTROL_COMMANDS, triggerPrefixes: prefixes, botUsernames: botNames });
      }
      if (action === "identity") {
        const identity = readIdentity(params);
        return ok([
          `userId: ${identity.userId || "unknown"}`,
          `displayName: ${identity.publicLabel}`,
          `chatId: ${identity.chatId || "unknown"}`,
          `identityKey: ${identity.identityKey || "unknown"}`
        ], { action, identity });
      }
      if (action !== "evaluate") throw new Error("unknown action");
      const result = evaluateMessage(config, params);
      return ok([
        `shouldRespond: ${result.shouldRespond}`,
        `reason: ${result.reason}`,
        `window: ${result.window.mode} ${result.window.key}`,
        result.normalizedText ? `normalizedText: ${result.normalizedText}` : "normalizedText: (empty)"
      ], { action, result });
    } catch (error) {
      return fail(error);
    }
  }
};

function contextLine(event, ctx) {
  const sessionKey = String(ctx?.sessionKey || event?.sessionKey || "").trim();
  const userId = normalizedUserId(event?.userId || event?.senderId || ctx?.userId || "");
  const chatId = String(event?.chatId || event?.groupId || ctx?.chatId || ctx?.groupId || "").trim();
  if (!sessionKey && !userId && !chatId) return "";
  return [
    "[Imagebot interaction context]",
    "Telegram group turns are multi-user: reason by stable Telegram user id when it is available.",
    "A reply to a bot message may intentionally enter another active window; do not silently replace it with the sender's personal window.",
    sessionKey ? `sessionKey: ${clip(sessionKey, 160)}` : "",
    userId ? `senderUserId: ${userId}` : "",
    chatId ? `chatId: ${chatId}` : "",
    "[/Imagebot interaction context]"
  ].filter(Boolean).join("\n");
}

export const __testing = {
  CONTROL_COMMANDS,
  DEFAULT_TRIGGER_PREFIXES,
  readIdentity,
  parseCommand,
  stripTriggerPrefix,
  evaluateMessage,
  sessionRecommendation,
  loadMarsRecords,
  selectMarsRecords,
  forwardFirstMarsMessage,
  marsStatePath,
  marsSqlitePath
};

export default {
  id: "imagebot-interaction-core",
  name: "Imagebot Interaction Core",
  description: "Small interaction pipeline primitives for Telegram trigger, identity, and window routing.",
  register(api) {
    const config = api.config || {};
    interactionPipelineTool.config = config;
    marsForwardLookupTool.config = config;
    api.registerTool(interactionPipelineTool, { name: TOOL_NAME });
    api.registerTool(marsForwardLookupTool, { name: MARS_FORWARD_LOOKUP_TOOL });
    registerLifecycleHook(api, "before_prompt_build", async (event, ctx) => {
      if (ctx?.agentId && ctx.agentId !== "imagebot") return;
      if (config.appendInteractionContext === false) return;
      const appendContext = contextLine(event, ctx);
      return appendContext ? { appendContext } : undefined;
    }, { name: "imagebot-interaction-core-before-prompt-build" });
  }
};

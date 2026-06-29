import crypto from "node:crypto";

const DEFAULT_CALLBACK_TTL_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

function nowMs() {
  return Date.now();
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function normalizeUserId(value) {
  const raw = cleanString(value);
  if (!raw) return "";
  return raw.startsWith("tg:") ? raw : `tg:${raw}`;
}

function normalizeScope(scope = {}) {
  return {
    chatId: cleanString(scope.chatId),
    windowId: cleanString(scope.windowId || scope.sessionKey),
    messageId: cleanString(scope.messageId),
    featureId: cleanString(scope.featureId),
    creatorUserId: normalizeUserId(scope.creatorUserId || scope.userId || scope.senderId)
  };
}

function normalizeAllowedUsers(users = []) {
  return [...new Set((Array.isArray(users) ? users : [users])
    .map(normalizeUserId)
    .filter(Boolean))];
}

function createCallbackRecord(input = {}, options = {}) {
  const createdAt = Number.isFinite(options.now) ? options.now : nowMs();
  const ttlMs = Math.max(1_000, Math.trunc(Number(input.ttlMs || options.ttlMs || DEFAULT_CALLBACK_TTL_MS)));
  const scope = normalizeScope(input);
  return {
    id: cleanString(input.id) || crypto.randomUUID(),
    kind: "callback",
    action: cleanString(input.action),
    role: cleanString(input.role || "creator"),
    createdAt,
    expiresAt: createdAt + ttlMs,
    scope,
    allowedUserIds: normalizeAllowedUsers(input.allowedUserIds),
    payload: input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? input.payload : {}
  };
}

function createSessionRecord(input = {}, options = {}) {
  const createdAt = Number.isFinite(options.now) ? options.now : nowMs();
  const ttlMs = Math.max(1_000, Math.trunc(Number(input.ttlMs || options.ttlMs || DEFAULT_SESSION_TTL_MS)));
  const scope = normalizeScope(input);
  return {
    id: cleanString(input.id) || crypto.randomUUID(),
    kind: "session",
    featureId: scope.featureId,
    state: cleanString(input.state || "active"),
    createdAt,
    updatedAt: createdAt,
    expiresAt: createdAt + ttlMs,
    scope,
    allowedUserIds: normalizeAllowedUsers(input.allowedUserIds),
    data: input.data && typeof input.data === "object" && !Array.isArray(input.data) ? input.data : {}
  };
}

function verifyScope(recordScope = {}, eventScope = {}, options = {}) {
  const reasons = [];
  const event = normalizeScope(eventScope);
  const record = normalizeScope(recordScope);
  const requireWindow = options.requireWindow !== false;
  const fields = [
    ["chatId", true],
    ["featureId", false],
    ["windowId", requireWindow],
    ["messageId", false]
  ];
  for (const [field, required] of fields) {
    if (!record[field]) continue;
    if (!event[field]) {
      if (required) reasons.push(`missing_${field}`);
      continue;
    }
    if (record[field] !== event[field]) reasons.push(`mismatched_${field}`);
  }
  return reasons;
}

function isUserAllowed(record, eventScope = {}) {
  const userId = normalizeUserId(eventScope.userId || eventScope.senderId || eventScope.creatorUserId);
  const creatorUserId = normalizeUserId(record?.scope?.creatorUserId);
  const allowed = normalizeAllowedUsers(record?.allowedUserIds || []);
  if (record?.role === "any") return { allowed: true, userId };
  if (allowed.length > 0 && allowed.includes(userId)) return { allowed: true, userId };
  if (creatorUserId && userId === creatorUserId) return { allowed: true, userId };
  return { allowed: false, userId };
}

function verifyInteractionRecord(record, eventScope = {}, options = {}) {
  const at = Number.isFinite(options.now) ? options.now : nowMs();
  if (!record || typeof record !== "object") {
    return { allowed: false, reason: "missing_record" };
  }
  if (Number.isFinite(record.expiresAt) && record.expiresAt < at) {
    return { allowed: false, reason: "expired", expiresAt: record.expiresAt };
  }
  const scopeReasons = verifyScope(record.scope, eventScope, options);
  if (scopeReasons.length > 0) {
    return { allowed: false, reason: scopeReasons[0], scopeReasons };
  }
  const user = isUserAllowed(record, eventScope);
  if (!user.allowed) {
    return { allowed: false, reason: "user_not_allowed", userId: user.userId };
  }
  return { allowed: true, reason: "ok", userId: user.userId };
}

function touchSession(record, patch = {}, options = {}) {
  const at = Number.isFinite(options.now) ? options.now : nowMs();
  return {
    ...record,
    state: cleanString(patch.state || record.state || "active"),
    updatedAt: at,
    expiresAt: Number.isFinite(patch.expiresAt) ? patch.expiresAt : record.expiresAt,
    data: {
      ...(record.data || {}),
      ...(patch.data && typeof patch.data === "object" && !Array.isArray(patch.data) ? patch.data : {})
    }
  };
}

function pruneExpired(records = [], options = {}) {
  const at = Number.isFinite(options.now) ? options.now : nowMs();
  return (Array.isArray(records) ? records : []).filter((record) => !Number.isFinite(record?.expiresAt) || record.expiresAt >= at);
}

export {
  DEFAULT_CALLBACK_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  normalizeUserId,
  normalizeScope,
  createCallbackRecord,
  createSessionRecord,
  verifyInteractionRecord,
  touchSession,
  pruneExpired
};

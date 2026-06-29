import crypto from "node:crypto";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return String(value ?? "").trim();
}

function firstString(...values) {
  for (const value of values) {
    const text = cleanString(value);
    if (text) return text;
  }
  return "";
}

function normalizeActorId(value) {
  const raw = cleanString(value);
  if (!raw) return "";
  const withoutPrefix = raw.replace(/^tg:/i, "");
  const numeric = withoutPrefix.match(/\d+/);
  return numeric ? numeric[0] : withoutPrefix;
}

function senderIdFromSessionKey(value) {
  const text = cleanString(value);
  const match = text.match(/(?:^|:)sender:([^:]+)/i);
  return match ? normalizeActorId(match[1]) : "";
}

function contextText(ctx = {}) {
  if (!isRecord(ctx)) return "";
  return firstString(
    ctx.approvalText,
    ctx.messageText,
    ctx.bodyText,
    ctx.rawBody,
    ctx.text,
    ctx.approval?.text,
    ctx.message?.text,
    ctx.message?.caption,
    ctx.event?.text,
    ctx.event?.caption,
    ctx.update?.message?.text,
    ctx.update?.message?.caption,
    ctx.update?.callback_query?.data,
    ctx.callbackQuery?.data
  );
}

export function trustedMutationContext(ctx = {}) {
  const message = isRecord(ctx?.message) ? ctx.message : {};
  const event = isRecord(ctx?.event) ? ctx.event : {};
  const updateMessage = isRecord(ctx?.update?.message) ? ctx.update.message : {};
  const callbackQuery = isRecord(ctx?.callbackQuery) ? ctx.callbackQuery : isRecord(ctx?.update?.callback_query) ? ctx.update.callback_query : {};
  const callbackMessage = isRecord(callbackQuery?.message) ? callbackQuery.message : {};
  const imagebotWindow = isRecord(ctx?.imagebotWindow) ? ctx.imagebotWindow : {};
  const window = isRecord(ctx?.window) ? ctx.window : {};
  const sessionKey = firstString(ctx.sessionKey, ctx.session?.key, ctx.route?.sessionKey, window.sessionKey, imagebotWindow.sessionKey);

  return {
    agentId: firstString(ctx.agentId, ctx.route?.agentId),
    accountId: firstString(ctx.accountId, ctx.account?.id, ctx.channelAccountId),
    channel: firstString(ctx.channel, ctx.platform, ctx.transport),
    chatId: firstString(ctx.chatId, ctx.groupId, message.chat?.id, event.chat?.id, updateMessage.chat?.id, callbackMessage.chat?.id),
    threadId: firstString(ctx.threadId, ctx.messageThreadId, ctx.resolvedThreadId, ctx.topicId, message.message_thread_id, updateMessage.message_thread_id, callbackMessage.message_thread_id),
    sessionKey,
    windowId: firstString(ctx.windowId, window.windowId, imagebotWindow.windowId),
    senderId: normalizeActorId(firstString(
      ctx.senderId,
      ctx.userId,
      ctx.fromUserId,
      ctx.telegramUserId,
      ctx.sender?.id,
      ctx.from?.id,
      message.from?.id,
      event.from?.id,
      updateMessage.from?.id,
      callbackQuery.from?.id,
      senderIdFromSessionKey(sessionKey)
    )),
    messageId: firstString(ctx.messageId, message.message_id, event.message_id, updateMessage.message_id, callbackMessage.message_id),
    text: contextText(ctx)
  };
}

export function mutationScopeKey(context = {}) {
  const normalized = trustedMutationContext(context);
  return [
    `account:${normalized.accountId || "default"}`,
    `chat:${normalized.chatId || "none"}`,
    `thread:${normalized.threadId || "main"}`,
    `session:${normalized.sessionKey || normalized.windowId || "none"}`
  ].join("|");
}

export function mutationActorKey(context = {}) {
  const normalized = trustedMutationContext(context);
  return `${mutationScopeKey(normalized)}|sender:${normalized.senderId || "none"}`;
}

export function requireTrustedActorContext(ctx = {}, { label = "mutation" } = {}) {
  const context = trustedMutationContext(ctx);
  if (!context.senderId) {
    throw new Error(`${label} requires trusted runtime sender context`);
  }
  if (!context.chatId && !context.sessionKey && !context.windowId) {
    throw new Error(`${label} requires trusted runtime chat/session context`);
  }
  return {
    ...context,
    scopeKey: mutationScopeKey(context),
    actorKey: mutationActorKey(context)
  };
}

function numericMessageId(value) {
  const text = cleanString(value);
  if (!/^-?\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

export function newMutationPlanId(prefix = "plan") {
  const cleanPrefix = cleanString(prefix).toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "plan";
  return `${cleanPrefix}_${crypto.randomBytes(7).toString("hex")}`;
}

export function newMutationApprovalCode(prefix = "APPROVE") {
  const cleanPrefix = cleanString(prefix).toUpperCase().replace(/[^A-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "APPROVE";
  return `${cleanPrefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

export function mutationTargetFingerprint(value, len = 18) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, len);
}

export function bindMutationPlanToContext(plan = {}, ctx = {}, { label = "mutation plan" } = {}) {
  const context = requireTrustedActorContext(ctx, { label });
  return {
    ...plan,
    context: {
      agentId: context.agentId,
      accountId: context.accountId,
      channel: context.channel,
      chatId: context.chatId,
      threadId: context.threadId,
      sessionKey: context.sessionKey,
      windowId: context.windowId,
      senderId: context.senderId,
      messageId: context.messageId
    },
    scopeKey: context.scopeKey,
    actorKey: context.actorKey,
    requestMessageId: context.messageId
  };
}

export function verifyMutationPlanApproval({ plan, ctx, approvalCode, label = "mutation" } = {}) {
  if (!isRecord(plan)) return { ok: false, reason: `${label} approval plan is missing` };
  let context;
  try {
    context = requireTrustedActorContext(ctx, { label });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (plan.scopeKey && plan.scopeKey !== context.scopeKey) {
    return { ok: false, reason: `${label} approval scope does not match the original request` };
  }
  if (plan.actorKey && plan.actorKey !== context.actorKey) {
    return { ok: false, reason: `${label} approval must come from the original requester` };
  }
  const plannedMessage = numericMessageId(plan.requestMessageId || plan.context?.messageId);
  const currentMessage = numericMessageId(context.messageId);
  if (plannedMessage !== null && currentMessage !== null && currentMessage <= plannedMessage) {
    return { ok: false, reason: `${label} approval must come from a later user message` };
  }
  const text = context.text;
  if (!approvalCode || !text.includes(approvalCode)) {
    return { ok: false, reason: `Trusted approval message must include ${approvalCode || "(missing approval code)"}` };
  }
  return { ok: true, context };
}

export function hasTrustedMutationApproval(ctx = {}) {
  return ctx?.mutationApproved === true ||
    ctx?.trustedMutationApproved === true ||
    ctx?.mutationAuthorization?.approved === true ||
    ctx?.mutationApproval?.approved === true ||
    (ctx?.approval?.trusted === true && ctx.approval.approved !== false);
}

export function requireTrustedMutationApproval(ctx = {}, { label = "mutation" } = {}) {
  const context = requireTrustedActorContext(ctx, { label });
  if (!hasTrustedMutationApproval(ctx)) {
    throw new Error(`${label} dryRun:false requires trusted mutation approval from runtime context`);
  }
  return context;
}

export function hasModelSuppliedApprovalFlag(params = {}, keys = []) {
  if (!isRecord(params)) return false;
  return keys.some((key) => {
    const value = params[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return /^(1|true|yes|on)$/i.test(value.trim());
    return false;
  });
}

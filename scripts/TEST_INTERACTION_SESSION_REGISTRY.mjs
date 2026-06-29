import assert from "node:assert/strict";
import {
  createCallbackRecord,
  createSessionRecord,
  normalizeScope,
  normalizeUserId,
  pruneExpired,
  touchSession,
  verifyInteractionRecord
} from "../plugins/imagebot-shared/interaction-session-registry.js";

assert.equal(normalizeUserId("123"), "tg:123");
assert.equal(normalizeUserId("tg:123"), "tg:123");
assert.deepEqual(normalizeScope({ chatId: -100, userId: 42, sessionKey: "s1", featureId: "settings" }), {
  chatId: "-100",
  windowId: "s1",
  messageId: "",
  featureId: "settings",
  creatorUserId: "tg:42"
});

const callback = createCallbackRecord({
  id: "cb-1",
  action: "settings.toggle",
  chatId: "-100",
  windowId: "window-A",
  messageId: "9001",
  featureId: "settings",
  creatorUserId: "100",
  ttlMs: 10_000
}, { now: 1_000 });

assert.equal(callback.expiresAt, 11_000);
assert.equal(verifyInteractionRecord(callback, {
  chatId: "-100",
  windowId: "window-A",
  messageId: "9001",
  featureId: "settings",
  userId: "100"
}, { now: 2_000 }).allowed, true);

assert.equal(verifyInteractionRecord(callback, {
  chatId: "-100",
  windowId: "window-A",
  messageId: "9001",
  featureId: "settings",
  userId: "200"
}, { now: 2_000 }).reason, "user_not_allowed");

assert.equal(verifyInteractionRecord(callback, {
  chatId: "-100",
  windowId: "window-B",
  messageId: "9001",
  featureId: "settings",
  userId: "100"
}, { now: 2_000 }).reason, "mismatched_windowId");

assert.equal(verifyInteractionRecord(callback, {
  chatId: "-100",
  windowId: "window-A",
  messageId: "9001",
  featureId: "settings",
  userId: "100"
}, { now: 12_000 }).reason, "expired");

const groupCallback = createCallbackRecord({
  id: "cb-2",
  role: "any",
  chatId: "-100",
  featureId: "gallery",
  ttlMs: 10_000
}, { now: 1_000 });
assert.equal(verifyInteractionRecord(groupCallback, {
  chatId: "-100",
  featureId: "gallery",
  userId: "300"
}, { now: 2_000 }).allowed, true);

const session = createSessionRecord({
  id: "session-1",
  chatId: "-100",
  windowId: "window-A",
  featureId: "sticker_pack",
  creatorUserId: "100",
  state: "awaiting_title",
  data: { count: 1 },
  ttlMs: 5_000
}, { now: 10_000 });
assert.equal(session.expiresAt, 15_000);
assert.equal(verifyInteractionRecord(session, {
  chatId: "-100",
  windowId: "window-A",
  featureId: "sticker_pack",
  userId: "100"
}, { now: 11_000 }).allowed, true);

const touched = touchSession(session, {
  state: "awaiting_emoji",
  data: { emoji: "ok" }
}, { now: 12_000 });
assert.equal(touched.state, "awaiting_emoji");
assert.equal(touched.updatedAt, 12_000);
assert.deepEqual(touched.data, { count: 1, emoji: "ok" });

assert.deepEqual(pruneExpired([callback, session, groupCallback], { now: 12_000 }).map((item) => item.id), ["session-1"]);

console.log("interaction session registry tests passed");

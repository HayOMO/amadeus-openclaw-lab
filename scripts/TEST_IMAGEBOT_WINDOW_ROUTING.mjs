import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { resolveOpenClawDistDir } from "./OPENCLAW_RUNTIME_PATHS.mjs";

const distDir = resolveOpenClawDistDir();
const HARNESS_NOW = Date.parse("2026-06-18T00:05:00.000Z");
const RealDate = Date;

async function readBotRuntime() {
  const names = await fs.readdir(distDir);
  for (const name of names.filter((entry) => entry.startsWith("bot-") && entry.endsWith(".js")).sort()) {
    const source = await fs.readFile(path.join(distDir, name), "utf8");
    if (source.includes("function resolveTelegramImagebotWindowContext")) return { name, source };
  }
  throw new Error("No bot runtime with imagebot window routing found.");
}

function extractWindowRuntime(source) {
  const start = source.indexOf("function telegramImagebotUserKey");
  const end = source.indexOf("async function resolveTelegramCommandIngressAuthorization", start);
  assert.notEqual(start, -1, "missing telegramImagebotUserKey");
  assert.notEqual(end, -1, "missing resolveTelegramCommandIngressAuthorization boundary");
  return source.slice(start, end);
}

function makeWindow({ id, owner, name, chatId, sessionKey }) {
  return {
    windowId: id,
    ownerUserKey: `tg:${owner}`,
    ownerSenderId: String(owner),
    ownerName: name,
    accountId: "imagebot",
    chatId: String(chatId),
    sessionKey,
    openedAt: "2026-06-18T00:00:00.000Z",
    lastActivityAt: "2026-06-18T00:00:00.000Z",
    participants: {
      [`tg:${owner}`]: {
        id: String(owner),
        name,
        lastSeenAt: "2026-06-18T00:00:00.000Z",
      },
    },
    recent: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildHarness(snippet, initialStore) {
  const context = {
    console,
    assert,
    Date: class extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [HARNESS_NOW]));
      }
      static now() {
        return HARNESS_NOW;
      }
      static parse(value) {
        return RealDate.parse(value);
      }
      static UTC(...args) {
        return RealDate.UTC(...args);
      }
    },
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
    process: {
      env: { USERPROFILE: "C:/Users/Test" },
      pid: 1234,
      cwd: () => "C:/repo",
    },
    path: {
      join: (...parts) => parts.filter(Boolean).join("/").replace(/\/+/g, "/"),
      dirname: (value) => String(value).replace(/[\\/][^\\/]*$/, "") || ".",
      resolve: (...parts) => parts.filter(Boolean).join("/").replace(/\/+/g, "/"),
      relative: (_from, to) => String(to || ""),
      isAbsolute: (value) => /^[A-Za-z]:[\\/]/.test(String(value || "")) || String(value || "").startsWith("/"),
    },
    fs: {
      existsSync: (filePath) => Object.hasOwn(context.__personaFiles, String(filePath)),
      readFileSync: (filePath) => context.__personaFiles[String(filePath)],
      mkdirSync: () => {},
      writeFileSync: (filePath, text) => {
        context.__personaFiles[String(filePath)] = String(text);
      },
      renameSync: (from, to) => {
        context.__personaFiles[String(to)] = context.__personaFiles[String(from)];
        delete context.__personaFiles[String(from)];
      },
    },
    __personaFiles: {},
    __store: clone(initialStore),
    __writes: [],
  };
  vm.createContext(context);
  vm.runInContext(`
function normalizeOptionalString(value) {
  if (value === null || value === undefined) return undefined;
  return String(value);
}
function normalizeLowercaseStringOrEmpty(value) {
  return (normalizeOptionalString(value)?.trim() || "").toLowerCase();
}
function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}
function readTelegramImagebotWindowStore() {
  return globalThis.__store;
}
function writeTelegramImagebotWindowStore(_cfg, _agentId, store) {
  globalThis.__store = store;
  globalThis.__writes.push(JSON.parse(JSON.stringify(store)));
}
function resolveTelegramConversationRoute(params) {
  return {
    route: {
      agentId: params.accountId || "imagebot",
    },
  };
}
function resolveTelegramConversationBaseSessionKey(params) {
  const scope = params.isGroup ? "group" : "dm";
  return "agent:" + params.route.agentId + ":telegram:" + scope + ":" + params.chatId + ":sender:" + params.senderId;
}
function applyTelegramImagebotAmmodelDefaultToSessionSync(params) {
  globalThis.__modelDefaultApplied = params;
  return false;
}
${snippet}
globalThis.__imagebotWindowRouting = {
  openTelegramImagebotWindow,
  resolveTelegramImagebotWindowContext,
  resolveTelegramImagebotActiveWindowId,
  resolveTelegramImagebotRecentActiveWindowId,
  resolveTelegramImagebotSequentialWindowId,
  resolveTelegramImagebotAmmodelTarget,
  isTelegramImagebotAmmodelOwnerAllowed,
  recordTelegramImagebotAmmodelMessage,
  resolveTelegramImagebotLatestBotMessageId,
  noteTelegramImagebotWindowOutbound,
  updateTelegramImagebotWindowPersona,
  resolveTelegramImagebotSessionPersona,
  resolveTelegramImagebotPersonaForNewWindow,
  getStore: () => globalThis.__store,
  getWrites: () => globalThis.__writes,
  getModelDefaultApplied: () => globalThis.__modelDefaultApplied,
  clearModelDefaultApplied: () => {
    delete globalThis.__modelDefaultApplied;
  }
};
`, context);
  return context.__imagebotWindowRouting;
}

const { name, source } = await readBotRuntime();
const snippet = extractWindowRuntime(source);

const chatId = -1000000000000;
const botId = 8704643527;
const windowA = makeWindow({
  id: "window-A",
  owner: "100",
  name: "Alice",
  chatId,
  sessionKey: "agent:imagebot:telegram:group:-1000000000000:sender:100:window:window-A",
});
const windowB = makeWindow({
  id: "window-B",
  owner: "200",
  name: "Bob",
  chatId,
  sessionKey: "agent:imagebot:telegram:group:-1000000000000:sender:200:window:window-B",
});
const windowC = makeWindow({
  id: "window-C",
  owner: "100",
  name: "Alice",
  chatId,
  sessionKey: "agent:imagebot:telegram:group:-1000000000000:sender:100:window:window-C",
});

const baseStore = {
  version: 3,
  users: {},
  windows: {
    "window-A": clone(windowA),
    "window-B": clone(windowB),
    "window-C": clone(windowC),
  },
  activeByUser: {
    "tg:100": clone(windowC),
    "tg:200": clone(windowB),
  },
  byBotMessage: {
    [`${chatId}:9001`]: {
      windowId: "window-A",
      ownerUserKey: "tg:100",
      sessionKey: windowA.sessionKey,
      recordedAt: Date.now(),
    },
    [`${chatId}:9002`]: {
      windowId: "window-B",
      ownerUserKey: "tg:200",
      sessionKey: windowB.sessionKey,
      recordedAt: Date.now(),
    },
    [`${chatId}:9003`]: {
      windowId: "window-C",
      ownerUserKey: "tg:100",
      sessionKey: windowC.sessionKey,
      recordedAt: Date.now(),
    },
  },
};

const harness = buildHarness(snippet, baseStore);

const openHarness = buildHarness(snippet, baseStore);
const openedWindow = openHarness.openTelegramImagebotWindow({
  cfg: {},
  agentId: "imagebot",
  accountId: "imagebot",
  chatId,
  senderId: "100",
  senderName: "Alice",
  baseSessionKey: windowC.sessionKey,
});
const openStore = openHarness.getStore();
assert.notEqual(openedWindow.windowId, "window-C");
assert.equal(openedWindow.personaId, "default");
assert.equal(openedWindow.personaLabel, "Amaduse");
assert.equal(openedWindow.recent.length, 0, "/amnew persona selection must not enter model-visible window recent context");
assert.equal(openStore.activeByUser["tg:100"].windowId, openedWindow.windowId);
assert.equal(openStore.windows["window-C"].closedReason, "replaced-by-amnew");
assert.equal(openStore.windows["window-C"].replacedByWindowId, openedWindow.windowId);
assert.ok(openStore.windows["window-C"].closedAt, "/amnew must close the sender's previous active window");
assert.equal(openStore.byBotMessage[`${chatId}:9003`], undefined);
assert.ok(openStore.windows["window-A"].closedAt, "/amnew must also close inactive replyable windows");
assert.equal(openStore.windows["window-A"].closedReason, "inactive-window-routing-pruned");
assert.equal(openStore.byBotMessage[`${chatId}:9001`], undefined);

const newWindowHarness = buildHarness(snippet, {
  version: 3,
  users: {},
  windows: {},
  activeByUser: {},
  byBotMessage: {},
});
const newSenderWindow = newWindowHarness.resolveTelegramImagebotWindowContext({
  cfg: {},
  agentId: "imagebot",
  accountId: "imagebot",
  chatId,
  isGroup: true,
  baseSessionKey: "agent:imagebot:telegram:group:-1000000000000:sender:300",
  msg: {},
  senderId: "300",
  senderName: "Cathy",
  botId,
});
assert.equal(newSenderWindow.source, "new-sender-window");
assert.equal(
  newWindowHarness.getModelDefaultApplied()?.sessionKey,
  newSenderWindow.sessionKey,
  "new sender windows must immediately copy the current /ammodel default into the new session",
);

const recentHarness = buildHarness(snippet, baseStore);
assert.equal(
  recentHarness.resolveTelegramImagebotRecentActiveWindowId({
    cfg: {},
    agentId: "imagebot",
    accountId: "imagebot",
    chatId,
    isGroup: true,
    senderId: "100",
    now: Date.parse("2026-06-18T00:10:00.000Z"),
  }),
  "window-C",
  "a recent active sender window should let a plain group message enter the window",
);
assert.equal(
  recentHarness.resolveTelegramImagebotRecentActiveWindowId({
    cfg: {},
    agentId: "imagebot",
    accountId: "imagebot",
    chatId,
    isGroup: true,
    senderId: "100",
    now: Date.parse("2026-06-18T00:31:00.000Z"),
  }),
  null,
  "a stale active sender window must not make all future plain group messages trigger the bot",
);
assert.equal(recentHarness.getStore().windows["window-C"].closedReason, "idle-window-timeout");
assert.equal(recentHarness.getStore().activeByUser["tg:100"], undefined);

const idleHarness = buildHarness(snippet, baseStore);
const idleReplacementWindow = idleHarness.resolveTelegramImagebotWindowContext({
  cfg: {},
  agentId: "imagebot",
  accountId: "imagebot",
  chatId,
  isGroup: true,
  baseSessionKey: windowC.sessionKey,
  msg: {},
  senderId: "100",
  senderName: "Alice",
  botId,
  now: Date.parse("2026-06-18T00:10:01.000Z"),
});
assert.equal(idleReplacementWindow.source, "new-sender-window");
assert.notEqual(idleReplacementWindow.windowId, "window-C");
assert.equal(idleHarness.getStore().windows["window-C"].closedReason, "idle-window-timeout");
assert.equal(
  idleHarness.getStore().windows["window-C"].replacedByWindowId,
  undefined,
  "idle timeout must not use the /amnew replacement path",
);
assert.equal(idleHarness.getStore().activeByUser["tg:100"].windowId, idleReplacementWindow.windowId);

const aliceAmmodelTarget = harness.resolveTelegramImagebotAmmodelTarget({
  cfg: {},
  accountId: "imagebot",
  chatId,
  isGroup: true,
  senderId: "100",
  msg: {
    __imagebotAmmodelCallback: {
      messageId: 9003,
    },
  },
  botId,
  botUsername: "YOUR_BOT_USERNAME",
});

assert.equal(aliceAmmodelTarget.window.windowId, "window-C");
assert.equal(aliceAmmodelTarget.sessionKey, windowC.sessionKey);
assert.equal(aliceAmmodelTarget.ownerUserKey, "tg:100");
assert.equal(
  harness.isTelegramImagebotAmmodelOwnerAllowed({ senderId: "100", target: aliceAmmodelTarget }),
  true,
  "window owner must be allowed to use their own /ammodel menu",
);

const bobClicksAliceAmmodelTarget = harness.resolveTelegramImagebotAmmodelTarget({
  cfg: {},
  accountId: "imagebot",
  chatId,
  isGroup: true,
  senderId: "200",
  msg: {
    __imagebotAmmodelCallback: {
      messageId: 9003,
    },
  },
  botId,
  botUsername: "YOUR_BOT_USERNAME",
});

assert.equal(bobClicksAliceAmmodelTarget.window.windowId, "window-C");
assert.equal(bobClicksAliceAmmodelTarget.sessionKey, windowC.sessionKey);
assert.equal(bobClicksAliceAmmodelTarget.ownerUserKey, "tg:100");
assert.equal(
  harness.isTelegramImagebotAmmodelOwnerAllowed({ senderId: "200", target: bobClicksAliceAmmodelTarget }),
  false,
  "a different group member clicking another user's /ammodel menu must be blocked",
);

const staleAmmodelTarget = harness.resolveTelegramImagebotAmmodelTarget({
  cfg: {},
  accountId: "imagebot",
  chatId,
  isGroup: true,
  senderId: "100",
  msg: {
    __imagebotAmmodelCallback: {
      messageId: 9001,
    },
  },
  botId,
  botUsername: "YOUR_BOT_USERNAME",
});

assert.equal(staleAmmodelTarget.untrustedCallback, true);
assert.equal(staleAmmodelTarget.window, null);
assert.equal(
  harness.isTelegramImagebotAmmodelOwnerAllowed({ senderId: "100", target: staleAmmodelTarget }),
  false,
  "a stale /ammodel callback from an inactive window must not mutate an old session",
);

const unmappedAmmodelTarget = harness.resolveTelegramImagebotAmmodelTarget({
  cfg: {},
  accountId: "imagebot",
  chatId,
  isGroup: true,
  senderId: "100",
  msg: {
    __imagebotAmmodelCallback: {
      messageId: 9999,
    },
  },
  botId,
  botUsername: "YOUR_BOT_USERNAME",
});

assert.equal(unmappedAmmodelTarget.untrustedCallback, true);
assert.equal(
  harness.isTelegramImagebotAmmodelOwnerAllowed({ senderId: "100", target: unmappedAmmodelTarget }),
  false,
  "an unmapped /ammodel callback cannot prove menu ownership and must be blocked",
);

harness.recordTelegramImagebotAmmodelMessage({
  cfg: {},
  agentId: "imagebot",
  chatId,
  messageId: 9010,
  ownerUserKey: aliceAmmodelTarget.ownerUserKey,
  sessionKey: aliceAmmodelTarget.sessionKey,
  window: aliceAmmodelTarget.window,
});

assert.equal(harness.getStore().byBotMessage[`${chatId}:9010`].windowId, "window-C");
assert.equal(harness.getStore().byBotMessage[`${chatId}:9010`].ownerUserKey, "tg:100");
assert.equal(harness.getStore().byBotMessage[`${chatId}:9010`].sessionKey, windowC.sessionKey);

harness.noteTelegramImagebotWindowOutbound({
  cfg: {},
  agentId: "imagebot",
  chatId,
  messageId: 9020,
  window: aliceAmmodelTarget.window,
  content: "ordinary bot answer",
});
assert.equal(
  harness.resolveTelegramImagebotLatestBotMessageId({
    cfg: {},
    agentId: "imagebot",
    window: aliceAmmodelTarget.window,
  }),
  9020,
  "model switch notification should be able to reply to the latest ordinary bot message in the window",
);
const recentBeforePersonaControl = harness.getStore().windows["window-C"].recent.length;
harness.updateTelegramImagebotWindowPersona({
  cfg: {},
  agentId: "imagebot",
  windowId: "window-C",
  persona: { id: "chihaya_anon", label: "千早爱音" },
});
assert.equal(
  harness.getStore().windows["window-C"].recent.length,
  recentBeforePersonaControl,
  "persona switch control events must not enter model-visible window recent context",
);

const aliceReplyOldWindowSequential = harness.resolveTelegramImagebotSequentialWindowId({
  cfg: {},
  agentId: "imagebot",
  accountId: "imagebot",
  chatId,
  isGroup: true,
  msg: {
    reply_to_message: {
      message_id: 9001,
      from: { id: botId },
    },
  },
  senderId: "100",
  botId,
  botUsername: "YOUR_BOT_USERNAME",
});

assert.equal(
  aliceReplyOldWindowSequential,
  "window-C",
  "same sender replying to an old bot message must stay in the sender's current active window",
);

harness.clearModelDefaultApplied();
const aliceReplyOldWindow = harness.resolveTelegramImagebotWindowContext({
  cfg: {},
  agentId: "imagebot",
  accountId: "imagebot",
  chatId,
  isGroup: true,
  baseSessionKey: windowC.sessionKey,
  msg: {
    reply_to_message: {
      message_id: 9001,
      from: { id: botId },
    },
  },
  senderId: "100",
  senderName: "Alice",
  botId,
});

assert.equal(aliceReplyOldWindow.windowId, "window-C");
assert.equal(aliceReplyOldWindow.sessionKey, windowC.sessionKey);
assert.equal(aliceReplyOldWindow.source, "sender");
assert.equal(
  harness.getStore().activeByUser["tg:100"].windowId,
  "window-C",
  "replying to an old window must not replace the sender's current active window",
);
assert.equal(
  harness.getModelDefaultApplied()?.sessionKey,
  windowC.sessionKey,
  "same-owner stale replies must sync the current /ammodel default before prompt construction",
);

harness.clearModelDefaultApplied();
const aliceStandaloneAfterOldReply = harness.resolveTelegramImagebotWindowContext({
  cfg: {},
  agentId: "imagebot",
  accountId: "imagebot",
  chatId,
  isGroup: true,
  baseSessionKey: windowC.sessionKey,
  msg: {},
  senderId: "100",
  senderName: "Alice",
  botId,
});

assert.equal(aliceStandaloneAfterOldReply.windowId, "window-C");
assert.equal(aliceStandaloneAfterOldReply.sessionKey, windowC.sessionKey);
assert.equal(aliceStandaloneAfterOldReply.source, "sender");
assert.equal(
  harness.getModelDefaultApplied()?.sessionKey,
  windowC.sessionKey,
  "existing sender-owned active windows must reapply the current /ammodel default before prompt construction",
);

const bobReplySequentialWindow = harness.resolveTelegramImagebotSequentialWindowId({
  cfg: {},
  agentId: "imagebot",
  accountId: "imagebot",
  chatId,
  isGroup: true,
  msg: {
    reply_to_message: {
      message_id: 9001,
      from: { id: botId },
    },
  },
  senderId: "200",
  botId,
  botUsername: "YOUR_BOT_USERNAME",
});

assert.equal(
  bobReplySequentialWindow,
  "window-B",
  "Telegram sequential lane must ignore inactive replied bot windows and fall back to the sender's active window",
);

const bobReplyToAliceWindow = harness.resolveTelegramImagebotWindowContext({
  cfg: {},
  agentId: "imagebot",
  accountId: "imagebot",
  chatId,
  isGroup: true,
  baseSessionKey: windowB.sessionKey,
  msg: {
    reply_to_message: {
      message_id: 9001,
      from: { id: botId },
    },
  },
  senderId: "200",
  senderName: "Bob",
  botId,
});

assert.equal(bobReplyToAliceWindow.windowId, "window-B");
assert.equal(bobReplyToAliceWindow.sessionKey, windowB.sessionKey);
assert.equal(bobReplyToAliceWindow.source, "sender");
assert.equal(bobReplyToAliceWindow.senderUserKey, "tg:200");
assert.equal(
  harness.getStore().activeByUser["tg:200"].windowId,
  "window-B",
  "replying into another window must not rebind the sender's standalone active window",
);
assert.equal(
  harness.getStore().windows["window-A"].participants["tg:200"],
  undefined,
  "replying to an inactive old window must not add the sender as a participant of that old thread",
);

const bobStandaloneAfterReply = harness.resolveTelegramImagebotWindowContext({
  cfg: {},
  agentId: "imagebot",
  accountId: "imagebot",
  chatId,
  isGroup: true,
  baseSessionKey: windowB.sessionKey,
  msg: {},
  senderId: "200",
  senderName: "Bob",
  botId,
});

assert.equal(bobStandaloneAfterReply.windowId, "window-B");
assert.equal(bobStandaloneAfterReply.sessionKey, windowB.sessionKey);
assert.equal(bobStandaloneAfterReply.source, "sender");

harness.clearModelDefaultApplied();
const aliceReplyToBobWindow = harness.resolveTelegramImagebotWindowContext({
  cfg: {},
  agentId: "imagebot",
  accountId: "imagebot",
  chatId,
  isGroup: true,
  baseSessionKey: windowA.sessionKey,
  msg: {
    reply_to_message: {
      message_id: 9002,
      from: { id: botId },
    },
  },
  senderId: "100",
  senderName: "Alice",
  botId,
});

assert.equal(aliceReplyToBobWindow.windowId, "window-B");
assert.equal(aliceReplyToBobWindow.sessionKey, windowB.sessionKey);
assert.equal(aliceReplyToBobWindow.source, "bot-reply");
assert.equal(
  harness.getStore().activeByUser["tg:100"].windowId,
  "window-C",
  "entering Bob's window by reply must not replace Alice's own standalone window",
);
assert.equal(
  harness.getModelDefaultApplied(),
  undefined,
  "cross-owner bot replies must not copy Alice's /ammodel default into Bob's session",
);

const closedStore = clone(baseStore);
closedStore.windows["window-A"].closedAt = "2026-06-18T01:00:00.000Z";
const closedHarness = buildHarness(snippet, closedStore);
const bobReplyToClosedAliceWindow = closedHarness.resolveTelegramImagebotWindowContext({
  cfg: {},
  agentId: "imagebot",
  accountId: "imagebot",
  chatId,
  isGroup: true,
  baseSessionKey: windowB.sessionKey,
  msg: {
    reply_to_message: {
      message_id: 9001,
      from: { id: botId },
    },
  },
  senderId: "200",
  senderName: "Bob",
  botId,
});

assert.equal(bobReplyToClosedAliceWindow.windowId, "window-B");
assert.equal(bobReplyToClosedAliceWindow.source, "sender");

console.log("imagebot window routing tests passed", { bot: name });

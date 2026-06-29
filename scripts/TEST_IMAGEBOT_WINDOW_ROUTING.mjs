import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const distDir = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Microsoft",
  "WinGet",
  "Packages",
  "OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe",
  "node-v24.15.0-win-x64",
  "node_modules",
  "openclaw",
  "dist",
);

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
  getWrites: () => globalThis.__writes
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
assert.equal(
  openStore.windows["window-A"].closedAt,
  undefined,
  "/amnew should only close the sender's current active window, not every archived/replyable window",
);

assert.equal(
  harness.resolveTelegramImagebotRecentActiveWindowId({
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
  harness.resolveTelegramImagebotRecentActiveWindowId({
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

const aliceAmmodelTarget = harness.resolveTelegramImagebotAmmodelTarget({
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

assert.equal(aliceAmmodelTarget.window.windowId, "window-A");
assert.equal(aliceAmmodelTarget.sessionKey, windowA.sessionKey);
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
      messageId: 9001,
    },
  },
  botId,
  botUsername: "YOUR_BOT_USERNAME",
});

assert.equal(bobClicksAliceAmmodelTarget.window.windowId, "window-A");
assert.equal(bobClicksAliceAmmodelTarget.sessionKey, windowA.sessionKey);
assert.equal(bobClicksAliceAmmodelTarget.ownerUserKey, "tg:100");
assert.equal(
  harness.isTelegramImagebotAmmodelOwnerAllowed({ senderId: "200", target: bobClicksAliceAmmodelTarget }),
  false,
  "a different group member clicking another user's /ammodel menu must be blocked",
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

assert.equal(harness.getStore().byBotMessage[`${chatId}:9010`].windowId, "window-A");
assert.equal(harness.getStore().byBotMessage[`${chatId}:9010`].ownerUserKey, "tg:100");
assert.equal(harness.getStore().byBotMessage[`${chatId}:9010`].sessionKey, windowA.sessionKey);

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
const recentBeforePersonaControl = harness.getStore().windows["window-A"].recent.length;
harness.updateTelegramImagebotWindowPersona({
  cfg: {},
  agentId: "imagebot",
  windowId: "window-A",
  persona: { id: "chihaya_anon", label: "千早爱音" },
});
assert.equal(
  harness.getStore().windows["window-A"].recent.length,
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
  "window-A",
  "same sender replying to an old bot message must use that old window, not the sender's current active window",
);

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

assert.equal(aliceReplyOldWindow.windowId, "window-A");
assert.equal(aliceReplyOldWindow.sessionKey, windowA.sessionKey);
assert.equal(aliceReplyOldWindow.source, "bot-reply");
assert.equal(
  harness.getStore().activeByUser["tg:100"].windowId,
  "window-C",
  "replying to an old window must not replace the sender's current active window",
);

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
  "window-A",
  "Telegram sequential lane must be resolved from replied bot message window before sender fallback",
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

assert.equal(bobReplyToAliceWindow.windowId, "window-A");
assert.equal(bobReplyToAliceWindow.sessionKey, windowA.sessionKey);
assert.equal(bobReplyToAliceWindow.source, "bot-reply");
assert.equal(bobReplyToAliceWindow.senderUserKey, "tg:200");
assert.equal(
  harness.getStore().activeByUser["tg:200"].windowId,
  "window-B",
  "replying into another window must not rebind the sender's standalone active window",
);
assert.ok(
  harness.getStore().windows["window-A"].participants["tg:200"],
  "replying into another window should add the sender as a participant of that group thread",
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

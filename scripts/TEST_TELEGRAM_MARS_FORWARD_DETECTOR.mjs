import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildImagebotConfig } from "./BUILD_IMAGEBOT_CONFIG.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
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

async function readDistFile(prefix, marker) {
  const names = await fsp.readdir(distDir);
  for (const name of names.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".js")).sort()) {
    const filePath = path.join(distDir, name);
    const source = await fsp.readFile(filePath, "utf8");
    if (source.includes(marker)) return { name, filePath, source };
  }
  throw new Error(`No ${prefix} dist file contains ${marker}`);
}

function normalizeForwardedContext(msg) {
  const origin = msg.forward_origin;
  if (!origin) return null;
  const chat = origin.chat || {};
  if (origin.type === "chat") {
    const senderChat = origin.sender_chat || chat;
    const title = senderChat.title || senderChat.username || String(senderChat.id || "");
    return {
      from: title,
      date: origin.date,
      fromType: "chat",
      fromId: senderChat.id != null ? String(senderChat.id) : undefined,
      fromUsername: senderChat.username,
      fromTitle: senderChat.title,
      fromSignature: origin.author_signature,
      fromChatType: senderChat.type,
      fromMessageId: origin.message_id,
    };
  }
  if (origin.type !== "channel") return null;
  const title = chat.title || chat.username || String(chat.id || "");
  return {
    from: title,
    date: origin.date,
    fromType: "channel",
    fromId: chat.id != null ? String(chat.id) : undefined,
    fromUsername: chat.username,
    fromTitle: chat.title,
    fromSignature: origin.author_signature,
    fromChatType: chat.type,
    fromMessageId: origin.message_id,
  };
}

const bot = await readDistFile("bot-", "TELEGRAM_MARS_FORWARD_DEFAULT_MAX_ENTRIES");
const start = bot.source.indexOf("const TELEGRAM_MARS_FORWARD_DEFAULT_MAX_ENTRIES");
const end = bot.source.indexOf("function resolveTelegramImagebotAmmodelDefaultStatePath", start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "telegram-mars-forward-"));
const context = {
  assert,
  console,
  createHash,
  Date,
  DatabaseSync,
  fs,
  path,
  process,
  URL,
  normalizeOptionalString(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return undefined;
  },
  resolveStorePath() {
    return path.join(tmp, "session-store.json");
  },
  getTelegramTextParts(msg) {
    return {
      text: msg.text ?? msg.caption ?? "",
      entities: msg.entities ?? msg.caption_entities ?? [],
    };
  },
  normalizeForwardedContext,
  resolveTelegramPrimaryMedia(msg) {
    if (Array.isArray(msg.photo) && msg.photo.length) return { placeholder: "<media:photo>" };
    if (msg.sticker) return { placeholder: "<media:sticker>" };
    return null;
  },
  buildSenderName(msg) {
    return [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() || msg.from?.username || "";
  },
  isTelegramSupportedReactionEmoji() {
    return true;
  },
  async withTelegramApiErrorLogging({ fn }) {
    return await fn();
  },
  logVerbose() {},
};
vm.createContext(context);
vm.runInContext(`${bot.source.slice(start, end)}\nglobalThis.__mars = { resolveTelegramMarsForwardConfig, resolveTelegramMarsForwardFingerprints, resolveTelegramMarsForwardFingerprint, trackTelegramMarsForwardCandidate, buildTelegramMarsForwardReviewPrompt, maybeReactToTelegramMarsForward };`, context);

const generated = await buildImagebotConfig({ write: false });
const interactionConfig = generated.configOps.find((op) => op.path === "plugins.entries.imagebot-interaction-core.config")?.value;
assert.equal(interactionConfig?.marsForwardDetector?.enabled, true);
assert.deepEqual(interactionConfig?.marsForwardDetector?.scriptReactKinds, ["channel_message", "canonical_url", "telegram_file"]);
assert.ok(interactionConfig?.marsForwardDetector?.maxEntries >= 100_000);
assert.equal(Object.hasOwn(interactionConfig?.marsForwardDetector || {}, "maxAgeDays"), false);
assert.equal(interactionConfig?.marsForwardDetector?.storageBackend, "sqlite");
assert.ok(interactionConfig?.marsForwardDetector?.sqlitePath?.endsWith("mars-forward-detector.sqlite"));
assert.ok(interactionConfig?.marsForwardDetector?.mediaDir?.includes(`${path.sep}.openclaw${path.sep}media${path.sep}mars-forward`));
assert.ok(interactionConfig?.marsForwardDetector?.maxMediaBytes <= 20 * 1024 * 1024);
assert.ok(interactionConfig?.marsForwardDetector?.maxMediaTotalBytes >= 100 * 1024 * 1024 * 1024);
assert.equal(interactionConfig?.marsForwardDetector?.pruneIntervalMs, 60 * 1000);
assert.equal(interactionConfig?.marsForwardDetector?.mediaIndexQueueLimit, 512);
assert.equal(interactionConfig?.marsForwardDetector?.mediaIndexMaxConcurrent, 1);
assert.equal(interactionConfig?.marsForwardDetector?.visualHashEnabled, true);
assert.equal(interactionConfig?.marsForwardDetector?.visualHashMaxDistance, 24);
assert.ok(Array.isArray(interactionConfig?.marsForwardDetector?.dependencyDirs));

const cfg = {
  session: { store: { dir: tmp } },
  plugins: {
    entries: {
      "imagebot-interaction-core": {
        config: {
          marsForwardDetector: {
            enabled: true,
            llmReview: true,
            reaction: "🔥",
            scriptReactKinds: ["channel_message"],
            statePath: path.join(tmp, "mars.json"),
            sqlitePath: path.join(tmp, "mars.sqlite"),
            maxEntries: 100,
          },
        },
      },
    },
  },
};
const detectorConfig = context.__mars.resolveTelegramMarsForwardConfig(cfg, "imagebot", "imagebot");
assert.equal(detectorConfig.maxAgeMs, null);
assert.equal(detectorConfig.storageBackend, "sqlite");
assert.equal(detectorConfig.sqlitePath, path.join(tmp, "mars.sqlite"));

const baseMessage = {
  message_id: 100,
  date: 1780000000,
  chat: { id: -100123, type: "supergroup", title: "Test group" },
  from: { id: 1, first_name: "Alice", username: "alice" },
  text: "Interesting forwarded post https://example.com/post?utm_source=x",
  entities: [{ type: "url", offset: 28, length: 41 }],
  forward_origin: {
    type: "channel",
    date: 1779999900,
    chat: { id: -100777, type: "channel", title: "Source Channel", username: "source" },
    message_id: 42,
  },
};

const baseFingerprints = context.__mars.resolveTelegramMarsForwardFingerprints(baseMessage, detectorConfig);
assert.ok(baseFingerprints.some((fingerprint) => fingerprint.kind === "channel_message"));
assert.ok(baseFingerprints.some((fingerprint) => fingerprint.kind === "canonical_url"));

const footerMessage = {
  ...baseMessage,
  message_id: 99,
  text: "Read https://example.com/post https://t.me/source https://t.me/source/7 https://t.me/id7371 https://x.com/intent/follow?screen_name=source",
  entities: [],
};
const footerFingerprints = context.__mars.resolveTelegramMarsForwardFingerprints(footerMessage, detectorConfig);
const footerUrls = Array.from(footerFingerprints, (fingerprint) => fingerprint.url).filter(Boolean);
assert.deepEqual(
  footerUrls,
  ["https://example.com/post"],
  "Mars URL fingerprints should ignore channel/profile/follow footer links",
);

const first = context.__mars.trackTelegramMarsForwardCandidate({
  config: detectorConfig,
  msg: baseMessage,
  chatId: baseMessage.chat.id,
  threadId: undefined,
  senderId: "1",
  senderUsername: "alice",
});
assert.equal(first.status, "first");
assert.equal(first.fingerprint.kind, "channel_message");
assert.ok(first.matchKeys.some((key) => key.startsWith("url:")));
assert.ok(fs.existsSync(detectorConfig.sqlitePath), "first Mars record should create SQLite state");
assert.equal(fs.existsSync(detectorConfig.statePath), false, "SQLite Mars state should not write new JSON state");

const duplicateMessage = {
  ...baseMessage,
  message_id: 101,
  from: { id: 2, first_name: "Bob", username: "bob" },
  date: 1780000060,
};
const duplicate = context.__mars.trackTelegramMarsForwardCandidate({
  config: detectorConfig,
  msg: duplicateMessage,
  chatId: duplicateMessage.chat.id,
  threadId: undefined,
  senderId: "2",
  senderUsername: "bob",
});
assert.equal(duplicate.status, "duplicate");
assert.equal(duplicate.hitCount, 2);
assert.equal(duplicate.first.messageId, "100");
assert.equal(duplicate.current.messageId, "101");

const prompt = context.__mars.buildTelegramMarsForwardReviewPrompt(duplicate);
assert.match(prompt, /Mars forward candidate/);
assert.match(prompt, /First seen: message 100/);
assert.match(prompt, /First same-group post: chat -100123 message 100/);
assert.match(prompt, /canonical_url|channel_message/);
assert.match(prompt, /Current message: 101/);
assert.match(prompt, /Source Channel/);

const sameUrlDifferentChannel = {
  ...baseMessage,
  message_id: 102,
  from: { id: 3, first_name: "Carol", username: "carol" },
  date: 1780000120,
  text: "Same link without tracking https://example.com/post",
  entities: [{ type: "url", offset: 27, length: 24 }],
  forward_origin: {
    type: "channel",
    date: 1780000100,
    chat: { id: -100778, type: "channel", title: "Another Channel", username: "another" },
    message_id: 55,
  },
};
const urlDuplicate = context.__mars.trackTelegramMarsForwardCandidate({
  config: detectorConfig,
  msg: sameUrlDifferentChannel,
  chatId: sameUrlDifferentChannel.chat.id,
  threadId: undefined,
  senderId: "3",
  senderUsername: "carol",
});
assert.equal(urlDuplicate.status, "duplicate");
assert.equal(urlDuplicate.fingerprint.kind, "canonical_url");
assert.equal(urlDuplicate.first.messageId, "100");

const sourceFooterFirstMessage = {
  message_id: 500,
  date: 1780000160,
  chat: baseMessage.chat,
  from: { id: 9, first_name: "Ivan", username: "ivan" },
  text: "Article A https://ourl.co/113665?t https://t.me/landiansub https://t.me/id7371 https://x.com/intent/follow?screen_name=landiantech https://t.me/landiansub/15535",
  entities: [],
  photo: [{ file_id: "footer-a-file", file_unique_id: "footer-a-unique", width: 1280, height: 720, file_size: 51524 }],
  forward_origin: {
    type: "channel",
    date: 1780000150,
    chat: { id: -1001125882855, type: "channel", title: "Landian", username: "landiansub" },
    message_id: 15846,
  },
};
const sourceFooterFirst = context.__mars.trackTelegramMarsForwardCandidate({
  config: detectorConfig,
  msg: sourceFooterFirstMessage,
  chatId: sourceFooterFirstMessage.chat.id,
  threadId: undefined,
  senderId: "9",
  senderUsername: "ivan",
});
assert.equal(sourceFooterFirst.status, "first");
assert.deepEqual(Array.from(sourceFooterFirst.current.match.urls), ["https://ourl.co/113665?t="]);

const sourceFooterSecondMessage = {
  ...sourceFooterFirstMessage,
  message_id: 501,
  date: 1780000170,
  from: { id: 10, first_name: "Judy", username: "judy" },
  text: "Article B https://ourl.co/113689?t https://t.me/landiansub https://t.me/id7371 https://x.com/intent/follow?screen_name=landiantech https://t.me/landiansub/15535",
  photo: [{ file_id: "footer-b-file", file_unique_id: "footer-b-unique", width: 1280, height: 720, file_size: 83446 }],
  forward_origin: {
    ...sourceFooterFirstMessage.forward_origin,
    message_id: 15863,
  },
};
const sourceFooterSecond = context.__mars.trackTelegramMarsForwardCandidate({
  config: detectorConfig,
  msg: sourceFooterSecondMessage,
  chatId: sourceFooterSecondMessage.chat.id,
  threadId: undefined,
  senderId: "10",
  senderUsername: "judy",
});
assert.equal(sourceFooterSecond.status, "first", "shared source footer URLs must not merge different channel posts");
assert.deepEqual(Array.from(sourceFooterSecond.current.match.urls), ["https://ourl.co/113689?t="]);

const mediaFirstMessage = {
  message_id: 300,
  date: 1780000200,
  chat: baseMessage.chat,
  from: { id: 4, first_name: "Dana", username: "dana" },
  caption: "image forward one",
  caption_entities: [],
  photo: [
    { file_id: "photo-small-a", file_unique_id: "photo-unique-small-a", width: 90, height: 90, file_size: 1234 },
    { file_id: "photo-large-a", file_unique_id: "photo-unique-large-a", width: 1280, height: 720, file_size: 4567 },
  ],
  forward_origin: {
    type: "channel",
    date: 1780000190,
    chat: { id: -100779, type: "channel", title: "Image Source A" },
    message_id: 12,
  },
};
const mediaFirst = context.__mars.trackTelegramMarsForwardCandidate({
  config: detectorConfig,
  msg: mediaFirstMessage,
  chatId: mediaFirstMessage.chat.id,
  threadId: undefined,
  senderId: "4",
  senderUsername: "dana",
});
assert.equal(mediaFirst.status, "first");
assert.ok(mediaFirst.matchKeys.includes("media:photo-unique-large-a"));

const mediaDuplicateMessage = {
  ...mediaFirstMessage,
  message_id: 301,
  from: { id: 5, first_name: "Eve", username: "eve" },
  caption: "different channel same image",
  forward_origin: {
    type: "channel",
    date: 1780000210,
    chat: { id: -100780, type: "channel", title: "Image Source B" },
    message_id: 88,
  },
};
const mediaDuplicate = context.__mars.trackTelegramMarsForwardCandidate({
  config: detectorConfig,
  msg: mediaDuplicateMessage,
  chatId: mediaDuplicateMessage.chat.id,
  threadId: undefined,
  senderId: "5",
  senderUsername: "eve",
});
assert.equal(mediaDuplicate.status, "duplicate");
assert.equal(mediaDuplicate.fingerprint.kind, "telegram_file");
assert.equal(mediaDuplicate.first.messageId, "300");

const visualHashA = {
  algorithm: "ahash8+dhash8+phash32",
  ahash: "ffffffffffffffff",
  dhash: "0000000000000000",
  phash: "aaaaaaaaaaaaaaaa",
};
const visualHashB = {
  algorithm: "ahash8+dhash8+phash32",
  ahash: "fffffffffffffffe",
  dhash: "0000000000000000",
  phash: "aaaaaaaaaaaaaaaa",
};
const visualFirstMessage = {
  ...mediaFirstMessage,
  message_id: 400,
  caption: "visually hashed first",
  photo: [{ file_id: "visual-a-file", file_unique_id: "visual-a-unique", width: 900, height: 900, file_size: 4321 }],
  forward_origin: {
    type: "channel",
    date: 1780000300,
    chat: { id: -100781, type: "channel", title: "Visual Source A" },
    message_id: 90,
  },
};
const visualFirst = context.__mars.trackTelegramMarsForwardCandidate({
  config: detectorConfig,
  msg: visualFirstMessage,
  chatId: visualFirstMessage.chat.id,
  threadId: undefined,
  senderId: "6",
  senderUsername: "frank",
  preparedMedia: [{
    kind: "photo",
    fileId: "visual-a-file",
    fileUniqueId: "visual-a-unique",
    width: 900,
    height: 900,
    fileSize: 4321,
    visualHash: visualHashA,
    visualHashStatus: "ready",
  }],
});
assert.equal(visualFirst.status, "first");
assert.ok(visualFirst.matchKeys.some((key) => key.startsWith("vhash:")));

const visualDuplicateMessage = {
  ...visualFirstMessage,
  message_id: 401,
  from: { id: 7, first_name: "Grace", username: "grace" },
  caption: "same image after light processing",
  photo: [{ file_id: "visual-b-file", file_unique_id: "visual-b-unique", width: 900, height: 900, file_size: 4322 }],
  forward_origin: {
    type: "channel",
    date: 1780000360,
    chat: { id: -100782, type: "channel", title: "Visual Source B" },
    message_id: 91,
  },
};
const visualDuplicate = context.__mars.trackTelegramMarsForwardCandidate({
  config: detectorConfig,
  msg: visualDuplicateMessage,
  chatId: visualDuplicateMessage.chat.id,
  threadId: undefined,
  senderId: "7",
  senderUsername: "grace",
  preparedMedia: [{
    kind: "photo",
    fileId: "visual-b-file",
    fileUniqueId: "visual-b-unique",
    width: 900,
    height: 900,
    fileSize: 4322,
    visualHash: visualHashB,
    visualHashStatus: "ready",
  }],
});
assert.equal(visualDuplicate.status, "duplicate");
assert.equal(visualDuplicate.fingerprint.kind, "visual_hash_similar");
assert.equal(visualDuplicate.first.messageId, "400");
assert.equal(visualDuplicate.matches.some((match) => match.visualDistance === 1), true);
const visualPrompt = context.__mars.buildTelegramMarsForwardReviewPrompt(visualDuplicate);
assert.match(visualPrompt, /Visual hash candidates/);

const visualHashC = {
  algorithm: "ahash8+dhash8+phash32",
  ahash: "fffffffffffffffc",
  dhash: "0000000000000000",
  phash: "aaaaaaaaaaaaaaaa",
};
const lateVisualMessage = {
  ...visualFirstMessage,
  message_id: 402,
  from: { id: 8, first_name: "Heidi", username: "heidi" },
  caption: "light index first, visual evidence later",
  photo: [{ file_id: "visual-c-file", file_unique_id: "visual-c-unique", width: 900, height: 900, file_size: 4323 }],
  forward_origin: {
    type: "channel",
    date: 1780000420,
    chat: { id: -100783, type: "channel", title: "Visual Source C" },
    message_id: 92,
  },
};
const lateVisualLight = context.__mars.trackTelegramMarsForwardCandidate({
  config: detectorConfig,
  msg: lateVisualMessage,
  chatId: lateVisualMessage.chat.id,
  threadId: undefined,
  senderId: "8",
  senderUsername: "heidi",
});
assert.equal(lateVisualLight.status, "first");
const lateVisualPrepared = context.__mars.trackTelegramMarsForwardCandidate({
  config: detectorConfig,
  msg: lateVisualMessage,
  chatId: lateVisualMessage.chat.id,
  threadId: undefined,
  senderId: "8",
  senderUsername: "heidi",
  preparedMedia: [{
    kind: "photo",
    fileId: "visual-c-file",
    fileUniqueId: "visual-c-unique",
    width: 900,
    height: 900,
    fileSize: 4323,
    visualHash: visualHashC,
    visualHashStatus: "ready",
  }],
});
assert.equal(lateVisualPrepared.status, "duplicate");
assert.equal(lateVisualPrepared.fingerprint.kind, "visual_hash_similar");
assert.equal(lateVisualPrepared.first.messageId, "400");

assert.equal(
  context.__mars.resolveTelegramMarsForwardFingerprint({
    message_id: 200,
    chat: baseMessage.chat,
    text: "https://example.com/post",
    entities: [{ type: "url", offset: 0, length: 24 }],
  }, detectorConfig),
  null,
);

const urlForward = {
  message_id: 201,
  chat: baseMessage.chat,
  text: "https://example.com/post?utm_source=copy",
  entities: [{ type: "url", offset: 0, length: 40 }],
  forward_origin: { type: "hidden_user", sender_user_name: "Hidden", date: 1780000000 },
};
const urlFingerprint = context.__mars.resolveTelegramMarsForwardFingerprint(urlForward, detectorConfig);
assert.equal(urlFingerprint, null);

const groupForward = {
  message_id: 202,
  chat: baseMessage.chat,
  text: "Forwarded inside-group post https://example.com/post",
  entities: [{ type: "url", offset: 28, length: 24 }],
  forward_origin: {
    type: "chat",
    date: 1780000000,
    sender_chat: { id: -100888, type: "supergroup", title: "Other Group" },
    message_id: 77,
  },
};
const groupFingerprint = context.__mars.resolveTelegramMarsForwardFingerprint(groupForward, detectorConfig);
assert.equal(groupFingerprint, null);

let reacted = false;
const reactionOk = await context.__mars.maybeReactToTelegramMarsForward({
  config: detectorConfig,
  result: duplicate,
  reactionApi: async (_chatId, _messageId, reactions) => {
    reacted = reactions[0]?.emoji === "🔥";
  },
  chatId: duplicateMessage.chat.id,
  messageId: duplicateMessage.message_id,
  runtime: {},
});
assert.equal(reactionOk, true);
assert.equal(reacted, true);

const visualReactionOk = await context.__mars.maybeReactToTelegramMarsForward({
  config: detectorConfig,
  result: visualDuplicate,
  reactionApi: async () => {
    throw new Error("visual candidates should not script-react");
  },
  chatId: visualDuplicateMessage.chat.id,
  messageId: visualDuplicateMessage.message_id,
  runtime: {},
});
assert.equal(visualReactionOk, false);

console.log("telegram mars forward detector ok");

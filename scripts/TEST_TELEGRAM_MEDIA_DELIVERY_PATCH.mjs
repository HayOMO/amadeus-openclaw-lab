import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { resolveOpenClawDistDir } from "./OPENCLAW_RUNTIME_PATHS.mjs";

const distDir = resolveOpenClawDistDir();

async function readDistFile(prefix, requiredMarker) {
  const names = await fs.readdir(distDir);
  for (const name of names.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".js")).sort()) {
    const filePath = path.join(distDir, name);
    const source = await fs.readFile(filePath, "utf8");
    if (!requiredMarker || source.includes(requiredMarker)) return { name, source, filePath };
  }
  throw new Error(`No dist file found for ${prefix} with marker ${requiredMarker || "(none)"}`);
}

async function readDistFileAny(candidates) {
  const errors = [];
  for (const candidate of candidates) {
    try {
      return await readDistFile(candidate.prefix, candidate.marker);
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`No dist file found for any candidate:\n${errors.join("\n")}`);
}

const bot = await readDistFile("bot-", "createTelegramBotCore");
const delivery = await readDistFile("delivery-", "deliverReplies");
const payloads = await readDistFile("payloads-", "parseReplyDirectives");
const actionRuntime = await readDistFile("action-runtime-", "handleTelegramAction");
const replyTurnAdmission = await readDistFileAny([
  { prefix: "reply-turn-admission-", marker: "IMAGEBOT_MEDIA_DIRECTIVE_TOKEN_RE" },
  { prefix: "reply-usage-state-", marker: "IMAGEBOT_MEDIA_DIRECTIVE_TOKEN_RE" },
]);
const outboundAdapter = await readDistFile("outbound-adapter-", "createTelegramOutboundAdapter");
const telegramSend = await readDistFile("send-", "withTelegramNativeSpoiler");
const openclawTools = await readDistFile("openclaw-tools-", "forceDocument");
const botDeps = await readDistFile("bot-deps-", "syncTelegramMenuCommands");
const commandDetection = await readDistFile("command-detection-", "listConfiguredTelegramCustomCommandAliases");
const dispatch = await readDistFile("dispatch-", "dispatchReplyFromConfig");
const sentCache = await readDistFile("sent-message-cache-", "resolveTelegramPrimaryMedia");
const browserPluginService = await readDistFile("plugin-service-", "createBrowserTool");
const embeddedTools = await readDistFileAny([
  { prefix: "embedded-agent-subscribe.tools-", marker: "TRUSTED_TOOL_RESULT_MEDIA" },
  { prefix: "embedded-agent-message-tool-source-reply-", marker: "TRUSTED_TOOL_RESULT_MEDIA" },
]);
const embeddedAgent = await readDistFile("embedded-agent-", "resolveSelectedOpenAIRuntimeProvider");
const embeddedPayloads = await readDistFileAny([
  { prefix: "payloads-", marker: "buildEmbeddedRunPayloads" },
  { prefix: "embedded-agent-", marker: "buildEmbeddedRunPayloads" },
]);
const selection = await readDistFile("selection-", "queuePendingToolMedia");
const getReply = await readDistFile("get-reply-", "applyMediaUnderstandingIfNeeded");
const turnKernel = await readDistFile("kernel-", "sendDurableMessageBatch");
const imagebotModelCatalog = JSON.parse(await fs.readFile(path.join(process.cwd(), "scripts", "IMAGEBOT_MODEL_PROFILES.json"), "utf8"));

function extractFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function not found: ${name}`);
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `function has no body: ${name}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function body did not close: ${name}`);
}

function extractConstSource(source, name) {
  const start = source.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `const not found: ${name}`);
  const arrow = source.indexOf("=>", start);
  assert.ok(arrow >= 0, `const is not an arrow function: ${name}`);
  const bodyStart = source.indexOf("{", arrow);
  const semicolonBeforeBody = source.indexOf(";", arrow);
  if (bodyStart < 0 || semicolonBeforeBody < bodyStart) {
    assert.ok(semicolonBeforeBody >= 0, `const declaration has no semicolon: ${name}`);
    return source.slice(start, semicolonBeforeBody + 1);
  }
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const end = source.indexOf(";", index);
        assert.ok(end >= 0, `const declaration has no closing semicolon: ${name}`);
        return source.slice(start, end + 1);
      }
    }
  }
  throw new Error(`const body did not close: ${name}`);
}

const payloadsModule = await import(pathToFileURL(payloads.filePath).href);
const parseReplyDirectives = payloadsModule.d;
const normalizeCommandModule = await import(pathToFileURL(path.join(distDir, "commands-registry-normalize-IpIeXL3a.js")).href);
const scriptCommandParserContext = {
  normalizeCommandBody: normalizeCommandModule.r,
  normalizeLowercaseStringOrEmpty(value) {
    return String(value ?? "").trim().toLowerCase();
  },
  getTelegramTextParts(msg) {
    return { text: String(msg?.text ?? msg?.caption ?? "") };
  },
};
vm.createContext(scriptCommandParserContext);
vm.runInContext(`
${extractFunctionSource(bot.source, "parseImagebotTextCommandParts")}
${extractFunctionSource(bot.source, "parseImagebotScriptControlCommand")}
${extractFunctionSource(bot.source, "parseImagebotUnsupportedControlCommand")}
${extractFunctionSource(bot.source, "formatTelegramImagebotNumber")}
${extractFunctionSource(bot.source, "clampTelegramImagebotInteger")}
${extractFunctionSource(bot.source, "splitTelegramImagebotListArgs")}
${extractFunctionSource(bot.source, "shuffleTelegramImagebotItems")}
${extractFunctionSource(bot.source, "buildTelegramImagebotRollText")}
${extractFunctionSource(bot.source, "buildTelegramImagebotCoinText")}
${extractFunctionSource(bot.source, "buildTelegramImagebotChooseText")}
${extractFunctionSource(bot.source, "buildTelegramImagebotShuffleText")}
${extractFunctionSource(bot.source, "buildTelegramImagebotSplitText")}
${extractFunctionSource(bot.source, "resolveTelegramImagebotTextPayload")}
${extractFunctionSource(bot.source, "buildTelegramImagebotStatsText")}
${extractFunctionSource(bot.source, "buildTelegramImagebotLinksText")}
${extractFunctionSource(bot.source, "buildTelegramImagebotMicroCommandText")}
globalThis.parseImagebotScriptControlCommand = parseImagebotScriptControlCommand;
globalThis.parseImagebotUnsupportedControlCommand = parseImagebotUnsupportedControlCommand;
globalThis.buildTelegramImagebotMicroCommandText = buildTelegramImagebotMicroCommandText;
`, scriptCommandParserContext);
const parseImagebotScriptControlCommandForTest = scriptCommandParserContext.parseImagebotScriptControlCommand;
const parseImagebotUnsupportedControlCommandForTest = scriptCommandParserContext.parseImagebotUnsupportedControlCommand;
const buildTelegramImagebotMicroCommandTextForTest = scriptCommandParserContext.buildTelegramImagebotMicroCommandText;
const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
assert.deepEqual(
  plain(parseImagebotScriptControlCommandForTest("/amhelp@YOUR_BOT_USERNAME tools", { channels: { telegram: {} } }, {
    accountId: "imagebot",
    botUsername: "amaduse_bot",
  })),
  { name: "amhelp", args: "tools" },
  "script controls must not depend on configured customCommands",
);
assert.deepEqual(
  plain(parseImagebotScriptControlCommandForTest("\uff0famstatus", {}, { accountId: "imagebot" })),
  { name: "amstatus", args: "" },
  "full-width slash status command should still short-circuit before model dispatch",
);
assert.deepEqual(
  plain(parseImagebotScriptControlCommandForTest("/amtools run cleanup", {}, { accountId: "imagebot" })),
  { name: "amtools", args: "run cleanup" },
  "amtools safety refusal path must be reachable without model dispatch",
);
assert.deepEqual(
  plain(parseImagebotScriptControlCommandForTest("/amroll 2d6", {}, { accountId: "imagebot" })),
  { name: "amroll", args: "2d6" },
  "micro script commands must be parsed before model dispatch",
);
assert.deepEqual(
  plain(parseImagebotScriptControlCommandForTest("\uff0famstats", {}, { accountId: "imagebot" })),
  { name: "amstats", args: "" },
  "full-width slash micro script commands must also be parsed",
);
assert.equal(
  parseImagebotScriptControlCommandForTest("/amhelp", {}, { accountId: "default" }),
  null,
  "script controls stay scoped to the imagebot account",
);
assert.deepEqual(
  plain(parseImagebotUnsupportedControlCommandForTest("/model spark", { accountId: "imagebot" })),
  { name: "model", args: "spark" },
  "legacy /model commands must be caught before model dispatch",
);
assert.deepEqual(
  plain(parseImagebotUnsupportedControlCommandForTest("\uff0fmodel spark", { accountId: "imagebot" })),
  { name: "model", args: "spark" },
  "full-width slash legacy /model commands must also be caught",
);
assert.equal(
  parseImagebotUnsupportedControlCommandForTest("/model spark", { accountId: "default" }),
  null,
  "legacy /model interception stays scoped to the imagebot account",
);
assert.match(
  buildTelegramImagebotMicroCommandTextForTest({ name: "amroll", args: "2d6" }, {}),
  /^掷骰 2d6：[1-6], [1-6] \| 合计=\d+$/,
);
assert.match(
  buildTelegramImagebotMicroCommandTextForTest({ name: "amchoose", args: "red | blue | green" }, {}),
  /^选中：(red|blue|green)$/,
);
assert.match(
  buildTelegramImagebotMicroCommandTextForTest({ name: "amstats", args: "" }, { reply_to_message: { text: "hello world\nagain" } }),
  /词元数=3/,
);
assert.match(
  buildTelegramImagebotMicroCommandTextForTest({ name: "amlinks", args: "see https://example.com/a, and http://example.org" }, {}),
  /1\. https:\/\/example\.com\/a/,
);

let repeaterNow = 1_000_000;
const repeaterContext = {
  accountId: "imagebot",
  opts: { botInfo: { id: 9000, username: "YOUR_BOT_USERNAME" } },
  bot: { botInfo: { id: 9000, username: "YOUR_BOT_USERNAME" } },
  Date: { now: () => repeaterNow },
  Math,
  Number,
  String,
  Boolean,
  Map,
  getTelegramTextParts(msg) {
    return { text: String(msg?.text ?? msg?.caption ?? ""), entities: msg?.entities ?? msg?.caption_entities ?? [] };
  },
  hasBotMention(msg, botUsername) {
    return String(msg?.text ?? msg?.caption ?? "").toLowerCase().includes(`@${botUsername}`);
  },
};
vm.createContext(repeaterContext);
vm.runInContext(`
const preDropImagebotTextRepeaterState = new Map();
${extractConstSource(bot.source, "readPreDropImagebotTextRepeaterNumber")}
${extractConstSource(bot.source, "resolvePreDropImagebotTextRepeaterConfig")}
${extractConstSource(bot.source, "compactPreDropImagebotTextRepeaterState")}
${extractConstSource(bot.source, "preDropImagebotRepeaterSenderKey")}
${extractConstSource(bot.source, "preDropImagebotRepeaterScopeKey")}
${extractConstSource(bot.source, "resolvePreDropImagebotTextRepeaterText")}
${extractConstSource(bot.source, "resolvePreDropImagebotRepeatableItem")}
${extractConstSource(bot.source, "shouldIgnorePreDropImagebotTextRepeaterMessage")}
${extractConstSource(bot.source, "recordPreDropImagebotTextRepeaterMessage")}
globalThis.resolvePreDropImagebotTextRepeaterConfig = resolvePreDropImagebotTextRepeaterConfig;
globalThis.recordPreDropImagebotTextRepeaterMessage = recordPreDropImagebotTextRepeaterMessage;
`, repeaterContext);
const repeaterOptions = repeaterContext.resolvePreDropImagebotTextRepeaterConfig({
  plugins: {
    entries: {
      "imagebot-interaction-core": {
        config: {
          textRepeater: {
            enabled: true,
            groupOnly: true,
            repeatText: true,
            repeatStickers: true,
            requireDifferentSenders: true,
            maxGapMs: 30000,
            minCount: 2,
            cooldownMs: 30000,
            stateTtlMs: 600000,
          },
        },
      },
    },
  },
});
const repeatRecord = repeaterContext.recordPreDropImagebotTextRepeaterMessage;
const repeatMessage = ({ chatId, messageId, senderId, text, stickerFileId, stickerUniqueId }) => ({
  message_id: messageId,
  chat: { id: chatId, type: "supergroup" },
  from: { id: senderId, is_bot: false },
  ...(text == null ? {} : { text }),
  ...(stickerFileId ? { sticker: { file_id: stickerFileId, file_unique_id: stickerUniqueId || stickerFileId } } : {}),
});
repeaterNow = 1_000_000;
assert.equal(repeatRecord(repeatMessage({ chatId: -1001, messageId: 1, senderId: 11, text: "复读测试" }), repeaterOptions, "amaduse_bot").shouldRepeat, false);
repeaterNow += 1000;
assert.equal(repeatRecord(repeatMessage({ chatId: -1001, messageId: 2, senderId: 22, text: "复读测试" }), repeaterOptions, "amaduse_bot").shouldRepeat, true);
repeaterNow = 2_000_000;
assert.equal(repeatRecord(repeatMessage({ chatId: -1002, messageId: 1, senderId: 11, text: "同人连发" }), repeaterOptions, "amaduse_bot").shouldRepeat, false);
repeaterNow += 1000;
assert.equal(repeatRecord(repeatMessage({ chatId: -1002, messageId: 2, senderId: 11, text: "同人连发" }), repeaterOptions, "amaduse_bot").shouldRepeat, false);
repeaterNow = 3_000_000;
assert.equal(repeatRecord(repeatMessage({ chatId: -1003, messageId: 1, senderId: 11, text: "超时复读" }), repeaterOptions, "amaduse_bot").shouldRepeat, false);
repeaterNow += 31000;
assert.equal(repeatRecord(repeatMessage({ chatId: -1003, messageId: 2, senderId: 22, text: "超时复读" }), repeaterOptions, "amaduse_bot").shouldRepeat, false);
repeaterNow = 4_000_000;
assert.equal(repeatRecord(repeatMessage({ chatId: -1004, messageId: 1, senderId: 11, stickerFileId: "sticker-file-a", stickerUniqueId: "sticker-unique-a" }), repeaterOptions, "amaduse_bot").shouldRepeat, false);
repeaterNow += 1000;
const stickerRepeat = repeatRecord(repeatMessage({ chatId: -1004, messageId: 2, senderId: 22, stickerFileId: "sticker-file-b", stickerUniqueId: "sticker-unique-a" }), repeaterOptions, "amaduse_bot");
assert.equal(stickerRepeat.shouldRepeat, true);
assert.equal(stickerRepeat.kind, "sticker");

assert.equal(parseReplyDirectives("found\nMEDIA:C:/tmp/a.jpg").sensitiveMedia, undefined);
assert.equal(
  parseReplyDirectives("found, NSFW, \u614e\u70b9\nMEDIA:C:/tmp/a.jpg", { inferSensitiveMediaFromText: true }).sensitiveMedia,
  undefined,
  "ordinary MEDIA must not infer Telegram spoiler from reply text",
);
assert.equal(
  parseReplyDirectives("\u4e0d\u662fNSFW\uff0c\u666e\u901a\u56fe\nMEDIA:C:/tmp/a.jpg", { inferSensitiveMediaFromText: true }).sensitiveMedia,
  undefined,
);
assert.equal(
  parseReplyDirectives("\u4e0d\u9700\u8981 spoiler\uff0c\u666e\u901a\u53d1\nMEDIA:C:/tmp/a.jpg", { inferSensitiveMediaFromText: true }).sensitiveMedia,
  undefined,
);
assert.equal(parseReplyDirectives("found\nSPOILER_MEDIA:C:/tmp/a.jpg").sensitiveMedia, true);

assert.match(bot.source, /msg\.animation/);
assert.match(bot.source, /import fs from "node:fs";/);
assert.match(delivery.source, /function stickerFileNameForMedia/);
assert.match(delivery.source, /function stickerMimeTypeForMedia/);
assert.match(delivery.source, /msg\.sticker/);
assert.match(delivery.source, /application\/x-tgsticker/);
assert.match(delivery.source, /sticker\.is_video\) return `\$\{base\}\.webm`/);
assert.match(delivery.source, /sticker\.is_video\) return "video\/webm"/);
assert.match(delivery.source, /function stickerFormatForMedia/);
assert.match(delivery.source, /format: stickerFormatForMedia\(sticker\)/);
assert.match(delivery.source, /fileName: stickerFileNameForMedia\(sticker\)/);
assert.match(bot.source, /stickerMetadata: media\.stickerMetadata/);
assert.match(bot.source, /ReplySticker: replyStickerMetadata/);
assert.match(bot.source, /ReplyStickerMediaIncluded: replyStickerMetadata/);
assert.match(bot.source, /TELEGRAM_MARS_FORWARD_DEFAULT_MAX_ENTRIES/);
assert.match(bot.source, /DatabaseSync/);
assert.match(bot.source, /mars_forward_records/);
assert.match(bot.source, /function resolveTelegramMarsForwardFingerprint/);
assert.match(bot.source, /function trackTelegramMarsForwardCandidate/);
assert.match(bot.source, /function buildTelegramMarsForwardReviewPrompt/);
assert.match(bot.source, /maybeHandleTelegramMarsForwardCandidate/);
assert.match(bot.source, /function enqueueTelegramMarsForwardMediaIndex/);
assert.match(bot.source, /maybePruneTelegramMarsForwardStore\(store, config, nowMs\)/);
assert.match(bot.source, /prepareMediaEvidence === true \? await prepareTelegramMarsForwardMediaEvidence/);
assert.match(bot.source, /marsForwardReviewPrompt/);
assert.match(bot.source, /scriptReactKinds/);
assert.match(bot.source, /const mechanicalDuplicate = detectorConfig\.scriptReactKinds\.has\(result\.fingerprint\.kind\);/);
assert.doesNotMatch(bot.source, /const replyMessageId = Number\.isFinite\(firstMessageId\) \? firstMessageId : params\.msg\.message_id;/);
assert.match(bot.source, /const sendScriptMarsReply = async \(text, messageId, threadId\) =>/);
assert.match(bot.source, /bot\.api\.sendMessage\(params\.chatId, text/);
assert.match(bot.source, /message_id: messageId/);
assert.match(bot.source, /\\u706b\\u661f\\uff0c\\u4f46\\u662f\\u9996\\u53d1\\u6d88\\u606f\\u4e0d\\u89c1\\u4e86\\u3002/);
assert.match(bot.source, /recordSentMessage\(params\.chatId, sentMessage\.message_id, runtimeCfg\)/);
assert.match(bot.source, /shouldDispatch: !mechanicalDuplicate && detectorConfig\.llmReview/);
assert.match(bot.source, /scriptReplied: review\.scriptReplied/);
assert.match(bot.source, /import \{ pathToFileURL \} from "node:url";/);
assert.match(bot.source, /import\(pathToFileURL\(config\.modulePath\)\.href\)/);
assert.match(bot.source, /function resolveTelegramLoliNsfwVisionGuardConfig/);
assert.match(bot.source, /function applyTelegramLoliNsfwVisionGuard/);
assert.match(bot.source, /function filterTelegramLoliNsfwGuardFailureMedia/);
assert.match(bot.source, /function formatTelegramLoliNsfwGuardError/);
assert.match(bot.source, /const errorMessage = formatTelegramLoliNsfwGuardError\(err\);/);
assert.match(bot.source, /failed_closed/);
assert.match(bot.source, /loliNsfwVisionGuard/);
assert.match(bot.source, /SafetyReview/);
assert.match(bot.source, /params\.accountId === "imagebot" && params\.senderId/);
assert.match(bot.source, /shouldDropUnaddressedImagebotGroupMessage/);
assert.doesNotMatch(bot.source, /IMAGEBOT_FALLBACK_TEXT_COMMANDS/);
assert.match(bot.source, /parseImagebotAllowedTextCommand/);
assert.match(bot.source, /isImagebotAllowedTextCommand/);
assert.match(bot.source, /isImagebotAmnewCommand/);
assert.match(bot.source, /parseImagebotAmmodelCommand/);
assert.match(bot.source, /parseImagebotAmpersonaCommand/);
assert.match(bot.source, /parseImagebotScriptControlCommand/);
assert.match(bot.source, /parseImagebotUnsupportedControlCommand/);
assert.match(bot.source, /buildTelegramImagebotHelpText/);
assert.match(bot.source, /formatTelegramImagebotUsageLine/);
assert.match(bot.source, /buildTelegramImagebotMicroCommandText/);
assert.match(bot.source, /buildTelegramImagebotRollText/);
assert.match(bot.source, /buildTelegramImagebotLinksText/);
assert.match(bot.source, /handleImagebotUnsupportedControlBeforeModel/);
assert.match(bot.source, /buildTelegramImagebotScriptControlKeyboard/);
assert.match(bot.source, /handleImagebotScriptControlBeforeModel/);
assert.match(bot.source, /handleImagebotAmmodelBeforeModel/);
assert.match(bot.source, /handleImagebotAmpersonaBeforeModel/);
assert.match(bot.source, /handleImagebotTextRepeaterBeforeModel/);
assert.match(bot.source, /resolveImagebotTextRepeaterConfig/);
assert.match(bot.source, /imagebotTextRepeaterState/);
assert.match(bot.source, /plugins\?\.entries\?\.\["imagebot-interaction-core"\]\?\.config\?\.textRepeater/);
assert.match(bot.source, /ignoreExplicitBotMention/);
assert.match(bot.source, /hasBotMention\(msg, botUsername\)/);
assert.match(bot.source, /bot\.api\.sendMessage\(msg\.chat\.id, decision\.text/);
assert.match(bot.source, /applyTelegramImagebotAmmodelSession/);
assert.match(bot.source, /updateSessionStoreEntry\(\{\s*storePath,\s*sessionKey: params\.sessionKey,/s);
assert.doesNotMatch(bot.source, /await updateSessionStore\(/, "/ammodel must use the imported session-store runtime helper, not an undefined whole-store helper");
assert.match(bot.source, /resolveTelegramImagebotAmmodelDefaultStatePath/);
assert.match(bot.source, /resolveTelegramImagebotAmmodelSeedStatePath/);
assert.match(bot.source, /OPENCLAW_IMAGEBOT_MODEL_STATE_FILE/);
assert.match(bot.source, /\.openclaw", "imagebot", "model-state\.json"/);
assert.match(bot.source, /config", "imagebot", "model-state\.json"/);
assert.match(bot.source, /writeTelegramImagebotAmmodelDefaultState\(params\.cfg, params\.agentId, defaultState\)/);
assert.match(bot.source, /const appliedDefaultModel = applyModelOverrideToSessionEntry\(\{/);
assert.match(bot.source, /let changed = appliedDefaultModel\?\.updated === true;/);
assert.match(bot.source, /if \(!changed\) return false;/);
assert.doesNotMatch(bot.source, /entry\.thinkingLevel = state\.reasoningEffort;\s*entry\.liveModelSwitchPending = true;\s*entry\.updatedAt = Date\.now\(\);/);
assert.match(bot.source, /applyTelegramImagebotAmmodelDefaultToSessionSync\(\{\s*cfg: params\.cfg,\s*agentId: params\.agentId,\s*sessionKey: windowEntry\.sessionKey\s*\}\)/s);
assert.match(bot.source, /source !== "new-sender-window" && windowEntry\?\.sessionKey && normalizeOptionalString\(windowEntry\.ownerUserKey\)\?\.trim\(\) === senderUserKey/);
assert.match(bot.source, /applyTelegramImagebotAmmodelDefaultToSessionSync\(\{\s*cfg: params\.cfg,\s*agentId: params\.agentId,\s*sessionKey\s*\}\)/s);
assert.match(bot.source, /buildTelegramImagebotAmmodelKeyboard/);
assert.match(bot.source, /buildTelegramImagebotPersonaKeyboard/);
assert.match(bot.source, /TELEGRAM_IMAGEBOT_PERSONA_MENU_PAGE_SIZE/);
assert.match(bot.source, /callback_data: `\/ampersona page \$\{Math\.max\(0, currentPage - 1\)\}`/);
assert.match(bot.source, /loadTelegramImagebotAmmodelCatalog/);
assert.match(bot.source, /models_cache\.json/);
assert.match(bot.source, /model\?\.supported_in_api === true/);
assert.match(bot.source, /model\?\.input_modalities/);
assert.doesNotMatch(bot.source, /listCodexAppServerModels/);
assert.doesNotMatch(bot.source, /const runtimeModels = await loadModelCatalog\(\{ config: cfg \}\)/);
assert.match(bot.source, /const catalog = await loadTelegramImagebotAmmodelCatalog\(freshCfg, target\.agentId\)/);
assert.match(bot.source, /loadTelegramImagebotPersonaCatalog/);
assert.match(bot.source, /TELEGRAM_IMAGEBOT_AMMODEL_MODELS/);
assert.match(bot.source, /openai\/gpt-5\.4-mini/);
assert.equal(
  imagebotModelCatalog.models.find((model) => model.id === "openai/gpt-5.3-codex-spark")?.enabled,
  false,
  "project model catalog must exclude Spark from the backend API route",
);
assert.equal(
  imagebotModelCatalog.models.find((model) => model.id === "openai/gpt-5.3-codex-spark")?.toolPolicy,
  "chat-only",
  "project model catalog must keep Spark under chat-only tool policy",
);
assert.equal(
  imagebotModelCatalog.profiles.some((profile) => profile.id === "spark"),
  false,
  "project model catalog must not expose a Spark /ammodel profile",
);
assert.match(bot.source, /getTelegramImagebotAmmodelProfilesForModel/);
assert.match(bot.source, /IMAGEBOT_MODEL_PROFILES\.json/);
assert.match(bot.source, /callback_data: `\/ammodel model \$\{model\.id\}`/);
assert.match(bot.source, /callback_data: `\/ammodel model \$\{modelRef\} think \$\{level\}`/);
assert.match(bot.source, /callback_data: `\/ampersona set \$\{persona\.id\}`/);
assert.match(bot.source, /callback_data: "\/ampersona default"/);
assert.doesNotMatch(bot.source, /callback_data: `\/ammodel profile \$\{profile\.id\}`/);
assert.match(bot.source, /callback_data: "\/ammodel models"/);
assert.match(bot.source, /< 返回模型/);
assert.match(bot.source, /__imagebotAmmodelCallback/);
assert.match(bot.source, /__imagebotAmpersonaCallback/);
assert.match(bot.source, /callbackId: callback\.id/);
assert.match(bot.source, /const editImagebotControlText = async/);
assert.match(bot.source, /editMessageText\(callbackEdit\.chatId \?\? msg\.chat\.id, callbackEdit\.messageId/);
assert.match(bot.source, /reply_markup: replyMarkup \?\? \{ inline_keyboard: \[\] \}/);
assert.match(bot.source, /answerCallbackQuery\(callback\.id\)/);
assert.match(bot.source, /recordTelegramImagebotAmmodelMessage/);
assert.match(bot.source, /isTelegramImagebotAmmodelOwnerAllowed/);
assert.match(bot.source, /resolveTelegramImagebotLatestBotMessageId/);
assert.match(bot.source, /model switched to \$\{label\}/);
assert.match(bot.source, /telegram imagebot \/ammodel: applied \$\{label\} to \$\{target\.sessionKey\}/);
assert.match(bot.source, /clearImagebotControlKeyboard/);
assert.match(bot.source, /editMessageReplyMarkup\(callbackEdit\.chatId \?\? msg\.chat\.id, callbackEdit\.messageId/);
/*
assert.match(bot.source, /模型已切换至：/);
assert.doesNotMatch(bot.source, /sendModelMessage\(`已切换：/);
assert.doesNotMatch(bot.source, /const personaLines = getTelegramImagebotPersonas/);
*/
assert.doesNotMatch(bot.source, /const personaLines = getTelegramImagebotPersonas/);
assert.doesNotMatch(bot.source, /const modelLines = getTelegramImagebotAmmodelModels/);
assert.match(bot.source, /untrustedCallback/);
assert.match(bot.source, /blocked non-owner/);
assert.match(bot.source, /resolveTelegramImagebotActiveWindowId/);
assert.match(bot.source, /TELEGRAM_IMAGEBOT_WINDOW_IDLE_CLOSE_MS = 30 \* 60 \* 1000/);
assert.match(bot.source, /TELEGRAM_IMAGEBOT_ACTIVE_WINDOW_TRIGGER_MAX_AGE_MS = TELEGRAM_IMAGEBOT_WINDOW_IDLE_CLOSE_MS/);
assert.match(bot.source, /resolveTelegramImagebotRecentActiveWindowId/);
assert.match(bot.source, /closedReason = normalizeOptionalString\(params\.closedReason\)\?\.trim\(\) \|\| "replaced-by-amnew"/);
assert.match(bot.source, /previousWindow\.replacedByWindowId = windowId/);
assert.match(bot.source, /openTelegramImagebotWindow/);
assert.match(bot.source, /activeByUser/);
assert.match(bot.source, /resolveTelegramImagebotUsableWindow/);
assert.match(bot.source, /candidate\.closedAt/);
assert.match(bot.source, /function closeTelegramImagebotIdleWindows/);
assert.match(bot.source, /idle-window-timeout/);
assert.match(bot.source, /function closeTelegramImagebotInactiveWindows/);
assert.match(bot.source, /inactive-window-routing-pruned/);
assert.match(bot.source, /const mappedWindow = mapped\.windowId \? resolveTelegramImagebotStoredActiveWindow\(store, params\.chatId, mapped, now\) : null;/);
assert.doesNotMatch(
  bot.source,
  /const storedWindow = resolveTelegramImagebotUsableWindow\(store, chatId, \{ windowId \}, ownerUserKey\);\s*if \(storedWindow\) return storedWindow;/s,
);
assert.match(bot.source, /buildTelegramImagebotWindowTurnPrompt/);
assert.match(bot.source, /group_thread_rule=treat this window as an ordinary Telegram group chat thread/);
assert.match(bot.source, /no_owner_rule=the window has no protagonist or privileged owner/);
assert.match(bot.source, /routing_rule=this message belongs to the named shared group-thread window only/);
assert.doesNotMatch(bot.source, /sender_lock=/);
assert.match(bot.source, /if \(accountId === "imagebot"\) return \[\];/);
assert.match(bot.source, /const useImagebotWindowIsolation = route\.accountId === "imagebot" && Boolean\(imagebotWindow\);/);
assert.match(bot.source, /let imagebotWindow = null;/);
assert.match(bot.source, /imagebotWindow = resolveTelegramImagebotWindowContext\(\{/);
assert.match(bot.source, /sessionKey = imagebotWindow\.sessionKey;/);
assert.match(bot.source, /!useImagebotWindowIsolation\) combinedBody = channelHistory\.buildPendingContext/);
assert.match(bot.source, /const effectivePromptContext = useImagebotWindowIsolation \? \[\] : promptContext;/);
assert.match(bot.source, /const safetyReviewPrompt = normalizeOptionalString\(loliNsfwVisionGuard\?\.reviewPrompt\)\?\.trim\(\);/);
assert.match(bot.source, /const marsForwardReviewPrompt = normalizeOptionalString\(options\?\.marsForwardReviewPrompt\)\?\.trim\(\);/);
assert.match(bot.source, /const guardedBodyText = normalizeOptionalString\(loliNsfwVisionGuard\?\.bodyTextForAgent\) \?\? bodyText;/);
assert.match(bot.source, /const currentBodyForAgentBase = `\$\{forwardPrefix\}\$\{guardedBodyText\}\$\{replySuffix\}`;/);
assert.match(bot.source, /const currentBodyForAgent = \[safetyReviewPrompt, marsForwardReviewPrompt, currentBodyForAgentBase\]\.filter/);
assert.match(bot.source, /const agentBodyText = imagebotTurnPrefix \? `\$\{imagebotTurnPrefix\}\\n\\n\$\{currentBodyForAgent\}` : currentBodyForAgent;/);
assert.match(bot.source, /function isTelegramImagebotWindowIsolatedContext\(context\)/);
assert.match(bot.source, /isTelegramImagebotWindowIsolatedContext\(params\.context\)\) return params\.currentMessage;/);
assert.match(bot.source, /!isTelegramImagebotWindowIsolatedContext\(params\.context\) \? createChannelHistoryWindow/);
assert.doesNotMatch(bot.source, /bot-reply-guest/);
assert.doesNotMatch(bot.source, /window_owner=/);
assert.doesNotMatch(bot.source, /relation_to_window=/);
assert.doesNotMatch(bot.source, /TelegramWindowOwnerUserKey/);
assert.match(bot.source, /:window:\$\{activeWindowId\}/);
assert.match(bot.source, /if \(imagebotAllowedTextCommand\) commandAuthorized = true;/);
assert.match(bot.source, /commandGate\.shouldBlockControlCommand && !imagebotAllowedTextCommand/);
assert.match(bot.source, /telegram imagebot \/amnew: failed to open window/);
assert.match(bot.source, /telegram imagebot \/amnew: opened window/);
assert.match(bot.source, /telegram imagebot \/ammodel: failed to resolve target/);
assert.match(bot.source, /telegram imagebot \/ampersona: failed to resolve target/);
assert.match(bot.source, /telegram imagebot \/ampersona: opened persona window/);
assert.match(bot.source, /Amadeus 运行状态/);
assert.match(bot.source, /Token 使用量：暂无/);
assert.match(bot.source, /\/amtools 不从 Telegram 直接运行脚本/);
assert.match(bot.source, /\/amroll \[NdS\]：掷骰/);
assert.match(bot.source, /if \(microCommandText\) \{/);
assert.match(bot.source, /请用 \/ammodel 查看或切换模型。我没有改动当前模型。/);
assert.match(bot.source, /resolveTelegramImagebotPersonaForNewWindow/);
assert.match(bot.source, /userDefaults/);
assert.match(bot.source, /rememberDefault: true/);
assert.match(bot.source, /persona: parsed\.persona/);
assert.match(bot.source, /personaSource: "ampersona"/);
assert.match(bot.source, /closedReason: "replaced-by-ampersona"/);
const imagebotOwnerGateCount = (bot.source.match(/if \(!isTelegramImagebotAmmodelOwnerAllowed\(\{ senderId, target \}\)\)/g) || []).length;
assert.equal(imagebotOwnerGateCount, 2, "/ammodel and /ampersona must both stay owner-gated before mutating session/window state");
assert.match(bot.source, /telegram imagebot \/ammodel: blocked non-owner/);
assert.match(bot.source, /telegram imagebot \/ampersona: blocked non-owner/);
assert.match(bot.source, /if \(await handleImagebotAmmodelBeforeModel\(primaryCtx\)\) return \{ kind: "completed" \};/);
assert.match(bot.source, /if \(await handleImagebotAmpersonaBeforeModel\(primaryCtx\)\) return \{ kind: "completed" \};/);
assert.match(bot.source, /if \(await handleImagebotAmnewBeforeModel\(primaryCtx\)\) return \{ kind: "completed" \};/);
assert.match(bot.source, /if \(await handleImagebotTextRepeaterBeforeModel\(primaryCtx\)\) return \{ kind: "completed" \};/);
assert.match(bot.source, /if \(await handleImagebotUnsupportedControlBeforeModel\(primaryCtx\)\) return \{ kind: "completed" \};/);
assert.match(bot.source, /if \(await handleImagebotScriptControlBeforeModel\(primaryCtx\)\) return \{ kind: "completed" \};/);
assert.match(bot.source, /handleImagebotTextRepeaterBeforeDrop/);
assert.match(bot.source, /__imagebotTextRepeaterSeen/);
assert.match(bot.source, /telegram imagebot repeater: repeated text before drop gate/);
assert.match(bot.source, /repeatStickers: raw\.repeatStickers !== false/);
assert.match(bot.source, /requireDifferentSenders: raw\.requireDifferentSenders !== false/);
assert.match(bot.source, /maxGapMs: readPreDropImagebotTextRepeaterNumber\(raw\.maxGapMs, 30_000/);
assert.match(bot.source, /resolvePreDropImagebotRepeatableItem/);
assert.match(bot.source, /preDropImagebotRepeaterSenderKey/);
assert.match(bot.source, /previous\.senderKey === item\.senderKey/);
assert.match(bot.source, /const clearPreDropImagebotTextRepeaterState = \(\) => \{\s*preDropImagebotTextRepeaterState\.delete\(key\);/);
assert.match(bot.source, /shouldIgnorePreDropImagebotTextRepeaterMessage\(msg, item, options, botUsername\)\) return clearPreDropImagebotTextRepeaterState\(\);/);
assert.match(bot.source, /now - previous\.updatedAt > options\.maxGapMs/);
assert.match(bot.source, /senderKey: item\.senderKey \|\| ""/);
assert.match(bot.source, /stickerUniqueId \|\| stickerFileId/);
assert.match(bot.source, /bot\.api\.sendSticker\(msg\.chat\.id, decision\.fileId, threadParams\)/);
assert.match(bot.source, /telegram imagebot repeater: repeated sticker before drop gate/);
assert.match(bot.source, /await commitDispatchDedupeKeys\(dispatchDedupeKeys\);\s*dispatchDedupeKeys = \[\];\s*return;/s);
const preModelDispatchStart = bot.source.indexOf("return async (primaryCtx, allMedia");
const textRepeaterCall = bot.source.indexOf("handleImagebotTextRepeaterBeforeModel(primaryCtx)", preModelDispatchStart);
const unsupportedControlCall = bot.source.indexOf("handleImagebotUnsupportedControlBeforeModel(primaryCtx)", preModelDispatchStart);
const scriptControlCall = bot.source.indexOf("handleImagebotScriptControlBeforeModel(primaryCtx)", preModelDispatchStart);
const modelContextCall = bot.source.indexOf("buildTelegramMessageContext({", preModelDispatchStart);
assert.ok(
  preModelDispatchStart >= 0 && textRepeaterCall > preModelDispatchStart && textRepeaterCall < unsupportedControlCall && textRepeaterCall < modelContextCall,
  "Telegram text repeater must run as a pre-model script before control commands and context construction",
);
assert.ok(
  preModelDispatchStart >= 0 && unsupportedControlCall > preModelDispatchStart && unsupportedControlCall < modelContextCall,
  "/model must be rejected before model context construction",
);
assert.ok(
  preModelDispatchStart >= 0 && scriptControlCall > preModelDispatchStart && scriptControlCall < modelContextCall,
  "/amhelp, /amstatus, and /amtools must be handled before model context construction",
);
const inboundMessageLikeStart = bot.source.indexOf("const handleInboundMessageLike = async (event) =>");
const preDropRepeaterCall = bot.source.indexOf("handleImagebotTextRepeaterBeforeDrop(event.ctx, event.msg)", inboundMessageLikeStart);
const marsForwardCall = bot.source.indexOf("maybeHandleTelegramMarsForwardCandidate({", inboundMessageLikeStart);
const unaddressedDropCall = bot.source.indexOf("shouldDropUnaddressedImagebotGroupMessage({", inboundMessageLikeStart);
assert.ok(
  inboundMessageLikeStart >= 0 && preDropRepeaterCall > inboundMessageLikeStart && preDropRepeaterCall < marsForwardCall && preDropRepeaterCall < unaddressedDropCall,
  "Telegram text repeater must run in the inbound pre-drop path before unaddressed group messages can be discarded",
);
assert.doesNotMatch(
  bot.source,
  /isImagebotAmnewCommand\(bodyResult\.rawBody/,
  "/amnew must stay in the pre-model command path, not context construction",
);
assert.doesNotMatch(
  bot.source,
  /model_config.*\/ammodel chat commands/s,
  "/ammodel must stay runtime-handled; tool manual must not route plain chat commands through model_config",
);
assert.match(bot.source, /\\u65b0\\u7a97\\u53e3\\u5df2\\u6253\\u5f00\\u3002/);
assert.match(bot.source, /dropping unaddressed imagebot group message before cache/);
assert.match(bot.source, /bindingMode\.kind === "plugin-owned-runtime" && account\.accountId !== "imagebot"/);
assert.match(bot.source, /if \(accountId === "imagebot"\) return null;/);
assert.match(getReply.source, /function resolveMediaUnderstandingActiveModel\(params\)/);
assert.match(getReply.source, /resolveStoredModelOverride\(\{\s*sessionEntry: entry,\s*sessionStore: store,\s*sessionKey: params\.sessionKey,\s*defaultProvider: params\.defaultProvider\s*\}\)/s);
assert.match(getReply.source, /activeModel: resolveMediaUnderstandingActiveModel\(\{\s*cfg,\s*agentId,\s*sessionKey: agentSessionKey,\s*provider,\s*model,\s*defaultProvider,\s*hasResolvedHeartbeatModelOverride\s*\}\)/s);

assert.match(openclawTools.source, /Imagebot sessions normally ignore per-call values/);
assert.match(openclawTools.source, /const imagebotManagedImageGeneration = typeof options\?\.agentSessionKey === "string" && options\.agentSessionKey\.startsWith\("agent:imagebot:"\);/);
assert.match(openclawTools.source, /const requestedModel = readStringParam\(params, "model"\);/);
assert.match(openclawTools.source, /const model = imagebotManagedImageGeneration \? void 0 : requestedModel;/);
assert.match(openclawTools.source, /const timeoutMs = imagebotManagedImageGeneration \? imageGenerationModelConfig\.timeoutMs : readGenerationTimeoutMs\(params\) \?\? imageGenerationModelConfig\.timeoutMs;/);
assert.doesNotMatch(openclawTools.source, /300000 tends to be a safe amount/);

assert.match(browserPluginService.source, /function markBrowserScreenshotDetailsNonOutbound\(details\)/);
assert.match(browserPluginService.source, /details: markBrowserScreenshotDetailsNonOutbound\(result\)/);
assert.match(embeddedTools.source, /function isOutboundToolResultMedia\(media\)/);
assert.match(embeddedTools.source, /if \(!isOutboundToolResultMedia\(detailsMedia\)\) return;/);
assert.match(openclawTools.source, /outbound: true/);

const embeddedToolsModule = await import(pathToFileURL(embeddedTools.filePath).href);
const extractToolResultMediaArtifact = embeddedToolsModule.f;
assert.equal(
  extractToolResultMediaArtifact({
    details: { media: { mediaUrl: "%USERPROFILE%/.openclaw/media/browser/blocked.png", outbound: false } },
  }),
  undefined,
  "browser screenshots marked outbound:false must stay observation-only and not become Telegram attachments",
);
assert.equal(
  extractToolResultMediaArtifact({
    details: { media: { mediaUrl: "%USERPROFILE%/.openclaw/media/browser/implicit.png" } },
  }),
  undefined,
  "plain details.media without outbound:true must not be implicitly attached to a later assistant reply",
);
assert.deepEqual(
  extractToolResultMediaArtifact({
    details: { media: { mediaUrl: "%USERPROFILE%/.openclaw/media/tool-image-generation/result.png", outbound: true } },
  })?.mediaUrls,
  ["%USERPROFILE%/.openclaw/media/tool-image-generation/result.png"],
  "generated/tool media explicitly marked outbound:true must still be deliverable",
);

const dropGateStart = bot.source.indexOf("const shouldDropUnaddressedImagebotGroupMessage");
assert.notEqual(dropGateStart, -1);
const dropGateCommandBypass = bot.source.indexOf(
  "if (isImagebotAllowedTextCommand(messageTextParts.text, runtimeCfg",
  dropGateStart,
);
const dropGateMentionCheck = bot.source.indexOf(
  "const hasAnyMention = messageTextParts.entities",
  dropGateStart,
);
const dropGateRecentWindowBypass = bot.source.indexOf(
  "resolveTelegramImagebotRecentActiveWindowId({",
  dropGateStart,
);
assert.ok(
  dropGateCommandBypass > dropGateStart && dropGateCommandBypass < dropGateMentionCheck,
  "imagebot slash commands must bypass the unaddressed group-message drop gate",
);
assert.ok(
  dropGateRecentWindowBypass > dropGateCommandBypass && dropGateRecentWindowBypass < dropGateMentionCheck,
  "recent active imagebot windows must bypass the unaddressed group-message drop gate before mention checks",
);

assert.match(bot.source, /buildTelegramMediaDeliveryFailureFallbackPayload/);
assert.match(bot.source, /if \(!delivered \|\| info\.kind === "final"\) return;/);
assert.match(bot.source, /function collectTelegramPayloadMediaUrls\(payload\)/);
assert.match(bot.source, /const effectiveMediaUrls = collectTelegramPayloadMediaUrls\(effectivePayload\)/);
assert.match(bot.source, /collectTelegramPayloadMediaUrls\(payload\)/);
assert.match(bot.source, /sentBlockMediaUrls\.add\(url\)/);
assert.match(bot.source, /getSequentialKeyForAccount/);
assert.match(bot.source, /function resolveTelegramImagebotSequentialWindowId\(params\)/);
assert.match(bot.source, /store\.byBotMessage\?\.\[telegramImagebotMessageKey\(params\.chatId, replyMessageId\)\]/);
assert.match(bot.source, /return `\$\{baseKey\}:imagebot-window:\$\{windowId\}`;/);
assert.match(bot.source, /baseKey\.endsWith\(":control"\)/);
assert.doesNotMatch(
  bot.source,
  /if \(account\.accountId === "imagebot" && isGroup && senderId\) return `\$\{baseKey\}:sender:\$\{senderId\}`;/,
  "imagebot group updates must prefer window-scoped sequential lanes before sender fallback",
);
assert.match(bot.source, /媒体已经准备好，但 Telegram 发出失败了/);
assert.match(bot.source, /处理这条消息时出错了，请重试。/);

const dedupStart = bot.source.indexOf("function deduplicateBlockSentMedia");
const dedupEnd = bot.source.indexOf("function buildTelegramMediaDeliveryFailureFallbackPayload", dedupStart);
assert.notEqual(dedupStart, -1);
assert.notEqual(dedupEnd, -1);
const dedupContext = {};
vm.createContext(dedupContext);
vm.runInContext(`
${bot.source.slice(dedupStart, dedupEnd)}
globalThis.__collect = collectTelegramPayloadMediaUrls;
globalThis.__dedup = deduplicateBlockSentMedia;
`, dedupContext);
assert.deepEqual(Array.from(dedupContext.__collect({ mediaUrl: "mem://a" })), ["mem://a"]);
assert.equal(dedupContext.__dedup({ mediaUrl: "mem://a" }, new Set(["mem://a"])), undefined);
const textOnlyAfterBlock = dedupContext.__dedup({ text: "done", mediaUrl: "mem://a" }, new Set(["mem://a"]));
assert.equal(textOnlyAfterBlock.text, "done");
assert.equal(textOnlyAfterBlock.mediaUrl, undefined);
assert.equal(textOnlyAfterBlock.mediaUrls, undefined);
const mixedAfterBlock = dedupContext.__dedup({ mediaUrl: "mem://a", mediaUrls: ["mem://b"] }, new Set(["mem://a"]));
assert.deepEqual(Array.from(mixedAfterBlock.mediaUrls), ["mem://b"]);
assert.equal(mixedAfterBlock.mediaUrl, "mem://b");

assert.match(sentCache.source, /<media:animation>/);

assert.match(delivery.source, /sendMediaGroup/);
assert.match(delivery.source, /loadTelegramMediaReplyItems/);
assert.match(delivery.source, /TELEGRAM_ALBUM_PHOTO_MAX_BYTES/);
assert.match(delivery.source, /msg\.animation/);
assert.match(delivery.source, /TELEGRAM_MEDIA_SEND_RETRY_DELAYS_MS = \[5000, 10000, 15000\]/);
assert.match(delivery.source, /function isRetryableTelegramMediaSendError/);
assert.match(delivery.source, /function sendTelegramMediaWithAudit/);
assert.match(delivery.source, /TELEGRAM_MEDIA_DELIVERY_AUDIT_FILE/);
assert.match(delivery.source, /telegram \$\{params\.operation\} media send ok/);
assert.match(delivery.source, /telegram \$\{params\.operation\} media send failed/);
assert.match(delivery.source, /operation: "sendMediaGroup"/);
assert.match(delivery.source, /operation: "sendPhoto"/);
assert.match(delivery.source, /operation: "sendDocument"/);
assert.match(delivery.source, /function isTelegramNativeSpoilerReply/);
assert.match(delivery.source, /has_spoiler: true/);
assert.match(delivery.source, /function coalesceTelegramPhotoAlbumReplies/);
assert.match(delivery.source, /function isTelegramReplyAlbumCoalesceCandidate/);
assert.match(delivery.source, /const deliveryReplies = coalesceTelegramPhotoAlbumReplies\(normalizedReplies\)/);
assert.match(delivery.source, /telegram outbound album coalesced replies=/);

async function runTelegramAlbumCoalesceSmoke(replies) {
  const { n: deliverReplies } = await import(pathToFileURL(delivery.filePath).href);
  const calls = [];
  const bot = {
    api: {
      sendMediaGroup: async (_chatId, media, params) => {
        calls.push({
          op: "sendMediaGroup",
          count: media.length,
          params,
          media: media.map((item) => ({
            type: item.type,
            hasSpoiler: item.has_spoiler === true,
            hasCaption: typeof item.caption === "string" && item.caption.length > 0,
          })),
        });
        return media.map((_, index) => ({ message_id: 100 + index }));
      },
      sendPhoto: async (_chatId, _file, params) => {
        calls.push({ op: "sendPhoto", params });
        return { message_id: 200 + calls.length };
      },
      sendMessage: async (_chatId, text, params) => {
        calls.push({ op: "sendMessage", text, params });
        return { message_id: 300 + calls.length };
      },
    },
  };

  await deliverReplies({
    bot,
    chatId: -1001,
    accountId: "imagebot",
    replies,
    cfg: {},
    runtime: {
      log: () => {},
      error: (msg) => {
        throw new Error(String(msg));
      },
    },
    mediaLoader: async (url) => ({
      buffer: Buffer.from(`fake-${url}`),
      contentType: "image/png",
      fileName: `${String(url).replace(/[^a-z0-9]/gi, "_")}.png`,
    }),
  });
  return calls;
}

const twoImageCalls = await runTelegramAlbumCoalesceSmoke([
  { mediaUrl: "mem://a", text: "album caption" },
  { mediaUrl: "mem://b" },
]);
assert.deepEqual(twoImageCalls.map((call) => `${call.op}:${call.count ?? 1}`), ["sendMediaGroup:2"]);
assert.ok(twoImageCalls[0].media.every((item) => item.hasSpoiler === false));

const mixedSpoilerAlbumCalls = await runTelegramAlbumCoalesceSmoke([
  { mediaUrl: "mem://spoiler-a", text: "album caption", sensitiveMedia: true },
  { mediaUrl: "mem://plain-b" },
  { mediaUrl: "mem://plain-c" },
]);
assert.deepEqual(mixedSpoilerAlbumCalls.map((call) => `${call.op}:${call.count ?? 1}`), ["sendMediaGroup:3"]);
assert.ok(
  mixedSpoilerAlbumCalls[0].media.every((item) => item.hasSpoiler === true),
  "if any coalesced album item is sensitive, every Telegram album item must get has_spoiler",
);

const differentCaptionCalls = await runTelegramAlbumCoalesceSmoke([
  { mediaUrl: "mem://a", text: "caption A" },
  { mediaUrl: "mem://b", text: "caption B" },
]);
assert.deepEqual(differentCaptionCalls.map((call) => call.op), ["sendPhoto", "sendPhoto"]);

const elevenImageCalls = await runTelegramAlbumCoalesceSmoke(
  Array.from({ length: 11 }, (_, index) => ({ mediaUrl: `mem://${index}` })),
);
assert.deepEqual(elevenImageCalls.map((call) => `${call.op}:${call.count ?? 1}`), ["sendMediaGroup:10", "sendPhoto:1"]);

assert.match(payloads.source, /SPOILER_MEDIA_TOKEN_RE/);
assert.match(payloads.source, /MEDIA_SPOILER/);
assert.match(payloads.source, /sensitiveMedia/);
assert.doesNotMatch(payloads.source, /SENSITIVE_MEDIA_INTENT_RE/);
assert.doesNotMatch(payloads.source, /NEGATED_SENSITIVE_MEDIA_INTENT_RE/);
assert.doesNotMatch(payloads.source, /inferSensitiveMediaFromText/);
assert.match(payloads.source, /function projectOutboundPayloadPlanForOutbound/);
assert.match(payloads.source, /sensitiveMedia: payload\.sensitiveMedia === true \? true : void 0/);
assert.match(payloads.source, /function summarizeOutboundPayloadForTransport/);
assert.match(replyTurnAdmission.source, /IMAGEBOT_MEDIA_DIRECTIVE_TOKEN_RE/);
assert.match(replyTurnAdmission.source, /IMAGEBOT_MEDIA_DIRECTIVE_TOKEN_RE\.test\(text\)\) return/);

assert.match(actionRuntime.source, /readBooleanParam\(params, "spoiler"\)/);
assert.match(actionRuntime.source, /hasSpoiler/);
assert.match(outboundAdapter.source, /params\.payload\.sensitiveMedia === true/);
assert.match(outboundAdapter.source, /telegramData\?\.spoiler === true/);
assert.match(outboundAdapter.source, /sensitiveMedia: true/);
assert.match(telegramSend.source, /const useNativeSpoiler = opts\.sensitiveMedia === true/);
assert.match(telegramSend.source, /function sendMessageTelegram/);
assert.match(telegramSend.source, /has_spoiler: true/);
assert.match(telegramSend.source, /api\.sendPhoto\(chatId, file, withTelegramNativeSpoiler\(effectiveParams\)\)/);
assert.match(openclawTools.source, /Telegram only: send visual media with native spoiler blur\/cover/);

assert.match(botDeps.source, /command menu sync disabled for imagebot/);
assert.match(commandDetection.source, /matchesControlCommandAlias/);
assert.match(commandDetection.source, /listConfiguredTelegramCustomCommandAliases/);
assert.match(commandDetection.source, /telegram\?\.customCommands/);
assert.match(commandDetection.source, /options\?\.accountId/);
assert.match(bot.source, /hasControlCommand\(messageTextParts\.text, runtimeCfg, \{ botUsername, accountId \}/);
assert.match(turnKernel.source, /reason: send\.reason \?\? "no_visible_result"/);
assert.match(bot.source, /durable\.reason === "adapter_returned_no_identity"/);
assert.match(bot.source, /treating as delivered to avoid duplicate direct send/);
assert.match(bot.source, /telegram duplicate durable visible payload suppressed within current dispatch/);
assert.match(bot.source, /toolName === "image_generate"\) await sendImageGenerationNotice\(\)/);
assert.match(bot.source, /bot\.api\.sendChatAction\(chatId, "upload_photo"/);
assert.match(bot.source, /bot\.api\.sendMessage\(chatId, "\\u751f\\u6210\\u56fe\\u7247\\u4e2d\.\.\."/);
assert.match(bot.source, /reply_parameters:\s*\{\s*message_id: msg\.message_id,\s*allow_sending_without_reply: true\s*\}/s);
assert.match(bot.source, /const applyImplicitMediaReplyTarget = \(payload\) => \{/);
assert.match(bot.source, /replyToId: String\(msg\.message_id\)/);
assert.match(embeddedTools.source, /"generated_gallery_resend"/);
assert.match(embeddedTools.source, /function hasTrustedLocalMediaDetails\(result\)/);
assert.match(embeddedTools.source, /if \(hasTrustedLocalMediaDetails\(result\)\) return mediaUrls/);
assert.match(embeddedTools.source, /detailsMedia\.sensitiveMedia === true/);
assert.match(embeddedTools.source, /sensitiveMedia: true/);
assert.match(embeddedAgent.source, /openAICodexRuntimeFastPath/);
assert.match(embeddedAgent.source, /skipProviderRuntimeHooks: openAICodexRuntimeFastPath/);
assert.match(embeddedAgent.source, /!openAICodexRuntimeFastPath && pluginHarnessOwnsTransport && provider === "openai"/);
assert.match(embeddedPayloads.source, /sensitiveMedia \} = parseReplyDirectives\(text(?:, [^)]+)?\)/);
assert.doesNotMatch(embeddedPayloads.source, /inferSensitiveMediaFromText/);
assert.match(embeddedPayloads.source, /if \(item\.sensitiveMedia\) payload\.sensitiveMedia = true/);
assert.match(embeddedPayloads.source, /const shouldPreferRawAnswerText = rawAnswerHasMedia && !assistantTextsHaveMedia/);
assert.match(embeddedAgent.source, /toolSensitiveMedia: attempt\.toolSensitiveMedia/);
assert.match(embeddedAgent.source, /sensitiveMedia: payload\.sensitiveMedia \|\| params\.toolSensitiveMedia \|\| void 0/);
assert.match(selection.source, /pendingToolSensitiveMedia/);
assert.match(selection.source, /parseReplyDirectives\(splitTrailingDirective\(trimmedText, \{ final: true \}\)\.text\)/);
assert.doesNotMatch(selection.source, /inferSensitiveMediaFromText/);
assert.match(selection.source, /STRUCTURED_MEDIA_TOOL_OUTPUT_SUPPRESS_TOOL_NAMES/);
assert.match(selection.source, /"telegram_media_spoiler"/);
assert.match(selection.source, /if \(mediaReply\.sensitiveMedia\) ctx\.state\.pendingToolSensitiveMedia = true/);
assert.match(selection.source, /\.\.\.mediaReply\.sensitiveMedia \? \{ sensitiveMedia: true \} : \{\}/);
assert.match(selection.source, /\.\.\.mediaArtifact\?\.sensitiveMedia \? \{ sensitiveMedia: true \} : \{\}/);
assert.match(selection.source, /cleanedTextLocal, mediaUrls: mediaUrlsLocal, audioAsVoice, replyToId, replyToTag, replyToCurrent, sensitiveMedia/);
assert.match(selection.source, /cleanedText, mediaUrls, audioAsVoice, replyToId, replyToTag, replyToCurrent, sensitiveMedia/);
assert.match(selection.source, /toolSensitiveMedia: pendingToolMediaReply\?\.sensitiveMedia/);
assert.match(dispatch.source, /final delivery summary attempted=/);

console.log("telegram media delivery runtime patch tests passed", {
  bot: bot.name,
  delivery: delivery.name,
  payloads: payloads.name,
  actionRuntime: actionRuntime.name,
  replyTurnAdmission: replyTurnAdmission.name,
  outboundAdapter: outboundAdapter.name,
  telegramSend: telegramSend.name,
  botDeps: botDeps.name,
  commandDetection: commandDetection.name,
  dispatch: dispatch.name,
  sentCache: sentCache.name,
  embeddedTools: embeddedTools.name,
  embeddedAgent: embeddedAgent.name,
  embeddedPayloads: embeddedPayloads.name,
  selection: selection.name,
});

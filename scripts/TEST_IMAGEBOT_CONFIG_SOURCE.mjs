import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildImagebotConfig } from "./BUILD_IMAGEBOT_CONFIG.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const result = await buildImagebotConfig({ write: false, template: true });
const { settings, prompt, configOps, promptOps } = result;

assert.ok(settings.groupIds.includes(settings.mainGroupId), "main group id must be in groupIds");
assert.ok(settings.groupIds.includes(settings.testGroupId), "test group id must be in groupIds");
assert.notEqual(settings.mainGroupId, settings.testGroupId, "main and test groups must be distinct");
assert.equal(settings.groupRoles?.[settings.mainGroupId], "production", "main group must be labeled production");
assert.equal(settings.groupRoles?.[settings.testGroupId], "test", "test group must be labeled test");
assert.deepEqual([...new Set(settings.groupIds)], settings.groupIds, "groupIds must not contain duplicates");
for (const groupId of settings.groupIds) {
  assert.ok(["production", "test"].includes(settings.groupRoles?.[groupId]), `group must have a known role: ${groupId}`);
}

assert.deepEqual(settings.promptSegments, [
  "config/imagebot/prompt/20-default-behavior.md",
  "config/imagebot/prompt/30-tool-index.md",
  "config/imagebot/prompt/40-workflows.md"
], "base prompt must stay tool/workflow-focused; persona and Telegram routing are dynamic context");
assert.ok(prompt.includes("工具路由与回复形态："));
assert.ok(!prompt.includes("运行身份："));
assert.ok(!prompt.includes("群聊上下文："));
assert.ok(!prompt.includes("隐私与交付："));
assert.ok(!prompt.includes("active_persona"));
assert.ok(!prompt.includes("persona_profile"));
assert.ok(!prompt.includes("You are YOUR_BOT_USERNAME in a private Telegram group chat."));
assert.ok(prompt.includes("工具索引："));
assert.ok(prompt.includes("当前可见工具和延迟工具目录就是当前动作空间"));
assert.ok(prompt.includes("延迟工具"));
assert.ok(prompt.includes("`tool_search`"));
assert.ok(prompt.includes("`tool_describe`"));
assert.ok(prompt.includes("`tool_call`"));
assert.ok(prompt.includes("工作流提示："));
assert.ok(prompt.includes("`/ammodel`"));
assert.ok(prompt.includes("internet_image_collection"));
assert.ok(prompt.includes("account_browser_risk"));
assert.ok(prompt.includes("telegram_media_spoiler"));
assert.ok(prompt.includes("只负责交付标记"));
assert.ok(prompt.includes("提供方原生托管搜索"));
assert.ok(prompt.includes("没有可见的 `web_search` 不代表原生搜索不可用"));
assert.ok(prompt.includes("外部当前事实"));
assert.ok(prompt.includes("外部/当前证据"));
assert.ok(prompt.includes("memory_search"));
assert.ok(prompt.includes("有效形态是 `query`"));
assert.ok(prompt.includes("强召回/群聊旧梗触发"));
assert.ok(!prompt.includes("{{PERSONA_CARD}}"));
assert.ok(!prompt.includes("# Active Persona Card"));
assert.ok(!prompt.includes("# 活跃角色卡"));
assert.ok(!prompt.includes("# 角色卡"));
assert.ok(!prompt.includes("active speaking-persona overlays"));
assert.ok(!prompt.includes("speaking-persona overlays"));
assert.ok(!prompt.includes("## Kurisu Core"));
assert.ok(!prompt.includes("## 红莉栖"));
assert.ok(!prompt.includes("## Memory Posture"));
assert.ok(!prompt.includes("Tools are senses and hands, not personality"));
assert.ok(!prompt.includes("final-answer script"));
assert.ok(!prompt.includes("Do not reduce successful media/search/download turns to only"));

for (const term of settings.promptLint.forbiddenSubstrings) {
  assert.ok(!prompt.toLowerCase().includes(term.toLowerCase()), `forbidden prompt term survived: ${term}`);
}
for (const term of settings.promptLint.requiredSubstrings) {
  assert.ok(prompt.includes(term), `required prompt term missing: ${term}`);
}

for (const tool of ["telegram_media_spoiler", "download_image_url", "download_image_urls", "danbooru_resource", "web_snapshot", "web_card", "generated_gallery", "generated_gallery_resend", "media_artifact", "artifact", "zhihu", "group_adventure", "background_job", "turn_observer_recent", "image_skill", "image_skill_save_reference", "image_skill_note_preference", "meme_transform", "knowledge", "knowledge_ingest", "media_brief", "audio_transcribe", "public_video", "pixiv_resource", "sticker_pack", "desktop_media_control", "mars_forward_lookup", "persona_config", "message"]) {
  assert.ok(settings.allowedTools.includes(tool), `missing allowed tool ${tool}`);
}
for (const tool of ["generated_gallery_recent", "generated_gallery_search", "generated_gallery_stats", "media_artifact_recent", "media_artifact_lineage", "artifact_recent", "artifact_search", "artifact_get", "image_skill_lookup", "image_skill_recent", "knowledge_sources", "knowledge_search", "knowledge_recent", "zhihu_search", "zhihu_global_search", "zhihu_hot_list"]) {
  assert.ok(!settings.allowedTools.includes(tool), `legacy split tool should not be directly exposed: ${tool}`);
}
assert.ok(!settings.allowedTools.includes("browser"), "OpenClaw built-in browser must not be exposed; use Playwright web_snapshot/download tools");
assert.ok(!settings.allowedTools.includes("web_search"), "provider-native search must not be exposed as a fake callable tool");

assert.ok(Array.isArray(settings.operatorSenderIds) && settings.operatorSenderIds.length >= 1, "operator sender ids must be configured");
assert.equal(settings.toolAccess?.strategy, "default_chat_plus_operator_unlock");
assert.ok(settings.toolAccess?.operatorOnlyTools?.includes("knowledge_ingest"), "knowledge_ingest must be operator-only");
assert.ok(settings.toolAccess?.operatorOnlyTools?.includes("script_action"), "script_action must be operator-only");
assert.ok(settings.toolAccess?.operatorOnlyTools?.includes("model_config"), "model_config must be operator-only");
assert.ok(settings.toolAccess?.operatorOnlyTools?.includes("desktop_media_control"), "desktop_media_control must be operator-only");
assert.ok(!settings.toolAccess?.operatorOnlyTools?.includes("sticker_pack"), "sticker_pack should stay available to normal chat senders; risky sticker actions are gated in tool code");
assert.ok(!settings.toolAccess?.operatorOnlyTools?.includes("feature_action"), "ordinary feature execution should remain a normal chat capability");
assert.ok(!settings.toolAccess?.operatorOnlyTools?.includes("message"), "message send must not be blocked by default sender policy");
for (const tool of settings.toolAccess?.operatorOnlyTools || []) {
  assert.ok(settings.allowedTools.includes(tool), `operator-only tool must remain in total allowedTools: ${tool}`);
  assert.ok(!settings.deniedTools.includes(tool), `operator-only tool must not be globally denied: ${tool}`);
}

for (const pathName of ["tools.allow", "agents.list[0].tools.allow"]) {
  const op = configOps.find((item) => item.path === pathName);
  assert.ok(op, `missing config op ${pathName}`);
  assert.ok(op.value.includes("web_snapshot"), `${pathName} must expose web_snapshot`);
  assert.ok(op.value.includes("web_card"), `${pathName} must expose web_card`);
  assert.ok(op.value.includes("background_job"), `${pathName} must expose background_job`);
  assert.ok(!op.value.includes("browser"), `${pathName} must not expose OpenClaw built-in browser`);
}

for (const pathName of ["tools.toolsBySender", "agents.list[0].tools.toolsBySender"]) {
  const op = configOps.find((item) => item.path === pathName);
  assert.ok(op, `missing config op ${pathName}`);
  assert.deepEqual(op.value["*"]?.deny, settings.toolAccess.operatorOnlyTools, `${pathName} wildcard policy must hide operator-only tools`);
  for (const senderId of settings.operatorSenderIds) {
    assert.deepEqual(op.value[`id:${senderId}`]?.alsoAllow, settings.toolAccess.operatorOnlyTools, `${pathName} must unlock tools for operator id:${senderId}`);
    assert.deepEqual(op.value[`channel:telegram:${senderId}`]?.alsoAllow, settings.toolAccess.operatorOnlyTools, `${pathName} must unlock tools for Telegram operator ${senderId}`);
  }
}

const webSearchOp = configOps.find((item) => item.path === "tools.web.search");
assert.ok(webSearchOp, "missing tools.web.search config");
assert.equal(webSearchOp.value.enabled, true);
assert.equal(Object.hasOwn(webSearchOp.value, "provider"), false, "web_search must not force a global provider; keep model-native search routes open");
assert.equal(webSearchOp.value.openaiCodex?.enabled, true, "OpenAI/Codex native web search should stay enabled for eligible models");
assert.ok(webSearchOp.value.maxResults <= 6, "web_search should stay bounded for group-chat latency");

const toolSearchOp = configOps.find((item) => item.path === "tools.toolSearch");
assert.ok(toolSearchOp, "missing tools.toolSearch config");
assert.deepEqual(toolSearchOp.value, {
  enabled: true,
  mode: "directory",
  searchDefaultLimit: 6,
  maxSearchLimit: 12
});
assert.equal(
  configOps.some((item) => item.path === "agents.list[0].tools.toolSearch"),
  false,
  "toolSearch is a runtime-global OpenClaw setting; do not add an inert agent-local mirror"
);

const interactionCoreOp = configOps.find((item) => item.path === "plugins.entries.imagebot-interaction-core.config");
assert.ok(interactionCoreOp, "missing interaction-core plugin config");
const textRepeater = interactionCoreOp.value.textRepeater;
assert.ok(textRepeater, "missing Telegram text repeater config");
assert.equal(textRepeater.enabled, true);
assert.equal(textRepeater.groupOnly, true);
assert.equal(textRepeater.repeatText, true);
assert.equal(textRepeater.repeatStickers, true);
assert.equal(textRepeater.requireDifferentSenders, true);
assert.equal(textRepeater.maxGapMs, 30000);
assert.equal(textRepeater.minCount, 2);
assert.equal(textRepeater.ignoreCommands, true);
assert.equal(textRepeater.ignoreBotMessages, true);
assert.equal(textRepeater.ignoreExplicitBotMention, true);

const expectedChatFallbacks = ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"];
assert.deepEqual(settings.modelFallbacks, expectedChatFallbacks, "settings must define the chat model fallback chain");
const defaultModelOp = configOps.find((item) => item.path === "agents.defaults.model");
assert.ok(defaultModelOp, "missing default chat model config");
assert.deepEqual(defaultModelOp.value, {
  primary: "openai/gpt-5.5",
  fallbacks: expectedChatFallbacks,
});
const agentModelOp = configOps.find((item) => item.path === "agents.list[0].model");
assert.ok(agentModelOp, "missing imagebot agent model config");
assert.deepEqual(agentModelOp.value, {
  primary: "openai/gpt-5.5",
  fallbacks: expectedChatFallbacks,
});

const modelStateTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-model-state-"));
const previousModelStateFile = process.env.OPENCLAW_IMAGEBOT_MODEL_STATE_FILE;
try {
  const runtimeModelStatePath = path.join(modelStateTempDir, "model-state.json");
  await fs.writeFile(
    runtimeModelStatePath,
    `${JSON.stringify({ model: "deepseek/deepseek-v4-flash", reasoningEffort: "low", textVerbosity: "high" }, null, 2)}\n`,
    "utf8",
  );
  process.env.OPENCLAW_IMAGEBOT_MODEL_STATE_FILE = runtimeModelStatePath;
  const runtimeStateResult = await buildImagebotConfig({ write: false });
  assert.deepEqual(
    runtimeStateResult.configOps.find((item) => item.path === "agents.defaults.model")?.value,
    { primary: "deepseek/deepseek-v4-flash", fallbacks: ["deepseek/deepseek-v4-pro"] },
    "config build should prefer mutable runtime model-state over the tracked seed",
  );
  assert.equal(
    runtimeStateResult.configOps.find((item) => item.path === "agents.list[0].params.reasoningEffort")?.value,
    "low",
    "runtime model-state should control reasoning effort",
  );
  assert.equal(
    runtimeStateResult.configOps.find((item) => item.path === "agents.list[0].params.textVerbosity")?.value,
    "high",
    "runtime model-state should control text verbosity",
  );

  const templateResult = await buildImagebotConfig({ write: false, template: true });
  assert.deepEqual(
    templateResult.configOps.find((item) => item.path === "agents.defaults.model")?.value,
    { primary: "openai/gpt-5.5", fallbacks: expectedChatFallbacks },
    "template/public builds should keep using the tracked seed model-state",
  );
} finally {
  if (previousModelStateFile === undefined) {
    delete process.env.OPENCLAW_IMAGEBOT_MODEL_STATE_FILE;
  } else {
    process.env.OPENCLAW_IMAGEBOT_MODEL_STATE_FILE = previousModelStateFile;
  }
  await fs.rm(modelStateTempDir, { recursive: true, force: true });
}

const setModelScript = await fs.readFile(path.join(repoRoot, "scripts", "SET_IMAGEBOT_MODEL_MODE.ps1"), "utf8");
assert.match(setModelScript, /\$chatModelConfig = @\{\s+primary = \$effectiveModel\s+fallbacks = \$effectiveFallbacks\s+\}/s);
assert.doesNotMatch(setModelScript, /agents\.defaults\.model\.primary/);
for (const [modelId, alias] of [
  ["openai/gpt-5.5", ""],
  ["openai/gpt-5.4", "gpt54"],
  ["openai/gpt-5.4-mini", "mini"],
  ["openai/gpt-5.3-codex-spark", "spark"],
  ["deepseek/deepseek-v4-flash", ""],
  ["deepseek/deepseek-v4-pro", ""]
]) {
  for (const prefix of ["agents.defaults.models", "agents.list[0].models"]) {
    const pathName = `${prefix}["${modelId}"]`;
    const op = configOps.find((item) => item.path === pathName);
    assert.ok(op, `missing model allowlist op ${pathName}`);
    assert.deepEqual(op.value, alias ? { alias } : {}, `${pathName} should have the expected alias metadata`);
  }
}
const reasoningOp = configOps.find((item) => item.path === "agents.list[0].params.reasoningEffort");
assert.ok(reasoningOp, "missing reasoning effort config");
assert.equal(reasoningOp.value, "medium");
assert.equal(
  configOps.some((item) => item.path === "agents.list[0].params.maxTokens"),
  false,
  "chat mode should not force a maxTokens cap; leave output budget to provider/OpenClaw defaults",
);

const imageGenerationOp = configOps.find((item) => item.path === "agents.defaults.imageGenerationModel");
assert.ok(imageGenerationOp, "missing image generation model config");
assert.equal(imageGenerationOp.value.primary, "openai/gpt-image-2");
assert.deepEqual(imageGenerationOp.value.fallbacks, []);
assert.equal(imageGenerationOp.value.timeoutMs, 420000);

const imageUnderstandingTimeoutOp = configOps.find((item) => item.path === "tools.media.image.timeoutSeconds");
assert.ok(imageUnderstandingTimeoutOp, "missing image understanding timeout config");
assert.equal(imageUnderstandingTimeoutOp.value, 420);

for (const pathName of ["channels.telegram.customCommands", "channels.telegram.accounts.imagebot.customCommands"]) {
  const op = configOps.find((item) => item.path === pathName);
  assert.ok(op, `missing config op ${pathName}`);
  const commands = op.value.map((item) => item.command);
  assert.deepEqual(commands, [
    "amnew",
    "amhelp",
    "amstatus",
    "ammodel",
    "ampersona",
    "amtools",
    "amroll",
    "amcoin",
    "amchoose",
    "amshuffle",
    "amsplit",
    "amstats",
    "amlinks"
  ], `${pathName} must expose only visible slash commands`);
  for (const command of op.value) {
    assert.match(command.description, /[\u3400-\u9fff]/, `${pathName} ${command.command} description should be Chinese-facing`);
  }
}
for (const pathName of [
  "channels.telegram.commands.native",
  "channels.telegram.commands.nativeSkills",
  "channels.telegram.accounts.imagebot.commands.native",
  "channels.telegram.accounts.imagebot.commands.nativeSkills"
]) {
  const op = configOps.find((item) => item.path === pathName);
  assert.ok(op, `missing config op ${pathName}`);
  assert.equal(op.value, false, `${pathName} must keep OpenClaw native slash/skill handlers disabled; /am* commands are handled by imagebot pre-model scripts`);
}

assert.ok(settings.allowedPluginIds.includes("imagebot-background-jobs"), "missing background jobs plugin allowlist");
assert.ok(settings.localPluginDirs.includes("plugins/imagebot-background-jobs"), "missing background jobs plugin path");
assert.ok(configOps.some((op) => op.path === "plugins.entries.imagebot-background-jobs.enabled"), "missing background jobs enable op");
assert.equal(configOps.some((op) => op.path === "plugins.entries.deepseek.enabled"), false, "DeepSeek uses models.providers.deepseek; do not write a missing plugin entry");
assert.ok(settings.allowedPluginIds.includes("imagebot-turn-observer"), "missing turn observer plugin allowlist");
assert.ok(settings.localPluginDirs.includes("plugins/imagebot-turn-observer"), "missing turn observer plugin path");
assert.ok(configOps.some((op) => op.path === "plugins.entries.imagebot-turn-observer.enabled"), "missing turn observer enable op");
for (const pluginId of [
  "imagebot-agent-ops",
  "imagebot-creative-ops",
  "imagebot-background-jobs",
  "imagebot-turn-observer",
  "imagebot-media-artifacts",
  "imagebot-memory-search",
  "imagebot-interaction-core"
]) {
  const hooksOp = configOps.find((op) => op.path === `plugins.entries.${pluginId}.hooks`);
  assert.equal(hooksOp?.value?.allowConversationAccess, true, `${pluginId} must allow OpenClaw conversation lifecycle hooks`);
  assert.equal(hooksOp?.value?.allowPromptInjection, true, `${pluginId} must allow prompt/context lifecycle hooks`);
}
const browserGuardHooksOp = configOps.find((op) => op.path === "plugins.entries.imagebot-browser-guard.hooks");
assert.equal(browserGuardHooksOp?.value?.allowConversationAccess, true, "browser guard must allow OpenClaw tool lifecycle hooks");
assert.equal(Object.hasOwn(browserGuardHooksOp?.value || {}, "allowPromptInjection"), false, "browser guard should not request prompt injection");
const galleryConfig = configOps.find((op) => op.path === "plugins.entries.imagebot-generated-gallery.config")?.value;
assert.ok(galleryConfig?.archiveRoot, "generated gallery must declare an archive root");
assert.ok(galleryConfig?.storeDir, "generated gallery must declare a state/index root");
assert.ok(galleryConfig.archiveRoot.includes(`${path.sep}.openclaw${path.sep}media${path.sep}archive`), "generated gallery archive should live under .openclaw");
assert.ok(galleryConfig?.maxManifestLines >= 1_000_000, "generated gallery manifest lookup should cover long-lived archives");
assert.ok(galleryConfig?.maxVisualIndexEntries >= 100_000, "generated gallery visual lookup should cover long-lived archives");
for (const pluginId of ["imagebot-image-skills", "imagebot-meme-tools", "imagebot-knowledge-library"]) {
  assert.ok(settings.allowedPluginIds.includes(pluginId), `missing ${pluginId} plugin allowlist`);
  assert.ok(settings.localPluginDirs.includes(`plugins/${pluginId}`), `missing ${pluginId} plugin path`);
  assert.ok(configOps.some((op) => op.path === `plugins.entries.${pluginId}.enabled`), `missing ${pluginId} enable op`);
}
for (const pluginId of ["imagebot-group-adventure"]) {
  assert.ok(settings.allowedPluginIds.includes(pluginId), `missing ${pluginId} plugin allowlist`);
  assert.ok(settings.localPluginDirs.includes(`plugins/${pluginId}`), `missing ${pluginId} plugin path`);
  assert.ok(configOps.some((op) => op.path === `plugins.entries.${pluginId}.enabled`), `missing ${pluginId} enable op`);
  assert.ok(configOps.some((op) => op.path === `plugins.entries.${pluginId}.config` && op.value?.storeDir), `${pluginId} must have a storeDir config`);
}
for (const pluginId of ["imagebot-audio-transcribe", "imagebot-public-video", "imagebot-pixiv-resource", "imagebot-sticker-pack"]) {
  assert.ok(settings.allowedPluginIds.includes(pluginId), `missing ${pluginId} plugin allowlist`);
  assert.ok(settings.localPluginDirs.includes(`plugins/${pluginId}`), `missing ${pluginId} plugin path`);
  assert.ok(configOps.some((op) => op.path === `plugins.entries.${pluginId}.enabled`), `missing ${pluginId} enable op`);
}
for (const pluginId of ["web-image-search", "imagebot-audio-transcribe", "imagebot-image-skills", "imagebot-meme-tools", "imagebot-media-artifacts", "imagebot-practical-tools", "imagebot-sticker-pack"]) {
  const pluginConfig = configOps.find((op) => op.path === `plugins.entries.${pluginId}.config`)?.value;
  assert.ok(pluginConfig?.openclawMediaRoot?.includes(`${path.sep}.openclaw${path.sep}media`), `${pluginId} must declare the shared media:// root`);
}
const webImageConfig = configOps.find((op) => op.path === "plugins.entries.web-image-search.config")?.value;
assert.equal(webImageConfig?.danbooru?.baseUrl, "https://danbooru.donmai.us", "danbooru_resource should default to the full Danbooru host");
assert.ok(webImageConfig?.danbooru?.secretFile?.endsWith(`secrets${path.sep}danbooru-imagebot.json`), "danbooru_resource should use the shared Danbooru secret file");
assert.ok(configOps.some((op) => op.path === "plugins.entries.imagebot-creative-ops.config" && op.value?.backgroundJobs?.storeDir), "creative ops must share background job config");
for (const pluginId of ["web-image-search", "imagebot-video-utils", "imagebot-public-video", "imagebot-meme-tools", "imagebot-practical-tools", "imagebot-feature-core"]) {
  assert.ok(configOps.some((op) => op.path === `plugins.entries.${pluginId}.config` && op.value?.backgroundJobs?.storeDir), `${pluginId} must share background job config`);
}
const practicalToolsConfig = configOps.find((op) => op.path === "plugins.entries.imagebot-practical-tools.config")?.value;
assert.equal(practicalToolsConfig?.accountBrowserRisk?.enabled, true, "practical tools must expose account browser risk config");
assert.ok(practicalToolsConfig?.accountBrowserRisk?.tiers?.read?.hourlyLimit > practicalToolsConfig?.accountBrowserRisk?.tiers?.interactive?.hourlyLimit, "read-only account browser budget should be higher than interactive budget");
assert.ok(practicalToolsConfig?.accountBrowserRisk?.tiers?.interactive?.hourlyLimit <= 24, "interactive account browser hourly budget should stay conservative");
assert.ok(practicalToolsConfig?.accountBrowserRisk?.verificationBackoffMs >= 300_000, "verification backoff should avoid immediate retries");
const interactionCoreConfig = configOps.find((op) => op.path === "plugins.entries.imagebot-interaction-core.config")?.value;
assert.ok(interactionCoreConfig?.marsForwardDetector?.maxEntries >= 100_000, "Mars forward detector should keep a large persistent source index");
assert.equal(Object.hasOwn(interactionCoreConfig?.marsForwardDetector || {}, "maxAgeDays"), false, "Mars forward detector should not use an age retention limit");
assert.deepEqual(interactionCoreConfig?.marsForwardDetector?.scriptReactKinds, ["channel_message", "canonical_url", "telegram_file"], "Mars forward detector should cover exact source, URL, and Telegram media keys");
assert.equal(interactionCoreConfig?.marsForwardDetector?.storageBackend, "sqlite", "Mars forward detector should use SQLite for durable concurrent lookup state");
assert.ok(interactionCoreConfig?.marsForwardDetector?.sqlitePath?.endsWith("mars-forward-detector.sqlite"), "Mars forward detector should configure a stable SQLite state path");
assert.ok(interactionCoreConfig?.marsForwardDetector?.tokenFile, "Mars forward lookup needs a Telegram token file for first-message forwarding");
assert.ok(interactionCoreConfig?.marsForwardDetector?.mediaDir?.includes(`${path.sep}.openclaw${path.sep}media${path.sep}mars-forward`), "Mars forward media evidence cache should live under .openclaw media");
assert.ok(interactionCoreConfig?.marsForwardDetector?.maxMediaBytes <= 20 * 1024 * 1024, "Mars forward media evidence should respect the Telegram Bot API ordinary file download cap");
assert.ok(interactionCoreConfig?.marsForwardDetector?.maxMediaTotalBytes >= 100 * 1024 * 1024 * 1024, "Mars forward media evidence cache should have a large but explicit total cap");
assert.equal(interactionCoreConfig?.marsForwardDetector?.visualHashEnabled, true, "Mars forward detector should precompute local visual hashes for media forwards");
assert.equal(interactionCoreConfig?.marsForwardDetector?.visualHashMaxDistance, 24, "Mars forward visual hash candidate threshold should stay conservative");
assert.ok(Array.isArray(interactionCoreConfig?.marsForwardDetector?.dependencyDirs) && interactionCoreConfig.marsForwardDetector.dependencyDirs.length >= 1, "Mars forward visual hashing should have plugin dependency roots for sharp");
assert.ok(settings.allowedPluginIds.includes("imagebot-desktop-control"), "missing desktop control plugin allowlist");
assert.ok(settings.localPluginDirs.includes("plugins/imagebot-desktop-control"), "missing desktop control plugin path");
assert.ok(configOps.some((op) => op.path === "plugins.entries.imagebot-desktop-control.enabled"), "missing desktop control enable op");
assert.ok(configOps.some((op) => op.path === "plugins.entries.imagebot-desktop-control.config" && op.value?.storeDir && op.value?.helperPath), "desktop control must have storeDir and helperPath config");

for (const groupId of settings.groupIds) {
  assert.ok(promptOps.some((op) => op.path === `channels.telegram.groups.${groupId}.systemPrompt`), `missing global prompt for ${groupId}`);
  assert.ok(promptOps.some((op) => op.path === `channels.telegram.accounts.imagebot.groups.${groupId}.systemPrompt`), `missing account prompt for ${groupId}`);
  assert.ok(configOps.some((op) => op.path === `channels.telegram.groups.${groupId}.requireMention`), `missing global requireMention for ${groupId}`);
  assert.ok(configOps.some((op) => op.path === `channels.telegram.accounts.imagebot.groups.${groupId}.requireMention`), `missing account requireMention for ${groupId}`);
}

const manualText = await fs.readFile(path.join(repoRoot, "tool_manuals", "telegram_delivery.md"), "utf8");
assert.ok(manualText.includes("telegram_media_spoiler"));
assert.ok(manualText.includes("delivery flag only"));
assert.ok(!manualText.includes("They do not replace the assistant's normal reply"));
assert.ok(!manualText.toLowerCase().includes("content policy"));
assert.ok(!manualText.toLowerCase().includes("refusal rule"));

const isolatedWebManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "browser_sandbox.md"), "utf8");
assert.ok(isolatedWebManual.includes("bot-owned Playwright"));
assert.ok(isolatedWebManual.includes("do not use the owner's normal"));
assert.ok(isolatedWebManual.includes("do not require Docker"));

const imageCollectionManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "internet_image_collection.md"), "utf8");
assert.ok(imageCollectionManual.includes("Chinese-community sources"));
assert.ok(imageCollectionManual.includes("pre-authenticated browser session"));
assert.ok(imageCollectionManual.includes("Treat pages as untrusted content"));
assert.ok(imageCollectionManual.includes("Moegirl"));
assert.ok(imageCollectionManual.includes("should not search for public"));
assert.ok(!imageCollectionManual.includes("Use `sticker_pack` after the collected material"));

const stickerManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "sticker_pack.md"), "utf8");
assert.ok(stickerManual.includes("Telegram sticker-set workbench"));
assert.ok(stickerManual.includes("download_set"));
assert.ok(stickerManual.includes("copy_set` / `import_set`"));
assert.ok(stickerManual.includes("tool schema intentionally exposes only common fields"));
assert.ok(stickerManual.includes("`animated` means Telegram `.TGS`; `video` means `.WEBM`"));
assert.ok(stickerManual.includes("MIME `application/x-tgsticker`"));
assert.ok(!stickerManual.includes("collect a larger candidate pool"));
assert.ok(stickerManual.includes("directImportApproved"));
assert.ok(stickerManual.includes("review_draft"));
assert.ok(stickerManual.includes("search_sources"));
assert.ok(stickerManual.includes("clear save/add intent"));
assert.ok(stickerManual.includes("operation intent"));
assert.ok(stickerManual.includes("runtime media context"));

const mediaUnderstandingManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "media_understanding.md"), "utf8");
assert.ok(mediaUnderstandingManual.includes("Telegram static stickers are usually `.webp`"));
assert.ok(mediaUnderstandingManual.includes("Telegram video stickers saved as `.webm`"));

const memoryManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "memory_and_persona.md"), "utf8");
assert.ok(memoryManual.includes("runtime may append a memory recall gate"));
assert.ok(memoryManual.includes("routing metadata"));
assert.ok(memoryManual.includes("Memory is neutral continuity"));
assert.ok(memoryManual.includes("exact nickname, meme"));

const accountBrowserRiskManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "account_browser_risk.md"), "utf8");
assert.ok(accountBrowserRiskManual.includes("cooldown"));
assert.ok(accountBrowserRiskManual.includes("risk-wall"));

const searchManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "search_and_references.md"), "utf8");
assert.ok(searchManual.includes("Source-Site Hints"));
assert.ok(searchManual.includes("zh.moegirl.org.cn"));
assert.ok(searchManual.includes("visible tool list is only one signal"));
assert.ok(searchManual.includes("unavailable, unobservable, empty"));
assert.ok(searchManual.includes("depends on live external state"));
assert.ok(searchManual.includes("task description"));
assert.ok(searchManual.includes("actual subject"));
assert.ok(searchManual.includes("Search results are leads"));
assert.ok(searchManual.includes("2-4 source reads/cards/snapshots"));
assert.ok(searchManual.includes("Click visible tabs/buttons"));
assert.ok(searchManual.includes("public current state"));
assert.ok(searchManual.includes("public `imageUrl` values must become bot-local"));
assert.ok(searchManual.includes("Do not ask the user to click, scroll, or turn a public page for you"));

assert.ok(prompt.includes("搜索工具给候选来源"));
assert.ok(prompt.includes("页面工具读取候选页面"));
assert.ok(prompt.includes("web_card"));
assert.ok(prompt.includes("click_text"));
assert.ok(prompt.includes("页面状态才是证据"));
assert.ok(prompt.includes("不要让用户代点、代翻页、代滚动公开网页"));
assert.ok(prompt.includes("用 `web_snapshot` 自己点击、翻页、等待或滚动"));

const webSearchPlugin = await fs.readFile(path.join(repoRoot, "plugins", "web-image-search", "index.js"), "utf8");
assert.ok(webSearchPlugin.includes("external-current public facts"));
assert.ok(webSearchPlugin.includes("do not loop wording variants"));

const stickerPackPlugin = await fs.readFile(path.join(repoRoot, "plugins", "imagebot-sticker-pack", "index.js"), "utf8");
assert.ok(stickerPackPlugin.includes("add_from_sticker with a Telegram sticker file_id"));
assert.ok(stickerPackPlugin.includes("current/reply media handle resolved by runtime"));

const backgroundJobsManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "background_jobs.md"), "utf8");
assert.ok(backgroundJobsManual.includes("background_job"));
assert.ok(backgroundJobsManual.includes("does not start arbitrary work"));

const modelModeScript = await fs.readFile(path.join(repoRoot, "scripts", "SET_IMAGEBOT_MODEL_MODE.ps1"), "utf8");
assert.ok(modelModeScript.includes(".openclaw\\imagebot\\model-state.json"), "model mode script must write mutable state outside the repository");
assert.ok(modelModeScript.includes(".runtime\\generated"), "model mode script must keep generated batch files outside scripts/ source files");
assert.doesNotMatch(
  modelModeScript,
  /\$modelStatePath\s*=\s*Join-Path\s+\$repoRoot\s+'config\\imagebot\\model-state\.json'/,
  "model mode script must not write the tracked repo seed model-state.json",
);

console.log("imagebot config source tests passed", {
  groups: settings.groupIds.length,
  configOps: configOps.length,
  promptOps: promptOps.length,
  promptChars: prompt.length
});

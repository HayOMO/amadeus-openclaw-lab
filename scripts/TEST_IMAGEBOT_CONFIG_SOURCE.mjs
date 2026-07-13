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
const hasTemplateSettings = /^-100000000000\d+$/.test(String(settings.mainGroupId || ""));

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
  "config/imagebot/prompt/30-tool-index.md"
], "base prompt must stay behavior/tool-index focused; persona and task routing are model/runtime decisions");
assert.ok(prompt.includes("工具路由与回复形态："));
assert.ok(prompt.includes("称呼与唤醒："));
assert.ok(prompt.includes("“助手今天吃什么”是在叫你并问“今天吃什么”"));
assert.ok(prompt.includes("称呼不是句子的主语"));
assert.ok(prompt.includes("称呼本身不改变当前持久化人设"));
assert.ok(!prompt.includes("运行身份："));
assert.ok(!prompt.includes("群聊上下文："));
assert.ok(!prompt.includes("隐私与交付："));
assert.ok(!prompt.includes("active_persona"));
assert.ok(!prompt.includes("persona_profile"));
assert.ok(!prompt.includes("You are YOUR_BOT_USERNAME in a private Telegram group chat."));
assert.ok(prompt.includes("工具索引："));
assert.ok(prompt.includes("当前可见工具与延迟目录构成本轮动作空间"));
assert.ok(prompt.includes("延迟目录"));
assert.ok(prompt.includes("`tool_search`"));
assert.ok(prompt.includes("`tool_describe`"));
assert.ok(prompt.includes("`tool_call`"));
assert.ok(prompt.includes("`command_catalog`"));
assert.ok(prompt.includes("telegram_media_spoiler"));
assert.ok(prompt.includes("生成 Telegram 媒体交付标记"));
assert.ok(prompt.includes("`web_search` 由运行时按当前模型路由"));
assert.ok(prompt.includes("模型切换与 fallback 后仍按实际提供方选择"));
assert.ok(prompt.includes("默认先使用当前模型/提供方自己的原生 `web_search`"));
assert.ok(prompt.includes("二次元、贴纸或插画类型本身不构成先反搜的条件"));
assert.ok(prompt.includes("Google Search/Images/Lens 都必须走 `bot`"));
assert.ok(prompt.includes("外部/当前证据"));
assert.ok(prompt.includes("memory_search"));
assert.ok(prompt.includes("按用户、群和窗口隔离"));
assert.ok(prompt.length < 5_000, `base prompt should stay compact, got ${prompt.length} chars`);
assert.ok((prompt.match(/不要|不能|不得|禁止/g) || []).length <= 2, "base prompt should not grow into negative-instruction patches");
assert.ok(!prompt.includes("元提示"), "operator meta-instructions must stay outside the bot base prompt");
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

for (const tool of ["telegram_media_spoiler", "download_image_url", "download_image_urls", "danbooru_resource", "browser", "web_snapshot", "web_card", "generated_gallery", "generated_gallery_resend", "media_artifact", "artifact", "zhihu", "group_adventure", "background_job", "turn_observer_recent", "image_skill", "image_skill_save_reference", "image_skill_note_preference", "meme_transform", "knowledge", "knowledge_ingest", "media_brief", "audio_transcribe", "public_video", "pixiv_resource", "sticker_pack", "desktop_media_control", "mars_forward_lookup", "persona_config", "message"]) {
  assert.ok(settings.allowedTools.includes(tool), `missing allowed tool ${tool}`);
}
for (const tool of ["generated_gallery_recent", "generated_gallery_search", "generated_gallery_stats", "media_artifact_recent", "media_artifact_lineage", "artifact_recent", "artifact_search", "artifact_get", "image_skill_lookup", "image_skill_recent", "knowledge_sources", "knowledge_search", "knowledge_recent", "zhihu_search", "zhihu_global_search", "zhihu_hot_list"]) {
  assert.ok(!settings.allowedTools.includes(tool), `legacy split tool should not be directly exposed: ${tool}`);
}
assert.ok(settings.allowedTools.includes("web_search"), "web_search must pass tool policy so OpenClaw can activate provider-native search");

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
  assert.ok(op.value.includes("browser"), `${pathName} must expose OpenClaw browser for full interactive browser work`);
  assert.ok(op.value.includes("web_card"), `${pathName} must expose web_card`);
  assert.ok(op.value.includes("background_job"), `${pathName} must expose background_job`);
  assert.ok(op.value.includes("web_search"), `${pathName} must permit provider-native web search`);
}

const browserConfigOp = configOps.find((item) => item.path === "browser");
assert.equal(browserConfigOp?.value?.defaultProfile, "bot", "browser must default to the Bot-owned OpenClaw profile");
assert.deepEqual(Object.keys(browserConfigOp?.value?.profiles || {}).sort(), ["bot", "isolated"], "browser must expose exactly the Bot-owned and isolated profiles");
assert.notEqual(browserConfigOp?.value?.profiles?.bot?.cdpPort, browserConfigOp?.value?.profiles?.isolated?.cdpPort, "browser profiles must use distinct CDP ports");
assert.equal(browserConfigOp?.value?.evaluateEnabled, true, "the Bot-owned browser must expose the full browser action surface");
assert.equal(browserConfigOp?.value?.ssrfPolicy?.dangerouslyAllowPrivateNetwork, true, "browser must not be crippled by a narrow host allowlist");
assert.equal(Object.hasOwn(browserConfigOp?.value?.ssrfPolicy || {}, "hostnameAllowlist"), false, "browser workflow should not hardcode site allowlists");
assert.equal(Object.hasOwn(browserConfigOp?.value?.ssrfPolicy || {}, "allowedHostnames"), false, "browser workflow should not hardcode site allowlists");

assert.ok(
  !configOps.some((item) => item.path === "channels.telegram.accounts.imagebot.mentionPatterns"),
  "imagebot account mentionPatterns is a channel policy object, not the mention regex list",
);

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
const deepSeekSearchConfig = configOps.find((item) => item.path === "plugins.entries.imagebot-deepseek-search.config")?.value;
assert.equal(deepSeekSearchConfig?.model, "deepseek-v4-flash", "DeepSeek managed search should remain available after model fallback");
assert.equal(deepSeekSearchConfig?.baseUrl, "https://api.deepseek.com/anthropic", "DeepSeek native search must use the documented Anthropic-compatible route");
assert.ok(deepSeekSearchConfig?.secretFile?.endsWith(`secrets${path.sep}deepseek-api-key.token`), "DeepSeek search must reuse the Bot-owned API credential file");

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

for (const pathName of ["channels.telegram.streaming", "channels.telegram.accounts.imagebot.streaming"]) {
  const op = configOps.find((item) => item.path === pathName);
  assert.ok(op, `missing Telegram progress config: ${pathName}`);
  assert.equal(op.value.mode, "progress", `${pathName} must use the native progress draft mode`);
  assert.equal(op.value.progress?.toolProgress, true, `${pathName} must expose real tool-stage progress`);
  assert.equal(op.value.progress?.commentary, false, `${pathName} must not stream private model commentary`);
  assert.equal(op.value.progress?.commandText, "status", `${pathName} must keep raw commands out of public progress`);
  assert.ok(op.value.progress?.maxLines <= 4, `${pathName} progress should stay compact`);
}
for (const pathName of ["channels.telegram.retry", "channels.telegram.accounts.imagebot.retry"]) {
  const op = configOps.find((item) => item.path === pathName);
  assert.ok(op, `missing Telegram retry config: ${pathName}`);
  assert.deepEqual(op.value, { attempts: 3, minDelayMs: 400, maxDelayMs: 30_000, jitter: 0.1 });
}

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
  primary: "openai/gpt-5.6-sol",
  fallbacks: expectedChatFallbacks,
});
const agentModelOp = configOps.find((item) => item.path === "agents.list[0].model");
assert.ok(agentModelOp, "missing imagebot agent model config");
assert.deepEqual(agentModelOp.value, {
  primary: "openai/gpt-5.6-sol",
  fallbacks: expectedChatFallbacks,
});
const openAiProviderModels = configOps.find((item) => item.path === "models.providers.openai.models")?.value;
const solModel = openAiProviderModels?.find((model) => model.id === "gpt-5.6-sol");
assert.deepEqual(solModel?.input, ["text", "image"], "GPT-5.6 Sol must be registered as native multimodal");
assert.equal(solModel?.contextTokens, 272_000, "GPT-5.6 Sol must use the OpenAI context cap");
for (const id of ["gpt-5.6-terra", "gpt-5.6-luna"]) {
  assert.deepEqual(
    openAiProviderModels?.find((model) => model.id === id)?.input,
    ["text", "image"],
    `${id} must use its verified Codex image-input capability`
  );
}
assert.equal(openAiProviderModels?.some((model) => model.id === "gpt-5.3-codex-spark"), false, "the backend provider must exclude Codex models with supported_in_api=false");
assert.deepEqual(
  configOps.find((item) => item.path === "agents.defaults.imageModel")?.value,
  { primary: "openai/gpt-5.6-sol" },
  "the image analysis fallback must use GPT-5.6 Sol"
);

const modelStateTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-model-state-"));
const previousModelStateFile = process.env.OPENCLAW_IMAGEBOT_MODEL_STATE_FILE;
try {
  const runtimeModelStatePath = path.join(modelStateTempDir, "model-state.json");
  await fs.writeFile(
    runtimeModelStatePath,
    `${JSON.stringify({ model: "deepseek/deepseek-v4-flash", reasoningEffort: "low", textVerbosity: "high", maxTokens: 1536 }, null, 2)}\n`,
    "utf8",
  );
  process.env.OPENCLAW_IMAGEBOT_MODEL_STATE_FILE = runtimeModelStatePath;
  if (!hasTemplateSettings) {
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
    assert.equal(
      runtimeStateResult.configOps.find((item) => item.path === "agents.list[0].params.maxTokens")?.value,
      1536,
      "runtime model-state should apply an explicit maxTokens cap only when configured",
    );
  }

  const templateResult = await buildImagebotConfig({ write: false, template: true });
  assert.deepEqual(
    templateResult.configOps.find((item) => item.path === "agents.defaults.model")?.value,
    { primary: "openai/gpt-5.6-sol", fallbacks: expectedChatFallbacks },
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
const applyConfigScript = await fs.readFile(path.join(repoRoot, "scripts", "APPLY_CHAT_BALANCE_MODE.ps1"), "utf8");
assert.match(applyConfigScript, /foreach \(\$provider in @\("openai", "deepseek"\)\)/, "config apply should clean up stale managed provider wildcards");
assert.match(applyConfigScript, /config set --batch-file \$configBatch --replace/, "config apply must explicitly replace the verified backend model catalog so unsupported stale entries are removed");
assert.match(applyConfigScript, /agents\.defaults\.models\[\"' \+ \$provider \+ '\/\*\"\]/, "config apply should unset a stale default provider wildcard");
assert.match(setModelScript, /\$chatModelConfig = @\{\s+primary = \$effectiveModel\s+fallbacks = \$effectiveFallbacks\s+\}/s);
assert.doesNotMatch(setModelScript, /agents\.defaults\.model\.primary/);
assert.match(setModelScript, /\$MaxTokens -gt 0[\s\S]+agents\.list\[0\]\.params\.maxTokens/, "model mode script should write maxTokens only when explicitly configured");
assert.match(setModelScript, /openclaw config unset 'agents\.list\[0\]\.params\.maxTokens'/, "model mode script should unset stale maxTokens when the field is left unset");
for (const wildcard of ["openai/*"]) {
  for (const prefix of ["agents.defaults.models", "agents.list[0].models"]) {
    const pathName = `${prefix}["${wildcard}"]`;
    const op = configOps.find((item) => item.path === pathName);
    assert.ok(op, `missing dynamic provider model allowlist op ${pathName}`);
    assert.deepEqual(op.value, {}, `${pathName} should use OpenClaw provider discovery`);
  }
}
for (const prefix of ["agents.defaults.models", "agents.list[0].models"]) {
  assert.equal(
    configOps.some((item) => item.path === `${prefix}["deepseek/*"]`),
    false,
    `DeepSeek should remain an exact curated fallback instead of exposing its provider catalog through ${prefix}`,
  );
}
for (const [modelId, alias] of [
  ["openai/gpt-5.6-sol", ""],
  ["openai/gpt-5.6-terra", "terra"],
  ["openai/gpt-5.6-luna", "luna"],
  ["openai/gpt-5.5", "fast"],
  ["openai/gpt-5.4", "gpt54"],
  ["openai/gpt-5.4-mini", "mini"],
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
for (const prefix of ["agents.defaults.models", "agents.list[0].models"]) {
  assert.equal(
    configOps.some((item) => item.path === `${prefix}["openai/gpt-5.3-codex-spark"]`),
    false,
    "the unsupported Spark backend route must not remain allowlisted"
  );
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
const browserGuardConfig = configOps.find((op) => op.path === "plugins.entries.imagebot-browser-guard.config")?.value;
assert.deepEqual(browserGuardConfig?.allowedProfiles, ["bot", "isolated"], "browser guard must permit only the Bot-owned and isolated profiles");
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
for (const pluginId of ["imagebot-deepseek-search"]) {
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
assert.ok(!Object.hasOwn(webImageConfig, "googleLens"), "Google Lens must stay a browser workflow, not a reverse_image_search plugin fallback");
const toolIndexPrompt = await fs.readFile(path.join(repoRoot, "config", "imagebot", "prompt", "30-tool-index.md"), "utf8");
assert.match(toolIndexPrompt, /`web_image_search`/, "tool index should describe generic image search");
assert.match(toolIndexPrompt, /`reverse_image_search`/, "tool index should describe reverse source search");
assert.match(toolIndexPrompt, /省略 profile 或使用 `bot`.*默认 profile/, "tool index should expose the Bot-owned browser policy");
assert.match(toolIndexPrompt, /`web_card` \/ `web_snapshot`/, "tool index should expose lightweight page readers");
assert.match(toolIndexPrompt, /具体 action 和审批边界见对应手册与 schema/, "tool index should defer detailed workflows to manuals and schemas");
assert.ok(toolIndexPrompt.length < 2_500, `tool index should stay capability-focused, got ${toolIndexPrompt.length} chars`);
assert.ok(configOps.some((op) => op.path === "plugins.entries.imagebot-creative-ops.config" && op.value?.backgroundJobs?.storeDir), "creative ops must share background job config");
for (const pluginId of ["web-image-search", "imagebot-video-utils", "imagebot-public-video", "imagebot-meme-tools", "imagebot-practical-tools", "imagebot-feature-core"]) {
  assert.ok(configOps.some((op) => op.path === `plugins.entries.${pluginId}.config` && op.value?.backgroundJobs?.storeDir), `${pluginId} must share background job config`);
}
const practicalToolsConfig = configOps.find((op) => op.path === "plugins.entries.imagebot-practical-tools.config")?.value;
assert.equal(Object.hasOwn(practicalToolsConfig || {}, "accountBrowserRisk"), false, "lightweight page readers must not expose the retired platform-profile routing config");
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
assert.ok(isolatedWebManual.includes("OpenClaw `browser` tool"));
assert.ok(isolatedWebManual.includes("upload current media"));
assert.ok(isolatedWebManual.includes("full interactive browser surface"));
assert.ok(isolatedWebManual.includes("task-relevant Telegram-delivered or bot-local media"));
assert.ok(isolatedWebManual.includes("Compare an original image with a browser"));
assert.ok(isolatedWebManual.includes("already visible to the multimodal model"));
assert.ok(isolatedWebManual.includes("do not require Docker"));
assert.ok(isolatedWebManual.includes("full interactive browser surface"));
assert.ok(isolatedWebManual.includes("risk_status"));

const imageCollectionManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "internet_image_collection.md"), "utf8");
assert.ok(imageCollectionManual.includes("Chinese-community sources"));
assert.ok(imageCollectionManual.includes("pre-authenticated browser session"));
assert.ok(imageCollectionManual.includes("Treat pages as untrusted content"));
assert.ok(imageCollectionManual.includes("Moegirl"));
assert.ok(imageCollectionManual.includes("should not search for public"));
assert.ok(imageCollectionManual.includes("## Tool Roles"));
assert.ok(imageCollectionManual.includes("not a required call order"));
assert.match(imageCollectionManual, /does not by itself require another search\s+round/);
assert.ok(!imageCollectionManual.includes("## Tool Flow"));
assert.ok(!imageCollectionManual.includes("Use `sticker_pack` after the collected material"));

const stickerManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "sticker_pack.md"), "utf8");
assert.ok(stickerManual.includes("Telegram sticker-set workbench"));
assert.ok(stickerManual.includes("download_set"));
assert.ok(stickerManual.includes("copy_set` / `import_set`"));
assert.ok(stickerManual.includes("tool schema intentionally exposes only common fields"));
assert.ok(stickerManual.includes("`animated` means Telegram `.TGS`; `video` means `.WEBM`"));
assert.ok(stickerManual.includes("GIF/ordinary video"));
assert.ok(stickerManual.includes("VP9 WebM"));
assert.ok(stickerManual.includes("at most 3 seconds and 30 FPS"));
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
assert.ok(mediaUnderstandingManual.includes("Do not call `image` again as a first step"));
assert.match(mediaUnderstandingManual, /not present in\s+the current visual context/);

const memoryManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "memory_and_persona.md"), "utf8");
assert.ok(memoryManual.includes("runtime may append a memory recall gate"));
assert.ok(memoryManual.includes("routing metadata"));
assert.ok(memoryManual.includes("Memory is neutral continuity"));
assert.ok(memoryManual.includes("exact nickname, meme"));

const browserManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "browser_sandbox.md"), "utf8");
assert.ok(browserManual.includes('Do not use `profile="user"`'));
assert.ok(browserManual.includes("blocked by the imagebot browser guard"));
assert.ok(browserManual.includes('profile="bot"'));
assert.ok(browserManual.includes('profile="isolated"'));
assert.ok(browserManual.includes("do not use it for Google"));
assert.match(browserManual, /prefer Yandex\s+Images/);
assert.ok(browserManual.includes("Do not silently switch to Bing"));
assert.ok(browserManual.includes("Xiaohongshu, Weibo, Bilibili, Baidu/Tieba, Zhihu, and Pixiv"));
assert.match(browserManual, /Google and\s+LOFTER are not verified as logged in/);
assert.ok(!browserManual.includes("ChatGPT / OpenAI"));
assert.match(browserManual, /broadest\s+general visual-search\s+capability/);
assert.ok(browserManual.includes("not a required order"));

const searchManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "search_and_references.md"), "utf8");
assert.ok(searchManual.includes("catalog invisibility alone is not"));
assert.ok(searchManual.includes("default first step"));
assert.ok(searchManual.includes("Source-Site Hints"));
assert.ok(searchManual.includes("zh.moegirl.org.cn"));
assert.ok(searchManual.includes("bounded generic public text search"));
assert.ok(searchManual.includes("source leads: title, URL, snippet"));
assert.ok(searchManual.includes("Danbooru-native image search/read/download"));
assert.ok(searchManual.includes("Returns image"));
assert.ok(searchManual.includes("Omitting"));
assert.ok(searchManual.includes("default first step for character, object, photo, or place identification"));
assert.ok(searchManual.includes("Similar-only candidates do not prove"));
assert.match(searchManual, /broadest\s+general visual-search capability/);
assert.ok(searchManual.includes("not a mandatory fallback step"));
assert.ok(searchManual.includes("Page tools return page-level evidence"));

assert.ok(prompt.includes("搜索工具给候选来源"));
assert.ok(prompt.includes("页面工具读取候选页面"));
assert.ok(prompt.includes("已作为原生多模态输入出现时，直接观察和回答，不要再调用 `image`"));
assert.ok(prompt.includes("省略 profile 或使用 `bot`"));
assert.ok(prompt.includes("web_card"));
assert.ok(prompt.includes("角色图像生成遇到知名角色且当前信息不足以稳定还原时"));
assert.ok(prompt.includes("这是还原偏好，不是固定前置步骤"));
assert.ok(!prompt.includes("工作偏好"));
assert.ok(!prompt.includes("现有图片出处结合相似度、来源页、作者/作品信息和可见图像证据判断"));
assert.ok(!prompt.includes("图像生成默认创建新图"));

const webSearchPlugin = await fs.readFile(path.join(repoRoot, "plugins", "web-image-search", "index.js"), "utf8");
assert.ok(webSearchPlugin.includes("Use provider-native web_search first."));
assert.ok(webSearchPlugin.includes("native search is unavailable, fails, returns insufficient evidence"));
assert.ok(webSearchPlugin.includes("continue from that evidence"));

const stickerPackPlugin = await fs.readFile(path.join(repoRoot, "plugins", "imagebot-sticker-pack", "index.js"), "utf8");
assert.ok(stickerPackPlugin.includes("add_from_sticker with a Telegram sticker file_id"));
assert.ok(stickerPackPlugin.includes("current/reply media handle resolved by runtime"));
assert.ok(stickerPackPlugin.includes('"libvpx-vp9"'));
assert.ok(stickerPackPlugin.includes("validateVideoStickerProbe"));

const backgroundJobsManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "background_jobs.md"), "utf8");
assert.ok(backgroundJobsManual.includes("background_job"));
assert.ok(backgroundJobsManual.includes("does not start arbitrary work"));

const imageGenerationManual = await fs.readFile(path.join(repoRoot, "tool_manuals", "image_generation.md"), "utf8");
assert.ok(imageGenerationManual.includes("concrete failure reason"));
assert.ok(imageGenerationManual.includes("A generated image from the current turn is not a default reference"));
assert.ok(imageGenerationManual.includes("Before generation, verify the character's source title"));
assert.ok(imageGenerationManual.includes("Named Artist / Style"));
assert.ok(imageGenerationManual.includes("representative public works"));

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

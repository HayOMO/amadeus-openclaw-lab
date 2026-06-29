import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin, { __testing } from "../plugins/imagebot-creative-ops/index.js";
import { getBackgroundJobManager } from "../plugins/imagebot-background-jobs/index.js";
import { __testing as manualTesting } from "../plugins/imagebot-tool-manual-search/index.js";

const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-creative-ops-test-"));
const repoRoot = process.cwd();
const openClawConfigPath = path.join(storeDir, "openclaw.json");
const sessionStorePath = path.join(storeDir, "sessions.json");
const backgroundJobsStoreDir = path.join(storeDir, "background-jobs");
await fs.writeFile(openClawConfigPath, JSON.stringify({
  models: { providers: { openai: {} } },
  agents: {
    defaults: {
      imageModel: { primary: "openai/gpt-5.5" },
      imageGenerationModel: { primary: "openai/gpt-image-2" }
    },
    list: [{
      id: "imagebot",
      model: "openai/gpt-5.5",
      params: {
        reasoningEffort: "medium",
        textVerbosity: "low"
      }
    }]
  }
}, null, 2));
const tools = new Map();
const hooks = new Map();
const requestCtx = {
  agentId: "imagebot",
  accountId: "imagebot",
  channel: "telegram",
  chatId: "unit-chat",
  sessionKey: "unit-session",
  senderId: "42",
  messageId: "100",
  text: "please plan this"
};
const approvalCtx = (code, overrides = {}) => ({
  ...requestCtx,
  messageId: "101",
  text: `approve ${code}`,
  ...overrides
});

plugin.register({
  config: {
    storeDir,
    repoRoot,
    openClawConfigPath,
    sessionStorePath,
    disableDelayedSessionModelOverride: true,
    appendFeedbackHints: true,
    allowMutatingScripts: true,
    backgroundJobs: { storeDir: backgroundJobsStoreDir, maxConcurrent: 1 }
  },
  registerTool(tool, opts) {
    tools.set(opts?.name || tool.name, tool);
  },
  registerHook(name, handler) {
    const list = hooks.get(name) || [];
    list.push(handler);
    hooks.set(name, list);
  }
});

for (const name of ["script_action", "prompt_library", "image_feedback", "model_config", "command_catalog"]) {
  assert.ok(tools.has(name), `${name} should be registered`);
}
assert.ok(hooks.has("before_prompt_build"), "feedback hook should be registered");
assert.ok(tools.get("model_config").parameters.properties.action.enum.includes("restart"));
assert.ok(tools.get("model_config").parameters.properties.action.enum.includes("plan"));
assert.ok(Object.hasOwn(tools.get("model_config").parameters.properties, "restartGateway"));
assert.ok(tools.get("script_action").parameters.properties.action.enum.includes("run_background"));
assert.ok(tools.get("command_catalog").parameters.properties.action.enum.includes("abilities"));

const list = await tools.get("script_action").execute("script-list", { action: "list" });
assert.equal(list.details.status, "ok");
assert.ok(list.details.scripts.some((script) => script.id === "gateway_status"));
assert.equal(list.details.scripts.find((script) => script.id === "archive_media_cache")?.requiresApproval, true);
assert.equal(list.details.scripts.find((script) => script.id === "export_memory_backup")?.requiresApproval, true);

const commandList = await tools.get("command_catalog").execute("command-list", { action: "list", category: "ops" });
assert.equal(commandList.details.status, "ok");
assert.ok(commandList.details.commands.some((command) => command.command === "ammodel"));

const commandMenuList = await tools.get("command_catalog").execute("command-menu-list", { action: "list", menuOnly: true });
assert.equal(commandMenuList.details.status, "ok");
assert.ok(commandMenuList.details.commands.some((command) => command.command === "amnew"));
assert.ok(commandMenuList.details.commands.some((command) => command.command === "ampersona"));
assert.ok(!commandMenuList.details.commands.some((command) => command.command === "ampdf"));
assert.ok(commandMenuList.details.capabilities.some((capability) => capability.id === "image"));
assert.match(commandMenuList.content[0].text, /她大概会这些/);
assert.match(commandMenuList.content[0].text, /生图/);

const abilities = await tools.get("command_catalog").execute("command-abilities", { action: "abilities", query: "网页 截图" });
assert.equal(abilities.details.status, "ok");
assert.ok(abilities.details.capabilities.some((capability) => capability.id === "web"));

const commandRoute = await tools.get("command_catalog").execute("command-route", { action: "route", query: "/amstatus" });
assert.equal(commandRoute.details.status, "ok");
assert.equal(commandRoute.details.results[0].command.command, "amstatus");
assert.equal(commandRoute.details.results[0].command.scriptId, "gateway_status");

const routed = await tools.get("script_action").execute("script-route", {
  action: "route",
  query: "check gateway health status"
});
assert.equal(routed.details.status, "ok");
assert.equal(routed.details.results[0].id, "gateway_status");

const riskyRun = await tools.get("script_action").execute("script-risky", {
  action: "run",
  id: "sync_telegram_commands"
});
assert.equal(riskyRun.details.status, "failed");
assert.match(riskyRun.content[0].text, /plan_id/i);

const localWriteRun = await tools.get("script_action").execute("script-local-write", {
  action: "run",
  id: "export_memory_backup"
});
assert.equal(localWriteRun.details.status, "failed");
assert.match(localWriteRun.content[0].text, /plan_id/i);

const plan = await tools.get("script_action").execute("script-plan", {
  action: "plan",
  id: "sync_telegram_commands",
  reason: "unit test"
}, null, null, requestCtx);
assert.equal(plan.details.status, "ok");
assert.ok(plan.details.plan.approvalCode.startsWith("APPROVE-"));

const badApproval = await tools.get("script_action").execute("script-bad-approval", {
  action: "run",
  id: "sync_telegram_commands",
  plan_id: plan.details.plan.id,
  approval_text: "nope"
}, null, null, approvalCtx("nope"));
assert.equal(badApproval.details.status, "failed");
assert.match(badApproval.content[0].text, /Trusted approval/i);

const modelFilledApproval = await tools.get("script_action").execute("script-model-filled-approval", {
  action: "run",
  id: "sync_telegram_commands",
  plan_id: plan.details.plan.id,
  approval_text: plan.details.plan.approvalCode
}, null, null, { ...requestCtx, messageId: "101", text: "no approval code here" });
assert.equal(modelFilledApproval.details.status, "failed");
assert.match(modelFilledApproval.details.error, /Trusted approval/i);

const wrongActorApproval = await tools.get("script_action").execute("script-wrong-actor", {
  action: "run",
  id: "sync_telegram_commands",
  plan_id: plan.details.plan.id
}, null, null, approvalCtx(plan.details.plan.approvalCode, { senderId: "99" }));
assert.equal(wrongActorApproval.details.status, "failed");
assert.match(wrongActorApproval.details.error, /original requester/i);

__testing.SCRIPT_REGISTRY.push({
  id: "unit_background_echo",
  title: "Unit background echo",
  description: "Test-only read script for background execution.",
  risk: "read",
  command: process.execPath,
  args: ["-e", "setTimeout(() => { console.log('background-ok') }, 30)"],
  keywords: ["unit", "background"]
});
const backgroundRun = await tools.get("script_action").execute("script-background", {
  action: "run_background",
  id: "unit_background_echo",
  dedupe_key: "unit-background-echo"
}, null, null, { agentId: "imagebot", chatId: "unit-chat", sessionKey: "unit-session" });
assert.equal(backgroundRun.details.status, "ok");
assert.equal(backgroundRun.details.action, "run_background");
assert.equal(backgroundRun.details.job.state, "queued");
const backgroundManager = getBackgroundJobManager({ storeDir: backgroundJobsStoreDir, maxConcurrent: 1 });
const backgroundFinal = await backgroundManager.waitForJob(backgroundRun.details.job.id, 2000);
assert.equal(backgroundFinal.state, "completed");
assert.equal(backgroundFinal.result.scriptId, "unit_background_echo");
assert.match(backgroundFinal.result.stdout, /background-ok/);

const modelStatus = await tools.get("model_config").execute("model-get", {
  action: "get"
});
assert.equal(modelStatus.details.status, "ok");
assert.equal(modelStatus.details.current.profileId, "balanced");

const modelProfiles = await tools.get("model_config").execute("model-profiles", {
  action: "profiles"
});
assert.equal(modelProfiles.details.status, "ok");
assert.ok(modelProfiles.details.profiles.some((profile) => profile.id === "deep"));

const modelSetWithoutPlan = await tools.get("model_config").execute("model-set-no-plan", {
  action: "set",
  mode: "balanced"
});
assert.equal(modelSetWithoutPlan.details.status, "failed");
assert.match(modelSetWithoutPlan.content[0].text, /plan_id/i);

const modelPlan = await tools.get("model_config").execute("model-plan", {
  action: "plan",
  mode: "balanced",
  reason: "unit test"
}, null, null, requestCtx);
assert.equal(modelPlan.details.status, "ok");
assert.ok(modelPlan.details.plan.approvalCode.startsWith("APPROVE-MODEL-"));

const modelBadApproval = await tools.get("model_config").execute("model-bad-approval", {
  action: "set",
  mode: "balanced",
  plan_id: modelPlan.details.plan.id,
  approval_text: "nope"
}, null, null, approvalCtx("nope"));
assert.equal(modelBadApproval.details.status, "failed");
assert.match(modelBadApproval.content[0].text, /Trusted approval/i);

const modelSameMessageApproval = await tools.get("model_config").execute("model-same-message", {
  action: "set",
  mode: "balanced",
  plan_id: modelPlan.details.plan.id
}, null, null, { ...requestCtx, text: `approve ${modelPlan.details.plan.approvalCode}` });
assert.equal(modelSameMessageApproval.details.status, "failed");
assert.match(modelSameMessageApproval.details.error, /later user message/i);

const restartWithoutPlan = await tools.get("model_config").execute("restart-no-plan", {
  action: "restart"
});
assert.equal(restartWithoutPlan.details.status, "failed");
assert.match(restartWithoutPlan.content[0].text, /plan_id/i);

const restartPlan = await tools.get("model_config").execute("restart-plan", {
  action: "plan",
  targetAction: "restart",
  reason: "unit test"
}, null, null, requestCtx);
assert.equal(restartPlan.details.status, "ok");
assert.equal(restartPlan.details.plan.plannedAction, "restart");

await fs.writeFile(sessionStorePath, JSON.stringify({
  "telegram:test-session": {
    sessionId: "session-1",
    modelProvider: "openai",
    model: "gpt-5.5",
    contextTokens: 123,
    authProfileOverride: "openai:old"
  }
}, null, 2));
const sessionOverride = await __testing.applySessionModelOverride({
  sessionStorePath
}, { agentId: "imagebot", sessionKey: "telegram:test-session" }, {
  model: "deepseek/deepseek-v4-flash",
  reasoningEffort: "low"
});
assert.equal(sessionOverride.applied, true);
const sessionStore = JSON.parse(await fs.readFile(sessionStorePath, "utf8"));
assert.equal(sessionStore["telegram:test-session"].providerOverride, "deepseek");
assert.equal(sessionStore["telegram:test-session"].modelOverride, "deepseek-v4-flash");
assert.equal(sessionStore["telegram:test-session"].modelOverrideSource, "user");
assert.equal(sessionStore["telegram:test-session"].liveModelSwitchPending, true);
assert.equal(sessionStore["telegram:test-session"].thinkingLevel, "low");
assert.equal(sessionStore["telegram:test-session"].modelProvider, undefined);
assert.equal(sessionStore["telegram:test-session"].model, undefined);
assert.equal(sessionStore["telegram:test-session"].contextTokens, undefined);
assert.equal(sessionStore["telegram:test-session"].authProfileOverride, undefined);

assert.throws(() => __testing.validateModelSettings({
  model: "unknown/nope",
  reasoningEffort: "medium",
  textVerbosity: "low"
}, {
  models: [{ id: "openai/gpt-5.5", enabled: true }],
  reasoningEfforts: ["medium"],
  textVerbosity: ["low"]
}), /not enabled/);

const cards = await tools.get("prompt_library").execute("cards-list", {
  action: "list",
  type: "recipe",
  count: 10
});
assert.equal(cards.details.status, "ok");
assert.ok(cards.details.results.some((card) => card.id === "recipe.official_character_generation"));

const search = await tools.get("prompt_library").execute("cards-search", {
  action: "search",
  query: "official character reference generation"
});
assert.equal(search.details.status, "ok");
assert.equal(search.details.results[0].id, "recipe.official_character_generation");

const got = await tools.get("prompt_library").execute("cards-get", {
  action: "get",
  id: "official_character_generation"
});
assert.equal(got.details.status, "ok");
assert.match(got.content[0].text, /official/i);

const composed = await tools.get("prompt_library").execute("cards-compose", {
  action: "compose",
  request: "Draw a specified anime character as a Telegram sticker.",
  card_ids: ["recipe.official_character_generation", "recipe.meme_sticker", "negative.common_anime_failures"]
});
assert.equal(composed.details.status, "ok");
assert.match(composed.content[0].text, /Selected cards/);
assert.match(composed.content[0].text, /Meme And Sticker/);

const feedback = await tools.get("image_feedback").execute("feedback-record", {
  action: "record",
  rating: "bad",
  subject: "official character reference",
  target: "gallery:test",
  keep: "clean cel shading",
  avoid: "wrong hair color and random fanart outfit",
  notes: "Reference was not strict enough.",
  tags: ["character", "reference"]
});
assert.equal(feedback.details.status, "ok");

const feedbackSearch = await tools.get("image_feedback").execute("feedback-search", {
  action: "search",
  query: "character wrong hair color reference"
});
assert.equal(feedbackSearch.details.status, "ok");
assert.equal(feedbackSearch.details.results[0].id, feedback.details.feedback.id);

const promptHook = await hooks.get("before_prompt_build")[0]({
  prompt: "Please draw an official character reference with correct hair color."
}, { agentId: "imagebot", sessionKey: "test" });
assert.ok(promptHook?.appendContext.includes("Imagebot image feedback hints"));
assert.ok(promptHook.appendContext.includes("wrong hair color"));

const manuals = await manualTesting.searchManuals({
  query: "script registry prompt library image feedback",
  focus: "creative_ops",
  count: 3
});
assert.ok(manuals.some((entry) => entry.id === "creative_ops"));

const manualFocusValues = manualTesting.focusValues();
for (const id of ["public_video", "meme_tools", "image_skills", "sticker_pack", "turn_observer"]) {
  assert.ok(manualFocusValues.includes(id), `manual focus enum must include ${id}`);
}

const publicVideoManuals = await manualTesting.searchManuals({
  query: "公开视频 字幕 下载",
  focus: "public_video",
  count: 2
});
assert.equal(publicVideoManuals[0].id, "public_video");

const memeManuals = await manualTesting.searchManuals({
  query: "表情包 加字 贴纸",
  focus: "meme_tools",
  count: 2
});
assert.equal(memeManuals[0].id, "meme_tools");

const perfManuals = await manualTesting.searchManuals({
  query: "performance budget hook overhead prompt library",
  focus: "agent_extension_performance",
  count: 2
});
assert.ok(perfManuals.some((entry) => entry.id === "agent_extension_performance"));

assert.ok(__testing.findScript("gateway_status"));
assert.ok(__testing.needsApproval(__testing.findScript("sync_telegram_commands")));
assert.ok(__testing.routeScripts("backup github").some((entry) => entry.script.id === "backup_to_github"));

console.log("creative-ops plugin tests passed");

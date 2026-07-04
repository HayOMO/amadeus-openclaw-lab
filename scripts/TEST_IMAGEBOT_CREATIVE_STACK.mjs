import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import toolManualSearch from "../plugins/imagebot-tool-manual-search/index.js";
import agentOps from "../plugins/imagebot-agent-ops/index.js";
import creativeOps from "../plugins/imagebot-creative-ops/index.js";
import featureCore from "../plugins/imagebot-feature-core/index.js";
import interactionCore from "../plugins/imagebot-interaction-core/index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-creative-stack-test-"));
const openClawConfigPath = path.join(root, "openclaw.json");
await fs.writeFile(openClawConfigPath, JSON.stringify({
  models: { providers: { openai: {} } },
  agents: {
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

function register(plugin, config = {}) {
  plugin.register({
    config,
    registerTool(tool, opts) {
      const name = opts?.name || tool.name;
      assert.ok(!tools.has(name), `duplicate tool: ${name}`);
      tools.set(name, tool);
    },
    registerHook(name, handler) {
      const list = hooks.get(name) || [];
      list.push(handler);
      hooks.set(name, list);
    }
  });
}

register(toolManualSearch);
register(interactionCore, {
  botUsernames: ["YOUR_BOT_USERNAME"],
  triggerPrefixes: ["助手", "amadeus", "kurisu"],
  appendInteractionContext: true
});
register(agentOps, { storeDir: path.join(root, "agent-ops"), repoRoot: process.cwd() });
register(featureCore, {
  storeDir: path.join(root, "feature-core"),
  featuresDir: path.join(process.cwd(), "features"),
  timezoneOffsetMinutes: 480
});
register(creativeOps, {
  storeDir: path.join(root, "creative-ops"),
  repoRoot: process.cwd(),
  openClawConfigPath,
  appendFeedbackHints: true,
  allowMutatingScripts: true
});

for (const name of [
  "tool_manual_search",
  "interaction_pipeline",
  "agent_mode",
  "persona_config",
  "learned_skill",
  "failure_memory",
  "script_action",
  "prompt_library",
  "image_feedback",
  "model_config",
  "command_catalog",
  "feature_catalog",
  "feature_action"
]) {
  assert.ok(tools.has(name), `${name} should be available`);
}

const manual = await tools.get("tool_manual_search").execute("manual", {
  action: "search",
  query: "telegram command catalog natural language command script prompt library feedback ammodel model profile",
  focus: "creative_ops",
  count: 2
});
assert.equal(manual.details.status, "ok");
assert.match(manual.content[0].text, /creative_ops/);

const routedTurn = await tools.get("interaction_pipeline").execute("interaction-route", {
  action: "evaluate",
  text: "@YOUR_BOT_USERNAME 签到",
  isGroup: true,
  botUsername: "YOUR_BOT_USERNAME",
  userId: "10001",
  chatId: "-100test"
});
assert.equal(routedTurn.details.status, "ok");
assert.equal(routedTurn.details.result.shouldRespond, true);
assert.equal(routedTurn.details.result.reason, "bot_mention");

const skillProposal = await tools.get("learned_skill").execute("skill-propose", {
  action: "propose",
  title: "Use prompt library before complex image requests",
  trigger: "complex image prompt or specified character",
  instructions: "Search prompt_library before complex image generation and compose from relevant cards."
});
await tools.get("learned_skill").execute("skill-approve", {
  action: "approve",
  id: skillProposal.details.skill.id
});

await tools.get("image_feedback").execute("feedback", {
  action: "record",
  rating: "mixed",
  subject: "specified character image",
  keep: "official anime cel style",
  avoid: "generic fanart drift",
  notes: "Use reference cards and strict canonical design."
});

const ctx = { agentId: "imagebot", sessionKey: "stack" };
const append = [];
for (const hook of hooks.get("before_prompt_build") || []) {
  const result = await hook({
    prompt: "Draw a specified character image in official anime cel style without fanart drift."
  }, ctx);
  if (result?.prependContext) append.push(result.prependContext);
  if (result?.appendContext) append.push(result.appendContext);
}
const combined = append.join("\n\n");
assert.match(combined, /Imagebot 活跃工作流笔记/);
assert.match(combined, /Imagebot 图像反馈提示/);
assert.match(combined, /Telegram 路由上下文/);
assert.match(combined, /fanart drift/);

const routed = await tools.get("script_action").execute("route", {
  action: "route",
  query: "export memory backup",
  count: 3
});
assert.equal(routed.details.status, "ok");
assert.ok(routed.details.results.some((entry) => entry.id === "export_memory_backup"));

const featureRouted = await tools.get("feature_catalog").execute("feature-route", {
  action: "route",
  query: "签到打卡",
  count: 3
});
assert.equal(featureRouted.details.status, "ok");
assert.equal(featureRouted.details.results[0].feature.id, "checkin");

const commandRouted = await tools.get("command_catalog").execute("command-route", {
  action: "route",
  query: "backup memory to github",
  count: 3
});
assert.equal(commandRouted.details.status, "ok");
assert.ok(commandRouted.details.results.some((entry) => entry.command.command === "ambackup"));

const modelProfiles = await tools.get("model_config").execute("profiles", {
  action: "profiles"
});
assert.equal(modelProfiles.details.status, "ok");
assert.ok(modelProfiles.content[0].text.includes("balanced"));

const composed = await tools.get("prompt_library").execute("compose", {
  action: "compose",
  request: "specified character phone wallpaper",
  query: "official character wallpaper negative failures"
});
assert.equal(composed.details.status, "ok");
assert.match(composed.content[0].text, /PROMPT_LIBRARY composition/);

console.log("imagebot creative stack smoke tests passed");

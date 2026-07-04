import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import agentOps from "../plugins/imagebot-agent-ops/index.js";
import toolManualSearch, { __testing as manualTesting } from "../plugins/imagebot-tool-manual-search/index.js";
import mediaArtifacts from "../plugins/imagebot-media-artifacts/index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-agent-stack-test-"));
const tools = new Map();
const hooks = new Map();
let typedHookCount = 0;
let legacyHookCount = 0;

function recordHook(name, handler) {
  const list = hooks.get(name) || [];
  list.push(handler);
  hooks.set(name, list);
}

function register(plugin, config = {}) {
  plugin.register({
    config,
    registerTool(tool, opts) {
      const name = opts?.name || tool.name;
      assert.ok(!tools.has(name), `duplicate tool name: ${name}`);
      tools.set(name, tool);
    },
    on(name, handler) {
      typedHookCount += 1;
      recordHook(name, handler);
    },
    registerHook(name, handler) {
      legacyHookCount += 1;
      recordHook(name, handler);
    }
  });
}

register(toolManualSearch);
register(mediaArtifacts, {
  storeDir: path.join(root, "media-artifacts"),
  appendPromptContext: true,
  strictGeneratedRefs: true
});
register(agentOps, {
  storeDir: path.join(root, "agent-ops"),
  repoRoot: process.cwd(),
  appendModeContext: true,
  appendRelevantSkills: true,
  failureSlowMs: 10
});

for (const name of [
  "tool_manual_search",
  "media_artifact",
  "agent_mode",
  "persona_config",
  "learned_skill",
  "failure_memory",
  "evidence_pack",
  "github_lookup",
  "data_tool"
]) {
  assert.ok(tools.has(name), `${name} should be available in stack`);
}
assert.ok(typedHookCount >= 7, "stack plugins must register lifecycle hooks through api.on when available");
assert.equal(legacyHookCount, 0, "stack plugins should not use legacy registerHook when api.on exists");

const manual = await tools.get("tool_manual_search").execute("manual", {
  query: "skill proposal failure memory evidence github data",
  focus: "agent_ops",
  count: 2
});
assert.equal(manual.details.status, "ok");
assert.match(manual.content[0].text, /agent_ops/);
assert.match(manual.content[0].text, /failure_memory|learned_skill|github_lookup/);

const ctx = { agentId: "imagebot", sessionKey: "telegram:stack-session", runId: "stack-run" };
await tools.get("agent_mode").execute("mode", {
  action: "set",
  mode: "debug",
  scope: "session"
}, undefined, undefined, ctx);
await tools.get("persona_config").execute("persona", {
  action: "set",
  persona: "chihaya_anon",
  scope: "session"
}, undefined, undefined, ctx);

const skill = await tools.get("learned_skill").execute("skill-propose", {
  action: "propose",
  title: "Stack test workflow",
  trigger: "stack integration test",
  instructions: "Use the stack workflow when stack integration is mentioned."
});
await tools.get("learned_skill").execute("skill-approve", {
  action: "approve",
  id: skill.details.skill.id
});

const promptPieces = [];
const systemPieces = [];
for (const handler of hooks.get("before_prompt_build") || []) {
  const result = await handler({
    prompt: "stack integration test\nCurrentMediaPaths: C:\\Users\\Bot\\.openclaw\\media\\inbound\\sample.png"
  }, ctx);
  if (result?.prependSystemContext) systemPieces.push(result.prependSystemContext);
  if (result?.appendSystemContext) systemPieces.push(result.appendSystemContext);
  if (result?.prependContext) promptPieces.push(result.prependContext);
  if (result?.appendContext) promptPieces.push(result.appendContext);
}
const combined = promptPieces.join("\n");
const combinedSystem = systemPieces.join("\n");
assert.match(combined, /Imagebot 活跃模式/);
assert.match(combinedSystem, /Chihaya Anon/);
assert.match(combinedSystem, /^# 角色卡 - 千早爱音/);
assert.doesNotMatch(combinedSystem, /Active Persona State|runtime_agent|persona_id|memory_layer/);
assert.match(combined, /Stack test workflow/);
assert.match(combined, /Imagebot 媒体句柄/);

await hooks.get("before_tool_call").find(Boolean)({
  toolName: "image_generate",
  toolCallId: "stack-tool",
  params: { prompt: "stack" }
}, ctx);
for (const handler of hooks.get("after_tool_call") || []) {
  await handler({
    toolName: "image_generate",
    toolCallId: "stack-tool",
    error: new Error("stack synthetic failure")
  }, ctx);
}

const failure = await tools.get("failure_memory").execute("failure", {
  action: "search",
  query: "synthetic failure",
  status: "failed"
});
assert.equal(failure.details.status, "ok");
assert.ok(failure.details.results.some((item) => item.toolName === "image_generate"));

const directManual = await manualTesting.searchManuals({
  query: "agent ops evidence pack",
  focus: "agent_ops",
  count: 1
});
assert.equal(directManual[0].id, "agent_ops");

console.log("imagebot agent stack smoke tests passed");

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin, { __testing } from "../plugins/imagebot-agent-ops/index.js";
import { __testing as manualTesting } from "../plugins/imagebot-tool-manual-search/index.js";

const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-agent-ops-test-"));
const windowStorePath = path.join(storeDir, "windows.json");
const mediaDir = path.join(storeDir, "media");
await fs.mkdir(mediaDir, { recursive: true });
const skillMediaPath = path.join(mediaDir, "reference.png");
await fs.writeFile(skillMediaPath, Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
]));
const tools = new Map();
const hooks = new Map();
let typedHookCount = 0;
let legacyHookCount = 0;

function recordHook(name, handler) {
  const list = hooks.get(name) || [];
  list.push(handler);
  hooks.set(name, list);
}

plugin.register({
  config: { storeDir, repoRoot: process.cwd(), windowStorePath, failureSlowMs: 10, allowedMediaRoots: [mediaDir] },
  registerTool(tool, opts) {
    tools.set(opts?.name || tool.name, tool);
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

for (const name of [
  "agent_mode",
  "persona_config",
  "learned_skill",
  "failure_memory",
  "evidence_pack",
  "bot_board",
  "github_lookup",
  "data_tool"
]) {
  assert.ok(tools.has(name), `${name} should be registered`);
}
assert.ok(hooks.has("before_prompt_build"), "before_prompt_build hook should be registered");
assert.ok(hooks.has("before_tool_call"), "before_tool_call hook should be registered");
assert.ok(hooks.has("after_tool_call"), "after_tool_call hook should be registered");
assert.equal(typedHookCount, 3, "agent ops must use OpenClaw lifecycle api.on when available");
assert.equal(legacyHookCount, 0, "agent ops should not use legacy registerHook when api.on exists");

const oldSessionKey = "agent:imagebot:telegram:group:-100test:sender:100:window:old-window";
const oldWindow = {
  windowId: "old-window",
  ownerUserKey: "tg:100",
  ownerSenderId: "100",
  ownerName: "Alice",
  accountId: "imagebot",
  chatId: "-100test",
  sessionKey: oldSessionKey,
  openedAt: "2026-06-26T00:00:00.000Z",
  lastActivityAt: "2026-06-26T00:00:00.000Z",
  participants: { "tg:100": { id: "100", name: "Alice", lastSeenAt: "2026-06-26T00:00:00.000Z" } },
  recent: []
};
await fs.writeFile(windowStorePath, JSON.stringify({
  version: 3,
  users: {},
  windows: { "old-window": oldWindow },
  activeByUser: { "tg:100": oldWindow },
  byBotMessage: { "-100test:9": { windowId: "old-window", ownerUserKey: "tg:100", sessionKey: oldSessionKey } }
}, null, 2), "utf8");

const ctx = { agentId: "imagebot", accountId: "imagebot", chatId: "-100test", senderId: "100", senderName: "Alice", sessionKey: oldSessionKey, runId: "run-1" };

const modeSet = await tools.get("agent_mode").execute("mode-set", {
  action: "set",
  mode: "research",
  scope: "group",
  note: "test mode"
}, undefined, undefined, ctx);
assert.equal(modeSet.details.status, "ok");
assert.equal(modeSet.details.record.mode, "research");

const modeGet = await tools.get("agent_mode").execute("mode-get", {
  action: "get",
  scope: "group"
}, undefined, undefined, ctx);
assert.equal(modeGet.details.status, "ok");
assert.match(modeGet.content[0].text, /research/);

const personaList = await tools.get("persona_config").execute("persona-list", {
  action: "list"
}, undefined, undefined, ctx);
assert.equal(personaList.details.status, "ok");
assert.ok(personaList.details.personas.some((item) => item.id === "default" && item.label === "Amaduse" && item.hasCard === true));
assert.ok(personaList.details.personas.some((item) => item.id === "none" && item.aliases.includes("none") && item.hasCard === false));
assert.ok(personaList.details.personas.some((item) => item.id === "chihaya_anon" && item.hasLorebook === true && item.hasExamples === true));

const personaSet = await tools.get("persona_config").execute("persona-set", {
  action: "set",
  id: "chihaya_anon",
  scope: "session",
  note: "unit test"
}, undefined, undefined, ctx);
assert.equal(personaSet.details.status, "ok");
assert.equal(personaSet.details.record.personaId, "chihaya_anon");
assert.equal(personaSet.details.windowMode, "new_window");
assert.notEqual(personaSet.details.window.sessionKey, oldSessionKey);
assert.equal(personaSet.details.window.personaId, "chihaya_anon");
assert.equal(personaSet.details.userDefault.personaId, "chihaya_anon");
const windowStoreAfterSet = JSON.parse(await fs.readFile(windowStorePath, "utf8"));
assert.equal(windowStoreAfterSet.activeByUser["tg:100"].windowId, personaSet.details.window.windowId);
assert.equal(windowStoreAfterSet.windows["old-window"].closedReason, "replaced-by-persona-switch");
assert.equal(windowStoreAfterSet.windows[personaSet.details.window.windowId].personaId, "chihaya_anon");
assert.equal(windowStoreAfterSet.byBotMessage["-100test:9"], undefined);
const personaCtx = { ...ctx, sessionKey: personaSet.details.window.sessionKey };

const bobSessionKey = "agent:imagebot:telegram:group:-100test:sender:200:window:bob-window";
const bobWindow = {
  windowId: "bob-window",
  ownerUserKey: "tg:200",
  ownerSenderId: "200",
  ownerName: "Bob",
  accountId: "imagebot",
  chatId: "-100test",
  sessionKey: bobSessionKey,
  openedAt: "2026-06-26T00:00:00.000Z",
  lastActivityAt: "2026-06-26T00:00:00.000Z",
  participants: { "tg:200": { id: "200", name: "Bob", lastSeenAt: "2026-06-26T00:00:00.000Z" } },
  recent: []
};
windowStoreAfterSet.windows["bob-window"] = bobWindow;
windowStoreAfterSet.activeByUser["tg:200"] = bobWindow;
await fs.writeFile(windowStorePath, JSON.stringify(windowStoreAfterSet, null, 2), "utf8");

const promptOnlyPersonaContext = await hooks.get("before_prompt_build")[0]({
  prompt: `[Telegram current turn]\nwindow_id=${personaSet.details.window.windowId}\n[/Telegram current turn]\n\n你是谁`
}, { agentId: "imagebot" });
assert.ok(promptOnlyPersonaContext.prependSystemContext.includes("Chihaya Anon"));
assert.ok(promptOnlyPersonaContext.prependSystemContext.includes("## 设定补充"));
assert.ok(promptOnlyPersonaContext.prependSystemContext.includes("英国"));
assert.ok(promptOnlyPersonaContext.prependSystemContext.includes("Ann"));
assert.ok(promptOnlyPersonaContext.prependSystemContext.includes("## 对话示例"));
assert.equal(promptOnlyPersonaContext.prependContext, undefined, "persona must not be injected as low-priority prompt context");
assert.equal(promptOnlyPersonaContext.appendContext, undefined, "persona hook context must not append to the user prompt");
assert.match(promptOnlyPersonaContext.prependSystemContext, /^# 角色卡 - 千早爱音/);
assert.ok(!/Active Persona State|runtime_agent|persona_id|persona_label|memory_layer|authority_layer/i.test(promptOnlyPersonaContext.prependSystemContext));
assert.ok(!/Tool contracts|safety boundaries|owner checks|memory provenance/i.test(promptOnlyPersonaContext.prependSystemContext));

const promptChatSenderPersonaContext = await hooks.get("before_prompt_build")[0]({
  prompt: "plain runtime event without embedded window_id"
}, { agentId: "imagebot", chatId: "-100test", senderId: "100" });
assert.ok(promptChatSenderPersonaContext.prependSystemContext.includes("Chihaya Anon"));
assert.ok(!promptChatSenderPersonaContext.prependSystemContext.includes("persona_id: chihaya_anon"));

const promptOtherWindowContext = await hooks.get("before_prompt_build")[0]({
  prompt: `[Telegram current turn]\nwindow_id=bob-window\n[/Telegram current turn]\n\n你是谁`
}, { agentId: "imagebot", senderId: "100" });
assert.ok(promptOtherWindowContext.prependSystemContext.includes("你是 Amaduse"));
assert.ok(!promptOtherWindowContext.prependSystemContext.includes("Chihaya Anon"));
assert.match(promptOtherWindowContext.prependSystemContext, /^# 活跃角色卡 - Amaduse/);

const personaStatusWithoutSession = await tools.get("persona_config").execute("persona-status-no-session", {
  action: "status",
  scope: "session"
}, undefined, undefined, { agentId: "imagebot" });
assert.equal(personaStatusWithoutSession.details.status, "ok");
assert.equal(personaStatusWithoutSession.details.active.record.personaId, "chihaya_anon");

const promptWithoutWindowOrSession = await hooks.get("before_prompt_build")[0]({
  prompt: "plain no-window event"
}, { agentId: "imagebot" });
assert.ok(promptWithoutWindowOrSession.prependSystemContext.includes("你是 Amaduse"));
assert.match(promptWithoutWindowOrSession.prependSystemContext, /^# 活跃角色卡 - Amaduse/);

const proposal = await tools.get("learned_skill").execute("skill-propose", {
  action: "propose",
  title: "Use official character references",
  trigger: "specified character image generation",
  problem: "Generated images drift when no reference is passed.",
  instructions: "When a named character is requested, search for an official-looking reference and inspect it before image generation.",
  tags: ["image", "reference"]
});
assert.equal(proposal.details.status, "ok");
const skillId = proposal.details.skill.id;

const pending = await tools.get("learned_skill").execute("skill-list", {
  action: "list",
  status: "pending"
});
assert.equal(pending.details.status, "ok");
assert.ok(pending.details.results.some((item) => item.id === skillId));

const approved = await tools.get("learned_skill").execute("skill-approve", {
  action: "approve",
  id: skillId,
  note: "unit test"
});
assert.equal(approved.details.status, "ok");

const skillSearch = await tools.get("learned_skill").execute("skill-search", {
  action: "search",
  query: "official character reference"
});
assert.equal(skillSearch.details.status, "ok");
assert.ok(skillSearch.details.results.some((item) => item.id === skillId));

const savedSkill = await tools.get("learned_skill").execute("skill-save", {
  action: "save",
  title: "Kurisu image preference note",
  trigger: "牧濑红莉栖 image generation",
  content: "For Makise Kurisu image generation, prefer official anime identity, lab-coat scientist styling, red-brown hair, and avoid generic westernized influencer faces.",
  media: [skillMediaPath],
  tags: ["image", "kurisu"]
});
assert.equal(savedSkill.details.status, "ok");
assert.equal(savedSkill.details.skill.status, "approved");
assert.ok(savedSkill.details.skill.file.endsWith(path.join(savedSkill.details.skill.id, "SKILL.md")));
assert.equal(savedSkill.details.skill.media.length, 1);
const savedSkillMarkdown = await fs.readFile(savedSkill.details.skill.file, "utf8");
assert.match(savedSkillMarkdown, /Kurisu image preference note/);
assert.match(savedSkillMarkdown, /## Instructions/);
assert.match(savedSkillMarkdown, /assets\//);

const savedSkillSearch = await tools.get("learned_skill").execute("skill-search-saved", {
  action: "search",
  query: "牧濑红莉栖 westernized influencer"
});
assert.equal(savedSkillSearch.details.status, "ok");
assert.ok(savedSkillSearch.details.results.some((item) => item.id === savedSkill.details.skill.id));

const promptContext = await hooks.get("before_prompt_build")[0]({
  prompt: "Please generate a specified character image with official reference."
}, personaCtx);
assert.ok(promptContext.prependSystemContext.includes("Chihaya Anon"));
assert.ok(promptContext.prependSystemContext.includes("Tomori"));
assert.match(promptContext.prependSystemContext, /^# 角色卡 - 千早爱音/);
assert.ok(!/Active Persona State|persona_id|memory_layer|authority_layer/i.test(promptContext.prependSystemContext));
assert.ok(!/Tool contracts|safety boundaries|owner checks|memory provenance/i.test(promptContext.prependSystemContext));
assert.ok(promptContext?.prependContext.includes("research"));
assert.ok(promptContext.prependContext.includes("official-looking reference"));

const savedPromptContext = await hooks.get("before_prompt_build")[0]({
  prompt: "牧濑红莉栖 image generation should avoid westernized influencer faces."
}, personaCtx);
assert.ok(savedPromptContext.prependContext.includes("Kurisu image preference note"));
assert.ok(savedPromptContext.prependContext.includes("MEDIA:"));

const personaClear = await tools.get("persona_config").execute("persona-clear", {
  action: "clear",
  scope: "session"
}, undefined, undefined, personaCtx);
assert.equal(personaClear.details.status, "ok");

await hooks.get("before_tool_call")[0]({
  toolName: "image_generate",
  toolCallId: "tc-1",
  params: { prompt: "test" }
}, ctx);
await new Promise((resolve) => setTimeout(resolve, 15));
await hooks.get("after_tool_call")[0]({
  toolName: "image_generate",
  toolCallId: "tc-1",
  result: { ok: true }
}, ctx);

await hooks.get("before_tool_call")[0]({
  toolName: "web_image_search",
  toolCallId: "tc-2",
  params: { query: "test" }
}, ctx);
await hooks.get("after_tool_call")[0]({
  toolName: "web_image_search",
  toolCallId: "tc-2",
  error: new Error("search backend failed")
}, ctx);

const failures = await tools.get("failure_memory").execute("failure-recent", {
  action: "recent",
  status: "all",
  count: 5
});
assert.equal(failures.details.status, "ok");
assert.ok(failures.details.results.some((item) => item.toolName === "web_image_search" && item.status === "failed"));
assert.ok(failures.details.results.some((item) => item.toolName === "image_generate" && item.status === "slow"));

const summary = await tools.get("failure_memory").execute("failure-summary", {
  action: "summary",
  hours: 1
});
assert.equal(summary.details.status, "ok");
assert.ok(summary.details.stats.some((item) => item.toolName === "web_image_search"));

const pack = await tools.get("evidence_pack").execute("pack-create", {
  action: "create",
  title: "OpenClaw evidence test",
  summary: "Testing evidence pack storage.",
  tags: ["test", "web"]
});
assert.equal(pack.details.status, "ok");
const packId = pack.details.pack.id;

const added = await tools.get("evidence_pack").execute("pack-add", {
  action: "add",
  pack_id: packId,
  title: "Example source",
  url: "https://example.com",
  note: "Example evidence note.",
  kind: "source"
});
assert.equal(added.details.status, "ok");

const gotPack = await tools.get("evidence_pack").execute("pack-get", {
  action: "get",
  id: packId
});
assert.equal(gotPack.details.status, "ok");
assert.equal(gotPack.details.pack.itemCount, 1);

const rule = await tools.get("bot_board").execute("rule-add", {
  action: "rule_add",
  scope: "group",
  groupKey: "test-group",
  keywords: ["shipping", "refund"],
  response: "Use the support ticket flow and ask for an order id.",
  tags: ["support"]
});
assert.equal(rule.details.status, "ok");
assert.equal(rule.details.item.kind, "rule");

const ruleMatch = await tools.get("bot_board").execute("rule-match", {
  action: "rule_match",
  text: "The user asks about shipping and a refund."
});
assert.equal(ruleMatch.details.status, "ok");
assert.ok(ruleMatch.details.matches.some((item) => item.id === rule.details.item.id && item.hits.includes("shipping")));

const conditionalRule = await tools.get("bot_board").execute("rule-add-conditional", {
  action: "rule_add",
  scope: "group",
  groupKey: "test-group",
  keywords: ["reference image"],
  response: "Ask for the source image before generating variants.",
  conditions: { groupKey: "test-group", hasMedia: true, fromHour: 9, toHour: 18 },
  tags: ["conditional"]
});
assert.equal(conditionalRule.details.status, "ok");

const conditionalMiss = await tools.get("bot_board").execute("rule-match-conditional-miss", {
  action: "rule_match",
  text: "reference image please",
  groupKey: "test-group",
  hasMedia: false,
  hour: 10
});
assert.equal(conditionalMiss.details.status, "ok");
assert.ok(!conditionalMiss.details.matches.some((item) => item.id === conditionalRule.details.item.id));

const conditionalHit = await tools.get("bot_board").execute("rule-match-conditional-hit", {
  action: "rule_match",
  text: "reference image please",
  groupKey: "test-group",
  hasMedia: true,
  hour: 10
});
assert.equal(conditionalHit.details.status, "ok");
assert.ok(conditionalHit.details.matches.some((item) => item.id === conditionalRule.details.item.id));

const ticket = await tools.get("bot_board").execute("ticket-create", {
  action: "ticket_create",
  scope: "group",
  groupKey: "test-group",
  title: "Check failed gallery resend",
  body: "Gallery resend should preserve the original MEDIA directive.",
  priority: "high",
  owner: "codex",
  tags: ["gallery", "ops"]
});
assert.equal(ticket.details.status, "ok");

const ticketUpdate = await tools.get("bot_board").execute("ticket-update", {
  action: "ticket_update",
  id: ticket.details.item.id,
  status: "doing",
  note: "Reproduced in unit test."
});
assert.equal(ticketUpdate.details.status, "ok");
assert.equal(ticketUpdate.details.item.status, "doing");

const schedule = await tools.get("bot_board").execute("schedule-create", {
  action: "schedule_create",
  scope: "group",
  groupKey: "test-group",
  title: "Nightly manual check",
  message: "Check due bot-board drafts before sending anything.",
  dueAt: "2026-06-29T12:00:00+08:00",
  audience: "test group",
  status: "ready"
});
assert.equal(schedule.details.status, "ok");

const due = await tools.get("bot_board").execute("schedule-due", {
  action: "schedule_due",
  before: "2026-06-29T12:01:00+08:00"
});
assert.equal(due.details.status, "ok");
assert.ok(due.details.results.some((item) => item.id === schedule.details.item.id));

const flow = await tools.get("bot_board").execute("flow-create", {
  action: "flow_create",
  scope: "group",
  groupKey: "test-group",
  status: "active",
  title: "Refund support flow",
  intent: "refund_support",
  samples: ["refund request", "return my order"],
  slots: ["order_id"],
  steps: [
    "Ask for the order id.",
    { id: "triage", text: "Create or update a support ticket with priority.", expect: "ticket id" }
  ],
  instructions: "Use this as a dry-run dialogue flow, not as automatic refund approval.",
  source: "Rasa business flow candidate"
});
assert.equal(flow.details.status, "ok");
assert.equal(flow.details.validation.ok, true);

const flowMatch = await tools.get("bot_board").execute("flow-match", {
  action: "flow_match",
  text: "I have a refund request for my order"
});
assert.equal(flowMatch.details.status, "ok");
assert.ok(flowMatch.details.matches.some((item) => item.id === flow.details.item.id));

const flowValidate = await tools.get("bot_board").execute("flow-validate", {
  action: "flow_validate",
  id: flow.details.item.id
});
assert.equal(flowValidate.details.status, "ok");
assert.equal(flowValidate.details.validation.ok, true);

const preset = await tools.get("bot_board").execute("preset-save", {
  action: "preset_save",
  scope: "group",
  groupKey: "test-group",
  title: "Concise support preset",
  trigger: "support flow",
  keywords: ["support-preset"],
  instructions: "Answer with a short status summary, one next action, and no invented policy.",
  source: "Kirara loadable preset candidate",
  tags: ["preset"]
});
assert.equal(preset.details.status, "ok");

const presetMatch = await tools.get("bot_board").execute("preset-match", {
  action: "preset_match",
  text: "Use support-preset for this reply"
});
assert.equal(presetMatch.details.status, "ok");
assert.ok(presetMatch.details.matches.some((item) => item.id === preset.details.item.id));

const presetGet = await tools.get("bot_board").execute("preset-get", {
  action: "preset_get",
  id: preset.details.item.id
});
assert.equal(presetGet.details.status, "ok");
assert.match(presetGet.content[0].text, /Concise support preset/);

const githubBad = await tools.get("github_lookup").execute("github-bad", {
  action: "repo",
  repo: "bad repo name"
});
assert.equal(githubBad.details.status, "failed");
assert.match(githubBad.content[0].text, /invalid|owner\/name|repo/i);
assert.deepEqual(__testing.parseRepo("https://github.com/openai/openai-agents-python"), {
  owner: "openai",
  repo: "openai-agents-python"
});

const numbers = await tools.get("data_tool").execute("numbers", {
  action: "numbers_summary",
  text: "1, 2, 3, 4, 10"
});
assert.equal(numbers.details.status, "ok");
assert.equal(numbers.details.result.count, 5);
assert.equal(numbers.details.result.median, 3);

const csv = await tools.get("data_tool").execute("csv", {
  action: "csv_summary",
  text: "name,score\nA,10\nB,20\nC,20"
});
assert.equal(csv.details.status, "ok");
assert.equal(csv.details.result.rows, 3);
assert.equal(csv.details.result.columns[1].stats.mean, 50 / 3);

const groupCount = await tools.get("data_tool").execute("group-count", {
  action: "group_count",
  column: "score",
  text: "name,score\nA,10\nB,20\nC,20"
});
assert.equal(groupCount.details.status, "ok");
assert.equal(groupCount.details.counts["20"], 2);

const manuals = await manualTesting.searchManuals({
  query: "learned workflow failure memory github csv",
  focus: "agent_ops",
  count: 3
});
assert.ok(manuals.some((entry) => entry.id === "agent_ops"));

const skillState = await __testing.loadSkillState({ storeDir });
assert.ok(skillState.some((item) => item.id === skillId && item.status === "approved"));
const personaState = await __testing.loadPersonaState({ storeDir });
assert.equal(personaState.active[`session:${personaCtx.sessionKey}`], undefined);
assert.equal(personaState.userDefaults["tg:100"].personaId, "chihaya_anon");
const toolEvents = await __testing.loadToolEvents({ storeDir });
assert.ok(toolEvents.length >= 2);
const evidenceState = await __testing.loadEvidenceState({ storeDir });
assert.ok(evidenceState.some((item) => item.id === packId));
const boardState = await __testing.loadBotBoardState({ storeDir });
assert.ok(boardState.some((item) => item.id === ticket.details.item.id && item.status === "doing"));
assert.ok(boardState.some((item) => item.id === flow.details.item.id && item.kind === "flow" && item.steps.length === 2));
assert.ok(boardState.some((item) => item.id === preset.details.item.id && item.kind === "preset"));

console.log("agent-ops plugin tests passed");

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin, { __testing } from "../plugins/imagebot-turn-observer/index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-turn-observer-test-"));
const tools = new Map();
const hooks = new Map();

plugin.register({
  config: { storeDir: root },
  registerTool(tool, meta) {
    tools.set(meta.name, tool);
  },
  registerHook(name, handler, meta) {
    hooks.set(`${name}:${meta.name}`, handler);
  }
});

assert.ok(tools.has("turn_observer_recent"));
assert.ok([...hooks.keys()].some((key) => key.startsWith("before_prompt_build:")));
assert.ok([...hooks.keys()].some((key) => key.startsWith("before_tool_call:")));
assert.ok([...hooks.keys()].some((key) => key.startsWith("after_tool_call:")));
assert.ok([...hooks.keys()].some((key) => key.startsWith("before_message_write:")));

assert.equal(__testing.sanitizeText("C:\\Users\\Bot\\secret.txt"), "[local-path-redacted]");
assert.match(__testing.sanitizeText(`${"123456"}:${"A".repeat(36)}`), /\[telegram-token-redacted\]/);

const beforePrompt = [...hooks.entries()].find(([key]) => key.startsWith("before_prompt_build:"))[1];
const beforeTool = [...hooks.entries()].find(([key]) => key.startsWith("before_tool_call:"))[1];
const afterTool = [...hooks.entries()].find(([key]) => key.startsWith("after_tool_call:"))[1];

await beforePrompt({ text: "助手 查一下 C:\\Users\\Bot\\secret.txt", chatId: "-100", userId: "42" }, { agentId: "imagebot", sessionKey: "s1", runId: "r1" });
await beforeTool({ toolName: "web_search", toolCallId: "t1", params: { query: "test" } }, { agentId: "imagebot", sessionKey: "s1", runId: "r1" });
await afterTool({ toolName: "web_search", toolCallId: "t1", result: { details: { status: "ok" }, content: [{ type: "text", text: "done" }] } }, { agentId: "imagebot", sessionKey: "s1", runId: "r1" });

const all = await tools.get("turn_observer_recent").execute("recent", { count: 10 });
assert.equal(all.details.status, "ok");
assert.equal(all.details.results.length, 3);
assert.ok(!all.content[0].text.includes("C:\\Users\\Bot"));

const toolsOnly = await tools.get("turn_observer_recent").execute("recent-tools", { kind: "before_tool_call", toolName: "web_search", count: 5 });
assert.equal(toolsOnly.details.results.length, 1);
assert.equal(toolsOnly.details.results[0].toolName, "web_search");

const file = __testing.logPath({ storeDir: root });
const stat = await fs.stat(file);
assert.ok(stat.size > 0);

console.log("turn observer plugin tests passed");

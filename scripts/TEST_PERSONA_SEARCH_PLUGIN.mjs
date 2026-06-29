import assert from "node:assert/strict";
import plugin, { __testing } from "../plugins/imagebot-persona-search/index.js";

const tools = new Map();
plugin.register({
  registerTool(tool, opts) {
    tools.set(opts?.name || tool.name, tool);
  }
});

assert.ok(tools.has("persona_search"));

const terms = __testing.extractTerms("中文语气 不要傲娇模板");
assert.ok(terms.includes("中文"));
assert.ok(terms.includes("傲娇"));
assert.ok(!terms.includes("不要"));

const voice = await __testing.searchPersona({
  query: "中文语气 冷静 讽刺 不客服",
  focus: "voice",
  count: 3
});
assert.equal(voice[0].focus, "voice");
assert.match(voice[0].text, /中文默认语气|冷静/);

const lore = await tools.get("persona_search").execute("persona-lore", {
  query: "用户说你傲娇 出戏 人设",
  count: 4
});
assert.equal(lore.details.status, "ok");
assert.ok(lore.details.results.some((entry) => /傲娇|出戏|人设/.test(entry.text)));
assert.match(lore.content[0].text, /PERSONA_SEARCH ok/);

console.log("persona search plugin tests passed");

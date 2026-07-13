import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-memory-search-test-"));
process.env.OPENCLAW_STATE_DIR = tempHome;

const memoryDir = path.join(tempHome, "agents", "imagebot", "sessions", "sessions.json.telegram-imagebot-memory");
await fs.mkdir(path.join(memoryDir, "users"), { recursive: true });
await fs.mkdir(path.join(memoryDir, "group"), { recursive: true });
const groupMeme = "\u5510\u7b11";
const groupMemeQuestion = `${groupMeme}\u662f\u4ec0\u4e48\u6897`;
await fs.writeFile(
  path.join(memoryDir, "users", "tg_10001.md"),
  "# Telegram Imagebot User Memory\n\nAlice likes official character references and dry jokes.\n",
  "utf8"
);
await fs.writeFile(
  path.join(memoryDir, "group", "shared.md"),
  `# Telegram Imagebot Shared Group Memory\n\n- ${groupMeme} is a recurring group meme about a character reaction face; use it as soft group lore, not public canon.\n`,
  "utf8"
);
await fs.writeFile(
  path.join(memoryDir, "semantic-index.json"),
  JSON.stringify({
    version: 2,
    model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    signature: "test-stale-signature",
    builtAt: "2026-01-01T00:00:00.000Z",
    chunks: [{
      id: "test",
      kind: "user",
      label: "user:Alice",
      fileName: "tg_10001.md",
      chunkIndex: 0,
      text: "Alice likes official character references.",
      embedding: [1, 0]
    }]
  }),
  "utf8"
);
const windowStorePath = path.join(tempHome, "agents", "imagebot", "sessions", "sessions.json.telegram-imagebot-windows.json");
await fs.writeFile(
  windowStorePath,
  JSON.stringify({
    version: 3,
    users: {
      "tg_10001": { names: ["Alice"] }
    },
    activeByUser: {},
    windows: {}
  }, null, 2),
  "utf8"
);

const { default: plugin, __testing } = await import(`../plugins/imagebot-memory-search/index.js?test=${Date.now()}`);
const cached = await __testing.loadCachedSemanticIndex();
assert.equal(cached.chunks.length, 1);
__testing.clearKnownUsersCache();
assert.equal(__testing.knownUsersCacheStats().cached, false);
const knownUsers = __testing.readKnownUsers();
assert.deepEqual(knownUsers.get("tg_10001"), ["Alice"]);
assert.equal(__testing.knownUsersCacheStats().users, 1);
await new Promise((resolve) => setTimeout(resolve, 20));
await fs.writeFile(
  windowStorePath,
  JSON.stringify({
    version: 3,
    users: {
      "tg_10001": { names: ["Alice", "Bob"] }
    },
    activeByUser: {},
    windows: {}
  }, null, 2),
  "utf8"
);
const updatedKnownUsers = __testing.readKnownUsers();
assert.deepEqual(updatedKnownUsers.get("tg_10001"), ["Alice", "Bob"]);

const tools = new Map();
const hooks = new Map();
plugin.register({
  config: { appendPromptContext: true },
  registerTool(tool, opts) {
    tools.set(opts?.name || tool.name, tool);
  },
  registerHook(name, handler) {
    if (!hooks.has(name)) hooks.set(name, []);
    hooks.get(name).push(handler);
  }
});
const memorySearch = tools.get("memory_search");
assert.ok(memorySearch, "memory_search tool should register");
assert.ok(hooks.get("before_prompt_build")?.length, "memory prompt hook should register");
assert.deepEqual(memorySearch.parameters.required, [], "memory_search should handle missing query inside the tool instead of schema-looping");
__testing.clearMemoryDocInventoryCache();
__testing.clearMemoryFileTextCache();
assert.equal(__testing.memoryDocInventoryCacheStats().entries, 0, "memory doc inventory cache should be clearable");
assert.deepEqual(
  __testing.memoryFileTextCacheStats(),
  { entries: 0, hits: 0, misses: 0, maxEntries: 256 },
  "memory file text cache should be clearable"
);

const missingQuery = await memorySearch.execute("missing-query-test", {});
assert.equal(missingQuery.details.status, "skipped");
assert.equal(missingQuery.details.reason, "missing_query");
assert.match(missingQuery.content[0].text, /Do not retry memory_search/);

const currentIdentityQuery = await memorySearch.execute("current-identity-test", { query: "助手这是谁", scope: "users" });
assert.equal(currentIdentityQuery.details.status, "skipped");
assert.equal(currentIdentityQuery.details.reason, "current_identity_query");
assert.match(currentIdentityQuery.content[0].text, /current visual\/context evidence/);

const result = await memorySearch.execute("keyword-test", {
  query: "Alice official references",
  mode: "keyword",
  count: 1
});
assert.equal(result.details.status, "ok");
assert.equal(result.details.count, 1);
assert.equal(result.details.results[0].mode, "keyword");
const firstInventoryStats = __testing.memoryDocInventoryCacheStats();
const firstFileStats = __testing.memoryFileTextCacheStats();
assert.ok(firstInventoryStats.scopes.includes("all"), "keyword search should cache the requested memory doc inventory scope");
assert.ok(firstFileStats.entries >= 1, "keyword search should cache memory file text by mtime signature");
assert.ok(firstFileStats.misses >= 1, "cold keyword search should read memory file text");

const hotResult = await memorySearch.execute("keyword-hot-test", {
  query: "Alice official references",
  mode: "keyword",
  count: 1
});
assert.equal(hotResult.details.status, "ok");
const hotFileStats = __testing.memoryFileTextCacheStats();
assert.ok(hotFileStats.hits > firstFileStats.hits, "hot keyword search should reuse cached memory file text");
assert.equal(
  __testing.memoryDocInventoryCacheStats().entries,
  firstInventoryStats.entries,
  "hot keyword search should reuse cached memory doc inventory"
);

const memoryHint = await hooks.get("before_prompt_build")[0](
  { prompt: groupMemeQuestion },
  { agentId: "imagebot", sessionKey: "agent:imagebot:telegram:group:-100:sender:10001:window:test" }
);
assert.ok(memoryHint?.appendContext.includes("Imagebot 记忆召回提示"));
assert.ok(memoryHint.appendContext.includes("memory_search"));
assert.ok(memoryHint.appendContext.includes(groupMemeQuestion));
assert.ok(memoryHint.appendContext.includes('scope: "group"'));
assert.ok(memoryHint.appendContext.includes("记忆层：中性的 bot 可见事实"));
assert.ok(!memoryHint.appendContext.includes("Before answering"));

const telegramWrappedPrompt = [
  "[Telegram current turn]",
  "current_sender=Alice [tg:10001]",
  "[/Telegram current turn]",
  "",
  groupMemeQuestion,
  "",
  "[Telegram 路由上下文]",
  "sessionKey: agent:imagebot:telegram:group:-100:sender:10001:window:test"
].join("\n");
assert.equal(__testing.extractRecallQueryText(telegramWrappedPrompt), groupMemeQuestion);
const wrappedHint = await hooks.get("before_prompt_build")[0](
  { prompt: telegramWrappedPrompt },
  { agentId: "imagebot", sessionKey: "agent:imagebot:telegram:group:-100:sender:10001:window:test" }
);
assert.ok(wrappedHint.appendContext.includes(groupMemeQuestion));
assert.ok(!wrappedHint.appendContext.includes("current_sender="));

const currentImageIdentityPrompt = [
  '"source_modality": "image"',
  "[Telegram current turn]",
  "current_sender=Alice [tg:10001]",
  "[/Telegram current turn]",
  "",
  "助手这是谁",
  "",
  "[Reply chain - nearest first]",
  "<media:sticker>",
  "[Imagebot 媒体句柄]",
  "- current.image.0: 当前 Telegram 图像"
].join("\n");
const currentImageIdentityHint = await hooks.get("before_prompt_build")[0](
  { prompt: currentImageIdentityPrompt },
  { agentId: "imagebot", sessionKey: "agent:imagebot:telegram:group:-100:sender:10001:window:image-id" }
);
assert.equal(currentImageIdentityHint, undefined, "current-media identity questions must not trigger memory recall");
assert.equal(__testing.shouldOpenRecallGate(currentImageIdentityPrompt), false);

const recalledImageIdentityPrompt = currentImageIdentityPrompt.replace("助手这是谁", "助手记得上次这是谁吗");
assert.equal(__testing.shouldOpenRecallGate(recalledImageIdentityPrompt), true, "explicit prior-turn recall should remain available with media");

const internalHint = await hooks.get("before_prompt_build")[0](
  { prompt: groupMemeQuestion },
  { agentId: "imagebot", sessionKey: "agent:imagebot:explicit:imagebot-memory-curator-test" }
);
assert.equal(internalHint, undefined);

const noHint = await hooks.get("before_prompt_build")[0](
  { prompt: "\u4eca\u5929\u968f\u4fbf\u804a\u4e24\u53e5" },
  { agentId: "imagebot", sessionKey: "agent:imagebot:telegram:group:-100:sender:10001:window:test" }
);
assert.equal(noHint, undefined);

if (originalStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
else process.env.OPENCLAW_STATE_DIR = originalStateDir;
await fs.rm(tempHome, { recursive: true, force: true });
console.log("memory-search plugin tests passed");

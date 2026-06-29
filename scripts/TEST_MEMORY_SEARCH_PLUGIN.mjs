import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-memory-search-test-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const memoryDir = path.join(tempHome, ".openclaw", "agents", "imagebot", "sessions", "sessions.json.telegram-imagebot-memory");
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

const { default: plugin, __testing } = await import(`../plugins/imagebot-memory-search/index.js?test=${Date.now()}`);
const cached = await __testing.loadCachedSemanticIndex();
assert.equal(cached.chunks.length, 1);

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

const result = await memorySearch.execute("keyword-test", {
  query: "Alice official references",
  mode: "keyword",
  count: 1
});
assert.equal(result.details.status, "ok");
assert.equal(result.details.count, 1);
assert.equal(result.details.results[0].mode, "keyword");

const memoryHint = await hooks.get("before_prompt_build")[0](
  { prompt: groupMemeQuestion },
  { agentId: "imagebot" }
);
assert.ok(memoryHint?.appendContext.includes("Imagebot memory recall gate"));
assert.ok(memoryHint.appendContext.includes("memory_search"));
assert.ok(memoryHint.appendContext.includes(groupMemeQuestion));
assert.ok(memoryHint.appendContext.includes('scope: "group"'));
assert.ok(memoryHint.appendContext.includes("Before answering"));

const noHint = await hooks.get("before_prompt_build")[0](
  { prompt: "\u4eca\u5929\u968f\u4fbf\u804a\u4e24\u53e5" },
  { agentId: "imagebot" }
);
assert.equal(noHint, undefined);

process.env.HOME = originalHome;
process.env.USERPROFILE = originalUserProfile;
await fs.rm(tempHome, { recursive: true, force: true });
console.log("memory-search plugin tests passed");

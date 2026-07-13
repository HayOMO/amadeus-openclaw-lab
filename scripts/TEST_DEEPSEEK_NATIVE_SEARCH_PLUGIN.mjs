import assert from "node:assert/strict";
import plugin, {
  buildDeepSeekSearchRequest,
  normalizeDeepSeekSearchConfig,
  parseDeepSeekSearchResponse
} from "../plugins/imagebot-deepseek-search/index.js";

const config = normalizeDeepSeekSearchConfig({
  secretFile: "C:/test/deepseek.token",
  baseUrl: "https://api.deepseek.com/anthropic",
  model: "deepseek-v4-flash",
  maxUses: 2,
  maxTokens: 800
});

const request = buildDeepSeekSearchRequest({
  query: "current OpenClaw release",
  language: "en"
}, config);
assert.equal(request.model, "deepseek-v4-flash");
assert.equal(request.tools[0].type, "web_search_20250305");
assert.equal(request.tools[0].max_uses, 2);
assert.match(request.messages[0].content, /language=en/);

const parsed = parseDeepSeekSearchResponse({
  content: [
    {
      type: "web_search_tool_result",
      content: [
        { type: "web_search_result", title: "OpenClaw", url: "https://example.com/openclaw", page_age: "1 day ago" },
        { type: "web_search_result", title: "Duplicate", url: "https://example.com/openclaw" }
      ]
    },
    {
      type: "text",
      text: "The current release is listed in the source.",
      citations: [{ title: "Release notes", url: "https://example.com/releases" }]
    },
    { type: "thinking", thinking: "must not escape" }
  ],
  usage: {
    input_tokens: 12,
    output_tokens: 34,
    server_tool_use: { web_search_requests: 1 }
  }
}, 6);

assert.equal(parsed.answer, "The current release is listed in the source.");
assert.deepEqual(parsed.results, [
  { title: "OpenClaw", url: "https://example.com/openclaw", pageAge: "1 day ago" },
  { title: "Release notes", url: "https://example.com/releases" }
]);
assert.equal(parsed.usage.searchRequests, 1);
assert.doesNotMatch(JSON.stringify(parsed), /must not escape/);

let registered;
plugin.register({
  pluginConfig: config,
  registerWebSearchProvider(provider) {
    registered = provider;
  }
});
assert.equal(registered?.id, "deepseek");
assert.equal(registered?.createTool({})?.parameters?.required?.[0], "query");

console.log("DeepSeek native search plugin tests passed");

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-zhihu-test-"));
process.env.USERPROFILE = home;
process.env.HOME = home;
delete process.env.ZHIHU_ACCESS_SECRET;
delete process.env.OPENCLAW_ZHIHU_ACCESS_SECRET;

const { default: plugin, __testing } = await import("../plugins/zhihu-openapi/index.js");

const tools = new Map();
plugin.register({
  registerTool(tool, opts) {
    tools.set(opts?.name || tool.name, tool);
  }
});

for (const name of ["zhihu_search", "zhihu_global_search", "zhihu_hot_list"]) {
  assert.ok(tools.has(name), `${name} should be registered`);
}

const item = __testing.normalizeSearchItem({
  Title: "知乎 &amp; OpenAPI",
  Url: "https://www.zhihu.com/question/1",
  ContentType: "answer",
  ContentText: "<p>hello&nbsp;world</p>",
  VoteUpCount: "42",
  CommentCount: "7",
  AuthorName: "<b>Alice</b>",
  EditTime: 1700000000
});
assert.equal(item.title, "知乎 & OpenAPI");
assert.equal(item.voteUpCount, 42);
assert.equal(item.commentCount, 7);
assert.equal(item.authorName, "Alice");
assert.ok(!item.summary.includes("<p>"));

const formatted = __testing.formatSearchResults("ZHIHU_SEARCH", "测试", [item], { hasMore: true, searchHashId: "abc" });
assert.match(formatted, /item_count=1 has_more=true search_hash_id=abc/);
assert.match(formatted, /知乎 & OpenAPI/);

const hot = __testing.normalizeHotItem({
  Title: "热榜标题",
  Url: "https://www.zhihu.com/hot",
  Summary: "<em>摘要</em>",
  ThumbnailUrl: "https://example.com/t.jpg"
});
assert.equal(hot.title, "热榜标题");
assert.equal(hot.summary, "摘要");
assert.match(__testing.formatHotList([hot], 1), /ZHIHU_HOT_LIST ok total=1 item_count=1/);

const missingSecret = await tools.get("zhihu_search").execute("missing-secret", { query: "测试", count: 1 });
assert.equal(missingSecret.details.status, "unavailable");
assert.equal(missingSecret.details.reason, "missing_access_secret");
assert.match(missingSecret.content[0].text, /explicit_web_text_search/);

const missingQuery = await tools.get("zhihu_search").execute("missing-query", { query: "" });
assert.equal(missingQuery.details.status, "failed");
assert.match(missingQuery.details.error, /query is required/);

console.log("zhihu openapi plugin tests passed");

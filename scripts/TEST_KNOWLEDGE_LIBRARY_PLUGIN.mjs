import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin, { __testing } from "../plugins/imagebot-knowledge-library/index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-knowledge-library-test-"));
const repoRoot = path.join(root, "repo");
const storeDir = path.join(root, "store");
const inbound = path.join(root, "inbound");

await fs.mkdir(path.join(repoRoot, "persona"), { recursive: true });
await fs.mkdir(path.join(repoRoot, "prompt_library", "characters"), { recursive: true });
await fs.mkdir(path.join(repoRoot, "tool_manuals"), { recursive: true });
await fs.mkdir(inbound, { recursive: true });

await fs.writeFile(path.join(repoRoot, "persona", "active_system.md"), "# Amadeus\nSharp scientist personality.\n", "utf8");
await fs.writeFile(path.join(repoRoot, "prompt_library", "characters", "kurisu.md"), "# Kurisu\nOfficial outfit, red hair, lab coat.\n", "utf8");
await fs.writeFile(path.join(repoRoot, "tool_manuals", "image_generation.md"), "# Image Generation\nUse reference images for named characters.\n", "utf8");

const inboundFile = path.join(inbound, "paper-note.txt");
await fs.writeFile(inboundFile, "B-spline reinforcement learning prototype note", "utf8");

const tools = new Map();
plugin.register({
  config: { repoRoot, storeDir, allowedFileRoots: [inbound] },
  registerTool(tool, meta) {
    tools.set(meta.name, tool);
  }
});

for (const name of ["knowledge", "knowledge_sources", "knowledge_search", "knowledge_recent", "knowledge_ingest"]) {
  assert.ok(tools.has(name), `${name} should be registered`);
}

__testing.clearKnowledgeCaches();
assert.deepEqual(
  __testing.knowledgeFileInventoryCacheStats(),
  { entries: 0, pending: 0, recheckMs: 1000 },
  "knowledge file inventory cache should be clearable"
);
assert.deepEqual(
  __testing.knowledgeFileTextCacheStats(),
  { entries: 0, hits: 0, misses: 0, maxEntries: 256 },
  "knowledge file text cache should be clearable"
);

const sources = await tools.get("knowledge_sources").execute("sources", {});
assert.equal(sources.details.status, "ok");
assert.ok(sources.details.sources.some((source) => source.id === "persona"));
const firstInventoryStats = __testing.knowledgeFileInventoryCacheStats();
assert.ok(firstInventoryStats.entries > 0, "knowledge_sources should cache source file inventories");

const aggregateSources = await tools.get("knowledge").execute("aggregate-sources", { action: "sources" });
assert.equal(aggregateSources.details.status, "ok");
assert.ok(aggregateSources.details.sources.some((source) => source.id === "persona"));
assert.equal(
  __testing.knowledgeFileInventoryCacheStats().entries,
  firstInventoryStats.entries,
  "hot aggregate sources should reuse cached source file inventories"
);

const found = await tools.get("knowledge_search").execute("search", {
  query: "official outfit reference images",
  sources: "prompt_library,tool_manuals",
  mode: "keyword",
  count: 4
});
assert.equal(found.details.status, "ok");
assert.equal(found.details.mode, "keyword");
assert.ok(found.details.results.some((item) => item.sourceId === "prompt_library"));
assert.ok(found.details.sources.some((item) => item.sourceId === "prompt_library"));
assert.ok(found.details.sources.every((item) => !("filePath" in item)));
const firstTextStats = __testing.knowledgeFileTextCacheStats();
assert.ok(firstTextStats.entries >= 1, "knowledge_search should cache searched file text by mtime signature");
assert.ok(firstTextStats.misses >= 1, "cold knowledge_search should read source text");

const hotFound = await tools.get("knowledge_search").execute("search-hot", {
  query: "official outfit reference images",
  sources: "prompt_library,tool_manuals",
  mode: "keyword",
  count: 4
});
assert.equal(hotFound.details.status, "ok");
assert.deepEqual(
  hotFound.details.results.map((item) => `${item.sourceId}/${item.title}`),
  found.details.results.map((item) => `${item.sourceId}/${item.title}`),
  "hot knowledge_search should return the same ranked public results"
);
assert.ok(__testing.knowledgeFileTextCacheStats().hits > firstTextStats.hits, "hot knowledge_search should reuse cached text");

const aggregateFound = await tools.get("knowledge").execute("aggregate-search", {
  action: "search",
  query: "official outfit reference images",
  sources: "prompt_library,tool_manuals",
  mode: "keyword",
  count: 4
});
assert.equal(aggregateFound.details.status, "ok");
assert.ok(aggregateFound.details.results.some((item) => item.sourceId === "prompt_library"));

const ctxA = { agentId: "imagebot", accountId: "imagebot", chatId: "knowledge-chat-a", sessionKey: "knowledge-session-a", senderId: "101", messageId: "10" };
const ctxB = { agentId: "imagebot", accountId: "imagebot", chatId: "knowledge-chat-b", sessionKey: "knowledge-session-b", senderId: "202", messageId: "20" };

const draftFile = await tools.get("knowledge_ingest").execute("ingest-file", {
  file: inboundFile,
  title: "RL note",
  tags: "research,prototype"
}, null, null, ctxA);
assert.equal(draftFile.details.status, "draft");
const ingestedFile = await tools.get("knowledge_ingest").execute("commit-file", {
  action: "commit",
  plan_id: draftFile.details.plan_id
}, null, null, { ...ctxA, messageId: "11", text: `approved ${draftFile.details.approval_code}` });
assert.equal(ingestedFile.details.status, "ok");
assert.equal(__testing.knowledgeFileInventoryCacheStats().entries, 0, "knowledge_ingest commit should invalidate file inventories");
assert.equal(__testing.knowledgeFileTextCacheStats().entries, 0, "knowledge_ingest commit should invalidate cached text");

const draftText = await tools.get("knowledge_ingest").execute("ingest-text", {
  title: "Group meme note",
  text: "Hanami likes cursed image jokes and fast replies."
}, null, null, ctxA);
assert.equal(draftText.details.status, "draft");
const ingestedText = await tools.get("knowledge_ingest").execute("commit-text", {
  action: "commit",
  plan_id: draftText.details.plan_id
}, null, null, { ...ctxA, messageId: "12", text: `save it ${draftText.details.approval_code}` });
assert.equal(ingestedText.details.status, "ok");

const draftOtherScope = await tools.get("knowledge_ingest").execute("ingest-other-scope", {
  title: "Other scope note",
  text: "Only chat B should recall the moonlit private keyword."
}, null, null, ctxB);
const ingestedOtherScope = await tools.get("knowledge_ingest").execute("commit-other-scope", {
  action: "commit",
  plan_id: draftOtherScope.details.plan_id
}, null, null, { ...ctxB, messageId: "21", text: `ok ${draftOtherScope.details.approval_code}` });
assert.equal(ingestedOtherScope.details.status, "ok");

const userSearch = await tools.get("knowledge_search").execute("search-user", {
  query: "cursed image jokes",
  sources: "user_docs",
  mode: "keyword",
  count: 3
}, null, null, ctxA);
assert.equal(userSearch.details.status, "ok");
assert.ok(userSearch.details.results.some((item) => /Hanami|cursed/.test(item.snippet)));
assert.ok(userSearch.details.sources.every((item) => item.privacy === "bot-workspace"));
assert.ok(userSearch.details.sources.every((item) => !/scopes\//i.test(item.title)));

const crossScopeSearch = await tools.get("knowledge_search").execute("search-cross-scope", {
  query: "moonlit private keyword",
  sources: "user_docs",
  mode: "keyword",
  count: 3
}, null, null, ctxA);
assert.equal(crossScopeSearch.details.status, "ok");
assert.equal(crossScopeSearch.details.results.length, 0);

const sameScopeSearch = await tools.get("knowledge_search").execute("search-same-scope", {
  query: "moonlit private keyword",
  sources: "user_docs",
  mode: "keyword",
  count: 3
}, null, null, ctxB);
assert.equal(sameScopeSearch.details.status, "ok");
assert.ok(sameScopeSearch.details.results.some((item) => /moonlit private/.test(item.snippet)));

const recent = await tools.get("knowledge_recent").execute("recent", { sources: "user_docs", count: 3 }, null, null, ctxA);
assert.equal(recent.details.status, "ok");
assert.ok(recent.details.results.length >= 2);

const aggregateRecent = await tools.get("knowledge").execute("aggregate-recent", { action: "recent", sources: "user_docs", count: 3 }, null, null, ctxA);
assert.equal(aggregateRecent.details.status, "ok");
assert.ok(aggregateRecent.details.results.length >= 2);

const listed = await tools.get("knowledge_ingest").execute("list-ingested", { action: "list", count: 5 }, null, null, ctxA);
assert.equal(listed.details.status, "ok");
assert.ok(listed.details.records.some((record) => record.id === ingestedText.details.id));

const crossScopeDelete = await tools.get("knowledge_ingest").execute("delete-cross-scope", {
  action: "delete",
  id: ingestedText.details.id,
  dryRun: false,
  reason: "wrong scope"
}, null, null, ctxB);
assert.equal(crossScopeDelete.details.status, "no_match");

const deleteDryRun = await tools.get("knowledge_ingest").execute("delete-dry-run", { action: "delete", id: ingestedText.details.id }, null, null, ctxA);
assert.equal(deleteDryRun.details.status, "dry_run");

const deleteMissingContext = await tools.get("knowledge_ingest").execute("delete-missing-context", {
  action: "delete",
  id: ingestedText.details.id,
  dryRun: false,
  reason: "missing context"
});
assert.equal(deleteMissingContext.details.status, "failed");
assert.match(deleteMissingContext.details.error, /trusted runtime actor context/);

const deleted = await tools.get("knowledge_ingest").execute("delete-real", {
  action: "delete",
  id: ingestedText.details.id,
  dryRun: false,
  reason: "stale test note"
}, null, null, ctxA);
assert.equal(deleted.details.status, "ok");
assert.equal(__testing.knowledgeFileInventoryCacheStats().entries, 0, "knowledge_ingest delete should invalidate file inventories");
assert.equal(__testing.knowledgeFileTextCacheStats().entries, 0, "knowledge_ingest delete should invalidate cached text");
const ingestIndexLines = (await fs.readFile(path.join(storeDir, "ingest-index.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
const deleteEvent = ingestIndexLines.find((event) => event.event === "delete" && event.id === ingestedText.details.id);
assert.equal(deleteEvent.reason, "stale test note");
assert.match(deleteEvent.targetFingerprint, /^[a-f0-9]{18}$/);
assert.equal(deleteEvent.deletedBy.senderId, "101");

assert.equal(__testing.normalizeMode("semantic"), "semantic");
assert.equal(__testing.normalizeMode("nonsense"), "hybrid");
assert.ok(__testing.chunkText("Amadeus reference note. ".repeat(140)).length > 1);
assert.match(__testing.docSignature([{ sourceId: "x", kind: "repo_docs", title: "a", mtimeMs: 1, size: 2 }]), /^[a-f0-9]{64}$/);
assert.ok(__testing.semanticIndexPath({ storeDir }).startsWith(storeDir));

await assert.rejects(
  () => __testing.knowledgeIngest({ repoRoot, storeDir, allowedFileRoots: [inbound] }, { file: path.join(os.homedir(), "Desktop", "private.txt") }),
  /outside allowed/
);

console.log("knowledge library plugin tests passed");

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __testing } from "../plugins/imagebot-tool-manual-search/index.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const manualsRoot = path.join(repoRoot, "tool_manuals");

__testing.clearManualCache();
assert.equal(__testing.manualCacheStats().cached, false);

const focusValues = new Set(__testing.focusValues());
const manualIds = [];
for (const name of await fs.readdir(manualsRoot)) {
  if (!name.endsWith(".md")) continue;
  const raw = await fs.readFile(path.join(manualsRoot, name), "utf8");
  const id = raw.match(/^id:\s*(.+)$/m)?.[1]?.trim() || name.replace(/\.md$/i, "");
  manualIds.push(id);
}
for (const id of manualIds) {
  assert.ok(focusValues.has(id), `focus enum must include current manual id: ${id}`);
}

const cold = await __testing.searchManuals({
  query: "background job manual tool usage",
  count: 4
});
assert.ok(cold.length >= 1, "cold manual search should return results");

const firstStats = __testing.manualCacheStats();
assert.equal(firstStats.cached, true, "manual sections should be cached after first search");
assert.ok(firstStats.files > 0, "cache should record manual file count");
assert.ok(firstStats.sections > 0, "cache should record manual section count");
assert.equal(firstStats.inventoryCached, true, "manual inventory should be cached after first search");
assert.ok(firstStats.inventoryCheckedAt > 0, "manual inventory cache should record check time");

const hot = await __testing.searchManuals({
  query: "background job manual tool usage",
  count: 4
});
const secondStats = __testing.manualCacheStats();
assert.equal(secondStats.loadedAt, firstStats.loadedAt, "hot search should reuse the same cache load");
assert.equal(secondStats.inventoryCheckedAt, firstStats.inventoryCheckedAt, "hot search should not rescan manual inventory within the recheck window");
assert.deepEqual(
  hot.map((item) => `${item.id}/${item.title}`),
  cold.map((item) => `${item.id}/${item.title}`),
  "cached search should preserve result order"
);

const [cachedAgentOps, uncachedAgentOps] = await Promise.all([
  __testing.loadManualSections("agent_ops"),
  __testing.loadManualSectionsUncached("agent_ops")
]);
assert.deepEqual(
  cachedAgentOps.map((item) => `${item.id}/${item.title}`),
  uncachedAgentOps.map((item) => `${item.id}/${item.title}`),
  "cached focus lookup should match uncached parsing"
);

__testing.clearManualCache();
const concurrent = await Promise.all(Array.from({ length: 12 }, () => __testing.searchManuals({
  query: "image generate telegram delivery manual",
  count: 3
})));
const concurrentStats = __testing.manualCacheStats();
assert.equal(concurrentStats.cached, true, "concurrent searches should leave a warm cache");
assert.ok(concurrent.every((result) => result.length >= 1), "all concurrent searches should return results");

console.log("tool manual search cache tests passed", {
  files: concurrentStats.files,
  sections: concurrentStats.sections,
  concurrent: concurrent.length
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin, { __testing } from "../plugins/imagebot-creative-ops/index.js";

const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "creative-ops-jsonl-cache-"));
const tools = new Map();

plugin.register({
  config: {
    storeDir,
    repoRoot: process.cwd(),
    appendFeedbackHints: true,
    allowMutatingScripts: true
  },
  registerTool(tool, opts) {
    tools.set(opts?.name || tool.name, tool);
  },
  registerHook() {}
});

__testing.clearJsonLinesCache();
assert.equal(__testing.jsonLinesCacheStats().entries, 0);

await tools.get("image_feedback").execute("record-1", {
  action: "record",
  rating: "good",
  subject: "cache test",
  keep: "sharp line art",
  avoid: "muddy color",
  tags: ["cache"]
});
assert.equal(__testing.jsonLinesCacheStats().entries, 0, "append should not leave stale cache");

const first = await tools.get("image_feedback").execute("search-1", {
  action: "search",
  query: "sharp line art",
  count: 3
});
assert.equal(first.details.status, "ok");
assert.equal(first.details.results.length, 1);
assert.equal(__testing.jsonLinesCacheStats().entries, 1);

const second = await tools.get("image_feedback").execute("search-2", {
  action: "search",
  query: "sharp line art",
  count: 3
});
assert.equal(second.details.results.length, 1);
assert.equal(__testing.jsonLinesCacheStats().entries, 1);

await tools.get("image_feedback").execute("record-2", {
  action: "record",
  rating: "bad",
  subject: "cache test second",
  keep: "clean silhouette",
  avoid: "wrong hair color",
  tags: ["cache"]
});
assert.equal(__testing.jsonLinesCacheStats().entries, 0, "append should invalidate cached JSONL records");

const updated = await tools.get("image_feedback").execute("search-3", {
  action: "search",
  query: "wrong hair color",
  count: 3
});
assert.ok(updated.details.results.some((record) => record.subject === "cache test second"));
assert.equal(__testing.jsonLinesCacheStats().entries, 1);

console.log("creative-ops jsonl cache tests passed", __testing.jsonLinesCacheStats());

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __testing } from "../plugins/imagebot-agent-ops/index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ops-json-cache-"));
const windowStorePath = path.join(root, "windows.json");
const config = { windowStorePath };

__testing.clearJsonCache();
assert.equal(__testing.jsonCacheStats().entries, 0);

await fs.writeFile(windowStorePath, JSON.stringify({
  version: 3,
  activeByUser: {},
  byBotMessage: {},
  users: {
    "telegram:1": { id: "1", names: ["Alice"] }
  },
  windows: {}
}, null, 2), "utf8");

const first = await __testing.loadWindowStore(config);
assert.equal(first.users["telegram:1"].names[0], "Alice");
assert.equal(__testing.jsonCacheStats().entries, 1);

const second = await __testing.loadWindowStore(config);
assert.equal(second.users["telegram:1"].names[0], "Alice");
assert.equal(__testing.jsonCacheStats().entries, 1);

await new Promise((resolve) => setTimeout(resolve, 20));
await fs.writeFile(windowStorePath, JSON.stringify({
  version: 3,
  activeByUser: {},
  byBotMessage: {},
  users: {
    "telegram:1": { id: "1", names: ["Alice", "Bob"] }
  },
  windows: {}
}, null, 2), "utf8");

const updated = await __testing.loadWindowStore(config);
assert.deepEqual(updated.users["telegram:1"].names, ["Alice", "Bob"]);
assert.equal(__testing.jsonCacheStats().entries, 1);

console.log("agent-ops json cache tests passed", __testing.jsonCacheStats());

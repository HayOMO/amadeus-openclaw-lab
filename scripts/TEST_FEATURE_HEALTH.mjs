import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync("node", ["scripts/CHECK_IMAGEBOT_FEATURE_HEALTH.mjs", "--json"], {
  encoding: "utf8",
  shell: false
});

if (result.status !== 0) {
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  process.exit(result.status ?? 1);
}

const parsed = JSON.parse(result.stdout);
assert.equal(parsed.status, "ok");
assert.ok(parsed.plugins >= 20, "feature health should inspect local plugins");
assert.ok(parsed.tools >= 50, "feature health should inspect plugin tools");

const warningMessages = new Set((parsed.warnings || []).map((item) => item.message));
assert.ok(
  warningMessages.has("manifest tool is not exposed in allowedTools: web_text_search"),
  "web_text_search should remain hidden behind explicit_web_text_search"
);
assert.ok(
  warningMessages.has("plugin directory is not configured as a local plugin: imagebot-shared"),
  "imagebot-shared should remain a helper directory, not a runtime plugin"
);

console.log("feature health tests passed", {
  plugins: parsed.plugins,
  tools: parsed.tools,
  warnings: parsed.warnings.length
});

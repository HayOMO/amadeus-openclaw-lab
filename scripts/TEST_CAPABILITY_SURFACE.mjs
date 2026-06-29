import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const policy = JSON.parse(await fs.readFile(path.join(repoRoot, "policy", "capability_surface.json"), "utf8"));
const settings = JSON.parse(await fs.readFile(path.join(repoRoot, "config", "imagebot", "settings.json"), "utf8"));

assert.equal(policy.schema, 1);
assert.equal(policy.bot, settings.agentId);
assert.deepEqual(policy.telegram.allowedGroupIds, settings.groupIds);
assert.equal(policy.telegram.groupPolicy, "allowlist");

for (const denied of policy.tooling.explicitlyDenied) {
  assert.ok(settings.deniedTools.includes(denied), `policy denied tool missing from settings.deniedTools: ${denied}`);
}

for (const denied of policy.tooling.agentDelegation.currentlyDenied) {
  assert.ok(settings.deniedTools.includes(denied), `delegation denied tool missing from settings.deniedTools: ${denied}`);
  assert.ok(!settings.allowedTools.includes(denied), `delegation tool must not be allowed yet: ${denied}`);
}
assert.equal(policy.tooling.agentDelegation.source, "config/imagebot/agents.catalog.json");

for (const command of policy.tooling.scriptStyleCommands) {
  assert.ok(["amnew", "amhelp", "amstatus", "ammodel", "ampersona", "amtools"].includes(command), `unexpected visible command in policy: ${command}`);
}

for (const diagnostic of policy.tooling.diagnostics) {
  assert.ok(settings.allowedTools.includes(diagnostic), `diagnostic tool not allowed in settings: ${diagnostic}`);
}

for (const tool of policy.tooling.personaOverlays || []) {
  assert.ok(settings.allowedTools.includes(tool), `persona overlay tool not allowed in settings: ${tool}`);
}

for (const tool of policy.tooling.mediaProduction) {
  assert.ok(settings.allowedTools.includes(tool), `media production tool not allowed in settings: ${tool}`);
}

for (const tool of policy.tooling.localDesktop || []) {
  assert.ok(settings.allowedTools.includes(tool), `local desktop tool not allowed in settings: ${tool}`);
}

for (const tool of policy.tooling.games || []) {
  assert.ok(settings.allowedTools.includes(tool), `game tool not allowed in settings: ${tool}`);
}

assert.equal(policy.tooling.senderToolPolicy.source, "config/imagebot/settings.json");
assert.equal(policy.tooling.senderToolPolicy.operatorIdsSource, "operatorSenderIds");
assert.deepEqual(policy.tooling.senderToolPolicy.operatorOnlyTools, settings.toolAccess.operatorOnlyTools);
assert.ok(Array.isArray(settings.operatorSenderIds) && settings.operatorSenderIds.length >= 1, "operator sender ids must be configured");
assert.ok(policy.tooling.senderToolPolicy.operatorOnlyTools.includes("knowledge_ingest"), "policy should keep long-term knowledge writes operator-only");
assert.ok(policy.tooling.senderToolPolicy.operatorOnlyTools.includes("script_action"), "policy should keep maintenance scripts operator-only");
assert.ok(!policy.tooling.senderToolPolicy.operatorOnlyTools.includes("feature_action"), "ordinary feature_action should stay outside the operator-only layer");
for (const tool of policy.tooling.senderToolPolicy.operatorOnlyTools) {
  assert.ok(settings.allowedTools.includes(tool), `operator-only tool must remain available in total allowlist: ${tool}`);
  assert.ok(!settings.deniedTools.includes(tool), `operator-only tool must not be globally denied: ${tool}`);
}

const doc = await fs.readFile(path.join(repoRoot, "docs", "CAPABILITY_SURFACE.md"), "utf8");
assert.ok(doc.includes("policy/capability_surface.json"));
assert.ok(doc.includes("Deferred Or Not Yet Granted"));
assert.ok(doc.includes("Sender Tool Layers"));

console.log("capability surface tests passed");

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __testing as interactionCore } from "../plugins/imagebot-interaction-core/index.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const scenariosDir = path.join(repoRoot, "tests", "telegram-scenarios");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function loadScenarios() {
  const entries = await fs.readdir(scenariosDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(scenariosDir, entry.name))
    .sort();
  return await Promise.all(files.map(readJson));
}

function assertExpectation(label, expect, result) {
  if (!expect) return;
  if ("shouldRespond" in expect) assert.equal(result.shouldRespond, expect.shouldRespond, `${label}: shouldRespond`);
  if ("reason" in expect) assert.equal(result.reason, expect.reason, `${label}: reason`);
  if ("command" in expect) assert.equal(result.command, expect.command, `${label}: command`);
  if ("windowMode" in expect) assert.equal(result.window?.mode, expect.windowMode, `${label}: window mode`);
  if ("windowKey" in expect) assert.equal(result.window?.key, expect.windowKey, `${label}: window key`);
  if ("normalizedText" in expect) assert.equal(result.normalizedText, expect.normalizedText, `${label}: normalized text`);
}

const settings = await readJson(path.join(repoRoot, "config", "imagebot", "settings.json"));
const baseConfig = {
  botUsernames: settings.botUsernames,
  triggerPrefixes: ["Amadeus", "Amaduse", "Makise Kurisu", "Makise", "Kurisu"]
};

const scenarios = await loadScenarios();
const summaries = [];

for (const scenario of scenarios) {
  const config = { ...baseConfig, ...(scenario.config || {}) };
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  assert.ok(steps.length > 0, `${scenario.name || "scenario"} should have steps`);
  for (const [index, step] of steps.entries()) {
    const label = `${scenario.name || "scenario"}#${index + 1}:${step.name || "step"}`;
    const result = interactionCore.evaluateMessage(config, step.input || {});
    assertExpectation(label, step.expect, result);
    summaries.push({
      scenario: scenario.name,
      step: step.name,
      shouldRespond: result.shouldRespond,
      reason: result.reason,
      windowMode: result.window?.mode
    });
  }
}

console.log("telegram scenario replay tests passed");
console.log(JSON.stringify({ scenarios: scenarios.length, steps: summaries.length, summaries }, null, 2));

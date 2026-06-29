import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __testing as interactionCore } from "../plugins/imagebot-interaction-core/index.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const fixturesDir = path.join(repoRoot, "tests", "telegram-turns");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function loadFixtures() {
  const entries = await fs.readdir(fixturesDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(fixturesDir, entry.name))
    .sort();
  return await Promise.all(files.map(readJson));
}

function assertExpectation(fixture, result) {
  const expect = fixture.expect || {};
  if ("shouldRespond" in expect) assert.equal(result.shouldRespond, expect.shouldRespond, `${fixture.name}: shouldRespond`);
  if ("reason" in expect) assert.equal(result.reason, expect.reason, `${fixture.name}: reason`);
  if ("windowMode" in expect) assert.equal(result.window?.mode, expect.windowMode, `${fixture.name}: window mode`);
  if ("windowKey" in expect) assert.equal(result.window?.key, expect.windowKey, `${fixture.name}: window key`);
  if ("normalizedText" in expect) assert.equal(result.normalizedText, expect.normalizedText, `${fixture.name}: normalized text`);
}

const settings = await readJson(path.join(repoRoot, "config", "imagebot", "settings.json"));
const config = {
  botUsernames: settings.botUsernames,
  triggerPrefixes: ["Amadeus", "Amaduse", "Makise Kurisu", "Makise", "Kurisu"]
};

const fixtures = await loadFixtures();
const summaries = [];

for (const fixture of fixtures) {
  const result = interactionCore.evaluateMessage(config, fixture.input || {});
  assertExpectation(fixture, result);
  summaries.push({
    name: fixture.name,
    shouldRespond: result.shouldRespond,
    reason: result.reason,
    window: result.window?.mode,
    normalizedText: result.normalizedText
  });
}

console.log("telegram turn replay tests passed");
console.log(JSON.stringify({ fixtures: summaries.length, summaries }, null, 2));

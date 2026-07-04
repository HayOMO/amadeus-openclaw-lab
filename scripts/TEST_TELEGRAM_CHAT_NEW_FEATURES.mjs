import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __testing as chatToolboxTesting } from "../plugins/imagebot-chat-toolbox/index.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const docPath = path.join(repoRoot, "docs", "bot_feature_scouting", "telegram_chat_new_features_2026-06-30.md");
const settingsPath = path.join(repoRoot, "config", "imagebot", "settings.json");
const doc = await fs.readFile(docPath, "utf8");
const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));

assert.ok(doc.includes("restricted to features that are useful inside Telegram chat"), "scope must be Telegram-chat only");
assert.ok(doc.includes("backlog candidates, not enabled in"), "doc must mark these features as backlog candidates");
assert.ok(doc.includes("already covered by the repo"), "doc must say existing features are skipped");
assert.ok(doc.includes("obvious conflicts"), "doc must say conflicting features are skipped");
assert.ok(doc.includes("Merged Evaluation Bundles"), "doc must group the backlog into review bundles");
assert.ok(!settings.allowedTools?.includes("chat_toolbox"), "chat_toolbox backlog prototype must not be active in allowedTools");
assert.ok(!settings.allowedPluginIds?.includes("imagebot-chat-toolbox"), "chat toolbox backlog prototype must not be active in allowedPluginIds");
assert.ok(!settings.localPluginDirs?.includes("plugins/imagebot-chat-toolbox"), "chat toolbox backlog prototype must not be active in localPluginDirs");

for (const source of [
  "https://github.com/topics/bot?o=desc&s=stars",
  "https://github.com/Cog-Creators/Red-DiscordBot",
  "https://github.com/ProgVal/Limnoria",
  "https://github.com/sopel-irc/sopel",
  "https://github.com/sfyc23/EverydayWechat",
  "https://github.com/hubotio/hubot"
]) {
  assert.ok(doc.includes(source), `missing source link: ${source}`);
}

const rows = doc
  .split(/\r?\n/)
  .filter((line) => /^\|\s*\d+\s*\|/.test(line))
  .map((line) => line.split("|").map((cell) => cell.trim()).filter(Boolean));

assert.equal(rows.length, 50, "Telegram-chat backlog feature table must contain exactly 50 counted rows");

const candidateActions = [];
for (const row of rows) {
  assert.equal(row[3], "todo_candidate", `row ${row[0]} must be a todo candidate`);
  assert.match(row[4], /chat_toolbox action=/, `row ${row[0]} must name chat_toolbox prototype action`);
  const match = row[4].match(/action=([a-z0-9_]+)/);
  assert.ok(match, `row ${row[0]} must name a concrete action`);
  candidateActions.push(match[1]);
}

const actionSet = new Set(chatToolboxTesting.ACTIONS);
assert.equal(chatToolboxTesting.GROUP_ACTIONS.length, 9, "chat toolbox should expose 9 grouped evaluation actions");
assert.deepEqual([...new Set(chatToolboxTesting.groupCoverage())].sort(), [...actionSet].sort(), "grouped bundles must cover every concrete action exactly once");
for (const action of candidateActions) {
  assert.ok(actionSet.has(action), `doc names action that chat_toolbox does not expose: ${action}`);
}

assert.equal(new Set(candidateActions).size, candidateActions.length, "feature rows must not duplicate actions");
assert.deepEqual(candidateActions.sort(), [...actionSet].sort(), "feature rows must cover every chat_toolbox prototype action exactly once");

for (const phrase of [
  "chat_toolbox action=task",
  "chat_toolbox action=records",
  "chat_toolbox action=schedule",
  "chat_toolbox action=poll",
  "chat_toolbox action=random",
  "chat_toolbox action=text",
  "chat_toolbox action=wellness",
  "chat_toolbox action=social",
  "chat_toolbox action=queue"
]) {
  assert.ok(doc.includes(phrase), `merged bundle table must mention: ${phrase}`);
}

for (const phrase of [
  "skipped as admin/control actions",
  "skipped because Telegram chat has no",
  "hidden automatic delivery is skipped",
  "skipped as copyright and storage risk"
]) {
  assert.ok(doc.includes(phrase), `skipped boundary examples must mention: ${phrase}`);
}

console.log("telegram chat backlog feature table tests passed", {
  rows: rows.length,
  actions: candidateActions.length,
  active: false
});

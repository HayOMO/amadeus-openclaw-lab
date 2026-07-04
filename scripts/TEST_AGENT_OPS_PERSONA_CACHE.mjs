import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __testing } from "../plugins/imagebot-agent-ops/index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ops-persona-cache-"));
const personaDir = path.join(root, "persona");
await fs.mkdir(personaDir, { recursive: true });

const cardPath = path.join(personaDir, "card.md");
const languagePath = path.join(personaDir, "language.md");
const lorebookPath = path.join(personaDir, "lorebook.json");
const examplesPath = path.join(personaDir, "examples.md");

await fs.writeFile(cardPath, "# Persona Card\n\nYou are Cache Test.", "utf8");
await fs.writeFile(languagePath, "Speak naturally.", "utf8");
await fs.writeFile(lorebookPath, JSON.stringify({
  entries: [
    { id: "lab", name: "Lab memory", keys: ["cache"], content: "Remember stable facts." }
  ]
}, null, 2), "utf8");
await fs.writeFile(examplesPath, "User: ping\nBot: pong", "utf8");

const config = { repoRoot: root };
const persona = {
  cardPath: "persona/card.md",
  languageRulesPath: "persona/language.md",
  lorebookPath: "persona/lorebook.json",
  examplePath: "persona/examples.md"
};

__testing.clearPersonaFileCache();
assert.deepEqual(__testing.personaFileCacheStats(), { entries: 0, hits: 0, misses: 0 });

const cold = await __testing.readPersonaProfile(config, persona);
assert.match(cold.card, /Cache Test/);
assert.match(cold.languageRules, /Speak naturally/);
assert.match(cold.lorebook, /Lab memory/);
assert.match(cold.lorebook, /Remember stable facts/);
assert.match(cold.examples, /ping/);
assert.deepEqual(__testing.personaFileCacheStats(), { entries: 4, hits: 0, misses: 4 });

const hot = await __testing.readPersonaProfile(config, persona);
assert.equal(hot.card, cold.card);
assert.deepEqual(__testing.personaFileCacheStats(), { entries: 4, hits: 4, misses: 4 });

const concurrent = await Promise.all(Array.from({ length: 8 }, () => __testing.readPersonaProfile(config, persona)));
assert.ok(concurrent.every((profile) => profile.card === cold.card));
assert.deepEqual(__testing.personaFileCacheStats(), { entries: 4, hits: 36, misses: 4 });

await new Promise((resolve) => setTimeout(resolve, 20));
await fs.writeFile(cardPath, "# Persona Card\n\nYou are Cache Test v2.", "utf8");

const refreshed = await __testing.readPersonaProfile(config, persona);
assert.match(refreshed.card, /v2/);
assert.match(refreshed.languageRules, /Speak naturally/);
assert.deepEqual(__testing.personaFileCacheStats(), { entries: 4, hits: 39, misses: 5 });

console.log("agent-ops persona cache tests passed", __testing.personaFileCacheStats());

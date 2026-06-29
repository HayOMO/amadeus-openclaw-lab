import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();

async function readJson(rel) {
  return JSON.parse(await fs.readFile(path.join(repoRoot, rel), "utf8"));
}

async function existsFile(rel) {
  const stat = await fs.stat(path.join(repoRoot, rel));
  return stat.isFile();
}

const catalog = await readJson("config/imagebot/agents.catalog.json");
assert.equal(catalog.schema, 1);
assert.equal(catalog.design.unit, "persona_agent");
assert.equal(catalog.design.modelRole, "runtime_backend");
assert.equal(catalog.design.delegation, "sessions_spawn");

assert.ok(Array.isArray(catalog.personas));
assert.ok(catalog.personas.length >= 2);

const main = catalog.personas.find((item) => item.id === "imagebot");
const alt = catalog.personas.find((item) => item.id === "persona_alt_seed");
assert.ok(main, "missing imagebot persona");
assert.ok(alt, "missing persona_alt_seed persona");

assert.equal(catalog.design.memoryPolicy, "shared_across_personas");
assert.equal(catalog.shared.memoryScope, "shared:imagebot");
assert.equal(main.memoryScope, catalog.shared.memoryScope);
assert.equal(alt.memoryScope, catalog.shared.memoryScope);
assert.notEqual(main.agentDir, alt.agentDir);
assert.notEqual(main.workspace, alt.workspace);
assert.equal(alt.inheritsFrom, "imagebot");
assert.match(alt.copyPolicy, /long-term memory is shared:imagebot/i);

for (const persona of catalog.personas) {
  assert.ok(await existsFile(persona.personaPath), `missing persona file: ${persona.personaPath}`);
  assert.equal(persona.memoryScope, catalog.shared.memoryScope, `${persona.id} must use shared imagebot memory`);
  assert.doesNotMatch(persona.memoryScope, /^private:/, `${persona.id} must not use persona-private memory`);
}

const shared = catalog.shared;
for (const tool of ["tool_manual_search", "knowledge_search", "memory_search"]) {
  assert.ok(shared.tools.safeShared.includes(tool), `missing shared tool ${tool}`);
}
for (const tool of ["script_action", "model_config"]) {
  assert.ok(shared.tools.opsPrivate.includes(tool), `missing ops private tool ${tool}`);
}
for (const tool of ["sessions_spawn", "sessions_yield", "sessions_history", "subagents", "agents_list"]) {
  assert.ok(shared.tools.delegateTools.includes(tool), `missing delegate tool ${tool}`);
}

const modelCatalog = await readJson("scripts/IMAGEBOT_MODEL_PROFILES.json");
for (const id of ["openai/gpt-5.5", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"]) {
  assert.ok(modelCatalog.models.some((model) => model.id === id && model.enabled !== false), `missing enabled model ${id}`);
}
for (const id of ["balanced", "ds-fast", "ds-pro"]) {
  assert.ok(modelCatalog.profiles.some((profile) => profile.id === id), `missing model profile ${id}`);
}

const overlayCatalog = await readJson("persona/persona_overlays.json");
assert.equal(overlayCatalog.schema, 1);
assert.equal(overlayCatalog.design.unit, "persona_overlay");
for (const id of ["default", "none", "chihaya_anon", "takamatsu_tomori", "shiina_taki", "kaname_rana", "nagasaki_soyo", "togawa_sakiko", "megumin", "frieren", "classic_nekomimi", "hatsune_miku", "raiden_shogun_ei", "aqua_konosuba"]) {
  assert.ok(overlayCatalog.personas.some((item) => item.id === id), `missing ${id} persona overlay`);
}

const defaultOverlay = overlayCatalog.personas.find((item) => item.id === "default");
assert.ok(defaultOverlay, "missing default Amaduse overlay");
assert.equal(defaultOverlay.label, "Amaduse");
assert.equal(defaultOverlay.cardPath, "persona/active_system.md", "default overlay must inject the base Amaduse card");
assert.ok(defaultOverlay.aliases.includes("amaduse"), "default overlay needs Amaduse alias");

const noneOverlay = overlayCatalog.personas.find((item) => item.id === "none");
assert.ok(noneOverlay, "missing explicit no-persona overlay");
assert.equal(noneOverlay.cardPath, undefined, "none overlay must not inject a persona card");
assert.ok(noneOverlay.aliases.includes("none"), "none overlay needs none alias");
assert.ok(noneOverlay.aliases.includes("无人设"), "none overlay needs Chinese no-persona alias");

const chihayaAnon = overlayCatalog.personas.find((item) => item.id === "chihaya_anon");
assert.ok(chihayaAnon, "missing chihaya_anon persona profile");
assert.ok(chihayaAnon.aliases.includes("千早爱音"));
assert.equal(chihayaAnon.cardPath, "persona/profiles/chihaya_anon/active_system.md");
assert.equal(chihayaAnon.languageRulesPath, "persona/profiles/chihaya_anon/language_rules.md");
assert.equal(chihayaAnon.lorebookPath, "persona/profiles/chihaya_anon/lorebook.json");
assert.equal(chihayaAnon.examplePath, "persona/profiles/chihaya_anon/examples.md");
assert.ok(await existsFile(chihayaAnon.cardPath), `missing persona profile file: ${chihayaAnon.cardPath}`);
assert.ok(await existsFile(chihayaAnon.languageRulesPath), `missing persona language rules file: ${chihayaAnon.languageRulesPath}`);
assert.ok(await existsFile(chihayaAnon.lorebookPath), `missing persona lorebook file: ${chihayaAnon.lorebookPath}`);
assert.ok(await existsFile(chihayaAnon.examplePath), `missing persona examples file: ${chihayaAnon.examplePath}`);
assert.ok(!chihayaAnon.memoryScope, "persona profiles must not declare private memory scopes");

for (const id of ["frieren", "megumin", "classic_nekomimi", "hatsune_miku", "raiden_shogun_ei", "aqua_konosuba"]) {
  const overlay = overlayCatalog.personas.find((item) => item.id === id);
  assert.ok(overlay?.languageRulesPath, `${id} should include language rules`);
  assert.ok(overlay?.lorebookPath, `${id} should include a lorebook`);
  assert.ok(overlay?.examplePath, `${id} should include examples`);
}

for (const overlay of overlayCatalog.personas) {
  assert.ok(!overlay.memoryScope, `${overlay.id} profile must not declare memory scope`);
  if (overlay.cardPath) {
    assert.ok(await existsFile(overlay.cardPath), `missing persona profile file: ${overlay.cardPath}`);
    const card = await fs.readFile(path.join(repoRoot, overlay.cardPath), "utf8");
    assert.match(card, /^# (?:Persona Card|Active Persona Card) - /, `${overlay.id} card must use persona card heading`);
    assert.ok(card.length < (overlay.id === "default" ? 5000 : 2500), `${overlay.id} card should stay lightweight`);
    assert.doesNotMatch(card, /Tool access|safety rules|safety boundaries|owner checks|memory provenance|Long-term memory is shared|private memory scope/i, `${overlay.id} card must not carry runtime boundary boilerplate`);
  }
  if (overlay.languageRulesPath) assert.ok(await existsFile(overlay.languageRulesPath), `missing persona language rules file: ${overlay.languageRulesPath}`);
  if (overlay.lorebookPath) assert.ok(await existsFile(overlay.lorebookPath), `missing persona lorebook file: ${overlay.lorebookPath}`);
  if (overlay.examplePath) assert.ok(await existsFile(overlay.examplePath), `missing persona examples file: ${overlay.examplePath}`);
}

console.log("agent persona catalog tests passed");

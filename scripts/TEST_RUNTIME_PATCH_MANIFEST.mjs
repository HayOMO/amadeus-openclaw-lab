import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const patchDir = path.join(repoRoot, "patches", "openclaw-2026.6.10-runtime");
const manifestPath = path.join(patchDir, "manifest.json");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
assert.equal(manifest.schema, 1);
assert.equal(manifest.openclawVersion, "2026.6.10");
assert.ok(Array.isArray(manifest.patches));
assert.ok(manifest.patches.length > 0);

const actualPatchFiles = (await fs.readdir(patchDir)).filter((name) => name.endsWith(".patch")).sort();
const manifestPatchFiles = manifest.patches.map((entry) => entry.file).sort();
assert.deepEqual(manifestPatchFiles, actualPatchFiles);

const ids = new Set();
for (const entry of manifest.patches) {
  assert.ok(entry.id && !ids.has(entry.id), `duplicate or missing id: ${entry.id}`);
  ids.add(entry.id);
  assert.ok(entry.file.endsWith(".patch"), `bad patch file: ${entry.file}`);
  assert.match(entry.target, /^dist\/.+\.js$/);
  assert.ok(Array.isArray(entry.protects) && entry.protects.length > 0, `${entry.file} needs protected behavior notes`);
  assert.ok(Array.isArray(entry.checks) && entry.checks.length > 0, `${entry.file} needs checks`);

  const patchText = await fs.readFile(path.join(patchDir, entry.file), "utf8");
  assert.ok(patchText.includes(`b/${entry.target}`), `${entry.file} does not reference ${entry.target}`);
}
assert.ok(ids.has("telegram-script-micro-commands"), "micro command runtime patch must stay listed");
assert.ok(ids.has("telegram-command-chinese-localization"), "Chinese command localization runtime patch must stay listed");

await fs.access(path.join(repoRoot, "scripts", "VERIFY_RUNTIME_PATCHES.mjs"));
await fs.access(path.join(repoRoot, "scripts", "VERIFY_RUNTIME_PATCHES.ps1"));
await fs.access(path.join(repoRoot, "docs", "PATCH_COMPATIBILITY.md"));

console.log(`runtime patch manifest ok: ${manifest.patches.length} patches`);

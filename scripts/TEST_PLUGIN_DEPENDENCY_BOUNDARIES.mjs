import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const settingsPath = path.join(repoRoot, "config", "imagebot", "settings.json");
const docsPath = path.join(repoRoot, "docs", "BOT_TOOL_SURFACE_AND_DEPENDENCIES.md");
const builtins = new Set(["image", "image_generate", "message"]);
const allowedInfrastructureDeps = new Set(["imagebot-shared", "imagebot-background-jobs"]);

async function readText(relativePath) {
  return await fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function pluginRelativeImports(source) {
  const deps = [];
  const patterns = [
    /from\s+["']\.\.\/([^"']+)["']/g,
    /import\(\s*["']\.\.\/([^"']+)["']\s*\)/g,
    /require\(\s*["']\.\.\/([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const dep = match[1].split(/[\\/]/)[0];
      if (dep.startsWith("imagebot-") || dep === "web-image-search" || dep === "zhihu-openapi") deps.push(dep);
    }
  }
  return [...new Set(deps)];
}

const settings = await readJson(settingsPath);
const doc = await fs.readFile(docsPath, "utf8");
const localPluginIds = settings.localPluginDirs.map((entry) => path.basename(entry));
const manifestTools = new Set();

for (const relDir of settings.localPluginDirs) {
  const pluginId = path.basename(relDir);
  const manifest = await readJson(path.join(repoRoot, relDir, "openclaw.plugin.json"));
  assert.ok(doc.includes(`\`${pluginId}\``), `tool surface doc must mention active plugin ${pluginId}`);
  for (const tool of manifest.contracts?.tools || []) manifestTools.add(tool);

  const indexPath = path.join(repoRoot, relDir, "index.js");
  const source = await fs.readFile(indexPath, "utf8");
  for (const dep of pluginRelativeImports(source)) {
    if (dep === pluginId) continue;
    assert.ok(
      allowedInfrastructureDeps.has(dep),
      `${pluginId} must not directly import business plugin ${dep}; move shared code to imagebot-shared or compose through tools`
    );
  }
}

for (const tool of settings.allowedTools) {
  assert.ok(
    builtins.has(tool) || manifestTools.has(tool),
    `allowed tool is not built-in or manifest-owned: ${tool}`
  );
  assert.ok(doc.includes(`\`${tool}\``), `tool surface doc must mention allowed tool ${tool}`);
}

for (const tool of manifestTools) {
  if (!settings.allowedTools.includes(tool)) {
    assert.ok(doc.includes(`\`${tool}\``), `tool surface doc must mention manifest-only tool ${tool}`);
  }
}

assert.ok(doc.includes("Business plugins must not import each other directly."));
assert.ok(doc.includes("imagebot-background-jobs"));
assert.equal(new Set(localPluginIds).size, localPluginIds.length, "local plugin ids must be unique");

console.log("plugin dependency boundary tests passed", {
  plugins: localPluginIds.length,
  allowedTools: settings.allowedTools.length,
  manifestTools: manifestTools.size
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const settingsPath = path.join(repoRoot, "config", "imagebot", "settings.json");
const pluginsRoot = path.join(repoRoot, "plugins");
const manualsRoot = path.join(repoRoot, "tool_manuals");

const BUILTIN_TOOLS = new Set([
  "image",
  "image_generate",
  "message"
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readMaybe(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function listFiles(dir, predicate = () => true) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function normalizeToolList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function parseManualTools(text) {
  const match = text.match(/^tools:\s*(.+)$/mi);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((item) => item.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

async function collectManualCoverage() {
  const files = await listFiles(manualsRoot, (name) => name.endsWith(".md"));
  const byTool = new Map();
  for (const filePath of files) {
    const text = await fs.readFile(filePath, "utf8");
    for (const tool of parseManualTools(text)) {
      const list = byTool.get(tool) || [];
      list.push(path.relative(repoRoot, filePath).replace(/\\/g, "/"));
      byTool.set(tool, list);
    }
  }
  return byTool;
}

async function collectTestReferences() {
  const files = await listFiles(scriptDir, (name) => /^(TEST_|REPLAY_).+\.mjs$/i.test(name));
  const refs = [];
  for (const filePath of files) {
    refs.push({
      file: path.relative(repoRoot, filePath).replace(/\\/g, "/"),
      text: await fs.readFile(filePath, "utf8")
    });
  }
  return refs;
}

function testFilesForPlugin(pluginId, refs) {
  const needles = [
    `plugins/${pluginId}`,
    `plugins\\${pluginId}`,
    pluginId
  ];
  return refs
    .filter((ref) => needles.some((needle) => ref.text.includes(needle)))
    .map((ref) => ref.file);
}

function issue(list, severity, message, details = {}) {
  list.push({ severity, message, ...details });
}

async function main() {
  const settings = await readJson(settingsPath);
  const allowedTools = new Set(normalizeToolList(settings.allowedTools));
  const allowedPluginIds = new Set(normalizeToolList(settings.allowedPluginIds));
  const localPluginDirs = normalizeToolList(settings.localPluginDirs);
  const manualCoverage = await collectManualCoverage();
  const testRefs = await collectTestReferences();
  const issues = [];
  const warnings = [];
  const pluginReports = [];
  const manifestTools = new Map();

  for (const relDir of localPluginDirs) {
    const pluginDir = path.resolve(repoRoot, relDir);
    const pluginId = path.basename(pluginDir);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const indexPath = path.join(pluginDir, "index.js");
    const exists = await pathExists(pluginDir);
    const manifestExists = await pathExists(manifestPath);
    const indexExists = await pathExists(indexPath);
    const tests = testFilesForPlugin(pluginId, testRefs);
    let manifest = null;
    let tools = [];
    let hooks = [];

    if (!exists) {
      issue(issues, "error", `local plugin directory does not exist: ${relDir}`, { pluginId });
    } else if (!manifestExists) {
      issue(issues, "error", `local plugin has no manifest: ${relDir}`, { pluginId });
    } else {
      manifest = await readJson(manifestPath);
      if (manifest.id !== pluginId) {
        issue(issues, "error", `plugin manifest id does not match directory: ${relDir}`, {
          pluginId,
          manifestId: manifest.id
        });
      }
      tools = normalizeToolList(manifest.contracts?.tools);
      hooks = normalizeToolList(manifest.contracts?.hooks);
      for (const tool of tools) manifestTools.set(tool, pluginId);
    }

    if (!indexExists) issue(issues, "error", `local plugin has no index.js: ${relDir}`, { pluginId });
    if (!allowedPluginIds.has(pluginId)) {
      issue(issues, "error", `local plugin is not in allowedPluginIds: ${pluginId}`, { pluginId });
    }
    if (tests.length === 0) {
      issue(issues, "error", `local plugin has no direct test or replay reference: ${pluginId}`, { pluginId });
    }

    for (const tool of tools) {
      if (!allowedTools.has(tool)) {
        issue(warnings, "warning", `manifest tool is not exposed in allowedTools: ${tool}`, { pluginId, tool });
        continue;
      }
      if (!manualCoverage.has(tool)) {
        issue(issues, "error", `manifest tool has no tool_manuals frontmatter coverage: ${tool}`, { pluginId, tool });
      }
    }

    pluginReports.push({
      pluginId,
      path: relDir,
      manifest: Boolean(manifest),
      tools,
      hooks,
      tests
    });
  }

  for (const tool of allowedTools) {
    if (BUILTIN_TOOLS.has(tool)) continue;
    if (!manifestTools.has(tool)) {
      issue(warnings, "warning", `allowed tool is not owned by a local plugin manifest: ${tool}`, { tool });
    }
  }

  const configuredPluginIds = new Set(localPluginDirs.map((entry) => path.basename(entry)));
  const pluginDirs = await fs.readdir(pluginsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of pluginDirs.filter((item) => item.isDirectory())) {
    if (!configuredPluginIds.has(entry.name)) {
      const manifestText = await readMaybe(path.join(pluginsRoot, entry.name, "openclaw.plugin.json"));
      issue(warnings, "warning", `plugin directory is not configured as a local plugin: ${entry.name}`, {
        pluginId: entry.name,
        helper: !manifestText
      });
    }
  }

  const summary = {
    status: issues.length === 0 ? "ok" : "failed",
    plugins: pluginReports.length,
    tools: manifestTools.size,
    manuals: manualCoverage.size,
    issues,
    warnings,
    pluginReports
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`feature health: ${summary.status} plugins=${summary.plugins} tools=${summary.tools} manuals=${summary.manuals}`);
    for (const item of issues) console.log(`ERROR ${item.message}`);
    for (const item of warnings) console.log(`WARN ${item.message}`);
  }

  assert.equal(issues.length, 0, "feature health checks failed");
}

await main();

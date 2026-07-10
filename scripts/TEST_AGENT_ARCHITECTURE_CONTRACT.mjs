import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const contractPath = path.join(repoRoot, "policy", "agent_architecture_contract.json");
const settingsPath = path.join(repoRoot, "config", "imagebot", "settings.json");

const BUILTIN_TOOLS = new Set(["browser", "image", "image_generate", "message"]);

async function readText(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

function exists(relativePath) {
  return fsSync.existsSync(path.join(repoRoot, relativePath));
}

function parseManualTools(text) {
  const match = text.match(/^tools:\s*(.+)$/mi);
  if (!match) return [];
  return match[1].split(",").map((item) => item.trim().replace(/^`|`$/g, "")).filter(Boolean);
}

async function listManualCoverage() {
  const root = path.join(repoRoot, "tool_manuals");
  const out = new Map();
  for (const name of await fs.readdir(root)) {
    if (!name.endsWith(".md")) continue;
    const relativePath = `tool_manuals/${name}`;
    const text = await readText(relativePath);
    for (const tool of parseManualTools(text)) {
      const current = out.get(tool) || [];
      current.push(relativePath);
      out.set(tool, current);
    }
  }
  return out;
}

async function loadRegisteredTools(settings) {
  const tools = new Map();
  const hooks = [];
  const api = {
    config: {},
    registerTool(tool, meta = {}) {
      tools.set(meta.name || tool.name, tool);
    },
    registerHook(name, fn, meta = {}) {
      hooks.push({ name, meta, fn });
    }
  };
  for (const relDir of settings.localPluginDirs) {
    const indexPath = path.join(repoRoot, relDir, "index.js");
    const mod = await import(pathToFileURL(indexPath).href);
    assert.equal(typeof mod.default?.register, "function", `${relDir} must export default.register`);
    await mod.default.register(api);
  }
  return { tools, hooks };
}

function allParameterDescriptions(schema = {}) {
  const descriptions = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (typeof node.description === "string") descriptions.push(node.description);
    if (node.properties && typeof node.properties === "object") {
      for (const value of Object.values(node.properties)) visit(value);
    }
    if (node.items) visit(node.items);
  }
  visit(schema);
  return descriptions;
}

function actionEnum(tool) {
  return tool?.parameters?.properties?.action?.enum || [];
}

const contract = await readJson("policy/agent_architecture_contract.json");
const settings = await readJson("config/imagebot/settings.json");
const allowedTools = new Set(settings.allowedTools || []);
const manualCoverage = await listManualCoverage();
const { tools, hooks } = await loadRegisteredTools(settings);

for (const relativePath of contract.requiredDocs) {
  assert.ok(exists(relativePath), `required architecture doc is missing: ${relativePath}`);
}

for (const toolName of allowedTools) {
  if (BUILTIN_TOOLS.has(toolName)) continue;
  assert.ok(tools.has(toolName), `allowed tool is not registered by local plugins: ${toolName}`);
  assert.ok(manualCoverage.has(toolName), `allowed tool has no tool manual frontmatter coverage: ${toolName}`);
}

for (const [toolName, tool] of tools) {
  const desc = String(tool.description || "");
  assert.ok(desc.length <= contract.schemaLimits.maxToolDescriptionChars, `${toolName} description is too long for short exposure`);
  const props = tool.parameters?.properties || {};
  assert.ok(Object.keys(props).length <= contract.schemaLimits.maxParameterCount, `${toolName} exposes too many top-level parameters`);
  for (const paramDesc of allParameterDescriptions(tool.parameters)) {
    assert.ok(paramDesc.length <= contract.schemaLimits.maxParameterDescriptionChars, `${toolName} parameter description is too long: ${paramDesc}`);
  }
}

const capabilityDoc = await readText(contract.capabilitySurface.doc);
const capabilityJson = await readJson(contract.capabilitySurface.json);
for (const phrase of contract.capabilitySurface.mustMention) {
  assert.ok(capabilityDoc.includes(phrase), `capability surface doc must mention: ${phrase}`);
}
for (const denied of contract.capabilitySurface.deniedTools) {
  assert.ok(capabilityJson.tooling.explicitlyDenied.includes(denied), `capability surface must explicitly deny ${denied}`);
  assert.ok(!allowedTools.has(denied), `denied tool must not be allowed: ${denied}`);
}

for (const [toolName, spec] of Object.entries(contract.highRiskTools)) {
  assert.ok(tools.has(toolName), `contracted high-risk tool is not registered: ${toolName}`);
  assert.ok(allowedTools.has(toolName), `contracted high-risk tool is not allowed/exposed: ${toolName}`);
  assert.ok(exists(spec.manual), `${toolName} manual is missing: ${spec.manual}`);
  const manualText = await readText(spec.manual);
  assert.ok(parseManualTools(manualText).includes(toolName), `${spec.manual} frontmatter must cover ${toolName}`);
  const source = await readText(`${spec.plugin}/index.js`);
  for (const evidence of spec.sourceEvidence || []) {
    assert.ok(source.includes(evidence) || manualText.includes(evidence), `${toolName} missing evidence: ${evidence}`);
  }
  const enumValues = actionEnum(tools.get(toolName));
  for (const [action, actionSpec] of Object.entries(spec.actions || {})) {
    assert.ok(enumValues.includes(action), `${toolName} schema must expose action ${action}`);
    assert.ok(actionSpec.sideEffect, `${toolName}.${action} must name its real side effect`);
    if (actionSpec.defaultsDryRun) {
      assert.ok(manualText.includes("dryRun:true"), `${toolName}.${action} must document dryRun:true`);
      assert.ok(source.includes("params.dryRun === undefined ? true"), `${toolName}.${action} must default mutation paths to dryRun`);
    }
    if (actionSpec.userAlignedDefaultReal) {
      assert.ok(source.includes("addDefaultsToRealMutation"), `${toolName}.${action} must use the user-aligned add default helper`);
      assert.ok(manualText.includes("runtime sender matches"), `${toolName}.${action} must document the user-aligned add default`);
    }
    for (const key of actionSpec.approvalKeys || []) {
      assert.ok(source.includes(key), `${toolName}.${action} missing approval key in code: ${key}`);
      assert.ok(manualText.includes(key) || source.includes(`${key}"`) || source.includes(`${key}'`), `${toolName}.${action} approval key must be documented or schema-visible: ${key}`);
    }
    if (actionSpec.ownerCheckWhenContextPresent) {
      assert.ok(source.includes("assertOwnerMatchesContext"), `${toolName}.${action} must enforce owner context checks`);
    }
    if (actionSpec.checkpoint) {
      assert.ok(manualText.includes(actionSpec.checkpoint) || source.includes(actionSpec.checkpoint), `${toolName}.${action} missing checkpoint ${actionSpec.checkpoint}`);
    }
  }
}

for (const [toolName, spec] of Object.entries(contract.longTaskTools)) {
  const baseTool = toolName.split(".")[0];
  assert.ok(tools.has(baseTool), `long-task base tool missing: ${baseTool}`);
  if (spec.supportsBackground) {
    const tool = tools.get(baseTool);
    const props = tool.parameters?.properties || {};
    assert.ok("background" in props || "async" in props || toolName.includes("."), `${toolName} must expose background/async parameters`);
  }
  if (spec.checkpoint) {
    const source = await readText(`plugins/${baseTool === "script_action" ? "imagebot-creative-ops" : "imagebot-background-jobs"}/index.js`);
    assert.ok(source.includes(spec.checkpoint), `${toolName} must persist checkpoint ${spec.checkpoint}`);
  }
}

const retrySource = await readText(contract.retryPolicy.backgroundQueueSource);
assert.equal(contract.retryPolicy.defaultAttempts, 1, "background work must default to one attempt");
assert.equal(contract.retryPolicy.mutationAutoRetry, false, "mutating jobs must not retry implicitly");
assert.ok(contract.retryPolicy.idempotentMaxAttempts <= 3, "idempotent retries must stay bounded");
for (const evidence of contract.retryPolicy.sourceEvidence) {
  assert.ok(retrySource.includes(evidence), `background retry policy missing evidence: ${evidence}`);
}

const memoryDoc = await readText(contract.memory.doc);
const memoryManual = await readText(contract.memory.manual);
for (const phrase of contract.memory.mustMention) {
  assert.ok(memoryDoc.includes(phrase) || memoryManual.includes(phrase), `memory contract missing phrase: ${phrase}`);
}
for (const layer of contract.memory.taxonomy) {
  assert.ok(memoryDoc.toLowerCase().includes(layer), `memory architecture must name ${layer} memory`);
}
const memoryTool = tools.get(contract.memory.tool);
assert.ok(memoryTool, "memory_search tool must be registered");
for (const mode of ["hybrid", "semantic", "keyword"]) {
  assert.ok(memoryTool.parameters.properties.mode.enum.includes(mode), `memory_search must expose ${mode} mode`);
}

const browserPrompt = await readText(contract.browserBoundary.prompt);
const browserBoundaryTexts = [browserPrompt];
for (const manual of contract.browserBoundary.manuals) browserBoundaryTexts.push(await readText(manual));
const browserJoined = browserBoundaryTexts.join("\n");
for (const phrase of contract.browserBoundary.mustMention) {
  assert.ok(browserJoined.includes(phrase), `browser/account boundary missing phrase: ${phrase}`);
}

for (const toolName of contract.traceEval.requiredTools) {
  assert.ok(allowedTools.has(toolName), `trace/eval required tool is not allowed: ${toolName}`);
  assert.ok(tools.has(toolName), `trace/eval required tool is not registered: ${toolName}`);
}
for (const relativePath of contract.traceEval.requiredTests) {
  assert.ok(exists(relativePath), `trace/eval required test missing: ${relativePath}`);
}
for (const relativePath of contract.traceEval.requiredReplays) {
  assert.ok(exists(relativePath), `trace/eval required replay asset missing: ${relativePath}`);
}
assert.ok(hooks.some((hook) => hook.name === "before_tool_call"), "turn observer/failure memory must have before_tool_call hook coverage");
assert.ok(hooks.some((hook) => hook.name === "after_tool_call"), "turn observer/failure memory must have after_tool_call hook coverage");

console.log("agent architecture contract tests passed", {
  tools: tools.size,
  hooks: hooks.length,
  highRiskTools: Object.keys(contract.highRiskTools).length
});

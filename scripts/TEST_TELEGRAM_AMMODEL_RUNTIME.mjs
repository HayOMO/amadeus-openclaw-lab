import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { resolveOpenClawDistDir } from "./OPENCLAW_RUNTIME_PATHS.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const distDir = resolveOpenClawDistDir();

async function readDistFile(prefix, requiredMarker) {
  const names = await fsp.readdir(distDir);
  for (const name of names.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".js")).sort()) {
    const filePath = path.join(distDir, name);
    const source = await fsp.readFile(filePath, "utf8");
    if (!requiredMarker || source.includes(requiredMarker)) return { name, source, filePath };
  }
  throw new Error(`No dist file found for ${prefix} with marker ${requiredMarker || "(none)"}`);
}

function extractFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function not found: ${name}`);
  const declarationStart = source.slice(start - 6, start) === "async " ? start - 6 : start;
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `function has no body: ${name}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(declarationStart, index + 1);
    }
  }
  throw new Error(`function body did not close: ${name}`);
}

function flattenButtons(keyboard) {
  return (keyboard?.inline_keyboard ?? []).flat();
}

function callbacks(keyboard) {
  return flattenButtons(keyboard).map((button) => button.callback_data);
}

function plain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const bot = await readDistFile("bot-", "buildTelegramImagebotAmmodelKeyboard");
const modelOverrides = await readDistFile("model-overrides-", "applyModelOverrideToSessionEntry");
const { t: applyModelOverrideToSessionEntry } = await import(pathToFileURL(modelOverrides.filePath).href);
const projectCatalog = JSON.parse(await fsp.readFile(path.join(repoRoot, "scripts", "IMAGEBOT_MODEL_PROFILES.json"), "utf8"));
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), "imagebot-codex-models-"));
await fsp.writeFile(path.join(codexHome, "models_cache.json"), `${JSON.stringify({
  fetched_at: "2026-07-10T00:00:00Z",
  models: [
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", visibility: "list", supported_in_api: true, input_modalities: ["text", "image"], supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })) },
    { slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", visibility: "list", supported_in_api: true, input_modalities: ["text", "image"], supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort })) },
    { slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", visibility: "list", supported_in_api: true, input_modalities: ["text", "image"], supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort })) },
    { slug: "gpt-5.5", display_name: "Runtime label must not replace curated label", visibility: "list", supported_in_api: true, input_modalities: ["text", "image"], supported_reasoning_levels: ["minimal", "low", "medium", "high", "xhigh"].map((effort) => ({ effort })) },
    { slug: "gpt-5.4-pro", display_name: "Generic API model", visibility: "list", supported_in_api: false, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }] },
    { slug: "gpt-5.3-codex-spark", display_name: "Unsupported backend model", visibility: "list", supported_in_api: false, input_modalities: ["text"], supported_reasoning_levels: [{ effort: "off" }] },
    { slug: "gpt-hidden", display_name: "Hidden Codex model", visibility: "hide", supported_in_api: true, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }] }
  ]
}, null, 2)}\n`, "utf8");

const context = {
  console,
  assert,
  fs,
  path,
  Date,
  process: { env: { CODEX_HOME: codexHome } },
  __projectCatalog: JSON.parse(JSON.stringify(projectCatalog)),
  __sessions: {},
  __sessionWrites: [],
  __defaultStateWrites: [],
  __defaultStates: {},
  __sessionStores: {},
  __sessionStoreWrites: [],
  __defaultModel: { provider: "openai", model: "gpt-5.4-mini" },
  applyModelOverrideToSessionEntry,
};

vm.createContext(context);
vm.runInContext(`
function cloneForTest(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
function normalizeOptionalString(value) {
  if (value === null || value === undefined) return undefined;
  return String(value);
}
function normalizeLowercaseStringOrEmpty(value) {
  return (normalizeOptionalString(value)?.trim() || "").toLowerCase();
}
function buildInlineKeyboard(rows) {
  return { inline_keyboard: rows };
}
function resolveStorePath(store, opts = {}) {
  return String(store || "sessions.json") + "::" + String(opts.agentId || "");
}
function resolveDefaultModelForAgent() {
  return globalThis.__defaultModel;
}
function readTelegramImagebotAmmodelDefaultState(_cfg, agentId) {
  return cloneForTest(globalThis.__defaultStates[agentId] || {});
}
function readTelegramImagebotSessionStoreSync(storePath) {
  return cloneForTest(globalThis.__sessionStores[storePath] || {});
}
function writeTelegramImagebotSessionStoreSync(storePath, store) {
  globalThis.__sessionStores[storePath] = cloneForTest(store);
  globalThis.__sessionStoreWrites.push({ storePath, store: cloneForTest(store) });
}
async function updateSessionStoreEntry(params) {
  globalThis.__lastUpdateParams = {
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    requireWriteSuccess: params.requireWriteSuccess
  };
  const currentEntry = globalThis.__sessions[params.sessionKey];
  const updated = await params.update(currentEntry && typeof currentEntry === "object" ? currentEntry : {});
  globalThis.__sessions[params.sessionKey] = updated;
  globalThis.__sessionWrites.push({ sessionKey: params.sessionKey, entry: cloneForTest(updated) });
  return updated;
}
function writeTelegramImagebotAmmodelDefaultState(_cfg, agentId, state) {
  globalThis.__defaultStateWrites.push({ agentId, state: cloneForTest(state) });
}
function resolveDefaultAgentId() {
  return "imagebot";
}
function resolveAgentDir(_cfg, agentId) {
  return "agent-dir::" + agentId;
}
const TELEGRAM_IMAGEBOT_AMMODEL_MODELS = globalThis.__projectCatalog.models;
const TELEGRAM_IMAGEBOT_AMMODEL_PROFILES = globalThis.__projectCatalog.profiles;
const TELEGRAM_IMAGEBOT_AMMODEL_REASONING_LEVELS = globalThis.__projectCatalog.reasoningEfforts;
${extractFunctionSource(bot.source, "splitTelegramImagebotAmmodelRef")}
${extractFunctionSource(bot.source, "getTelegramImagebotAmmodelModels")}
${extractFunctionSource(bot.source, "findTelegramImagebotAmmodelModel")}
${extractFunctionSource(bot.source, "getTelegramImagebotAmmodelReasoningForModel")}
${extractFunctionSource(bot.source, "chunkTelegramImagebotAmmodelButtons")}
${extractFunctionSource(bot.source, "buildTelegramImagebotAmmodelKeyboard")}
${extractFunctionSource(bot.source, "loadTelegramImagebotAmmodelCatalog")}
${extractFunctionSource(bot.source, "applyTelegramImagebotAmmodelSession")}
${extractFunctionSource(bot.source, "applyTelegramImagebotAmmodelDefaultToSessionSync")}
${extractFunctionSource(bot.source, "parseTelegramImagebotAmmodelArgs")}
globalThis.__ammodelRuntime = {
  splitTelegramImagebotAmmodelRef,
  getTelegramImagebotAmmodelModels,
  findTelegramImagebotAmmodelModel,
  getTelegramImagebotAmmodelReasoningForModel,
  buildTelegramImagebotAmmodelKeyboard,
  loadTelegramImagebotAmmodelCatalog,
  applyTelegramImagebotAmmodelSession,
  applyTelegramImagebotAmmodelDefaultToSessionSync,
  parseTelegramImagebotAmmodelArgs,
  setSessionEntry: (key, entry) => {
    globalThis.__sessions[key] = cloneForTest(entry);
  },
  getSessionEntry: (key) => cloneForTest(globalThis.__sessions[key]),
  setDefaultModel: (model) => {
    globalThis.__defaultModel = cloneForTest(model);
  },
  setDefaultState: (agentId, state) => {
    globalThis.__defaultStates[agentId] = cloneForTest(state);
  },
  setSessionStore: (storePath, store) => {
    globalThis.__sessionStores[storePath] = cloneForTest(store);
  },
  getSessionStore: (storePath) => cloneForTest(globalThis.__sessionStores[storePath]),
  clearSessionStoreWrites: () => {
    globalThis.__sessionStoreWrites = [];
  },
  getSessionStoreWrites: () => cloneForTest(globalThis.__sessionStoreWrites),
  clearDefaultStateWrites: () => {
    globalThis.__defaultStateWrites = [];
  },
  getDefaultStateWrites: () => cloneForTest(globalThis.__defaultStateWrites),
  getSessionWrites: () => cloneForTest(globalThis.__sessionWrites),
  getLastUpdateParams: () => cloneForTest(globalThis.__lastUpdateParams)
};
`, context);

const runtime = context.__ammodelRuntime;
const catalog = await runtime.loadTelegramImagebotAmmodelCatalog({
  plugins: {
    entries: {
      "imagebot-creative-ops": {
        config: { repoRoot },
      },
    },
  },
}, "imagebot");

assert.equal(
  catalog.models.find((model) => model.id === "openai/gpt-5.6-sol")?.enabled,
  true,
  "project /ammodel catalog must load the signed-in account's GPT-5.6 Codex model",
);
for (const id of ["openai/gpt-5.6-terra", "openai/gpt-5.6-luna"]) {
  assert.deepEqual(plain(catalog.models.find((model) => model.id === id)?.nativeCapabilities), ["text", "vision"], `${id} must carry verified native vision into /ammodel`);
}
assert.equal(catalog.models.some((model) => model.id === "openai/gpt-5.3-codex-spark"), false, "Codex models unsupported by the backend API must stay out of /ammodel");
assert.equal(catalog.models.find((model) => model.id === "openai/gpt-5.5")?.label, "GPT-5.5", "curated metadata should override a matching live Codex label");
assert.equal(catalog.models.some((model) => model.id === "openai/gpt-5.4-pro"), false, "generic OpenAI API catalog models must not leak into /ammodel");
assert.equal(catalog.models.some((model) => model.id === "deepseek/deepseek-reasoner"), false, "DeepSeek provider discovery must remain disabled");
assert.equal(catalog.models.some((model) => model.id === "openai/gpt-hidden"), false, "hidden Codex models must stay hidden");
assert.ok(catalog.models.some((model) => model.id === "deepseek/deepseek-v4-pro"), "exact curated DeepSeek fallbacks should remain available");
assert.deepEqual(
  plain(runtime.getTelegramImagebotAmmodelReasoningForModel(catalog, "openai/gpt-5.6-sol")),
  ["low", "medium", "high", "xhigh", "max"],
  "Codex reasoning levels should use the live model/list response while filtering unsupported ultra",
);
assert.deepEqual(
  plain(runtime.getTelegramImagebotAmmodelReasoningForModel(catalog, "openai/gpt-5.5")),
  ["minimal", "low", "medium", "high", "xhigh"],
  "GPT-5.5 reasoning menu must use the OpenAI levels from the project catalog",
);
assert.deepEqual(
  plain(runtime.getTelegramImagebotAmmodelReasoningForModel(catalog, "deepseek/deepseek-v4-pro")),
  ["off", "high", "max"],
  "DeepSeek Pro reasoning menu must stay limited to supported DeepSeek levels",
);

const modelKeyboard = runtime.buildTelegramImagebotAmmodelKeyboard(catalog, "models");
const modelCallbacks = callbacks(modelKeyboard);
assert.ok(
  modelCallbacks.includes("/ammodel model openai/gpt-5.6-sol"),
  "first-level model menu must include the live GPT-5.6 Codex model",
);
for (const id of ["openai/gpt-5.6-terra", "openai/gpt-5.6-luna"]) {
  assert.ok(modelCallbacks.includes(`/ammodel model ${id}`), `first-level model menu must include ${id}`);
}
assert.ok(!modelCallbacks.includes("/ammodel model openai/gpt-5.4-pro"), "first-level model menu must exclude generic OpenAI API catalog models");
assert.ok(!modelCallbacks.includes("/ammodel model deepseek/deepseek-reasoner"), "first-level model menu must exclude dynamically discovered DeepSeek models");
assert.ok(
  !modelCallbacks.some((callback) => /\bthink\b/.test(callback)),
  "first-level model menu must not one-tap switch reasoning levels",
);
assert.ok(
  !modelCallbacks.some((callback) => callback.startsWith("/ammodel profile ")),
  "first-level model menu must not expose legacy profile callbacks",
);
assert.ok(modelCallbacks.includes("/ammodel status"), "first-level menu must keep status reachable");

const gpt55Keyboard = runtime.buildTelegramImagebotAmmodelKeyboard(catalog, "model", "openai/gpt-5.5");
const gpt55Callbacks = callbacks(gpt55Keyboard);
assert.deepEqual(
  plain(gpt55Callbacks.filter((callback) => callback.startsWith("/ammodel model openai/gpt-5.5 think "))),
  [
    "/ammodel model openai/gpt-5.5 think minimal",
    "/ammodel model openai/gpt-5.5 think low",
    "/ammodel model openai/gpt-5.5 think medium",
    "/ammodel model openai/gpt-5.5 think high",
    "/ammodel model openai/gpt-5.5 think xhigh",
  ],
  "second-level GPT-5.5 menu must expose every supported reasoning level",
);
assert.ok(gpt55Callbacks.includes("/ammodel models"), "second-level model menu must keep a back button");
assert.ok(gpt55Callbacks.includes("/ammodel status"), "second-level model menu must keep status reachable");

const deepseekKeyboard = runtime.buildTelegramImagebotAmmodelKeyboard(catalog, "model", "deepseek/deepseek-v4-pro");
assert.deepEqual(
  plain(callbacks(deepseekKeyboard).filter((callback) => callback.startsWith("/ammodel model deepseek/deepseek-v4-pro think "))),
  [
    "/ammodel model deepseek/deepseek-v4-pro think off",
    "/ammodel model deepseek/deepseek-v4-pro think high",
    "/ammodel model deepseek/deepseek-v4-pro think max",
  ],
  "DeepSeek second-level menu must not inherit unsupported OpenAI reasoning levels",
);

const parsedModelOnly = runtime.parseTelegramImagebotAmmodelArgs("model openai/gpt-5.5", catalog);
assert.equal(parsedModelOnly.action, "model");
assert.equal(parsedModelOnly.model.id, "openai/gpt-5.5");

const parsedDiscoveredModel = runtime.parseTelegramImagebotAmmodelArgs("model openai/gpt-5.6-sol", catalog);
assert.equal(parsedDiscoveredModel.action, "model");
assert.equal(parsedDiscoveredModel.model.id, "openai/gpt-5.6-sol");

const parsedModelThink = runtime.parseTelegramImagebotAmmodelArgs("model openai/gpt-5.5 think medium", catalog);
assert.equal(parsedModelThink.action, "model_think");
assert.equal(parsedModelThink.model.id, "openai/gpt-5.5");
assert.equal(parsedModelThink.level, "medium");

const parsedThinkOnly = runtime.parseTelegramImagebotAmmodelArgs("think high", catalog);
assert.deepEqual(plain(parsedThinkOnly), { action: "think", level: "high" });

const parsedBalanced = runtime.parseTelegramImagebotAmmodelArgs("balanced", catalog);
assert.equal(parsedBalanced.action, "profile");
assert.equal(parsedBalanced.profile.model, "openai/gpt-5.6-sol");
assert.equal(parsedBalanced.profile.reasoningEffort, "medium");

runtime.setDefaultModel({ provider: "openai", model: "gpt-5.4-mini" });
runtime.setSessionEntry("session-gpt", {
  modelProvider: "openai",
  model: "gpt-5.3-codex-spark",
  thinkingLevel: "off",
  contextTokens: 123,
  contextBudgetStatus: "near",
});
runtime.clearDefaultStateWrites();
await runtime.applyTelegramImagebotAmmodelSession({
  cfg: { session: { store: "sessions.json" } },
  agentId: "imagebot",
  sessionKey: "session-gpt",
  profile: { id: "custom-openai/gpt-5.5", model: "openai/gpt-5.5" },
  reasoningEffort: "medium",
});

const gptSession = runtime.getSessionEntry("session-gpt");
assert.equal(gptSession.providerOverride, "openai");
assert.equal(gptSession.modelOverride, "gpt-5.5");
assert.equal(gptSession.modelOverrideSource, "default");
assert.equal(gptSession.modelProvider, undefined, "stale runtime provider must be cleared after model switch");
assert.equal(gptSession.model, undefined, "stale runtime model must be cleared after model switch");
assert.equal(gptSession.contextTokens, undefined, "stale token metadata must be cleared after model switch");
assert.equal(gptSession.contextBudgetStatus, undefined, "stale budget metadata must be cleared after model switch");
assert.equal(gptSession.thinkingLevel, "medium");
assert.equal(gptSession.liveModelSwitchPending, true);
assert.equal(typeof gptSession.updatedAt, "number");
assert.deepEqual(plain(runtime.getLastUpdateParams()), {
  storePath: "sessions.json::imagebot",
  sessionKey: "session-gpt",
  requireWriteSuccess: true,
});
assert.deepEqual(plain(runtime.getDefaultStateWrites().at(-1)), {
  agentId: "imagebot",
  state: {
    profile: "custom-openai/gpt-5.5",
    model: "openai/gpt-5.5",
    reasoningEffort: "medium",
    textVerbosity: "",
    source: "telegram:/ammodel",
  },
});

runtime.setSessionEntry("session-ds", {
  providerOverride: "deepseek",
  modelOverride: "deepseek-v4-pro",
  thinkingLevel: "high",
});
runtime.clearDefaultStateWrites();
await runtime.applyTelegramImagebotAmmodelSession({
  cfg: { session: { store: "sessions.json" } },
  agentId: "imagebot",
  sessionKey: "session-ds",
  reasoningEffort: "max",
});

const dsSession = runtime.getSessionEntry("session-ds");
assert.equal(dsSession.providerOverride, "deepseek");
assert.equal(dsSession.modelOverride, "deepseek-v4-pro");
assert.equal(dsSession.thinkingLevel, "max");
assert.equal(dsSession.liveModelSwitchPending, true);
assert.deepEqual(plain(runtime.getDefaultStateWrites().at(-1)), {
  agentId: "imagebot",
  state: {
    profile: "custom",
    model: "deepseek/deepseek-v4-pro",
    reasoningEffort: "max",
    textVerbosity: "",
    source: "telegram:/ammodel",
  },
});

const defaultStorePath = "sessions.json::imagebot";
runtime.setDefaultModel({ provider: "openai", model: "gpt-5.4-mini" });
runtime.setDefaultState("imagebot", {
  model: "openai/gpt-5.5",
  reasoningEffort: "medium",
});
runtime.setSessionStore(defaultStorePath, {
  unchanged: {
    providerOverride: "openai",
    modelOverride: "gpt-5.5",
    modelOverrideSource: "default",
    thinkingLevel: "medium",
  },
  changed: {
    providerOverride: "openai",
    modelOverride: "gpt-5.4-mini",
    modelOverrideSource: "default",
    thinkingLevel: "low",
  },
  legacyUserSource: {
    providerOverride: "openai",
    modelOverride: "gpt-5.5",
    modelOverrideSource: "user",
    thinkingLevel: "medium",
  },
});
runtime.clearSessionStoreWrites();
assert.equal(runtime.applyTelegramImagebotAmmodelDefaultToSessionSync({
  cfg: { session: { store: "sessions.json" } },
  agentId: "imagebot",
  sessionKey: "unchanged",
}), false, "unchanged default sync must be a no-op");
assert.deepEqual(plain(runtime.getSessionStoreWrites()), [], "unchanged default sync must not rewrite the session store");

assert.equal(runtime.applyTelegramImagebotAmmodelDefaultToSessionSync({
  cfg: { session: { store: "sessions.json" } },
  agentId: "imagebot",
  sessionKey: "changed",
}), true, "changed default sync must update the session store");
const changedStore = runtime.getSessionStore(defaultStorePath);
assert.equal(changedStore.changed.providerOverride, "openai");
assert.equal(changedStore.changed.modelOverride, "gpt-5.5");
assert.equal(changedStore.changed.modelOverrideSource, "default");
assert.equal(changedStore.changed.thinkingLevel, "medium");
assert.equal(changedStore.changed.liveModelSwitchPending, true);
assert.equal(runtime.getSessionStoreWrites().length, 1);

runtime.clearSessionStoreWrites();
assert.equal(runtime.applyTelegramImagebotAmmodelDefaultToSessionSync({
  cfg: { session: { store: "sessions.json" } },
  agentId: "imagebot",
  sessionKey: "legacyUserSource",
}), true, "legacy user-sourced default mirrors must migrate to fallback-capable defaults");
const migratedStore = runtime.getSessionStore(defaultStorePath);
assert.equal(migratedStore.legacyUserSource.providerOverride, "openai");
assert.equal(migratedStore.legacyUserSource.modelOverride, "gpt-5.5");
assert.equal(migratedStore.legacyUserSource.modelOverrideSource, "default");
assert.equal(runtime.getSessionStoreWrites().length, 1);

await fsp.rm(codexHome, { recursive: true, force: true });

console.log("telegram /ammodel runtime behavior tests passed", {
  bot: bot.name,
  modelOverrides: modelOverrides.name,
});

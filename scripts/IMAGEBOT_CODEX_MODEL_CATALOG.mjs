import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MODEL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export function resolveCodexModelsCachePath(env = process.env) {
  const override = String(env.IMAGEBOT_CODEX_MODELS_CACHE_FILE || "").trim();
  if (override) return path.resolve(override);
  const codexHome = String(env.CODEX_HOME || "").trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "models_cache.json");
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))];
}

function normalizeReasoningEfforts(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item?.effort || item?.reasoningEffort || item || "").trim().toLowerCase())
    .filter(Boolean))];
}

export function normalizeCodexModelsCache(value) {
  const models = Array.isArray(value?.models) ? value.models : [];
  return models.map((model) => {
    const slug = String(model?.slug || model?.model || model?.id || "").trim();
    const inputModalities = normalizeStringList(model?.input_modalities ?? model?.inputModalities);
    const supportsSearchTool = model?.supports_search_tool === true || model?.supportsSearchTool === true;
    const webSearchToolType = String(model?.web_search_tool_type || model?.webSearchToolType || "").trim().toLowerCase();
    if (!MODEL_ID_PATTERN.test(slug)) return null;
    if (String(model?.visibility || "").trim().toLowerCase() !== "list") return null;
    if (model?.supported_in_api !== true && model?.supportedInApi !== true) return null;
    if (!inputModalities.includes("text")) return null;
    const nativeCapabilities = inputModalities.map((item) => item === "image" ? "vision" : item);
    if (supportsSearchTool) nativeCapabilities.push("hosted_search");
    return {
      id: `openai/${slug}`,
      model: slug,
      label: String(model?.display_name || model?.displayName || slug).trim() || slug,
      provider: "openai",
      enabled: true,
      reasoningEfforts: normalizeReasoningEfforts(model?.supported_reasoning_levels ?? model?.supportedReasoningEfforts),
      defaultReasoningEffort: String(model?.default_reasoning_level || model?.defaultReasoningEffort || "").trim().toLowerCase(),
      inputModalities,
      nativeCapabilities,
      supportsSearchTool,
      webSearchToolType,
      ...(supportsSearchTool ? {
        nativeSearch: {
          protocol: "openai-chatgpt-responses-web-search",
          resultModalities: webSearchToolType === "text_and_image" ? ["text", "image"] : ["text"],
          source: "codex-models-cache"
        }
      } : {}),
      capabilitySource: "codex-models-cache"
    };
  }).filter(Boolean);
}

export async function readCodexModelCatalog({ env = process.env } = {}) {
  const cachePath = resolveCodexModelsCachePath(env);
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8"));
    return {
      source: "codex-models-cache",
      fetchedAt: String(parsed?.fetched_at || ""),
      models: normalizeCodexModelsCache(parsed)
    };
  } catch {
    return {
      source: "curated-fallback",
      fetchedAt: "",
      models: []
    };
  }
}

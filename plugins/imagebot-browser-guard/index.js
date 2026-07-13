import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerLifecycleHook } from "../imagebot-shared/openclaw-lifecycle-hooks.mjs";
import { mediaReferenceToLocalPath } from "../imagebot-shared/media-uri.mjs";
import { openclawStatePath } from "../imagebot-shared/openclaw-paths.mjs";

const DEFAULT_ALLOWED_PROFILES = ["bot", "isolated"];
const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/;
const UNC_PATH_RE = /^\\\\/;
const MAX_STAGED_UPLOAD_BYTES = 120 * 1024 * 1024;
const browserTargetAliases = new Map();
const browserTargetProfiles = new Map();

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeProfileName(value) {
  return normalizeString(value).toLowerCase();
}

function sessionAliasKey(event, ctx) {
  return String(ctx?.sessionKey || event?.sessionKey || ctx?.runId || event?.runId || "__global");
}

function normalizeAllowedProfiles(config) {
  const raw = Array.isArray(config?.allowedProfiles) ? config.allowedProfiles : DEFAULT_ALLOWED_PROFILES;
  const normalized = raw
    .map((entry) => normalizeProfileName(entry))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : [...DEFAULT_ALLOWED_PROFILES];
}

function normalizeAbsolutePath(value) {
  const raw = normalizeString(value);
  if (!raw) return "";
  const expanded = raw.startsWith("~\\") || raw.startsWith("~/")
    ? path.join(os.homedir(), raw.slice(2))
    : raw === "~"
      ? os.homedir()
      : raw;
  return path.resolve(expanded).replace(/\//g, "\\").toLowerCase();
}

function localPathFromUploadValue(raw) {
  const value = normalizeString(raw);
  if (!value) return "";
  if (value.toLowerCase().startsWith("file://")) return decodeURIComponent(value.replace(/^file:\/\//i, ""));
  return value;
}

function defaultAllowedPathPrefixes() {
  return [
    openclawStatePath("media")
  ];
}

function normalizeAllowedPathPrefixes(config) {
  const raw = Array.isArray(config?.allowedPathPrefixes) && config.allowedPathPrefixes.length > 0
    ? config.allowedPathPrefixes
    : defaultAllowedPathPrefixes();
  return raw
    .map((entry) => normalizeAbsolutePath(entry))
    .filter(Boolean);
}

function uploadStagingDir(config) {
  const configured = normalizeString(config?.uploadStagingDir);
  return normalizeAbsolutePath(configured || openclawStatePath("media", "inbound"));
}

function mergeUniqueStringArrays(...values) {
  const merged = [];
  const seen = new Set();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const normalized = normalizeString(item);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(normalized);
    }
  }
  return merged;
}

function effectivePluginConfig(apiConfig, contextConfig) {
  const base = isRecord(apiConfig) ? apiConfig : {};
  const context = isRecord(contextConfig) ? contextConfig : {};
  return {
    ...base,
    ...context,
    allowedProfiles: mergeUniqueStringArrays(base.allowedProfiles, context.allowedProfiles),
    allowedPathPrefixes: mergeUniqueStringArrays(base.allowedPathPrefixes, context.allowedPathPrefixes)
  };
}

function collectStringValues(value, found = []) {
  if (typeof value === "string") {
    found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, found);
    return found;
  }
  if (!isRecord(value)) return found;
  for (const item of Object.values(value)) collectStringValues(item, found);
  return found;
}

function isLocalPathLike(raw) {
  const value = normalizeString(raw);
  return WINDOWS_PATH_RE.test(value) || UNC_PATH_RE.test(value) || value.toLowerCase().startsWith("file://");
}

function isAllowedLocalPath(raw, allowedRoots) {
  const normalized = normalizeAbsolutePath(localPathFromUploadValue(raw));
  return allowedRoots.some((root) => normalized === root || normalized.startsWith(`${root}\\`));
}

function isDirectChildOfRoot(raw, root) {
  const normalized = normalizeAbsolutePath(localPathFromUploadValue(raw));
  return path.dirname(normalized) === root;
}

function safeUploadName(sourcePath) {
  const ext = path.extname(sourcePath).slice(0, 16);
  const base = path.basename(sourcePath, path.extname(sourcePath))
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .slice(0, 48) || "upload";
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${base}${ext}`;
}

async function stageBrowserUploadPaths(params, allowedRoots, stagingRoot, mediaConfig = {}) {
  if (!isRecord(params) || normalizeString(params.action).toLowerCase() !== "upload") return params;
  if (!Array.isArray(params.paths)) return params;

  const stagedPaths = [];
  for (const item of params.paths) {
    const uploadValue = typeof item === "string" ? mediaReferenceToLocalPath(item, mediaConfig) : item;
    if (typeof uploadValue !== "string" || !isLocalPathLike(uploadValue) || isDirectChildOfRoot(uploadValue, stagingRoot)) {
      stagedPaths.push(uploadValue);
      continue;
    }
    if (!isAllowedLocalPath(uploadValue, allowedRoots)) {
      stagedPaths.push(item);
      continue;
    }
    const source = localPathFromUploadValue(uploadValue);
    const stat = await fs.stat(source);
    if (!stat.isFile()) throw new Error("browser upload source is not a file");
    if (stat.size > MAX_STAGED_UPLOAD_BYTES) throw new Error("browser upload source is too large to stage");
    await fs.mkdir(stagingRoot, { recursive: true });
    const staged = path.join(stagingRoot, safeUploadName(source));
    await fs.copyFile(source, staged);
    stagedPaths.push(staged);
  }
  const adjusted = { ...params, paths: stagedPaths };
  if (!normalizeString(adjusted.selector) && (normalizeString(adjusted.inputRef) || normalizeString(adjusted.ref))) {
    delete adjusted.inputRef;
    delete adjusted.ref;
    adjusted.selector = "input[type=file]";
  }
  return adjusted;
}

function rewriteBrowserTargetAliases(params, aliasMap) {
  if (!isRecord(params) || !aliasMap?.size) return params;
  const targetId = normalizeString(params.targetId);
  if (!targetId || !aliasMap.has(targetId)) return params;
  return { ...params, targetId: aliasMap.get(targetId) };
}

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractResultObjects(result, found = []) {
  const parsed = parseJsonMaybe(result);
  if (!parsed) return found;
  found.push(parsed);
  if (Array.isArray(parsed?.content)) {
    for (const item of parsed.content) {
      if (typeof item?.text === "string") extractResultObjects(item.text, found);
    }
  }
  if (isRecord(parsed?.details)) found.push(parsed.details);
  return found;
}

function rememberBrowserTargetAliases(event, ctx) {
  if (event?.toolName !== "browser" || event?.error) return;
  const key = sessionAliasKey(event, ctx);
  const aliasMap = browserTargetAliases.get(key) || new Map();
  const profileMap = browserTargetProfiles.get(key) || new Map();
  const profile = normalizeProfileName(event?.params?.profile);
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    const targetId = normalizeString(value.targetId);
    if (targetId && profile) profileMap.set(targetId, profile);
    for (const aliasKey of ["tabId", "suggestedTargetId"]) {
      const alias = normalizeString(value[aliasKey]);
      if (targetId && alias && alias !== targetId) aliasMap.set(alias, targetId);
      if (alias && profile) profileMap.set(alias, profile);
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const object of extractResultObjects(event.result)) visit(object);
  if (aliasMap.size > 0) browserTargetAliases.set(key, aliasMap);
  if (profileMap.size > 0) browserTargetProfiles.set(key, profileMap);
}

async function findUnsafeLocalPaths(params, allowedRoots) {
  const strings = collectStringValues(params);
  const violations = [];
  for (const raw of strings) {
    const value = normalizeString(raw);
    if (!value) continue;
    if (isLocalPathLike(value)) {
      if (!isAllowedLocalPath(value, allowedRoots)) violations.push("local-path:outside-openclaw-media");
    }
  }
  return violations;
}

function withDefaultProfile(params, defaultProfile) {
  if (!isRecord(params)) return { profile: defaultProfile };
  if (typeof params.profile === "string" && normalizeProfileName(params.profile)) return params;
  return {
    ...params,
    profile: defaultProfile
  };
}

function browserUrl(params) {
  return normalizeString(params?.targetUrl || params?.url);
}

function isGoogleUrl(raw) {
  const value = normalizeString(raw);
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return /^(?:[^.]+\.)*google\.[a-z.]+$/i.test(hostname);
  } catch {
    return false;
  }
}

function enforceSearchProfile(params, defaultProfile) {
  if (!isRecord(params)) return params;
  if (normalizeProfileName(params.profile) !== "isolated") return params;
  if (!isGoogleUrl(browserUrl(params))) return params;
  return { ...params, profile: defaultProfile };
}

export default {
  id: "imagebot-browser-guard",
  name: "Imagebot Browser Guard",
  description: "Uses the Bot-owned browser by default, permits an isolated profile, and blocks ordinary user-browser sessions.",
  register(api) {
    registerLifecycleHook(api, "before_tool_call", async (event, ctx) => {
      if (event.toolName !== "browser") return;

      const pluginConfig = effectivePluginConfig(api.config, event?.context?.pluginConfig);
      const allowedProfiles = normalizeAllowedProfiles(pluginConfig);
      const allowedRoots = normalizeAllowedPathPrefixes(pluginConfig);
      const stagingRoot = uploadStagingDir(pluginConfig);
      const requestedProfile = normalizeProfileName(event?.params?.profile);
      if (requestedProfile && !allowedProfiles.includes(requestedProfile)) {
        return {
          block: true,
          blockReason: `browser profile is not allowed for imagebot: ${requestedProfile}`
        };
      }

      const stateKey = sessionAliasKey(event, ctx);
      const aliasMap = browserTargetAliases.get(stateKey);
      const profileMap = browserTargetProfiles.get(stateKey);
      const targetProfile = profileMap?.get(normalizeString(event?.params?.targetId));
      const adjustedParams = await stageBrowserUploadPaths(
        rewriteBrowserTargetAliases(
          enforceSearchProfile(withDefaultProfile(event.params, targetProfile || allowedProfiles[0]), allowedProfiles[0]),
          aliasMap
        ),
        allowedRoots,
        stagingRoot,
        pluginConfig
      );
      const violations = await findUnsafeLocalPaths(adjustedParams, allowedRoots);
      if (violations.length > 0) {
        return {
          block: true,
          blockReason: `browser local file access is restricted to bot media paths (${[...new Set(violations)].join(", ")})`
        };
      }

      event.params = adjustedParams;
      return { params: adjustedParams };
    }, {
      name: "imagebot-browser-guard-before-tool-call",
      description: "Add browser defaults, stage bot-local uploads, and resolve tab aliases."
    });

    registerLifecycleHook(api, "after_tool_call", async (event, ctx) => {
      rememberBrowserTargetAliases(event, ctx);
    }, {
      name: "imagebot-browser-guard-after-tool-call",
      description: "Remember browser tab aliases so later actions can use the visible tab id."
    });
  }
};

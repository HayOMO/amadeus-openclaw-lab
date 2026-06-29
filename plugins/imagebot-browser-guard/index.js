import os from "node:os";
import path from "node:path";
import { registerLifecycleHook } from "../imagebot-shared/openclaw-lifecycle-hooks.mjs";
import {
  assertPublicHostname,
  isBlockedHostname
} from "../imagebot-shared/public-network-guard.mjs";

const DEFAULT_ALLOWED_PROFILES = ["openclaw"];
const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/;
const UNC_PATH_RE = /^\\\\/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const BLOCKED_SCHEMES = new Set([
  "file",
  "javascript",
  "chrome",
  "chrome-extension",
  "edge",
  "devtools",
  "about"
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeProfileName(value) {
  return normalizeString(value).toLowerCase();
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

function defaultAllowedPathPrefixes() {
  const home = os.homedir();
  return [
    path.join(home, ".openclaw", "media", "inbound"),
    path.join(home, ".openclaw", "media", "tool-image-generation")
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

function collectProfileValues(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectProfileValues(item, found);
    return found;
  }
  if (!isRecord(value)) return found;
  for (const [key, item] of Object.entries(value)) {
    if (normalizeProfileName(key) === "profile" && typeof item === "string") found.push(item);
    else collectProfileValues(item, found);
  }
  return found;
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
  const value = normalizeString(raw);
  const candidate = value.toLowerCase().startsWith("file://")
    ? decodeURIComponent(value.replace(/^file:\/\//i, ""))
    : value;
  const normalized = normalizeAbsolutePath(candidate);
  return allowedRoots.some((root) => normalized === root || normalized.startsWith(`${root}\\`));
}

async function findUnsafeStrings(params, allowedRoots, networkGuardOptions = {}) {
  const strings = collectStringValues(params);
  const violations = [];
  for (const raw of strings) {
    const value = normalizeString(raw);
    if (!value) continue;
    if (isLocalPathLike(value)) {
      if (!isAllowedLocalPath(value, allowedRoots)) violations.push(`local-path:${value}`);
      continue;
    }
    if (!SCHEME_RE.test(value)) continue;
    const scheme = value.slice(0, value.indexOf(":")).toLowerCase();
    if (BLOCKED_SCHEMES.has(scheme)) {
      violations.push(`scheme:${value}`);
      continue;
    }
    if (scheme !== "http" && scheme !== "https" && scheme !== "data") continue;
    if (scheme === "data") {
      if (!value.toLowerCase().startsWith("data:image/")) violations.push(`scheme:${value}`);
      continue;
    }
    try {
      const parsed = new URL(value);
      if (isBlockedHostname(parsed.hostname)) violations.push(`url:${value}`);
      else {
        await assertPublicHostname(parsed.hostname, networkGuardOptions).catch(() => {
          violations.push(`url:${value}`);
        });
      }
    } catch {
      violations.push(`url:${value}`);
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

function isBrowserProfileMutation(params) {
  if (!isRecord(params)) return false;
  const pathValue = normalizeString(params.path);
  return pathValue === "/profiles" || pathValue.startsWith("/profiles/");
}

export default {
  id: "imagebot-browser-guard",
  name: "Imagebot Browser Guard",
  description: "Restricts browser tool calls to isolated managed browsing only.",
  register(api) {
    registerLifecycleHook(api, "before_tool_call", async (event) => {
      if (event.toolName !== "browser") return;

      const pluginConfig = event?.context?.pluginConfig ?? api.config;
      const allowedProfiles = normalizeAllowedProfiles(pluginConfig);
      const allowedRoots = normalizeAllowedPathPrefixes(pluginConfig);
      const networkGuardOptions = isRecord(pluginConfig?.publicNetworkGuard) ? pluginConfig.publicNetworkGuard : {};
      const requestedProfiles = collectProfileValues(event.params).map((entry) => normalizeProfileName(entry));
      const disallowedProfile = requestedProfiles.find((entry) => entry && !allowedProfiles.includes(entry));
      if (disallowedProfile) {
        return {
          block: true,
          blockReason: `browser profile "${disallowedProfile}" is blocked; allowed profile: ${allowedProfiles.join(", ")}`
        };
      }

      if (isBrowserProfileMutation(event.params)) {
        return {
          block: true,
          blockReason: "browser profile management is blocked for this bot"
        };
      }

      const adjustedParams = withDefaultProfile(event.params, allowedProfiles[0]);
      const violations = await findUnsafeStrings(adjustedParams, allowedRoots, networkGuardOptions);
      if (violations.length > 0) {
        return {
          block: true,
          blockReason: "browser access is restricted to public web pages and current Telegram media paths only"
        };
      }

      return { params: adjustedParams };
    }, {
      name: "imagebot-browser-guard-before-tool-call",
      description: "Restrict browser tool calls to the isolated managed profile and safe media paths."
    });
  }
};

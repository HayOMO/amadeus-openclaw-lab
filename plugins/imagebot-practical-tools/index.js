import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { backgroundToolParameters, enqueueBackgroundTool, shouldRunInBackground } from "../imagebot-background-jobs/index.js";
import { browserExecutablePath as pooledBrowserExecutablePath, closeBrowserContextPool, withEphemeralPage, withPooledPage } from "../imagebot-shared/browser-context-pool.js";
import {
  mutationActorKey,
  mutationScopeKey,
  trustedMutationContext
} from "../imagebot-shared/mutation-authorization.mjs";
import {
  assertBrowserRequestUrlAllowed,
  assertPublicHostname,
  installBrowserNetworkGuard,
  isPrivateIp
} from "../imagebot-shared/public-network-guard.mjs";

const WEB_SNAPSHOT_TOOL = "web_snapshot";
const WEB_CARD_TOOL = "web_card";
const MEDIA_TRANSFORM_TOOL = "media_transform";
const ARTIFACT_RECENT_TOOL = "artifact_recent";
const ARTIFACT_SEARCH_TOOL = "artifact_search";
const ARTIFACT_GET_TOOL = "artifact_get";
const QR_TOOL = "qr_tool";
const PDF_RENDER_TOOL = "pdf_render";
const AV_MEDIA_TOOL = "av_media";
const TEXT_TOOLKIT_TOOL = "text_toolkit";
const WEB_WATCH_ADD_TOOL = "web_watch_add";
const WEB_WATCH_LIST_TOOL = "web_watch_list";
const WEB_WATCH_CHECK_TOOL = "web_watch_check";
const WEB_WATCH_DELETE_TOOL = "web_watch_delete";

const MAX_ARTIFACT_READ_BYTES = 4 * 1024 * 1024;
const MAX_RECENT = 20;
const DEFAULT_RECENT = 8;
const MAX_WEB_TEXT_CHARS = 12_000;
const MAX_WEB_WAIT_MS = 8_000;
const DEFAULT_WEB_WAIT_MS = 1_200;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const PYTHON_TIMEOUT_MS = 45_000;
const WEB_TIMEOUT_MS = 30_000;
const ACCOUNT_BROWSER_MIN_INTERVAL_MS = 15_000;
const ACCOUNT_BROWSER_HOURLY_LIMIT = 18;
const ACCOUNT_BROWSER_DAILY_LIMIT = 80;
const ACCOUNT_BROWSER_ACTION_LIMIT = 4;
const ACCOUNT_BROWSER_LOGIN_BACKOFF_MS = 5 * 60 * 1000;
const ACCOUNT_BROWSER_VERIFICATION_BACKOFF_MS = 30 * 60 * 1000;
const AV_TIMEOUT_MS = 90_000;
const MAX_AV_BYTES = 100 * 1024 * 1024;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_PDF_RENDER_PAGES = 6;
const TOOL_RESULT_IMAGE_PREVIEW_MAX_BYTES = 1250 * 1024;
const TOOL_RESULT_IMAGE_PREVIEW_MAX_EDGE = 1536;
const IMAGE_TOOL_MAX_CALLS_PER_TURN = 3;
const TOOL_LIMIT_TTL_MS = 10 * 60 * 1000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "Chrome/120.0 Safari/537.36";

const INPUT_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);
const INPUT_PDF_EXTS = new Set([".pdf"]);
const INPUT_AV_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".gif", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".flac"]);
const OUTPUT_FORMATS = new Set(["jpg", "jpeg", "png", "webp"]);
const OUTPUT_MIME = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"]
]);
const SHARP_IMAGE_ACTIONS = new Set([
  "compress",
  "convert",
  "resize",
  "sticker",
  "strip_exif",
  "crop",
  "rotate",
  "flip",
  "flop",
  "normalize",
  "grayscale",
  "blur",
  "sharpen"
]);
const ACCOUNT_BROWSER_PLATFORMS = [
  {
    id: "weibo",
    label: "Weibo",
    domains: ["weibo.com", "sina.com.cn", "sina.com"],
    loginUrl: /passport\.weibo\.com|login\.sina\.com/i,
    riskText: /验证码|安全验证|访问过于频繁|异常流量|captcha|verify/i
  },
  {
    id: "bilibili",
    label: "Bilibili",
    domains: ["bilibili.com"],
    loginUrl: /passport\.bilibili\.com/i,
    riskText: /验证码|安全验证|captcha|verify/i
  },
  {
    id: "baidu_tieba",
    label: "Baidu/Tieba",
    domains: ["baidu.com", "tieba.baidu.com"],
    loginUrl: /passport\.baidu\.com/i,
    riskText: /验证码|安全验证|访问过于频繁|异常流量|captcha|verify/i
  },
  {
    id: "xiaohongshu",
    label: "Xiaohongshu",
    domains: ["xiaohongshu.com"],
    loginUrl: /login|signin/i,
    riskText: /验证码|安全验证|异常|captcha|verify/i
  },
  {
    id: "zhihu",
    label: "Zhihu",
    domains: ["zhihu.com"],
    loginUrl: /signin|login/i,
    riskText: /验证码|安全验证|captcha|verify/i
  },
  {
    id: "pixiv",
    label: "Pixiv",
    domains: ["pixiv.net"],
    loginUrl: /\/login/i,
    riskText: /captcha|verify|cloudflare/i
  },
  {
    id: "lofter",
    label: "LOFTER",
    domains: ["lofter.com"],
    loginUrl: /login|passport/i,
    riskText: /验证码|安全验证|captcha|verify/i
  }
];
const ACCOUNT_BROWSER_TIER_DEFAULTS = {
  read: {
    label: "read",
    minIntervalMs: 5_000,
    hourlyLimit: 48,
    dailyLimit: 160,
    actionLimit: 0
  },
  light: {
    label: "light",
    minIntervalMs: 9_000,
    hourlyLimit: 32,
    dailyLimit: 120,
    actionLimit: 2
  },
  interactive: {
    label: "interactive",
    minIntervalMs: ACCOUNT_BROWSER_MIN_INTERVAL_MS,
    hourlyLimit: ACCOUNT_BROWSER_HOURLY_LIMIT,
    dailyLimit: ACCOUNT_BROWSER_DAILY_LIMIT,
    actionLimit: ACCOUNT_BROWSER_ACTION_LIMIT
  }
};
const ACCOUNT_BROWSER_PASSIVE_ACTIONS = new Set(["scroll", "wait"]);

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginDir, "..", "..");
const toolTurnCounters = new Map();
const browserRiskStateLocks = new Map();

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  return typeof value === "string" ? value.trim() : fallback;
}

function readBoolean(params, key, fallback = false) {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(1|true|yes|on)$/i.test(value.trim());
  return fallback;
}

function readNumber(params, key, fallback, min, max) {
  const raw = isRecord(params) ? params[key] : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clip(value, max = 600) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function toolTurnKey(toolName, ctx = {}) {
  const runId = String(ctx?.runId || "").trim();
  if (runId) return `${toolName}:run:${runId}`;
  const sessionKey = String(ctx?.sessionKey || ctx?.chatId || ctx?.agentId || "").trim();
  if (!sessionKey) return "";
  const bucket = Math.floor(Date.now() / TOOL_LIMIT_TTL_MS);
  return `${toolName}:session:${sessionKey}:bucket:${bucket}`;
}

function claimToolTurnCall(toolName, ctx, limit = IMAGE_TOOL_MAX_CALLS_PER_TURN) {
  const now = Date.now();
  for (const [key, entry] of toolTurnCounters) {
    if (entry.expiresAt <= now) toolTurnCounters.delete(key);
  }
  const key = toolTurnKey(toolName, ctx);
  if (!key) return { ok: true, count: 1, limit, untracked: true };
  const current = toolTurnCounters.get(key) || { count: 0, expiresAt: now + TOOL_LIMIT_TTL_MS };
  if (current.count >= limit) {
    return {
      ok: false,
      count: current.count,
      limit,
      text: `${toolName.toUpperCase()} limit: already used ${current.count}/${limit} times in this turn. Stop refactoring automatically and ask the user for a clearer next instruction if more changes are needed.`
    };
  }
  current.count += 1;
  current.expiresAt = now + TOOL_LIMIT_TTL_MS;
  toolTurnCounters.set(key, current);
  return { ok: true, count: current.count, limit };
}

function sha256(value, len = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function safeBaseName(value, fallback = "artifact") {
  const raw = String(value || fallback).trim().replace(/\.[a-z0-9]{1,8}$/i, "");
  const cleaned = raw
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

function storeRoot(config) {
  const configured = String(config?.storeDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "practical-tools"));
}

function mediaRoot(config) {
  const configured = String(config?.mediaDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "media", "practical-tools"));
}

function browserRiskStatePath(config) {
  return path.join(storeRoot(config), "browser-risk-state.json");
}

function artifactLogPath(config) {
  return path.join(storeRoot(config), "artifacts.jsonl");
}

function normalizeToolContext(context) {
  if (!isRecord(context)) return {};
  const trusted = trustedMutationContext(context);
  const out = {};
  for (const key of ["agentId", "accountId", "channel", "chatId", "threadId", "sessionKey", "windowId", "senderId", "messageId"]) {
    if (trusted[key] !== undefined && trusted[key] !== null && String(trusted[key]).trim()) out[key] = String(trusted[key]);
  }
  for (const key of ["messageThreadId", "replyToMessageId"]) {
    if (context[key] !== undefined && context[key] !== null && String(context[key]).trim()) out[key] = String(context[key]);
  }
  if (out.chatId || out.sessionKey || out.windowId) out.scopeKey = mutationScopeKey(trusted);
  if (out.scopeKey && out.senderId) out.actorKey = mutationActorKey(trusted);
  return out;
}

function artifactScopeFilter(ctx = {}, config = {}) {
  if (config.allowCrossScopeArtifacts === true) return {};
  const context = normalizeToolContext(ctx);
  if (context.scopeKey) return { scopeKey: context.scopeKey };
  if (context.sessionKey) return { sessionKey: context.sessionKey };
  if (context.chatId) return { chatId: context.chatId };
  return {};
}

function artifactMatchesFilter(record, filter = {}) {
  if (!record) return false;
  const context = record.context || {};
  const scopeKey = record.scopeKey || context.scopeKey || "";
  const actorKey = record.actorKey || context.actorKey || "";
  const sessionKey = context.sessionKey || record.sessionKey || "";
  const chatId = context.chatId || record.chatId || "";
  if (filter.scopeKey && scopeKey !== filter.scopeKey) return false;
  if (filter.actorKey && actorKey !== filter.actorKey) return false;
  if (filter.sessionKey && sessionKey !== filter.sessionKey) return false;
  if (filter.chatId && chatId !== filter.chatId) return false;
  return true;
}

async function readBrowserRiskState(config) {
  try {
    const parsed = JSON.parse(await fs.readFile(browserRiskStatePath(config), "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    return {};
  }
}

async function writeBrowserRiskState(config, state) {
  const filePath = browserRiskStatePath(config);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function withBrowserRiskStateLock(config, fn) {
  const key = browserRiskStatePath(config);
  const previous = browserRiskStateLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  browserRiskStateLocks.set(key, tail);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (browserRiskStateLocks.get(key) === tail) browserRiskStateLocks.delete(key);
  }
}

async function appendJsonLine(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function readTail(filePath, maxBytes = MAX_ARTIFACT_READ_BYTES) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
  if (!stat.isFile() || stat.size <= 0) return "";
  if (stat.size <= maxBytes) return await fs.readFile(filePath, "utf8");
  const length = maxBytes;
  const position = Math.max(0, stat.size - length);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const result = await handle.read(buffer, 0, length, position);
    let text = buffer.subarray(0, result.bytesRead).toString("utf8");
    if (position > 0) {
      const index = text.indexOf("\n");
      text = index >= 0 ? text.slice(index + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

async function loadArtifacts(config, filter = {}) {
  const raw = await readTail(artifactLogPath(config));
  if (!raw) return [];
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (isRecord(record) && record.type === "artifact") records.push(record);
    } catch {
      // Append-only store: skip corrupt tail fragments.
    }
  }
  records.sort((a, b) => Date.parse(b.t || 0) - Date.parse(a.t || 0));
  return records.filter((record) => artifactMatchesFilter(record, filter));
}

async function recordArtifact(config, record, context = {}) {
  const normalizedContext = normalizeToolContext(context);
  const artifact = {
    type: "artifact",
    artifactId: record.artifactId || `art_${sha256(`${Date.now()}:${Math.random()}`, 20)}`,
    t: new Date().toISOString(),
    ...record,
    context: normalizedContext,
    scopeKey: normalizedContext.scopeKey || "",
    actorKey: normalizedContext.actorKey || ""
  };
  await appendJsonLine(artifactLogPath(config), artifact);
  return artifact;
}

function normalizeUrlInput(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("url is required");
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) ? text : `https://${text}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("invalid url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("only public http/https URLs are allowed");
  }
  parsed.hash = "";
  return parsed;
}

function hostMatchesDomain(hostname, domain) {
  const host = String(hostname || "").toLowerCase().replace(/^\./, "");
  const target = String(domain || "").toLowerCase().replace(/^\./, "");
  return host === target || host.endsWith(`.${target}`);
}

function accountBrowserPlatformForUrl(urlLike) {
  let url;
  try {
    url = urlLike instanceof URL ? urlLike : new URL(String(urlLike || ""));
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  return ACCOUNT_BROWSER_PLATFORMS.find((platform) => platform.domains.some((domain) => hostMatchesDomain(hostname, domain))) || null;
}

function readRiskNumber(value, fallback, min = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.trunc(number));
}

function accountBrowserTierPolicy(cfg, tierName) {
  const defaults = ACCOUNT_BROWSER_TIER_DEFAULTS[tierName] || ACCOUNT_BROWSER_TIER_DEFAULTS.interactive;
  const tierCfg = isRecord(cfg.tiers?.[tierName]) ? cfg.tiers[tierName] : {};
  const legacy = tierName === "interactive";
  return {
    label: defaults.label,
    minIntervalMs: readRiskNumber(tierCfg.minIntervalMs ?? (legacy ? cfg.minIntervalMs : undefined), defaults.minIntervalMs),
    hourlyLimit: readRiskNumber(tierCfg.hourlyLimit ?? (legacy ? cfg.hourlyLimit : undefined), defaults.hourlyLimit, 1),
    dailyLimit: readRiskNumber(tierCfg.dailyLimit ?? (legacy ? cfg.dailyLimit : undefined), defaults.dailyLimit, 1),
    actionLimit: readRiskNumber(tierCfg.actionLimit ?? (legacy ? cfg.actionLimit : undefined), defaults.actionLimit)
  };
}

function accountBrowserPolicy(config = {}) {
  const cfg = isRecord(config.accountBrowserRisk) ? config.accountBrowserRisk : {};
  return {
    enabled: cfg.enabled !== false,
    loginBackoffMs: readRiskNumber(cfg.loginBackoffMs, ACCOUNT_BROWSER_LOGIN_BACKOFF_MS),
    verificationBackoffMs: readRiskNumber(cfg.verificationBackoffMs, ACCOUNT_BROWSER_VERIFICATION_BACKOFF_MS),
    tiers: {
      read: accountBrowserTierPolicy(cfg, "read"),
      light: accountBrowserTierPolicy(cfg, "light"),
      interactive: accountBrowserTierPolicy(cfg, "interactive")
    }
  };
}

function accountBrowserActionProfile(actionsOrCount = 0) {
  if (Array.isArray(actionsOrCount)) {
    const actions = actionsOrCount.filter(isRecord);
    const actionCount = actions.length;
    if (actionCount === 0) return { tier: "read", actionCount, actionTypes: [] };
    const actionTypes = actions.map((action) => String(action.type || "").toLowerCase()).filter(Boolean);
    const passiveOnly = actionTypes.length === actionCount && actionTypes.every((type) => ACCOUNT_BROWSER_PASSIVE_ACTIONS.has(type));
    if (passiveOnly) return { tier: "light", actionCount, actionTypes };
    return { tier: "interactive", actionCount, actionTypes };
  }
  const actionCount = Math.max(0, Math.trunc(Number(actionsOrCount) || 0));
  return {
    tier: actionCount === 0 ? "read" : "interactive",
    actionCount,
    actionTypes: []
  };
}

function browserRiskHistory(platformState = {}, now = Date.now()) {
  const hourAgo = now - 60 * 60 * 1000;
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const visits = Array.isArray(platformState.visits) ? platformState.visits.filter((entry) => Number(entry?.at) >= dayAgo) : [];
  return {
    visits,
    hourCount: visits.filter((entry) => Number(entry?.at) >= hourAgo).length,
    dayCount: visits.length
  };
}

function browserRiskBackoff(platformState = {}, policy, now = Date.now()) {
  const events = Array.isArray(platformState.events) ? platformState.events : [];
  const candidates = events
    .filter((entry) => ["login_redirect", "verification_or_risk_wall"].includes(String(entry?.kind || "")))
    .map((entry) => ({ ...entry, at: Number(entry?.at || 0) }))
    .filter((entry) => entry.at > 0)
    .sort((a, b) => b.at - a.at);
  const latest = candidates[0];
  if (!latest) return null;
  const backoffMs = latest.kind === "login_redirect" ? policy.loginBackoffMs : policy.verificationBackoffMs;
  const waitMs = backoffMs - (now - latest.at);
  return waitMs > 0 ? { kind: latest.kind, waitMs } : null;
}

async function claimBrowserRiskVisit(config, platform, url, actionsOrCount = 0) {
  const policy = accountBrowserPolicy(config);
  if (!policy.enabled || !platform) return { platform: null, policy, tracked: false };
  const profile = accountBrowserActionProfile(actionsOrCount);
  const limits = policy.tiers[profile.tier] || policy.tiers.interactive;
  if (profile.actionCount > limits.actionLimit) {
    throw new Error(`account browser risk limit: ${platform.label} ${limits.label} mode allows up to ${limits.actionLimit} action(s) per snapshot; received ${profile.actionCount}. Split the browsing into smaller human-reviewed steps.`);
  }
  return await withBrowserRiskStateLock(config, async () => {
    const now = Date.now();
    const state = await readBrowserRiskState(config);
    const platforms = isRecord(state.platforms) ? state.platforms : {};
    const previous = isRecord(platforms[platform.id]) ? platforms[platform.id] : {};
    const backoff = browserRiskBackoff(previous, policy, now);
    if (backoff) {
      throw new Error(`account browser risk backoff: ${platform.label} recently hit ${backoff.kind}; wait ${Math.ceil(backoff.waitMs / 1000)}s before another account-backed page read.`);
    }
    const history = browserRiskHistory(previous, now);
    const lastAt = Number(previous.lastAt || 0);
    const sinceLast = lastAt ? now - lastAt : Number.POSITIVE_INFINITY;
    if (sinceLast < limits.minIntervalMs) {
      const waitMs = limits.minIntervalMs - sinceLast;
      throw new Error(`account browser risk cooldown: wait ${Math.ceil(waitMs / 1000)}s before another ${platform.label} ${limits.label} page read.`);
    }
    if (history.hourCount >= limits.hourlyLimit) {
      throw new Error(`account browser risk budget: ${platform.label} ${limits.label} mode reached ${history.hourCount}/${limits.hourlyLimit} page reads this hour.`);
    }
    if (history.dayCount >= limits.dailyLimit) {
      throw new Error(`account browser risk budget: ${platform.label} ${limits.label} mode reached ${history.dayCount}/${limits.dailyLimit} page reads in 24h.`);
    }
    const visits = [...history.visits, { at: now, url: clip(String(url || ""), 240), tier: profile.tier, actionCount: profile.actionCount, actionTypes: profile.actionTypes }];
    platforms[platform.id] = {
      ...previous,
      label: platform.label,
      lastAt: now,
      visits
    };
    await writeBrowserRiskState(config, {
      ...state,
      updatedAt: new Date(now).toISOString(),
      platforms
    });
    return {
      platform: { id: platform.id, label: platform.label },
      policy,
      tier: profile.tier,
      limits,
      tracked: true,
      hourCount: history.hourCount + 1,
      dailyCount: history.dayCount + 1
    };
  });
}

async function recordBrowserRiskEvent(config, platform, event) {
  if (!platform) return;
  await withBrowserRiskStateLock(config, async () => {
    const now = Date.now();
    const state = await readBrowserRiskState(config);
    const platforms = isRecord(state.platforms) ? state.platforms : {};
    const previous = isRecord(platforms[platform.id]) ? platforms[platform.id] : {};
    const events = Array.isArray(previous.events) ? previous.events.filter((entry) => Number(entry?.at) >= now - 7 * 24 * 60 * 60 * 1000) : [];
    events.push({ at: now, ...event });
    platforms[platform.id] = {
      ...previous,
      label: platform.label,
      events
    };
    await writeBrowserRiskState(config, {
      ...state,
      updatedAt: new Date(now).toISOString(),
      platforms
    });
  });
}

function classifyBrowserRiskPage(platform, finalUrl = "", bodyText = "") {
  if (!platform) return "";
  if (platform.loginUrl?.test(String(finalUrl || ""))) return "login_redirect";
  const text = String(bodyText || "");
  if (platform.riskText?.test(text)) return "verification_or_risk_wall";
  return "";
}

async function resolveRedirects(startUrl, signal) {
  let current = normalizeUrlInput(startUrl);
  const chain = [];
  for (let i = 0; i < 4; i++) {
    await assertPublicHostname(current.hostname);
    chain.push(current.toString());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("redirect probe timed out")), 8_000);
    const abortParent = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) abortParent();
      else signal.addEventListener("abort", abortParent, { once: true });
    }
    try {
      const response = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.8" }
      }).catch(async (error) => {
        if (error?.name === "AbortError") throw error;
        return await fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.8", range: "bytes=0-2048" }
        });
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return { finalUrl: current.toString(), chain };
      const location = response.headers.get("location");
      if (!location) return { finalUrl: current.toString(), chain };
      current = new URL(location, current);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abortParent);
    }
  }
  throw new Error("too many redirects");
}

function runtimeRequireCandidates() {
  const candidates = [
    import.meta.url,
    path.join(repoRoot, "plugins", "imagebot-video-utils", "index.js"),
    path.join(path.dirname(process.execPath), "node_modules", "openclaw", "openclaw.mjs")
  ];
  return candidates.map((candidate) => createRequire(candidate));
}

function requireRuntimeModule(moduleName) {
  let lastError;
  for (const require of runtimeRequireCandidates()) {
    try {
      return require(moduleName);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`unable to require ${moduleName}`);
}

function commandPath(moduleName) {
  const mod = requireRuntimeModule(moduleName);
  const candidate = mod?.path ?? mod?.default?.path;
  if (!candidate) throw new Error(`${moduleName} did not expose a binary path`);
  return candidate;
}

let chromiumPromise = null;
let sharpPromise = null;
const prewarmedBrowserPools = new Set();
async function getChromium() {
  if (!chromiumPromise) {
    chromiumPromise = Promise.resolve().then(() => {
      const playwright = requireRuntimeModule("playwright-core");
      if (!playwright?.chromium) throw new Error("playwright-core chromium is unavailable");
      return playwright.chromium;
    });
  }
  return await chromiumPromise;
}

async function getSharp() {
  if (!sharpPromise) {
    sharpPromise = Promise.resolve().then(() => {
      const mod = requireRuntimeModule("sharp");
      return mod?.default || mod;
    });
  }
  return await sharpPromise;
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function browserExecutablePath(chromium) {
  return await pooledBrowserExecutablePath(chromium);
}

function browserPoolConfig(config = {}) {
  const cfg = isRecord(config.browserPool) ? config.browserPool : {};
  return {
    prewarm: cfg.prewarm === true,
    maxPages: Math.max(1, Math.min(12, Math.trunc(Number(cfg.maxPages || 4)))),
    idleMs: Math.max(30_000, Math.trunc(Number(cfg.idleMs || 10 * 60 * 1000)))
  };
}

function accountBrowserProfileDir(config = {}, platform = {}) {
  const id = String(platform?.id || "account").replace(/[^a-z0-9_.-]+/gi, "_").replace(/^_+|_+$/g, "") || "account";
  return path.join(storeRoot(config), "browser-profiles", "account", id);
}

function browserPoolLaunchOptions(executablePath, { viewport, persistent = false } = {}) {
  const launchOptions = {
    headless: true,
    executablePath,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions"]
  };
  if (persistent) {
    launchOptions.viewport = viewport;
    launchOptions.userAgent = USER_AGENT;
    launchOptions.acceptDownloads = false;
  }
  return launchOptions;
}

function browserContextOptions({ viewport } = {}) {
  return {
    viewport,
    userAgent: USER_AGENT,
    acceptDownloads: false
  };
}

async function withWebSnapshotPage({ config, chromium, executablePath, accountPlatform, viewport, pool, signal }, fn) {
  if (accountPlatform) {
    const userDataDir = accountBrowserProfileDir(config, accountPlatform);
    await fs.mkdir(path.dirname(userDataDir), { recursive: true });
    return await withPooledPage({
      key: `imagebot-practical-account-${accountPlatform.id}`,
      chromium,
      userDataDir,
      viewport,
      maxPages: pool.maxPages,
      idleMs: pool.idleMs,
      signal,
      launchOptions: browserPoolLaunchOptions(executablePath, { viewport, persistent: true })
    }, async (page, context, meta) => {
      await installBrowserNetworkGuard(context);
      return await fn(page, context, { ...meta, accountPlatform, profileDir: userDataDir });
    });
  }

  return await withEphemeralPage({
    key: "imagebot-practical-public-browser",
    chromium,
    viewport,
    maxPages: pool.maxPages,
    idleMs: pool.idleMs,
    signal,
    launchOptions: browserPoolLaunchOptions(executablePath, { viewport, persistent: false }),
    contextOptions: browserContextOptions({ viewport })
  }, async (page, context, meta) => {
    await installBrowserNetworkGuard(context);
    return await fn(page, context, meta);
  });
}

function scheduleWebSnapshotBrowserPrewarm(config = {}) {
  const pool = browserPoolConfig(config);
  if (!pool.prewarm) return;
  const key = "imagebot-practical-public-browser";
  if (prewarmedBrowserPools.has(key)) return;
  prewarmedBrowserPools.add(key);
  setTimeout(() => {
    void (async () => {
      const chromium = await getChromium();
      const executablePath = await browserExecutablePath(chromium);
      if (!executablePath) return;
      await withEphemeralPage({
        key,
        chromium,
        viewport: { width: 1200, height: 720 },
        maxPages: pool.maxPages,
        idleMs: pool.idleMs,
        launchOptions: browserPoolLaunchOptions(executablePath, { persistent: false }),
        contextOptions: browserContextOptions({ viewport: { width: 1200, height: 720 } })
      }, async (page) => {
        await page.goto("about:blank", { timeout: 5_000 }).catch(() => {});
      });
    })().catch(() => {});
  }, 1200).unref?.();
}

function readWebActions(params) {
  const raw = isRecord(params) ? params.actions : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).slice(0, 8).map((entry) => ({
    type: readString(entry, "type").toLowerCase(),
    selector: readString(entry, "selector"),
    text: readString(entry, "text"),
    value: readString(entry, "value"),
    key: readString(entry, "key"),
    pixels: readNumber(entry, "pixels", 600, -3000, 3000),
    waitMs: readNumber(entry, "waitMs", 500, 0, MAX_WEB_WAIT_MS)
  }));
}

async function clickTextOnPage(page, text) {
  const needle = String(text || "").trim().toLowerCase();
  if (!needle) throw new Error("click_text requires text");
  return await page.evaluate((target) => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const candidates = [...document.querySelectorAll("a,button,[role='button'],input[type='button'],input[type='submit']")];
    for (const el of candidates) {
      const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").trim().toLowerCase();
      if (label.includes(target) && visible(el)) {
        el.click();
        return label;
      }
    }
    return "";
  }, needle);
}

async function applyWebActions(page, actions) {
  const log = [];
  for (const action of actions) {
    if (!action.type) continue;
    try {
      if (action.type === "wait") {
        await page.waitForTimeout(action.waitMs);
        log.push({ type: action.type, status: "ok", waitMs: action.waitMs });
      } else if (action.type === "scroll") {
        await page.evaluate((pixels) => window.scrollBy(0, pixels), action.pixels);
        await page.waitForTimeout(action.waitMs);
        log.push({ type: action.type, status: "ok", pixels: action.pixels });
      } else if (action.type === "click_selector") {
        if (!action.selector) throw new Error("click_selector requires selector");
        await page.locator(action.selector).first().click({ timeout: 5000 });
        await page.waitForTimeout(action.waitMs);
        log.push({ type: action.type, status: "ok", selector: action.selector });
      } else if (action.type === "click_text") {
        const clicked = await clickTextOnPage(page, action.text);
        if (!clicked) throw new Error(`no visible clickable text matched "${action.text}"`);
        await page.waitForTimeout(action.waitMs);
        log.push({ type: action.type, status: "ok", text: action.text, matched: clicked.slice(0, 120) });
      } else if (action.type === "fill_selector") {
        if (!action.selector) throw new Error("fill_selector requires selector");
        await page.locator(action.selector).first().fill(action.value, { timeout: 5000 });
        log.push({ type: action.type, status: "ok", selector: action.selector, valueLength: action.value.length });
      } else if (action.type === "press") {
        await page.keyboard.press(action.key || "Enter");
        await page.waitForTimeout(action.waitMs);
        log.push({ type: action.type, status: "ok", key: action.key || "Enter" });
      } else {
        log.push({ type: action.type, status: "skipped", error: "unsupported action type" });
      }
    } catch (error) {
      log.push({ type: action.type, status: "failed", error: clip(error?.message || error, 200) });
    }
  }
  return log;
}

async function removeDirQuiet(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function runWebSnapshot(config, params, signal, ctx = {}) {
  const inputUrl = readString(params, "url");
  const width = readNumber(params, "width", 1365, 360, 1920);
  const height = readNumber(params, "height", 768, 360, 1600);
  const waitMs = readNumber(params, "waitMs", DEFAULT_WEB_WAIT_MS, 0, MAX_WEB_WAIT_MS);
  const fullPage = readBoolean(params, "fullPage", false);
  const includeText = readBoolean(params, "includeText", true);
  const maxTextChars = readNumber(params, "maxTextChars", 6_000, 500, MAX_WEB_TEXT_CHARS);
  const filenameHint = safeBaseName(readString(params, "filename", ""), "web-snapshot");
  const actions = readWebActions(params);
  const { finalUrl, chain } = await resolveRedirects(inputUrl, signal);
  await assertPublicHostname(new URL(finalUrl).hostname);
  const accountPlatform = accountBrowserPlatformForUrl(finalUrl) || accountBrowserPlatformForUrl(inputUrl);
  const risk = await claimBrowserRiskVisit(config, accountPlatform, finalUrl, actions);

  const chromium = await getChromium();
  const outputDir = path.join(mediaRoot(config), "web-snapshots");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${Date.now()}-${filenameHint}.png`);
  const executablePath = await browserExecutablePath(chromium);
  if (!executablePath) throw new Error("no Chromium/Chrome/Edge executable is available for web_snapshot");
  const pool = browserPoolConfig(config);
  return await withWebSnapshotPage({
    config,
    chromium,
    executablePath,
    accountPlatform,
    viewport: { width, height },
    pool,
    signal
  }, async (page, _context, browserMeta) => {
    await page.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: WEB_TIMEOUT_MS });
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    const earlyBodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || "").catch(() => "");
    let riskStatus = classifyBrowserRiskPage(accountPlatform, page.url(), earlyBodyText);
    if (riskStatus) {
      await recordBrowserRiskEvent(config, accountPlatform, { kind: riskStatus, url: clip(page.url(), 240) });
    }
    const actionLog = riskStatus ? [{ type: "risk_guard", status: "stopped", error: riskStatus }] : await applyWebActions(page, actions);
    const finalPageUrl = page.url();
    await assertPublicHostname(new URL(finalPageUrl).hostname);
    const title = await page.title().catch(() => "");
    const metadata = await page.evaluate(() => {
      const meta = (name) => document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute("content") || "";
      const headings = [...document.querySelectorAll("h1,h2")].slice(0, 10).map((node) => node.textContent?.trim()).filter(Boolean);
      const links = [...document.querySelectorAll("a[href]")].slice(0, 40).map((node) => ({
        text: node.textContent?.trim().slice(0, 120) || "",
        href: node.href
      }));
      return {
        description: meta("description") || meta("og:description"),
        ogTitle: meta("og:title"),
        bodyText: document.body?.innerText || "",
        headings,
        links
      };
    }).catch(() => ({ description: "", ogTitle: "", bodyText: "", headings: [], links: [] }));
    const finalRiskStatus = riskStatus || classifyBrowserRiskPage(accountPlatform, finalPageUrl, metadata.bodyText || "");
    if (finalRiskStatus && !riskStatus) {
      await recordBrowserRiskEvent(config, accountPlatform, { kind: finalRiskStatus, url: clip(finalPageUrl, 240) });
      riskStatus = finalRiskStatus;
    }
    await page.screenshot({ path: outputPath, fullPage, animations: "disabled", type: "png" });
    const stat = await fs.stat(outputPath);
    const textPath = path.join(storeRoot(config), "web-snapshots", `${Date.now()}-${filenameHint}.txt`);
    await fs.mkdir(path.dirname(textPath), { recursive: true });
    const bodyText = includeText ? clip(metadata.bodyText, maxTextChars) : "";
    await fs.writeFile(textPath, [
      `URL: ${finalPageUrl}`,
      `Title: ${title}`,
      `Description: ${metadata.description || ""}`,
      "",
      bodyText
    ].join("\n"), "utf8");
    const artifact = await recordArtifact(config, {
      artifactId: `web_${sha256(finalPageUrl + outputPath, 20)}`,
      kind: "web_snapshot",
      source: "web_snapshot",
      title,
      url: finalPageUrl,
      originalUrl: inputUrl,
      redirectChain: chain,
      screenshotPath: outputPath,
      textPath,
      mediaPath: outputPath,
      mimeType: "image/png",
      sizeBytes: stat.size,
      summary: clip(`${title}\n${metadata.description || ""}\n${bodyText}`, 800),
      tags: ["web", "snapshot", accountPlatform ? "account-browser" : "public-browser", actions.length ? "interactive" : ""].filter(Boolean),
      browserProfile: accountPlatform ? `account:${accountPlatform.id}` : "ephemeral-public"
    }, ctx);
    return { artifact, title, finalUrl: finalPageUrl, description: metadata.description || "", headings: metadata.headings || [], links: metadata.links || [], bodyText, outputPath, sizeBytes: stat.size, fullPage, width, height, actions: actionLog, risk, riskStatus, browserProfile: artifact.browserProfile, profileDir: browserMeta.profileDir || "" };
  });
}

function allowedMediaRoots(config) {
  const home = homeDir();
  const defaults = [
    path.join(home, ".openclaw", "media", "inbound"),
    path.join(home, ".openclaw", "media", "tool-image-generation"),
    path.join(home, ".openclaw", "media", "downloaded"),
    path.join(home, ".openclaw", "media", "gallery-resend"),
    mediaRoot(config),
    path.join(home, ".openclaw", "media", "archive")
  ];
  const extra = Array.isArray(config?.allowedMediaRoots) ? config.allowedMediaRoots : [];
  return [...defaults, ...extra].map((entry) => path.resolve(String(entry))).filter(Boolean);
}

function isInside(root, target) {
  const rootNorm = path.resolve(root).toLowerCase();
  const targetNorm = path.resolve(target).toLowerCase();
  return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + path.sep);
}

async function resolveAllowedMediaInput(config, raw) {
  const input = readMediaPath(raw);
  if (!input) throw new Error("input image path is required");
  if (/^https?:\/\//i.test(input)) throw new Error("media_transform only accepts Telegram/local bot media paths, not URLs");
  const resolved = path.resolve(input);
  if (!allowedMediaRoots(config).some((root) => isInside(root, resolved))) {
    throw new Error("input path is outside allowed bot media directories");
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("input path is not a file");
  if (stat.size > MAX_MEDIA_BYTES) throw new Error("input media is larger than 100 MB");
  const ext = path.extname(resolved).toLowerCase();
  if (!INPUT_IMAGE_EXTS.has(ext)) throw new Error(`unsupported input image type: ${ext || "unknown"}`);
  return { path: resolved, stat, ext };
}

async function resolveAllowedBotFile(config, raw, { label = "file", allowedExts = null, maxBytes = MAX_MEDIA_BYTES } = {}) {
  const input = readMediaPath(raw);
  if (!input) throw new Error(`${label} path is required`);
  if (/^https?:\/\//i.test(input)) throw new Error(`${label} tools only accept Telegram/bot-local media paths, not URLs`);
  const resolved = path.resolve(input);
  if (!allowedMediaRoots(config).some((root) => isInside(root, resolved))) {
    throw new Error(`${label} path is outside allowed bot media directories`);
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`${label} path is not a file`);
  if (stat.size > maxBytes) throw new Error(`${label} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const ext = path.extname(resolved).toLowerCase();
  if (allowedExts && !allowedExts.has(ext)) throw new Error(`unsupported ${label} type: ${ext || "unknown"}`);
  return { path: resolved, stat, ext };
}

function readMediaPath(raw) {
  const value = String(raw || "").trim().replace(/^`+|`+$/g, "");
  if (!value) return "";
  if (/^file:\/\//i.test(value)) return decodeURIComponent(value.replace(/^file:\/\//i, ""));
  return value;
}

function normalizeFormat(value, fallback = "jpg") {
  const format = String(value || fallback).trim().toLowerCase().replace(/^\./, "");
  if (!OUTPUT_FORMATS.has(format)) return fallback;
  return format;
}

function normalizeAction(value) {
  const action = String(value || "compress").trim().toLowerCase();
  if (SHARP_IMAGE_ACTIONS.has(action)) return action;
  return "compress";
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(command)} timed out`));
    }, options.timeoutMs || PYTHON_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${path.basename(command)} exited with code ${code}`));
    });
  });
}

async function runPython(args) {
  const commands = [];
  if (process.env.PYTHON) commands.push(process.env.PYTHON);
  commands.push("python", "py");
  let lastError;
  for (const command of [...new Set(commands)]) {
    try {
      return await runProcess(command, args, { timeoutMs: PYTHON_TIMEOUT_MS });
    } catch (error) {
      lastError = error;
      if (!/ENOENT|not recognized|not found/i.test(String(error?.message || error))) break;
    }
  }
  throw lastError || new Error("python is unavailable");
}

function readOptionalNumber(params, key, min, max) {
  const raw = isRecord(params) ? params[key] : undefined;
  if (raw === undefined || raw === null || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parseAspectRatio(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "square") return 1;
  const colon = raw.match(/^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/);
  if (colon) {
    const w = Number(colon[1]);
    const h = Number(colon[2]);
    if (w > 0 && h > 0) return w / h;
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function cropBoxFromParams(params, metadata) {
  const sourceWidth = Number(metadata?.width || 0);
  const sourceHeight = Number(metadata?.height || 0);
  if (!sourceWidth || !sourceHeight) return null;

  const cropBox = readString(params, "cropBox");
  if (cropBox) {
    const parts = cropBox.split(/[,\s]+/).map((part) => Number(part)).filter((part) => Number.isFinite(part));
    if (parts.length >= 4) {
      const [left, top, width, height] = parts.map((part) => Math.trunc(part));
      if (width > 0 && height > 0) return boundedCropBox({ left, top, width, height }, sourceWidth, sourceHeight);
    }
  }

  const cropPercent = readString(params, "cropPercent");
  if (cropPercent) {
    const parts = cropPercent.split(/[,\s]+/).map((part) => Number(part)).filter((part) => Number.isFinite(part));
    if (parts.length >= 4) {
      const [leftPct, topPct, widthPct, heightPct] = parts;
      return boundedCropBox({
        left: Math.round(sourceWidth * leftPct / 100),
        top: Math.round(sourceHeight * topPct / 100),
        width: Math.round(sourceWidth * widthPct / 100),
        height: Math.round(sourceHeight * heightPct / 100)
      }, sourceWidth, sourceHeight);
    }
  }

  const left = readOptionalNumber(params, "left", 0, sourceWidth - 1);
  const top = readOptionalNumber(params, "top", 0, sourceHeight - 1);
  const width = readOptionalNumber(params, "cropWidth", 1, sourceWidth) ?? readOptionalNumber(params, "width", 1, sourceWidth);
  const height = readOptionalNumber(params, "cropHeight", 1, sourceHeight) ?? readOptionalNumber(params, "height", 1, sourceHeight);
  if (left !== null && top !== null && width !== null && height !== null) {
    return boundedCropBox({ left, top, width, height }, sourceWidth, sourceHeight);
  }

  const aspect = parseAspectRatio(readString(params, "aspectRatio")) ?? 1;
  let cropWidth = sourceWidth;
  let cropHeight = Math.round(cropWidth / aspect);
  if (cropHeight > sourceHeight) {
    cropHeight = sourceHeight;
    cropWidth = Math.round(cropHeight * aspect);
  }
  return boundedCropBox({
    left: Math.floor((sourceWidth - cropWidth) / 2),
    top: Math.floor((sourceHeight - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight
  }, sourceWidth, sourceHeight);
}

function boundedCropBox(box, sourceWidth, sourceHeight) {
  const left = Math.max(0, Math.min(sourceWidth - 1, Math.trunc(box.left)));
  const top = Math.max(0, Math.min(sourceHeight - 1, Math.trunc(box.top)));
  const width = Math.max(1, Math.min(sourceWidth - left, Math.trunc(box.width)));
  const height = Math.max(1, Math.min(sourceHeight - top, Math.trunc(box.height)));
  return { left, top, width, height };
}

function applySharpOutput(image, format, quality) {
  if (format === "jpg" || format === "jpeg") {
    return image.jpeg({ quality, mozjpeg: true, progressive: true });
  }
  if (format === "png") {
    return image.png({ compressionLevel: 9, adaptiveFiltering: true });
  }
  if (format === "webp") {
    return image.webp({ quality, effort: 5 });
  }
  throw new Error(`unsupported output format: ${format}`);
}

async function buildImagePreviewContent(filePath, mimeType) {
  const stat = await fs.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (stat.size <= TOOL_RESULT_IMAGE_PREVIEW_MAX_BYTES && [".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
    const data = await fs.readFile(filePath);
    return { type: "image", data: data.toString("base64"), mimeType, fileName: path.basename(filePath) };
  }

  const sharp = await getSharp();
  const preview = await sharp(filePath, { animated: false, limitInputPixels: false })
    .rotate()
    .resize({ width: TOOL_RESULT_IMAGE_PREVIEW_MAX_EDGE, height: TOOL_RESULT_IMAGE_PREVIEW_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return { type: "image", data: preview.toString("base64"), mimeType: "image/jpeg", fileName: `${path.basename(filePath, ext)}-preview.jpg` };
}

async function runMediaTransform(config, params, ctx = {}) {
  const input = await resolveAllowedMediaInput(config, readString(params, "input") || readString(params, "image"));
  const action = normalizeAction(readString(params, "action", "compress"));
  const requestedFormat = readString(params, "format", "");
  const inputFormat = input.ext === ".jpeg" ? "jpg" : input.ext.replace(/^\./, "");
  const format = action === "sticker" ? "webp" : action === "censor" ? "png" : normalizeFormat(requestedFormat, OUTPUT_FORMATS.has(inputFormat) ? inputFormat : "jpg");
  const quality = readNumber(params, "quality", action === "compress" ? 82 : 90, 30, 98);
  const width = readNumber(params, "width", 0, 0, 4096);
  const height = readNumber(params, "height", 0, 0, 4096);
  const maxEdge = readNumber(params, "maxEdge", action === "compress" ? 1600 : 0, 0, 4096);
  const filename = safeBaseName(readString(params, "filename", ""), `${action}-${path.basename(input.path, input.ext)}`);
  const outputDir = path.join(mediaRoot(config), "media-transform");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${Date.now()}-${filename}.${format === "jpeg" ? "jpg" : format}`);
  const sharp = await getSharp();
  const base = sharp(input.path, { animated: false, limitInputPixels: false }).rotate();
  const metadata = await base.clone().metadata();
  let image = base;
  let cropBox = null;

  if (action === "crop") {
    cropBox = cropBoxFromParams(params, metadata);
    if (!cropBox) throw new Error("unable to determine crop box");
    image = image.extract(cropBox);
  }
  if (action === "rotate") {
    const angle = readNumber(params, "angle", 90, -360, 360);
    image = image.rotate(angle);
  }
  if (action === "flip") image = image.flip();
  if (action === "flop") image = image.flop();
  if (action === "normalize") image = image.normalize();
  if (action === "grayscale") image = image.grayscale();
  if (action === "blur") image = image.blur(readNumber(params, "sigma", readNumber(params, "radius", 2, 1, 100), 1, 100));
  if (action === "sharpen") image = image.sharpen();

  if (action === "sticker") {
    image = image.resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true });
  } else if (width > 0 || height > 0) {
    image = image.resize({
      width: width > 0 ? width : null,
      height: height > 0 ? height : null,
      fit: "inside",
      withoutEnlargement: true
    });
  } else if (maxEdge > 0) {
    image = image.resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
  }

  const info = await applySharpOutput(image, format, quality).toFile(outputPath);
  const outStat = await fs.stat(outputPath);
  const artifact = await recordArtifact(config, {
    artifactId: `media_${sha256(outputPath, 20)}`,
    kind: "media_transform",
    source: "media_transform",
    action,
    inputPath: input.path,
    mediaPath: outputPath,
    mimeType: OUTPUT_MIME.get(format) || "application/octet-stream",
    sizeBytes: outStat.size,
    originalSizeBytes: input.stat.size,
    width: info.width,
    height: info.height,
    frames: Number(metadata.pages || 1),
    cropBox,
    summary: `${action} ${path.basename(input.path)} -> ${path.basename(outputPath)} (${outStat.size} bytes)`,
    tags: ["media", action, format]
  }, ctx);
  return { artifact, input, outputPath, outputFormat: format, mimeType: OUTPUT_MIME.get(format), sizeBytes: outStat.size, width: info.width, height: info.height, frames: Number(metadata.pages || 1), action, cropBox, engine: "sharp" };
}

const PY_QR_GENERATE_SCRIPT = String.raw`
import qrcode, sys, json
text, outp, box_size, border = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=box_size, border=border)
qr.add_data(text)
qr.make(fit=True)
img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
img.save(outp)
print(json.dumps({"width": img.width, "height": img.height}, ensure_ascii=False))
`;

async function runQrGenerate(config, params, ctx = {}) {
  const text = readString(params, "text") || readString(params, "content");
  if (!text) throw new Error("text/content is required");
  if (text.length > 2048) throw new Error("QR text is too long; keep it under 2048 chars");
  const boxSize = readNumber(params, "boxSize", 10, 4, 24);
  const border = readNumber(params, "border", 4, 1, 10);
  const outputDir = path.join(mediaRoot(config), "qr");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${Date.now()}-${safeBaseName(readString(params, "filename"), "qr-code")}.png`);
  const { stdout } = await runPython(["-c", PY_QR_GENERATE_SCRIPT, text, outputPath, String(boxSize), String(border)]);
  const parsed = JSON.parse(stdout.trim() || "{}");
  const stat = await fs.stat(outputPath);
  const artifact = await recordArtifact(config, {
    artifactId: `qr_${sha256(outputPath, 20)}`,
    kind: "qr_code",
    source: "qr_tool",
    action: "generate",
    mediaPath: outputPath,
    mimeType: "image/png",
    sizeBytes: stat.size,
    width: parsed.width,
    height: parsed.height,
    summary: `QR code generated for ${clip(text, 180)}`,
    tags: ["qr", "generated"]
  }, ctx);
  return { artifact, outputPath, sizeBytes: stat.size, width: parsed.width, height: parsed.height, text };
}

const PY_QR_DECODE_SCRIPT = String.raw`
import cv2, json, sys
img = cv2.imread(sys.argv[1])
if img is None:
    raise RuntimeError("failed to read image")
detector = cv2.QRCodeDetector()
results = []
try:
    ok, decoded, points, _ = detector.detectAndDecodeMulti(img)
    if ok:
        for value in decoded:
            if value:
                results.append({"rawValue": value, "format": "qr_code"})
except Exception:
    value, points, _ = detector.detectAndDecode(img)
    if value:
        results.append({"rawValue": value, "format": "qr_code"})
if not results:
    value, points, _ = detector.detectAndDecode(img)
    if value:
        results.append({"rawValue": value, "format": "qr_code"})
print(json.dumps({"results": results}, ensure_ascii=False))
`;

async function runQrDecodeWithPython(imagePath) {
  const { stdout } = await runPython(["-c", PY_QR_DECODE_SCRIPT, imagePath]);
  const parsed = JSON.parse(stdout.trim() || "{}");
  return Array.isArray(parsed.results) ? parsed.results : [];
}

async function runQrDecode(config, params) {
  const input = await resolveAllowedBotFile(config, readString(params, "image") || readString(params, "input"), {
    label: "QR image",
    allowedExts: INPUT_IMAGE_EXTS,
    maxBytes: MAX_MEDIA_BYTES
  });
  const pythonResults = await runQrDecodeWithPython(input.path).catch(() => []);
  if (pythonResults.length > 0) return { input, results: pythonResults, decoder: "opencv" };
  const imageBytes = await fs.readFile(input.path);
  const mime = input.ext === ".jpg" || input.ext === ".jpeg" ? "image/jpeg" :
    input.ext === ".webp" ? "image/webp" :
      input.ext === ".gif" ? "image/gif" : "image/png";
  const dataUrl = `data:${mime};base64,${imageBytes.toString("base64")}`;
  const chromium = await getChromium();
  const executablePath = await browserExecutablePath(chromium);
  if (!executablePath) throw new Error("no Chromium/Chrome/Edge executable is available for QR decode");
  const userDataDir = path.join(storeRoot(config), "browser-profiles", `qr-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      executablePath,
      viewport: { width: 800, height: 600 },
      args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions"]
    });
    const page = await context.newPage();
    const result = await page.evaluate(async (src) => {
      if (!("BarcodeDetector" in globalThis)) return { supported: false, results: [] };
      const image = new Image();
      image.src = src;
      await image.decode();
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const detected = await detector.detect(image);
      return {
        supported: true,
        results: detected.map((entry) => ({
          rawValue: entry.rawValue || "",
          format: entry.format || "qr_code"
        }))
      };
    }, dataUrl);
    if (!result.supported) throw new Error("browser BarcodeDetector is not available for QR decode");
    return { input, results: result.results || [], decoder: "browser" };
  } finally {
    if (context) await context.close().catch(() => {});
    await removeDirQuiet(userDataDir);
  }
}

function parsePageList(raw, pageCount) {
  const text = String(raw || "1").trim();
  const pages = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let page = Math.min(start, end); page <= Math.max(start, end); page++) pages.push(page);
    } else {
      const page = Number(part);
      if (Number.isFinite(page)) pages.push(Math.trunc(page));
    }
  }
  const normalized = [...new Set(pages)]
    .filter((page) => page >= 1 && page <= pageCount)
    .slice(0, MAX_PDF_RENDER_PAGES);
  return normalized.length ? normalized : [1];
}

const PY_PDF_RENDER_SCRIPT = String.raw`
import json, sys, os, math
import pypdfium2 as pdfium
from PIL import Image, ImageDraw

inp, outp, pages_raw, max_edge = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
pdf = pdfium.PdfDocument(inp)
page_count = len(pdf)

def parse_pages(raw):
    result = []
    for part in raw.replace(",", " ").split():
        if "-" in part:
            a, b = part.split("-", 1)
            if a.isdigit() and b.isdigit():
                lo, hi = sorted((int(a), int(b)))
                result.extend(range(lo, hi + 1))
        elif part.isdigit():
            result.append(int(part))
    seen = []
    for p in result or [1]:
        if 1 <= p <= page_count and p not in seen:
            seen.append(p)
    return seen[:6] or [1]

pages = parse_pages(pages_raw)
rendered = []
for pno in pages:
    page = pdf[pno - 1]
    pil = page.render(scale=2.0).to_pil().convert("RGB")
    pil.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    label_h = 28
    canvas = Image.new("RGB", (pil.width, pil.height + label_h), "white")
    canvas.paste(pil, (0, label_h))
    draw = ImageDraw.Draw(canvas)
    draw.text((8, 6), f"page {pno}/{page_count}", fill=(30, 30, 30))
    rendered.append(canvas)

if len(rendered) == 1:
    sheet = rendered[0]
else:
    gap = 16
    cols = 2 if len(rendered) > 1 else 1
    rows = math.ceil(len(rendered) / cols)
    cell_w = max(img.width for img in rendered)
    cell_h = max(img.height for img in rendered)
    sheet = Image.new("RGB", (cols * cell_w + (cols + 1) * gap, rows * cell_h + (rows + 1) * gap), (245, 245, 245))
    for i, img in enumerate(rendered):
        x = gap + (i % cols) * (cell_w + gap)
        y = gap + (i // cols) * (cell_h + gap)
        sheet.paste(img, (x, y))

sheet.save(outp, optimize=True)
print(json.dumps({"page_count": page_count, "pages": pages, "width": sheet.width, "height": sheet.height}, ensure_ascii=False))
`;

async function runPdfRender(config, params, ctx = {}) {
  const input = await resolveAllowedBotFile(config, readString(params, "pdf") || readString(params, "input") || readString(params, "document"), {
    label: "PDF",
    allowedExts: INPUT_PDF_EXTS,
    maxBytes: MAX_PDF_BYTES
  });
  const pages = readString(params, "pages", readString(params, "page", "1"));
  const maxEdge = readNumber(params, "maxEdge", 1400, 600, 2400);
  const outputDir = path.join(mediaRoot(config), "pdf-render");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${Date.now()}-${safeBaseName(readString(params, "filename"), path.basename(input.path, input.ext))}.png`);
  const { stdout } = await runPython(["-c", PY_PDF_RENDER_SCRIPT, input.path, outputPath, pages, String(maxEdge)]);
  const parsed = JSON.parse(stdout.trim() || "{}");
  const stat = await fs.stat(outputPath);
  const artifact = await recordArtifact(config, {
    artifactId: `pdf_${sha256(outputPath, 20)}`,
    kind: "pdf_render",
    source: "pdf_render",
    inputPath: input.path,
    mediaPath: outputPath,
    mimeType: "image/png",
    sizeBytes: stat.size,
    pages: parsed.pages,
    pageCount: parsed.page_count,
    width: parsed.width,
    height: parsed.height,
    summary: `Rendered PDF pages ${(parsed.pages || []).join(", ")} from ${path.basename(input.path)}`,
    tags: ["pdf", "render"]
  }, ctx);
  return { artifact, input, outputPath, sizeBytes: stat.size, ...parsed };
}

async function probeAv(inputPath) {
  const ffprobe = commandPath("@ffprobe-installer/ffprobe");
  const { stdout } = await runProcess(ffprobe, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    inputPath
  ], { timeoutMs: 20_000 });
  return JSON.parse(stdout || "{}");
}

function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function avSummary(meta) {
  const streams = Array.isArray(meta.streams) ? meta.streams : [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  return {
    duration: meta.format?.duration,
    size: meta.format?.size,
    format: meta.format?.format_name,
    videoCodec: video?.codec_name,
    width: video?.width,
    height: video?.height,
    audioCodec: audio?.codec_name,
    sampleRate: audio?.sample_rate
  };
}

async function runAvMedia(config, params, ctx = {}) {
  const input = await resolveAllowedBotFile(config, readString(params, "input") || readString(params, "media") || readString(params, "video") || readString(params, "audio"), {
    label: "audio/video",
    allowedExts: INPUT_AV_EXTS,
    maxBytes: MAX_AV_BYTES
  });
  const action = String(readString(params, "action", "probe")).toLowerCase();
  const meta = await probeAv(input.path);
  const summary = avSummary(meta);
  if (action === "probe") return { action, input, meta, summary };

  const ffmpeg = commandPath("@ffmpeg-installer/ffmpeg");
  const outputDir = path.join(mediaRoot(config), "av-media");
  await fs.mkdir(outputDir, { recursive: true });
  const base = safeBaseName(readString(params, "filename"), `${action}-${path.basename(input.path, input.ext)}`);
  let outputPath;
  let args;
  let mimeType;

  if (action === "extract_audio") {
    outputPath = path.join(outputDir, `${Date.now()}-${base}.mp3`);
    mimeType = "audio/mpeg";
    args = ["-hide_banner", "-loglevel", "error", "-y", "-i", input.path, "-vn", "-ac", "2", "-b:a", "128k", outputPath];
  } else if (action === "compress_video") {
    outputPath = path.join(outputDir, `${Date.now()}-${base}.mp4`);
    mimeType = "video/mp4";
    const maxEdge = readNumber(params, "maxEdge", 1280, 360, 1920);
    args = [
      "-hide_banner", "-loglevel", "error", "-y", "-i", input.path,
      "-vf", `scale='min(${maxEdge},iw)':-2`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
      "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
      outputPath
    ];
  } else if (action === "to_gif") {
    outputPath = path.join(outputDir, `${Date.now()}-${base}.gif`);
    mimeType = "image/gif";
    const duration = readNumber(params, "duration", 8, 1, 20);
    const maxEdge = readNumber(params, "maxEdge", 480, 160, 720);
    args = [
      "-hide_banner", "-loglevel", "error", "-y", "-t", String(duration), "-i", input.path,
      "-vf", `fps=10,scale=${maxEdge}:-1:flags=lanczos`,
      outputPath
    ];
  } else {
    throw new Error("action must be probe, extract_audio, compress_video, or to_gif");
  }

  await runProcess(ffmpeg, args, { timeoutMs: AV_TIMEOUT_MS });
  const stat = await fs.stat(outputPath);
  const artifact = await recordArtifact(config, {
    artifactId: `av_${sha256(outputPath, 20)}`,
    kind: "av_media",
    source: "av_media",
    action,
    inputPath: input.path,
    mediaPath: outputPath,
    mimeType,
    sizeBytes: stat.size,
    originalSizeBytes: input.stat.size,
    summary: `${action} ${path.basename(input.path)} -> ${path.basename(outputPath)}`,
    tags: ["audio-video", action]
  }, ctx);
  return { action, input, outputPath, mimeType, sizeBytes: stat.size, originalSizeBytes: input.stat.size, meta, summary, artifact };
}

function runTextToolkit(params) {
  const action = String(readString(params, "action", "json_format")).toLowerCase();
  const text = readString(params, "text") || readString(params, "input");
  if (action === "json_format" || action === "json_minify") {
    const parsed = JSON.parse(text);
    return action === "json_minify" ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2);
  }
  if (action === "hash") {
    const algo = String(readString(params, "algorithm", "sha256")).toLowerCase();
    if (!["sha256", "sha1", "md5"].includes(algo)) throw new Error("algorithm must be sha256, sha1, or md5");
    return crypto.createHash(algo).update(text).digest("hex");
  }
  if (action === "base64_encode") return Buffer.from(text, "utf8").toString("base64");
  if (action === "base64_decode") return Buffer.from(text, "base64").toString("utf8");
  if (action === "regex_test") {
    const pattern = readString(params, "pattern");
    const flags = readString(params, "flags", "g").replace(/[^gimsuy]/g, "");
    if (!pattern) throw new Error("pattern is required");
    const re = new RegExp(pattern, flags);
    const matches = [...text.matchAll(re)].slice(0, 50).map((match) => ({
      match: match[0],
      index: match.index,
      groups: match.slice(1)
    }));
    return JSON.stringify({ count: matches.length, matches }, null, 2);
  }
  if (action === "diff") {
    const left = String(isRecord(params) ? params.left ?? "" : "");
    const right = String(isRecord(params) ? params.right ?? "" : "");
    const a = left.split(/\r?\n/);
    const b = right.split(/\r?\n/);
    const max = Math.max(a.length, b.length);
    const lines = [];
    for (let i = 0; i < max; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] !== undefined) lines.push(`- ${i + 1}: ${a[i]}`);
      if (b[i] !== undefined) lines.push(`+ ${i + 1}: ${b[i]}`);
      if (lines.length >= 120) {
        lines.push("... diff truncated");
        break;
      }
    }
    return lines.length ? lines.join("\n") : "no differences";
  }
  throw new Error("unsupported text_toolkit action");
}

function watchStorePath(config) {
  return path.join(storeRoot(config), "web-watches.json");
}

async function loadWatches(config) {
  try {
    const raw = await fs.readFile(watchStorePath(config), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.watches) ? parsed.watches : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function saveWatches(config, watches) {
  const filePath = watchStorePath(config);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ version: 1, watches }, null, 2), "utf8");
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWatchSnapshot(url, signal) {
  const { finalUrl, chain } = await resolveRedirects(url, signal);
  await assertPublicHostname(new URL(finalUrl).hostname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("watch fetch timed out")), 15_000);
  const abortParent = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abortParent();
    else signal.addEventListener("abort", abortParent, { once: true });
  }
  try {
    const response = await fetch(finalUrl, {
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,*/*;q=0.8" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    const raw = await response.text();
    const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
    const text = contentType.includes("html") ? htmlToText(raw) : raw.replace(/\s+/g, " ").trim();
    return {
      finalUrl,
      chain,
      title,
      contentType,
      text: clip(text, 12_000),
      digest: sha256(text, 32)
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortParent);
  }
}

function artifactTerms(query) {
  const terms = [];
  const text = String(query || "").toLowerCase();
  for (const match of text.matchAll(/[a-z0-9_.:/-]{2,80}/gi)) terms.push(match[0].toLowerCase());
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,16}/g)) terms.push(match[0]);
  return [...new Set(terms)];
}

function scoreArtifact(record, terms) {
  if (terms.length === 0) return 1;
  const haystack = [
    record.artifactId,
    record.kind,
    record.source,
    record.title,
    record.url,
    record.summary,
    record.mediaPath,
    record.screenshotPath,
    record.textPath,
    ...(Array.isArray(record.tags) ? record.tags : [])
  ].join("\n").toLowerCase();
  let score = 0;
  for (const term of terms) {
    const count = haystack.split(term).length - 1;
    if (count > 0) score += count * (term.length + 2);
  }
  return score;
}

function formatArtifactLine(record, index) {
  const fields = [
    `${index}. id=${record.artifactId}`,
    `time=${record.t || ""}`,
    `kind=${record.kind || ""}`
  ];
  if (record.title) fields.push(`title=${clip(record.title, 120)}`);
  if (record.url) fields.push(`url=${record.url}`);
  if (record.action) fields.push(`action=${record.action}`);
  if (record.mimeType) fields.push(`mime=${record.mimeType}`);
  if (record.sizeBytes) fields.push(`size=${record.sizeBytes}`);
  if (record.summary) fields.push(`summary=${clip(record.summary, 180)}`);
  return fields.join(" | ");
}

function formatArtifactDetails(record) {
  if (!record) return "ARTIFACT_GET no match";
  const lines = [
    "ARTIFACT_GET ok",
    `id: ${record.artifactId}`,
    `time: ${record.t || ""}`,
    `kind: ${record.kind || ""}`
  ];
  if (record.title) lines.push(`title: ${record.title}`);
  if (record.url) lines.push(`url: ${record.url}`);
  if (record.summary) lines.push(`summary: ${clip(record.summary, 1200)}`);
  if (record.mediaPath) lines.push(`MEDIA: \`${record.mediaPath}\``);
  if (record.textPath) lines.push(`textArtifact: ${record.textPath}`);
  lines.push("Use MEDIA lines only when the user asks to receive the stored artifact. Do not expose local paths otherwise.");
  return lines.join("\n");
}

async function findArtifact(config, query, filter = {}) {
  const records = await loadArtifacts(config, filter);
  const key = String(query || "").trim().toLowerCase();
  return records.find((record) =>
    String(record.artifactId || "").toLowerCase() === key ||
    String(record.mediaPath || "").toLowerCase() === key ||
    String(record.screenshotPath || "").toLowerCase() === key
  ) || null;
}

function backgroundResultFromArtifact(prefix, result, extra = {}) {
  const artifact = result?.artifact || {};
  const mediaPath = result?.outputPath || artifact.mediaPath || artifact.screenshotPath || "";
  const text = [
    `${prefix} ok`,
    artifact.artifactId ? `artifact_id: ${artifact.artifactId}` : "",
    result?.title ? `title: ${result.title}` : "",
    result?.finalUrl ? `url: ${result.finalUrl}` : artifact.url ? `url: ${artifact.url}` : "",
    mediaPath ? `MEDIA: \`${mediaPath}\`` : "",
    extra.note || ""
  ].filter(Boolean).join("\n");
  return {
    status: "ok",
    resultText: text,
    artifactId: artifact.artifactId || "",
    title: result?.title || artifact.title || "",
    url: result?.finalUrl || artifact.url || "",
    mediaPath,
    textPath: artifact.textPath || result?.textPath || "",
    mimeType: artifact.mimeType || result?.mimeType || "",
    sizeBytes: artifact.sizeBytes || result?.sizeBytes || 0,
    ...extra
  };
}

async function queuePracticalJob({ toolName, config, params, ctx, label, timeoutMs, runner, formatter }) {
  return enqueueBackgroundTool({
    toolName,
    config,
    params,
    ctx,
    kind: `${toolName}.run`,
    label,
    payload: params,
    timeoutMs,
    handler: async ({ payload, signal, progress, context }) => {
      await progress({ percent: 5, note: `running ${toolName}` });
      const result = await runner(config, payload, signal, context);
      await progress({ percent: 95, note: `${toolName} completed` });
      return formatter(result);
    }
  });
}

const webSnapshotTool = {
  name: WEB_SNAPSHOT_TOOL,
  label: "Web Snapshot",
  description:
    "Open a public http/https webpage in a bot-owned Playwright temporary headless profile, save a screenshot, extract visible text, and record an artifact. " +
    "Use when the user needs page visuals, UI inspection, product/forum page reading, or a safe preview of a link.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", description: "Public http/https URL. Private/internal/local URLs are blocked." },
      fullPage: { type: "boolean", description: "Capture full page instead of the viewport. Default false." },
      width: { type: "number", description: "Viewport width, 360-1920. Default 1365." },
      height: { type: "number", description: "Viewport height, 360-1600. Default 768." },
      waitMs: { type: "number", description: "Extra wait after DOM load, 0-8000 ms. Default 1200." },
      includeText: { type: "boolean", description: "Extract visible text. Default true." },
      maxTextChars: { type: "number", description: "Max visible text chars returned, 500-12000. Default 6000." },
      filename: { type: "string", description: "Optional short safe filename hint." },
      actions: {
        type: "array",
        description: "Optional bounded interaction steps before screenshot. Supported types: click_text, click_selector, fill_selector, press, scroll, wait.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["click_text", "click_selector", "fill_selector", "press", "scroll", "wait"] },
            selector: { type: "string", description: "CSS selector for selector-based actions." },
            text: { type: "string", description: "Visible clickable text for click_text." },
            value: { type: "string", description: "Value for fill_selector." },
            key: { type: "string", description: "Keyboard key for press. Default Enter." },
            pixels: { type: "number", description: "Vertical scroll pixels, -3000 to 3000. Default 600." },
            waitMs: { type: "number", description: "Wait after this action, 0-8000 ms. Default 500." }
          }
        }
      },
      ...backgroundToolParameters()
    },
    required: ["url"]
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    try {
      const config = webSnapshotTool.config || {};
      if (shouldRunInBackground(params)) {
        return await queuePracticalJob({
          toolName: WEB_SNAPSHOT_TOOL,
          config,
          params,
          ctx,
          label: `web_snapshot ${readString(params, "url")}`,
          timeoutMs: WEB_TIMEOUT_MS + MAX_WEB_WAIT_MS + 15_000,
          runner: runWebSnapshot,
          formatter: (result) => backgroundResultFromArtifact("WEB_SNAPSHOT", result, {
            finalUrl: result.finalUrl,
            bodyText: clip(result.bodyText, 1200),
            width: result.width,
            height: result.height,
            actions: result.actions || [],
            risk: result.risk || null,
            riskStatus: result.riskStatus || "",
            browserProfile: result.browserProfile || ""
          })
        });
      }
      const result = await runWebSnapshot(config, params, signal, ctx);
      const image = await fs.readFile(result.outputPath);
      const text = [
        "WEB_SNAPSHOT ok",
        `artifact_id: ${result.artifact.artifactId}`,
        `title: ${result.title || "(untitled)"}`,
        `url: ${result.finalUrl}`,
        `screenshot: ${result.width}x${result.height}${result.fullPage ? " fullPage" : " viewport"}`,
        result.risk?.platform ? `account_browser: ${result.risk.platform.label} ${result.risk.tier || "interactive"} ${result.risk.hourCount || 0}/${result.risk.limits?.hourlyLimit || "?"}h ${result.risk.dailyCount || 0}/${result.risk.limits?.dailyLimit || "?"}d` : "",
        result.riskStatus ? `risk_status: ${result.riskStatus}` : "",
        result.actions?.length ? `actions: ${result.actions.map((entry) => `${entry.type}:${entry.status}`).join(" | ")}` : "",
        result.description ? `description: ${clip(result.description, 300)}` : "",
        result.headings?.length ? `headings: ${result.headings.slice(0, 8).join(" | ")}` : "",
        result.bodyText ? `visibleText:\n${clip(result.bodyText, 1600)}` : "",
        `MEDIA: \`${result.outputPath}\``,
        "Use the screenshot and visible text to answer. Include the MEDIA line only if the user asks to receive the screenshot."
      ].filter(Boolean).join("\n");
      return {
        content: [
          { type: "text", text },
          { type: "image", data: image.toString("base64"), mimeType: "image/png", fileName: path.basename(result.outputPath) }
        ],
        details: { status: "ok", artifact: result.artifact, url: result.finalUrl, path: result.outputPath, risk: result.risk || null, riskStatus: result.riskStatus || "", browserProfile: result.browserProfile || "", media: { path: result.outputPath, mediaUrl: result.outputPath, mimeType: "image/png", outbound: false } }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `WEB_SNAPSHOT error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const webCardTool = {
  name: WEB_CARD_TOOL,
  label: "Web Card",
  description:
    "Create a compact card for a public webpage: title, final URL, description/headings, short visible-text preview, screenshot, and artifact id. " +
    "Use for quick URL previews before deeper reading or screenshot delivery.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", description: "Public http/https URL. Private/internal/local URLs are blocked." },
      width: { type: "number", description: "Viewport width, 360-1920. Default 1200." },
      height: { type: "number", description: "Viewport height, 360-1600. Default 720." },
      waitMs: { type: "number", description: "Extra wait after DOM load, 0-8000 ms. Default 800." },
      actions: webSnapshotTool.parameters.properties.actions,
      ...backgroundToolParameters()
    },
    required: ["url"]
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    try {
      const config = webCardTool.config || {};
      const snapshotParams = {
        ...(params || {}),
        width: readNumber(params, "width", 1200, 360, 1920),
        height: readNumber(params, "height", 720, 360, 1600),
        waitMs: readNumber(params, "waitMs", 800, 0, MAX_WEB_WAIT_MS),
        fullPage: false,
        includeText: true,
        maxTextChars: 2500,
        filename: readString(params, "filename", "web-card")
      };
      if (shouldRunInBackground(params)) {
        return await queuePracticalJob({
          toolName: WEB_CARD_TOOL,
          config,
          params: snapshotParams,
          ctx,
          label: `web_card ${readString(params, "url")}`,
          timeoutMs: WEB_TIMEOUT_MS + MAX_WEB_WAIT_MS + 15_000,
          runner: runWebSnapshot,
          formatter: (result) => backgroundResultFromArtifact("WEB_CARD", result, {
            finalUrl: result.finalUrl,
            preview: clip(result.bodyText, 800),
            headings: result.headings?.slice(0, 6) || [],
            actions: result.actions || [],
            risk: result.risk || null,
            riskStatus: result.riskStatus || "",
            browserProfile: result.browserProfile || ""
          })
        });
      }
      const result = await runWebSnapshot(config, snapshotParams, signal, ctx);
      const image = await fs.readFile(result.outputPath);
      const lines = [
        "WEB_CARD ok",
        `artifact_id: ${result.artifact.artifactId}`,
        `title: ${result.title || "(untitled)"}`,
        `url: ${result.finalUrl}`,
        result.risk?.platform ? `account_browser: ${result.risk.platform.label} ${result.risk.tier || "interactive"} ${result.risk.hourCount || 0}/${result.risk.limits?.hourlyLimit || "?"}h ${result.risk.dailyCount || 0}/${result.risk.limits?.dailyLimit || "?"}d` : "",
        result.riskStatus ? `risk_status: ${result.riskStatus}` : "",
        result.description ? `description: ${clip(result.description, 260)}` : "",
        result.headings?.length ? `headings: ${result.headings.slice(0, 6).join(" | ")}` : "",
        result.actions?.length ? `actions: ${result.actions.map((entry) => `${entry.type}:${entry.status}`).join(" | ")}` : "",
        result.bodyText ? `preview:\n${clip(result.bodyText, 900)}` : "",
        `MEDIA: \`${result.outputPath}\``,
        "This is a compact preview card. Use web_snapshot for full-page or more detailed visual inspection."
      ].filter(Boolean);
      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "image", data: image.toString("base64"), mimeType: "image/png", fileName: path.basename(result.outputPath) }
        ],
        details: { status: "ok", artifact: result.artifact, url: result.finalUrl, path: result.outputPath, risk: result.risk || null, riskStatus: result.riskStatus || "", browserProfile: result.browserProfile || "", media: { path: result.outputPath, mediaUrl: result.outputPath, mimeType: "image/png", outbound: false } }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `WEB_CARD error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const mediaTransformTool = {
  name: MEDIA_TRANSFORM_TOOL,
  label: "Media Transform",
  description:
    "Transform a Telegram/bot-local image with sharp/libvips: compress, convert, resize, crop, rotate, flip, normalize, make sticker-sized WebP, or strip metadata. " +
    "Only accepts files from safe bot media directories.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      input: { type: "string", description: "Telegram/bot-local image path from delivered media, gallery, generated image, or artifact." },
      image: { type: "string", description: "Alias for input." },
      action: { type: "string", enum: ["compress", "convert", "resize", "sticker", "strip_exif", "crop", "rotate", "flip", "flop", "normalize", "grayscale", "blur", "sharpen"], description: "Transform action. Default compress." },
      format: { type: "string", enum: ["jpg", "png", "webp"], description: "Output format. Sticker always uses webp." },
      quality: { type: "number", description: "JPEG/WebP quality 30-98. Default 82 for compress, 90 otherwise." },
      width: { type: "number", description: "Optional max target width." },
      height: { type: "number", description: "Optional max target height." },
      maxEdge: { type: "number", description: "Optional max edge. Default 1600 for compress." },
      left: { type: "number", description: "Crop left pixel for action=crop." },
      top: { type: "number", description: "Crop top pixel for action=crop." },
      cropWidth: { type: "number", description: "Crop width in pixels for action=crop." },
      cropHeight: { type: "number", description: "Crop height in pixels for action=crop." },
      cropBox: { type: "string", description: "Crop box as 'left,top,width,height' pixels." },
      cropPercent: { type: "string", description: "Crop box as 'left,top,width,height' percentages." },
      aspectRatio: { type: "string", description: "Center crop aspect ratio for action=crop, e.g. square, 1:1, 16:9." },
      angle: { type: "number", description: "Rotation angle for action=rotate. Default 90." },
      sigma: { type: "number", description: "Blur sigma/radius for action=blur." },
      filename: { type: "string", description: "Optional safe filename hint." },
      ...backgroundToolParameters()
    }
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const config = mediaTransformTool.config || {};
      const claimed = claimToolTurnCall(MEDIA_TRANSFORM_TOOL, ctx);
      if (!claimed.ok) {
        return {
          content: [{ type: "text", text: claimed.text }],
          details: { status: "limited", tool: MEDIA_TRANSFORM_TOOL, count: claimed.count, limit: claimed.limit }
        };
      }
      if (shouldRunInBackground(params)) {
        return await queuePracticalJob({
          toolName: MEDIA_TRANSFORM_TOOL,
          config,
          params,
          ctx,
          label: `media_transform ${readString(params, "action", "compress")}`,
          timeoutMs: PYTHON_TIMEOUT_MS + 10_000,
          runner: async (jobConfig, payload, _signal, context) => runMediaTransform(jobConfig, payload, context),
          formatter: (result) => backgroundResultFromArtifact("MEDIA_TRANSFORM", result, {
            action: result.action,
            outputFormat: result.outputFormat,
            engine: result.engine,
            width: result.width,
            height: result.height,
            cropBox: result.cropBox ? `${result.cropBox.left},${result.cropBox.top},${result.cropBox.width},${result.cropBox.height}` : ""
          })
        });
      }
      const result = await runMediaTransform(config, params, ctx);
      const lines = [
        "MEDIA_TRANSFORM ok",
        `artifact_id: ${result.artifact.artifactId}`,
        `action: ${result.action}`,
        `format: ${result.outputFormat}`,
        `dimensions: ${result.width || "?"}x${result.height || "?"}`,
        `sizeBytes: ${result.sizeBytes}`,
        `engine: ${result.engine}`,
        result.cropBox ? `cropBox: ${result.cropBox.left},${result.cropBox.top},${result.cropBox.width},${result.cropBox.height}` : "",
        `MEDIA: \`${result.outputPath}\``,
        "A preview image is included in this tool result so you can visually verify the deterministic edit before replying.",
        "If the user asked to receive this file, include the MEDIA line exactly in the final reply."
      ].filter(Boolean);
      const preview = await buildImagePreviewContent(result.outputPath, result.mimeType);
      return {
        content: [{ type: "text", text: lines.join("\n") }, preview],
        details: { status: "ok", artifact: result.artifact, path: result.outputPath, media: { path: result.outputPath, mediaUrl: result.outputPath, mimeType: result.mimeType, outbound: false }, engine: result.engine, cropBox: result.cropBox, width: result.width, height: result.height, sizeBytes: result.sizeBytes }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `MEDIA_TRANSFORM error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const artifactRecentTool = {
  name: ARTIFACT_RECENT_TOOL,
  label: "Artifact Recent",
  description: "List recent locally recorded web snapshots and media transform artifacts.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      count: { type: "number", description: `Number of artifacts, 1-${MAX_RECENT}. Default ${DEFAULT_RECENT}.` },
      kind: { type: "string", description: "Optional kind filter, e.g. web_snapshot or media_transform." }
    }
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const config = artifactRecentTool.config || {};
      const filter = artifactScopeFilter(ctx, config);
      const count = readNumber(params, "count", DEFAULT_RECENT, 1, MAX_RECENT);
      const kind = readString(params, "kind").toLowerCase();
      const records = (await loadArtifacts(config, filter)).filter((record) => !kind || String(record.kind || "").toLowerCase() === kind).slice(0, count);
      const text = [`ARTIFACT_RECENT ok results=${records.length}`, "Use artifact_get for details or MEDIA resend."];
      records.forEach((record, index) => text.push(formatArtifactLine(record, index + 1)));
      return { content: [{ type: "text", text: text.join("\n") }], details: { status: "ok", results: records } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `ARTIFACT_RECENT error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const artifactSearchTool = {
  name: ARTIFACT_SEARCH_TOOL,
  label: "Artifact Search",
  description: "Search locally recorded web snapshots and media transform artifacts.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Search terms: title, URL, tag, artifact id, filename, summary." },
      count: { type: "number", description: `Number of artifacts, 1-${MAX_RECENT}. Default ${DEFAULT_RECENT}.` },
      kind: { type: "string", description: "Optional kind filter." }
    },
    required: ["query"]
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const config = artifactSearchTool.config || {};
      const filter = artifactScopeFilter(ctx, config);
      const count = readNumber(params, "count", DEFAULT_RECENT, 1, MAX_RECENT);
      const kind = readString(params, "kind").toLowerCase();
      const terms = artifactTerms(readString(params, "query"));
      const scored = (await loadArtifacts(config, filter))
        .filter((record) => !kind || String(record.kind || "").toLowerCase() === kind)
        .map((record) => ({ record, score: scoreArtifact(record, terms) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, count);
      const text = [`ARTIFACT_SEARCH ok results=${scored.length}`, "Use artifact_get for details or MEDIA resend."];
      scored.forEach((entry, index) => text.push(`${formatArtifactLine(entry.record, index + 1)} | score=${entry.score}`));
      return { content: [{ type: "text", text: text.join("\n") }], details: { status: "ok", results: scored.map((entry) => entry.record) } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `ARTIFACT_SEARCH error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const artifactGetTool = {
  name: ARTIFACT_GET_TOOL,
  label: "Artifact Get",
  description: "Get one recorded artifact by id or exact path, including a MEDIA line when it has a sendable file.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", description: "Artifact id, screenshot path, or media path." },
      artifact_id: { type: "string", description: "Alias for id." }
    }
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const config = artifactGetTool.config || {};
      const filter = artifactScopeFilter(ctx, config);
      const query = readString(params, "id") || readString(params, "artifact_id");
      const record = await findArtifact(config, query, filter);
      return { content: [{ type: "text", text: formatArtifactDetails(record) }], details: { status: record ? "ok" : "no_match", result: record } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `ARTIFACT_GET error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const qrTool = {
  name: QR_TOOL,
  label: "QR Tool",
  description: "Generate a QR code image or decode QR codes from Telegram/bot-local images.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["generate", "decode"], description: "generate creates a QR image; decode reads QR content from an image." },
      text: { type: "string", description: "Text/content for generate." },
      content: { type: "string", description: "Alias for text." },
      image: { type: "string", description: "Bot-local image path for decode." },
      input: { type: "string", description: "Alias for image." },
      filename: { type: "string", description: "Optional safe filename hint." },
      boxSize: { type: "number", description: "QR module size, 4-24. Default 10." },
      border: { type: "number", description: "QR border modules, 1-10. Default 4." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const config = qrTool.config || {};
      const action = String(readString(params, "action", "generate")).toLowerCase();
      if (action === "generate") {
        const result = await runQrGenerate(config, params, ctx);
        const image = await fs.readFile(result.outputPath);
        const text = [
          "QR_TOOL ok action=generate",
          `artifact_id: ${result.artifact.artifactId}`,
          `dimensions: ${result.width}x${result.height}`,
          `sizeBytes: ${result.sizeBytes}`,
          `MEDIA: \`${result.outputPath}\``,
          "If the user asked to receive this QR code, include the MEDIA line exactly in the final reply."
        ].join("\n");
        return {
          content: [
            { type: "text", text },
            { type: "image", data: image.toString("base64"), mimeType: "image/png", fileName: path.basename(result.outputPath) }
          ],
          details: { status: "ok", action, artifact: result.artifact, path: result.outputPath, media: { path: result.outputPath, mediaUrl: result.outputPath, mimeType: "image/png", outbound: false } }
        };
      }
      if (action === "decode") {
        const result = await runQrDecode(config, params);
        const lines = [
          "QR_TOOL ok action=decode",
          `input: ${path.basename(result.input.path)}`,
          `results: ${result.results.length}`
        ];
        for (const [index, entry] of result.results.entries()) lines.push(`${index + 1}. ${entry.rawValue}`);
        if (result.results.length === 0) lines.push("No QR code detected.");
        return { content: [{ type: "text", text: lines.join("\n") }], details: { status: "ok", action, results: result.results } };
      }
      throw new Error("action must be generate or decode");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `QR_TOOL error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const pdfRenderTool = {
  name: PDF_RENDER_TOOL,
  label: "PDF Render",
  description: "Render pages from a Telegram/bot-local PDF into a PNG page image/contact sheet for visual reading.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      pdf: { type: "string", description: "Bot-local PDF path." },
      input: { type: "string", description: "Alias for pdf." },
      document: { type: "string", description: "Alias for pdf." },
      page: { type: "string", description: "One-based page number, e.g. 1." },
      pages: { type: "string", description: "One-based pages/ranges, e.g. 1,3-4. Max 6 pages." },
      maxEdge: { type: "number", description: "Max rendered edge, 600-2400. Default 1400." },
      filename: { type: "string", description: "Optional safe filename hint." },
      ...backgroundToolParameters()
    }
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const config = pdfRenderTool.config || {};
      if (shouldRunInBackground(params)) {
        return await queuePracticalJob({
          toolName: PDF_RENDER_TOOL,
          config,
          params,
          ctx,
          label: "pdf_render",
          timeoutMs: PYTHON_TIMEOUT_MS + 20_000,
          runner: async (jobConfig, payload, _signal, context) => runPdfRender(jobConfig, payload, context),
          formatter: (result) => backgroundResultFromArtifact("PDF_RENDER", result, {
            pages: result.pages,
            pageCount: result.page_count,
            width: result.width,
            height: result.height
          })
        });
      }
      const result = await runPdfRender(config, params, ctx);
      const image = await fs.readFile(result.outputPath);
      const text = [
        "PDF_RENDER ok",
        `artifact_id: ${result.artifact.artifactId}`,
        `input: ${path.basename(result.input.path)}`,
        `pages: ${(result.pages || []).join(", ")} / ${result.page_count}`,
        `dimensions: ${result.width}x${result.height}`,
        `MEDIA: \`${result.outputPath}\``,
        "Use the rendered page image to answer. Include the MEDIA line only if the user asks to receive it."
      ].join("\n");
      return {
        content: [
          { type: "text", text },
          { type: "image", data: image.toString("base64"), mimeType: "image/png", fileName: path.basename(result.outputPath) }
        ],
        details: { status: "ok", artifact: result.artifact, path: result.outputPath, media: { path: result.outputPath, mediaUrl: result.outputPath, mimeType: "image/png", outbound: false } }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `PDF_RENDER error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const avMediaTool = {
  name: AV_MEDIA_TOOL,
  label: "Audio Video Media",
  description: "Probe or lightly transform Telegram/bot-local audio/video: extract audio, compress video, or make a short GIF.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      input: { type: "string", description: "Bot-local audio/video path." },
      media: { type: "string", description: "Alias for input." },
      video: { type: "string", description: "Alias for input." },
      audio: { type: "string", description: "Alias for input." },
      action: { type: "string", enum: ["probe", "extract_audio", "compress_video", "to_gif"], description: "Default probe." },
      maxEdge: { type: "number", description: "Max video edge for compress/gif." },
      duration: { type: "number", description: "Max seconds for GIF, 1-20. Default 8." },
      filename: { type: "string", description: "Optional safe filename hint." },
      ...backgroundToolParameters()
    }
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const config = avMediaTool.config || {};
      if (shouldRunInBackground(params)) {
        return await queuePracticalJob({
          toolName: AV_MEDIA_TOOL,
          config,
          params,
          ctx,
          label: `av_media ${readString(params, "action", "probe")}`,
          timeoutMs: AV_TIMEOUT_MS + 15_000,
          runner: async (jobConfig, payload, _signal, context) => runAvMedia(jobConfig, payload, context),
          formatter: (result) => {
            if (result.action === "probe") {
              return {
                status: "ok",
                resultText: [
                  "AV_MEDIA ok action=probe",
                  `duration: ${formatDuration(result.summary.duration)}`,
                  `format: ${result.summary.format || "unknown"}`,
                  result.summary.videoCodec ? `video: ${result.summary.videoCodec} ${result.summary.width || "?"}x${result.summary.height || "?"}` : "",
                  result.summary.audioCodec ? `audio: ${result.summary.audioCodec} ${result.summary.sampleRate || ""}` : ""
                ].filter(Boolean).join("\n"),
                summary: result.summary
              };
            }
            return backgroundResultFromArtifact("AV_MEDIA", result, {
              action: result.action,
              summary: result.summary
            });
          }
        });
      }
      const result = await runAvMedia(config, params, ctx);
      const s = result.summary;
      if (result.action === "probe") {
        const text = [
          "AV_MEDIA ok action=probe",
          `input: ${path.basename(result.input.path)}`,
          `duration: ${formatDuration(s.duration)}`,
          `format: ${s.format || "unknown"}`,
          s.videoCodec ? `video: ${s.videoCodec} ${s.width || "?"}x${s.height || "?"}` : "",
          s.audioCodec ? `audio: ${s.audioCodec} ${s.sampleRate || ""}` : "",
          s.size ? `sizeBytes: ${s.size}` : ""
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text }], details: { status: "ok", action: result.action, summary: s, meta: result.meta } };
      }
      const text = [
        `AV_MEDIA ok action=${result.action}`,
        `artifact_id: ${result.artifact.artifactId}`,
        `input: ${path.basename(result.input.path)}`,
        `sizeBytes: ${result.sizeBytes}`,
        `MEDIA: \`${result.outputPath}\``,
        "If the user asked to receive this file, include the MEDIA line exactly in the final reply."
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { status: "ok", action: result.action, artifact: result.artifact, path: result.outputPath, media: { path: result.outputPath, mediaUrl: result.outputPath, mimeType: result.mimeType, outbound: false } }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `AV_MEDIA error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const textToolkitTool = {
  name: TEXT_TOOLKIT_TOOL,
  label: "Text Toolkit",
  description: "Safe text utilities: JSON format/minify, regex test, hash, base64 encode/decode, and simple line diff. No arbitrary code execution.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["json_format", "json_minify", "regex_test", "hash", "base64_encode", "base64_decode", "diff"], description: "Text utility action." },
      text: { type: "string", description: "Input text for most actions." },
      input: { type: "string", description: "Alias for text." },
      pattern: { type: "string", description: "Regex pattern for regex_test." },
      flags: { type: "string", description: "Regex flags for regex_test." },
      algorithm: { type: "string", enum: ["sha256", "sha1", "md5"], description: "Hash algorithm." },
      left: { type: "string", description: "Left text for diff." },
      right: { type: "string", description: "Right text for diff." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params) {
    try {
      const output = runTextToolkit(params);
      return { content: [{ type: "text", text: `TEXT_TOOLKIT ok\n${clip(output, 5000)}` }], details: { status: "ok", output } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `TEXT_TOOLKIT error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const webWatchAddTool = {
  name: WEB_WATCH_ADD_TOOL,
  label: "Web Watch Add",
  description: "Store a public URL watch and its current digest for later manual change checks.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", description: "Public http/https URL to watch." },
      name: { type: "string", description: "Optional short watch name." }
    },
    required: ["url"]
  },
  async execute(_toolCallId, params, signal) {
    try {
      const config = webWatchAddTool.config || {};
      const snapshot = await fetchWatchSnapshot(readString(params, "url"), signal);
      const watches = await loadWatches(config);
      const id = `watch_${sha256(snapshot.finalUrl, 14)}`;
      const watch = {
        id,
        name: readString(params, "name") || snapshot.title || snapshot.finalUrl,
        url: snapshot.finalUrl,
        createdAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        digest: snapshot.digest,
        title: snapshot.title,
        preview: clip(snapshot.text, 500)
      };
      const next = watches.filter((entry) => entry.id !== id);
      next.unshift(watch);
      await saveWatches(config, next);
      return { content: [{ type: "text", text: `WEB_WATCH_ADD ok\nid: ${id}\ntitle: ${watch.title}\nurl: ${watch.url}\ndigest: ${watch.digest}` }], details: { status: "ok", watch } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `WEB_WATCH_ADD error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const webWatchListTool = {
  name: WEB_WATCH_LIST_TOOL,
  label: "Web Watch List",
  description: "List stored public URL watches.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async execute() {
    try {
      const watches = await loadWatches(webWatchListTool.config || {});
      const lines = [`WEB_WATCH_LIST ok results=${watches.length}`];
      watches.slice(0, 30).forEach((watch, index) => lines.push(`${index + 1}. id=${watch.id} | checked=${watch.checkedAt || ""} | title=${clip(watch.name || watch.title || "", 120)} | url=${watch.url}`));
      return { content: [{ type: "text", text: lines.join("\n") }], details: { status: "ok", watches } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `WEB_WATCH_LIST error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

async function runWebWatchCheck(config, params, signal) {
  const id = readString(params, "id");
  const update = readBoolean(params, "update", true);
  const watches = await loadWatches(config);
  const selected = id ? watches.filter((watch) => watch.id === id) : watches;
  if (id && selected.length === 0) return { status: "no_match", checked: [], id };
  const checked = [];
  for (const watch of selected.slice(0, 10)) {
    const snapshot = await fetchWatchSnapshot(watch.url, signal);
    const changed = snapshot.digest !== watch.digest;
    checked.push({ id: watch.id, url: watch.url, title: snapshot.title, changed, oldDigest: watch.digest, newDigest: snapshot.digest, preview: clip(snapshot.text, 500) });
    if (update) {
      watch.checkedAt = new Date().toISOString();
      watch.digest = snapshot.digest;
      watch.title = snapshot.title;
      watch.preview = clip(snapshot.text, 500);
    }
  }
  if (update) await saveWatches(config, watches);
  return { status: "ok", checked };
}

const webWatchCheckTool = {
  name: WEB_WATCH_CHECK_TOOL,
  label: "Web Watch Check",
  description: "Check one or all stored public URL watches for digest changes. Manual/on-demand; no background sending.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", description: "Watch id. Omit to check all watches." },
      update: { type: "boolean", description: "Whether to store the new digest after checking. Default true." },
      ...backgroundToolParameters()
    }
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    try {
      const config = webWatchCheckTool.config || {};
      if (shouldRunInBackground(params)) {
        return await queuePracticalJob({
          toolName: WEB_WATCH_CHECK_TOOL,
          config,
          params,
          ctx,
          label: `web_watch_check ${readString(params, "id") || "all"}`,
          timeoutMs: WEB_TIMEOUT_MS * 10 + 10_000,
          runner: async (jobConfig, payload, jobSignal) => runWebWatchCheck(jobConfig, payload, jobSignal),
          formatter: (result) => ({
            status: "ok",
            resultText: [
              `WEB_WATCH_CHECK ok results=${result.checked.length}`,
              ...result.checked.map((entry, index) => `${index + 1}. id=${entry.id} | changed=${entry.changed} | title=${clip(entry.title, 120)} | url=${entry.url}`)
            ].join("\n"),
            checked: result.checked
          })
        });
      }
      const id = readString(params, "id");
      const update = readBoolean(params, "update", true);
      const watches = await loadWatches(config);
      const selected = id ? watches.filter((watch) => watch.id === id) : watches;
      if (id && selected.length === 0) return { content: [{ type: "text", text: `WEB_WATCH_CHECK no match id=${id}` }], details: { status: "no_match" } };
      const checked = [];
      for (const watch of selected.slice(0, 10)) {
        const snapshot = await fetchWatchSnapshot(watch.url, signal);
        const changed = snapshot.digest !== watch.digest;
        checked.push({ id: watch.id, url: watch.url, title: snapshot.title, changed, oldDigest: watch.digest, newDigest: snapshot.digest, preview: clip(snapshot.text, 500) });
        if (update) {
          watch.checkedAt = new Date().toISOString();
          watch.digest = snapshot.digest;
          watch.title = snapshot.title;
          watch.preview = clip(snapshot.text, 500);
        }
      }
      if (update) await saveWatches(config, watches);
      const lines = [`WEB_WATCH_CHECK ok results=${checked.length}`];
      checked.forEach((entry, index) => lines.push(`${index + 1}. id=${entry.id} | changed=${entry.changed} | title=${clip(entry.title, 120)} | url=${entry.url}`));
      return { content: [{ type: "text", text: lines.join("\n") }], details: { status: "ok", checked } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `WEB_WATCH_CHECK error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

const webWatchDeleteTool = {
  name: WEB_WATCH_DELETE_TOOL,
  label: "Web Watch Delete",
  description: "Delete one stored public URL watch.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { id: { type: "string", description: "Watch id." } },
    required: ["id"]
  },
  async execute(_toolCallId, params) {
    try {
      const config = webWatchDeleteTool.config || {};
      const id = readString(params, "id");
      const watches = await loadWatches(config);
      const next = watches.filter((watch) => watch.id !== id);
      await saveWatches(config, next);
      return { content: [{ type: "text", text: `WEB_WATCH_DELETE ok id=${id} deleted=${next.length !== watches.length}` }], details: { status: "ok", deleted: next.length !== watches.length } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `WEB_WATCH_DELETE error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

export const __testing = {
  normalizeUrlInput,
  assertPublicHostname,
  resolveRedirects,
  resolveAllowedMediaInput,
  resolveAllowedBotFile,
  runMediaTransform,
  runWebSnapshot,
  runQrGenerate,
  runQrDecode,
  runPdfRender,
  runAvMedia,
  runTextToolkit,
  fetchWatchSnapshot,
  runWebWatchCheck,
  readWebActions,
  applyWebActions,
  accountBrowserPlatformForUrl,
  accountBrowserPolicy,
  accountBrowserActionProfile,
  claimBrowserRiskVisit,
  recordBrowserRiskEvent,
  classifyBrowserRiskPage,
  readBrowserRiskState,
  browserRiskStatePath,
  loadArtifacts,
  recordArtifact,
  accountBrowserProfileDir,
  assertBrowserRequestUrlAllowed,
  scoreArtifact,
  safeBaseName,
  isPrivateIp,
  closeBrowserContextPool
};

export default {
  id: "imagebot-practical-tools",
  name: "Imagebot Practical Tools",
  description: "Bounded webpage snapshots, media transforms, and artifact lookup.",
  register(api) {
    const config = api.config || {};
    webSnapshotTool.config = config;
    webCardTool.config = config;
    mediaTransformTool.config = config;
    artifactRecentTool.config = config;
    artifactSearchTool.config = config;
    artifactGetTool.config = config;
    qrTool.config = config;
    pdfRenderTool.config = config;
    avMediaTool.config = config;
    textToolkitTool.config = config;
    webWatchAddTool.config = config;
    webWatchListTool.config = config;
    webWatchCheckTool.config = config;
    webWatchDeleteTool.config = config;
    scheduleWebSnapshotBrowserPrewarm(config);
    api.registerTool(webSnapshotTool, { name: WEB_SNAPSHOT_TOOL });
    api.registerTool(webCardTool, { name: WEB_CARD_TOOL });
    api.registerTool(mediaTransformTool, { name: MEDIA_TRANSFORM_TOOL });
    api.registerTool(artifactRecentTool, { name: ARTIFACT_RECENT_TOOL });
    api.registerTool(artifactSearchTool, { name: ARTIFACT_SEARCH_TOOL });
    api.registerTool(artifactGetTool, { name: ARTIFACT_GET_TOOL });
    api.registerTool(qrTool, { name: QR_TOOL });
    api.registerTool(pdfRenderTool, { name: PDF_RENDER_TOOL });
    api.registerTool(avMediaTool, { name: AV_MEDIA_TOOL });
    api.registerTool(textToolkitTool, { name: TEXT_TOOLKIT_TOOL });
    api.registerTool(webWatchAddTool, { name: WEB_WATCH_ADD_TOOL });
    api.registerTool(webWatchListTool, { name: WEB_WATCH_LIST_TOOL });
    api.registerTool(webWatchCheckTool, { name: WEB_WATCH_CHECK_TOOL });
    api.registerTool(webWatchDeleteTool, { name: WEB_WATCH_DELETE_TOOL });
  }
};

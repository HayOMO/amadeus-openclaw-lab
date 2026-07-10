import fs from "node:fs/promises";
import { openclawStatePath } from "../imagebot-shared/openclaw-paths.mjs";

const ZHIHU_SEARCH_TOOL = "zhihu_search";
const ZHIHU_GLOBAL_SEARCH_TOOL = "zhihu_global_search";
const ZHIHU_HOT_LIST_TOOL = "zhihu_hot_list";
const ZHIHU_TOOL = "zhihu";
const BASE_URL = "https://developer.zhihu.com";
const REQUEST_TIMEOUT_MS = Number(process.env.IMAGEBOT_ZHIHU_TIMEOUT_MS || "18000");
const DEFAULT_SEARCH_COUNT = 5;
const MAX_ZHIHU_COUNT = 10;
const MAX_GLOBAL_COUNT = 20;
const DEFAULT_HOT_LIMIT = 10;
const MAX_HOT_LIMIT = 30;
const CACHE_TTL_MS = 10 * 60 * 1000;
const HOT_CACHE_TTL_MS = 2 * 60 * 1000;
const SECRET_FILE = openclawStatePath("secrets", "zhihu-access-secret.token");

const cache = new Map();

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  return typeof value === "string" ? value.trim() : fallback;
}

function readBoundedInt(params, key, fallback, min, max) {
  const raw = isRecord(params) ? params[key] : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function timeoutSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs);
  let removeParentListener = () => {};
  if (parent) {
    const abortFromParent = () => controller.abort(parent.reason);
    if (parent.aborted) abortFromParent();
    else {
      parent.addEventListener("abort", abortFromParent, { once: true });
      removeParentListener = () => parent.removeEventListener("abort", abortFromParent);
    }
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      removeParentListener();
    }
  };
}

async function readAccessSecret() {
  const fromEnv = process.env.ZHIHU_ACCESS_SECRET || process.env.OPENCLAW_ZHIHU_ACCESS_SECRET;
  if (fromEnv?.trim()) return fromEnv.trim();
  try {
    return (await fs.readFile(SECRET_FILE, "utf-8")).trim();
  } catch {
    return "";
  }
}

function normalizeCode(payload) {
  const raw = payload?.Code ?? payload?.code;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const value = Number(raw);
    return Number.isFinite(value) ? value : raw;
  }
  return undefined;
}

function normalizeMessage(payload) {
  return String(payload?.Message ?? payload?.message ?? payload?.error?.message ?? "").trim();
}

function unavailable(tool, reason, extra = {}) {
  const detail = extra.code != null ? ` code=${extra.code}` : "";
  const message = extra.message ? `: ${extra.message}` : "";
  return {
    content: [
      {
        type: "text",
        text: `${tool.toUpperCase()} unavailable (${reason}${detail})${message}\nIf public search is still needed, use explicit_web_text_search once as a bounded fallback.`
      }
    ],
    details: {
      status: "unavailable",
      reason,
      ...extra
    }
  };
}

function failure(tool, message) {
  return {
    content: [{ type: "text", text: `${tool.toUpperCase()} error: ${message}\nDo not retry this Zhihu tool in the same turn. Use explicit_web_text_search once if public search is still needed.` }],
    details: { status: "failed", error: message }
  };
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function clip(value, max = 420) {
  const text = stripHtml(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 12)).trimEnd()}...`;
}

function formatUnixSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  try {
    return new Date(seconds * 1000).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function requestZhihu(pathname, params, signal) {
  const secret = await readAccessSecret();
  if (!secret) {
    return { unavailable: true, reason: "missing_access_secret" };
  }
  const url = new URL(pathname, BASE_URL);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && String(value) !== "") url.searchParams.set(key, String(value));
  }
  const request = timeoutSignal(signal, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: request.signal,
      headers: {
        authorization: `Bearer ${secret}`,
        "x-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "content-type": "application/json",
        accept: "application/json"
      }
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`non-JSON response from Zhihu OpenAPI (HTTP ${response.status})`);
    }
    if (!response.ok) {
      return {
        unavailable: true,
        reason: response.status === 401 || response.status === 403 ? "auth_or_permission" : "http_error",
        code: response.status,
        message: normalizeMessage(payload) || `HTTP ${response.status}`
      };
    }
    const code = normalizeCode(payload);
    if (code !== undefined && code !== 0) {
      const reason = code === 20001 ? "auth_or_permission" : code === 30001 ? "rate_limited" : "api_error";
      return { unavailable: true, reason, code, message: normalizeMessage(payload) || "Zhihu OpenAPI returned a non-zero code" };
    }
    return { payload };
  } finally {
    request.cleanup();
  }
}

function normalizeSearchItem(item) {
  if (!isRecord(item)) return null;
  const title = stripHtml(item.Title);
  const url = String(item.Url || "").trim();
  if (!title && !url) return null;
  return {
    title,
    contentType: String(item.ContentType || "").trim(),
    contentId: String(item.ContentID || "").trim(),
    summary: clip(item.ContentText, 520),
    url,
    commentCount: Number.isFinite(Number(item.CommentCount)) ? Number(item.CommentCount) : undefined,
    voteUpCount: Number.isFinite(Number(item.VoteUpCount)) ? Number(item.VoteUpCount) : undefined,
    authorName: stripHtml(item.AuthorName),
    authorBadgeText: stripHtml(item.AuthorBadgeText),
    editTime: Number.isFinite(Number(item.EditTime)) ? Number(item.EditTime) : undefined,
    authorityLevel: String(item.AuthorityLevel || "").trim(),
    rankingScore: Number.isFinite(Number(item.RankingScore)) ? Number(item.RankingScore) : undefined
  };
}

function normalizeHotItem(item) {
  if (!isRecord(item)) return null;
  const title = stripHtml(item.Title);
  const url = String(item.Url || "").trim();
  if (!title && !url) return null;
  return {
    title,
    url,
    thumbnailUrl: String(item.ThumbnailUrl || "").trim(),
    summary: clip(item.Summary, 360)
  };
}

function summarizeMeta(item) {
  const parts = [];
  if (item.contentType) parts.push(item.contentType);
  if (item.authorName) parts.push(`author=${item.authorName}`);
  if (item.voteUpCount !== undefined) parts.push(`votes=${item.voteUpCount}`);
  if (item.commentCount !== undefined) parts.push(`comments=${item.commentCount}`);
  const date = formatUnixSeconds(item.editTime);
  if (date) parts.push(`date=${date}`);
  if (item.authorityLevel) parts.push(`authority=${item.authorityLevel}`);
  return parts.join(" | ");
}

function formatSearchResults(label, query, items, { hasMore, searchHashId, emptyReason } = {}) {
  if (!items.length) {
    return [
      `${label} ok query="${query}" item_count=0`,
      emptyReason ? `EmptyReason: ${stripHtml(emptyReason)}` : "No results returned.",
      "If public search is still needed, use explicit_web_text_search once as a fallback."
    ].join("\n");
  }
  const lines = [`${label} ok query="${query}" item_count=${items.length}${hasMore ? " has_more=true" : ""}${searchHashId ? ` search_hash_id=${searchHashId}` : ""}`];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title || "(untitled)"}`);
    const meta = summarizeMeta(item);
    if (meta) lines.push(`   ${meta}`);
    if (item.summary) lines.push(`   ${item.summary}`);
    if (item.url) lines.push(`   ${item.url}`);
  });
  return lines.join("\n");
}

function formatHotList(items, total) {
  if (!items.length) return "ZHIHU_HOT_LIST ok item_count=0\nNo hot-list items returned.";
  const lines = [`ZHIHU_HOT_LIST ok total=${total ?? items.length} item_count=${items.length}`];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title || "(untitled)"}`);
    if (item.summary) lines.push(`   ${item.summary}`);
    if (item.url) lines.push(`   ${item.url}`);
    if (item.thumbnailUrl) lines.push(`   thumbnail=${item.thumbnailUrl}`);
  });
  return lines.join("\n");
}

async function executeSearchTool(toolName, params, signal, options) {
  const query = readString(params, "query");
  if (!query) {
    return failure(toolName, "query is required");
  }
  const count = readBoundedInt(params, "count", DEFAULT_SEARCH_COUNT, 1, options.maxCount);
  const cacheKey = `${toolName}:${query.toLowerCase()}:${count}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const result = await requestZhihu(options.path, { Query: query, Count: count }, signal);
    if (result.unavailable) return unavailable(toolName, result.reason, { code: result.code, message: result.message });
    const data = result.payload?.Data ?? result.payload?.data ?? {};
    const rawItems = Array.isArray(data.Items) ? data.Items : Array.isArray(data.items) ? data.items : [];
    const items = rawItems.map(normalizeSearchItem).filter(Boolean).slice(0, count);
    const response = {
      content: [{ type: "text", text: formatSearchResults(options.label, query, items, {
        hasMore: Boolean(data.HasMore ?? data.hasMore),
        searchHashId: String(data.SearchHashId || data.searchHashId || "").trim(),
        emptyReason: data.EmptyReason ?? data.emptyReason
      }) }],
      details: { status: "ok", query, count: items.length, hasMore: Boolean(data.HasMore ?? data.hasMore), results: items }
    };
    cacheSet(cacheKey, response, CACHE_TTL_MS);
    return response;
  } catch (error) {
    return failure(toolName, error instanceof Error ? error.message : String(error));
  }
}

const zhihuSearchTool = {
  name: ZHIHU_SEARCH_TOOL,
  label: "Zhihu Search",
  description: "Search Zhihu Open Platform station results. Default for questions like '知乎上怎么说', Zhihu answers/articles, and China-focused discussion references.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Search keywords, 2-100 characters recommended." },
      count: { type: "number", description: `Number of results, 1-${MAX_ZHIHU_COUNT}. Default ${DEFAULT_SEARCH_COUNT}.` }
    },
    required: ["query"]
  },
  async execute(_toolCallId, params, signal) {
    return executeSearchTool(ZHIHU_SEARCH_TOOL, params, signal, {
      path: "/api/v1/content/zhihu_search",
      label: "ZHIHU_SEARCH",
      maxCount: MAX_ZHIHU_COUNT
    });
  }
};

const zhihuGlobalSearchTool = {
  name: ZHIHU_GLOBAL_SEARCH_TOOL,
  label: "Zhihu Global Search",
  description: "Search public web content through Zhihu Open Platform. Use for Zhihu-specific, Chinese/community, or fallback public search; explicit_web_text_search is the bounded general fallback.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Search keywords, 2-100 characters recommended." },
      count: { type: "number", description: `Number of results, 1-${MAX_GLOBAL_COUNT}. Default ${DEFAULT_SEARCH_COUNT}.` }
    },
    required: ["query"]
  },
  async execute(_toolCallId, params, signal) {
    return executeSearchTool(ZHIHU_GLOBAL_SEARCH_TOOL, params, signal, {
      path: "/api/v1/content/global_search",
      label: "ZHIHU_GLOBAL_SEARCH",
      maxCount: MAX_GLOBAL_COUNT
    });
  }
};

const zhihuHotListTool = {
  name: ZHIHU_HOT_LIST_TOOL,
  label: "Zhihu Hot List",
  description: "Fetch the current Zhihu hot list. Use when the user asks for Zhihu hot topics, hotlist, trending topics, or group chat material from Zhihu.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "number", description: `Number of hot-list items, 1-${MAX_HOT_LIMIT}. Default ${DEFAULT_HOT_LIMIT}.` }
    }
  },
  async execute(_toolCallId, params, signal) {
    const limit = readBoundedInt(params, "limit", DEFAULT_HOT_LIMIT, 1, MAX_HOT_LIMIT);
    const cacheKey = `${ZHIHU_HOT_LIST_TOOL}:${limit}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    try {
      const result = await requestZhihu("/api/v1/content/hot_list", { Limit: limit }, signal);
      if (result.unavailable) return unavailable(ZHIHU_HOT_LIST_TOOL, result.reason, { code: result.code, message: result.message });
      const data = result.payload?.Data ?? result.payload?.data ?? {};
      const rawItems = Array.isArray(data.Items) ? data.Items : Array.isArray(data.items) ? data.items : [];
      const items = rawItems.map(normalizeHotItem).filter(Boolean).slice(0, limit);
      const response = {
        content: [{ type: "text", text: formatHotList(items, data.Total ?? data.total) }],
        details: { status: "ok", limit, total: data.Total ?? data.total ?? items.length, results: items }
      };
      cacheSet(cacheKey, response, HOT_CACHE_TTL_MS);
      return response;
    } catch (error) {
      return failure(ZHIHU_HOT_LIST_TOOL, error instanceof Error ? error.message : String(error));
    }
  }
};

const zhihuTool = {
  name: ZHIHU_TOOL,
  label: "Zhihu",
  description: "Search Zhihu/OpenAPI content through action=search, global_search, or hot_list.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["search", "global_search", "hot_list"],
        description: "Zhihu action. Default search when query is supplied; hot_list when only limit is supplied."
      },
      query: { type: "string", description: "Search keywords, 2-100 characters recommended." },
      count: { type: "number", description: `Search result count, 1-${MAX_GLOBAL_COUNT}.` },
      limit: { type: "number", description: `Hot-list item count, 1-${MAX_HOT_LIMIT}.` }
    }
  },
  async execute(toolCallId, params, signal) {
    const requested = readString(params, "action").toLowerCase();
    const action = requested || (readString(params, "query") ? "search" : "hot_list");
    if (action === "search") return zhihuSearchTool.execute(toolCallId, params, signal);
    if (action === "global_search") return zhihuGlobalSearchTool.execute(toolCallId, params, signal);
    if (action === "hot_list") return zhihuHotListTool.execute(toolCallId, params, signal);
    return failure(ZHIHU_TOOL, "action must be search, global_search, or hot_list");
  }
};

export const __testing = {
  stripHtml,
  normalizeSearchItem,
  normalizeHotItem,
  formatSearchResults,
  formatHotList
};

export default {
  id: "zhihu-openapi",
  name: "Zhihu OpenAPI",
  description: "Searches Zhihu Open Platform public search and hot-list APIs.",
  register(api) {
    api.registerTool(zhihuTool, { name: ZHIHU_TOOL });
    api.registerTool(zhihuSearchTool, { name: ZHIHU_SEARCH_TOOL });
    api.registerTool(zhihuGlobalSearchTool, { name: ZHIHU_GLOBAL_SEARCH_TOOL });
    api.registerTool(zhihuHotListTool, { name: ZHIHU_HOT_LIST_TOOL });
  }
};

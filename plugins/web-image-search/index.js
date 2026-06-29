import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { backgroundToolParameters, enqueueBackgroundTool, shouldRunInBackground } from "../imagebot-background-jobs/index.js";
import { withEphemeralPage } from "../imagebot-shared/browser-context-pool.js";

const IMAGE_TOOL_NAME = "web_image_search";
const TEXT_TOOL_NAME = "web_text_search";
const EXPLICIT_TEXT_TOOL_NAME = "explicit_web_text_search";
const REVERSE_TOOL_NAME = "reverse_image_search";
const DOWNLOAD_TOOL_NAME = "download_image_url";
const DOWNLOAD_MANY_TOOL_NAME = "download_image_urls";
const SPOILER_TOOL_NAME = "telegram_media_spoiler";
const DEFAULT_COUNT = 6;
const MAX_COUNT = 12;
const MODEL_VISIBLE_IMAGE_RESULTS = 6;
const REQUEST_TIMEOUT_MS = 20_000;
const REVERSE_REQUEST_TIMEOUT_MS = 75_000;
const DOWNLOAD_REQUEST_TIMEOUT_MS = 25_000;
const DOWNLOAD_BROWSER_TIMEOUT_MS = 60_000;
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_MANY_MAX_COUNT = 10;
const DOWNLOAD_MANY_CONCURRENCY = 3;
const DOWNLOAD_MAX_REDIRECTS = 2;
const DOWNLOAD_TRANSPORT_CACHE_TTL_MS = 15 * 60 * 1000;
const IMAGE_GENERATE_TOOL_NAME = "image_generate";
const IMAGE_GENERATE_REFERENCE_FAILURE_TTL_MS = 10 * 60 * 1000;
const IMAGE_SEARCH_AUTO_DOWNLOAD_PREVIEW_COUNT = MODEL_VISIBLE_IMAGE_RESULTS;
const TOOL_RESULT_DIRECT_IMAGE_PREVIEW_MAX_BYTES = 768 * 1024;
const TOOL_RESULT_IMAGE_PREVIEW_MAX_BYTES = 1250 * 1024;
const TOOL_RESULT_IMAGE_PREVIEW_TOTAL_MAX_BYTES = 3 * 1024 * 1024;
const TOOL_RESULT_IMAGE_PREVIEW_MAX_COUNT = 4;
const TOOL_RESULT_IMAGE_PREVIEW_MAX_EDGE = 1536;
const DANBOORU_HOME_URL = "https://danbooru.donmai.us/";
const DEFAULT_REVERSE_PROVIDERS = ["saucenao", "iqdb"];
const REVERSE_PROVIDERS = new Set(["saucenao", "iqdb", "ascii2d", "google_lens"]);
const DOWNLOAD_ALLOWED_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"]
]);
const TOOL_RESULT_DIRECT_IMAGE_PREVIEW_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const TOOL_RESULT_CONVERTIBLE_IMAGE_PREVIEW_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const TOOL_RESULT_ANIMATED_IMAGE_TYPES = new Set(["image/gif"]);
const imageGenerateReferenceRequirements = new Map();
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "Chrome/120.0 Safari/537.36";
const requireBase = process.argv[1] && (path.isAbsolute(process.argv[1]) || process.argv[1].startsWith("file:"))
  ? process.argv[1]
  : import.meta.url;
const runtimeRequire = createRequire(requireBase);
const pluginRequire = createRequire(import.meta.url);
let playwrightChromiumPromise = null;
let sharpModulePromise = null;
const downloadTransportCache = new Map();
const prewarmedBrowserPools = new Set();

function requireRuntimeModule(moduleName) {
  try {
    return runtimeRequire(moduleName);
  } catch (firstError) {
    const candidates = [
      path.join(path.dirname(process.execPath), "node_modules", "openclaw", "openclaw.mjs")
    ];
    for (const candidate of candidates) {
      try {
        return createRequire(candidate)(moduleName);
      } catch {}
    }
    throw firstError;
  }
}

async function getSharp() {
  if (!sharpModulePromise) {
    sharpModulePromise = Promise.resolve().then(() => {
      const mod = pluginRequire("sharp");
      return mod?.default || mod;
    });
  }
  return sharpModulePromise;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value !== "string") return fallback;
  return value.trim();
}

function readCount(params) {
  const raw = isRecord(params) ? params.count : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_COUNT;
  return Math.max(1, Math.min(MAX_COUNT, Math.trunc(value)));
}

function readBoolean(params, key) {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
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

function normalizeSafeSearch(raw) {
  const value = String(raw || "moderate").trim().toLowerCase();
  if (value === "off" || value === "strict") return value;
  return "moderate";
}

function safeSearchParam(value) {
  if (value === "off") return "-1";
  return "1";
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

async function fetchText(url, { signal, accept, method = "GET", headers = {}, body, redirect = "follow", timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const request = timeoutSignal(signal, timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      body,
      redirect,
      signal: request.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept,
        ...headers
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    return await response.text();
  } finally {
    request.cleanup();
  }
}

function extractVqd(html) {
  const patterns = [
    /vqd=['"]([^'"]+)['"]/i,
    /"vqd"\s*:\s*"([^"]+)"/i,
    /vqd=([^&"'<>\\]+)/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  if (host === "::" || host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 100 && b >= 64 && b <= 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 0 && c === 0 ||
    a === 192 && b === 0 && c === 2 ||
    a === 192 && b === 168 ||
    a === 198 && (b === 18 || b === 19) ||
    a === 198 && b === 51 && c === 100 ||
    a === 203 && b === 0 && c === 113 ||
    a >= 224
  );
}

function normalizeHttpUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  try {
    const trimmed = raw.trim();
    const url = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (isBlockedHostname(url.hostname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeDuckDuckGoRedirect(raw) {
  const direct = normalizeHttpUrl(raw);
  if (!direct) return "";
  try {
    const url = new URL(direct);
    if (url.hostname.toLowerCase().endsWith("duckduckgo.com") && url.pathname.startsWith("/l/")) {
      const redirected = url.searchParams.get("uddg");
      return normalizeHttpUrl(redirected || "") || direct;
    }
    return direct;
  } catch {
    return direct;
  }
}

function normalizeDownloadUrl(raw, baseUrl = "") {
  const candidate = baseUrl ? new URL(raw, baseUrl).toString() : raw;
  const normalized = normalizeHttpUrl(candidate);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.username || parsed.password) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function isDanbooruUrl(raw) {
  const normalized = normalizeHttpUrl(raw);
  if (!normalized) return false;
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return host === "danbooru.donmai.us" || host === "cdn.donmai.us" || host.endsWith(".donmai.us");
  } catch {
    return false;
  }
}

function isSurugaYaHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "suruga-ya.jp" || host === "www.suruga-ya.jp" || host === "cdn.suruga-ya.jp";
}

function surugaCdnMirrorUrl(raw) {
  const normalized = normalizeDownloadUrl(raw);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    if ((host === "suruga-ya.jp" || host === "www.suruga-ya.jp") && parsed.pathname.startsWith("/database/pics")) {
      parsed.hostname = "cdn.suruga-ya.jp";
      return parsed.toString();
    }
    return "";
  } catch {
    return "";
  }
}

function downloadUrlCandidates(raw) {
  const normalized = normalizeDownloadUrl(raw);
  if (!normalized) return [];
  const mirror = surugaCdnMirrorUrl(normalized);
  const candidates = mirror && mirror !== normalized ? [mirror, normalized] : [normalized];
  return [...new Set(candidates)];
}

function normalizeDownloadTransport(raw) {
  const value = String(raw || "auto").trim().toLowerCase();
  if (value === "browser" || value === "isolated_browser") return "browser";
  if (value === "http" || value === "fetch") return "http";
  return "auto";
}

function resolveDownloadTransport(params, url) {
  const requested = normalizeDownloadTransport(readString(params, "transport", "auto"));
  if (requested !== "auto") return requested;
  const cached = cachedDownloadTransport(url);
  if (cached) return cached;
  return isDanbooruUrl(url) ? "browser" : "http";
}

function downloadTransportCacheKey(raw) {
  const normalized = normalizeDownloadUrl(raw);
  if (!normalized) return "";
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function cachedDownloadTransport(raw) {
  const key = downloadTransportCacheKey(raw);
  if (!key) return "";
  const entry = downloadTransportCache.get(key);
  if (!entry) return "";
  if (entry.expiresAt <= Date.now()) {
    downloadTransportCache.delete(key);
    return "";
  }
  return entry.transport;
}

function rememberDownloadTransport(raw, transport) {
  const normalized = normalizeDownloadTransport(transport);
  if (normalized !== "http" && normalized !== "browser") return;
  const key = downloadTransportCacheKey(raw);
  if (!key) return;
  downloadTransportCache.set(key, {
    transport: normalized,
    expiresAt: Date.now() + DOWNLOAD_TRANSPORT_CACHE_TTL_MS
  });
}

function readDownloadReferer(params, url) {
  const explicit = normalizeDownloadUrl(readString(params, "refererUrl") || readString(params, "referer"));
  if (explicit) return explicit;
  if (isDanbooruUrl(url)) return DANBOORU_HOME_URL;
  try {
    const parsed = new URL(normalizeDownloadUrl(url));
    if (isSurugaYaHost(parsed.hostname)) return "https://www.suruga-ya.jp/";
    return `${parsed.origin}/`;
  } catch {
    return "";
  }
}

function normalizeDownloadContentType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: "image/png", extension: "png" };
  }
  const header6 = buffer.subarray(0, 6).toString("ascii");
  if (header6 === "GIF87a" || header6 === "GIF89a") {
    return { mimeType: "image/gif", extension: "gif" };
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return null;
}

async function readResponseBufferLimited(response, maxBytes) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error(`image exceeds ${Math.ceil(maxBytes / 1024 / 1024)}MB limit`);
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`image exceeds ${Math.ceil(maxBytes / 1024 / 1024)}MB limit`);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`image exceeds ${Math.ceil(maxBytes / 1024 / 1024)}MB limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function readDownloadMaxBytes(params) {
  const raw = isRecord(params) ? params.maxBytes : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DOWNLOAD_MAX_BYTES;
  return Math.max(1, Math.min(DOWNLOAD_MAX_BYTES, Math.trunc(value)));
}

function safeDownloadBasename(raw, fallback) {
  const name = String(raw || "").trim();
  const clean = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 80);
  return clean || fallback;
}

function resolveDownloadDirectory() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return path.join(os.homedir(), ".openclaw", "media", "downloaded", today);
}

async function fetchImageWithRedirects(rawUrl, { signal, maxBytes, refererUrl }) {
  let currentUrl = normalizeDownloadUrl(rawUrl);
  if (!currentUrl) throw new Error("URL is not an allowed public http/https image URL");
  for (let redirectCount = 0; redirectCount <= DOWNLOAD_MAX_REDIRECTS; redirectCount++) {
    const request = timeoutSignal(signal, DOWNLOAD_REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal: request.signal,
        headers: {
          "user-agent": USER_AGENT,
          "accept-language": "ja,en-US;q=0.8,en;q=0.6",
          accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5",
          ...(refererUrl ? { referer: refererUrl } : {})
        }
      });
    } finally {
      request.cleanup();
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount >= DOWNLOAD_MAX_REDIRECTS) throw new Error("too many redirects");
      const location = response.headers.get("location");
      const nextUrl = normalizeDownloadUrl(location || "", currentUrl);
      if (!nextUrl) throw new Error("redirect target is not an allowed public image URL");
      currentUrl = nextUrl;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(currentUrl).hostname}`);
    const declaredType = normalizeDownloadContentType(response.headers.get("content-type"));
    if (declaredType && !declaredType.startsWith("image/") && declaredType !== "application/octet-stream") {
      throw new Error(`response is not an image (${declaredType})`);
    }
    const buffer = await readResponseBufferLimited(response, maxBytes);
    const sniffed = sniffImageType(buffer);
    if (!sniffed || !DOWNLOAD_ALLOWED_TYPES.has(sniffed.mimeType)) {
      throw new Error("downloaded file is not an allowed jpg/png/webp/gif image");
    }
    return {
      finalUrl: currentUrl,
      buffer,
      mimeType: sniffed.mimeType,
      extension: sniffed.extension,
      transport: "http"
    };
  }
  throw new Error("too many redirects");
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
  }
}

async function readPlaywrightImageResponse(response, maxBytes, currentUrl) {
  const status = typeof response.status === "function" ? response.status() : response.status;
  const ok = typeof response.ok === "function" ? response.ok() : response.ok;
  if (!ok) throw new Error(`HTTP ${status} from ${new URL(currentUrl).hostname}`);
  const headers = typeof response.headers === "function" ? response.headers() : {};
  const declaredType = normalizeDownloadContentType(headers["content-type"]);
  if (declaredType && !declaredType.startsWith("image/") && declaredType !== "application/octet-stream") {
    throw new Error(`response is not an image (${declaredType})`);
  }
  const length = Number(headers["content-length"]);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error(`image exceeds ${Math.ceil(maxBytes / 1024 / 1024)}MB limit`);
  }
  const buffer = Buffer.from(await response.body());
  if (buffer.length > maxBytes) throw new Error(`image exceeds ${Math.ceil(maxBytes / 1024 / 1024)}MB limit`);
  const sniffed = sniffImageType(buffer);
  if (!sniffed || !DOWNLOAD_ALLOWED_TYPES.has(sniffed.mimeType)) {
    throw new Error("downloaded file is not an allowed jpg/png/webp/gif image");
  }
  return {
    buffer,
    mimeType: sniffed.mimeType,
    extension: sniffed.extension
  };
}

async function createBrowserDownloadSession(signal) {
  const chromium = await getPlaywrightChromium();
  throwIfAborted(signal);
  const pool = browserPoolConfig(createBrowserDownloadSession.config || {});

  async function warmReferer(page, currentUrl, referer) {
    const warmUrl = isDanbooruUrl(currentUrl) ? DANBOORU_HOME_URL : referer;
    if (!warmUrl) return;
    const normalized = normalizeDownloadUrl(warmUrl);
    if (!normalized) return;
    await page.goto(normalized, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
    if (!isDanbooruUrl(currentUrl)) await page.waitForTimeout(250).catch(() => {});
  }

  async function fetchWithBrowser(rawUrl, { maxBytes, refererUrl }) {
    const currentUrl = normalizeDownloadUrl(rawUrl);
    if (!currentUrl) throw new Error("URL is not an allowed public http/https image URL");
    throwIfAborted(signal);
    const referer = refererUrl || readDownloadReferer({ refererUrl }, currentUrl);
    return await withEphemeralPage({
      key: "imagebot-download-browser",
      chromium,
      viewport: { width: 1280, height: 720 },
      maxPages: pool.maxPages,
      idleMs: pool.idleMs,
      signal,
      launchOptions: {
        channel: "msedge",
        headless: true,
        args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"]
      },
      contextOptions: {
        viewport: { width: 1280, height: 720 },
        locale: "ja-JP",
        timezoneId: "Asia/Tokyo",
        userAgent: USER_AGENT,
        acceptDownloads: false
      }
    }, async (page, context) => {
      await warmReferer(page, currentUrl, referer);
      throwIfAborted(signal);
      const headers = {
        "user-agent": USER_AGENT,
        "accept-language": "ja,en-US;q=0.8,en;q=0.6",
        accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5",
        ...(referer ? { referer } : {})
      };
      try {
        const response = await context.request.get(currentUrl, {
          timeout: DOWNLOAD_BROWSER_TIMEOUT_MS,
          maxRedirects: DOWNLOAD_MAX_REDIRECTS,
          headers
        });
        const image = await readPlaywrightImageResponse(response, maxBytes, currentUrl);
        return {
          finalUrl: typeof response.url === "function" ? response.url() : currentUrl,
          ...image,
          transport: "browser"
        };
      } catch (requestError) {
        throwIfAborted(signal);
        await page.setExtraHTTPHeaders(headers).catch(() => {});
        const response = await page.goto(currentUrl, { waitUntil: "load", timeout: DOWNLOAD_BROWSER_TIMEOUT_MS });
        if (!response) throw requestError;
        const image = await readPlaywrightImageResponse(response, maxBytes, currentUrl);
        return {
          finalUrl: page.url() || currentUrl,
          ...image,
          transport: "browser"
        };
      }
    });
  }

  async function close() {
    // The shared bot-owned browser is closed by the idle timer in the browser pool.
  }

  return { fetch: fetchWithBrowser, close };
}

function browserPoolConfig(config = {}) {
  const cfg = isRecord(config.browserPool) ? config.browserPool : {};
  return {
    prewarm: cfg.prewarm === true,
    maxPages: Math.max(1, Math.min(12, Math.trunc(Number(cfg.maxPages || 4)))),
    idleMs: Math.max(30_000, Math.trunc(Number(cfg.idleMs || 10 * 60 * 1000)))
  };
}

function scheduleDownloadBrowserPrewarm(config = {}) {
  const pool = browserPoolConfig(config);
  if (!pool.prewarm) return;
  const key = "imagebot-download-browser";
  if (prewarmedBrowserPools.has(key)) return;
  prewarmedBrowserPools.add(key);
  createBrowserDownloadSession.config = config;
  setTimeout(() => {
    void (async () => {
      const chromium = await getPlaywrightChromium();
      await withEphemeralPage({
        key,
        chromium,
        viewport: { width: 1280, height: 720 },
        maxPages: pool.maxPages,
        idleMs: pool.idleMs,
        launchOptions: {
          channel: "msedge",
          headless: true,
          args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"]
        },
        contextOptions: {
          viewport: { width: 1280, height: 720 },
          locale: "ja-JP",
          timezoneId: "Asia/Tokyo",
          userAgent: USER_AGENT,
          acceptDownloads: false
        }
      }, async (page) => {
        await page.goto("about:blank", { timeout: 5_000 }).catch(() => {});
      });
    })().catch(() => {});
  }, 1500).unref?.();
}

async function fetchImageWithIsolatedBrowser(rawUrl, { signal, maxBytes, refererUrl }) {
  const session = await createBrowserDownloadSession(signal);
  try {
    return await session.fetch(rawUrl, { maxBytes, refererUrl });
  } finally {
    await session.close();
  }
}

async function fetchImageWithBrowserTransport(rawUrl, { signal, maxBytes, refererUrl }, options = {}) {
  if (typeof options.getBrowserSession === "function") {
    const session = await options.getBrowserSession();
    return await session.fetch(rawUrl, { maxBytes, refererUrl });
  }
  return await fetchImageWithIsolatedBrowser(rawUrl, { signal, maxBytes, refererUrl });
}

async function fetchImageForDownload(url, params, signal, maxBytes, options = {}) {
  const requested = normalizeDownloadTransport(readString(params, "transport", "auto"));
  const candidates = downloadUrlCandidates(url);
  if (!candidates.length) throw new Error("URL is not an allowed public http/https image URL");
  let lastError = null;
  for (const candidateUrl of candidates) {
    const refererUrl = readDownloadReferer(params, candidateUrl);
    const transport = requested === "auto" ? resolveDownloadTransport({ transport: "auto" }, candidateUrl) : requested;
    if (transport === "browser") {
      try {
        const result = await fetchImageWithBrowserTransport(candidateUrl, { signal, maxBytes, refererUrl }, options);
        rememberDownloadTransport(candidateUrl, "browser");
        return result;
      } catch (browserError) {
        try {
          const fallback = await fetchImageWithRedirects(candidateUrl, { signal, maxBytes, refererUrl });
          rememberDownloadTransport(candidateUrl, "http");
          return { ...fallback, fallbackFrom: "browser", fallbackError: browserError instanceof Error ? browserError.message : String(browserError) };
        } catch (httpError) {
          lastError = new Error(`isolated browser download failed for ${candidateUrl}: ${browserError instanceof Error ? browserError.message : String(browserError)}; http fallback failed: ${httpError instanceof Error ? httpError.message : String(httpError)}`);
          continue;
        }
      }
    }
    try {
      const result = await fetchImageWithRedirects(candidateUrl, { signal, maxBytes, refererUrl });
      rememberDownloadTransport(candidateUrl, "http");
      return result;
    } catch (httpError) {
      if (requested === "http") {
        lastError = httpError instanceof Error ? httpError : new Error(String(httpError));
        continue;
      }
      try {
        const browserFallback = await fetchImageWithBrowserTransport(candidateUrl, { signal, maxBytes, refererUrl }, options);
        rememberDownloadTransport(candidateUrl, "browser");
        return { ...browserFallback, fallbackFrom: "http", fallbackError: httpError instanceof Error ? httpError.message : String(httpError) };
      } catch (browserError) {
        lastError = new Error(`http download failed for ${candidateUrl}: ${httpError instanceof Error ? httpError.message : String(httpError)}; isolated browser fallback failed: ${browserError instanceof Error ? browserError.message : String(browserError)}`);
      }
    }
  }
  throw lastError || new Error("all download candidates failed");
}

async function saveDownloadedImage(result, params) {
  const dir = resolveDownloadDirectory();
  await fs.mkdir(dir, { recursive: true });
  const hash = createHash("sha256").update(result.buffer).digest("hex").slice(0, 16);
  let urlBase = "";
  try {
    urlBase = path.basename(new URL(result.finalUrl).pathname).replace(/\.[^.]+$/, "");
  } catch {}
  const requestedBase = readString(params, "filename").replace(/\.[^.]+$/, "");
  const basename = safeDownloadBasename(requestedBase || urlBase, `image-${hash}`);
  const filePath = path.join(dir, `${basename}-${randomUUID().slice(0, 8)}.${result.extension}`);
  await fs.writeFile(filePath, result.buffer, { flag: "wx" });
  return {
    path: filePath,
    finalUrl: result.finalUrl,
    mimeType: result.mimeType,
    sizeBytes: result.buffer.length,
    hash,
    transport: result.transport,
    fallbackFrom: result.fallbackFrom,
    fallbackError: result.fallbackError
  };
}

async function downloadImageUrl(params, signal, options = {}) {
  const url = readString(params, "url") || readString(params, "imageUrl");
  if (!url) throw new Error("url is required");
  const maxBytes = readDownloadMaxBytes(params);
  const result = await fetchImageForDownload(url, params, signal, maxBytes, options);
  return await saveDownloadedImage(result, params);
}

function readDownloadUrls(params) {
  const raw = isRecord(params) ? params.urls : undefined;
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\r?\n|,/g) : [];
  const normalized = [];
  const seen = new Set();
  for (const entry of values) {
    const url = normalizeDownloadUrl(String(entry || "").trim());
    if (!url || seen.has(url)) continue;
    seen.add(url);
    normalized.push(url);
    if (normalized.length >= DOWNLOAD_MANY_MAX_COUNT) break;
  }
  return normalized;
}

function cleanImageGenerateReference(value) {
  return String(value || "")
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^MEDIA\s*:\s*/i, "")
    .trim();
}

function readImageGenerateReferences(params) {
  const refs = [];
  const image = isRecord(params) ? params.image : undefined;
  if (typeof image === "string") {
    const value = cleanImageGenerateReference(image);
    if (value) refs.push({ key: "image", index: null, value });
  }
  const images = isRecord(params) && Array.isArray(params.images) ? params.images : [];
  for (const [index, entry] of images.entries()) {
    if (typeof entry !== "string") continue;
    const value = cleanImageGenerateReference(entry);
    if (value) refs.push({ key: "images", index, value });
  }
  return refs;
}

function isHttpImageGenerateReference(value) {
  return /^https?:\/\//i.test(cleanImageGenerateReference(value));
}

function referenceDisplay(value) {
  const raw = cleanImageGenerateReference(value);
  const normalized = normalizeDownloadUrl(raw);
  return normalized || raw;
}

function imageGenerateReferenceStateKey(event, ctx) {
  const runId = String(event?.runId || ctx?.runId || "").trim();
  if (runId) return { key: `run:${runId}`, runScoped: true };
  const sessionKey = String(ctx?.sessionKey || event?.sessionKey || "").trim();
  if (sessionKey) return { key: `session:${sessionKey}`, runScoped: false };
  return { key: "", runScoped: false };
}

function normalizePromptKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 2000);
}

function pruneImageGenerateReferenceRequirements(now = Date.now()) {
  for (const [key, entry] of imageGenerateReferenceRequirements) {
    if (!entry || entry.expiresAt <= now) imageGenerateReferenceRequirements.delete(key);
  }
}

function rememberImageGenerateReferenceRequirement(event, ctx, params, refs) {
  const identity = imageGenerateReferenceStateKey(event, ctx);
  if (!identity.key) return;
  imageGenerateReferenceRequirements.set(identity.key, {
    runScoped: identity.runScoped,
    promptKey: normalizePromptKey(readString(params, "prompt")),
    refs: refs.map((ref) => referenceDisplay(ref.value)).slice(0, 5),
    expiresAt: Date.now() + IMAGE_GENERATE_REFERENCE_FAILURE_TTL_MS
  });
}

function recentImageGenerateReferenceRequirement(event, ctx, params) {
  pruneImageGenerateReferenceRequirements();
  const identity = imageGenerateReferenceStateKey(event, ctx);
  if (!identity.key) return null;
  const entry = imageGenerateReferenceRequirements.get(identity.key);
  if (!entry) return null;
  if (entry.runScoped) return entry;
  const promptKey = normalizePromptKey(readString(params, "prompt"));
  return entry.promptKey && entry.promptKey === promptKey ? entry : null;
}

function formatReferenceList(refs) {
  return refs
    .map((ref, index) => `${index + 1}. ${referenceDisplay(ref.value)}`)
    .join("\n");
}

function guardImageGenerateReferenceInputs(event, ctx) {
  if (String(event?.toolName || "") !== IMAGE_GENERATE_TOOL_NAME) return;
  if (ctx?.agentId && ctx.agentId !== "imagebot") return;
  const params = isRecord(event?.params) ? event.params : {};
  const refs = readImageGenerateReferences(params);
  const remoteRefs = refs.filter((ref) => isHttpImageGenerateReference(ref.value));
  if (remoteRefs.length > 0) {
    rememberImageGenerateReferenceRequirement(event, ctx, params, remoteRefs);
    return {
      block: true,
      blockReason: [
        "Remote image_generate references require a model-visible local download first.",
        "Next step: call download_image_url for each selected URL, inspect the returned preview image, then call image_generate with the returned local MEDIA path in images.",
        "Prompt-only retry for this run is blocked because a reference was selected.",
        "remote_refs:",
        formatReferenceList(remoteRefs)
      ].join("\n")
    };
  }
  if (refs.length > 0) {
    rememberImageGenerateReferenceRequirement(event, ctx, params, refs);
    return;
  }
  const recentRequirement = recentImageGenerateReferenceRequirement(event, ctx, params);
  if (recentRequirement) {
    return {
      block: true,
      blockReason: [
        "A reference image was selected earlier in this run, but this image_generate call has no local reference media.",
        "Next step: retry with the same local MEDIA path(s), use download_image_url if the reference is still remote, or report the reference/generation failure.",
        "required_refs:",
        formatReferenceList((recentRequirement.refs || []).map((value) => ({ value })))
      ].join("\n")
    };
  }
}

function readSearchPreviewCount(params, config = {}) {
  const raw = isRecord(params) && params.previewCount !== undefined ? params.previewCount : config.searchPreviewCount;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return IMAGE_SEARCH_AUTO_DOWNLOAD_PREVIEW_COUNT;
  return Math.max(0, Math.min(MODEL_VISIBLE_IMAGE_RESULTS, Math.trunc(value)));
}

function shouldAutoDownloadSearchPreviews(params, ctx, config = {}) {
  const explicit = readBoolean(params, "downloadPreviews");
  if (explicit !== undefined) return explicit;
  if (config.autoDownloadSearchPreviews === false) return false;
  return ctx?.agentId === "imagebot";
}

function selectImageSearchPreviewCandidates(results, limit) {
  const selected = [];
  const seen = new Set();
  for (const [index, result] of results.slice(0, MODEL_VISIBLE_IMAGE_RESULTS).entries()) {
    if (selected.length >= limit) break;
    const imageUrl = normalizeDownloadUrl(result?.imageUrl || "");
    if (!imageUrl || seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    selected.push({
      candidateIndex: index,
      title: result?.title || "",
      imageUrl,
      sourceUrl: normalizeDownloadUrl(result?.sourceUrl || "")
    });
  }
  return selected;
}

async function downloadImageSearchPreviews(results, params, signal, config = {}, ctx = {}) {
  const previewCount = shouldAutoDownloadSearchPreviews(params, ctx, config) ? readSearchPreviewCount(params, config) : 0;
  const candidates = selectImageSearchPreviewCandidates(results, previewCount);
  if (candidates.length === 0) return [];
  const transport = readString(params, "previewTransport", readString(params, "transport", "auto"));
  let browserSessionPromise = null;
  const getBrowserSession = async () => {
    if (!browserSessionPromise) browserSessionPromise = createBrowserDownloadSession(signal);
    return await browserSessionPromise;
  };
  try {
    return await mapConcurrent(candidates, DOWNLOAD_MANY_CONCURRENCY, async (candidate) => {
      try {
        const downloaded = await downloadImageUrl({
          url: candidate.imageUrl,
          filename: `web-image-search-${candidate.candidateIndex + 1}`,
          maxBytes: DOWNLOAD_MAX_BYTES,
          transport,
          refererUrl: candidate.sourceUrl
        }, signal, { getBrowserSession });
        return {
          ok: true,
          ...candidate,
          ...downloaded
        };
      } catch (error) {
        return {
          ok: false,
          ...candidate,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    });
  } finally {
    if (browserSessionPromise) {
      try {
        const session = await browserSessionPromise;
        await session.close();
      } catch {
        // A failed preview browser session should not mask the search results.
      }
    }
  }
}

async function buildImageSearchPreviewContent(downloads) {
  const successes = downloads.filter((entry) => entry.ok && entry.path);
  if (successes.length === 0) return [];
  return await buildToolResultImagePreviews(successes);
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function downloadImageUrls(params, signal) {
  const urls = readDownloadUrls(params);
  if (urls.length === 0) throw new Error("urls is required");
  const maxBytes = readDownloadMaxBytes(params);
  const filenamePrefix = safeDownloadBasename(readString(params, "filenamePrefix"), "image");
  const transport = readString(params, "transport", "auto");
  const refererUrl = readString(params, "refererUrl") || readString(params, "referer");
  let browserSessionPromise = null;
  const getBrowserSession = async () => {
    if (!browserSessionPromise) browserSessionPromise = createBrowserDownloadSession(signal);
    return await browserSessionPromise;
  };
  try {
    return await mapConcurrent(urls, DOWNLOAD_MANY_CONCURRENCY, async (url, index) => {
      try {
        const downloaded = await downloadImageUrl({
          url,
          filename: `${filenamePrefix}-${index + 1}`,
          maxBytes,
          transport,
          refererUrl
        }, signal, { getBrowserSession });
        return { ok: true, url, ...downloaded };
      } catch (error) {
        return {
          ok: false,
          url,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    });
  } finally {
    if (browserSessionPromise) {
      try {
        const session = await browserSessionPromise;
        await session.close();
      } catch {
        // Failed session startup/cleanup should not mask per-image results.
      }
    }
  }
}

async function buildToolResultImagePreview(entry) {
  if (!entry?.path || !entry?.mimeType || !TOOL_RESULT_CONVERTIBLE_IMAGE_PREVIEW_TYPES.has(entry.mimeType)) return null;
  if (!Number.isFinite(entry.sizeBytes) || entry.sizeBytes <= 0) return null;
  const shouldConvert = entry.sizeBytes > TOOL_RESULT_DIRECT_IMAGE_PREVIEW_MAX_BYTES;
  let image;
  let mimeType = entry.mimeType;
  let fileName = path.basename(entry.path);
  if (!shouldConvert && TOOL_RESULT_DIRECT_IMAGE_PREVIEW_TYPES.has(entry.mimeType)) {
    image = await fs.readFile(entry.path);
  } else {
    const sharp = await getSharp();
    image = await sharp(entry.path, {
      animated: false,
      pages: 1,
      limitInputPixels: 80_000_000
    })
      .rotate()
      .resize({
        width: TOOL_RESULT_IMAGE_PREVIEW_MAX_EDGE,
        height: TOOL_RESULT_IMAGE_PREVIEW_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true
      })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    mimeType = "image/jpeg";
    fileName = `${path.basename(entry.path, path.extname(entry.path))}-preview.jpg`;
  }
  if (image.length > TOOL_RESULT_IMAGE_PREVIEW_MAX_BYTES) return null;
  return {
    type: "image",
    data: image.toString("base64"),
    mimeType,
    fileName
  };
}

async function buildToolResultImagePreviews(entries) {
  const previews = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (previews.length >= TOOL_RESULT_IMAGE_PREVIEW_MAX_COUNT) break;
    const preview = await buildToolResultImagePreview(entry);
    if (!preview) continue;
    const previewBytes = Buffer.byteLength(preview.data, "base64");
    if (totalBytes + previewBytes > TOOL_RESULT_IMAGE_PREVIEW_TOTAL_MAX_BYTES) continue;
    previews.push(preview);
    totalBytes += previewBytes;
  }
  return previews;
}

function formatVisualPreviewStatus(entry, preview) {
  if (preview) return "included";
  if (TOOL_RESULT_ANIMATED_IMAGE_TYPES.has(entry?.mimeType)) return "omitted (animated; use video_keyframes for multi-frame visual analysis)";
  return "omitted";
}

function sourceSafetyHintForImageUrl(url) {
  const normalized = String(url || "").trim().toLowerCase();
  if (!normalized) return "unknown";
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^www\./, "");
    const pathname = parsed.pathname;
    if (
      host.endsWith("dmm.co.jp") && /\/adult\//i.test(pathname) ||
      host.endsWith("fanza.co.jp") ||
      /(?:^|\.)eporner\.com$/.test(host) ||
      /(?:^|\.)xhamster\.com$/.test(host) ||
      /(?:^|\.)xhcdn\.com$/.test(host) ||
      /(?:^|\.)pornhub\.com$/.test(host) ||
      /(?:^|\.)adultempire\.com$/.test(host) ||
      /(?:^|\.)aznude\.com$/.test(host)
    ) {
      return "adult_or_sensitive_source";
    }
    if (/(?:^|[\/_.-])(?:ssni|ssis|adn|ipx|ipzz|jul|mide|mird|pred|abw|dvdms|miaa|fc2|iptd|jufe|stars|dass|vec|meyd|rki|sone)\d{2,5}(?:$|[\/_.-])/i.test(`${host}${pathname}`)) {
      return "adult_or_sensitive_source";
    }
  } catch {
    if (/\badult\b|\/adult\/|\b(?:ssni|ssis|adn|ipx|ipzz|jul|mide|mird|pred|abw|dvdms|miaa|fc2|iptd|jufe|stars|dass|vec|meyd|rki|sone)[-_]?\d{2,5}\b/i.test(normalized)) {
      return "adult_or_sensitive_source";
    }
  }
  return "unknown";
}

function buildDownloadDeliveryGuidance({ previewIncluded, sourceSafetyHint, plural = false }) {
  const subject = plural ? "these images" : "this image";
  const mediaPhrase = plural ? "media paths" : "media path";
  const lines = [
    previewIncluded
      ? `The included image preview is visual context for you now; use the visible image plus source metadata before deciding how to reply.`
      : `No visual preview was included; rely on source metadata and ask/use another tool if visual judgment matters.`,
    sourceSafetyHint === "adult_or_sensitive_source"
      ? "sourceSafetyHint: adult_or_sensitive_source"
      : "sourceSafetyHint: unknown",
    `If the user asked to receive ${subject}, include the ${mediaPhrase} in the final reply as MEDIA for ordinary media or SPOILER_MEDIA for sensitive/adult/NSFW media so Telegram attaches it correctly.`,
    "Do not expose local paths except as media directives."
  ];
  return lines.join("\n");
}

function normalizeResult(raw) {
  if (!isRecord(raw)) return null;
  const imageUrl = normalizeHttpUrl(raw.image);
  if (!imageUrl) return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const sourceUrl = normalizeHttpUrl(raw.url);
  const thumbnailUrl = normalizeHttpUrl(raw.thumbnail);
  const source = typeof raw.source === "string" ? raw.source.trim() : "";
  const format = typeof raw.encoding_format === "string" ? raw.encoding_format.trim().toLowerCase() : "";
  if (format === "svg") return null;
  return {
    title,
    imageUrl,
    thumbnailUrl,
    sourceUrl,
    source,
    width: Number.isFinite(Number(raw.width)) ? Number(raw.width) : undefined,
    height: Number.isFinite(Number(raw.height)) ? Number(raw.height) : undefined,
    format
  };
}

function dedupeResults(results) {
  const seen = new Set();
  const unique = [];
  for (const result of results) {
    const key = result.imageUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(result);
  }
  return unique;
}

function compactImageResult(result) {
  return {
    title: result.title || "",
    imageUrl: result.imageUrl || "",
    sourceUrl: result.sourceUrl || "",
    source: result.source || "",
    width: result.width,
    height: result.height,
    format: result.format || ""
  };
}

export async function searchDuckDuckGoImages({ query, count = DEFAULT_COUNT, safeSearch = "moderate", region = "us-en", signal } = {}) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) throw new Error("query is required");
  const home = new URL("https://duckduckgo.com/");
  home.searchParams.set("q", normalizedQuery);
  home.searchParams.set("iax", "images");
  home.searchParams.set("ia", "images");
  const html = await fetchText(home, { signal, accept: "text/html,application/xhtml+xml" });
  const vqd = extractVqd(html);
  if (!vqd) throw new Error("DuckDuckGo image token not found");

  const images = new URL("https://duckduckgo.com/i.js");
  images.searchParams.set("l", region || "us-en");
  images.searchParams.set("o", "json");
  images.searchParams.set("q", normalizedQuery);
  images.searchParams.set("vqd", vqd);
  images.searchParams.set("f", ",,,");
  images.searchParams.set("p", safeSearchParam(safeSearch));

  const text = await fetchText(images, { signal, accept: "application/json,*/*" });
  const payload = JSON.parse(text);
  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  return dedupeResults(rawResults.map(normalizeResult).filter(Boolean)).slice(0, count);
}

function parseDuckDuckGoTextResults(html, count) {
  const results = [];
  const resultBlockRe = /<div[^>]+class="[^"]*\bresult\b[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*\bresult\b|<\/body>)/gi;
  let blockMatch;
  while ((blockMatch = resultBlockRe.exec(html)) && results.length < count) {
    const block = blockMatch[0];
    const linkMatch =
      block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = normalizeDuckDuckGoRedirect(decodeHtmlEntities(linkMatch[1]));
    if (!url) continue;
    const title = stripHtml(linkMatch[2]);
    const snippetMatch =
      block.match(/<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";
    results.push({ title, url, snippet });
  }
  return dedupeTextResults(results).slice(0, count);
}

function dedupeTextResults(results) {
  const seen = new Set();
  const unique = [];
  for (const result of results) {
    const key = result.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(result);
  }
  return unique;
}

export async function searchDuckDuckGoText({ query, count = DEFAULT_COUNT, safeSearch = "moderate", region = "us-en", signal } = {}) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) throw new Error("query is required");
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", normalizedQuery);
  url.searchParams.set("kl", region || "us-en");
  url.searchParams.set("kp", safeSearchParam(safeSearch));
  const html = await fetchText(url, { signal, accept: "text/html,application/xhtml+xml" });
  return parseDuckDuckGoTextResults(html, count);
}

function formatResults(query, results, previewDownloads = []) {
  if (results.length === 0) {
    return `WEB_IMAGE_SEARCH results for "${query}": no usable public image candidates found.`;
  }
  const previewByIndex = new Map();
  for (const entry of Array.isArray(previewDownloads) ? previewDownloads : []) {
    if (Number.isInteger(entry?.candidateIndex)) previewByIndex.set(entry.candidateIndex, entry);
  }
  const visible = results.slice(0, MODEL_VISIBLE_IMAGE_RESULTS);
  const lines = [`WEB_IMAGE_SEARCH results for "${query}":`];
  visible.forEach((result, index) => {
    const size = result.width && result.height ? `${result.width}x${result.height}` : "unknown size";
    const preview = previewByIndex.get(index);
    lines.push(
      `${index + 1}. ${result.title || "(untitled)"}`,
      `   imageUrl: ${result.imageUrl}`,
      `   sourceUrl: ${result.sourceUrl || ""}`,
      `   source: ${result.source || ""}`,
      `   size: ${size}`,
      `   format: ${result.format || ""}`
    );
    if (preview?.ok && preview.path) {
      lines.push(
        `   localMedia: ${preview.path}`,
        `   localMimeType: ${preview.mimeType || ""}`,
        `   localTransport: ${preview.transport || "unknown"}`
      );
    } else if (preview && !preview.ok) {
      lines.push(`   localMedia: unavailable (${preview.error || "download failed"})`);
    }
  });
  if (results.length > visible.length) {
    lines.push(`Showing ${visible.length} of ${results.length} candidates. Use a focused query if the visible set is not enough.`);
  }
  const downloadedCount = previewDownloads.filter((entry) => entry?.ok).length;
  if (previewDownloads.length > 0) {
    lines.push(`Downloaded model-visible previews: ${downloadedCount}/${previewDownloads.length}.`);
  }
  lines.push(
    "This tool returns candidate URLs and may include localMedia paths for downloaded previews. Use visible preview images and source metadata before selecting references.",
    "For found-image requests, do not call image_generate. Select candidates, then call download_image_url(s) if the user wants the existing images attached.",
    "For generation reference requests, pass useful localMedia paths to image_generate.images. If localMedia is unavailable for a useful candidate, call download_image_url first.",
    "Direct public imageUrl references are blocked for imagebot image_generate calls until downloaded locally.",
    "If the user explicitly wants one found image attached/downloaded, call download_image_url on the selected imageUrl and include its MEDIA line in the final reply.",
    "If the user explicitly wants multiple found images attached/downloaded, call download_image_urls once with up to 10 selected imageUrl values and include every returned MEDIA line."
  );
  return lines.join("\n");
}

function formatTextResults(query, results, prefix = "WEB_TEXT_SEARCH") {
  if (results.length === 0) return `${prefix} results for "${query}": no usable public results found.`;
  const lines = [`${prefix} results for "${query}":`];
  results.forEach((result, index) => {
    lines.push(
      `${index + 1}. ${result.title || "(untitled)"}`,
      `   url: ${result.url}`,
      `   snippet: ${result.snippet || ""}`
    );
  });
  lines.push("Treat these URLs as public source leads. Do not loop with more keyword variants in the same turn.");
  return lines.join("\n");
}

function normalizeAbsolutePath(value) {
  const raw = typeof value === "string" ? value.trim() : "";
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
    path.join(home, ".openclaw", "media", "tool-image-generation"),
    path.join(home, ".openclaw", "media", "downloaded"),
    path.join(home, ".openclaw", "media", "practical-tools"),
    path.join(home, ".openclaw", "media", "gallery-resend"),
    path.join(home, ".openclaw", "media", "gacha-archive")
  ].map((entry) => normalizeAbsolutePath(entry));
}

function isAllowedLocalFile(filePath) {
  const normalized = normalizeAbsolutePath(filePath);
  if (!normalized) return false;
  return defaultAllowedPathPrefixes().some((root) => normalized === root || normalized.startsWith(`${root}\\`));
}

function unwrapMediaDirective(value) {
  const raw = String(value || "").trim().replace(/^`+|`+$/g, "");
  const match = raw.match(/^(?:SPOILER_MEDIA|MEDIA):\s*`?([^`\r\n]+)`?$/i);
  return match ? match[1].trim() : raw;
}

async function resolveLocalMediaForSpoiler(value) {
  const candidate = unwrapMediaDirective(value);
  if (!candidate) throw new Error("media path is required");
  if (/^https?:\/\//i.test(candidate)) throw new Error("telegram_media_spoiler accepts bot-local media paths, not URLs");
  if (!isAllowedLocalFile(candidate)) {
    throw new Error("media path is blocked; only current bot media paths are allowed");
  }
  const stat = await fs.stat(candidate);
  if (!stat.isFile()) throw new Error("media path is not a file");
  const ext = path.extname(candidate).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) throw new Error(`unsupported media type: ${ext || "unknown"}`);
  return candidate;
}

function guessContentType(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

async function resolveImageInput(params) {
  const candidate = readString(params, "image") || readString(params, "imagePath") || readString(params, "url");
  if (!candidate) throw new Error("image is required");
  const url = normalizeHttpUrl(candidate);
  if (url) {
    return {
      kind: "url",
      value: url,
      label: url
    };
  }
  if (!isAllowedLocalFile(candidate)) {
    throw new Error("local image path is blocked; only current Telegram media paths are allowed");
  }
  const data = await fs.readFile(candidate);
  return {
    kind: "file",
    value: candidate,
    label: path.basename(candidate),
    filename: path.basename(candidate),
    contentType: guessContentType(candidate),
    data
  };
}

function readReverseCount(params) {
  const raw = isRecord(params) ? params.count : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(8, Math.trunc(value)));
}

function normalizeProviderList(params) {
  const raw = isRecord(params) ? params.providers : undefined;
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : DEFAULT_REVERSE_PROVIDERS;
  const normalized = values
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter((entry) => REVERSE_PROVIDERS.has(entry));
  return normalized.length > 0 ? [...new Set(normalized)] : [...DEFAULT_REVERSE_PROVIDERS];
}

function extractLinks(html) {
  const links = [];
  for (const match of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = normalizeHttpUrl(decodeHtmlEntities(match[1] || ""));
    if (!url) continue;
    links.push({ url, text: stripHtml(match[2] || "") });
  }
  return links;
}

function parseSauceResults(html, limit) {
  const blocks = [...html.matchAll(/<div class="result(?: hidden)?">([\s\S]*?)<\/table><\/div>/gi)];
  const results = [];
  for (const match of blocks) {
    const block = match[1] || "";
    const similarity = (block.match(/<div class="resultsimilarityinfo">([^<]+)<\/div>/i)?.[1] || "").trim();
    const title = stripHtml(block.match(/<div class="resulttitle">([\s\S]*?)<\/div>/i)?.[1] || "");
    const details = stripHtml(block.match(/<div class="resultcontentcolumn">([\s\S]*?)<\/div>/i)?.[1] || "");
    const links = extractLinks(block).filter((entry) => !entry.url.includes("saucenao.com/search.php"));
    const thumbnail =
      normalizeHttpUrl(block.match(/data-src="([^"]+)"/i)?.[1] || "") ||
      normalizeHttpUrl(block.match(/src="([^"]+)"/i)?.[1] || "");
    results.push({
      provider: "SauceNAO",
      title: title || "(untitled)",
      similarity,
      details,
      thumbnailUrl: thumbnail,
      links: dedupeLinkEntries(links).slice(0, 6)
    });
    if (results.length >= limit) break;
  }
  return results;
}

function parseSauceNotice(html) {
  const adaptive = (html.match(/adaptive minsim:\s*([0-9.]+)/i)?.[1] || "").trim();
  return adaptive ? `adaptive min similarity ${adaptive}%` : "";
}

function parseIqdbResults(html, limit) {
  const results = [];
  const blocks = [...html.matchAll(/<div(?: class="nomatch")?><table>([\s\S]*?)<\/table><\/div>/gi)];
  let noRelevantMatches = false;
  const fallbackLinks = [];
  for (const match of blocks) {
    const block = match[1] || "";
    const header = stripHtml(block.match(/<th>([\s\S]*?)<\/th>/i)?.[1] || "");
    if (/^Your image$/i.test(header)) continue;
    if (/No relevant matches/i.test(header)) {
      noRelevantMatches = true;
      fallbackLinks.push(...dedupeLinkEntries(extractLinks(block)).slice(0, 6));
      continue;
    }
    const href = normalizeHttpUrl(block.match(/<td class='image'><a href="([^"]+)"/i)?.[1] || block.match(/<td class="image"><a href="([^"]+)"/i)?.[1] || "");
    const thumbnail = normalizeHttpUrl(block.match(/<img src='([^']+)'/i)?.[1] || block.match(/<img src="([^"]+)"/i)?.[1] || "");
    const service = stripHtml(block.match(/service-icon[^>]*>[\s\S]*?<\/td><\/tr><tr><td>([\s\S]*?)<\/td><\/tr>/i)?.[1] || "");
    const cells = [...block.matchAll(/<tr><td>([\s\S]*?)<\/td><\/tr>/gi)].map((entry) => stripHtml(entry[1] || ""));
    const size = cells.find((entry) => /\d+x\d+/i.test(entry)) || "";
    const similarity = cells.find((entry) => /similarity/i.test(entry)) || "";
    results.push({
      provider: "IQDB",
      title: header || service || "(possible match)",
      service,
      similarity,
      details: size,
      thumbnailUrl: thumbnail,
      links: dedupeLinkEntries(href ? [{ url: href, text: service || header || "match" }] : []).slice(0, 3)
    });
    if (results.length >= limit) break;
  }
  return {
    results,
    noRelevantMatches,
    fallbackLinks: dedupeLinkEntries(fallbackLinks)
  };
}

function dedupeLinkEntries(entries) {
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    const url = normalizeHttpUrl(entry.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push({
      url,
      text: stripHtml(entry.text || "")
    });
  }
  return unique;
}

async function sauceSearch(input, limit, signal) {
  const form = new FormData();
  form.set("hide", "0");
  if (input.kind === "url") {
    form.set("url", input.value);
  } else {
    form.set("file", new Blob([input.data], { type: input.contentType }), input.filename);
  }
  const html = await fetchText("https://saucenao.com/search.php", {
    signal,
    timeoutMs: REVERSE_REQUEST_TIMEOUT_MS,
    accept: "text/html,application/xhtml+xml",
    method: "POST",
    body: form,
    headers: {
      referer: "https://saucenao.com/"
    }
  });
  return {
    provider: "SauceNAO",
    notice: parseSauceNotice(html),
    results: parseSauceResults(html, limit)
  };
}

async function iqdbSearch(input, limit, signal) {
  const form = new FormData();
  if (input.kind === "url") {
    form.set("url", input.value);
  } else {
    form.set("file", new Blob([input.data], { type: input.contentType }), input.filename);
  }
  for (const service of ["1", "2", "3", "4", "5", "6", "11", "13"]) {
    form.append("service[]", service);
  }
  const html = await fetchText("https://safe.iqdb.org/", {
    signal,
    timeoutMs: REVERSE_REQUEST_TIMEOUT_MS,
    accept: "text/html,application/xhtml+xml",
    method: "POST",
    body: form,
    headers: {
      referer: "https://safe.iqdb.org/"
    }
  });
  const parsed = parseIqdbResults(html, limit);
  return {
    provider: "IQDB",
    ...parsed
  };
}

function ascii2dFallback(input) {
  if (input.kind === "url") {
    return {
      provider: "Ascii2d",
      unavailable: true,
      reason: "direct automation currently blocked by Cloudflare on this host",
      fallbackUrl: `https://ascii2d.net/search/url/${encodeURIComponent(input.value)}`
    };
  }
  return {
    provider: "Ascii2d",
    unavailable: true,
    reason: "direct automation currently blocked by Cloudflare on this host; use browser fallback for local files"
  };
}

async function getPlaywrightChromium() {
  if (!playwrightChromiumPromise) {
    playwrightChromiumPromise = Promise.resolve().then(() => {
      const playwright = requireRuntimeModule("playwright-core");
      if (!playwright?.chromium) throw new Error("playwright-core chromium is unavailable");
      return playwright.chromium;
    });
  }
  return await playwrightChromiumPromise;
}

function isGoogleDomain(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "google.com" || host.endsWith(".google.com");
}

function isGoogleMetaDomain(hostname) {
  const host = String(hostname || "").toLowerCase();
  return isGoogleDomain(host) || host === "about.google" || host.endsWith(".about.google");
}

function seemsGoogleSorryPage(url, text) {
  const normalizedUrl = String(url || "");
  const body = String(text || "");
  return normalizedUrl.includes("/sorry/") ||
    /unusual traffic/i.test(body) ||
    /异常流量/.test(body) ||
    /确认这些请求是由您而不是自动程序发出的/.test(body);
}

async function collectGoogleLensPageSummary(page, limit) {
  const title = await page.title().catch(() => "");
  const finalUrl = page.url();
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const heading =
    await page.locator("h1, h2, h3").first().innerText().catch(() => "") ||
    title;
  const rawLinks = await page.locator("a[href]").evaluateAll((nodes) => nodes.map((node) => ({
    url: node.href || "",
    text: (node.textContent || "").trim()
  }))).catch(() => []);
  const links = dedupeLinkEntries(rawLinks.filter((entry) => {
    const url = normalizeHttpUrl(entry.url);
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return !isGoogleMetaDomain(parsed.hostname);
    } catch {
      return false;
    }
  })).slice(0, Math.max(3, limit));
  return {
    title: stripHtml(heading || title || "Google Lens result"),
    finalUrl,
    bodyText,
    links
  };
}

async function googleLensSearch(input, limit) {
  const chromium = await getPlaywrightChromium();
  const baseTmpDir = path.join(os.homedir(), ".openclaw", "tmp");
  await fs.mkdir(baseTmpDir, { recursive: true });
  const userDataDir = await fs.mkdtemp(path.join(baseTmpDir, "google-lens-"));
  let browser = null;
  try {
    browser = await chromium.launchPersistentContext(userDataDir, {
      channel: "msedge",
      headless: true,
      args: ["--no-first-run", "--no-default-browser-check"]
    });
    const page = await browser.newPage();
    if (input.kind === "url") {
      const target = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(input.value)}`;
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(4_000);
    } else {
      await page.goto("https://www.google.com/", { waitUntil: "domcontentloaded", timeout: 15_000 });
      const trigger = page.locator('[aria-label*="图搜索"], [aria-label*="Search by image"], [aria-label*="Lens"]').first();
      try {
        await trigger.click({ timeout: 5_000 });
      } catch {
        await page.locator("[aria-label]").nth(13).click({ timeout: 5_000 });
      }
      await page.waitForTimeout(1_500);
      const fileInput = page.locator('input[type="file"]').last();
      await fileInput.setInputFiles(input.value);
      await page.waitForFunction(() => location.href !== "https://www.google.com/" && location.href !== "https://www.google.com", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(6_000);
    }

    const summary = await collectGoogleLensPageSummary(page, limit);
    if ((summary.finalUrl === "https://www.google.com/" || summary.finalUrl === "https://www.google.com") &&
      /使用 Google 智能镜头搜索任意图片|Search any image with Google Lens/i.test(summary.bodyText)) {
      return {
        provider: "Google Lens",
        unavailable: true,
        reason: "Google Lens upload UI opened but search results did not load on this host",
        fallbackUrl: summary.finalUrl
      };
    }
    if (seemsGoogleSorryPage(summary.finalUrl, summary.bodyText)) {
      return {
        provider: "Google Lens",
        unavailable: true,
        reason: "Google Lens returned an anti-bot / unusual traffic page on this host",
        fallbackUrl: summary.finalUrl
      };
    }
    return {
      provider: "Google Lens",
      notice: "browser-automated visual search",
      results: [{
        provider: "Google Lens",
        title: summary.title || "Google Lens result",
        details: summary.finalUrl,
        links: summary.links.length > 0 ? summary.links : dedupeLinkEntries([{ url: summary.finalUrl, text: "Google Lens result" }])
      }]
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runReverseProvider(provider, input, count, signal) {
  try {
    if (provider === "saucenao") return await sauceSearch(input, count, signal);
    if (provider === "iqdb") return await iqdbSearch(input, count, signal);
    if (provider === "ascii2d") return ascii2dFallback(input);
    if (provider === "google_lens") return await googleLensSearch(input, count, signal);
    return {
      provider,
      failed: true,
      reason: "unsupported provider"
    };
  } catch (error) {
    return {
      provider: provider === "saucenao" ? "SauceNAO" : provider === "iqdb" ? "IQDB" : provider,
      failed: true,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseSimilarityValue(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

function classifyMatchStrength(providerName, result, providerMeta) {
  const similarity = parseSimilarityValue(result?.similarity);
  if (providerMeta?.failed) return "failed";
  if (providerMeta?.unavailable) return "unavailable";
  if (providerName === "IQDB" && providerMeta?.noRelevantMatches) return similarity !== null && similarity >= 70 ? "possible" : "weak";
  if (similarity === null) return "possible";
  if (similarity >= 85) return "strong";
  if (similarity >= 65) return "possible";
  return "weak";
}

function extractSauceCreator(details) {
  const text = String(details || "");
  const twitter = text.match(/Twitter:\s*(@[^\s]+)/i)?.[1];
  const pixiv = text.match(/Pixiv(?: ID)?:\s*([0-9]+)/i)?.[1];
  const user = text.match(/Member:\s*([^\s|]+)/i)?.[1];
  return twitter || (pixiv ? `Pixiv ${pixiv}` : "") || user || "";
}

function extractPrimaryUrl(result) {
  const links = Array.isArray(result?.links) ? result.links : [];
  return links[0]?.url || "";
}

function summarizeProvider(providerMeta) {
  const first = Array.isArray(providerMeta?.results) ? providerMeta.results[0] : null;
  if (!first) {
    return {
      provider: providerMeta?.provider || "Unknown",
      verdict: providerMeta?.failed ? "failed" : providerMeta?.unavailable ? "unavailable" : "no_match",
      title: "",
      similarity: "",
      creator: "",
      primaryUrl: providerMeta?.fallbackUrl || "",
      note: providerMeta?.reason || providerMeta?.notice || ""
    };
  }
  const provider = providerMeta.provider || "Unknown";
  const verdict = classifyMatchStrength(provider, first, providerMeta);
  const noteBits = [];
  if (providerMeta.notice) noteBits.push(providerMeta.notice);
  if (providerMeta.noRelevantMatches) noteBits.push("provider says no relevant matches");
  if (provider === "IQDB" && first.service) noteBits.push(first.service);
  return {
    provider,
    verdict,
    title: first.title || "",
    similarity: first.similarity || "",
    creator: provider === "SauceNAO" ? extractSauceCreator(first.details) : "",
    primaryUrl: extractPrimaryUrl(first),
    note: noteBits.join("; "),
    fallbackLinks: providerMeta.fallbackLinks || [],
    raw: first
  };
}

function chooseBestLead(providerSummaries) {
  const scoreVerdict = {
    strong: 4,
    possible: 3,
    weak: 2,
    no_match: 1,
    unavailable: 0,
    failed: -1
  };
  const scored = providerSummaries
    .map((entry) => ({
      entry,
      verdictScore: scoreVerdict[entry.verdict] ?? 0,
      similarity: parseSimilarityValue(entry.similarity) ?? -1
    }))
    .sort((a, b) => {
      if (b.verdictScore !== a.verdictScore) return b.verdictScore - a.verdictScore;
      return b.similarity - a.similarity;
    });
  return scored[0]?.entry || null;
}

function formatReverseSearchResult(label, providers, count) {
  const lines = [`REVERSE_IMAGE_SEARCH summary for "${label}":`];
  const summaries = providers.map((provider) => summarizeProvider(provider));
  const best = chooseBestLead(summaries);
  if (best) {
    lines.push("Best lead:");
    lines.push(`- provider: ${best.provider}`);
    lines.push(`- verdict: ${best.verdict}`);
    if (best.title) lines.push(`- title: ${best.title}`);
    if (best.similarity) lines.push(`- similarity: ${best.similarity}`);
    if (best.creator) lines.push(`- creator: ${best.creator}`);
    if (best.primaryUrl) lines.push(`- source: ${best.primaryUrl}`);
    if (best.note) lines.push(`- note: ${best.note}`);
  }
  lines.push("Providers:");
  for (const summary of summaries) {
    lines.push(`- ${summary.provider}: ${summary.verdict}`);
    if (summary.title) lines.push(`  title: ${summary.title}`);
    if (summary.similarity) lines.push(`  similarity: ${summary.similarity}`);
    if (summary.creator) lines.push(`  creator: ${summary.creator}`);
    if (summary.primaryUrl) lines.push(`  source: ${summary.primaryUrl}`);
    if (summary.note) lines.push(`  note: ${summary.note}`);
  }
  const fallbackEntries = [];
  for (const provider of providers) {
    if (provider.fallbackUrl) fallbackEntries.push({ text: provider.provider, url: provider.fallbackUrl });
    if (Array.isArray(provider.fallbackLinks)) fallbackEntries.push(...provider.fallbackLinks);
  }
  const dedupedFallbacks = dedupeLinkEntries(fallbackEntries);
  if (dedupedFallbacks.length) {
    lines.push("Fallback links:");
    dedupedFallbacks.slice(0, Math.max(4, count + 1)).forEach((entry) => {
      lines.push(`- ${entry.text || "link"}: ${entry.url}`);
    });
  }
  lines.push("Treat these as source leads, not proof. Weak/possible matches still need checking.");
  return lines.join("\n");
}

async function executeTextSearch(prefix, params, signal) {
  const query = readString(params, "query");
  if (!query) {
    return {
      content: [{ type: "text", text: `${prefix} error: query is required.` }],
      details: { status: "failed", error: "query is required" }
    };
  }
  const count = readCount(params);
  const safeSearch = normalizeSafeSearch(readString(params, "safeSearch", "moderate"));
  const region = readString(params, "region", "us-en") || "us-en";
  try {
    const results = await searchDuckDuckGoText({ query, count, safeSearch, region, signal });
    return {
      content: [{ type: "text", text: formatTextResults(query, results, prefix) }],
      details: { status: "ok", query, count: results.length, results }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `${prefix} error: ${message}` }],
      details: { status: "failed", error: message }
    };
  }
}

const textTool = {
  name: TEXT_TOOL_NAME,
  label: "Web Text Search",
  description:
    "Search public web pages and return result URLs with short snippets. Use this for current/public facts or source leads.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Public web search query."
      },
      count: {
        type: "number",
        description: `Number of results to return, 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.`
      },
      safeSearch: {
        type: "string",
        enum: ["strict", "moderate", "off"],
        description: "Safe search setting. Default moderate."
      },
      region: {
        type: "string",
        description: "DuckDuckGo region/language code. Default us-en."
      }
    },
    required: ["query"]
  },
  async execute(_toolCallId, params, signal) {
    return executeTextSearch("WEB_TEXT_SEARCH", params, signal);
  }
};

const explicitTextTool = {
  ...textTool,
  name: EXPLICIT_TEXT_TOOL_NAME,
  label: "Explicit Web Text Search",
  description:
    "Bounded DuckDuckGo public text search. Use for general public lookup when Zhihu search is not the right fit; do not loop keyword variants.",
  async execute(_toolCallId, params, signal) {
    return executeTextSearch("EXPLICIT_WEB_TEXT_SEARCH", params, signal);
  }
};

const imageTool = {
  name: IMAGE_TOOL_NAME,
  label: "Web Image Search",
  description:
    "Search public web image results, return candidate URLs/source pages, and for imagebot foreground turns auto-download visible previews into local MEDIA paths. " +
    "Use visible previews plus localMedia paths for generation references; direct public URLs are not stable image_generate inputs.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Public image search query, for example a character, product, place, outfit, logo, or visual style."
      },
      count: {
        type: "number",
        description: `Number of candidates to return, 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.`
      },
      safeSearch: {
        type: "string",
        enum: ["strict", "moderate", "off"],
        description: "Safe search setting. Default moderate."
      },
      region: {
        type: "string",
        description: "DuckDuckGo region/language code. Default us-en."
      },
      downloadPreviews: {
        type: "boolean",
        description: "Whether to download visible candidate previews into local MEDIA paths. Imagebot foreground default true."
      },
      previewCount: {
        type: "number",
        description: `Number of visible candidates to auto-download, 0-${MODEL_VISIBLE_IMAGE_RESULTS}. Imagebot default ${IMAGE_SEARCH_AUTO_DOWNLOAD_PREVIEW_COUNT}.`
      },
      previewTransport: {
        type: "string",
        enum: ["auto", "http", "browser"],
        description: "Optional transport for auto-downloaded previews. auto retries failed HTTP downloads with a bot-owned temporary browser profile."
      },
      ...backgroundToolParameters()
    },
    required: ["query"]
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const query = readString(params, "query");
    if (!query) {
      return {
        content: [{ type: "text", text: "WEB_IMAGE_SEARCH error: query is required." }],
        details: { status: "failed", error: "query is required" }
      };
    }
    const count = readCount(params);
    const safeSearch = normalizeSafeSearch(readString(params, "safeSearch", "moderate"));
    const region = readString(params, "region", "us-en") || "us-en";
    try {
      if (shouldRunInBackground(params)) {
        return await enqueueBackgroundTool({
          toolName: IMAGE_TOOL_NAME,
          config: imageTool.config || {},
          params,
          ctx,
          kind: `${IMAGE_TOOL_NAME}.search`,
          label: `web_image_search ${query}`,
          payload: { query, count, safeSearch, region },
          timeoutMs: REQUEST_TIMEOUT_MS + 15_000,
          handler: async ({ payload, signal: jobSignal, progress }) => {
            await progress({ percent: 10, note: "searching images" });
            const results = await searchDuckDuckGoImages({ ...payload, signal: jobSignal });
            await progress({ percent: 95, note: `${results.length} candidates` });
            return {
              status: "ok",
              query,
              count: results.length,
              resultText: formatResults(query, results),
              results: results.slice(0, MAX_COUNT).map(compactImageResult)
            };
          }
        });
      }
      const results = await searchDuckDuckGoImages({ query, count, safeSearch, region, signal });
      let previewDownloads = [];
      let previewImages = [];
      let previewError = "";
      try {
        previewDownloads = await downloadImageSearchPreviews(results, params, signal, imageTool.config || {}, ctx);
        previewImages = await buildImageSearchPreviewContent(previewDownloads);
      } catch (error) {
        previewError = error instanceof Error ? error.message : String(error);
      }
      return {
        content: [
          { type: "text", text: [formatResults(query, results, previewDownloads), previewError ? `Preview download error: ${previewError}` : ""].filter(Boolean).join("\n") },
          ...previewImages
        ],
        details: {
          status: "ok",
          query,
          count: results.length,
          results: results.map(compactImageResult),
          previewDownloads: previewDownloads.map((entry) => ({
            ok: entry.ok === true,
            candidateIndex: entry.candidateIndex,
            imageUrl: entry.imageUrl,
            sourceUrl: entry.sourceUrl,
            path: entry.path,
            mimeType: entry.mimeType,
            sizeBytes: entry.sizeBytes,
            transport: entry.transport,
            error: entry.error
          })),
          visualPreviewCount: previewImages.length,
          ...previewError ? { previewError } : {}
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `WEB_IMAGE_SEARCH error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

const downloadImageTool = {
  name: DOWNLOAD_TOOL_NAME,
  label: "Download Image URL",
  description:
    "Download one public http/https image URL into the bot's safe local media cache and return a model-visible preview plus MEDIA path. " +
    "Allowed formats: jpg, png, webp, gif. Max size: 20MB. Use for found-image attachments and for public generation references before image_generate.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: {
        type: "string",
        description: "Public http/https image URL to download."
      },
      filename: {
        type: "string",
        description: "Optional short safe base filename without extension."
      },
      maxBytes: {
        type: "number",
        description: `Optional byte limit, capped at ${DOWNLOAD_MAX_BYTES}.`
      },
      transport: {
        type: "string",
        enum: ["auto", "http", "browser"],
        description: "Optional download transport. auto uses known public image mirrors when available and retries failed HTTP downloads with a bot-owned Playwright temporary profile."
      },
      refererUrl: {
        type: "string",
        description: "Optional public referer/source page URL. Useful for Danbooru post pages."
      },
      ...backgroundToolParameters()
    },
    required: ["url"]
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    try {
      if (shouldRunInBackground(params)) {
        return await enqueueBackgroundTool({
          toolName: DOWNLOAD_TOOL_NAME,
          config: downloadImageTool.config || {},
          params,
          ctx,
          kind: `${DOWNLOAD_TOOL_NAME}.download`,
          label: `download_image_url ${readString(params, "url")}`,
          payload: params,
          timeoutMs: DOWNLOAD_BROWSER_TIMEOUT_MS + 20_000,
          handler: async ({ payload, signal: jobSignal, progress }) => {
            await progress({ percent: 10, note: "downloading image" });
            const downloaded = await downloadImageUrl(payload, jobSignal);
            await progress({ percent: 95, note: "image downloaded" });
            return {
              status: "ok",
              sourceUrl: downloaded.finalUrl,
              mediaPath: downloaded.path,
              mimeType: downloaded.mimeType,
              sizeBytes: downloaded.sizeBytes,
              transport: downloaded.transport,
              sourceSafetyHint: sourceSafetyHintForImageUrl(downloaded.finalUrl),
              resultText: [
                "DOWNLOAD_IMAGE_URL ok:",
                `sourceUrl: ${downloaded.finalUrl}`,
                `mimeType: ${downloaded.mimeType}`,
                `sizeBytes: ${downloaded.sizeBytes}`,
                `transport: ${downloaded.transport || "unknown"}`,
                `MEDIA: \`${downloaded.path}\``
              ].join("\n")
            };
          }
        });
      }
      const downloaded = await downloadImageUrl(params, signal);
      const preview = await buildToolResultImagePreview(downloaded);
      const sourceSafetyHint = sourceSafetyHintForImageUrl(downloaded.finalUrl);
      const text = [
        "DOWNLOAD_IMAGE_URL ok:",
        `sourceUrl: ${downloaded.finalUrl}`,
        `mimeType: ${downloaded.mimeType}`,
        `sizeBytes: ${downloaded.sizeBytes}`,
        `transport: ${downloaded.transport || "unknown"}`,
        `visualPreview: ${formatVisualPreviewStatus(downloaded, preview)}`,
        `MEDIA: \`${downloaded.path}\``,
        buildDownloadDeliveryGuidance({
          previewIncluded: Boolean(preview),
          sourceSafetyHint
        })
      ].join("\n");
      return {
        content: [
          { type: "text", text },
          ...(preview ? [preview] : [])
        ],
        details: {
          status: "ok",
          sourceUrl: downloaded.finalUrl,
          path: downloaded.path,
          mimeType: downloaded.mimeType,
          sizeBytes: downloaded.sizeBytes,
          sha256Prefix: downloaded.hash,
          sourceSafetyHint,
          visualPreviewIncluded: Boolean(preview),
          media: {
            path: downloaded.path,
            mediaUrl: downloaded.path,
            mimeType: downloaded.mimeType,
            outbound: false
          },
          transport: downloaded.transport,
          fallbackFrom: downloaded.fallbackFrom,
          fallbackError: downloaded.fallbackError
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `DOWNLOAD_IMAGE_URL error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

const downloadImagesTool = {
  name: DOWNLOAD_MANY_TOOL_NAME,
  label: "Download Image URLs",
  description:
    "Download 2-10 public http/https image URLs into the bot's safe local media cache for Telegram attachment, usually so Telegram can send them as an album. " +
    "Allowed formats: jpg, png, webp, gif. Max size per image: 20MB. Use only when the user explicitly wants multiple found images attached/downloaded.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: DOWNLOAD_MANY_MAX_COUNT,
        description: "Public http/https image URLs to download. Use at most 10."
      },
      filenamePrefix: {
        type: "string",
        description: "Optional short safe filename prefix without extension."
      },
      maxBytes: {
        type: "number",
        description: `Optional per-image byte limit, capped at ${DOWNLOAD_MAX_BYTES}.`
      },
      transport: {
        type: "string",
        enum: ["auto", "http", "browser"],
        description: "Optional download transport for each URL. auto uses known public image mirrors when available and retries failed HTTP downloads with a bot-owned Playwright temporary profile."
      },
      refererUrl: {
        type: "string",
        description: "Optional public referer/source page URL shared by all downloads."
      },
      ...backgroundToolParameters()
    },
    required: ["urls"]
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    try {
      if (shouldRunInBackground(params)) {
        return await enqueueBackgroundTool({
          toolName: DOWNLOAD_MANY_TOOL_NAME,
          config: downloadImagesTool.config || {},
          params,
          ctx,
          kind: `${DOWNLOAD_MANY_TOOL_NAME}.download`,
          label: "download_image_urls",
          payload: params,
          timeoutMs: DOWNLOAD_BROWSER_TIMEOUT_MS * Math.min(DOWNLOAD_MANY_MAX_COUNT, Array.isArray(params?.urls) ? params.urls.length : 1) + 20_000,
          handler: async ({ payload, signal: jobSignal, progress }) => {
            await progress({ percent: 10, note: "downloading images" });
            const results = await downloadImageUrls(payload, jobSignal);
            const successes = results.filter((entry) => entry.ok);
            const failures = results.filter((entry) => !entry.ok);
            await progress({ percent: 95, note: `${successes.length} ok, ${failures.length} failed` });
            const lines = [`DOWNLOAD_IMAGE_URLS completed: ${successes.length} ok, ${failures.length} failed.`];
            for (const entry of successes) {
              lines.push(`sourceUrl: ${entry.finalUrl}`, `mimeType: ${entry.mimeType}`, `sizeBytes: ${entry.sizeBytes}`, `transport: ${entry.transport || "unknown"}`, `MEDIA: \`${entry.path}\``);
            }
            for (const entry of failures.slice(0, 5)) lines.push(`failed: ${entry.url} :: ${entry.error}`);
            return {
              status: successes.length > 0 ? failures.length > 0 ? "partial" : "ok" : "failed",
              ok: successes.length,
              failed: failures.length,
              mediaPaths: successes.map((entry) => entry.path),
              resultText: lines.join("\n")
            };
          }
        });
      }
      const results = await downloadImageUrls(params, signal);
      const successes = results.filter((entry) => entry.ok);
      const failures = results.filter((entry) => !entry.ok);
      const previews = await buildToolResultImagePreviews(successes);
      const sourceSafetyHints = successes.map((entry) => sourceSafetyHintForImageUrl(entry.finalUrl || entry.url));
      const aggregateSourceSafetyHint = sourceSafetyHints.includes("adult_or_sensitive_source") ? "adult_or_sensitive_source" : "unknown";
      const lines = [`DOWNLOAD_IMAGE_URLS completed: ${successes.length} ok, ${failures.length} failed.`];
      for (const [index, entry] of successes.entries()) {
        lines.push(
          `sourceUrl: ${entry.finalUrl}`,
          `mimeType: ${entry.mimeType}`,
          `sizeBytes: ${entry.sizeBytes}`,
          `transport: ${entry.transport || "unknown"}`,
          `sourceSafetyHint: ${sourceSafetyHints[index] || "unknown"}`,
          `MEDIA: \`${entry.path}\``
        );
      }
      for (const entry of failures.slice(0, 5)) {
        lines.push(`failed: ${entry.url} :: ${entry.error}`);
      }
      lines.push(`visualPreview: ${previews.length}/${successes.length} included`);
      lines.push(buildDownloadDeliveryGuidance({
        previewIncluded: previews.length > 0,
        sourceSafetyHint: aggregateSourceSafetyHint,
        plural: true
      }));
      return {
        content: [
          { type: "text", text: lines.join("\n") },
          ...previews
        ],
        details: {
          status: successes.length > 0 ? failures.length > 0 ? "partial" : "ok" : "failed",
          ok: successes.length,
          failed: failures.length,
          results,
          sourceSafetyHint: aggregateSourceSafetyHint,
          visualPreviewCount: previews.length,
          media: successes.map((entry) => ({
            path: entry.path,
            mediaUrl: entry.path,
            mimeType: entry.mimeType
          }))
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `DOWNLOAD_IMAGE_URLS error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

const spoilerTool = {
  name: SPOILER_TOOL_NAME,
  label: "Telegram Media Spoiler",
  description:
    "Return SPOILER_MEDIA attachment directive(s) for explicitly chosen bot-local image media so the final Telegram reply uses native spoiler blur/cover. " +
    "This does not inspect, censor, alter, or send the image by itself.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      media: {
        type: "string",
        description: "Bot-local media path or MEDIA line to send with Telegram native spoiler."
      },
      path: {
        type: "string",
        description: "Alias for media."
      },
      mediaUrls: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: DOWNLOAD_MANY_MAX_COUNT,
        description: "Bot-local media paths or MEDIA lines to send with Telegram native spoiler."
      }
    }
  },
  async execute(_toolCallId, params) {
    try {
      const rawValues = [];
      const single = readString(params, "media") || readString(params, "path");
      if (single) rawValues.push(single);
      const many = isRecord(params) && Array.isArray(params.mediaUrls) ? params.mediaUrls : [];
      for (const entry of many) if (typeof entry === "string" && entry.trim()) rawValues.push(entry);
      const uniqueValues = [...new Set(rawValues.map((entry) => unwrapMediaDirective(entry)).filter(Boolean))];
      if (uniqueValues.length === 0) throw new Error("media or mediaUrls is required");
      const resolved = [];
      for (const value of uniqueValues.slice(0, DOWNLOAD_MANY_MAX_COUNT)) {
        resolved.push(await resolveLocalMediaForSpoiler(value));
      }
      const lines = [
        "TELEGRAM_MEDIA_SPOILER ok",
        "Use these SPOILER_MEDIA line(s) in the final reply to attach media with Telegram native spoiler.",
        "This tool does not send media by itself.",
        ...resolved.map((entry) => `SPOILER_MEDIA: \`${entry}\``)
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          status: "ok",
          media: {
            mediaUrls: resolved,
            mediaUrl: resolved[0],
            sensitiveMedia: true,
            trustedLocalMedia: true,
            outbound: false
          }
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `TELEGRAM_MEDIA_SPOILER error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

const reverseTool = {
  name: REVERSE_TOOL_NAME,
  label: "Reverse Image Search",
  description:
    "Search source/match sites for a Telegram-delivered image using direct site automation. " +
    "Best for anime/game/illustration identity, source, artist, or Pixiv-style lookups.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      image: {
        type: "string",
        description: "Current Telegram media local path or a public image URL."
      },
      count: {
        type: "number",
        description: "Max matches per provider to include. Default 3."
      },
      providers: {
        type: "array",
        items: {
          type: "string",
          enum: ["saucenao", "iqdb", "ascii2d", "google_lens"]
        },
        description: "Providers to query. Default: SauceNAO + IQDB. Google Lens is slower and best used as a fallback."
      },
      ...backgroundToolParameters()
    },
    required: ["image"]
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    try {
      if (shouldRunInBackground(params)) {
        return await enqueueBackgroundTool({
          toolName: REVERSE_TOOL_NAME,
          config: reverseTool.config || {},
          params,
          ctx,
          kind: `${REVERSE_TOOL_NAME}.search`,
          label: `reverse_image_search ${readString(params, "image")}`,
          payload: params,
          timeoutMs: REVERSE_REQUEST_TIMEOUT_MS + 30_000,
          handler: async ({ payload, signal: jobSignal, progress }) => {
            await progress({ percent: 10, note: "preparing reverse image search" });
            const input = await resolveImageInput(payload);
            const count = readReverseCount(payload);
            const providers = normalizeProviderList(payload);
            await progress({ percent: 25, note: `querying ${providers.join(", ")}` });
            const outputs = await Promise.all(providers.map((provider) => runReverseProvider(provider, input, count, jobSignal)));
            await progress({ percent: 95, note: "reverse search completed" });
            return {
              status: "ok",
              input: input.label,
              inputKind: input.kind,
              providers,
              resultText: formatReverseSearchResult(input.label, outputs, count),
              results: outputs.map((entry) => ({
                provider: entry.provider,
                status: entry.status,
                fallbackUrl: entry.fallbackUrl,
                error: entry.error || "",
                matches: Array.isArray(entry.matches) ? entry.matches.length : 0
              }))
            };
          }
        });
      }
      const input = await resolveImageInput(params);
      const count = readReverseCount(params);
      const providers = normalizeProviderList(params);
      const outputs = await Promise.all(providers.map((provider) => runReverseProvider(provider, input, count, signal)));
      return {
        content: [{ type: "text", text: formatReverseSearchResult(input.label, outputs, count) }],
        details: {
          status: "ok",
          input: input.label,
          inputKind: input.kind,
          providers,
          results: outputs
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `REVERSE_IMAGE_SEARCH error: ${message}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

export const __testing = {
  searchDuckDuckGoImages,
  searchDuckDuckGoText,
  downloadImageUrl,
  downloadImageUrls,
  buildToolResultImagePreview,
  buildToolResultImagePreviews,
  buildDownloadDeliveryGuidance,
  sourceSafetyHintForImageUrl,
  resolveLocalMediaForSpoiler,
  isDanbooruUrl,
  cachedDownloadTransport,
  rememberDownloadTransport,
  downloadUrlCandidates,
  resolveDownloadTransport,
  mapConcurrent,
  selectImageSearchPreviewCandidates,
  shouldAutoDownloadSearchPreviews,
  readSearchPreviewCount,
  readImageGenerateReferences,
  guardImageGenerateReferenceInputs,
  downloadImageSearchPreviews,
  formatResults,
  compactImageResult,
  extractVqd,
  normalizeResult,
  parseSauceResults,
  parseIqdbResults
};

export default {
  id: "web-image-search",
  name: "Local Web Image Search",
  description: "Returns public web, image, reverse-image, and controlled image download candidates for reference selection.",
  register(api) {
    const config = api.config || {};
    createBrowserDownloadSession.config = config;
    textTool.config = config;
    explicitTextTool.config = config;
    imageTool.config = config;
    downloadImageTool.config = config;
    downloadImagesTool.config = config;
    spoilerTool.config = config;
    reverseTool.config = config;
    scheduleDownloadBrowserPrewarm(config);
    api.registerTool(textTool, { name: TEXT_TOOL_NAME });
    api.registerTool(explicitTextTool, { name: EXPLICIT_TEXT_TOOL_NAME });
    api.registerTool(imageTool, { name: IMAGE_TOOL_NAME });
    api.registerTool(downloadImageTool, { name: DOWNLOAD_TOOL_NAME });
    api.registerTool(downloadImagesTool, { name: DOWNLOAD_MANY_TOOL_NAME });
    api.registerTool(spoilerTool, { name: SPOILER_TOOL_NAME });
    api.registerTool(reverseTool, { name: REVERSE_TOOL_NAME });
    api.registerHook?.("before_tool_call", async (event, ctx) => {
      return guardImageGenerateReferenceInputs(event, ctx);
    }, { name: "web-image-search-before-tool-call" });
  }
};

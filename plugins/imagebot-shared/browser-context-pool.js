import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PAGES = 4;
const pools = new Map();

function now() {
  return Date.now();
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function browserExecutablePath(chromium, extraCandidates = []) {
  const candidates = [
    ...extraCandidates,
    chromium?.executablePath?.(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  for (const candidate of candidates) {
    if (candidate && await fileExists(candidate)) return candidate;
  }
  return "";
}

async function closePool(pool) {
  if (pool.closeTimer) clearTimeout(pool.closeTimer);
  pool.closeTimer = null;
  if (pool.context) await pool.context.close().catch(() => {});
  if (pool.browser) await pool.browser.close().catch(() => {});
  pools.delete(pool.key);
}

function scheduleClose(pool) {
  if (pool.closeTimer) clearTimeout(pool.closeTimer);
  pool.closeTimer = setTimeout(() => {
    if (pool.activePages > 0) {
      scheduleClose(pool);
      return;
    }
    const age = now() - pool.lastUsedAt;
    if (age < pool.idleMs) {
      scheduleClose(pool);
      return;
    }
    void closePool(pool);
  }, pool.idleMs);
  pool.closeTimer.unref?.();
}

async function ensurePool(options) {
  const key = String(options.key || "default");
  let pool = pools.get(key);
  if (pool?.context) return pool;
  if (pool?.opening) return await pool.opening;

  pool = {
    key,
    context: null,
    opening: null,
    activePages: 0,
    maxPages: Math.max(1, Math.min(12, Math.trunc(Number(options.maxPages || DEFAULT_MAX_PAGES)))),
    idleMs: Math.max(30_000, Math.trunc(Number(options.idleMs || DEFAULT_IDLE_MS))),
    lastUsedAt: now(),
    closeTimer: null
  };
  pools.set(key, pool);
  pool.opening = (async () => {
    const context = await options.chromium.launchPersistentContext(options.userDataDir, options.launchOptions);
    pool.context = context;
    pool.opening = null;
    scheduleClose(pool);
    return pool;
  })().catch((error) => {
    pools.delete(key);
    throw error;
  });
  return await pool.opening;
}

async function ensureBrowserPool(options) {
  const key = String(options.key || "default-browser");
  let pool = pools.get(key);
  if (pool?.browser) return pool;
  if (pool?.opening) return await pool.opening;

  pool = {
    key,
    browser: null,
    opening: null,
    activePages: 0,
    maxPages: Math.max(1, Math.min(12, Math.trunc(Number(options.maxPages || DEFAULT_MAX_PAGES)))),
    idleMs: Math.max(30_000, Math.trunc(Number(options.idleMs || DEFAULT_IDLE_MS))),
    lastUsedAt: now(),
    closeTimer: null
  };
  pools.set(key, pool);
  pool.opening = (async () => {
    const browser = await options.chromium.launch(options.launchOptions);
    pool.browser = browser;
    pool.opening = null;
    scheduleClose(pool);
    return pool;
  })().catch((error) => {
    pools.delete(key);
    throw error;
  });
  return await pool.opening;
}

async function waitForPageSlot(pool, signal, timeoutMs = 15_000) {
  const started = now();
  while (pool.activePages >= pool.maxPages) {
    if (signal?.aborted) throw signal.reason || new Error("browser context wait aborted");
    if (now() - started > timeoutMs) throw new Error("browser context page pool is busy");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function withPooledPage(options, fn) {
  const pool = await ensurePool(options);
  await waitForPageSlot(pool, options.signal, options.slotTimeoutMs);
  pool.activePages += 1;
  pool.lastUsedAt = now();
  let page = null;
  try {
    page = await pool.context.newPage();
    if (options.viewport) await page.setViewportSize(options.viewport).catch(() => {});
    return await fn(page, pool.context, { reused: true, key: pool.key });
  } catch (error) {
    if (/Target page, context or browser has been closed|Browser has been closed/i.test(String(error?.message || error))) {
      await closePool(pool);
    }
    throw error;
  } finally {
    if (page) await page.close().catch(() => {});
    pool.activePages = Math.max(0, pool.activePages - 1);
    pool.lastUsedAt = now();
    scheduleClose(pool);
  }
}

export async function withEphemeralPage(options, fn) {
  const pool = await ensureBrowserPool(options);
  await waitForPageSlot(pool, options.signal, options.slotTimeoutMs);
  pool.activePages += 1;
  pool.lastUsedAt = now();
  let context = null;
  let page = null;
  try {
    context = await pool.browser.newContext(options.contextOptions || {});
    page = await context.newPage();
    if (options.viewport) await page.setViewportSize(options.viewport).catch(() => {});
    return await fn(page, context, { reused: true, key: pool.key, persistent: false });
  } catch (error) {
    if (/Target page, context or browser has been closed|Browser has been closed/i.test(String(error?.message || error))) {
      await closePool(pool);
    }
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    pool.activePages = Math.max(0, pool.activePages - 1);
    pool.lastUsedAt = now();
    scheduleClose(pool);
  }
}

export async function closeBrowserContextPool(key = "") {
  if (key) {
    const pool = pools.get(key);
    if (pool) await closePool(pool);
    return;
  }
  await Promise.all([...pools.values()].map((pool) => closePool(pool)));
}

export function browserContextPoolStats() {
  return [...pools.values()].map((pool) => ({
    key: pool.key,
    activePages: pool.activePages,
    maxPages: pool.maxPages,
    idleMs: pool.idleMs,
    open: Boolean(pool.context),
    opening: Boolean(pool.opening),
    lastUsedAt: pool.lastUsedAt
  }));
}

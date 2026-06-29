import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "Chrome/120.0 Safari/537.36";

const DEFAULT_URLS = [
  "about:blank",
  "https://safebooru.donmai.us/"
];

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function readArg(name, fallback = "") {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg === name || arg.startsWith(prefix));
  if (!found) return fallback;
  if (found === name) return "true";
  return found.slice(prefix.length);
}

function runtimeRequireCandidates() {
  const candidates = [
    import.meta.url,
    path.join(repoRoot, "plugins", "imagebot-practical-tools", "index.js"),
    path.join(repoRoot, "plugins", "web-image-search", "index.js"),
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

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function browserExecutablePath(chromium) {
  const candidates = [
    chromium.executablePath(),
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

async function cleanupOldProfiles(root, maxAgeMs = 24 * 60 * 60 * 1000) {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("browser-prewarm-")) continue;
    const fullPath = path.join(root, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        await fs.rm(fullPath, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Best-effort temp cleanup only.
    }
  }
  return removed;
}

function normalizeUrls() {
  const raw = readArg("--urls", "");
  const values = raw
    ? raw.split(",").map((item) => item.trim()).filter(Boolean)
    : DEFAULT_URLS;
  return [...new Set(values)].slice(0, 6);
}

async function gotoWarmPage(context, url, timeoutMs) {
  const startedAt = Date.now();
  const page = await context.newPage();
  try {
    if (url === "about:blank") {
      await page.goto(url, { timeout: timeoutMs });
    } else {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await page.waitForTimeout(250).catch(() => {});
    }
    return {
      url,
      ok: true,
      finalUrl: page.url(),
      title: await page.title().catch(() => ""),
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      url,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function warmContextRoute({ label, chromium, launchOptions, urls, timeoutMs }) {
  const routeStartedAt = Date.now();
  const baseTmpDir = path.join(homeDir(), ".openclaw", "tmp");
  const userDataDir = await fs.mkdtemp(path.join(baseTmpDir, `browser-prewarm-${label}-`));
  let context = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    const results = [];
    for (const url of urls) {
      results.push(await gotoWarmPage(context, url, timeoutMs));
    }
    return {
      label,
      ok: results.some((entry) => entry.ok),
      durationMs: Date.now() - routeStartedAt,
      urls: results
    };
  } catch (error) {
    return {
      label,
      ok: false,
      durationMs: Date.now() - routeStartedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (context) await context.close().catch(() => {});
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

const startedAt = Date.now();
const timeoutMs = Math.max(3000, Math.min(30000, Number(readArg("--timeout-ms", "15000")) || 15000));
const urls = normalizeUrls();
const tmpRoot = path.join(homeDir(), ".openclaw", "tmp");

try {
  const playwright = requireRuntimeModule("playwright-core");
  if (!playwright?.chromium) throw new Error("playwright-core chromium is unavailable");
  const executablePath = await browserExecutablePath(playwright.chromium);
  if (!executablePath) throw new Error("no Chromium/Chrome/Edge executable is available for browser prewarm");

  await fs.mkdir(tmpRoot, { recursive: true });
  const oldProfilesRemoved = await cleanupOldProfiles(tmpRoot);
  const commonLaunchOptions = {
    headless: true,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 720 },
    acceptDownloads: false,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions"]
  };

  const routes = [];
  routes.push(await warmContextRoute({
    label: "executable",
    chromium: playwright.chromium,
    launchOptions: { ...commonLaunchOptions, executablePath },
    urls,
    timeoutMs
  }));

  if (path.basename(executablePath).toLowerCase() !== "msedge.exe") {
    routes.push(await warmContextRoute({
      label: "msedge-channel",
      chromium: playwright.chromium,
      launchOptions: { ...commonLaunchOptions, channel: "msedge" },
      urls,
      timeoutMs
    }));
  }

  const okCount = routes.filter((entry) => entry.ok).length;
  console.log(JSON.stringify({
    status: okCount > 0 ? "ok" : "degraded",
    durationMs: Date.now() - startedAt,
    executable: path.basename(executablePath),
    routes,
    oldProfilesRemoved
  }, null, 2));
  process.exitCode = okCount > 0 ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({
    status: "failed",
    durationMs: Date.now() - startedAt,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
}

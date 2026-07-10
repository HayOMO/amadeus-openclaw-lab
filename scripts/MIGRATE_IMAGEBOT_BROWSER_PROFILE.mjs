import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { openclawStatePath } from "../plugins/imagebot-shared/openclaw-paths.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const write = process.argv.includes("--write");
const sourceRoot = openclawStatePath("practical-tools", "browser-profiles", "account");
const targetDir = openclawStatePath("browser", "bot", "user-data");
const sourceNames = [
  "xiaohongshu",
  "weibo",
  "bilibili",
  "pixiv",
  "zhihu",
  "baidu_tieba",
  "lofter"
];

const loginMarkers = [
  { service: "Xiaohongshu", domains: ["xiaohongshu.com"], names: ["web_session"] },
  { service: "Weibo", domains: ["weibo.com", "sina.com.cn"], names: ["SUB"] },
  { service: "Pixiv", domains: ["pixiv.net"], names: ["PHPSESSID"] },
  { service: "Bilibili", domains: ["bilibili.com"], names: ["SESSDATA", "DedeUserID"] },
  { service: "Zhihu", domains: ["zhihu.com"], names: ["z_c0"] },
  { service: "Baidu", domains: ["baidu.com"], names: ["BDUSS"] },
  { service: "Lofter", domains: ["lofter.com"], names: ["P_OINFO"] }
];

function runtimeRequire(moduleName) {
  const candidates = [
    process.env.OPENCLAW_RUNTIME_MAIN,
    path.join(path.dirname(process.execPath), "node_modules", "openclaw", "openclaw.mjs"),
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Microsoft",
      "WinGet",
      "Packages",
      "OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe",
      "node-v24.15.0-win-x64",
      "node_modules",
      "openclaw",
      "openclaw.mjs"
    )
  ].filter(Boolean);
  let lastError;
  for (const candidate of candidates) {
    try {
      return createRequire(candidate)(moduleName);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Cannot load ${moduleName} from OpenClaw runtime`);
}

async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function executablePath(chromium) {
  const candidates = [
    chromium?.executablePath?.(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  for (const candidate of candidates) {
    if (candidate && await fileExists(candidate)) return candidate;
  }
  throw new Error("No Chromium-based browser executable found");
}

function domainMatches(cookieDomain, expected) {
  const normalized = String(cookieDomain || "").toLowerCase().replace(/^\./, "");
  return normalized === expected || normalized.endsWith(`.${expected}`);
}

function markerStatus(cookies) {
  return loginMarkers.map((marker) => ({
    service: marker.service,
    verified: cookies.some((cookie) =>
      marker.names.includes(cookie.name) && marker.domains.some((domain) => domainMatches(cookie.domain, domain))
    )
  }));
}

async function readProfileCookies(chromium, browserPath, userDataDir) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: browserPath,
    acceptDownloads: false,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions"]
  });
  try {
    const now = Date.now() / 1000;
    return (await context.cookies()).filter((cookie) => cookie.expires <= 0 || cookie.expires > now);
  } finally {
    await context.close();
  }
}

const playwright = runtimeRequire("playwright-core");
if (!playwright?.chromium) throw new Error("playwright-core chromium is unavailable");
const browserPath = await executablePath(playwright.chromium);
const collected = [];
const sources = [];

for (const name of sourceNames) {
  const userDataDir = path.join(sourceRoot, name);
  if (!await fileExists(path.join(userDataDir, "Default", "Network", "Cookies"))) continue;
  const cookies = await readProfileCookies(playwright.chromium, browserPath, userDataDir);
  collected.push(...cookies);
  sources.push({ name, cookieCount: cookies.length, loginMarkers: markerStatus(cookies) });
}

const uniqueCookies = [...new Map(collected.map((cookie) => [
  `${cookie.domain}\n${cookie.path}\n${cookie.name}`,
  cookie
])).values()];

let targetStatus = [];
if (write) {
  await fs.mkdir(targetDir, { recursive: true });
  const context = await playwright.chromium.launchPersistentContext(targetDir, {
    headless: true,
    executablePath: browserPath,
    acceptDownloads: false,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions"]
  });
  try {
    await context.addCookies(uniqueCookies);
    targetStatus = markerStatus(await context.cookies());
  } finally {
    await context.close();
  }
}

console.log(JSON.stringify({
  mode: write ? "write" : "dry-run",
  sourceRoot,
  targetDir,
  sourceProfiles: sources,
  migratedCookieCount: write ? uniqueCookies.length : 0,
  candidateCookieCount: uniqueCookies.length,
  targetLoginMarkers: targetStatus,
  note: "Cookie values are transferred only in process memory and are never printed or written as plaintext."
}, null, 2));

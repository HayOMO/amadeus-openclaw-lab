import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sqlite3 from "node:sqlite";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveOpenClawMain } from "./OPENCLAW_RUNTIME_PATHS.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const profileRoot = path.join(os.homedir(), ".openclaw", "practical-tools", "browser-profiles", "account");
const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "Chrome/120.0 Safari/537.36";

const platforms = [
  {
    id: "weibo",
    name: "Weibo",
    domains: ["weibo.com", "sina.com.cn", "sina.com"],
    markers: ["SUB", "SUBP", "SSOLoginState", "ALF", "WBPSESS"],
    url: "https://s.weibo.com/weibo?q=%E7%8C%AB%E7%8C%AB%20%E8%A1%A8%E6%83%85%E5%8C%85",
    loginUrlPattern: /passport\.weibo\.com|login\.sina\.com/i,
    blockedPattern: /验证码|安全验证|访问过于频繁|异常流量|captcha|verify/i
  },
  {
    id: "bilibili",
    name: "Bilibili",
    domains: ["bilibili.com"],
    markers: ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5"],
    url: "https://search.bilibili.com/all?keyword=%E7%8C%AB%E7%8C%AB%20%E8%A1%A8%E6%83%85%E5%8C%85",
    loginUrlPattern: /passport\.bilibili\.com/i,
    blockedPattern: /验证码|安全验证|captcha|verify/i
  },
  {
    id: "baidu_tieba",
    name: "Baidu/Tieba",
    domains: ["baidu.com", "tieba.baidu.com"],
    markers: ["BDUSS", "STOKEN", "PTOKEN", "BDUSS_BFESS"],
    url: "https://tieba.baidu.com/f/search/res?ie=utf-8&qw=%E7%8C%AB%E7%8C%AB%20%E8%A1%A8%E6%83%85%E5%8C%85",
    loginUrlPattern: /passport\.baidu\.com/i,
    blockedPattern: /验证码|安全验证|访问过于频繁|异常流量|captcha|verify/i
  },
  {
    id: "xiaohongshu",
    name: "Xiaohongshu",
    domains: ["xiaohongshu.com"],
    markers: ["web_session", "webId", "a1", "xsecappid", "web_session_id"],
    url: "https://www.xiaohongshu.com/search_result?keyword=%E7%8C%AB%E7%8C%AB%20%E8%A1%A8%E6%83%85%E5%8C%85",
    loginUrlPattern: /login|signin/i,
    blockedPattern: /验证码|安全验证|异常|captcha|verify/i
  },
  {
    id: "zhihu",
    name: "Zhihu",
    domains: ["zhihu.com"],
    markers: ["z_c0", "q_c1"],
    url: "https://www.zhihu.com/search?type=content&q=%E7%8C%AB%E7%8C%AB%20%E8%A1%A8%E6%83%85%E5%8C%85",
    loginUrlPattern: /signin|login/i,
    blockedPattern: /验证码|安全验证|captcha|verify/i
  },
  {
    id: "pixiv",
    name: "Pixiv",
    domains: ["pixiv.net"],
    markers: ["PHPSESSID"],
    url: "https://www.pixiv.net/tags/%E7%8C%AB/artworks",
    loginUrlPattern: /\/login/i,
    blockedPattern: /captcha|verify|cloudflare/i
  },
  {
    id: "lofter",
    name: "LOFTER",
    domains: ["lofter.com", "163.com"],
    markers: ["LOFTER_SESS", "MUSIC_U", "NTES_SESS"],
    url: "https://www.lofter.com/tag/%E7%8C%AB%E7%8C%AB",
    loginUrlPattern: /login|passport/i,
    blockedPattern: /验证码|安全验证|captcha|verify/i
  }
];

function requireRuntimeModule(moduleName) {
  const candidates = [
    process.env.OPENCLAW_RUNTIME_MAIN,
    path.join(path.dirname(process.execPath), "node_modules", "openclaw", "openclaw.mjs"),
    resolveOpenClawMain()
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return createRequire(candidate)(moduleName);
    } catch {}
  }
  throw new Error(`Cannot load ${moduleName} from OpenClaw runtime`);
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

function profileDirFor(platform) {
  return path.join(profileRoot, platform.id);
}

async function readCookieMarkers(platform, profileDir) {
  const src = path.join(profileDir, "Default", "Network", "Cookies");
  if (!await fileExists(src)) {
    return {
      status: "no_profile_cookies",
      cookieCount: 0,
      loginMarkers: [],
      sampleNames: []
    };
  }
  const outDir = path.join(repoRoot, ".runtime", "probes");
  await fs.mkdir(outDir, { recursive: true });
  const copy = path.join(outDir, `cookies-domain-probe-${platform.id}-${Date.now()}.sqlite`);
  await fs.copyFile(src, copy);
  const db = new sqlite3.DatabaseSync(copy, { readOnly: true });
  const rows = db.prepare("select host_key, name from cookies").all();
  db.close();
  const matched = rows.filter((row) => platform.domains.some((domain) => row.host_key === domain || row.host_key.endsWith(`.${domain}`) || row.host_key.endsWith(domain)));
  const names = [...new Set(matched.map((row) => row.name))].sort();
  const markers = names.filter((name) => platform.markers.includes(name));
  return {
    status: markers.length ? "login_marker_present" : matched.length ? "cookies_present_uncertain" : "no_cookies",
    cookieCount: matched.length,
    loginMarkers: markers,
    sampleNames: names.slice(0, 16)
  };
}

function classifyPage(platform, details) {
  const text = `${details.title}\n${details.bodyText}`.toLowerCase();
  if (platform.loginUrlPattern.test(details.finalUrl)) return "login_redirect";
  if (platform.blockedPattern.test(text)) return "blocked_or_verification";
  if (details.visibleImageCount >= 4 || details.textLength >= 1200 || details.linkCount >= 20) return "page_accessible";
  if (/登录|登陆|扫码|sign in|login|请先登录|登录后/i.test(text)) return "login_prompt_or_limited";
  return "unclear";
}

async function verifyPage(context, platform) {
  const page = await context.newPage();
  try {
    await page.goto(platform.url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.waitForTimeout(2500);
    const details = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width >= 32 && rect.height >= 32 && style.display !== "none" && style.visibility !== "hidden";
      };
      const images = [...document.images].filter(visible);
      const links = [...document.querySelectorAll("a[href]")];
      const bodyText = document.body?.innerText || "";
      return {
        title: document.title || "",
        finalUrl: location.href,
        bodyText: bodyText.slice(0, 3000),
        textLength: bodyText.length,
        visibleImageCount: images.length,
        linkCount: links.length
      };
    });
    return { status: classifyPage(platform, details), ...details, bodyText: undefined };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    await page.close().catch(() => {});
  }
}

const playwright = requireRuntimeModule("playwright-core");
if (!playwright?.chromium) throw new Error("playwright-core chromium is unavailable");
const executablePath = await browserExecutablePath(playwright.chromium);
if (!executablePath) throw new Error("No Chromium/Chrome/Edge executable found");

const results = [];
for (const platform of platforms) {
  const profileDir = profileDirFor(platform);
  const cookie = await readCookieMarkers(platform, profileDir);
  let context = null;
  try {
    context = await playwright.chromium.launchPersistentContext(profileDir, {
      headless: true,
      executablePath,
      viewport: { width: 1365, height: 900 },
      userAgent,
      locale: "zh-CN",
      acceptDownloads: false,
      args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions"]
    });
    const page = await verifyPage(context, platform);
    results.push({ id: platform.id, name: platform.name, profileDir, cookie, page });
  } catch (error) {
    results.push({
      id: platform.id,
      name: platform.name,
      profileDir,
      cookie,
      page: { status: "failed", error: error instanceof Error ? error.message : String(error) }
    });
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

const outDir = path.join(repoRoot, ".runtime", "probes");
await fs.mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = path.join(outDir, `browser-login-verification-${stamp}.json`);
const mdPath = path.join(outDir, `browser-login-verification-${stamp}.md`);
const report = { createdAt: new Date().toISOString(), profileRoot, results };
await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const lines = [
  "# Browser Login Verification",
  "",
  `- Profile root: ${profileRoot}`,
  `- Created: ${report.createdAt}`,
  "",
  "| Platform | Profile | Cookie status | Login markers | Page status | Images | Text chars | Final URL |",
  "|---|---|---|---|---|---:|---:|---|"
];
for (const item of results) {
  lines.push(`| ${item.name} | ${item.id} | ${item.cookie.status} | ${item.cookie.loginMarkers.join(", ") || "-"} | ${item.page.status} | ${item.page.visibleImageCount ?? 0} | ${item.page.textLength ?? 0} | ${item.page.finalUrl || ""} |`);
}
await fs.writeFile(mdPath, `${lines.join("\n")}\n`, "utf8");

console.log(JSON.stringify({
  mdPath,
  jsonPath,
  results: results.map((item) => ({
    platform: item.name,
    cookieStatus: item.cookie.status,
    loginMarkers: item.cookie.loginMarkers,
    pageStatus: item.page.status,
    visibleImageCount: item.page.visibleImageCount ?? 0,
    textLength: item.page.textLength ?? 0,
    finalUrl: item.page.finalUrl || "",
    error: item.page.error || ""
  }))
}, null, 2));

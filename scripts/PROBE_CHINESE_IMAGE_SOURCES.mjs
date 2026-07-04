import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveOpenClawMain } from "./OPENCLAW_RUNTIME_PATHS.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const query = process.argv.slice(2).join(" ").trim() || "芙莉莲 表情包";
const timeoutMs = 25_000;
const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "Chrome/120.0 Safari/537.36";

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

function encode(value) {
  return encodeURIComponent(value);
}

const targets = [
  {
    id: "weibo_search",
    platform: "Weibo",
    url: `https://s.weibo.com/weibo?q=${encode(query)}`
  },
  {
    id: "tieba_search",
    platform: "Baidu Tieba",
    url: `https://tieba.baidu.com/f/search/res?ie=utf-8&qw=${encode(query)}`
  },
  {
    id: "xiaohongshu_search",
    platform: "Xiaohongshu",
    url: `https://www.xiaohongshu.com/search_result?keyword=${encode(query)}`
  },
  {
    id: "bilibili_search",
    platform: "Bilibili",
    url: `https://search.bilibili.com/all?keyword=${encode(query)}`
  },
  {
    id: "zhihu_search",
    platform: "Zhihu",
    url: `https://www.zhihu.com/search?type=content&q=${encode(query)}`
  },
  {
    id: "baidu_image",
    platform: "Baidu Image",
    url: `https://image.baidu.com/search/index?tn=baiduimage&word=${encode(query)}`
  }
];

function classify(metrics) {
  const text = `${metrics.title}\n${metrics.text}`.toLowerCase();
  const blocked = /验证码|安全验证|访问过于频繁|异常流量|verify|captcha|robot|风险/i.test(text);
  const login = /登录|登陆|注册|扫码|sign in|login|请先登录|登录后|打开小红书app/i.test(text);
  if (blocked) return "blocked_or_verification";
  if (login && metrics.visibleImageCount < 4 && metrics.textLength < 1200) return "login_required";
  if (login && metrics.visibleImageCount >= 4) return "partial_with_login_prompt";
  if (metrics.visibleImageCount >= 6 || metrics.textLength >= 1500) return "public_or_partial";
  return "unclear";
}

async function probeTarget(context, target) {
  const page = await context.newPage();
  try {
    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(2500);
    const metrics = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width >= 32 && rect.height >= 32 && style.display !== "none" && style.visibility !== "hidden";
      };
      const images = [...document.images];
      const visibleImages = images.filter(visible);
      const links = [...document.querySelectorAll("a[href]")]
        .slice(0, 80)
        .map((node) => ({ text: node.textContent?.trim().slice(0, 80) || "", href: node.href }))
        .filter((item) => item.text || item.href);
      const text = document.body?.innerText || "";
      return {
        title: document.title || "",
        finalUrl: location.href,
        text: text.slice(0, 4000),
        textLength: text.length,
        imageCount: images.length,
        visibleImageCount: visibleImages.length,
        linkCount: links.length,
        sampleLinks: links.slice(0, 8)
      };
    });
    return { ...target, status: classify(metrics), ...metrics };
  } catch (error) {
    return { ...target, status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    await page.close().catch(() => {});
  }
}

const playwright = requireRuntimeModule("playwright-core");
if (!playwright?.chromium) throw new Error("playwright-core chromium is unavailable");
const executablePath = await browserExecutablePath(playwright.chromium);
if (!executablePath) throw new Error("No Chromium/Chrome/Edge executable found");

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-cn-source-probe-"));
let context = null;
try {
  context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath,
    viewport: { width: 1365, height: 900 },
    userAgent,
    locale: "zh-CN",
    acceptDownloads: false,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions"]
  });
  const results = [];
  for (const target of targets) {
    results.push(await probeTarget(context, target));
  }
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(repoRoot, ".runtime", "probes");
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `chinese-image-sources-${stamp}.json`);
  const mdPath = path.join(outDir, `chinese-image-sources-${stamp}.md`);
  const report = { query, createdAt: now.toISOString(), executablePath, results };
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const lines = [
    `# Chinese Image Source Probe`,
    "",
    `- Query: ${query}`,
    `- Created: ${now.toISOString()}`,
    "",
    "| Platform | Status | Visible Images | Text Chars | Final URL |",
    "|---|---:|---:|---:|---|"
  ];
  for (const item of results) {
    lines.push(`| ${item.platform} | ${item.status} | ${item.visibleImageCount ?? 0} | ${item.textLength ?? 0} | ${item.finalUrl || item.url} |`);
  }
  lines.push("", "## Notes", "");
  for (const item of results) {
    lines.push(`- ${item.platform}: ${item.status}${item.error ? ` (${item.error})` : ""}`);
  }
  await fs.writeFile(mdPath, `${lines.join("\n")}\n`, "utf8");
  console.log(JSON.stringify({
    query,
    mdPath,
    jsonPath,
    results: results.map((item) => ({
      platform: item.platform,
      status: item.status,
      visibleImageCount: item.visibleImageCount ?? 0,
      textLength: item.textLength ?? 0,
      finalUrl: item.finalUrl || item.url,
      error: item.error || ""
    }))
  }, null, 2));
} finally {
  if (context) await context.close().catch(() => {});
  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

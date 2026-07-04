import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const DEFAULT_OUT_DIR = path.join(repoRoot, "docs", "bot_feature_scouting");
const USER_AGENT = "AmaduseImagebotFeatureScout/1.0 (+https://github.com)";

const SEARCH_QUERIES = [
  "topic:chatbot stars:>500",
  "topic:telegram-bot stars:>100",
  "topic:discord-bot stars:>100",
  "topic:bot-framework stars:>100",
  "topic:bots stars:>100",
  "chatbot in:name,description stars:>1000",
  "telegram bot in:name,description stars:>500",
  "discord bot in:name,description stars:>500",
  "bot in:name,description stars:>5000"
];

const CATEGORY_RULES = [
  ["feed-monitor", /rss|feed|watch|monitor|notification|subscribe|webhook|release feed|提醒|订阅|监控/i],
  ["moderation", /moderation|admin|ban|kick|mute|warning|anti[- ]?spam|filter|captcha|raid|automod|blacklist|whitelist|审核|封禁|禁言|反垃圾/i],
  ["bridge", /bridge|cross[- ]?post|relay|forward|telegram.*discord|discord.*telegram|matrix|slack/i],
  ["media", /image|video|audio|voice|transcrib|sticker|meme|gallery|download|媒体|语音|图片|视频|表情/i],
  ["ai-chat", /ai|llm|rag|prompt|memory|agent|model|chatgpt|openai|assistant|function call|tool/i],
  ["game", /game|gacha|level|xp|economy|points|leaderboard|quest|trivia|poll|抽卡|签到|积分|排行榜/i],
  ["ops", /deploy|docker|config|plugin|extension|health|metrics|logging|backup|admin panel|dashboard/i],
  ["crm", /ticket|support|faq|qna|handoff|operator|customer|helpdesk/i],
  ["dev", /github|issue|pull request|commit|release|ci|package|npm|pypi|repo/i]
];

const BOUNDARY_RULES = [
  {
    status: "conflict",
    reason: "Mass messaging, selfbot, unsolicited DM, or growth automation conflicts with safe Telegram bot boundaries.",
    pattern: /selfbot|mass dm|mass message|campaign|scrape users|invite spam|低成本群发|私信群发/i
  },
  {
    status: "conflict",
    reason: "Destructive moderation requires explicit group-admin authority, audit logs, rate limits, and owner/group consent before implementation.",
    pattern: /ban|kick|mute|delete messages|purge|raid|封禁|踢出|禁言|删消息/i
  },
  {
    status: "conflict",
    reason: "Music/voice streaming bots need long-running voice-session infrastructure outside the current Telegram imagebot scope.",
    pattern: /music|spotify|youtube playback|voice channel|stream audio|音乐播放|语音频道/i
  },
  {
    status: "candidate",
    reason: "Fits the local bot as a bounded tool, feature manifest, or learned workflow with scoped state.",
    pattern: /.*/
  }
];

const ALREADY_SUPPORTED_RULES = [
  [/image generation|generate image|image edit|sticker|meme|gallery|gacha|draw card|抽卡|生图|表情/i, "Covered partly by image_generate, sticker, gallery, and waifu_gacha tools."],
  [/memory|remember|preference|learned skill|feedback/i, "Covered partly by memory_search, image_feedback, image skills, and learned_skill."],
  [/voice.*transcrib|transcrib.*voice|audio transcrib|语音转文字/i, "Covered partly by audio_transcribe."],
  [/github repo|issue|pull request|release/i, "Covered partly by github_lookup for public GitHub metadata."],
  [/check[- ]?in|daily fortune|leaderboard|签到|每日运势|排行榜/i, "Covered partly by feature_core checkin/daily_fortune."],
  [/web search|snapshot|browser|网页|搜索/i, "Covered partly by web search, snapshot, and browser tooling."]
];

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function hasArg(name) {
  return process.argv.includes(name);
}

function toNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function slug(value, fallback = "item") {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return text || fallback;
}

function cleanMarkdown(value) {
  return String(value || "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*_~>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyFeatureLine(line, section = "") {
  const raw = String(line || "").trim();
  if (!/^[-*+]\s+|\d+[.)]\s+/.test(raw)) return false;
  const text = cleanMarkdown(raw.replace(/^[-*+]\s+|\d+[.)]\s+/, ""));
  if (text.length < 14 || text.length > 220) return false;
  if (/^(https?:|badge|build|license|npm|pip install|docker run)/i.test(text)) return false;
  if (/^\w+$/.test(text)) return false;
  if (/feature|功能|capabilit|support|what.*can|模块|主要/i.test(section)) return true;
  return /(support|integrat|manage|monitor|notify|search|generate|moderate|bridge|schedule|command|plugin|dashboard|deploy|memory|rag|voice|image|sticker|webhook|ticket|poll|game|leaderboard|支持|管理|监控|提醒|搜索|生成|插件|部署|记忆|语音|图片|工单|投票|排行)/i.test(text);
}

function featureTitleFromLine(line) {
  const text = cleanMarkdown(line.replace(/^[-*+]\s+|\d+[.)]\s+/, ""));
  const split = text.split(/\s+-\s+|:\s+|：/);
  return cleanMarkdown(split[0]).slice(0, 90) || text.slice(0, 90);
}

function categorize(text) {
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) return category;
  }
  return "misc";
}

function boundaryFor(text) {
  for (const [pattern, note] of ALREADY_SUPPORTED_RULES) {
    if (pattern.test(text)) return { status: "already_supported", reason: note };
  }
  for (const rule of BOUNDARY_RULES) {
    if (rule.pattern.test(text)) return { status: rule.status, reason: rule.reason };
  }
  return { status: "candidate", reason: "Needs manual review." };
}

function extractFeaturesFromReadme(repo, readme) {
  const lines = String(readme || "").replace(/\r\n/g, "\n").split("\n");
  const features = [];
  let section = "";
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,4}\s+(.+)/);
    if (heading) {
      section = cleanMarkdown(heading[1]);
      continue;
    }
    if (!isLikelyFeatureLine(line, section)) continue;
    const evidence = cleanMarkdown(line.replace(/^[-*+]\s+|\d+[.)]\s+/, ""));
    const title = featureTitleFromLine(line);
    const category = categorize(`${section} ${evidence}`);
    const boundary = boundaryFor(`${title} ${evidence}`);
    features.push({
      id: "",
      title,
      category,
      evidence,
      source: {
        repo: repo.full_name,
        url: repo.html_url,
        stars: repo.stargazers_count || 0,
        section
      },
      boundary,
      implementation: {
        status: boundary.status === "candidate" ? "not_started" : boundary.status,
        path: "",
        tests: [],
        docs: [],
        notes: boundary.reason
      }
    });
  }
  return features;
}

function dedupeFeatures(features, minCount) {
  const seen = new Set();
  const deduped = [];
  for (const feature of features) {
    const key = `${feature.category}:${slug(feature.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    feature.id = `botfeat_${String(deduped.length + 1).padStart(3, "0")}_${slug(feature.title, "feature").slice(0, 44)}`;
    deduped.push(feature);
    if (deduped.length >= minCount) break;
  }
  return deduped;
}

function headerArgs(headers) {
  return Object.entries(headers).flatMap(([key, value]) => ["-H", `${key}: ${value}`]);
}

function curlFetchText(url, headers) {
  const output = execFileSync("curl.exe", [
    "-L",
    "-sS",
    "-w",
    "\n%{http_code}",
    ...headerArgs(headers),
    url
  ], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const match = output.match(/\n(\d{3})$/);
  const status = match ? Number(match[1]) : 0;
  const text = match ? output.slice(0, -4) : output;
  return { status, ok: status >= 200 && status < 300, text };
}

async function fetchText(url, headers) {
  try {
    const response = await fetch(url, { headers });
    return { status: response.status, ok: response.ok, text: await response.text() };
  } catch (error) {
    if (process.platform !== "win32") throw error;
    return curlFetchText(url, headers);
  }
}

async function githubFetch(url) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28"
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetchText(url, headers);
  const text = response.text;
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message = parsed?.message || response.statusText || `HTTP ${response.status}`;
    throw new Error(`GitHub API ${response.status}: ${message}`);
  }
  return parsed;
}

async function githubFetchRaw(url) {
  const headers = {
    accept: "application/vnd.github.raw",
    "user-agent": USER_AGENT
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetchText(url, headers);
  if (response.status === 404) return "";
  const text = response.text;
  if (!response.ok) throw new Error(`GitHub raw API ${response.status}: ${text.slice(0, 160)}`);
  return text;
}

async function searchRepos(limit) {
  const byName = new Map();
  for (const query of SEARCH_QUERIES) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=20`;
    const result = await githubFetch(url);
    for (const item of result.items || []) {
      if (!byName.has(item.full_name)) byName.set(item.full_name, item);
    }
    if (byName.size >= limit * 2) break;
  }
  return [...byName.values()]
    .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
    .slice(0, limit);
}

async function loadFixture(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  return (parsed.repos || []).map((repo) => ({
    full_name: repo.full_name,
    html_url: repo.html_url || `https://github.com/${repo.full_name}`,
    stargazers_count: repo.stargazers_count || 0,
    description: repo.description || "",
    readme: repo.readme || ""
  }));
}

async function collect({ repoLimit, featureLimit, fixture }) {
  const repos = fixture ? await loadFixture(fixture) : await searchRepos(repoLimit);
  const features = [];
  const repoRecords = [];
  for (const repo of repos) {
    let readme = repo.readme || "";
    if (!readme && repo.full_name) {
      readme = await githubFetchRaw(`https://api.github.com/repos/${repo.full_name}/readme`);
    }
    repoRecords.push({
      full_name: repo.full_name,
      html_url: repo.html_url,
      stargazers_count: repo.stargazers_count || 0,
      description: repo.description || "",
      readmeFeatureLines: extractFeaturesFromReadme(repo, readme).length
    });
    features.push(...extractFeaturesFromReadme(repo, readme));
    if (features.length >= featureLimit * 2) break;
  }
  return {
    generatedAt: new Date().toISOString(),
    queries: fixture ? ["fixture"] : SEARCH_QUERIES,
    repos: repoRecords.sort((a, b) => b.stargazers_count - a.stargazers_count),
    features: dedupeFeatures(features, featureLimit)
  };
}

function markdownReport(data) {
  const lines = [
    "# GitHub Bot Feature Scouting",
    "",
    `Generated: ${data.generatedAt}`,
    "",
    "## Method",
    "",
    "- Search GitHub repositories by bot/chatbot/Telegram/Discord topics and descriptions.",
    "- Sort repositories by stars after deduplication.",
    "- Extract README feature bullets with source repository, section, and evidence text.",
    "- Classify each feature as `not_started`, `already_supported`, or `conflict` for local implementation planning.",
    "",
    "## Source Repositories",
    "",
    "| Rank | Repository | Stars | Feature Lines |",
    "| ---: | --- | ---: | ---: |",
    ...data.repos.map((repo, index) => `| ${index + 1} | [${repo.full_name}](${repo.html_url}) | ${repo.stargazers_count} | ${repo.readmeFeatureLines} |`),
    "",
    "## Feature Candidates",
    "",
    "| # | Feature | Category | Source | Status | Boundary / Implementation Note |",
    "| ---: | --- | --- | --- | --- | --- |"
  ];
  for (const [index, feature] of data.features.entries()) {
    lines.push(`| ${index + 1} | ${feature.title.replace(/\|/g, "\\|")} | ${feature.category} | [${feature.source.repo}](${feature.source.url}) | ${feature.implementation.status} | ${feature.implementation.notes.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push("## Detailed Evidence");
  for (const feature of data.features) {
    lines.push("");
    lines.push(`### ${feature.id}: ${feature.title}`);
    lines.push("");
    lines.push(`- Category: ${feature.category}`);
    lines.push(`- Source: [${feature.source.repo}](${feature.source.url}) (${feature.source.stars} stars)`);
    if (feature.source.section) lines.push(`- README section: ${feature.source.section}`);
    lines.push(`- Evidence: ${feature.evidence}`);
    lines.push(`- Boundary: ${feature.boundary.status} - ${feature.boundary.reason}`);
    lines.push(`- Implementation status: ${feature.implementation.status}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function writeOutputs(data, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "github-bot-feature-scout.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, "github-bot-feature-scout.md"), markdownReport(data), "utf8");
}

export {
  extractFeaturesFromReadme,
  dedupeFeatures,
  boundaryFor,
  collect,
  markdownReport
};

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  const outDir = path.resolve(repoRoot, argValue("--out", DEFAULT_OUT_DIR));
  const repoLimit = toNumber(argValue("--repos"), 40, 1, 100);
  const featureLimit = toNumber(argValue("--features"), 50, 1, 200);
  const fixture = argValue("--fixture");
  const data = await collect({ repoLimit, featureLimit, fixture });
  await writeOutputs(data, outDir);
  const summary = {
    ok: true,
    outDir,
    repos: data.repos.length,
    features: data.features.length,
    conflicts: data.features.filter((item) => item.implementation.status === "conflict").length,
    alreadySupported: data.features.filter((item) => item.implementation.status === "already_supported").length,
    noNetwork: Boolean(fixture || hasArg("--no-network"))
  };
  console.log(JSON.stringify(summary, null, 2));
}

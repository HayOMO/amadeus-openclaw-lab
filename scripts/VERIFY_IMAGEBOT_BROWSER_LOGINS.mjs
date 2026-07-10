import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const configuredProfileDir = String(
  process.env.IMAGEBOT_BOT_BROWSER_PROFILE_DIR ||
  path.join(os.homedir(), ".openclaw", "browser", "bot", "user-data", "Default")
).trim();
const profileDir = path.resolve(configuredProfileDir);
const ordinaryChromeDefault = path.resolve(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Google",
  "Chrome",
  "User Data",
  "Default"
);
if (profileDir.toLowerCase() === ordinaryChromeDefault.toLowerCase()) {
  throw new Error("Refusing to inspect the ordinary Chrome Default profile; configure a separate Bot-owned profile.");
}
const cookieDbPath = path.join(profileDir, "Network", "Cookies");

const services = [
  {
    id: "xiaohongshu",
    name: "Xiaohongshu",
    domains: ["xiaohongshu.com"],
    markers: ["web_session"]
  },
  {
    id: "weibo",
    name: "Weibo",
    domains: ["weibo.com", "sina.com.cn"],
    markers: ["SUB"]
  },
  {
    id: "bilibili",
    name: "Bilibili",
    domains: ["bilibili.com", "bilibili.cn", "biligame.com"],
    markers: ["SESSDATA", "DedeUserID"]
  },
  {
    id: "baidu",
    name: "Baidu/Tieba",
    domains: ["baidu.com"],
    markers: ["BDUSS", "BDUSS_BFESS"]
  },
  {
    id: "google",
    name: "Google (Search/Lens/Scholar/Gmail)",
    domains: ["google.com"],
    markers: ["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID"]
  },
  {
    id: "youtube",
    name: "YouTube",
    domains: ["youtube.com"],
    markers: ["LOGIN_INFO", "SID", "SAPISID", "__Secure-1PSID"]
  },
  {
    id: "openai",
    name: "ChatGPT/OpenAI",
    domains: ["chatgpt.com", "openai.com"],
    markerPrefixes: ["__Secure-next-auth.session-token", "oai-client-auth-info", "unified_session_manifest"]
  },
  {
    id: "github",
    name: "GitHub",
    domains: ["github.com"],
    markers: ["user_session", "logged_in", "__Host-user_session_same_site"]
  },
  {
    id: "huawei",
    name: "Huawei Account",
    domains: ["cloud.huawei.com"],
    markers: ["hwid_cas_sid"]
  },
  {
    id: "zhihu",
    name: "Zhihu",
    domains: ["zhihu.com"],
    markers: ["z_c0"]
  },
  {
    id: "pixiv",
    name: "Pixiv",
    domains: ["pixiv.net"],
    markers: ["PHPSESSID"]
  },
  {
    id: "lofter",
    name: "LOFTER",
    domains: ["lofter.com"],
    markers: ["P_OINFO"]
  }
];

function hostMatches(host, domain) {
  const normalized = String(host || "").toLowerCase().replace(/^\./, "");
  const target = String(domain || "").toLowerCase().replace(/^\./, "");
  return normalized === target || normalized.endsWith(`.${target}`);
}

function markerMatches(name, service) {
  if ((service.markers || []).includes(name)) return true;
  return (service.markerPrefixes || []).some((prefix) => name.startsWith(prefix));
}

function cookieIsCurrent(row, nowMs = Date.now()) {
  try {
    const raw = BigInt(String(row.expires_text || "0"));
    if (raw <= 0n) return true;
    const chromeEpochMicros = 11644473600000000n;
    return Number((raw - chromeEpochMicros) / 1000n) > nowMs;
  } catch {
    return false;
  }
}

async function readProfileLabel() {
  const localStatePath = path.join(path.dirname(profileDir), "Local State");
  try {
    const localState = JSON.parse(await fs.readFile(localStatePath, "utf8"));
    const info = localState?.profile?.info_cache?.Default || {};
    return String(info.name || info.gaia_name || "Default");
  } catch {
    return "Default";
  }
}

const outDir = path.join(repoRoot, ".runtime", "probes");
await fs.mkdir(outDir, { recursive: true });
const cookieCopy = path.join(outDir, `dedicated-browser-cookies-${process.pid}-${Date.now()}.sqlite`);
let copyError = null;
for (let attempt = 0; attempt < 5; attempt += 1) {
  try {
    await fs.copyFile(cookieDbPath, cookieCopy);
    copyError = null;
    break;
  } catch (error) {
    copyError = error;
    if (error?.code !== "EBUSY" || attempt === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

if (copyError) {
  console.log(JSON.stringify({
    createdAt: new Date().toISOString(),
    browserContract: { dedicatedProfile: "bot", isolatedProfile: "isolated" },
    profileDir,
    status: "profile_active_locked",
    note: "Close the explicitly configured Bot-owned profile and rerun to refresh cookie-name login markers. Cookie values are never read or reported."
  }, null, 2));
  process.exit(0);
}

let rows;
try {
  const db = new DatabaseSync(cookieCopy, { readOnly: true });
  rows = db.prepare("select host_key, name, cast(expires_utc as text) as expires_text from cookies").all();
  db.close();
} finally {
  await fs.rm(cookieCopy, { force: true });
}

const results = services.map((service) => {
  const matched = rows.filter((row) => cookieIsCurrent(row) && service.domains.some((domain) => hostMatches(row.host_key, domain)));
  const names = [...new Set(matched.map((row) => String(row.name || "")))].sort();
  const loginMarkers = names.filter((name) => markerMatches(name, service));
  return {
    id: service.id,
    name: service.name,
    status: loginMarkers.length > 0
      ? "login_marker_present"
      : matched.length > 0
        ? "cookies_present_uncertain"
        : "no_cookies",
    loginMarkers,
    cookieCount: matched.length,
    hosts: [...new Set(matched.map((row) => String(row.host_key || "").replace(/^\./, "")))].sort()
  };
});

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = path.join(outDir, `browser-login-verification-${stamp}.json`);
const mdPath = path.join(outDir, `browser-login-verification-${stamp}.md`);
const report = {
  createdAt: new Date().toISOString(),
  browserContract: {
    dedicatedProfile: "bot",
    isolatedProfile: "isolated"
  },
  profileDir,
  profileLabel: await readProfileLabel(),
  results
};

await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const lines = [
  "# Dedicated Browser Login Verification",
  "",
  `- Profile: ${profileDir}`,
  `- Created: ${report.createdAt}`,
  "- Cookie values are never read or reported.",
  "",
  "| Service | Status | Login markers | Cookie rows |",
  "|---|---|---|---:|",
  ...results.map((item) => `| ${item.name} | ${item.status} | ${item.loginMarkers.join(", ") || "-"} | ${item.cookieCount} |`)
];
await fs.writeFile(mdPath, `${lines.join("\n")}\n`, "utf8");

console.log(JSON.stringify({
  mdPath,
  jsonPath,
  profileDir,
  loggedIn: results.filter((item) => item.status === "login_marker_present").map((item) => item.name),
  uncertain: results.filter((item) => item.status === "cookies_present_uncertain").map((item) => item.name)
}, null, 2));

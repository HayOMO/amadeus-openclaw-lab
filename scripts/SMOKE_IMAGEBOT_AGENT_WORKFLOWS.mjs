import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openclawStatePath } from "../plugins/imagebot-shared/openclaw-paths.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_SECONDS = 360;

function powershellExe() {
  if (process.platform !== "win32") return "pwsh";
  const candidates = [
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
    "pwsh.exe"
  ];
  return candidates.find((candidate) => candidate.includes(path.sep) && fs.existsSync(candidate)) || candidates.at(-2);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return "";
  return String(process.argv[index + 1] || "").trim();
}

function hasArg(name) {
  return process.argv.includes(name);
}

function powershell(command, timeoutMs = 15000) {
  return spawnSync(powershellExe(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024
  });
}

function resolveOpenclawInvoker() {
  const explicit = process.env.OPENCLAW_BIN || argValue("--openclaw");
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (resolved.toLowerCase().endsWith(".ps1")) {
      return { cmd: powershellExe(), prefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved] };
    }
    return { cmd: resolved, prefix: [] };
  }

  if (process.platform === "win32") {
    const besideNodeOpenclaw = path.join(path.dirname(process.execPath), "node_modules", "openclaw", "openclaw.mjs");
    if (fs.existsSync(besideNodeOpenclaw)) {
      return { cmd: process.execPath, prefix: [besideNodeOpenclaw] };
    }
    const besideNode = path.join(path.dirname(process.execPath), "openclaw.ps1");
    if (fs.existsSync(besideNode)) {
      return { cmd: powershellExe(), prefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", besideNode] };
    }
    const result = powershell("(Get-Command openclaw).Path", 15000);
    const candidate = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!candidate) throw new Error(`openclaw not found: ${String(result.stderr || result.stdout || "").trim()}`);
    if (candidate.toLowerCase().endsWith(".ps1")) {
      return { cmd: powershellExe(), prefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", candidate] };
    }
    return { cmd: candidate, prefix: [] };
  }

  return { cmd: "openclaw", prefix: [] };
}

function findKey(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function runAgent({ invoker, name, message, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS }) {
  const sessionKey = `codex-agent-smoke-${name}-${Date.now().toString(36)}`;
  const args = [
    ...invoker.prefix,
    "agent",
    "--agent",
    "imagebot",
    "--session-key",
    sessionKey,
    "--message",
    message,
    "--json",
    "--timeout",
    String(timeoutSeconds)
  ];
  const started = Date.now();
  const result = spawnSync(invoker.cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: (timeoutSeconds + 90) * 1000,
    maxBuffer: 180 * 1024 * 1024
  });
  const elapsedMs = Date.now() - started;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${name} exited ${result.status}: ${String(result.stderr || result.stdout || "").slice(-4000)}`);
  }
  const stdout = String(result.stdout || "").trim();
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${name} did not return JSON: ${error.message}\n${stdout.slice(-4000)}`);
  }
  return {
    name,
    elapsedMs,
    finalText: String(findKey(payload, "finalAssistantVisibleText") || findKey(payload, "finalAssistantRawText") || ""),
    toolSummary: findKey(payload, "toolSummary") || null,
    sessionId: findKey(payload, "sessionId") || "",
    raw: payload
  };
}

function ensureSmokeImage() {
  const explicit = argValue("--image");
  const candidates = [
    explicit,
    openclawStatePath("media", "downloaded", "codex-smoke", "lens-test.png"),
    path.join(os.tmpdir(), "codex-clipboard-67d10553-7045-4214-a5ba-a24f67c96f35.png")
  ].filter(Boolean);
  const source = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!source) return "";
  const targetDir = openclawStatePath("media", "downloaded", "codex-smoke");
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, "lens-test.png");
  if (path.resolve(source).toLowerCase() !== path.resolve(target).toLowerCase()) {
    fs.copyFileSync(source, target);
  }
  return target;
}

function expectCase(result, pattern) {
  if (!pattern.test(result.finalText)) {
    throw new Error(`${result.name} failed expectation ${pattern}: ${result.finalText}`);
  }
}

const invoker = resolveOpenclawInvoker();
const imagePath = ensureSmokeImage();
const skipImage = hasArg("--skip-image") || !imagePath;

const cases = [
  {
    name: "browser",
    expect: /browser_ok=true/i,
    message: "黑盒回归：必须自己调用工具完成，不要只凭常识。用 tool_search 找到 browser 工具，然后用 browser 打开 https://example.com ，snapshot/截图读取页面标题或主标题，最后只输出：browser_ok=<true/false>; title=<你看到的标题>; tools=<实际调用的工具名列表>。不要投递 Telegram。"
  },
  {
    name: "web-snapshot",
    expect: /web_snapshot_ok=true/i,
    message: "黑盒回归：必须自己调用工具，不要凭常识。用 tool_search 找 web_snapshot 或 web_card，然后读取 https://example.com 的标题或 H1。最后只输出：web_snapshot_ok=<true/false>; title=<标题>; tools=<实际调用工具名列表>。不要投递 Telegram。"
  },
  {
    name: "image-generate-list",
    expect: /image_generate_list_ok=true/i,
    message: "黑盒回归：必须自己调用工具，不要凭常识。用 tool_search 找 image_generate，然后只调用 action=list 检查可用生图模型，不要真的生成图片。最后只输出：image_generate_list_ok=<true/false>; primary=<主模型或unknown>; tools=<实际调用工具名列表>。不要投递 Telegram。"
  },
  {
    name: "mars-lookup",
    expect: /mars_lookup_ok=true/i,
    message: "黑盒回归：必须自己调用工具，不要凭常识。用 tool_search 找 mars_forward_lookup，调用只读查询/帮助/状态动作，确认工具可见且能返回未命中时的鲁棒响应，不要写入。最后只输出：mars_lookup_ok=<true/false>; result=<hit/miss/error>; tools=<实际调用工具名列表>。不要投递 Telegram。"
  }
];

if (!skipImage) {
  cases.push(
    {
      name: "reverse-image",
      expect: /reverse_ok=true/i,
      message: `Black-box smoke: you must use tools, not memory. Use tool_search to find reverse_image_search, then run one ordinary fast reverse search on bot-local image ${imagePath}. Omit providers unless the tool refuses; do not pass every provider enum value. Do not use Google Lens here. Final output only: reverse_ok=<true/false>; engines=<engines or unknown>; top=<best result or none>; tools=<actual tool names>. Do not deliver to Telegram.`
    },
    {
      name: "browser-visual-search",
      expect: /visual_search_browser_ok=true/i,
      message: `Black-box smoke: you must use browser tools, not reverse_image_search. Use tool_search to find browser, then use browser as an interactive browser for visual image search with this bot-local image: ${imagePath}. Open Google Lens or another suitable public visual-search page, upload/submit the image if possible, inspect the visible results, and continue clicking/scrolling only as needed. Final output only: visual_search_browser_ok=<true/false>; page=<site/page used or blocked>; candidate=<best visible candidate or none>; tools=<actual tool names>. Do not deliver to Telegram.`
    },
    {
      name: "sticker-dry-run",
      expect: /sticker_ok=true/i,
      message: `Black-box smoke: you must use tools, not memory. Use tool_search to find sticker_pack, then use bot-local image ${imagePath} to make a dryRun/prepare preview plan. Do not upload/delete/change a real sticker set. Final output only: sticker_ok=<true/false>; action=<actual action>; tools=<actual tool names>. Do not deliver to Telegram.`
    }
  );
}

const results = [];
for (const testCase of cases) {
  const result = runAgent({ invoker, ...testCase });
  expectCase(result, testCase.expect);
  results.push(result);
  console.log(`[ok] ${testCase.name} ${result.elapsedMs}ms :: ${result.finalText.replace(/\s+/g, " ").slice(0, 500)}`);
}

if (skipImage) {
  console.log(`[skip] image-dependent cases skipped; pass --image <path> or place a file at ${openclawStatePath("media", "downloaded", "codex-smoke", "lens-test.png")}`);
}

console.log(JSON.stringify({
  status: "ok",
  count: results.length,
  imageCases: !skipImage,
  totalMs: results.reduce((sum, result) => sum + result.elapsedMs, 0),
  tools: [...new Set(results.flatMap((result) => Array.isArray(result.toolSummary?.tools) ? result.toolSummary.tools : []))]
}, null, 2));

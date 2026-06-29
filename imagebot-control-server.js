import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(ROOT, "app");
const RUNTIME_DIR = path.resolve(process.env.IMAGEBOT_CONTROL_RUNTIME_DIR || path.join(ROOT, ".runtime"));
const LOG_DIR = path.resolve(process.env.IMAGEBOT_CONTROL_LOG_DIR || path.join(ROOT, "logs"));
const OPENCLAW_HOME = path.join(os.homedir(), ".openclaw");
const OPENCLAW_CONFIG = path.join(OPENCLAW_HOME, "openclaw.json");
const MODEL_PROFILE_PATH = path.join(ROOT, "scripts", "IMAGEBOT_MODEL_PROFILES.json");
const FEATURE_HEALTH_SCRIPT = path.join(ROOT, "scripts", "CHECK_IMAGEBOT_FEATURE_HEALTH.mjs");
const HOST = process.env.IMAGEBOT_CONTROL_HOST || "127.0.0.1";
const PORT = normalizePort(process.env.IMAGEBOT_CONTROL_PORT, 18788);
const GATEWAY_PORT = 18789;
const TOKEN_HEADER = "x-imagebot-control-token";
const TOKEN_FILE = path.join(RUNTIME_DIR, "imagebot-control-server.token");
const CONTROL_TOKEN = resolveControlToken();
const CONTROL_TOKEN_HASH = sha256Buffer(CONTROL_TOKEN);

assertControlHostAllowed();

fs.mkdirSync(RUNTIME_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
writeControlTokenFile();

const FILE_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

let actionInFlight = null;
let lastActionResult = null;
let shuttingDown = false;

function normalizePort(value, fallback) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fallback;
  return port;
}

function resolveControlToken() {
  const configured = String(process.env.IMAGEBOT_CONTROL_TOKEN || "").trim();
  if (configured.length >= 32) return configured;
  return randomBytes(32).toString("hex");
}

function writeControlTokenFile() {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, CONTROL_TOKEN, { encoding: "utf8", mode: 0o600 });
}

function sha256Buffer(value) {
  return createHash("sha256").update(String(value)).digest();
}

function safeTokenEqual(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return timingSafeEqual(sha256Buffer(text), CONTROL_TOKEN_HASH);
}

function allowedHostValues() {
  return new Set([
    `${hostHeaderName(HOST)}:${PORT}`.toLowerCase(),
    `127.0.0.1:${PORT}`,
    `localhost:${PORT}`,
    `[::1]:${PORT}`
  ]);
}

function allowedOriginValues() {
  return new Set([
    `http://${originHost(HOST)}:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    `http://[::1]:${PORT}`
  ]);
}

function normalizeHostName(value) {
  return String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function hostHeaderName(value) {
  const normalized = normalizeHostName(value);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function originHost(value) {
  return hostHeaderName(value || "127.0.0.1");
}

function isLoopbackHost(value) {
  const host = normalizeHostName(value);
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function assertControlHostAllowed() {
  if (process.env.IMAGEBOT_CONTROL_ALLOW_REMOTE === "1") return;
  if (!isLoopbackHost(HOST)) {
    throw new Error("IMAGEBOT_CONTROL_HOST must be loopback unless IMAGEBOT_CONTROL_ALLOW_REMOTE=1 is set");
  }
}

function validateHost(req) {
  const host = String(req.headers.host || "").trim().toLowerCase();
  return allowedHostValues().has(host);
}

function requestToken(req) {
  const header = req.headers[TOKEN_HEADER];
  if (Array.isArray(header)) return header[0] || "";
  const auth = String(req.headers.authorization || "");
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return String(header || "");
}

function validateApiAuth(req) {
  return safeTokenEqual(requestToken(req));
}

function validatePostBoundary(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!allowedOriginValues().has(origin)) return { ok: false, status: 403, error: "Invalid request origin" };
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.split(";")[0].trim().endsWith("/json") && !contentType.startsWith("application/json")) {
    return { ok: false, status: 415, error: "POST requests must use application/json" };
  }
  return { ok: true };
}

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "X-Frame-Options": "DENY",
    ...extra
  };
}

function readText(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
      return buffer.toString("utf16le").replace(/^\uFEFF/, "");
    }
    const utf8 = buffer.toString("utf8");
    const sample = utf8.slice(0, 4096);
    const nullCount = (sample.match(/\u0000/g) || []).length;
    if (sample.length > 0 && nullCount / sample.length > 0.08) {
      return buffer.toString("utf16le").replace(/^\uFEFF/, "");
    }
    return utf8;
  } catch {
    return "";
  }
}

function readJsonFile(filePath, fallback = null) {
  const raw = readText(filePath).trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, securityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  }));
  res.end(body);
}

function writeError(res, statusCode, error) {
  writeJson(res, statusCode, { ok: false, error });
}

function getModelCatalog() {
  const fallback = {
    version: 1,
    models: [
      { id: "openai/gpt-5.5", label: "GPT-5.5", provider: "openai", enabled: true, reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"] },
      { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", provider: "deepseek", enabled: true, reasoningEfforts: ["off", "high", "max"] },
      { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", enabled: true, reasoningEfforts: ["off", "high", "max"] }
    ],
    reasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    textVerbosity: ["low", "medium", "high"],
    profiles: [
      { id: "fast", label: "Fast", model: "openai/gpt-5.5", reasoningEffort: "low", textVerbosity: "low", maxTokens: 768 },
      { id: "balanced", label: "Balanced", model: "openai/gpt-5.5", reasoningEffort: "medium", textVerbosity: "low", maxTokens: 1024 },
      { id: "deep", label: "Deep", model: "openai/gpt-5.5", reasoningEffort: "high", textVerbosity: "low", maxTokens: 1536 },
      { id: "ds-fast", label: "DS Flash High", model: "deepseek/deepseek-v4-flash", reasoningEffort: "high", textVerbosity: "low", maxTokens: 1024 },
      { id: "ds-pro", label: "DS Pro High", model: "deepseek/deepseek-v4-pro", reasoningEffort: "high", textVerbosity: "low", maxTokens: 1536 },
      { id: "ds-flash-off", label: "DS Flash Off", model: "deepseek/deepseek-v4-flash", reasoningEffort: "off", textVerbosity: "low", maxTokens: 1024 },
      { id: "ds-flash-max", label: "DS Flash Max", model: "deepseek/deepseek-v4-flash", reasoningEffort: "max", textVerbosity: "low", maxTokens: 2048 },
      { id: "ds-pro-off", label: "DS Pro Off", model: "deepseek/deepseek-v4-pro", reasoningEffort: "off", textVerbosity: "low", maxTokens: 1536 },
      { id: "ds-pro-max", label: "DS Pro Max", model: "deepseek/deepseek-v4-pro", reasoningEffort: "max", textVerbosity: "medium", maxTokens: 3072 }
    ]
  };
  const catalog = readJsonFile(MODEL_PROFILE_PATH, fallback);
  return {
    version: catalog.version || 1,
    models: Array.isArray(catalog.models) ? catalog.models : fallback.models,
    reasoningEfforts: Array.isArray(catalog.reasoningEfforts) ? catalog.reasoningEfforts : fallback.reasoningEfforts,
    textVerbosity: Array.isArray(catalog.textVerbosity) ? catalog.textVerbosity : fallback.textVerbosity,
    profiles: Array.isArray(catalog.profiles) ? catalog.profiles : fallback.profiles
  };
}

function detectCurrentProfile(current, catalog) {
  const found = catalog.profiles.find(profile =>
    profile.model === current.model &&
    profile.reasoningEffort === current.reasoningEffort &&
    profile.textVerbosity === current.textVerbosity &&
    Number(profile.maxTokens) === Number(current.maxTokens)
  );
  return found ? found.id : "custom";
}

function getModelConfig() {
  const catalog = getModelCatalog();
  const config = readJsonFile(OPENCLAW_CONFIG, {});
  const agent = Array.isArray(config.agents?.list) ? config.agents.list.find(item => item && item.id === "imagebot") || config.agents.list[0] : {};
  const params = agent?.params || {};
  const current = {
    model: agent?.model || "",
    reasoningEffort: params.reasoningEffort || "",
    textVerbosity: params.textVerbosity || "",
    maxTokens: Number(params.maxTokens) || 0,
    imageModel: config.agents?.defaults?.imageModel?.primary || "",
    imageGenerationModel: config.agents?.defaults?.imageGenerationModel?.primary || "",
    providers: Object.keys(config.models?.providers || {})
  };
  current.profileId = detectCurrentProfile(current, catalog);
  return {
    ok: true,
    current,
    ...catalog,
    restartRequiredForApply: true,
    configPath: OPENCLAW_CONFIG
  };
}

function validateModelPayload(body) {
  const catalog = getModelCatalog();
  const profileId = String(body.profileId || body.mode || "").trim() || "custom";
  let profile = catalog.profiles.find(item => item.id === profileId);
  if (profileId !== "custom" && !profile) {
    throw new Error("Unknown model profile");
  }
  if (!profile) profile = {};

  const model = String(body.model || profile.model || "").trim();
  const reasoningEffort = String(body.reasoningEffort || profile.reasoningEffort || "medium").trim();
  const textVerbosity = String(body.textVerbosity || profile.textVerbosity || "low").trim();
  const maxTokens = Number(body.maxTokens || profile.maxTokens || 1024);

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/.test(model)) {
    throw new Error("Invalid model id. Use provider/model, for example openai/gpt-5.5.");
  }
  if (!catalog.reasoningEfforts.includes(reasoningEffort)) {
    throw new Error("Invalid reasoning effort");
  }
  if (!catalog.textVerbosity.includes(textVerbosity)) {
    throw new Error("Invalid text verbosity");
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 8192) {
    throw new Error("Max tokens must be an integer between 256 and 8192.");
  }

  return {
    profileId,
    model,
    reasoningEffort,
    textVerbosity,
    maxTokens,
    restart: body.restart === true
  };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function testTcpPort(port) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(650);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, HOST);
  });
}

function getPortOwners() {
  return new Promise(resolve => {
    const command =
      "$owners=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); " +
      "$owners -join ','";
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { cwd: ROOT, windowsHide: true, timeout: 1200 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const owners = stdout
          .trim()
          .split(",")
          .map(value => value.trim())
          .filter(Boolean);
        resolve(owners);
      }
    );
  });
}

function readTail(filePath, maxLines = 90) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  const content = readText(filePath);
  if (!content) {
    return [];
  }
  return content.replace(/\r\n/g, "\n").split("\n").slice(-maxLines).filter(line => line.length);
}

function getLatestLogPath() {
  const saved = readText(path.join(RUNTIME_DIR, "imagebot-gateway.logpath")).trim();
  if (isUsableLogPath(saved)) return path.resolve(saved);
  try {
    const logs = fs.readdirSync(LOG_DIR)
      .filter(name => /^imagebot-gateway-.*\.log$/i.test(name))
      .map(name => {
        const full = path.join(LOG_DIR, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return logs[0] ? logs[0].full : "";
  } catch {
    return "";
  }
}

function isUsableLogPath(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const resolved = path.resolve(filePath).toLowerCase();
  const root = path.resolve(ROOT).toLowerCase();
  const tempOpenClaw = path.join(os.tmpdir(), "openclaw").toLowerCase();
  return resolved === root ||
    resolved.startsWith(root + path.sep) ||
    resolved.startsWith(tempOpenClaw + path.sep);
}

function getWatchdogState() {
  const raw = readText(path.join(RUNTIME_DIR, "imagebot-gateway.state.json")).trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { state: "unknown", message: "Watchdog state file is unreadable." };
  }
}

function getPrewarmState() {
  const raw = readText(path.join(RUNTIME_DIR, "imagebot-prewarm.state.json")).trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { state: "unknown", message: "Prewarm state file is unreadable." };
  }
}

function getMemoryPrewarmState() {
  const raw = readText(path.join(RUNTIME_DIR, "imagebot-memory-prewarm.state.json")).trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { state: "unknown", message: "Memory prewarm state file is unreadable." };
  }
}

function getBrowserPrewarmState() {
  const raw = readText(path.join(RUNTIME_DIR, "imagebot-browser-prewarm.state.json")).trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { state: "unknown", message: "Browser prewarm state file is unreadable." };
  }
}

function latestLine(tail, predicate) {
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    if (predicate(tail[index])) return tail[index];
  }
  return "";
}

function compactOutput(output, limit = 14000) {
  if (!output || output.length <= limit) return output || "";
  return `${output.slice(0, 1600)}\n\n... trimmed ...\n\n${output.slice(-limit + 1600)}`;
}

function getFeatureHealth() {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [FEATURE_HEALTH_SCRIPT, "--json"],
      { cwd: ROOT, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 * 4 },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        let parsed = null;
        try {
          parsed = stdout ? JSON.parse(stdout) : null;
        } catch {
          parsed = null;
        }
        resolve({
          ok: !error && parsed?.status === "ok",
          status: parsed?.status || "failed",
          error: error ? error.message : "",
          output: compactOutput(output),
          checkedAt: new Date().toISOString(),
          ...(parsed || {})
        });
      }
    );
  });
}

async function getStatus() {
  const ready = await testTcpPort(GATEWAY_PORT);
  const owners = await getPortOwners();
  const savedPid = readText(path.join(RUNTIME_DIR, "imagebot-gateway.pid")).trim();
  const watchdog = getWatchdogState();
  const prewarm = getPrewarmState();
  const memoryPrewarm = getMemoryPrewarmState();
  const browserPrewarm = getBrowserPrewarmState();
  const logPath = getLatestLogPath();
  const tail = readTail(logPath);
  const providerSeen = tail.some(line => line.includes("[telegram] [imagebot] starting provider"));
  const readySeen = tail.some(line => line.includes("[gateway] ready"));
  const lastLine = tail.length ? tail[tail.length - 1] : "";
  const modelLine = latestLine(tail, line => line.includes("[gateway] agent model:"));
  const model = modelLine.replace(/^.*agent model:\s*/i, "").trim();
  const pluginsLine = latestLine(tail, line => line.includes("[gateway] http server listening"));
  const pluginMatch = pluginsLine.match(/\((\d+)\s+plugins:\s*([^;)]+)/i);
  const pluginCount = pluginMatch ? Number(pluginMatch[1]) : 0;
  const plugins = pluginMatch ? pluginMatch[2].split(",").map(item => item.trim()).filter(Boolean) : [];
  const telegramLine = latestLine(tail, line => line.includes("[telegram] [imagebot]"));
  const telegramHandleMatch = telegramLine.match(/\((@[^)]+)\)/);
  const browserLine = latestLine(tail, line => line.includes("[browser/server]"));
  const sessionStartIndex = (() => {
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      if (tail[index].includes("[gateway] loading configuration")) return index;
    }
    return -1;
  })();
  const healthTail = sessionStartIndex >= 0 ? tail.slice(sessionStartIndex) : tail;
  const warningLines = healthTail.filter(line => /\b(warn|warning|degraded|retry|timeout|conflict|blocked)\b/i.test(line));
  const errorLines = healthTail.filter(line => /\b(error|failed|exception|fatal|conflict|blocked)\b/i.test(line));

  return {
    state: ready ? "running" : (watchdog.state || "stopped"),
    ready,
    port: `127.0.0.1:${GATEWAY_PORT}`,
    pids: owners,
    pid: owners[0] || savedPid || "",
    savedPid,
    logPath,
    logTail: tail,
    providerSeen,
    readySeen,
    telegramHandle: telegramHandleMatch ? telegramHandleMatch[1] : "",
    telegramLine,
    model,
    modelLine,
    pluginCount,
    plugins,
    pluginsLine,
    browserLine,
    warningCount: warningLines.length,
    errorCount: errorLines.length,
    lastWarning: warningLines[warningLines.length - 1] || "",
    lastError: errorLines[errorLines.length - 1] || "",
    lastLine,
    watchdog,
    prewarm,
    memoryPrewarm,
    browserPrewarm,
    actionInFlight: Boolean(actionInFlight),
    actionName: actionInFlight ? actionInFlight.name : "",
    lastAction: lastActionResult,
    updatedAt: new Date().toISOString(),
    controllerPid: process.pid,
    root: ROOT
  };
}

function publicStatus(status) {
  const {
    logPath: _logPath,
    logTail: _logTail,
    root: _root,
    lastWarning: _lastWarning,
    lastError: _lastError,
    ...safe
  } = status || {};
  return {
    ...safe,
    logAvailable: Boolean(status?.logPath),
    logsRedacted: true
  };
}

function runPowerShellScript(scriptName, extraArgs = [], nameOverride = "", timeoutMs = 240000) {
  const scriptPath = path.join(ROOT, scriptName);
  if (!fs.existsSync(scriptPath)) {
    return Promise.reject(new Error(`Missing script: ${scriptName}`));
  }

  if (actionInFlight) {
    return Promise.reject(new Error(`${actionInFlight.name} is already running`));
  }

  const name = nameOverride || scriptName.replace("_IMAGEBOT_GATEWAY.ps1", "").replace(/\.ps1$/i, "").toLowerCase();
  const startedAt = Date.now();
  const promise = new Promise((resolve, reject) => {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...extraArgs];
    if (["START_IMAGEBOT_GATEWAY.ps1", "STOP_IMAGEBOT_GATEWAY.ps1", "RESTART_IMAGEBOT_GATEWAY.ps1"].includes(scriptName)) {
      args.push("-Fast");
    }

    execFile(
      "powershell.exe",
      args,
      { cwd: ROOT, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 4 },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        const result = {
          ok: !error,
          name,
          scriptName,
          durationMs: Date.now() - startedAt,
          output: compactOutput(output),
          code: error && typeof error.code !== "undefined" ? error.code : 0
        };
        lastActionResult = {
          ...result,
          startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date().toISOString()
        };
        if (error) {
          reject(Object.assign(error, { result }));
        } else {
          resolve(result);
        }
      }
    );
  });

  actionInFlight = { name, promise };
  promise.finally(() => {
    actionInFlight = null;
  });
  return promise;
}

function runScript(scriptName) {
  return runPowerShellScript(scriptName);
}

async function applyModelConfig(body) {
  const payload = validateModelPayload(body || {});
  const args = [
    "-Mode", payload.profileId,
    "-Model", payload.model,
    "-ReasoningEffort", payload.reasoningEffort,
    "-TextVerbosity", payload.textVerbosity,
    "-MaxTokens", String(payload.maxTokens)
  ];

  const result = await runPowerShellScript("scripts\\SET_IMAGEBOT_MODEL_MODE.ps1", args, "model config", 180000);
  let restartResult = null;
  if (payload.restart) {
    restartResult = await runPowerShellScript("RESTART_IMAGEBOT_GATEWAY.ps1", [], "restart", 240000);
  }
  return { result, restartResult, payload };
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${originHost(HOST)}:${PORT}`);
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.resolve(APP_DIR, `.${pathname}`);
  const relative = path.relative(APP_DIR, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, securityHeaders({
      "Content-Type": FILE_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    }));
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${originHost(HOST)}:${PORT}`);
    if (!validateHost(req)) {
      writeError(res, 403, "Invalid Host header");
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (!validateApiAuth(req)) {
        writeError(res, 401, "Missing or invalid control token");
        return;
      }
      if (req.method === "POST") {
        const postBoundary = validatePostBoundary(req);
        if (!postBoundary.ok) {
          writeError(res, postBoundary.status, postBoundary.error);
          return;
        }
      }
    }

    if (req.method === "GET" && url.pathname === "/api/ping") {
      writeJson(res, 200, { ok: true, pid: process.pid });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      writeJson(res, 200, publicStatus(await getStatus()));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/model-config") {
      writeJson(res, 200, getModelConfig());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/feature-health") {
      writeJson(res, 200, await getFeatureHealth());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/model-config") {
      const raw = await readRequestBody(req);
      const body = raw ? JSON.parse(raw) : {};
      try {
        const applied = await applyModelConfig(body);
        writeJson(res, 200, {
          ok: true,
          ...applied,
          modelConfig: getModelConfig(),
          status: publicStatus(await getStatus())
        });
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          error: error.message,
          result: error.result || null,
          modelConfig: getModelConfig(),
          status: publicStatus(await getStatus())
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/action") {
      const raw = await readRequestBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const actions = {
        start: "START_IMAGEBOT_GATEWAY.ps1",
        stop: "STOP_IMAGEBOT_GATEWAY.ps1",
        restart: "RESTART_IMAGEBOT_GATEWAY.ps1",
        status: "STATUS_IMAGEBOT_GATEWAY.ps1"
      };
      const scriptName = actions[body.action];
      if (!scriptName) {
        writeJson(res, 400, { ok: false, error: "Unknown action" });
        return;
      }
      try {
        const result = await runScript(scriptName);
        writeJson(res, 200, { ...result, status: publicStatus(await getStatus()) });
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          error: error.message,
          result: error.result || null,
          status: publicStatus(await getStatus())
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/open-log-folder") {
      execFile("explorer.exe", [LOG_DIR], { windowsHide: true }, () => {});
      writeJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/open-root") {
      execFile("explorer.exe", [ROOT], { windowsHide: true }, () => {});
      writeJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/open-config") {
      execFile("explorer.exe", [OPENCLAW_HOME], { windowsHide: true }, () => {});
      writeJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/open-dashboard") {
      execFile("rundll32.exe", ["url.dll,FileProtocolHandler", `http://${HOST}:${GATEWAY_PORT}/`], { windowsHide: true }, () => {});
      writeJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/exit") {
      writeJson(res, 200, { ok: true });
      if (!shuttingDown) {
        shuttingDown = true;
        setTimeout(() => server.close(() => process.exit(0)), 200);
      }
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    writeJson(res, 500, { ok: false, error: error.message });
  }
});

if (process.argv.includes("--self-test")) {
  Promise.all([getStatus(), getFeatureHealth()]).then(([status, featureHealth]) => {
    const ok = featureHealth.ok !== false;
    console.log(JSON.stringify({ ok, status, featureHealth }));
    if (!ok) process.exitCode = 1;
  }).catch(error => {
    console.error(error);
    process.exit(1);
  });
} else {
  server.listen(PORT, HOST, () => {
    fs.writeFileSync(path.join(RUNTIME_DIR, "imagebot-control-server.pid"), String(process.pid));
    console.log(`Imagebot control server listening at http://${HOST}:${PORT}/`);
  });
}

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.join(ROOT, ".runtime");
const LOG_DIR = path.join(ROOT, "logs");
const SERVER_SCRIPT = path.join(ROOT, "imagebot-control-server.js");
const SERVER_LOG = path.join(LOG_DIR, "imagebot-control-server.log");
const APP_ORIGIN = "http://127.0.0.1:18788";
const APP_URL = `${APP_ORIGIN}/`;
const TOKEN_FILE = path.join(RUNTIME_DIR, "imagebot-control-server.token");

fs.mkdirSync(RUNTIME_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

function readControlToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function pingServer() {
  return new Promise(resolve => {
    const token = readControlToken();
    if (!token) {
      resolve(false);
      return;
    }
    const req = http.get(`${APP_ORIGIN}/api/ping`, {
      headers: {
        "X-Imagebot-Control-Token": token
      }
    }, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await pingServer()) return true;
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  return false;
}

function startServer() {
  if (!fs.existsSync(SERVER_SCRIPT)) {
    throw new Error(`Missing control server: ${SERVER_SCRIPT}`);
  }

  const out = fs.openSync(SERVER_LOG, "a");
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out]
  });
  child.unref();
  fs.writeFileSync(path.join(RUNTIME_DIR, "imagebot-control-server.pid"), String(child.pid));
}

function firstExisting(candidates) {
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || "";
}

function resolveEdge() {
  return firstExisting([
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe")
  ]);
}

function appUrlWithToken() {
  const token = readControlToken();
  if (!token) throw new Error(`Control token not found: ${TOKEN_FILE}`);
  return `${APP_URL}#token=${encodeURIComponent(token)}`;
}

function openAppWindow() {
  const edge = resolveEdge();
  const url = appUrlWithToken();
  if (edge) {
    const child = spawn(edge, [`--app=${url}`, "--window-size=1180,760"], {
      detached: true,
      windowsHide: false,
      stdio: "ignore"
    });
    child.unref();
    return;
  }

  spawn("cmd.exe", ["/c", "start", "", url], {
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  }).unref();
}

async function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify({
      ok: true,
      root: ROOT,
      serverScript: SERVER_SCRIPT,
      serverScriptExists: fs.existsSync(SERVER_SCRIPT),
      serverReady: await pingServer(),
      tokenFileExists: fs.existsSync(TOKEN_FILE)
    }));
    return;
  }

  const noOpen = process.argv.includes("--no-open");
  if (!(await pingServer())) {
    startServer();
  }

  if (!(await waitForServer())) {
    throw new Error(`Imagebot control server did not start. Log: ${SERVER_LOG}`);
  }

  console.log(`Imagebot app server is ready: ${APP_URL}`);
  if (!noOpen) {
    openAppWindow();
  }
}

main().catch(error => {
  console.error(error.message || String(error));
  process.exit(1);
});

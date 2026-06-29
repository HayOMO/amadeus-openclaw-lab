import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DESKTOP_MEDIA_CONTROL_TOOL = "desktop_media_control";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const ACTIONS = new Set(["status", "play", "pause", "toggle", "next", "previous", "stop"]);
const TARGETS = new Set(["current", "netease", "any"]);

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginDir, "..", "..");

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  return typeof value === "string" ? value.trim() : fallback;
}

function readNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function clip(value, max = 1200) {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function nowIso() {
  return new Date().toISOString();
}

function storeRoot(config) {
  const configured = String(config?.storeDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "desktop-control"));
}

function helperPath(config) {
  const configured = String(config?.helperPath || "").trim();
  return path.resolve(configured || path.join(repoRoot, "scripts", "LOCAL_DESKTOP_MEDIA_CONTROL.ps1"));
}

function auditLogPath(config) {
  return path.join(storeRoot(config), "desktop-media-events.jsonl");
}

async function appendJsonLine(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function toolContext(ctx = {}) {
  const out = {};
  for (const key of ["agentId", "accountId", "channel", "chatId", "sessionKey", "windowId", "messageId"]) {
    if (ctx[key] !== undefined && ctx[key] !== null && String(ctx[key]).trim()) {
      out[key] = String(ctx[key]);
    }
  }
  return out;
}

function validateActionParams(params) {
  const action = readString(params, "action", "status").toLowerCase();
  const target = readString(params, "target", "current").toLowerCase();
  if (!ACTIONS.has(action)) throw new Error(`unsupported desktop media action: ${action || "(empty)"}`);
  if (!TARGETS.has(target)) throw new Error(`unsupported desktop media target: ${target || "(empty)"}`);
  return { action, target };
}

function parseHelperJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) throw new Error("desktop media helper returned no output");
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  const jsonText = firstBrace >= 0 && lastBrace >= firstBrace ? text.slice(firstBrace, lastBrace + 1) : text;
  return JSON.parse(jsonText);
}

function runPowerShellHelper(config, request, signal) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve({
        ok: false,
        status: "unsupported_platform",
        action: request.action,
        target: request.target,
        error: "desktop media control is currently implemented for Windows only"
      });
      return;
    }

    const resolvedHelperPath = helperPath(config);
    const timeoutMs = readNumber(config?.timeoutMs, DEFAULT_TIMEOUT_MS, 3_000, MAX_TIMEOUT_MS);
    const child = spawn("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolvedHelperPath,
      "-Action",
      request.action,
      "-Target",
      request.target
    ], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const kill = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", kill, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 80_000) stdout = stdout.slice(-80_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 80_000) stderr = stderr.slice(-80_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve({
        ok: false,
        status: "failed",
        action: request.action,
        target: request.target,
        error: error.message,
        stderr: clip(stderr)
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      try {
        const parsed = parseHelperJson(stdout);
        parsed.exitCode = typeof code === "number" ? code : -1;
        parsed.timedOut = timedOut;
        parsed.aborted = aborted;
        if (stderr.trim()) parsed.stderr = clip(stderr);
        resolve(parsed);
      } catch (error) {
        resolve({
          ok: false,
          status: timedOut ? "timeout" : "failed",
          action: request.action,
          target: request.target,
          exitCode: typeof code === "number" ? code : -1,
          timedOut,
          aborted,
          error: error instanceof Error ? error.message : String(error),
          stdout: clip(stdout),
          stderr: clip(stderr)
        });
      }
    });
  });
}

function formatTrack(session) {
  const media = isRecord(session?.media) ? session.media : {};
  const title = String(media.title || "").trim();
  const artist = String(media.artist || "").trim();
  const source = String(session?.sourceAppUserModelId || "").trim();
  const status = String(session?.playbackStatus || "").trim();
  const track = [title, artist].filter(Boolean).join(" - ") || "(unknown track)";
  return `${track}${status ? ` | ${status}` : ""}${source ? ` | ${source}` : ""}`;
}

function formatResult(result) {
  const lines = [
    "DESKTOP_MEDIA_CONTROL",
    `action: ${result.action || ""}`,
    `target: ${result.target || ""}`,
    `status: ${result.status || "unknown"}`
  ];

  if (result.current) lines.push(`current: ${formatTrack(result.current)}`);
  if (result.selected) lines.push(`selected: ${formatTrack(result.selected)}`);
  if (Number.isFinite(Number(result.sessionCount))) lines.push(`sessions: ${result.sessionCount}`);
  if (result.error) lines.push(`error: ${clip(result.error, 500)}`);
  if (result.timedOut) lines.push("timedOut: true");
  return lines.filter(Boolean).join("\n");
}

async function invokeDesktopMediaControl(config, params, signal, ctx, options = {}) {
  const request = validateActionParams(params);
  const runner = typeof options.runner === "function" ? options.runner : config?.runner;
  const result = typeof runner === "function"
    ? await runner(request, { config, signal, ctx })
    : await runPowerShellHelper(config, request, signal);

  const record = {
    type: "desktop_media_control",
    t: nowIso(),
    action: request.action,
    target: request.target,
    status: result?.status || "unknown",
    ok: result?.ok === true,
    context: toolContext(ctx),
    selectedSource: result?.selected?.sourceAppUserModelId || result?.current?.sourceAppUserModelId || "",
    selectedPlaybackStatus: result?.selected?.playbackStatus || result?.current?.playbackStatus || "",
    sessionCount: Number.isFinite(Number(result?.sessionCount)) ? Number(result.sessionCount) : undefined
  };

  if (config?.audit !== false) {
    await appendJsonLine(auditLogPath(config), record);
  }

  return {
    content: [{ type: "text", text: formatResult(result || {}) }],
    details: {
      status: result?.ok === true ? "ok" : (result?.status || "failed"),
      request,
      result,
      audit: record
    }
  };
}

const desktopMediaControlTool = {
  name: DESKTOP_MEDIA_CONTROL_TOOL,
  label: "Desktop Media Control",
  description: "Control bounded Windows media sessions such as NetEase Cloud Music. Exposes only fixed media actions, not raw shell, clicks, typing, or hotkeys.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        description: "Fixed media operation. Use status before claiming an app is controllable."
      },
      target: {
        type: "string",
        enum: [...TARGETS],
        description: "Media session selector. netease matches known NetEase Cloud Music session identifiers; current uses the Windows current media session."
      }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    try {
      const config = desktopMediaControlTool.config || {};
      return await invokeDesktopMediaControl(config, params, signal, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `DESKTOP_MEDIA_CONTROL error: ${clip(message, 500)}` }],
        details: { status: "failed", error: message }
      };
    }
  }
};

export const __testing = {
  ACTIONS,
  TARGETS,
  validateActionParams,
  parseHelperJson,
  formatTrack,
  formatResult,
  invokeDesktopMediaControl,
  runPowerShellHelper,
  helperPath,
  auditLogPath
};

export default {
  id: "imagebot-desktop-control",
  name: "Imagebot Desktop Control",
  description: "Bounded local desktop control adapters.",
  register(api) {
    const config = api.config || {};
    desktopMediaControlTool.config = config;
    api.registerTool(desktopMediaControlTool, { name: DESKTOP_MEDIA_CONTROL_TOOL });
  }
};

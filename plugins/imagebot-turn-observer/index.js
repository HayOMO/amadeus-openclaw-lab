import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { registerLifecycleHook } from "../imagebot-shared/openclaw-lifecycle-hooks.mjs";
import { openclawStatePath } from "../imagebot-shared/openclaw-paths.mjs";

const RECENT_TOOL = "turn_observer_recent";
const DEFAULT_COUNT = 8;
const MAX_COUNT = 30;
const MAX_TEXT = 5000;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function readCount(params, fallback = DEFAULT_COUNT) {
  const raw = isRecord(params) ? params.count : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_COUNT, Math.trunc(value)));
}

function storeRoot(config = {}) {
  const configured = String(config.storeDir || "").trim();
  return path.resolve(configured || openclawStatePath("turn-observer"));
}

function logPath(config = {}) {
  return path.join(storeRoot(config), "turn-events.jsonl");
}

function hash(value, len = 12) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[telegram-token-redacted]")
    .replace(/https:\/\/api\.telegram\.org\/bot[^\s<>"']+/gi, "https://api.telegram.org/[telegram-token-redacted]")
    .replace(/[A-Za-z]:\\[^\s<>"']+/g, "[local-path-redacted]")
    .replace(/\\\\[^\\\s]+\\[^\s<>"']+/g, "[unc-path-redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip-redacted]")
    .replace(/[A-Za-z0-9_][A-Za-z0-9_-]{63,}/g, "[long-token-redacted]")
    .replace(/\r\n/g, "\n")
    .trim();
}

function clip(value, max = 500) {
  const text = sanitizeText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function summarizeParams(params) {
  if (!isRecord(params)) return "";
  const summary = {};
  for (const key of Object.keys(params).sort().slice(0, 20)) {
    const value = params[key];
    if (typeof value === "string") summary[key] = clip(value, 220);
    else if (typeof value === "number" || typeof value === "boolean") summary[key] = value;
    else if (Array.isArray(value)) summary[key] = `[array:${value.length}]`;
    else if (isRecord(value)) summary[key] = "[object]";
    else if (value == null) summary[key] = null;
  }
  return clip(JSON.stringify(summary), 1200);
}

function getNestedText(value, depth = 0) {
  if (depth > 2 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => getNestedText(item, depth + 1)).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  for (const key of ["text", "message", "content", "prompt", "caption"]) {
    const found = getNestedText(value[key], depth + 1);
    if (found) return found;
  }
  return "";
}

function identityFrom(event = {}, ctx = {}) {
  return {
    agentId: String(ctx.agentId || event.agentId || ""),
    runId: String(ctx.runId || event.runId || ""),
    sessionKey: String(ctx.sessionKey || event.sessionKey || ""),
    chatId: String(event.chatId || event.groupId || ctx.chatId || ctx.groupId || ""),
    userId: String(event.userId || event.senderId || ctx.userId || "")
  };
}

function modelInfoFrom(event = {}, ctx = {}) {
  const model = event.model || ctx.model || event.modelInfo || ctx.modelInfo || {};
  return {
    modelProvider: String(event.provider || ctx.provider || model.provider || ""),
    modelId: String(event.modelId || ctx.modelId || model.modelId || model.id || model.name || ""),
    modelApi: String(event.modelApi || ctx.modelApi || model.api || "")
  };
}

function summarizeEvent(kind, event = {}, ctx = {}) {
  const identity = identityFrom(event, ctx);
  const modelInfo = modelInfoFrom(event, ctx);
  const toolName = String(event.toolName || "");
  const status = String(event.status || event.result?.details?.status || event.details?.status || "");
  const error = event.error ? (event.error instanceof Error ? event.error.message : String(event.error)) : "";
  const text = getNestedText(event.message ?? event);
  const params = isRecord(event.params) ? Object.keys(event.params).sort().slice(0, 20) : [];
  const paramsPreview = summarizeParams(event.params);
  const attachments = [];
  for (const item of [event.message, event.result, event.details, event.params]) {
    if (!isRecord(item)) continue;
    for (const key of ["file", "path", "url", "image", "images", "files", "media", "attachments"]) {
      if (key in item) attachments.push(key);
    }
  }
  return {
    t: new Date().toISOString(),
    kind,
    ...identity,
    ...modelInfo,
    toolName,
    toolCallId: String(event.toolCallId || ctx.toolCallId || ""),
    status,
    error: clip(error, 300),
    textHash: text ? hash(text) : "",
    textPreview: clip(text, 260),
    paramKeys: params,
    paramsPreview,
    attachmentKeys: [...new Set(attachments)]
  };
}

async function appendRecord(config, record) {
  await fs.mkdir(path.dirname(logPath(config)), { recursive: true });
  await fs.appendFile(logPath(config), `${JSON.stringify(record)}\n`, "utf8");
}

async function readTailLines(filePath, maxLines = 200) {
  let text = "";
  try {
    const stat = await fs.stat(filePath);
    const handle = await fs.open(filePath, "r");
    try {
      const length = Math.min(stat.size, 512 * 1024);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
  return text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
}

function matchesFilter(record, params = {}) {
  const type = readString(params, "type") || readString(params, "kind");
  const toolName = readString(params, "toolName") || readString(params, "tool");
  const sessionKey = readString(params, "sessionKey") || readString(params, "session");
  const runId = readString(params, "runId") || readString(params, "run");
  const status = readString(params, "status");
  if (type && record.kind !== type) return false;
  if (toolName && record.toolName !== toolName) return false;
  if (sessionKey && record.sessionKey !== sessionKey) return false;
  if (runId && record.runId !== runId) return false;
  if (status && record.status !== status) return false;
  return true;
}

async function recentRecords(config = {}, params = {}) {
  const count = readCount(params);
  const lines = await readTailLines(logPath(config), Math.max(200, count * 10));
  const records = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => record && matchesFilter(record, params))
    .slice(-count)
    .reverse();
  return {
    content: [{
      type: "text",
      text: [
        `TURN_OBSERVER_RECENT results=${records.length}`,
        ...records.map((item, index) => [
          `${index + 1}. ${item.t} kind=${item.kind} tool=${item.toolName || "-"} status=${item.status || "-"} model=${item.modelId || "-"} session=${clip(item.sessionKey, 80) || "-"}`,
          item.textPreview ? `text: ${item.textPreview}` : "",
          item.paramsPreview ? `params: ${clip(item.paramsPreview, 420)}` : "",
          item.error ? `error: ${item.error}` : ""
        ].filter(Boolean).join("\n"))
      ].join("\n").slice(0, MAX_TEXT)
    }],
    details: { status: "ok", results: records }
  };
}

function tool(name, label, description, parameters, fn) {
  return {
    name,
    label,
    description,
    parameters,
    execute: async (_id, params) => {
      try {
        return await fn(params || {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `${name.toUpperCase()} error: ${clip(message, 500)}` }], details: { status: "failed", error: message } };
      }
    }
  };
}

const recentTool = tool(RECENT_TOOL, "Turn Observer Recent", "Read sanitized recent imagebot turn/tool/message records.", {
  type: "object",
  additionalProperties: false,
  properties: {
    count: { type: "number", description: `Max results 1-${MAX_COUNT}.` },
    kind: { type: "string", description: "Filter by record kind." },
    type: { type: "string", description: "Alias for kind." },
    toolName: { type: "string", description: "Filter by tool name." },
    tool: { type: "string", description: "Alias for toolName." },
    sessionKey: { type: "string", description: "Filter by session key." },
    session: { type: "string", description: "Alias for sessionKey." },
    runId: { type: "string", description: "Filter by run id." },
    run: { type: "string", description: "Alias for runId." },
    status: { type: "string", description: "Filter by status." }
  }
}, (params) => recentRecords(recentTool.config || {}, params));

export const __testing = {
  logPath,
  sanitizeText,
  summarizeParams,
  summarizeEvent,
  recentRecords
};

export default {
  id: "imagebot-turn-observer",
  name: "Imagebot Turn Observer",
  description: "Sanitized per-turn observability for the imagebot.",
  register(api) {
    const config = api.config || {};
    recentTool.config = config;
    api.registerTool(recentTool, { name: RECENT_TOOL });
    const hook = (kind) => async (event, ctx) => {
      if (ctx?.agentId && ctx.agentId !== "imagebot") return;
      await appendRecord(config, summarizeEvent(kind, event, ctx));
    };
    const syncHook = (kind) => (event, ctx) => {
      if (ctx?.agentId && ctx.agentId !== "imagebot") return;
      appendRecord(config, summarizeEvent(kind, event, ctx)).catch(() => {});
    };
    registerLifecycleHook(api, "before_prompt_build", hook("before_prompt_build"), { name: "imagebot-turn-observer-before-prompt-build" });
    registerLifecycleHook(api, "before_tool_call", hook("before_tool_call"), { name: "imagebot-turn-observer-before-tool-call" });
    registerLifecycleHook(api, "after_tool_call", hook("after_tool_call"), { name: "imagebot-turn-observer-after-tool-call" });
    registerLifecycleHook(api, "before_message_write", syncHook("before_message_write"), { name: "imagebot-turn-observer-before-message-write" });
  }
};

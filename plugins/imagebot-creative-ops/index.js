import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getBackgroundJobManager } from "../imagebot-background-jobs/index.js";
import { registerLifecycleHook } from "../imagebot-shared/openclaw-lifecycle-hooks.mjs";
import {
  bindMutationPlanToContext,
  mutationTargetFingerprint,
  newMutationApprovalCode,
  newMutationPlanId,
  verifyMutationPlanApproval
} from "../imagebot-shared/mutation-authorization.mjs";

const SCRIPT_ACTION_TOOL = "script_action";
const PROMPT_LIBRARY_TOOL = "prompt_library";
const IMAGE_FEEDBACK_TOOL = "image_feedback";
const MODEL_CONFIG_TOOL = "model_config";
const COMMAND_CATALOG_TOOL = "command_catalog";

const MAX_TEXT = 6000;
const MAX_LOG_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_COUNT = 6;
const MAX_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(pluginDir, "..", "..");
let promptCardsCacheRoot = "";
let promptCardsCache = null;

const SCRIPT_REGISTRY = [
  {
    id: "gateway_status",
    title: "Gateway status",
    description: "Read current OpenClaw gateway status.",
    risk: "read",
    command: "powershell",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "openclaw status"],
    keywords: ["status", "health", "alive", "online", "gateway", "状态", "健康", "在线"]
  },
  {
    id: "gateway_deep_status",
    title: "Gateway deep status",
    description: "Read detailed OpenClaw gateway/channel/security status.",
    risk: "read",
    command: "powershell",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "openclaw status --deep"],
    timeoutMs: 120_000,
    keywords: ["deep", "security", "telegram", "channel", "详细", "安全", "通道"]
  },
  {
    id: "sync_telegram_commands",
    title: "Sync Telegram command menu",
    description: "Update Telegram BotFather-style command menu from local config.",
    risk: "telegram-write",
    script: "scripts/SYNC_IMAGEBOT_TELEGRAM_COMMANDS.ps1",
    requiresApproval: true,
    timeoutMs: 120_000,
    keywords: ["commands", "botfather", "menu", "telegram", "命令", "菜单", "同步"]
  },
  {
    id: "archive_media_cache",
    title: "Archive generated/downloaded media cache",
    description: "Copy bot media cache into the local image archive.",
    risk: "local-write",
    script: "scripts/ARCHIVE_IMAGEBOT_MEDIA_CACHE.ps1",
    timeoutMs: 180_000,
    keywords: ["archive", "gallery", "media", "cache", "图库", "缓存", "归档"]
  },
  {
    id: "export_memory_backup",
    title: "Export imagebot memory backup",
    description: "Export bot-visible memory files into the repository backup folder.",
    risk: "local-write",
    script: "scripts/EXPORT_IMAGEBOT_MEMORY_BACKUP.ps1",
    timeoutMs: 180_000,
    keywords: ["memory", "backup", "export", "记忆", "备份", "导出"]
  },
  {
    id: "backup_to_github",
    title: "Backup bot project to GitHub",
    description: "Run the project backup script. It creates a local commit by default; network push requires an explicit operator shell run with -Push.",
    risk: "local-write",
    script: "scripts/BACKUP_IMAGEBOT_TO_GITHUB.ps1",
    requiresApproval: true,
    timeoutMs: 180_000,
    keywords: ["github", "backup", "push", "commit", "备份", "提交"]
  },
  {
    id: "consolidate_memory",
    title: "Consolidate imagebot memory",
    description: "Run the existing memory consolidation script.",
    risk: "memory-write",
    script: "scripts/CONSOLIDATE_IMAGEBOT_MEMORY.ps1",
    requiresApproval: true,
    timeoutMs: 180_000,
    keywords: ["memory", "consolidate", "整理", "记忆", "总结"]
  },
  {
    id: "apply_chat_balance_mode",
    title: "Apply chat balance config",
    description: "Re-apply the main OpenClaw imagebot config and prompt bundle.",
    risk: "config-write",
    script: "scripts/APPLY_CHAT_BALANCE_MODE.ps1",
    requiresApproval: true,
    timeoutMs: 180_000,
    keywords: ["config", "apply", "prompt", "tools", "配置", "提示词", "应用"]
  }
];

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function repoRoot(config) {
  const configured = String(config?.repoRoot || "").trim();
  return path.resolve(configured || defaultRepoRoot);
}

function storeRoot(config) {
  const configured = String(config?.storeDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "creative-ops"));
}

function plansPath(config) {
  return path.join(storeRoot(config), "script-plans.json");
}

function scriptLogPath(config) {
  return path.join(storeRoot(config), "script-runs.jsonl");
}

function feedbackLogPath(config) {
  return path.join(storeRoot(config), "image-feedback.jsonl");
}

function modelProfilesPath(config) {
  const configured = String(config?.modelProfilesPath || "").trim();
  return path.resolve(configured || path.join(repoRoot(config), "scripts", "IMAGEBOT_MODEL_PROFILES.json"));
}

function openClawConfigPath(config) {
  const configured = String(config?.openClawConfigPath || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "openclaw.json"));
}

function sessionStorePath(config, ctx = {}) {
  const configured = String(config?.sessionStorePath || "").trim();
  if (configured) return path.resolve(configured);
  const agentId = String(ctx?.agentId || config?.agentId || "imagebot").trim().replace(/[^A-Za-z0-9_.-]/g, "_") || "imagebot";
  return path.join(homeDir(), ".openclaw", "agents", agentId, "sessions", "sessions.json");
}

function commandCatalogPath(config) {
  const configured = String(config?.commandCatalogPath || "").trim();
  return path.resolve(configured || path.join(repoRoot(config), "scripts", "IMAGEBOT_COMMANDS.json"));
}

function promptLibraryRoot(config) {
  const configured = String(config?.promptLibraryDir || "").trim();
  return path.resolve(configured || path.join(repoRoot(config), "prompt_library"));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nowIso() {
  return new Date().toISOString();
}

function hash(value, len = 16) {
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

function clip(value, max = 600) {
  const text = sanitizeText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  return typeof value === "string" ? value.trim() : fallback;
}

function readBoolean(params, key, fallback = false) {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(1|true|yes|on)$/i.test(value.trim());
  return fallback;
}

function readNumber(params, key, fallback, min, max) {
  const raw = isRecord(params) ? params[key] : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function readCount(params, fallback = DEFAULT_COUNT, max = MAX_COUNT) {
  return readNumber(params, "count", fallback, 1, max);
}

function readArrayStrings(params, key) {
  const raw = isRecord(params) ? params[key] : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item || "").trim()).filter(Boolean);
}

async function appendJsonLine(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function readTail(filePath, maxBytes = MAX_LOG_READ_BYTES) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
  if (!stat.isFile() || stat.size <= 0) return "";
  if (stat.size <= maxBytes) return await fs.readFile(filePath, "utf8");
  const length = maxBytes;
  const position = Math.max(0, stat.size - length);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const result = await handle.read(buffer, 0, length, position);
    let text = buffer.subarray(0, result.bytesRead).toString("utf8");
    if (position > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

async function readJsonLines(filePath) {
  const raw = await readTail(filePath);
  if (!raw) return [];
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (isRecord(record)) records.push(record);
    } catch {
      // Append-only store: skip malformed tail fragments.
    }
  }
  return records;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

function ok(toolName, lines, details = {}) {
  return {
    content: [{ type: "text", text: [toolName.toUpperCase(), ...lines].filter(Boolean).join("\n") }],
    details: { status: "ok", ...details }
  };
}

function fail(toolName, error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `${toolName.toUpperCase()} error: ${clip(message, 500)}` }],
    details: { status: "failed", error: message }
  };
}

function addTerm(terms, term) {
  const normalized = String(term || "").trim().replace(/^@/, "").toLowerCase();
  if (normalized.length < 2) return;
  terms.add(normalized);
}

function extractTerms(text) {
  const terms = new Set();
  const source = String(text || "").toLowerCase();
  for (const match of source.matchAll(/[a-z0-9_.-]{2,64}/gi)) addTerm(terms, match[0]);
  for (const match of source.matchAll(/[\u4e00-\u9fff]{2,14}/g)) {
    const seq = match[0];
    for (let size = Math.min(4, seq.length); size >= 2; size--) {
      for (let i = 0; i <= seq.length - size; i++) addTerm(terms, seq.slice(i, i + size));
    }
  }
  return [...terms].slice(0, 60);
}

function scoreText(haystack, terms) {
  const text = String(haystack || "").toLowerCase();
  let score = 0;
  const hits = [];
  for (const term of terms) {
    const count = text.split(term).length - 1;
    if (count > 0) {
      score += count * (4 + Math.min(term.length, 12));
      hits.push(term);
    }
  }
  return { score, hits: [...new Set(hits)].slice(0, 10) };
}

function normalizeScriptId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
}

function publicScript(script) {
  return {
    id: script.id,
    title: script.title,
    description: script.description,
    risk: script.risk,
    requiresApproval: needsApproval(script)
  };
}

function findScript(id) {
  const normalized = normalizeScriptId(id);
  return SCRIPT_REGISTRY.find((script) => script.id === normalized) || null;
}

function routeScripts(query, count = 5) {
  const terms = extractTerms(query);
  const scored = SCRIPT_REGISTRY.map((script) => {
    const haystack = [
      script.id,
      script.title,
      script.description,
      script.risk,
      ...(script.keywords || [])
    ].join("\n");
    const scored = scoreText(haystack, terms);
    return { script, score: scored.score, hits: scored.hits };
  }).sort((a, b) => b.score - a.score);
  const positive = scored.filter((entry) => entry.score > 0);
  return (positive.length ? positive : scored).slice(0, count);
}

function needsApproval(script) {
  if (script.requiresApproval === true) return true;
  if (script.safeUnapproved === true) return false;
  return script.risk !== "read";
}

function isMutatingScript(script) {
  return script.risk !== "read";
}

async function loadPlans(config) {
  const loaded = await readJson(plansPath(config), null);
  if (isRecord(loaded) && isRecord(loaded.plans)) return loaded;
  return { version: 1, plans: {} };
}

async function savePlans(config, plans) {
  plans.version = 1;
  plans.updatedAt = nowIso();
  await writeJsonAtomic(plansPath(config), plans);
}

function scriptPlanFingerprint(script) {
  return mutationTargetFingerprint({
    tool: SCRIPT_ACTION_TOOL,
    action: "run",
    scriptId: script.id,
    risk: script.risk,
    command: script.command || "",
    script: script.script || ""
  });
}

async function makeScriptPlan(config, script, reason = "", ctx = {}) {
  const plans = await loadPlans(config);
  const plan = bindMutationPlanToContext({
    id: newMutationPlanId("plan"),
    scriptId: script.id,
    t: nowIso(),
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    approvalCode: newMutationApprovalCode("APPROVE"),
    reason: clip(reason, 500),
    risk: script.risk,
    fingerprint: scriptPlanFingerprint(script),
    used: false
  }, ctx, { label: "script_action plan" });
  plans.plans[plan.id] = plan;
  const entries = Object.entries(plans.plans).filter(([, entry]) => Date.parse(entry.expiresAt || 0) > Date.now() && entry.used !== true);
  plans.plans = Object.fromEntries(entries.slice(-80));
  await savePlans(config, plans);
  return plan;
}

async function resolveScriptPlan(config, script, params, ctx = {}, options = {}) {
  if (!needsApproval(script)) return { ok: true, plan: null };
  const planId = readString(params, "plan_id") || readString(params, "planId");
  if (!planId) return { ok: false, reason: "This script requires a plan_id from script_action action=plan." };
  const plans = await loadPlans(config);
  const plan = plans.plans[planId];
  if (!plan || plan.scriptId !== script.id) return { ok: false, reason: "No matching active script plan." };
  if (plan.used === true || Date.parse(plan.expiresAt || 0) <= Date.now()) return { ok: false, reason: "Script plan expired or already used." };
  if (plan.fingerprint && plan.fingerprint !== scriptPlanFingerprint(script)) return { ok: false, reason: "Script plan does not match the registered script target." };
  const approval = verifyMutationPlanApproval({ plan, ctx, approvalCode: plan.approvalCode, label: "script_action" });
  if (!approval.ok) return approval;
  if (options.consume !== false) {
    plan.used = true;
    plan.usedAt = nowIso();
    plan.usedBy = approval.context ? {
      accountId: approval.context.accountId,
      chatId: approval.context.chatId,
      threadId: approval.context.threadId,
      sessionKey: approval.context.sessionKey,
      windowId: approval.context.windowId,
      senderId: approval.context.senderId,
      messageId: approval.context.messageId
    } : undefined;
    await savePlans(config, plans);
  }
  return { ok: true, plan };
}

async function consumeScriptPlan(config, script, params, ctx) {
  return resolveScriptPlan(config, script, params, ctx, { consume: true });
}

async function checkScriptPlan(config, script, params, ctx) {
  return resolveScriptPlan(config, script, params, ctx, { consume: false });
}

function modelPlanFingerprint({ plannedAction = "set", settings = null, restartGateway = false } = {}) {
  return hash(JSON.stringify({
    plannedAction,
    settings: settings ? {
      mode: settings.mode,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      textVerbosity: settings.textVerbosity
    } : null,
    restartGateway: restartGateway === true
  }), 18);
}

async function makeModelConfigPlan(config, { plannedAction = "set", settings = null, restartGateway = false, reason = "" } = {}, ctx = {}) {
  const plans = await loadPlans(config);
  const plan = bindMutationPlanToContext({
    id: newMutationPlanId("model_plan"),
    kind: "model_config",
    plannedAction,
    t: nowIso(),
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    approvalCode: newMutationApprovalCode("APPROVE-MODEL"),
    reason: clip(reason, 500),
    settings: settings ? {
      mode: settings.mode,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      textVerbosity: settings.textVerbosity
    } : null,
    restartGateway: restartGateway === true,
    fingerprint: modelPlanFingerprint({ plannedAction, settings, restartGateway }),
    used: false
  }, ctx, { label: "model_config plan" });
  plans.plans[plan.id] = plan;
  const entries = Object.entries(plans.plans).filter(([, entry]) => Date.parse(entry.expiresAt || 0) > Date.now() && entry.used !== true);
  plans.plans = Object.fromEntries(entries.slice(-80));
  await savePlans(config, plans);
  return plan;
}

async function consumeModelConfigPlan(config, params, expected, ctx = {}) {
  if (config.requireModelConfigApproval === false) return { ok: true, plan: null };
  const planId = readString(params, "plan_id") || readString(params, "planId");
  if (!planId) return { ok: false, reason: "model_config set/restart requires a plan_id from model_config action=plan." };
  const plans = await loadPlans(config);
  const plan = plans.plans[planId];
  if (!plan || plan.kind !== "model_config") return { ok: false, reason: "No matching active model_config plan." };
  if (plan.used === true || Date.parse(plan.expiresAt || 0) <= Date.now()) return { ok: false, reason: "Model config plan expired or already used." };
  const expectedFingerprint = modelPlanFingerprint(expected);
  if (plan.fingerprint !== expectedFingerprint) return { ok: false, reason: "Model config plan does not match the requested set/restart operation." };
  const approval = verifyMutationPlanApproval({ plan, ctx, approvalCode: plan.approvalCode, label: "model_config" });
  if (!approval.ok) return approval;
  plan.used = true;
  plan.usedAt = nowIso();
  plan.usedBy = approval.context ? {
    accountId: approval.context.accountId,
    chatId: approval.context.chatId,
    threadId: approval.context.threadId,
    sessionKey: approval.context.sessionKey,
    windowId: approval.context.windowId,
    senderId: approval.context.senderId,
    messageId: approval.context.messageId
  } : undefined;
  await savePlans(config, plans);
  return { ok: true, plan };
}

function isInside(root, target) {
  const rootNorm = path.resolve(root).toLowerCase();
  const targetNorm = path.resolve(target).toLowerCase();
  return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + path.sep);
}

async function resolveScriptCommand(config, script) {
  if (script.command) return { command: script.command, args: script.args || [], cwd: repoRoot(config) };
  const root = repoRoot(config);
  const scriptPath = path.resolve(root, script.script);
  if (!isInside(root, scriptPath)) throw new Error("script path escaped repository root");
  const stat = await fs.stat(scriptPath);
  if (!stat.isFile()) throw new Error(`registered script missing: ${script.script}`);
  return {
    command: "powershell",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    cwd: root
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const abort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);
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
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode: -1, timedOut, aborted, stdout, stderr: String(error), durationMs: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode: typeof code === "number" ? code : -1, timedOut, aborted, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

async function runRegisteredScript(config, script, params, options = {}) {
  if (isMutatingScript(script) && config.allowMutatingScripts === false) {
    throw new Error("mutating scripts are disabled by plugin config");
  }
  const approval = options.approval || await consumeScriptPlan(config, script, params, options.ctx || {});
  if (!approval.ok) throw new Error(approval.reason);
  const resolved = await resolveScriptCommand(config, script);
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, script.timeoutMs || DEFAULT_TIMEOUT_MS);
  const result = await runProcess(resolved.command, resolved.args, { cwd: resolved.cwd, timeoutMs, signal: options.signal });
  const record = {
    type: "script_run",
    t: nowIso(),
    scriptId: script.id,
    risk: script.risk,
    planId: approval.plan?.id || "",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: result.aborted === true,
    durationMs: result.durationMs,
    stdout: clip(result.stdout, 2000),
    stderr: clip(result.stderr, 2000)
  };
  await appendJsonLine(scriptLogPath(config), record);
  return { result, record };
}

async function loadScriptRuns(config) {
  return (await readJsonLines(scriptLogPath(config)))
    .filter((record) => record.type === "script_run")
    .sort((a, b) => String(b.t || "").localeCompare(String(a.t || "")));
}

function formatScriptLine(script, index = 0) {
  const prefix = index ? `${index}. ` : "";
  return `${prefix}${script.id} | risk=${script.risk}${needsApproval(script) ? " | approval" : ""} | ${script.title}`;
}

function backgroundJobsConfig(config) {
  const configured = isRecord(config.backgroundJobs) ? config.backgroundJobs : {};
  return {
    storeDir: configured.storeDir || path.join(homeDir(), ".openclaw", "background-jobs"),
    maxConcurrent: readNumber(configured, "maxConcurrent", 3, 1, 8),
    appendActiveContext: configured.appendActiveContext !== false
  };
}

function toolContext(ctx) {
  if (!isRecord(ctx)) return {};
  const out = {};
  for (const key of ["agentId", "accountId", "channel", "chatId", "threadId", "messageThreadId", "sessionKey", "windowId", "senderId", "userId", "fromUserId", "messageId", "replyToMessageId"]) {
    if (ctx[key] !== undefined && ctx[key] !== null && String(ctx[key]).trim()) out[key] = String(ctx[key]);
  }
  return out;
}

async function enqueueScriptRun(config, script, params, ctx) {
  const approval = await consumeScriptPlan(config, script, params, ctx);
  if (!approval.ok) throw new Error(approval.reason);
  const manager = getBackgroundJobManager(backgroundJobsConfig(config));
  const dedupeKey = readString(params, "dedupe_key") || readString(params, "dedupeKey") ||
    `script_action:${script.id}:${hash(`${readString(params, "plan_id")}:${approval.plan?.actorKey || ""}:${readString(params, "reason")}`, 18)}`;
  return manager.enqueue({
    kind: "script_action.run",
    label: `script_action ${script.id}`,
    payload: {
      scriptId: script.id,
      risk: script.risk,
      reason: clip(readString(params, "reason"), 300)
    },
    context: toolContext(ctx),
    dedupeKey,
    timeoutMs: Math.min(MAX_TIMEOUT_MS + 5000, (script.timeoutMs || DEFAULT_TIMEOUT_MS) + 5000),
    handler: async ({ progress, signal }) => {
      await progress({ percent: 5, note: `running ${script.id}` });
      const { result, record } = await runRegisteredScript(config, script, params, { signal, approval });
      await progress({ percent: 95, note: `exit ${result.exitCode}` });
      return {
        scriptId: script.id,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted === true,
        durationMs: result.durationMs,
        stdout: record.stdout,
        stderr: record.stderr
      };
    }
  });
}

const scriptActionTool = {
  name: SCRIPT_ACTION_TOOL,
  label: "Script Action",
  description: "Route, plan, run, and inspect a strict whitelist of local imagebot maintenance scripts. No arbitrary shell.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "route", "plan", "run", "run_background", "history"], description: "Script action operation." },
      query: { type: "string", description: "Natural language maintenance request for route." },
      id: { type: "string", description: "Registered script id." },
      script_id: { type: "string", description: "Alias for id." },
      reason: { type: "string", description: "Reason to include in a plan." },
      plan_id: { type: "string", description: "Plan id returned by action=plan for approval-required scripts." },
      approval_text: { type: "string", description: "Legacy hint only; approval is read from current trusted runtime message context." },
      count: { type: "number", description: `Count 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.` },
      dedupe_key: { type: "string", description: "Optional duplicate key for run_background. Reusing it while a job is open returns the existing job." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const config = scriptActionTool.config || {};
      const action = readString(params, "action").toLowerCase();
      if (action === "list") {
        return ok(SCRIPT_ACTION_TOOL, [
          "registered scripts:",
          ...SCRIPT_REGISTRY.map(formatScriptLine)
        ], { action, scripts: SCRIPT_REGISTRY.map(publicScript) });
      }
      if (action === "route") {
        const query = readString(params, "query");
        if (!query) throw new Error("query is required for route");
        const results = routeScripts(query, readCount(params, 5, 10));
        return ok(SCRIPT_ACTION_TOOL, [
          `route results=${results.length}`,
          ...results.map((entry, index) => `${formatScriptLine(entry.script, index + 1)} | score=${entry.score} | hits=${entry.hits.join("/") || "none"}`)
        ], { action, results: results.map((entry) => ({ ...publicScript(entry.script), score: entry.score, hits: entry.hits })) });
      }
      if (action === "plan") {
        const script = findScript(readString(params, "id") || readString(params, "script_id"));
        if (!script) throw new Error("unknown script id");
        const plan = await makeScriptPlan(config, script, readString(params, "reason"), ctx);
        return ok(SCRIPT_ACTION_TOOL, [
          `planned ${script.id}`,
          `risk: ${script.risk}`,
          `plan_id: ${plan.id}`,
          `approval_code: ${plan.approvalCode}`,
          needsApproval(script)
            ? "Ask the same user to approve in a later message by repeating the approval code before running."
            : "This script does not require approval, but the plan can still be used for traceability."
        ], { action, script: publicScript(script), plan });
      }
      if (action === "history") {
        const records = (await loadScriptRuns(config)).slice(0, readCount(params, 8));
        const lines = [`history results=${records.length}`];
        for (const [index, record] of records.entries()) {
          lines.push(`${index + 1}. ${record.t} | ${record.scriptId} | exit=${record.exitCode} | timeout=${record.timedOut} | ${record.durationMs}ms`);
        }
        if (!records.length) lines.push("No script runs recorded yet.");
        return ok(SCRIPT_ACTION_TOOL, lines, { action, results: records });
      }
      if (action === "run") {
        const script = findScript(readString(params, "id") || readString(params, "script_id"));
        if (!script) throw new Error("unknown script id");
        const { result, record } = await runRegisteredScript(config, script, params, { ctx, signal: _signal });
        const lines = [
          `ran ${script.id}`,
          `exitCode: ${result.exitCode}`,
          `timedOut: ${result.timedOut}`,
          `durationMs: ${result.durationMs}`,
          result.stdout ? `stdout:\n${clip(result.stdout, MAX_TEXT)}` : "",
          result.stderr ? `stderr:\n${clip(result.stderr, MAX_TEXT)}` : ""
        ].filter(Boolean);
        const status = result.exitCode === 0 && result.timedOut !== true ? "ok" : "failed";
        return {
          content: [{ type: "text", text: [SCRIPT_ACTION_TOOL.toUpperCase(), ...lines].join("\n") }],
          details: { status, action, script: publicScript(script), record }
        };
      }
      if (action === "run_background") {
        const script = findScript(readString(params, "id") || readString(params, "script_id"));
        if (!script) throw new Error("unknown script id");
        const started = await enqueueScriptRun(config, script, params, ctx);
        return ok(SCRIPT_ACTION_TOOL, [
          started.deduped ? `existing background job for ${script.id}` : `queued background job for ${script.id}`,
          `job_id: ${started.job.id}`,
          `state: ${started.job.state}`,
          `risk: ${script.risk}`,
          "Use background_job action=get/list/cancel for status."
        ], { action, jobStatus: started.job.state, script: publicScript(script), job: started.job, deduped: started.deduped });
      }
      throw new Error("unknown action");
    } catch (error) {
      return fail(SCRIPT_ACTION_TOOL, error);
    }
  }
};

const DEFAULT_COMMAND_CATALOG = {
  version: 4,
  capabilities: [
    {
      id: "chat",
      title: "聊天 / 识图",
      summary: "日常聊天、看图吐槽、读回复里的图片和上下文。",
      examples: ["回复图片说想问什么", "@Amadeus 这图哪里怪"]
    },
    {
      id: "image",
      title: "生图 / 改图",
      summary: "生成图片、参考图改图、指定角色时查参考并尽量贴近原设。",
      examples: ["画一个角色", "回复图片说按这个姿势重画"]
    },
    {
      id: "media",
      title: "文件 / 媒体",
      summary: "读常见文本、代码、PDF、网页、小视频、GIF、音频摘要和关键帧。",
      examples: ["发 PDF 让她总结", "回复视频问发生了什么"]
    },
    {
      id: "web",
      title: "搜索 / 网页",
      summary: "搜索资料、搜图、网页截图、下载外链图片并保存到本地图库。",
      examples: ["搜一下这个梗", "截一下这个网页"]
    },
    {
      id: "memory",
      title: "记忆 / 资料库",
      summary: "维护群友印象、长期资料、角色/风格参考和轻量偏好。",
      examples: ["记住这个角色参考", "查一下之前那张图"]
    },
    {
      id: "play",
      title: "群玩具",
      summary: "抽老婆、签到、每日实验、图库统计和一些脚本式小玩法。",
      examples: ["抽一次老婆", "今日实验"]
    }
  ],
  commands: [
    { command: "amnew", description: "Start a clean chat window", usage: "/amnew [message]", category: "session", kind: "runtime", menu: true },
    { command: "amhelp", description: "Show available capabilities and control commands", usage: "/amhelp [abilities|all|category|command]", category: "ops", kind: "tool", tool: "command_catalog", menu: true },
    { command: "amstatus", description: "Show gateway status", usage: "/amstatus", category: "ops", kind: "script", tool: "script_action", scriptId: "gateway_status", menu: true },
    { command: "amtools", description: "List or run registered scripts", usage: "/amtools [list|route <query>|run <id>]", category: "ops", kind: "script", tool: "script_action", menu: true },
    { command: "ammodel", description: "Show or switch chat model", usage: "/ammodel [models|model <provider/model>|model <provider/model> think <level>|think <level>]", category: "ops", kind: "runtime", menu: true },
    { command: "ampersona", description: "Show or switch speaking persona", usage: "/ampersona [list|status|set <persona>|default]", category: "session", kind: "runtime", menu: true }
  ]
};

async function loadCommandCatalog(config) {
  const loaded = await readJson(commandCatalogPath(config), DEFAULT_COMMAND_CATALOG);
  return {
    version: loaded?.version || 1,
    updatedAt: String(loaded?.updatedAt || ""),
    capabilities: Array.isArray(loaded?.capabilities) ? loaded.capabilities : DEFAULT_COMMAND_CATALOG.capabilities,
    commands: Array.isArray(loaded?.commands) ? loaded.commands : DEFAULT_COMMAND_CATALOG.commands
  };
}

function normalizeCommandName(value) {
  return String(value || "").trim().replace(/^\/+/, "").replace(/@[\w_]+$/i, "").toLowerCase();
}

function publicCommand(command) {
  return {
    command: normalizeCommandName(command?.command),
    description: String(command?.description || ""),
    usage: String(command?.usage || ""),
    category: String(command?.category || "misc"),
    kind: String(command?.kind || ""),
    tool: String(command?.tool || ""),
    scriptId: String(command?.scriptId || ""),
    requiresApproval: command?.requiresApproval === true,
    menu: command?.menu !== false,
    notes: String(command?.notes || "")
  };
}

function publicCapability(capability) {
  return {
    id: normalizeCommandName(capability?.id),
    title: String(capability?.title || ""),
    summary: String(capability?.summary || ""),
    examples: Array.isArray(capability?.examples)
      ? capability.examples.map((example) => String(example || "").trim()).filter(Boolean).slice(0, 4)
      : []
  };
}

function formatCommandLine(command) {
  const item = publicCommand(command);
  const approval = item.requiresApproval ? " (needs approval)" : "";
  return `/${item.command} - ${item.description}${approval}`;
}

function formatCapabilityLine(capability) {
  const item = publicCapability(capability);
  const examples = item.examples.length ? ` 例：${item.examples.slice(0, 2).join(" / ")}` : "";
  return `- ${item.title}: ${item.summary}${examples}`;
}

function filterCommands(commands, params = {}) {
  const category = readString(params, "category").toLowerCase();
  const menuOnly = readBoolean(params, "menuOnly", false);
  return commands
    .map(publicCommand)
    .filter((command) => command.command)
    .filter((command) => !category || command.category.toLowerCase() === category)
    .filter((command) => !menuOnly || command.menu !== false)
    .sort((a, b) => a.category.localeCompare(b.category) || a.command.localeCompare(b.command));
}

function filterCapabilities(capabilities, params = {}) {
  const query = readString(params, "query") || readString(params, "category");
  const terms = extractTerms(query);
  const items = capabilities.map(publicCapability).filter((capability) => capability.id && capability.title);
  if (!terms.length) return items;
  return items
    .map((capability) => {
      const scored = scoreText([
        capability.id,
        capability.title,
        capability.summary,
        capability.examples.join("\n")
      ].join("\n"), terms);
      return { capability, score: scored.score };
    })
    .filter((entry) => entry.score > 0 || entry.capability.id === normalizeCommandName(query))
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .map((entry) => entry.capability);
}

function formatCapabilityOverview(capabilities) {
  const items = capabilities.map(publicCapability).filter((capability) => capability.id && capability.title);
  if (!items.length) return ["[她大概会这些]", "no capability overview"];
  return [
    "[她大概会这些]",
    ...items.map(formatCapabilityLine),
    "直接说需求、@ 她、回复她的消息，或回复图片/文件都行；/am* 只是少数固定控制命令。"
  ];
}

function scoreCommand(command, terms) {
  const haystack = [
    command.command,
    command.description,
    command.usage,
    command.category,
    command.kind,
    command.tool,
    command.scriptId,
    command.notes
  ].join("\n");
  return scoreText(haystack, terms);
}

function routeCommands(commands, query, count = 5) {
  const normalized = normalizeCommandName(query);
  const exact = commands.map(publicCommand).find((command) => command.command === normalized);
  if (exact) return [{ command: exact, score: 9999, hits: [normalized] }];
  const terms = extractTerms(query);
  const scored = commands.map(publicCommand).map((command) => {
    const scored = scoreCommand(command, terms);
    return { command, score: scored.score, hits: scored.hits };
  }).sort((a, b) => b.score - a.score || a.command.command.localeCompare(b.command.command));
  const positive = scored.filter((entry) => entry.score > 0);
  return (positive.length ? positive : scored).slice(0, count);
}

const commandCatalogTool = {
  name: COMMAND_CATALOG_TOOL,
  label: "Command Catalog",
  description: "List available capabilities and route Telegram slash commands from the local product command catalog.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "abilities", "get", "search", "route", "categories"], description: "List capabilities and commands, list abilities only, get one command, search/route a query, or list categories." },
      command: { type: "string", description: "Command name, with or without leading slash." },
      query: { type: "string", description: "Search/routing query." },
      category: { type: "string", description: "Optional command category filter." },
      menuOnly: { type: "boolean", description: "Only include Telegram menu commands." },
      includeCapabilities: { type: "boolean", description: "Include the human-facing capability overview before commands when listing all menu commands." },
      count: { type: "number", description: "Max results." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params) {
    try {
      const config = commandCatalogTool.config || {};
      const action = readString(params, "action").toLowerCase();
      const catalog = await loadCommandCatalog(config);
      const commands = catalog.commands.map(publicCommand).filter((command) => command.command);
      const capabilities = catalog.capabilities.map(publicCapability).filter((capability) => capability.id && capability.title);
      if (action === "categories") {
        const categories = [...new Set(commands.map((command) => command.category || "misc"))].sort();
        return ok(COMMAND_CATALOG_TOOL, [`categories: ${categories.join(", ")}`], { action, categories });
      }
      if (action === "abilities") {
        const selectedCapabilities = filterCapabilities(capabilities, params);
        return ok(COMMAND_CATALOG_TOOL, formatCapabilityOverview(selectedCapabilities), { action, capabilities: selectedCapabilities, version: catalog.version, updatedAt: catalog.updatedAt });
      }
      if (action === "list") {
        const selected = filterCommands(commands, params);
        const includeCapabilities = readBoolean(params, "includeCapabilities", !readString(params, "category"));
        const selectedCapabilities = includeCapabilities ? filterCapabilities(capabilities, {}) : [];
        const byCategory = new Map();
        for (const command of selected) {
          const key = command.category || "misc";
          if (!byCategory.has(key)) byCategory.set(key, []);
          byCategory.get(key).push(command);
        }
        const lines = [];
        if (selectedCapabilities.length) {
          lines.push(...formatCapabilityOverview(selectedCapabilities));
          lines.push("");
        }
        for (const [category, items] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          lines.push(`[${category}]`);
          lines.push(...items.map(formatCommandLine));
        }
        return ok(COMMAND_CATALOG_TOOL, lines.length ? lines : ["no commands"], { action, commands: selected, capabilities: selectedCapabilities, version: catalog.version, updatedAt: catalog.updatedAt });
      }
      if (action === "get") {
        const name = normalizeCommandName(readString(params, "command") || readString(params, "query"));
        const command = commands.find((item) => item.command === name);
        if (!command) throw new Error(`unknown command: ${name || "(empty)"}`);
        return ok(COMMAND_CATALOG_TOOL, [
          formatCommandLine(command),
          command.usage ? `usage: ${command.usage}` : "",
          command.tool ? `tool: ${command.tool}` : "",
          command.scriptId ? `script: ${command.scriptId}` : "",
          command.notes ? `notes: ${command.notes}` : ""
        ].filter(Boolean), { action, command });
      }
      if (action === "search" || action === "route") {
        const query = readString(params, "query") || readString(params, "command");
        const results = routeCommands(commands, query, readCount(params, 5, 12));
        return ok(COMMAND_CATALOG_TOOL, [
          `results=${results.length}`,
          ...results.map((entry) => `${formatCommandLine(entry.command)} | score=${entry.score}`)
        ], { action, query, results });
      }
      throw new Error("unknown action");
    } catch (error) {
      return fail(COMMAND_CATALOG_TOOL, error);
    }
  }
};

const DEFAULT_MODEL_CATALOG = {
  version: 1,
  models: [
    { id: "openai/gpt-5.5", label: "GPT-5.5", provider: "openai", enabled: true, reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"] },
    { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", provider: "deepseek", enabled: true, reasoningEfforts: ["off", "high", "max"] },
    { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", enabled: true, reasoningEfforts: ["off", "high", "max"] }
  ],
  reasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  textVerbosity: ["low", "medium", "high"],
  profiles: [
    { id: "fast", label: "Fast", model: "openai/gpt-5.5", reasoningEffort: "low", textVerbosity: "low" },
    { id: "balanced", label: "Balanced", model: "openai/gpt-5.5", reasoningEffort: "medium", textVerbosity: "low" },
    { id: "deep", label: "GPT High", model: "openai/gpt-5.5", reasoningEffort: "high", textVerbosity: "low" },
    { id: "research", label: "GPT XHigh", model: "openai/gpt-5.5", reasoningEffort: "xhigh", textVerbosity: "medium" },
    { id: "ds-fast", label: "DS Flash High", model: "deepseek/deepseek-v4-flash", reasoningEffort: "high", textVerbosity: "low" },
    { id: "ds-pro", label: "DS Pro High", model: "deepseek/deepseek-v4-pro", reasoningEffort: "high", textVerbosity: "low" },
    { id: "ds-flash-off", label: "DS Flash Off", model: "deepseek/deepseek-v4-flash", reasoningEffort: "off", textVerbosity: "low" },
    { id: "ds-flash-max", label: "DS Flash Max", model: "deepseek/deepseek-v4-flash", reasoningEffort: "max", textVerbosity: "low" },
    { id: "ds-pro-off", label: "DS Pro Off", model: "deepseek/deepseek-v4-pro", reasoningEffort: "off", textVerbosity: "low" },
    { id: "ds-pro-max", label: "DS Pro Max", model: "deepseek/deepseek-v4-pro", reasoningEffort: "max", textVerbosity: "medium" }
  ]
};

async function loadModelCatalog(config) {
  const loaded = await readJson(modelProfilesPath(config), DEFAULT_MODEL_CATALOG);
  return {
    version: loaded?.version || 1,
    models: Array.isArray(loaded?.models) ? loaded.models : DEFAULT_MODEL_CATALOG.models,
    reasoningEfforts: Array.isArray(loaded?.reasoningEfforts) ? loaded.reasoningEfforts : DEFAULT_MODEL_CATALOG.reasoningEfforts,
    textVerbosity: Array.isArray(loaded?.textVerbosity) ? loaded.textVerbosity : DEFAULT_MODEL_CATALOG.textVerbosity,
    profiles: Array.isArray(loaded?.profiles) ? loaded.profiles : DEFAULT_MODEL_CATALOG.profiles
  };
}

function publicModel(model) {
  return {
    id: String(model?.id || ""),
    label: String(model?.label || model?.id || ""),
    provider: String(model?.provider || ""),
    enabled: model?.enabled !== false,
    notes: String(model?.notes || "")
  };
}

function publicModelProfile(profile) {
  return {
    id: String(profile?.id || ""),
    label: String(profile?.label || profile?.id || ""),
    model: String(profile?.model || ""),
    reasoningEffort: String(profile?.reasoningEffort || ""),
    textVerbosity: String(profile?.textVerbosity || ""),
    description: String(profile?.description || "")
  };
}

function detectModelProfile(current, catalog) {
  const match = catalog.profiles.find((profile) =>
    String(profile.model || "") === current.model &&
    String(profile.reasoningEffort || "") === current.reasoningEffort &&
    String(profile.textVerbosity || "") === current.textVerbosity
  );
  return match ? String(match.id || "") : "custom";
}

async function readCurrentModelConfig(config, catalog = null) {
  const cfg = await readJson(openClawConfigPath(config), {});
  const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  const agent = agents.find((item) => item?.id === "imagebot") || agents[0] || {};
  const params = isRecord(agent.params) ? agent.params : {};
  const current = {
    model: String(agent.model || cfg?.agents?.defaults?.model?.primary || ""),
    reasoningEffort: String(params.reasoningEffort || ""),
    textVerbosity: String(params.textVerbosity || ""),
    imageModel: String(cfg?.agents?.defaults?.imageModel?.primary || ""),
    imageGenerationModel: String(cfg?.agents?.defaults?.imageGenerationModel?.primary || ""),
    providers: Object.keys(cfg?.models?.providers || {})
  };
  current.profileId = detectModelProfile(current, catalog || DEFAULT_MODEL_CATALOG);
  return current;
}

function readModelMode(params) {
  return (readString(params, "mode") || readString(params, "profile") || readString(params, "profile_id") || readString(params, "profileId")).toLowerCase();
}

function readReasoningEffort(params) {
  return (readString(params, "reasoningEffort") || readString(params, "reasoning") || readString(params, "thinking") || readString(params, "think")).toLowerCase();
}

function readTextVerbosity(params) {
  return (readString(params, "textVerbosity") || readString(params, "verbosity")).toLowerCase();
}

function validateModelSettings(settings, catalog) {
  if (!settings.model || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/.test(settings.model)) {
    throw new Error("Invalid model id. Use provider/model, for example openai/gpt-5.5.");
  }
  const known = catalog.models.find((model) => String(model.id || "") === settings.model);
  if (!known || known.enabled === false) {
    throw new Error(`Model '${settings.model}' is not enabled in IMAGEBOT_MODEL_PROFILES.json.`);
  }
  if (!catalog.reasoningEfforts.includes(settings.reasoningEffort)) {
    throw new Error(`Invalid reasoning effort '${settings.reasoningEffort}'.`);
  }
  if (!catalog.textVerbosity.includes(settings.textVerbosity)) {
    throw new Error(`Invalid text verbosity '${settings.textVerbosity}'.`);
  }
}

async function runModelConfigScript(config, settings) {
  const root = repoRoot(config);
  const scriptPath = path.resolve(root, "scripts", "SET_IMAGEBOT_MODEL_MODE.ps1");
  if (!isInside(root, scriptPath)) throw new Error("model config script path escaped repository root");
  const stat = await fs.stat(scriptPath);
  if (!stat.isFile()) throw new Error("SET_IMAGEBOT_MODEL_MODE.ps1 is missing");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Mode",
    settings.mode,
    "-Model",
    settings.model,
    "-ReasoningEffort",
    settings.reasoningEffort,
    "-TextVerbosity",
    settings.textVerbosity
  ];
  return await runProcess("powershell", args, { cwd: root, timeoutMs: 180_000 });
}

async function scheduleGatewayRestart(config, delaySeconds = 35) {
  const root = repoRoot(config);
  const scriptPath = path.resolve(root, "RESTART_IMAGEBOT_GATEWAY.ps1");
  if (!isInside(root, scriptPath)) throw new Error("gateway restart script path escaped repository root");
  const stat = await fs.stat(scriptPath);
  if (!stat.isFile()) throw new Error("RESTART_IMAGEBOT_GATEWAY.ps1 is missing");
  const delay = Math.max(10, Math.min(120, Math.trunc(Number(delaySeconds) || 35)));
  const quotedScript = scriptPath.replace(/'/g, "''");
  const command = `Start-Sleep -Seconds ${delay}; & '${quotedScript}' -Fast`;
  const child = spawn("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command
  ], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref();
  return { scheduled: true, delaySeconds: delay };
}

function parseJsonObjectFromText(text) {
  const raw = String(text || "");
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    return null;
  }
}

function splitModelRef(modelRef) {
  const raw = String(modelRef || "").trim();
  const index = raw.indexOf("/");
  if (index <= 0 || index >= raw.length - 1) throw new Error(`invalid model ref '${raw}'`);
  return {
    provider: raw.slice(0, index),
    model: raw.slice(index + 1)
  };
}

function applySessionModelOverrideEntry(entry, settings) {
  const { provider, model } = splitModelRef(settings.model);
  const next = isRecord(entry) ? { ...entry } : {};
  next.providerOverride = provider;
  next.modelOverride = model;
  next.modelOverrideSource = "user";
  next.liveModelSwitchPending = true;
  next.thinkingLevel = settings.reasoningEffort;
  next.updatedAt = Date.now();
  delete next.modelProvider;
  delete next.model;
  delete next.contextTokens;
  delete next.contextBudgetStatus;
  delete next.agentHarnessId;
  delete next.modelOverrideFallbackOriginProvider;
  delete next.modelOverrideFallbackOriginModel;
  delete next.authProfileOverride;
  delete next.authProfileOverrideSource;
  delete next.authProfileOverrideCompactionCount;
  delete next.fallbackNoticeSelectedModel;
  delete next.fallbackNoticeActiveModel;
  delete next.fallbackNoticeReason;
  return { entry: next, provider, model };
}

async function applySessionModelOverride(config, ctx, settings) {
  const sessionKey = String(ctx?.sessionKey || "").trim();
  if (!sessionKey) return { applied: false, reason: "missing_session_key" };
  const filePath = sessionStorePath(config, ctx);
  const store = await readJson(filePath, {});
  const previous = isRecord(store[sessionKey]) ? store[sessionKey] : {};
  const { entry, provider, model } = applySessionModelOverrideEntry(previous, settings);
  store[sessionKey] = entry;
  await writeJsonAtomic(filePath, store);
  return {
    applied: true,
    sessionKey,
    provider,
    model,
    storePathHash: hash(filePath, 12),
    previousModel: previous.model ? `${previous.modelProvider || ""}/${previous.model}`.replace(/^\/+/, "") : "",
    previousOverride: previous.modelOverride ? `${previous.providerOverride || ""}/${previous.modelOverride}`.replace(/^\/+/, "") : ""
  };
}

function scheduleSessionModelOverrideReapply(config, ctx, settings) {
  if (config.disableDelayedSessionModelOverride === true) return [];
  const delays = Array.isArray(config.sessionModelOverrideReapplyMs)
    ? config.sessionModelOverrideReapplyMs
    : [1500, 7000, 20000];
  const scheduled = [];
  for (const rawDelay of delays) {
    const delay = Math.max(250, Math.min(60000, Number(rawDelay) || 0));
    const timer = setTimeout(() => {
      applySessionModelOverride(config, ctx, settings).catch(() => {});
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
    scheduled.push(delay);
  }
  return scheduled;
}

const modelConfigTool = {
  name: MODEL_CONFIG_TOOL,
  label: "Model Config",
  description: "Read or switch the imagebot chat model profile, reasoning effort, and text verbosity from a strict local profile catalog.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["get", "status", "profiles", "list", "plan", "set", "restart"], description: "Use get/status to read, profiles/list to show presets, plan before set/restart, set to write a profile, restart only for provider/plugin/auth refresh." },
      targetAction: { type: "string", enum: ["set", "restart"], description: "For action=plan, choose the operation to approve. Default set." },
      mode: { type: "string", description: "Profile id: fast, balanced, deep, research, ds-fast, ds-pro, ds-flash-off, ds-flash-max, ds-pro-off, ds-pro-max, or custom." },
      profile: { type: "string", description: "Alias for mode." },
      profile_id: { type: "string", description: "Alias for mode." },
      model: { type: "string", description: "Known enabled model id from the profile catalog, e.g. openai/gpt-5.5 or deepseek/deepseek-v4-flash." },
      reasoningEffort: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: "Thinking/reasoning effort. DeepSeek V4 shows off/high/max in Telegram; low/medium are compatibility aliases to high." },
      reasoning: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: "Alias for reasoningEffort." },
      thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: "Alias for reasoningEffort." },
      textVerbosity: { type: "string", enum: ["low", "medium", "high"], description: "Output verbosity." },
      verbosity: { type: "string", enum: ["low", "medium", "high"], description: "Alias for textVerbosity." },
      restartGateway: { type: "boolean", description: "If true with action=set, schedule a delayed gateway restart after applying config." },
      restart: { type: "boolean", description: "Alias for restartGateway." },
      delaySeconds: { type: "number", description: "Delayed restart wait time, clamped to 10-120 seconds." },
      reason: { type: "string", description: "Reason to include in the approval plan." },
      plan_id: { type: "string", description: "Plan id returned by action=plan for set/restart." },
      approval_text: { type: "string", description: "Legacy hint only; approval is read from current trusted runtime message context." }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params, _event, _runtime, ctx) {
    try {
      const config = modelConfigTool.config || {};
      const action = readString(params, "action").toLowerCase();
      const catalog = await loadModelCatalog(config);
      const current = await readCurrentModelConfig(config, catalog);
      if (action === "get" || action === "status") {
        return ok(MODEL_CONFIG_TOOL, [
          `current: ${current.model || "unknown"}`,
          `profile: ${current.profileId || "custom"}`,
          `reasoning: ${current.reasoningEffort || "unknown"}`,
          `verbosity: ${current.textVerbosity || "unknown"}`,
          "config writes are validated; set also pins the current session when a sessionKey is available."
        ], { action: "get", current, profiles: catalog.profiles.map(publicModelProfile), models: catalog.models.map(publicModel) });
      }
      if (action === "profiles" || action === "list") {
        return ok(MODEL_CONFIG_TOOL, [
          "available profiles:",
          ...catalog.profiles.map((profile, index) => `${index + 1}. ${profile.id} | ${profile.model} | reasoning=${profile.reasoningEffort} | verbosity=${profile.textVerbosity}`)
        ], { action: "profiles", current, profiles: catalog.profiles.map(publicModelProfile), models: catalog.models.map(publicModel) });
      }
      if (action === "plan") {
        const plannedAction = (readString(params, "targetAction") || readString(params, "target_action") || "set").toLowerCase();
        if (!["set", "restart"].includes(plannedAction)) throw new Error("targetAction must be set or restart");
        let settings = null;
        const restartGateway = plannedAction === "set" && (readBoolean(params, "restartGateway") || readBoolean(params, "restart"));
        if (plannedAction === "set") {
          const mode = readModelMode(params);
          const profile = mode && mode !== "custom" ? catalog.profiles.find((item) => String(item.id || "").toLowerCase() === mode) : null;
          if (mode && mode !== "custom" && !profile) throw new Error(`unknown model profile '${mode}'`);
          settings = {
            mode: profile ? String(profile.id || mode) : "custom",
            model: readString(params, "model") || String(profile?.model || current.model || ""),
            reasoningEffort: readReasoningEffort(params) || String(profile?.reasoningEffort || current.reasoningEffort || "medium"),
            textVerbosity: readTextVerbosity(params) || String(profile?.textVerbosity || current.textVerbosity || "low")
          };
          validateModelSettings(settings, catalog);
        }
        const plan = await makeModelConfigPlan(config, {
          plannedAction,
          settings,
          restartGateway,
          reason: readString(params, "reason")
        }, ctx);
        return ok(MODEL_CONFIG_TOOL, [
          `planned ${plannedAction}`,
          `plan_id: ${plan.id}`,
          `approval_code: ${plan.approvalCode}`,
          settings ? `model: ${settings.model}` : "",
          settings ? `reasoning: ${settings.reasoningEffort}` : "",
          settings ? `verbosity: ${settings.textVerbosity}` : "",
          restartGateway ? "restartGateway: true" : "",
          "Ask the same user to approve in a later message by repeating the approval code before set/restart."
        ], { action, plan });
      }
      if (action === "restart") {
        const approval = await consumeModelConfigPlan(config, params, { plannedAction: "restart", settings: null, restartGateway: false }, ctx);
        if (!approval.ok) throw new Error(approval.reason);
        const scheduled = await scheduleGatewayRestart(config, readNumber(params, "delaySeconds", 35, 10, 120));
        return ok(MODEL_CONFIG_TOOL, [
          "gateway restart scheduled",
          `delaySeconds: ${scheduled.delaySeconds}`,
          "The bot may be unavailable briefly during restart."
        ], { action: "restart", scheduled });
      }
      if (action !== "set") throw new Error("unknown action");

      const mode = readModelMode(params);
      const profile = mode && mode !== "custom" ? catalog.profiles.find((item) => String(item.id || "").toLowerCase() === mode) : null;
      if (mode && mode !== "custom" && !profile) throw new Error(`unknown model profile '${mode}'`);

      const settings = {
        mode: profile ? String(profile.id || mode) : "custom",
        model: readString(params, "model") || String(profile?.model || current.model || ""),
        reasoningEffort: readReasoningEffort(params) || String(profile?.reasoningEffort || current.reasoningEffort || "medium"),
        textVerbosity: readTextVerbosity(params) || String(profile?.textVerbosity || current.textVerbosity || "low")
      };
      validateModelSettings(settings, catalog);
      const wantsRestart = readBoolean(params, "restartGateway") || readBoolean(params, "restart");
      const approval = await consumeModelConfigPlan(config, params, {
        plannedAction: "set",
        settings,
        restartGateway: wantsRestart
      }, ctx);
      if (!approval.ok) throw new Error(approval.reason);
      const result = await runModelConfigScript(config, settings);
      const parsed = parseJsonObjectFromText(result.stdout);
      let sessionOverride = { applied: false, reason: "config_failed" };
      let sessionOverrideReapplyMs = [];
      if (result.exitCode === 0 && result.timedOut !== true) {
        sessionOverride = await applySessionModelOverride(config, ctx, settings);
        if (sessionOverride.applied) {
          sessionOverrideReapplyMs = scheduleSessionModelOverrideReapply(config, ctx, settings);
        }
      }
      const updated = await readCurrentModelConfig(config, catalog);
      let scheduled = null;
      const status = result.exitCode === 0 && result.timedOut !== true ? "ok" : "failed";
      if (status === "ok" && wantsRestart) {
        scheduled = await scheduleGatewayRestart(config, readNumber(params, "delaySeconds", 35, 10, 120));
      }
      return {
        content: [{
          type: "text",
          text: [
            "MODEL_CONFIG",
            status === "ok" ? "applied" : "failed",
            `model: ${settings.model}`,
            `reasoning: ${settings.reasoningEffort}`,
            `verbosity: ${settings.textVerbosity}`,
            "configWritten: true",
            `sessionOverrideApplied: ${sessionOverride.applied ? "true" : "false"}`,
            sessionOverride.reason ? `sessionOverrideReason: ${sessionOverride.reason}` : "",
            sessionOverride.applied ? "liveSwitchPending: true" : "",
            scheduled ? `restartScheduled: ${scheduled.delaySeconds}s` : "",
            status === "ok" && sessionOverride.applied && !scheduled ? "Current window should use this model on the next clean turn." : "",
            status === "ok" && !sessionOverride.applied && !scheduled ? "Config was written; use a new window or restart if the current session keeps the old model." : "",
            result.stderr ? `stderr:\n${clip(result.stderr, 1200)}` : ""
          ].filter(Boolean).join("\n")
        }],
        details: {
          status,
          action: "set",
          settings,
          current: updated,
          sessionOverride,
          sessionOverrideReapplyMs,
          parsed,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          scheduled
        }
      };
    } catch (error) {
      return fail(MODEL_CONFIG_TOOL, error);
    }
  }
};

function parseFrontMatter(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { meta: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { meta: {}, body: normalized };
  const raw = normalized.slice(4, end).trim();
  const meta = {};
  for (const line of raw.split("\n")) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body: normalized.slice(end + 4).trim() };
}

function splitList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

async function listMarkdownFiles(root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(filePath);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(filePath);
    }
  }
  await walk(root);
  return files.sort();
}

async function loadPromptCards(config) {
  const root = promptLibraryRoot(config);
  if (config.reloadPromptLibrary !== true && promptCardsCache && promptCardsCacheRoot === root) {
    return promptCardsCache;
  }
  const cards = [];
  for (const filePath of await listMarkdownFiles(root)) {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = parseFrontMatter(raw);
    const rel = path.relative(root, filePath).replace(/\\/g, "/");
    const id = String(parsed.meta.id || rel.replace(/\.md$/i, "").replace(/[\\/]/g, ".")).trim();
    cards.push({
      id,
      title: String(parsed.meta.title || id).trim(),
      type: String(parsed.meta.type || "note").trim().toLowerCase(),
      tags: splitList(parsed.meta.tags),
      aliases: splitList(parsed.meta.aliases),
      tools: splitList(parsed.meta.tools),
      file: rel,
      body: parsed.body
    });
  }
  promptCardsCacheRoot = root;
  promptCardsCache = cards;
  return cards;
}

function publicCard(card) {
  return {
    id: card.id,
    title: card.title,
    type: card.type,
    tags: card.tags,
    aliases: card.aliases,
    file: card.file
  };
}

function scoreCard(card, terms) {
  const haystack = [
    card.id,
    card.title,
    card.type,
    card.tags.join(" "),
    card.aliases.join(" "),
    card.body
  ].join("\n");
  return scoreText(haystack, terms);
}

function findCard(cards, id) {
  const q = String(id || "").trim().toLowerCase();
  return cards.find((card) => card.id.toLowerCase() === q || card.id.toLowerCase().endsWith(`.${q}`) || card.aliases.some((alias) => alias.toLowerCase() === q)) || null;
}

function formatCard(card) {
  return [
    `PROMPT_LIBRARY ok id=${card.id}`,
    `title: ${card.title}`,
    `type: ${card.type}`,
    card.tags.length ? `tags: ${card.tags.join(", ")}` : "",
    "",
    clip(card.body, 3000)
  ].filter(Boolean).join("\n");
}

function composePrompt(cards, params) {
  const request = clip(readString(params, "request") || readString(params, "query"), 1200);
  const negative = clip(readString(params, "negative"), 800);
  const lines = [
    "PROMPT_LIBRARY composition",
    request ? `User request: ${request}` : "",
    "",
    "Selected cards:"
  ].filter(Boolean);
  for (const card of cards) {
    lines.push(`\n## ${card.title} (${card.id})\n${clip(card.body, 1600)}`);
  }
  if (negative) lines.push(`\nNegative constraints:\n${negative}`);
  lines.push("\nUse this as a compact drafting aid. Preserve user intent and do not expose card mechanics unless asked.");
  return lines.join("\n");
}

const promptLibraryTool = {
  name: PROMPT_LIBRARY_TOOL,
  label: "Prompt Library",
  description: "Search, list, get, or compose from local image prompt, style, character, and recipe cards.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["list", "search", "get", "compose"], description: "Prompt library operation." },
      query: { type: "string", description: "Search query or request." },
      id: { type: "string", description: "Card id for get." },
      card_ids: { type: "array", items: { type: "string" }, description: "Card ids for compose." },
      type: { type: "string", description: "Optional card type filter, e.g. recipe, style, character, negative." },
      request: { type: "string", description: "User image request for compose." },
      negative: { type: "string", description: "Extra negative constraints for compose." },
      count: { type: "number", description: `Count 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.` }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params) {
    try {
      const config = promptLibraryTool.config || {};
      const action = readString(params, "action").toLowerCase();
      const cards = await loadPromptCards(config);
      if (action === "list") {
        const type = readString(params, "type").toLowerCase();
        const selected = cards.filter((card) => !type || card.type === type).slice(0, readCount(params, 12));
        return ok(PROMPT_LIBRARY_TOOL, [
          `cards=${selected.length}`,
          ...selected.map((card, index) => `${index + 1}. ${card.id} | ${card.type} | ${card.title} | tags=${card.tags.join(",") || "none"}`)
        ], { action, results: selected.map(publicCard) });
      }
      if (action === "search") {
        const query = readString(params, "query");
        if (!query) throw new Error("query is required for search");
        const type = readString(params, "type").toLowerCase();
        const terms = extractTerms(query);
        const selected = cards
          .filter((card) => !type || card.type === type)
          .map((card) => {
            const scored = scoreCard(card, terms);
            return { card, score: scored.score, hits: scored.hits };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, readCount(params, 6));
        return ok(PROMPT_LIBRARY_TOOL, [
          `results=${selected.length}`,
          ...selected.map((entry, index) => `${index + 1}. ${entry.card.id} | ${entry.card.type} | score=${entry.score} | hits=${entry.hits.join("/") || "none"} | ${entry.card.title}`)
        ], { action, results: selected.map((entry) => ({ ...publicCard(entry.card), score: entry.score, hits: entry.hits })) });
      }
      if (action === "get") {
        const card = findCard(cards, readString(params, "id"));
        if (!card) return { content: [{ type: "text", text: "PROMPT_LIBRARY no_match" }], details: { status: "no_match" } };
        return { content: [{ type: "text", text: formatCard(card) }], details: { status: "ok", action, card: publicCard(card) } };
      }
      if (action === "compose") {
        const ids = readArrayStrings(params, "card_ids");
        let selected = ids.map((id) => findCard(cards, id)).filter(Boolean);
        if (!selected.length) {
          const query = readString(params, "query") || readString(params, "request");
          selected = cards.map((card) => {
            const scored = scoreCard(card, extractTerms(query));
            return { card, score: scored.score };
          }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 4).map((entry) => entry.card);
        }
        if (!selected.length) throw new Error("no cards selected");
        const text = composePrompt(selected, params);
        return ok(PROMPT_LIBRARY_TOOL, [text], { action, cards: selected.map(publicCard) });
      }
      throw new Error("unknown action");
    } catch (error) {
      return fail(PROMPT_LIBRARY_TOOL, error);
    }
  }
};

function normalizeRating(value) {
  const rating = String(value || "mixed").trim().toLowerCase();
  if (["good", "bad", "mixed"].includes(rating)) return rating;
  return "mixed";
}

function normalizeTags(values) {
  return values.map((tag) => clip(tag, 40).replace(/\s+/g, "-")).filter(Boolean).slice(0, 12);
}

function feedbackHaystack(record) {
  return [
    record.target,
    record.subject,
    record.prompt,
    record.notes,
    record.keep,
    record.avoid,
    Array.isArray(record.tags) ? record.tags.join(" ") : ""
  ].join("\n");
}

async function loadFeedback(config) {
  return (await readJsonLines(feedbackLogPath(config)))
    .filter((record) => record.type === "image_feedback")
    .sort((a, b) => String(b.t || "").localeCompare(String(a.t || "")));
}

function publicFeedback(record) {
  return {
    id: record.id,
    t: record.t,
    rating: record.rating,
    target: record.target,
    subject: record.subject,
    notes: record.notes,
    keep: record.keep,
    avoid: record.avoid,
    tags: record.tags || []
  };
}

function formatFeedbackLine(record, index = 0) {
  const prefix = index ? `${index}. ` : "";
  return `${prefix}${record.id} | ${record.rating} | ${clip(record.subject || record.target || "image", 90)} | keep=${clip(record.keep, 90)} | avoid=${clip(record.avoid, 90)}`;
}

function relevantFeedback(records, query, count = 3) {
  const terms = extractTerms(query);
  if (!terms.length) return [];
  return records.map((record) => {
    const scored = scoreText(feedbackHaystack(record), terms);
    return { record, score: scored.score, hits: scored.hits };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, count).map((entry) => entry.record);
}

function formatFeedbackPrompt(records) {
  if (!records.length) return "";
  const lines = [
    "[Imagebot image feedback hints]",
    "Use as soft preference memory for image work; do not mention hidden feedback logs."
  ];
  for (const record of records) {
    const parts = [
      record.rating,
      record.subject ? `subject=${clip(record.subject, 80)}` : "",
      record.keep ? `keep=${clip(record.keep, 120)}` : "",
      record.avoid ? `avoid=${clip(record.avoid, 120)}` : "",
      record.notes ? `note=${clip(record.notes, 120)}` : ""
    ].filter(Boolean);
    lines.push(`- ${parts.join(" | ")}`);
  }
  lines.push("[/Imagebot image feedback hints]");
  return lines.join("\n");
}

const imageFeedbackTool = {
  name: IMAGE_FEEDBACK_TOOL,
  label: "Image Feedback",
  description: "Record, search, summarize, and retrieve user feedback about generated images and prompts.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["record", "recent", "search", "summary"], description: "Feedback operation." },
      rating: { type: "string", enum: ["good", "bad", "mixed"], description: "Feedback rating." },
      target: { type: "string", description: "Gallery id, artifact id, task id, or short target label." },
      subject: { type: "string", description: "Character/style/topic this feedback applies to." },
      prompt: { type: "string", description: "Prompt or request associated with the image." },
      notes: { type: "string", description: "Freeform feedback notes." },
      keep: { type: "string", description: "What to keep/reuse next time." },
      avoid: { type: "string", description: "What to avoid next time." },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
      query: { type: "string", description: "Search query." },
      count: { type: "number", description: `Count 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.` }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params) {
    try {
      const config = imageFeedbackTool.config || {};
      const action = readString(params, "action").toLowerCase();
      if (action === "record") {
        const record = {
          type: "image_feedback",
          id: `fb_${hash(`${Date.now()}:${readString(params, "target")}:${readString(params, "notes")}`, 14)}`,
          t: nowIso(),
          rating: normalizeRating(readString(params, "rating")),
          target: clip(readString(params, "target"), 180),
          subject: clip(readString(params, "subject"), 180),
          prompt: clip(readString(params, "prompt"), 1200),
          notes: clip(readString(params, "notes"), 1000),
          keep: clip(readString(params, "keep"), 600),
          avoid: clip(readString(params, "avoid"), 600),
          tags: normalizeTags(readArrayStrings(params, "tags"))
        };
        if (!record.target && !record.subject && !record.notes && !record.keep && !record.avoid) {
          throw new Error("record requires target, subject, notes, keep, or avoid");
        }
        await appendJsonLine(feedbackLogPath(config), record);
        return ok(IMAGE_FEEDBACK_TOOL, ["recorded", formatFeedbackLine(record)], { action, feedback: publicFeedback(record) });
      }
      const records = await loadFeedback(config);
      if (action === "recent") {
        const selected = records.slice(0, readCount(params));
        return ok(IMAGE_FEEDBACK_TOOL, [`results=${selected.length}`, ...selected.map(formatFeedbackLine)], { action, results: selected.map(publicFeedback) });
      }
      if (action === "search") {
        const selected = relevantFeedback(records, readString(params, "query"), readCount(params));
        return ok(IMAGE_FEEDBACK_TOOL, [`results=${selected.length}`, ...selected.map(formatFeedbackLine)], { action, results: selected.map(publicFeedback) });
      }
      if (action === "summary") {
        const totals = { good: 0, bad: 0, mixed: 0 };
        const keep = new Map();
        const avoid = new Map();
        for (const record of records) {
          totals[record.rating] = (totals[record.rating] || 0) + 1;
          for (const term of extractTerms(record.keep).slice(0, 6)) keep.set(term, (keep.get(term) || 0) + 1);
          for (const term of extractTerms(record.avoid).slice(0, 6)) avoid.set(term, (avoid.get(term) || 0) + 1);
        }
        const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([term, count]) => `${term}:${count}`).join(", ") || "none";
        return ok(IMAGE_FEEDBACK_TOOL, [
          `records=${records.length}`,
          `ratings good=${totals.good || 0} mixed=${totals.mixed || 0} bad=${totals.bad || 0}`,
          `common keep: ${top(keep)}`,
          `common avoid: ${top(avoid)}`
        ], { action, totals });
      }
      throw new Error("unknown action");
    } catch (error) {
      return fail(IMAGE_FEEDBACK_TOOL, error);
    }
  }
};

function promptLooksImageRelated(prompt) {
  return /(draw|image|picture|photo|illustration|generate|edit|wallpaper|character|style|prompt|生图|画|图片|图像|插画|角色|壁纸|提示词)/i.test(String(prompt || ""));
}

export const __testing = {
  SCRIPT_REGISTRY,
  extractTerms,
  routeScripts,
  loadModelCatalog,
  loadCommandCatalog,
  readCurrentModelConfig,
  validateModelSettings,
  routeCommands,
  parseFrontMatter,
  loadPromptCards,
  composePrompt,
  relevantFeedback,
  splitModelRef,
  applySessionModelOverrideEntry,
  applySessionModelOverride,
  sanitizeText,
  findScript,
  needsApproval,
  isMutatingScript
};

export default {
  id: "imagebot-creative-ops",
  name: "Imagebot Creative Ops",
  description: "Bounded script registry, prompt library, and image feedback learning.",
  register(api) {
    const config = api.config || {};
    scriptActionTool.config = config;
    promptLibraryTool.config = config;
    imageFeedbackTool.config = config;
    modelConfigTool.config = config;
    commandCatalogTool.config = config;
    api.registerTool(scriptActionTool, { name: SCRIPT_ACTION_TOOL });
    api.registerTool(promptLibraryTool, { name: PROMPT_LIBRARY_TOOL });
    api.registerTool(imageFeedbackTool, { name: IMAGE_FEEDBACK_TOOL });
    api.registerTool(modelConfigTool, { name: MODEL_CONFIG_TOOL });
    api.registerTool(commandCatalogTool, { name: COMMAND_CATALOG_TOOL });

    registerLifecycleHook(api, "before_prompt_build", async (event, ctx) => {
      if (ctx?.agentId && ctx.agentId !== "imagebot") return;
      if (config.appendFeedbackHints === false) return;
      const prompt = String(event?.prompt || "");
      if (!promptLooksImageRelated(prompt)) return;
      const records = await loadFeedback(config);
      const hints = relevantFeedback(records, prompt, 3);
      const appendContext = formatFeedbackPrompt(hints);
      return appendContext ? { appendContext } : undefined;
    }, { name: "imagebot-creative-ops-before-prompt-build" });
  }
};

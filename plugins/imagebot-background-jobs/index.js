import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  mutationActorKey,
  mutationScopeKey,
  trustedMutationContext
} from "../imagebot-shared/mutation-authorization.mjs";
import { registerLifecycleHook } from "../imagebot-shared/openclaw-lifecycle-hooks.mjs";

const TOOL_NAME = "background_job";
const DEFAULT_MAX_CONCURRENT = 3;
const MAX_MAX_CONCURRENT = 8;
const DEFAULT_COUNT = 8;
const MAX_COUNT = 30;
const MAX_LOG_READ_BYTES = 4 * 1024 * 1024;
const FINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const OPEN_STATES = new Set(["queued", "active", "retrying"]);

const managers = new Map();

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function storeRoot(config = {}) {
  const configured = String(config.storeDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "background-jobs"));
}

function eventsPath(config = {}) {
  return path.join(storeRoot(config), "jobs.jsonl");
}

function nowIso() {
  return new Date().toISOString();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash(value, len = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function clip(value, max = 600) {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
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

function readCount(params, fallback = DEFAULT_COUNT) {
  const raw = isRecord(params) ? params.count : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_COUNT, Math.trunc(value)));
}

function readNumber(value, fallback, min, max) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
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
  if (stat.size <= maxBytes) return fs.readFile(filePath, "utf8");
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
      const parsed = JSON.parse(line);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // Append-only store: ignore malformed tail fragments.
    }
  }
  return records;
}

function summarizePayload(payload) {
  if (!isRecord(payload)) return clip(payload, 240);
  const summary = {};
  for (const [key, value] of Object.entries(payload).slice(0, 12)) {
    if (typeof value === "string") summary[key] = clip(value, 160);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) summary[key] = value;
    else if (Array.isArray(value)) summary[key] = `[array:${value.length}]`;
    else if (isRecord(value)) summary[key] = "[object]";
  }
  return summary;
}

function summarizeResult(result) {
  if (result === undefined) return null;
  if (typeof result === "string") return clip(result, 1000);
  if (typeof result === "number" || typeof result === "boolean" || result === null) return result;
  if (Array.isArray(result)) return { type: "array", length: result.length };
  if (!isRecord(result)) return clip(result, 1000);
  const summary = {};
  for (const [key, value] of Object.entries(result).slice(0, 16)) {
    if (typeof value === "string") summary[key] = clip(value, 500);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) summary[key] = value;
    else if (Array.isArray(value)) {
      const primitive = value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null);
      summary[key] = primitive ? value.slice(0, 12).map((item) => typeof item === "string" ? clip(item, 240) : item) : `[array:${value.length}]`;
    }
    else if (isRecord(value)) summary[key] = "[object]";
  }
  return summary;
}

function normalizeContext(context) {
  if (!isRecord(context)) return {};
  const trusted = trustedMutationContext(context);
  const out = {};
  for (const key of ["agentId", "accountId", "channel", "chatId", "threadId", "sessionKey", "windowId", "senderId", "messageId"]) {
    if (trusted[key] !== undefined && trusted[key] !== null && String(trusted[key]).trim()) out[key] = String(trusted[key]);
  }
  for (const key of ["messageThreadId", "replyToMessageId"]) {
    if (context[key] !== undefined && context[key] !== null && String(context[key]).trim()) out[key] = String(context[key]);
  }
  if (out.chatId || out.sessionKey || out.windowId) out.scopeKey = mutationScopeKey(trusted);
  if (out.scopeKey && out.senderId) out.actorKey = mutationActorKey(trusted);
  return out;
}

function contextFilterFrom(ctx = {}, params = {}, config = {}) {
  const scopeMode = readString(params, "scope").toLowerCase();
  const includeAll = readBoolean(params, "includeAll", false) || scopeMode === "all";
  if (includeAll && config.allowCrossScopeBackgroundJobs === true) return {};
  const context = normalizeContext(ctx);
  if (context.scopeKey) return { scopeKey: context.scopeKey };
  if (context.sessionKey) return { sessionKey: context.sessionKey };
  if (context.chatId) return { chatId: context.chatId };
  return {};
}

function jobMatchesFilter(job, filter = {}) {
  if (!job) return false;
  const context = job.context || {};
  if (filter.scopeKey && context.scopeKey !== filter.scopeKey) return false;
  if (filter.actorKey && context.actorKey !== filter.actorKey) return false;
  if (filter.sessionKey && context.sessionKey !== filter.sessionKey) return false;
  if (filter.chatId && context.chatId !== filter.chatId) return false;
  return true;
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt || "",
    finishedAt: job.finishedAt || "",
    attempt: job.attempt,
    attempts: job.attempts,
    progress: job.progress || null,
    context: job.context || {},
    dedupeKey: job.dedupeKey || "",
    payloadSummary: job.payloadSummary,
    result: job.result ?? null,
    error: job.error || ""
  };
}

function formatJobLine(job, index = 0) {
  const prefix = index ? `${index}. ` : "";
  const progress = job.progress?.note ? ` | ${clip(job.progress.note, 90)}` : "";
  const percent = typeof job.progress?.percent === "number" ? ` ${job.progress.percent}%` : "";
  return `${prefix}${job.id} | ${job.kind} | ${job.state}${percent} | ${clip(job.label || "", 80)}${progress}`;
}

function formatJobDetails(job) {
  const lines = [formatJobLine(job)];
  if (job.error) lines.push(`error: ${job.error}`);
  if (job.result !== undefined && job.result !== null) {
    const resultText = typeof job.result === "string" ? job.result : JSON.stringify(job.result, null, 2);
    lines.push("result:", clip(resultText, 2500));
  }
  return lines.join("\n");
}

function summarizeJobs(jobs, { staleMs = 5 * 60_000 } = {}) {
  const counts = {};
  const now = Date.now();
  const stale = [];
  for (const job of jobs) {
    counts[job.state || "unknown"] = Number(counts[job.state || "unknown"] || 0) + 1;
    const updated = Date.parse(job.updatedAt || job.startedAt || job.createdAt || "");
    if (OPEN_STATES.has(job.state) && Number.isFinite(updated) && now - updated > staleMs) stale.push(job);
  }
  return {
    total: jobs.length,
    open: jobs.filter((job) => OPEN_STATES.has(job.state)).length,
    counts,
    stale: stale.slice(0, 8),
    latest: jobs.slice(0, 8)
  };
}

function formatJobSummary(summary) {
  const countText = Object.entries(summary.counts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const lines = [
    `BACKGROUND_JOB summary total=${summary.total} open=${summary.open}${countText ? ` ${countText}` : ""}`
  ];
  if (summary.stale.length) {
    lines.push("stale:");
    for (const job of summary.stale) lines.push(`- ${formatJobLine(job)}`);
  }
  if (summary.latest.length) {
    lines.push("latest:");
    for (const [index, job] of summary.latest.entries()) lines.push(`- ${formatJobLine(job, index + 1)}`);
  }
  return lines.join("\n");
}

async function recentJobStates(config, count = DEFAULT_COUNT) {
  const events = await readJsonLines(eventsPath(config));
  const byId = new Map();
  for (const event of events) {
    const jobId = String(event.jobId || event.job?.id || "").trim();
    if (!jobId) continue;
    const previous = byId.get(jobId) || {};
    byId.set(jobId, {
      ...previous,
      ...(isRecord(event.job) ? event.job : {}),
      state: event.state || event.job?.state || previous.state,
      updatedAt: event.t || event.job?.updatedAt || previous.updatedAt
    });
  }
  return [...byId.values()]
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, count);
}

class BackgroundJobManager {
  constructor(config = {}) {
    this.config = {
      ...config,
      maxConcurrent: readNumber(config.maxConcurrent, DEFAULT_MAX_CONCURRENT, 1, MAX_MAX_CONCURRENT)
    };
    this.handlers = new Map();
    this.jobs = new Map();
    this.queue = [];
    this.active = new Map();
    this.dedupe = new Map();
    this.waiters = new Map();
    this.pumpScheduled = false;
  }

  registerHandler(kind, handler) {
    const id = String(kind || "").trim();
    if (!id) throw new Error("background job kind is required");
    if (typeof handler !== "function") throw new Error("background job handler must be a function");
    this.handlers.set(id, handler);
    return this;
  }

  async enqueue(input = {}) {
    const kind = String(input.kind || "").trim();
    const handler = input.handler || this.handlers.get(kind);
    if (!kind) throw new Error("background job kind is required");
    if (typeof handler !== "function") throw new Error(`no background job handler registered for ${kind}`);
    const context = normalizeContext(input.context);
    const rawDedupeKey = String(input.dedupeKey || "").trim();
    const dedupeKey = rawDedupeKey ? `${context.scopeKey || "legacy"}:${rawDedupeKey}` : "";
    if (dedupeKey) {
      const existingId = this.dedupe.get(dedupeKey);
      const existing = existingId ? this.jobs.get(existingId) : null;
      if (existing && !FINAL_STATES.has(existing.state)) {
        return { job: publicJob(existing), deduped: true };
      }
    }
    const now = nowIso();
    const job = {
      id: `bg_${crypto.randomBytes(7).toString("hex")}`,
      kind,
      label: clip(input.label || kind, 160),
      state: "queued",
      createdAt: now,
      updatedAt: now,
      queuedAt: now,
      startedAt: "",
      finishedAt: "",
      attempt: 0,
      attempts: readNumber(input.attempts, 1, 1, 5),
      backoffMs: readNumber(input.backoffMs, 1000, 0, 60_000),
      timeoutMs: readNumber(input.timeoutMs, 0, 0, 30 * 60_000),
      progress: { percent: 0, note: "queued", updatedAt: now },
      context,
      payload: input.payload,
      payloadSummary: summarizePayload(input.payload),
      dedupeKey,
      handler
    };
    this.jobs.set(job.id, job);
    if (dedupeKey) this.dedupe.set(dedupeKey, job.id);
    this.queue.push(job);
    await this.record("queued", job);
    this.schedulePump();
    return { job: publicJob(job), deduped: false };
  }

  schedulePump() {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  async pump() {
    while (this.active.size < this.config.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      if (!job || job.state === "cancelled") continue;
      void this.runJob(job);
    }
  }

  async runJob(job) {
    const controller = new AbortController();
    this.active.set(job.id, controller);
    job.state = "active";
    job.attempt += 1;
    job.startedAt = job.startedAt || nowIso();
    job.updatedAt = nowIso();
    job.progress = { percent: 1, note: "started", updatedAt: job.updatedAt };
    await this.record("active", job);
    let timeout = null;
    if (job.timeoutMs > 0) {
      timeout = setTimeout(() => controller.abort(new Error("background job timed out")), job.timeoutMs);
    }
    const progress = async (update = {}) => {
      if (FINAL_STATES.has(job.state)) return;
      job.progress = {
        percent: typeof update.percent === "number" ? Math.max(0, Math.min(100, Math.trunc(update.percent))) : job.progress?.percent,
        note: update.note !== undefined ? clip(update.note, 240) : job.progress?.note,
        updatedAt: nowIso()
      };
      job.updatedAt = job.progress.updatedAt;
      await this.record("progress", job);
    };
    try {
      const result = await job.handler({
        job: publicJob(job),
        payload: job.payload,
        context: job.context,
        signal: controller.signal,
        progress
      });
      if (job.state === "cancelled" || controller.signal.aborted) {
        throw new Error("background job cancelled");
      }
      job.state = "completed";
      job.finishedAt = nowIso();
      job.updatedAt = job.finishedAt;
      job.progress = { percent: 100, note: "completed", updatedAt: job.finishedAt };
      job.result = summarizeResult(result);
      await this.record("completed", job);
      this.finalize(job);
    } catch (error) {
      const cancelled = controller.signal.aborted || job.state === "cancelled";
      if (!cancelled && job.attempt < job.attempts) {
        job.state = "retrying";
        job.updatedAt = nowIso();
        job.error = clip(error instanceof Error ? error.message : String(error), 500);
        job.progress = { percent: job.progress?.percent || 0, note: `retrying: ${job.error}`, updatedAt: job.updatedAt };
        await this.record("retrying", job);
        this.active.delete(job.id);
        if (timeout) clearTimeout(timeout);
        setTimeout(() => {
          job.state = "queued";
          job.queuedAt = nowIso();
          this.queue.push(job);
          this.schedulePump();
        }, job.backoffMs);
        return;
      }
      job.state = cancelled ? "cancelled" : "failed";
      job.finishedAt = nowIso();
      job.updatedAt = job.finishedAt;
      job.error = clip(error instanceof Error ? error.message : String(error), 500);
      job.progress = { percent: job.progress?.percent || 0, note: job.state, updatedAt: job.finishedAt };
      await this.record(job.state, job);
      this.finalize(job);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.active.get(job.id) === controller) this.active.delete(job.id);
      this.schedulePump();
    }
  }

  async record(state, job) {
    await appendJsonLine(eventsPath(this.config), {
      type: "background_job",
      event: state,
      state,
      t: nowIso(),
      jobId: job.id,
      job: publicJob(job)
    });
  }

  finalize(job) {
    if (job.dedupeKey && this.dedupe.get(job.dedupeKey) === job.id) this.dedupe.delete(job.dedupeKey);
    const waiters = this.waiters.get(job.id) || [];
    this.waiters.delete(job.id);
    for (const waiter of waiters) waiter.resolve(publicJob(job));
  }

  async cancel(id, filter = {}) {
    const jobId = String(id || "").trim();
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, reason: "not_found" };
    if (!jobMatchesFilter(publicJob(job), filter)) return { ok: false, reason: "not_found" };
    if (FINAL_STATES.has(job.state)) return { ok: true, job: publicJob(job), alreadyFinal: true };
    const queuedIndex = this.queue.findIndex((item) => item.id === jobId);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    job.state = "cancelled";
    job.finishedAt = nowIso();
    job.updatedAt = job.finishedAt;
    job.progress = { percent: job.progress?.percent || 0, note: "cancelled", updatedAt: job.finishedAt };
    const controller = this.active.get(jobId);
    if (controller) controller.abort(new Error("background job cancelled"));
    await this.record("cancelled", job);
    this.finalize(job);
    return { ok: true, job: publicJob(job) };
  }

  get(id, filter = {}) {
    const job = publicJob(this.jobs.get(String(id || "").trim()));
    return jobMatchesFilter(job, filter) ? job : null;
  }

  listRuntime(filter = {}) {
    const state = String(filter.state || "").trim().toLowerCase();
    const sessionKey = String(filter.sessionKey || "").trim();
    const chatId = String(filter.chatId || "").trim();
    const scopeKey = String(filter.scopeKey || "").trim();
    const actorKey = String(filter.actorKey || "").trim();
    const count = readNumber(filter.count, DEFAULT_COUNT, 1, MAX_COUNT);
    return [...this.jobs.values()]
      .map(publicJob)
      .filter((job) => {
        if (state === "open" && !OPEN_STATES.has(job.state)) return false;
        if (state && state !== "open" && job.state !== state) return false;
        if (scopeKey && job.context?.scopeKey !== scopeKey) return false;
        if (actorKey && job.context?.actorKey !== actorKey) return false;
        if (sessionKey && job.context?.sessionKey !== sessionKey) return false;
        if (chatId && job.context?.chatId !== chatId) return false;
        return true;
      })
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, count);
  }

  async list(filter = {}) {
    const count = readNumber(filter.count, DEFAULT_COUNT, 1, MAX_COUNT);
    const runtime = this.listRuntime({ ...filter, count });
    if (runtime.length >= count || filter.runtimeOnly === true) return runtime.slice(0, count);
    const seen = new Set(runtime.map((job) => job.id));
    const recent = (await recentJobStates(this.config, count * 3)).filter((job) => !seen.has(job.id) && jobMatchesFilter(job, filter));
    return [...runtime, ...recent].slice(0, count);
  }

  waitForJob(id, timeoutMs = 30_000) {
    const jobId = String(id || "").trim();
    const existing = this.jobs.get(jobId);
    if (existing && FINAL_STATES.has(existing.state)) return Promise.resolve(publicJob(existing));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = (this.waiters.get(jobId) || []).filter((item) => item.resolve !== wrappedResolve);
        if (waiters.length) this.waiters.set(jobId, waiters);
        else this.waiters.delete(jobId);
        reject(new Error(`timed out waiting for ${jobId}`));
      }, timeoutMs);
      const wrappedResolve = (job) => {
        clearTimeout(timer);
        resolve(job);
      };
      const waiters = this.waiters.get(jobId) || [];
      waiters.push({ resolve: wrappedResolve });
      this.waiters.set(jobId, waiters);
    });
  }
}

export function createBackgroundJobManager(config = {}) {
  return new BackgroundJobManager(config);
}

export function getBackgroundJobManager(config = {}) {
  const root = storeRoot(config);
  const key = `${root}:${readNumber(config.maxConcurrent, DEFAULT_MAX_CONCURRENT, 1, MAX_MAX_CONCURRENT)}`;
  if (!managers.has(key)) managers.set(key, createBackgroundJobManager(config));
  return managers.get(key);
}

export function backgroundJobsConfig(config = {}) {
  const configured = isRecord(config.backgroundJobs) ? config.backgroundJobs : {};
  return {
    storeDir: configured.storeDir || config.backgroundJobStoreDir || path.join(homeDir(), ".openclaw", "background-jobs"),
    maxConcurrent: readNumber(configured.maxConcurrent ?? config.backgroundJobMaxConcurrent, DEFAULT_MAX_CONCURRENT, 1, MAX_MAX_CONCURRENT),
    appendActiveContext: configured.appendActiveContext !== false
  };
}

export function shouldRunInBackground(params = {}) {
  return readBoolean(params, "background", false) || readBoolean(params, "async", false);
}

export function toolContext(ctx) {
  return normalizeContext(ctx);
}

export function backgroundToolParameters(extra = {}) {
  return {
    background: {
      type: "boolean",
      description: "Queue this long-running operation as a background job and return job_id quickly. Default false."
    },
    async: {
      type: "boolean",
      description: "Alias for background."
    },
    dedupe_key: {
      type: "string",
      description: "Optional duplicate key. Reusing it while a job is open returns the existing job."
    },
    ...extra
  };
}

export async function enqueueBackgroundTool({
  toolName,
  config = {},
  params = {},
  ctx,
  kind,
  label,
  payload,
  dedupeKey,
  timeoutMs,
  attempts,
  backoffMs,
  handler
}) {
  const manager = getBackgroundJobManager(backgroundJobsConfig(config));
  const requestKey = dedupeKey || readString(params, "dedupe_key") || readString(params, "dedupeKey") ||
    `${toolName}:${hash(JSON.stringify(payload ?? params), 20)}`;
  const started = await manager.enqueue({
    kind: kind || toolName,
    label: label || toolName,
    payload: payload ?? params,
    context: toolContext(ctx),
    dedupeKey: requestKey,
    timeoutMs,
    attempts,
    backoffMs,
    handler
  });
  return {
    content: [{
      type: "text",
      text: [
        `${String(toolName || "BACKGROUND").toUpperCase()} background ${started.deduped ? "existing" : "queued"}`,
        `job_id: ${started.job.id}`,
        `state: ${started.job.state}`,
        "Use background_job action=get/summary/list/cancel for status. The chat can continue while this runs."
      ].join("\n")
    }],
    details: {
      status: "ok",
      background: true,
      deduped: started.deduped,
      job: started.job
    }
  };
}

const backgroundJobTool = {
  name: TOOL_NAME,
  label: "Background Job",
  description: "Inspect or cancel bot-owned background jobs started by long-running tools. It cannot run arbitrary jobs by itself.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["summary", "list", "recent", "get", "cancel"], description: "Background job operation." },
      job_id: { type: "string", description: "Background job id for get/cancel." },
      state: { type: "string", enum: ["open", "queued", "active", "retrying", "completed", "failed", "cancelled"], description: "Optional list filter." },
      count: { type: "number", description: `Count 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.` }
    },
    required: ["action"]
  },
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const config = backgroundJobTool.config || {};
      const manager = backgroundJobTool.manager || getBackgroundJobManager(config);
      const action = readString(params, "action").toLowerCase();
      const contextFilter = contextFilterFrom(ctx, params, config);
      if (action === "summary") {
        const jobs = await manager.list({
          ...contextFilter,
          state: readString(params, "state", ""),
          count: readCount(params, MAX_COUNT)
        });
        const summary = summarizeJobs(jobs);
        return {
          content: [{ type: "text", text: formatJobSummary(summary) }],
          details: { status: "ok", action, summary }
        };
      }
      if (action === "list" || action === "recent") {
        const jobs = await manager.list({
          ...contextFilter,
          state: readString(params, "state", action === "list" ? "open" : ""),
          count: readCount(params)
        });
        return {
          content: [{
            type: "text",
            text: [
              `BACKGROUND_JOB ${action} results=${jobs.length}`,
              ...jobs.map((job, index) => formatJobLine(job, index + 1))
            ].join("\n")
          }],
          details: { status: "ok", action, jobs }
        };
      }
      if (action === "get") {
        const job = manager.get(readString(params, "job_id"), contextFilter);
        if (!job) return { content: [{ type: "text", text: "BACKGROUND_JOB not_found" }], details: { status: "not_found" } };
        return { content: [{ type: "text", text: `BACKGROUND_JOB get\n${formatJobDetails(job)}` }], details: { status: "ok", action, job } };
      }
      if (action === "cancel") {
        const result = await manager.cancel(readString(params, "job_id"), contextFilter);
        if (!result.ok) return { content: [{ type: "text", text: `BACKGROUND_JOB cancel ${result.reason}` }], details: { status: result.reason } };
        return { content: [{ type: "text", text: `BACKGROUND_JOB cancel ok\n${formatJobLine(result.job)}` }], details: { status: "ok", action, job: result.job } };
      }
      throw new Error("unknown action");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `BACKGROUND_JOB error: ${clip(message, 500)}` }], details: { status: "failed", error: message } };
    }
  }
};

function formatActiveContext(jobs) {
  if (!jobs.length) return "";
  return [
    "[Background jobs]",
    "Long-running work already accepted by the bot:",
    ...jobs.map((job) => `- ${formatJobLine(job)}`),
    "[/Background jobs]"
  ].join("\n");
}

export const __testing = {
  createBackgroundJobManager,
  getBackgroundJobManager,
  recentJobStates,
  publicJob,
  formatJobLine,
  formatJobDetails,
  summarizeJobs,
  formatJobSummary,
  storeRoot,
  eventsPath
};

export default {
  id: "imagebot-background-jobs",
  name: "Imagebot Background Jobs",
  description: "Shared queue and status tool for long-running imagebot work.",
  register(api) {
    const config = api.config || {};
    const manager = getBackgroundJobManager(config);
    backgroundJobTool.config = config;
    backgroundJobTool.manager = manager;
    api.registerTool(backgroundJobTool, { name: TOOL_NAME });
    registerLifecycleHook(api, "before_prompt_build", async (_event, ctx) => {
      if (ctx?.agentId && ctx.agentId !== "imagebot") return;
      if (config.appendActiveContext === false) return;
      const jobs = manager.listRuntime({
        ...contextFilterFrom(ctx, {}, config),
        state: "open",
        count: 5
      });
      const appendContext = formatActiveContext(jobs);
      return appendContext ? { appendContext } : undefined;
    }, { name: "imagebot-background-jobs-before-prompt-build" });
  }
};

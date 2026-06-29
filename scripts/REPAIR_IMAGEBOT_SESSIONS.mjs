import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_AGENT = "imagebot";
const DEFAULT_VISIBLE_RESULTS = 6;
const DEFAULT_DETAIL_RESULTS = 12;
const DEFAULT_LOCK_STALE_SECONDS = 900;
const REPAIR_TEXT = "[assistant turn interrupted after a provider overload; continue from the visible conversation and tool results if relevant.]";

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function defaultSessionsDir(agent = DEFAULT_AGENT) {
  return path.join(homeDir(), ".openclaw", "agents", agent, "sessions");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n");
}

function setTextContent(message, text) {
  return {
    ...message,
    content: [{ type: "text", text }]
  };
}

function isObjectObjectUser(message) {
  return message?.role === "user" && textFromContent(message.content).trim() === "[object Object]";
}

function isProviderOverloadError(message) {
  if (message?.role !== "assistant" || message.stopReason !== "error") return false;
  const code = String(message.errorCode || "").toLowerCase();
  const text = `${message.errorMessage || ""} ${message.errorBody || ""}`.toLowerCase();
  return code === "server_is_overloaded" || text.includes("server_is_overloaded") || text.includes("servers are currently overloaded");
}

function compactImageResult(result = {}) {
  return {
    title: String(result.title || ""),
    imageUrl: String(result.imageUrl || ""),
    sourceUrl: String(result.sourceUrl || ""),
    source: String(result.source || ""),
    width: Number.isFinite(Number(result.width)) ? Number(result.width) : undefined,
    height: Number.isFinite(Number(result.height)) ? Number(result.height) : undefined,
    format: String(result.format || "")
  };
}

function formatCompactWebImageSearch(query, results, visibleLimit = DEFAULT_VISIBLE_RESULTS) {
  if (!results.length) return `WEB_IMAGE_SEARCH results for "${query}": no usable public image candidates found.`;
  const visible = results.slice(0, visibleLimit);
  const lines = [`WEB_IMAGE_SEARCH results for "${query}":`];
  visible.forEach((result, index) => {
    const size = result.width && result.height ? `${result.width}x${result.height}` : "unknown size";
    lines.push(
      `${index + 1}. ${result.title || "(untitled)"}`,
      `   imageUrl: ${result.imageUrl}`,
      `   sourceUrl: ${result.sourceUrl || ""}`,
      `   source: ${result.source || ""}`,
      `   size: ${size}`,
      `   format: ${result.format || ""}`
    );
  });
  if (results.length > visible.length) {
    lines.push(`Showing ${visible.length} of ${results.length} candidates. Use a focused query if the visible set is not enough.`);
  }
  lines.push(
    "This repaired compact result keeps candidate URLs only; current web_image_search may also provide localMedia previews in live turns.",
    "Use returned localMedia paths when present; otherwise call download_image_url(s) for useful candidates before generation references or found-image attachments."
  );
  return lines.join("\n");
}

function repairToolResult(message, options = {}) {
  if (message?.role !== "toolResult" || message.toolName !== "web_image_search") {
    return { message, changed: false, compactedToolResults: 0 };
  }
  const contentText = textFromContent(message.content);
  if (!contentText.includes("WEB_IMAGE_SEARCH results")) {
    return { message, changed: false, compactedToolResults: 0 };
  }

  const details = isRecord(message.details) ? message.details : {};
  const rawResults = Array.isArray(details.results) ? details.results : [];
  if (!rawResults.length) {
    return { message, changed: false, compactedToolResults: 0 };
  }

  const maxChars = Number.isFinite(Number(options.maxToolResultChars)) ? Number(options.maxToolResultChars) : 2600;
  const hasThumbnails = contentText.includes("thumbnailUrl:");
  if (contentText.length <= maxChars && !hasThumbnails) {
    return { message, changed: false, compactedToolResults: 0 };
  }

  const visibleLimit = Number.isFinite(Number(options.visibleResults)) ? Number(options.visibleResults) : DEFAULT_VISIBLE_RESULTS;
  const detailLimit = Number.isFinite(Number(options.detailResults)) ? Number(options.detailResults) : DEFAULT_DETAIL_RESULTS;
  const results = rawResults.map(compactImageResult).filter((item) => item.imageUrl);
  const query = String(details.query || "").trim() || "image search";
  const next = setTextContent(message, formatCompactWebImageSearch(query, results, visibleLimit));
  const existingOriginalCount = Number(details.originalResultCount);
  const originalResultCount = Number.isFinite(existingOriginalCount)
    ? Math.max(existingOriginalCount, rawResults.length)
    : rawResults.length;
  next.details = {
    ...details,
    results: results.slice(0, detailLimit),
    persistedDetailsCompacted: true,
    originalResultCount
  };
  const unchanged = JSON.stringify(message.content) === JSON.stringify(next.content)
    && JSON.stringify(message.details || {}) === JSON.stringify(next.details || {});
  if (unchanged) {
    return { message, changed: false, compactedToolResults: 0 };
  }
  return { message: next, changed: true, compactedToolResults: 1 };
}

function repairMessage(record, options = {}) {
  if (!record || record.type !== "message" || !isRecord(record.message)) {
    return { record, changed: false, removed: false, normalizedErrors: 0, compactedToolResults: 0 };
  }
  const message = record.message;
  if (options.dropObjectObjectUser !== false && isObjectObjectUser(message)) {
    return { record, changed: true, removed: true, normalizedErrors: 0, compactedToolResults: 0 };
  }
  if (isProviderOverloadError(message)) {
    const nextMessage = setTextContent({
      role: "assistant",
      timestamp: message.timestamp,
      stopReason: "stop"
    }, REPAIR_TEXT);
    return {
      record: { ...record, message: nextMessage },
      changed: true,
      removed: false,
      normalizedErrors: 1,
      compactedToolResults: 0
    };
  }
  const toolRepair = repairToolResult(message, options);
  if (toolRepair.changed) {
    return {
      record: { ...record, message: toolRepair.message },
      changed: true,
      removed: false,
      normalizedErrors: 0,
      compactedToolResults: toolRepair.compactedToolResults
    };
  }
  return { record, changed: false, removed: false, normalizedErrors: 0, compactedToolResults: 0 };
}

async function hasFreshLock(filePath, lockStaleSeconds = DEFAULT_LOCK_STALE_SECONDS) {
  const lockPath = `${filePath}.lock`;
  try {
    const stat = await fs.stat(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs < Math.max(1, lockStaleSeconds) * 1000;
  } catch {
    return false;
  }
}

async function writeBackup(filePath, text) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak-${stamp}`;
  await fs.writeFile(backupPath, text, "utf8");
  return backupPath;
}

export async function repairSessionFile(filePath, options = {}) {
  const lockStaleSeconds = Number.isFinite(Number(options.lockStaleSeconds)) ? Number(options.lockStaleSeconds) : DEFAULT_LOCK_STALE_SECONDS;
  if (!options.ignoreLocks && await hasFreshLock(filePath, lockStaleSeconds)) {
    return { filePath, skipped: true, reason: "active-lock", changed: false, normalizedErrors: 0, compactedToolResults: 0, removedMessages: 0 };
  }

  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    return { filePath, skipped: true, reason: error?.code || "read-failed", changed: false, normalizedErrors: 0, compactedToolResults: 0, removedMessages: 0 };
  }

  let changed = false;
  let normalizedErrors = 0;
  let compactedToolResults = 0;
  let removedMessages = 0;
  const output = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      output.push(line);
      continue;
    }
    const repaired = repairMessage(record, options);
    if (repaired.changed) changed = true;
    if (repaired.removed) {
      removedMessages += 1;
      continue;
    }
    normalizedErrors += repaired.normalizedErrors;
    compactedToolResults += repaired.compactedToolResults;
    output.push(JSON.stringify(repaired.record));
  }

  let backupPath = "";
  if (changed && !options.dryRun) {
    backupPath = await writeBackup(filePath, text);
    await fs.writeFile(filePath, `${output.join("\n")}\n`, "utf8");
  }

  return { filePath, changed, dryRun: options.dryRun === true, backupPath, normalizedErrors, compactedToolResults, removedMessages };
}

async function listSessionFiles(sessionsDir, options = {}) {
  if (options.sessionId) return [path.join(sessionsDir, `${options.sessionId}.jsonl`)];
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(sessionsDir, entry.name));
}

async function updateSessionIndex(sessionsDir, fileResults, options = {}) {
  if (options.dryRun) return { changed: false };
  const changedFiles = new Set(fileResults.filter((item) => item.changed && !item.skipped).map((item) => path.resolve(item.filePath).toLowerCase()));
  if (!changedFiles.size) return { changed: false };
  const indexPath = path.join(sessionsDir, "sessions.json");
  let index = {};
  try {
    index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  } catch {
    return { changed: false, reason: "missing-index" };
  }
  let changed = false;
  for (const entry of Object.values(index)) {
    if (!isRecord(entry)) continue;
    const sessionFile = String(entry.sessionFile || "").trim();
    if (!sessionFile || !changedFiles.has(path.resolve(sessionFile).toLowerCase())) continue;
    if (entry.status === "failed") {
      entry.status = "done";
      entry.repairedAt = Date.now();
      changed = true;
    }
  }
  if (changed) {
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }
  return { changed, indexPath };
}

export async function repairSessions(options = {}) {
  const sessionsDir = path.resolve(options.sessionsDir || defaultSessionsDir(options.agent || DEFAULT_AGENT));
  const files = await listSessionFiles(sessionsDir, options);
  const results = [];
  for (const filePath of files) {
    results.push(await repairSessionFile(filePath, options));
  }
  const index = await updateSessionIndex(sessionsDir, results, options);
  return {
    sessionsDir,
    files: results,
    index,
    changedFiles: results.filter((item) => item.changed && !item.skipped).length,
    normalizedErrors: results.reduce((sum, item) => sum + (item.normalizedErrors || 0), 0),
    compactedToolResults: results.reduce((sum, item) => sum + (item.compactedToolResults || 0), 0),
    removedMessages: results.reduce((sum, item) => sum + (item.removedMessages || 0), 0)
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`missing value for ${arg}`);
      i += 1;
      return next;
    };
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--ignore-locks") options.ignoreLocks = true;
    else if (arg === "--agent") options.agent = readValue();
    else if (arg === "--sessions-dir") options.sessionsDir = readValue();
    else if (arg === "--session-id") options.sessionId = readValue();
    else if (arg === "--visible-results") options.visibleResults = Number(readValue());
    else if (arg === "--max-tool-result-chars") options.maxToolResultChars = Number(readValue());
    else if (arg === "--lock-stale-seconds") options.lockStaleSeconds = Number(readValue());
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs();
  const result = await repairSessions(options);
  if (options.quiet) {
    if (result.changedFiles > 0 || result.normalizedErrors > 0 || result.compactedToolResults > 0 || result.removedMessages > 0) {
      console.log(`session repair changedFiles=${result.changedFiles} normalizedErrors=${result.normalizedErrors} compactedToolResults=${result.compactedToolResults} removedMessages=${result.removedMessages}`);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

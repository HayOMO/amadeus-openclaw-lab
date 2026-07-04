import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_AGENT = "imagebot";
const DEFAULT_LOCK_STALE_SECONDS = 15 * 60;
const DEFAULT_MAX_FILES = 80;
const DEFAULT_MIN_DATA_CHARS = 1024;
const EMBEDDED_IMAGE_DATA_RE = /("data"\s*:\s*")((?:data:image\/(?:png|jpe?g|webp|gif);base64,)?[A-Za-z0-9+/=]{1024,})(?="|\[\.\.\.|$)/g;

function defaultSessionsDir(agent = DEFAULT_AGENT) {
  return path.join(os.homedir(), ".openclaw", "agents", agent, "sessions");
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    agent: DEFAULT_AGENT,
    sessionsDir: "",
    lockStaleSeconds: DEFAULT_LOCK_STALE_SECONDS,
    maxFiles: DEFAULT_MAX_FILES,
    minDataChars: DEFAULT_MIN_DATA_CHARS,
    dryRun: false,
    quiet: false
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const readValue = () => {
      const inline = arg.match(/^--[^=]+=([\s\S]*)$/);
      if (inline) return inline[1];
      return argv[++index] || "";
    };
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg.startsWith("--agent")) options.agent = readValue() || DEFAULT_AGENT;
    else if (arg.startsWith("--sessions-dir")) options.sessionsDir = readValue();
    else if (arg.startsWith("--lock-stale-seconds")) options.lockStaleSeconds = Number(readValue());
    else if (arg.startsWith("--max-files")) options.maxFiles = Number(readValue());
    else if (arg.startsWith("--min-data-chars")) options.minDataChars = Number(readValue());
  }

  if (!Number.isFinite(options.lockStaleSeconds) || options.lockStaleSeconds < 0) {
    options.lockStaleSeconds = DEFAULT_LOCK_STALE_SECONDS;
  }
  if (!Number.isFinite(options.maxFiles) || options.maxFiles <= 0) {
    options.maxFiles = DEFAULT_MAX_FILES;
  }
  if (!Number.isFinite(options.minDataChars) || options.minDataChars < 0) {
    options.minDataChars = DEFAULT_MIN_DATA_CHARS;
  }
  if (!options.sessionsDir) options.sessionsDir = defaultSessionsDir(options.agent);
  options.sessionsDir = path.resolve(options.sessionsDir);
  options.maxFiles = Math.trunc(options.maxFiles);
  options.minDataChars = Math.trunc(options.minDataChars);
  return options;
}

function isSessionJsonl(name) {
  return name.endsWith(".jsonl") && !name.includes(".trajectory.");
}

async function isLocked(filePath, lockStaleSeconds) {
  const lockPath = `${filePath}.lock`;
  let stat;
  try {
    stat = await fs.stat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const ageMs = Date.now() - stat.mtimeMs;
  return ageMs < lockStaleSeconds * 1000;
}

function compactImageItem(item, minDataChars) {
  if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "image") {
    return { item, pruned: false, bytesSaved: 0 };
  }

  const data = item.data;
  const dataChars = typeof data === "string" ? data.length :
    data && typeof data === "object" ? JSON.stringify(data).length : 0;
  if (dataChars < minDataChars) return { item, pruned: false, bytesSaved: 0 };

  const parts = ["[saved image preview pruned from session history"];
  if (item.fileName) parts.push(`file=${item.fileName}`);
  if (item.mimeType) parts.push(`mime=${item.mimeType}`);
  parts.push(`base64Chars=${dataChars}]`);

  return {
    item: { type: "text", text: parts.join(" ") },
    pruned: true,
    bytesSaved: dataChars
  };
}

function compactEmbeddedImageDataText(item, minDataChars) {
  if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "text" || typeof item.text !== "string") {
    return { item, pruned: 0, bytesSaved: 0 };
  }
  if (!item.text.includes('"data"')) return { item, pruned: 0, bytesSaved: 0 };
  let pruned = 0;
  let bytesSaved = 0;
  const text = item.text.replace(EMBEDDED_IMAGE_DATA_RE, (match, prefix, data) => {
    if (data.length < minDataChars) return match;
    pruned++;
    bytesSaved += data.length;
    return `${prefix}[embedded image data pruned from session history base64Chars=${data.length}]`;
  });
  if (!pruned) return { item, pruned: 0, bytesSaved: 0 };
  return {
    item: { ...item, text },
    pruned,
    bytesSaved
  };
}

function pruneContentImages(content, minDataChars) {
  if (!Array.isArray(content)) return { content, pruned: 0, bytesSaved: 0 };
  let pruned = 0;
  let bytesSaved = 0;
  let changed = false;
  const next = content.map((item) => {
    const embedded = compactEmbeddedImageDataText(item, minDataChars);
    if (embedded.pruned) {
      pruned += embedded.pruned;
      bytesSaved += embedded.bytesSaved;
      changed = true;
      return embedded.item;
    }
    const result = compactImageItem(item, minDataChars);
    if (result.pruned) {
      pruned++;
      bytesSaved += result.bytesSaved;
      changed = true;
    }
    return result.item;
  });
  return { content: changed ? next : content, pruned, bytesSaved };
}

function pruneSessionObject(obj, minDataChars) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { obj, pruned: 0, bytesSaved: 0 };
  }
  const message = obj.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { obj, pruned: 0, bytesSaved: 0 };
  }
  const result = pruneContentImages(message.content, minDataChars);
  if (!result.pruned) return { obj, pruned: 0, bytesSaved: 0 };
  return {
    obj: {
      ...obj,
      message: {
        ...message,
        content: result.content
      }
    },
    pruned: result.pruned,
    bytesSaved: result.bytesSaved
  };
}

export async function pruneSessionFile(filePath, options = {}) {
  const minDataChars = Number.isFinite(options.minDataChars) ? options.minDataChars : DEFAULT_MIN_DATA_CHARS;
  const dryRun = options.dryRun === true;
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const out = [];
  let changed = false;
  let pruned = 0;
  let bytesSaved = 0;
  let malformed = 0;

  for (const line of lines) {
    if (!line) {
      out.push(line);
      continue;
    }
    try {
      const obj = JSON.parse(line);
      const result = pruneSessionObject(obj, minDataChars);
      if (result.pruned) {
        changed = true;
        pruned += result.pruned;
        bytesSaved += result.bytesSaved;
        out.push(JSON.stringify(result.obj));
      } else {
        out.push(line);
      }
    } catch {
      malformed++;
      out.push(line);
    }
  }

  if (changed && !dryRun) {
    const nextRaw = out.join("\n");
    const tempPath = `${filePath}.prune-${process.pid}-${Date.now()}.tmp`;
    await fs.writeFile(tempPath, nextRaw, "utf8");
    await fs.rename(tempPath, filePath);
  }

  return {
    filePath,
    changed,
    pruned,
    bytesSaved,
    malformed,
    beforeBytes: Buffer.byteLength(raw),
    afterBytes: changed ? Buffer.byteLength(out.join("\n")) : Buffer.byteLength(raw)
  };
}

export async function pruneSessions(options = {}) {
  const sessionsDir = path.resolve(options.sessionsDir || defaultSessionsDir(options.agent || DEFAULT_AGENT));
  let entries;
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { sessionsDir, files: [], totalPruned: 0, totalBytesSaved: 0 };
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isSessionJsonl(entry.name)) continue;
    const filePath = path.join(sessionsDir, entry.name);
    const stat = await fs.stat(filePath);
    files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const selected = files.slice(0, options.maxFiles || DEFAULT_MAX_FILES);
  const results = [];
  for (const file of selected) {
    if (await isLocked(file.filePath, options.lockStaleSeconds ?? DEFAULT_LOCK_STALE_SECONDS)) {
      results.push({ filePath: file.filePath, skipped: true, reason: "active-lock" });
      continue;
    }
    results.push(await pruneSessionFile(file.filePath, options));
  }

  return {
    sessionsDir,
    files: results,
    totalPruned: results.reduce((sum, item) => sum + (item.pruned || 0), 0),
    totalBytesSaved: results.reduce((sum, item) => sum + (item.bytesSaved || 0), 0)
  };
}

async function main() {
  const options = parseArgs();
  const result = await pruneSessions(options);
  if (!options.quiet || result.totalPruned > 0) {
    console.log(`session image prune: files=${result.files.length} pruned=${result.totalPruned} bytesSaved=${result.totalBytesSaved}`);
    for (const file of result.files.filter((item) => item.pruned || item.skipped)) {
      const label = path.basename(file.filePath);
      if (file.skipped) console.log(`- ${label}: skipped ${file.reason}`);
      else console.log(`- ${label}: pruned=${file.pruned} bytesSaved=${file.bytesSaved} before=${file.beforeBytes} after=${file.afterBytes}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`session image prune failed: ${error?.stack || error?.message || error}`);
    process.exit(1);
  });
}

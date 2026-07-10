import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openclawStatePath } from "../plugins/imagebot-shared/openclaw-paths.mjs";

const DEFAULT_AGENT = "imagebot";

function defaultWindowStorePath(agent = DEFAULT_AGENT) {
  return openclawStatePath("agents", agent, "sessions", "sessions.json.telegram-imagebot-windows.json");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeString(value) {
  return String(value ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizeJsonValue(value) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeJsonValue(item)]));
}

function escapeRawControlCharsInStrings(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const code = ch.charCodeAt(0);
    if (inString) {
      if (escaped) {
        output += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        output += ch;
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        output += ch;
        inString = false;
        continue;
      }
      if (code < 0x20) {
        if (ch === "\n") output += "\\n";
        else if (ch === "\r") output += "\\r";
        else if (ch === "\t") output += "\\t";
        else output += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      output += ch;
      continue;
    }
    output += ch;
    if (ch === "\"") inString = true;
  }
  return output;
}

function parseWindowStoreText(text) {
  try {
    return { value: JSON.parse(text), repairedSyntax: false };
  } catch (firstError) {
    const escaped = escapeRawControlCharsInStrings(text);
    try {
      return { value: JSON.parse(escaped), repairedSyntax: true, firstError };
    } catch (secondError) {
      return { value: null, repairedSyntax: false, firstError, secondError };
    }
  }
}

function normalizeWindowStore(raw) {
  const store = isRecord(raw) ? raw : {};
  const windows = isRecord(store.windows) ? sanitizeJsonValue(store.windows) : {};
  const activeByUser = {};
  const activeWindowIds = new Set();
  if (isRecord(store.activeByUser)) {
    for (const [userKey, ref] of Object.entries(store.activeByUser)) {
      if (!isRecord(ref)) continue;
      const cleanRef = sanitizeJsonValue(ref);
      const windowId = sanitizeString(cleanRef.windowId);
      if (!windowId) continue;
      const storedWindow = isRecord(windows[windowId]) ? windows[windowId] : cleanRef;
      if (storedWindow.closedAt) continue;
      activeByUser[userKey] = storedWindow;
      activeWindowIds.add(windowId);
    }
  }
  const inactiveClosedAt = new Date().toISOString();
  for (const [windowKey, windowEntry] of Object.entries(windows)) {
    if (!isRecord(windowEntry)) continue;
    const windowId = sanitizeString(windowEntry.windowId) || windowKey;
    if (activeWindowIds.has(windowId) || windowEntry.closedAt) continue;
    windows[windowKey] = {
      ...windowEntry,
      closedAt: inactiveClosedAt,
      closedReason: sanitizeString(windowEntry.closedReason) || "inactive-window-routing-pruned"
    };
  }
  const isRoutableWindowId = (windowId) => {
    if (!activeWindowIds.has(windowId)) return false;
    const storedWindow = isRecord(windows[windowId]) ? windows[windowId] : null;
    return !storedWindow?.closedAt;
  };
  const byBotMessage = {};
  if (isRecord(store.byBotMessage)) {
    for (const [messageKey, ref] of Object.entries(store.byBotMessage)) {
      if (!isRecord(ref)) continue;
      const cleanRef = sanitizeJsonValue(ref);
      const windowId = sanitizeString(cleanRef.windowId);
      if (!windowId || !isRoutableWindowId(windowId)) continue;
      byBotMessage[messageKey] = cleanRef;
    }
  }
  const users = isRecord(store.users) ? sanitizeJsonValue(store.users) : {};
  return {
    ...sanitizeJsonValue(store),
    version: 3,
    activeByUser,
    byBotMessage,
    users,
    windows
  };
}

async function writeBackup(filePath, text) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak-${stamp}`;
  await fs.writeFile(backupPath, text, "utf8");
  return backupPath;
}

export async function repairWindowStore(filePath = defaultWindowStorePath(), options = {}) {
  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { filePath, changed: false, skipped: true, reason: "missing" };
    }
    throw error;
  }

  const parsed = parseWindowStoreText(text);
  const fallback = { version: 3, activeByUser: {}, byBotMessage: {}, users: {}, windows: {} };
  const normalized = normalizeWindowStore(parsed.value || fallback);
  const nextText = `${JSON.stringify(normalized, null, 2)}\n`;
  const changed = parsed.repairedSyntax || parsed.value === null || text !== nextText;
  let backupPath = "";
  if (changed && !options.dryRun) {
    backupPath = await writeBackup(filePath, text);
    await fs.writeFile(filePath, nextText, "utf8");
  }
  return {
    filePath,
    changed,
    dryRun: options.dryRun === true,
    repairedSyntax: parsed.repairedSyntax,
    reset: parsed.value === null,
    backupPath,
    activeUsers: Object.keys(normalized.activeByUser || {}).length,
    windows: Object.keys(normalized.windows || {}).length,
    parseError: parsed.value === null ? String(parsed.secondError?.message || parsed.firstError?.message || "") : ""
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
    else if (arg === "--agent") options.agent = readValue();
    else if (arg === "--file") options.filePath = readValue();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs();
  const result = await repairWindowStore(path.resolve(options.filePath || defaultWindowStorePath(options.agent || DEFAULT_AGENT)), options);
  if (options.quiet) {
    if (result.changed || result.reset || result.repairedSyntax) {
      console.log(`window store repair changed=${result.changed} repairedSyntax=${result.repairedSyntax} reset=${result.reset} activeUsers=${result.activeUsers ?? 0} windows=${result.windows ?? 0}`);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

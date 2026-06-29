import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = Math.max(1, Math.min(100, Number(limitArg?.split("=")[1] || 20)));
const auditPath = path.join(os.homedir(), ".openclaw", "logs", "telegram-media-delivery.jsonl");

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function pick(entry) {
  return {
    ts: entry.ts || entry.time || entry.timestamp || "",
    status: entry.status || "",
    operation: entry.operation || "",
    chatId: entry.chatId || "",
    deliveryKind: entry.deliveryKind || "",
    mediaCount: entry.mediaCount ?? "",
    hasSpoiler: entry.hasSpoiler === true,
    messageIds: Array.isArray(entry.messageIds) ? entry.messageIds.join(",") : entry.messageId || "",
    fileName: entry.fileName || "",
    error: entry.error || ""
  };
}

let raw = "";
try {
  raw = await fs.readFile(auditPath, "utf8");
} catch (error) {
  console.error(`No telegram media delivery audit found: ${auditPath}`);
  console.error(String(error?.message || error));
  process.exit(1);
}

const entries = raw
  .split(/\r?\n/)
  .filter(Boolean)
  .map(parseLine)
  .filter(Boolean)
  .slice(-limit)
  .map(pick);

console.log(JSON.stringify({ auditPath, count: entries.length, entries }, null, 2));

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const fileLocks = new Map();
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;

function lockKey(filePath) {
  return path.resolve(String(filePath || "")).toLowerCase();
}

function lockId(filePath) {
  const target = path.resolve(String(filePath || ""));
  const digest = crypto.createHash("sha256").update(target).digest("hex").slice(0, 20);
  return `${path.basename(target).replace(/[^a-z0-9._-]/gi, "_")}.${digest}.sqlite`;
}

export function stateFileLockPath(filePath) {
  const target = path.resolve(String(filePath || ""));
  return path.join(path.dirname(target), ".state-locks", lockId(target));
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function acquireProcessLock(filePath, options = {}) {
  const target = path.resolve(String(filePath || ""));
  const lockPath = stateFileLockPath(target);
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  let db = null;
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    db = new DatabaseSync(lockPath);
    db.exec(`PRAGMA busy_timeout = ${Math.floor(timeoutMs)}`);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("CREATE TABLE IF NOT EXISTS lock_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT OR REPLACE INTO lock_meta (key, value) VALUES ('last_owner', ?)").run(JSON.stringify({
      pid: process.pid,
      target,
      acquiredAt: new Date().toISOString()
    }));
    return async () => {
      try {
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      } finally {
        db.close();
      }
    };
  } catch (error) {
    try {
      db?.close();
    } catch {}
    if (String(error?.code || "").includes("BUSY") || /busy|locked/i.test(String(error?.message || ""))) {
      throw new Error(`Timed out waiting for state file lock after ${timeoutMs}ms: ${target}`);
    }
    throw error;
  }
}

export async function withStateFileLock(filePath, fn, options = {}) {
  const key = lockKey(filePath);
  const previous = fileLocks.get(key) || Promise.resolve();
  const current = (async () => {
    await previous.catch(() => {});
    const release = await acquireProcessLock(filePath, options);
    try {
      return await fn();
    } finally {
      await release();
    }
  })();
  fileLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (fileLocks.get(key) === current) fileLocks.delete(key);
  }
}

export async function writeFileAtomic(filePath, data, options = "utf8") {
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tempPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  try {
    await fs.writeFile(tempPath, data, options);
    await fs.rename(tempPath, target);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value, options = {}) {
  const space = options.space === undefined ? 2 : options.space;
  const trailingNewline = options.trailingNewline !== false;
  const body = `${JSON.stringify(value, null, space)}${trailingNewline ? "\n" : ""}`;
  await writeFileAtomic(filePath, body, "utf8");
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== null) return fallback;
    throw error;
  }
}

export async function appendFileLocked(filePath, data, options = "utf8") {
  return await withStateFileLock(filePath, async () => {
    await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    await fs.appendFile(filePath, data, options);
  });
}

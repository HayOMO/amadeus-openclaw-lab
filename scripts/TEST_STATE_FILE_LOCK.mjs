import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendFileLocked,
  readJsonFile,
  stateFileLockPath,
  withStateFileLock,
  writeJsonAtomic
} from "../plugins/imagebot-shared/state-file.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[2] === "--worker") {
  const counterPath = process.argv[3];
  const workerId = Number(process.argv[4]);
  const iterations = Number(process.argv[5] || 10);
  for (let index = 0; index < iterations; index += 1) {
    await withStateFileLock(counterPath, async () => {
      const state = await readJsonFile(counterPath, { value: 0, seen: [] });
      await delay((workerId + index) % 7);
      state.value += 1;
      state.seen.push(`${workerId}:${index}`);
      await writeJsonAtomic(counterPath, state);
    }, { timeoutMs: 20_000, heartbeatMs: 200 });
  }
  process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-state-file-lock-test-"));
const counterPath = path.join(root, "nested", "counter.json");
const logPath = path.join(root, "nested", "events.jsonl");
const throwPath = path.join(root, "nested", "throw-release.json");
const crossProcessCounterPath = path.join(root, "nested", "cross-process-counter.json");

function runWorker(counterFile, workerId, iterations) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      "--worker",
      counterFile,
      String(workerId),
      String(iterations)
    ], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`worker ${workerId} exited ${code}\n${stdout}${stderr}`));
      }
    });
  });
}

assert.deepEqual(await readJsonFile(counterPath, { value: 0, seen: [] }), { value: 0, seen: [] });

await Promise.all(Array.from({ length: 32 }, async (_, index) => {
  await withStateFileLock(counterPath, async () => {
    const state = await readJsonFile(counterPath, { value: 0, seen: [] });
    await delay(index % 4);
    state.value += 1;
    state.seen.push(index);
    await writeJsonAtomic(counterPath, state);
  });
}));

const finalCounter = await readJsonFile(counterPath);
assert.equal(finalCounter.value, 32);
assert.equal(finalCounter.seen.length, 32);
assert.equal(new Set(finalCounter.seen).size, 32);
assert.deepEqual([...finalCounter.seen].sort((a, b) => a - b), Array.from({ length: 32 }, (_, index) => index));
assert.equal(await pathExists(stateFileLockPath(counterPath)), true);

await Promise.all(Array.from({ length: 48 }, async (_, index) => {
  await delay(index % 5);
  await appendFileLocked(logPath, `${JSON.stringify({ index, value: `line-${index}` })}\n`);
}));

const logLines = (await fs.readFile(logPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.equal(logLines.length, 48);
assert.equal(new Set(logLines.map((line) => line.index)).size, 48);
assert.ok(logLines.every((line) => /^line-\d+$/.test(line.value)));
assert.equal(await pathExists(stateFileLockPath(logPath)), true);

await assert.rejects(
  () => withStateFileLock(throwPath, async () => {
    await writeJsonAtomic(throwPath, { value: 1 });
    throw new Error("intentional release test");
  }, { timeoutMs: 2_000, heartbeatMs: 100 }),
  /intentional release test/
);
assert.equal(await pathExists(stateFileLockPath(throwPath)), true);
await withStateFileLock(throwPath, async () => {
  const state = await readJsonFile(throwPath, { value: 0 });
  state.value += 1;
  await writeJsonAtomic(throwPath, state);
}, { timeoutMs: 2_000, heartbeatMs: 100 });
assert.deepEqual(await readJsonFile(throwPath), { value: 2 });

const workerCount = 8;
const workerIterations = 12;
await Promise.all(Array.from({ length: workerCount }, (_, index) => runWorker(crossProcessCounterPath, index, workerIterations)));
const crossProcessCounter = await readJsonFile(crossProcessCounterPath);
assert.equal(crossProcessCounter.value, workerCount * workerIterations);
assert.equal(crossProcessCounter.seen.length, workerCount * workerIterations);
assert.equal(new Set(crossProcessCounter.seen).size, workerCount * workerIterations);
assert.equal(await pathExists(stateFileLockPath(crossProcessCounterPath)), true);

console.log("state file lock tests passed");

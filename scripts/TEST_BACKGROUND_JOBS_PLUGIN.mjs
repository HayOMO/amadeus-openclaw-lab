import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin, { __testing } from "../plugins/imagebot-background-jobs/index.js";

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

async function makeManager(name, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const manager = __testing.createBackgroundJobManager({
    storeDir: root,
    maxConcurrent: config.maxConcurrent ?? 2
  });
  return { root, manager };
}

{
  const { root, manager } = await makeManager("imagebot-bg-concurrency", { maxConcurrent: 2 });
  let active = 0;
  let maxActive = 0;
  manager.registerHandler("wait", async ({ payload, progress, signal }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await progress({ percent: 25, note: `running ${payload.name}` });
      await sleep(payload.ms, signal);
      return { done: payload.name };
    } finally {
      active -= 1;
    }
  });
  const started = await Promise.all([
    manager.enqueue({ kind: "wait", label: "one", payload: { name: "one", ms: 80 } }),
    manager.enqueue({ kind: "wait", label: "two", payload: { name: "two", ms: 80 } }),
    manager.enqueue({ kind: "wait", label: "three", payload: { name: "three", ms: 20 } })
  ]);
  const completed = await Promise.all(started.map((entry) => manager.waitForJob(entry.job.id, 2000)));
  assert.equal(completed.length, 3);
  assert.ok(maxActive > 1, "jobs should run concurrently");
  assert.ok(maxActive <= 2, "maxConcurrent should cap active jobs");
  const recent = await __testing.recentJobStates({ storeDir: root }, 10);
  assert.ok(recent.some((job) => job.state === "completed"), "events should persist completed jobs");
}

{
  const { manager } = await makeManager("imagebot-bg-dedupe", { maxConcurrent: 1 });
  manager.registerHandler("slow", async ({ signal }) => {
    await sleep(80, signal);
    return "ok";
  });
  const first = await manager.enqueue({ kind: "slow", dedupeKey: "same-request", payload: { index: 1 } });
  const second = await manager.enqueue({ kind: "slow", dedupeKey: "same-request", payload: { index: 2 } });
  assert.equal(second.deduped, true);
  assert.equal(second.job.id, first.job.id);
  const final = await manager.waitForJob(first.job.id, 2000);
  assert.equal(final.state, "completed");
}

{
  const { manager } = await makeManager("imagebot-bg-cancel", { maxConcurrent: 1 });
  manager.registerHandler("slow", async ({ signal }) => {
    await sleep(120, signal);
    return "ok";
  });
  const active = await manager.enqueue({ kind: "slow", label: "active" });
  const queued = await manager.enqueue({ kind: "slow", label: "queued" });
  const cancelled = await manager.cancel(queued.job.id);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.job.state, "cancelled");
  const activeFinal = await manager.waitForJob(active.job.id, 2000);
  assert.equal(activeFinal.state, "completed");
}

{
  const { manager } = await makeManager("imagebot-bg-retry-policy", { maxConcurrent: 1 });
  let mutationRuns = 0;
  const mutation = await manager.enqueue({
    kind: "mutation",
    attempts: 3,
    backoffMs: 1,
    handler: async () => {
      mutationRuns += 1;
      throw new Error("mutation failed");
    }
  });
  const mutationFinal = await manager.waitForJob(mutation.job.id, 2000);
  assert.equal(mutationFinal.state, "failed");
  assert.equal(mutationFinal.attempts, 1, "background mutations must not retry implicitly");
  assert.equal(mutationFinal.retryClass, "none");
  assert.equal(mutationRuns, 1);

  let readRuns = 0;
  const idempotentRead = await manager.enqueue({
    kind: "idempotent-read",
    retryClass: "idempotent",
    attempts: 3,
    backoffMs: 1,
    handler: async () => {
      readRuns += 1;
      if (readRuns < 3) throw new Error("temporary read failure");
      return { ok: true };
    }
  });
  const readFinal = await manager.waitForJob(idempotentRead.job.id, 2000);
  assert.equal(readFinal.state, "completed");
  assert.equal(readFinal.attempt, 3);
  assert.equal(readFinal.retryClass, "idempotent");
}

{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-bg-tool-"));
  const tools = new Map();
  const hooks = [];
  plugin.register({
    config: { storeDir: root, maxConcurrent: 1, appendActiveContext: true },
    registerTool(tool, meta) {
      tools.set(meta.name, tool);
    },
    registerHook(name, handler, meta) {
      hooks.push({ name, handler, meta });
    }
  });
  const manager = __testing.getBackgroundJobManager({ storeDir: root, maxConcurrent: 1 });
  manager.registerHandler("quick", async () => ({ ok: true }));
  const queued = await manager.enqueue({
    kind: "quick",
    label: "tool visibility",
    context: { agentId: "imagebot", chatId: "123", sessionKey: "abc" }
  });
  const list = await tools.get("background_job").execute("tool-test", { action: "list", state: "open", count: 5 });
  assert.equal(list.details.status, "ok");
  assert.ok(Array.isArray(list.details.jobs));
  const summary = await tools.get("background_job").execute("tool-test", { action: "summary", count: 5 });
  assert.equal(summary.details.status, "ok");
  assert.match(summary.content[0].text, /BACKGROUND_JOB summary/);
  const hook = hooks.find((item) => item.meta?.name === "imagebot-background-jobs-before-prompt-build");
  assert.ok(hook, "prompt hook should be registered");
  const context = await hook.handler({}, { agentId: "imagebot", chatId: "123", sessionKey: "abc" });
  assert.ok(!context || context.appendContext.includes("Background jobs"));
  const final = await manager.waitForJob(queued.job.id, 2000);
  assert.equal(final.state, "completed");
  const get = await tools.get("background_job").execute("tool-test", { action: "get", job_id: queued.job.id });
  assert.equal(get.details.status, "ok");
}

{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-bg-scope-"));
  const tools = new Map();
  plugin.register({
    config: { storeDir: root, maxConcurrent: 1, appendActiveContext: true },
    registerTool(tool, meta) {
      tools.set(meta.name, tool);
    },
    registerHook() {}
  });
  const manager = __testing.getBackgroundJobManager({ storeDir: root, maxConcurrent: 1 });
  manager.registerHandler("scope-wait", async ({ payload, signal }) => {
    await sleep(payload.ms, signal);
    return { ok: payload.name };
  });
  const ctxA = { agentId: "imagebot", accountId: "imagebot", chatId: "chat-a", sessionKey: "session-a", senderId: "100" };
  const ctxB = { agentId: "imagebot", accountId: "imagebot", chatId: "chat-b", sessionKey: "session-b", senderId: "200" };
  const jobA = await manager.enqueue({
    kind: "scope-wait",
    label: "scope A",
    payload: { name: "a", ms: 120 },
    context: ctxA,
    dedupeKey: "same-payload"
  });
  const jobB = await manager.enqueue({
    kind: "scope-wait",
    label: "scope B",
    payload: { name: "b", ms: 120 },
    context: ctxB,
    dedupeKey: "same-payload"
  });
  assert.notEqual(jobA.job.id, jobB.job.id, "same dedupe key in different scopes must not collide");

  const listA = await tools.get("background_job").execute("list-a", { action: "list", state: "open", count: 10 }, undefined, undefined, ctxA);
  assert.equal(listA.details.status, "ok");
  assert.ok(listA.details.jobs.some((job) => job.id === jobA.job.id));
  assert.ok(!listA.details.jobs.some((job) => job.id === jobB.job.id));

  const getBFromA = await tools.get("background_job").execute("get-b-from-a", { action: "get", job_id: jobB.job.id }, undefined, undefined, ctxA);
  assert.equal(getBFromA.details.status, "not_found");

  const cancelBFromA = await tools.get("background_job").execute("cancel-b-from-a", { action: "cancel", job_id: jobB.job.id }, undefined, undefined, ctxA);
  assert.equal(cancelBFromA.details.status, "not_found");

  const cancelBFromB = await tools.get("background_job").execute("cancel-b-from-b", { action: "cancel", job_id: jobB.job.id }, undefined, undefined, ctxB);
  assert.equal(cancelBFromB.details.status, "ok");
  assert.equal(cancelBFromB.details.job.state, "cancelled");

  const finalA = await manager.waitForJob(jobA.job.id, 2000);
  assert.equal(finalA.state, "completed");
}

console.log("background jobs plugin tests passed");

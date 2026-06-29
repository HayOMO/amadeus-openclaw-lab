import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function request({ port, method = "GET", target = "/", token, host, origin, contentType, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const headers = {
      Host: host || `127.0.0.1:${port}`
    };
    if (token !== undefined) headers["X-Imagebot-Control-Token"] = token;
    if (origin !== undefined) headers.Origin = origin;
    if (contentType !== undefined) headers["Content-Type"] = contentType;
    if (payload) headers["Content-Length"] = payload.length;
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: target,
      headers,
      timeout: 5000
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForReady(port, token) {
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await request({ port, target: "/api/ping", token });
      if (res.status === 200) return;
      lastError = new Error(`HTTP ${res.status}: ${res.body}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError || new Error("control server did not start");
}

const port = await freePort();
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-control-runtime-"));
const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-control-logs-"));
const token = "test-control-token-0123456789abcdef0123456789abcdef";
const child = spawn(process.execPath, ["imagebot-control-server.js"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    IMAGEBOT_CONTROL_PORT: String(port),
    IMAGEBOT_CONTROL_RUNTIME_DIR: runtimeDir,
    IMAGEBOT_CONTROL_LOG_DIR: logDir,
    IMAGEBOT_CONTROL_TOKEN: token
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

try {
  await waitForReady(port, token);

  assert.equal((await fs.readFile(path.join(runtimeDir, "imagebot-control-server.token"), "utf8")).trim(), token);

  const noToken = await request({ port, target: "/api/ping" });
  assert.equal(noToken.status, 401, "API ping should require a token");

  const badToken = await request({ port, target: "/api/ping", token: "wrong-token" });
  assert.equal(badToken.status, 401, "wrong token should be rejected");

  const badHost = await request({ port, target: "/api/ping", token, host: `evil.example:${port}` });
  assert.equal(badHost.status, 403, "unexpected Host should be rejected");

  const okPing = await request({ port, target: "/api/ping", token });
  assert.equal(okPing.status, 200, "valid token should allow API ping");
  assert.equal(okPing.headers["x-content-type-options"], "nosniff");

  const statusResponse = await request({ port, target: "/api/status", token });
  assert.equal(statusResponse.status, 200);
  const status = JSON.parse(statusResponse.body);
  assert.equal(status.logsRedacted, true);
  assert.equal(Object.hasOwn(status, "root"), false, "status must not expose repo root");
  assert.equal(Object.hasOwn(status, "logPath"), false, "status must not expose absolute log path");
  assert.equal(Object.hasOwn(status, "logTail"), false, "status must not expose raw log tail");
  assert.equal(Object.hasOwn(status, "lastWarning"), false, "status must not expose raw warning line");
  assert.equal(Object.hasOwn(status, "lastError"), false, "status must not expose raw error line");

  const missingOrigin = await request({
    port,
    method: "POST",
    target: "/api/action",
    token,
    contentType: "application/json",
    body: "{}"
  });
  assert.equal(missingOrigin.status, 403, "POST without expected Origin should be rejected");

  const badOrigin = await request({
    port,
    method: "POST",
    target: "/api/action",
    token,
    origin: "https://attacker.example",
    contentType: "application/json",
    body: "{}"
  });
  assert.equal(badOrigin.status, 403, "cross-site Origin should be rejected");

  const textPost = await request({
    port,
    method: "POST",
    target: "/api/action",
    token,
    origin: `http://127.0.0.1:${port}`,
    contentType: "text/plain",
    body: "{}"
  });
  assert.equal(textPost.status, 415, "POST must require JSON content type");

  const invalidAction = await request({
    port,
    method: "POST",
    target: "/api/action",
    token,
    origin: `http://127.0.0.1:${port}`,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ action: "not-a-real-action" })
  });
  assert.equal(invalidAction.status, 400, "valid boundary with invalid action should reach action validation");

  const traversal = await request({ port, target: "/%2e%2e%5cpackage.json" });
  assert.equal(traversal.status, 403, "encoded static path traversal should be rejected");

  const index = await request({ port, target: "/" });
  assert.equal(index.status, 200, "static app should remain readable");
  assert.equal(index.headers["x-content-type-options"], "nosniff");

  await request({
    port,
    method: "POST",
    target: "/api/exit",
    token,
    origin: `http://127.0.0.1:${port}`,
    contentType: "application/json",
    body: "{}"
  });
} finally {
  child.kill();
  await fs.rm(runtimeDir, { recursive: true, force: true });
  await fs.rm(logDir, { recursive: true, force: true });
}

assert.equal(/test-control-token/.test(stdout + stderr), false, "server output must not print the control token");

console.log("control server auth tests passed");

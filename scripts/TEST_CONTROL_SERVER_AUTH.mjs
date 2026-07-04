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

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("child did not exit"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
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

  const bootstrap = "test-bootstrap-nonce-0123456789abcdef0123456789abcdef";
  await fs.writeFile(path.join(runtimeDir, "imagebot-control-bootstrap.json"), JSON.stringify({ nonce: bootstrap, createdAt: Date.now() }), "utf8");
  const bootstrapResponse = await request({
    port,
    method: "POST",
    target: "/api/bootstrap",
    origin: `http://127.0.0.1:${port}`,
    contentType: "application/json",
    body: JSON.stringify({ bootstrap })
  });
  assert.equal(bootstrapResponse.status, 200, "bootstrap nonce should exchange for the control token once");
  assert.equal(JSON.parse(bootstrapResponse.body).token, token);
  const replayBootstrap = await request({
    port,
    method: "POST",
    target: "/api/bootstrap",
    origin: `http://127.0.0.1:${port}`,
    contentType: "application/json",
    body: JSON.stringify({ bootstrap })
  });
  assert.equal(replayBootstrap.status, 401, "bootstrap nonce should be one-use");

  const noToken = await request({ port, target: "/api/ping" });
  assert.equal(noToken.status, 401, "API ping should require a token");

  const badToken = await request({ port, target: "/api/ping", token: "wrong-token" });
  assert.equal(badToken.status, 401, "wrong token should be rejected");

  const badHost = await request({ port, target: "/api/ping", token, host: `evil.example:${port}` });
  assert.equal(badHost.status, 403, "unexpected Host should be rejected");

  const okPing = await request({ port, target: "/api/ping", token });
  assert.equal(okPing.status, 200, "valid token should allow API ping");
  assert.equal(okPing.headers["x-content-type-options"], "nosniff");
  assert.match(okPing.headers["content-security-policy"] || "", /default-src 'self'/);
  assert.equal(okPing.headers["x-frame-options"], "DENY");
  assert.match(okPing.headers["permissions-policy"] || "", /camera=\(\)/);
  assert.equal(okPing.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(okPing.headers["cross-origin-embedder-policy"], "require-corp");

  const gatewayLog = path.join(logDir, "imagebot-gateway-large.log");
  const fillerLine = `old line ${"x".repeat(220)}`;
  await fs.writeFile(
    gatewayLog,
    `${Array.from({ length: 4096 }, (_, index) => `${fillerLine} ${index}`).join("\n")}\n[gateway] ready\n[gateway] agent model: openai/gpt-5.5\nlast status marker\n`,
    "utf8",
  );
  await fs.writeFile(path.join(runtimeDir, "imagebot-gateway.logpath"), gatewayLog, "utf8");

  const statusResponse = await request({ port, target: "/api/status", token });
  assert.equal(statusResponse.status, 200);
  const status = JSON.parse(statusResponse.body);
  assert.equal(status.lastLine, "last status marker", "status should read the newest log line from a large log file");
  assert.equal(status.model, "openai/gpt-5.5", "status should parse model info from the bounded log tail");
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

  const localhostOriginAction = await request({
    port,
    method: "POST",
    target: "/api/action",
    token,
    origin: `http://localhost:${port}`,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ action: "not-a-real-action" })
  });
  assert.equal(localhostOriginAction.status, 400, "localhost Origin should be accepted for loopback UI usage");

  const traversal = await request({ port, target: "/%2e%2e%5cpackage.json" });
  assert.equal(traversal.status, 403, "encoded static path traversal should be rejected");

  const index = await request({ port, target: "/" });
  assert.equal(index.status, 200, "static app should remain readable");
  assert.equal(index.headers["x-content-type-options"], "nosniff");
  assert.match(index.headers["content-security-policy"] || "", /frame-ancestors 'none'/);
  assert.equal(index.headers["cross-origin-resource-policy"], "same-origin");

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
const launcherSource = await fs.readFile(path.join(repoRoot, "imagebot-launcher.js"), "utf8");
assert.match(launcherSource, /#bootstrap=/, "launcher should put only a one-use bootstrap nonce in the browser URL");
assert.doesNotMatch(launcherSource, /#token=/, "launcher must not put the long-lived control token in the browser URL");
const panelSource = await fs.readFile(path.join(repoRoot, "app", "app.js"), "utf8");
assert.match(panelSource, /\/api\/bootstrap/, "panel should exchange the bootstrap nonce for the control token");

const remotePort = await freePort();
const remoteRuntimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-control-remote-runtime-"));
const remoteLogDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-control-remote-logs-"));
const remoteChild = spawn(process.execPath, ["imagebot-control-server.js"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    IMAGEBOT_CONTROL_HOST: "0.0.0.0",
    IMAGEBOT_CONTROL_PORT: String(remotePort),
    IMAGEBOT_CONTROL_RUNTIME_DIR: remoteRuntimeDir,
    IMAGEBOT_CONTROL_LOG_DIR: remoteLogDir,
    IMAGEBOT_CONTROL_TOKEN: token
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let remoteStdout = "";
let remoteStderr = "";
remoteChild.stdout.on("data", (chunk) => {
  remoteStdout += chunk.toString("utf8");
});
remoteChild.stderr.on("data", (chunk) => {
  remoteStderr += chunk.toString("utf8");
});
try {
  const exited = await waitForExit(remoteChild);
  assert.notEqual(exited.code, 0, "non-loopback control host should be rejected by default");
  assert.match(remoteStdout + remoteStderr, /loopback|IMAGEBOT_CONTROL_ALLOW_REMOTE/);
} finally {
  remoteChild.kill();
  await fs.rm(remoteRuntimeDir, { recursive: true, force: true });
  await fs.rm(remoteLogDir, { recursive: true, force: true });
}

console.log("control server auth tests passed");

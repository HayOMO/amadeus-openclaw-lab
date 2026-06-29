import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import plugin, { __testing } from "../plugins/imagebot-desktop-control/index.js";

const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-desktop-control-test-"));
const tools = new Map();

plugin.register({
  config: {
    storeDir,
    audit: true,
    runner: async (request) => ({
      ok: true,
      status: "ok",
      action: request.action,
      target: request.target,
      sessionCount: 1,
      current: {
        sourceAppUserModelId: "cloudmusic.exe",
        playbackStatus: "Playing",
        media: {
          title: "Test Song",
          artist: "Test Artist",
          albumTitle: "Test Album"
        },
        controls: {
          play: true,
          pause: true,
          next: true,
          previous: true
        }
      }
    })
  },
  registerTool(tool, opts) {
    tools.set(opts?.name || tool.name, tool);
  }
});

assert.ok(tools.has("desktop_media_control"), "desktop_media_control should be registered");
const tool = tools.get("desktop_media_control");
assert.equal(tool.parameters.additionalProperties, false);
assert.ok(!Object.hasOwn(tool.parameters.properties, "command"));
assert.ok(!Object.hasOwn(tool.parameters.properties, "script"));
assert.ok(!Object.hasOwn(tool.parameters.properties, "cwd"));
assert.deepEqual(new Set(tool.parameters.properties.action.enum), __testing.ACTIONS);
assert.deepEqual(new Set(tool.parameters.properties.target.enum), __testing.TARGETS);

assert.deepEqual(__testing.validateActionParams({ action: "TOGGLE", target: "NETEASE" }), {
  action: "toggle",
  target: "netease"
});
assert.throws(
  () => __testing.validateActionParams({ action: "click", target: "netease" }),
  /unsupported desktop media action/
);

const status = await tool.execute("status", { action: "status", target: "netease" }, undefined, undefined, {
  agentId: "imagebot",
  channel: "telegram",
  chatId: "-100test",
  sessionKey: "desktop-test"
});
assert.equal(status.details.status, "ok");
assert.equal(status.details.result.current.media.title, "Test Song");
assert.match(status.content[0].text, /Test Song - Test Artist/);

const auditPath = __testing.auditLogPath({ storeDir });
const auditLines = (await fs.readFile(auditPath, "utf8")).trim().split(/\r?\n/);
assert.equal(auditLines.length, 1);
const audit = JSON.parse(auditLines[0]);
assert.equal(audit.action, "status");
assert.equal(audit.target, "netease");
assert.equal(audit.context.channel, "telegram");
assert.equal(audit.selectedSource, "cloudmusic.exe");

const noSession = await __testing.invokeDesktopMediaControl({
  storeDir,
  audit: false
}, { action: "play", target: "netease" }, undefined, {}, {
  runner: async (request) => ({
    ok: false,
    status: "no_session",
    action: request.action,
    target: request.target,
    sessionCount: 0,
    sessions: [],
    error: "No matching Windows media session was found."
  })
});
assert.equal(noSession.details.status, "no_session");
assert.match(noSession.content[0].text, /No matching Windows media session/);

if (process.platform === "win32") {
  const helper = spawnSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(process.cwd(), "scripts", "LOCAL_DESKTOP_MEDIA_CONTROL.ps1"),
    "-Action",
    "status",
    "-Target",
    "any"
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
    timeout: 30_000
  });
  assert.equal(helper.status, 0, helper.stderr || helper.stdout);
  const parsed = JSON.parse(helper.stdout.trim());
  assert.equal(parsed.status, "ok");
  assert.ok(Array.isArray(parsed.sessions), "helper status should return a sessions array");
}

console.log("desktop control plugin tests passed");

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin from "../plugins/imagebot-browser-guard/index.js";

const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-browser-guard-test-"));
const hooks = new Map();

plugin.register({
  config: {
    allowedProfiles: ["openclaw"],
    allowedPathPrefixes: [mediaRoot]
  },
  registerHook(name, handler, meta) {
    hooks.set(meta?.name || name, handler);
  }
});

const hook = hooks.get("imagebot-browser-guard-before-tool-call");
assert.ok(hook, "browser guard hook should be registered");

assert.equal(await hook({ toolName: "web_snapshot", params: { url: "https://example.com" } }), undefined);

const publicPage = await hook({ toolName: "browser", params: { url: "https://example.com/page" } });
assert.equal(publicPage.params.profile, "openclaw");
assert.equal(publicPage.params.url, "https://example.com/page");

const allowedMediaPath = path.join(mediaRoot, "inbound.png");
const localMedia = await hook({ toolName: "browser", params: { url: allowedMediaPath } });
assert.equal(localMedia.params.profile, "openclaw");

const privateHost = await hook({ toolName: "browser", params: { url: "http://127.0.0.1:18789/" } });
assert.equal(privateHost.block, true);
assert.match(privateHost.blockReason, /restricted/);

const localPath = await hook({ toolName: "browser", params: { url: "C:\\Users\\Bot\\.ssh\\id_rsa" } });
assert.equal(localPath.block, true);
assert.match(localPath.blockReason, /restricted/);

const disallowedProfile = await hook({ toolName: "browser", params: { profile: "Default", url: "https://example.com" } });
assert.equal(disallowedProfile.block, true);
assert.match(disallowedProfile.blockReason, /profile/);

const profileMutation = await hook({ toolName: "browser", params: { path: "/profiles" } });
assert.equal(profileMutation.block, true);
assert.match(profileMutation.blockReason, /profile management/);

console.log("browser guard plugin tests passed");

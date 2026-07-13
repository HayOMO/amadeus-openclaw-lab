import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin from "../plugins/imagebot-browser-guard/index.js";

const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-browser-guard-test-"));
const uploadStagingDir = path.join(mediaRoot, "inbound");
const hooks = new Map();

plugin.register({
  config: {
    allowedProfiles: ["bot", "isolated"],
    allowedPathPrefixes: [mediaRoot],
    mediaRoot,
    uploadStagingDir,
    publicNetworkGuard: {
      dnsLookup: async (host) => host === "rebinding.example"
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }]
    }
  },
  registerHook(name, handler, meta) {
    hooks.set(meta?.name || name, handler);
  }
});

const hook = hooks.get("imagebot-browser-guard-before-tool-call");
assert.ok(hook, "browser guard hook should be registered");
const afterHook = hooks.get("imagebot-browser-guard-after-tool-call");
assert.ok(afterHook, "browser guard after hook should be registered");

assert.equal(await hook({ toolName: "web_snapshot", params: { url: "https://example.com" } }), undefined);

const publicPage = await hook({ toolName: "browser", params: { url: "https://example.com/page" } });
assert.equal(publicPage.params.profile, "bot");
assert.equal(publicPage.params.url, "https://example.com/page");

await afterHook({
  toolName: "browser",
  params: { action: "open", profile: "isolated", targetUrl: "https://example.com" },
  result: {
    content: [
      {
        type: "text",
        text: JSON.stringify({ targetId: "REAL_TARGET_ID", suggestedTargetId: "t1", tabId: "t1" })
      }
    ]
  }
}, { sessionKey: "browser-alias-test" });
const aliasRewrite = await hook({
  toolName: "browser",
  params: { action: "act", targetId: "t1", kind: "click", ref: "e39" }
}, { sessionKey: "browser-alias-test" });
assert.equal(aliasRewrite.params.targetId, "REAL_TARGET_ID");
assert.equal(aliasRewrite.params.profile, "isolated", "later tab actions must inherit the profile that owns the tab");

const allowedMediaPath = path.join(mediaRoot, "inbound.png");
await fs.writeFile(allowedMediaPath, "browser-upload-test");
const localMedia = await hook({ toolName: "browser", params: { url: allowedMediaPath } });
assert.equal(localMedia.params.profile, "bot");

const localMediaWithEmptyRuntimeContext = await hook({
  toolName: "browser",
  params: { action: "upload", paths: [allowedMediaPath] },
  context: { pluginConfig: {} }
});
assert.equal(localMediaWithEmptyRuntimeContext.params.profile, "bot");
assert.ok(localMediaWithEmptyRuntimeContext.params.paths[0].toLowerCase().startsWith(uploadStagingDir.toLowerCase()));
assert.equal(path.dirname(localMediaWithEmptyRuntimeContext.params.paths[0]).toLowerCase(), uploadStagingDir.toLowerCase());
await fs.access(localMediaWithEmptyRuntimeContext.params.paths[0]);

const mediaUriUploadSource = path.join(mediaRoot, "practical-tools", "media-transform", "uri-upload.jpg");
await fs.mkdir(path.dirname(mediaUriUploadSource), { recursive: true });
await fs.writeFile(mediaUriUploadSource, "browser-media-uri-upload-test");
const mediaUriUpload = await hook({
  toolName: "browser",
  params: { action: "upload", paths: ["media://practical-tools/media-transform/uri-upload.jpg"] }
});
assert.ok(mediaUriUpload.params.paths[0].toLowerCase().startsWith(uploadStagingDir.toLowerCase()));
assert.equal(path.dirname(mediaUriUpload.params.paths[0]).toLowerCase(), uploadStagingDir.toLowerCase());
await fs.access(mediaUriUpload.params.paths[0]);

const uploadEvent = {
  toolName: "browser",
  params: { action: "upload", inputRef: "e83", paths: [allowedMediaPath] },
  context: {
    pluginConfig: {
      allowedProfiles: ["bot", "isolated"],
      allowedPathPrefixes: [path.join(os.homedir(), ".openclaw", "media", "inbound")]
    }
  }
};
const localMediaWithManifestDefaultContext = await hook(uploadEvent);
assert.equal(localMediaWithManifestDefaultContext.params.profile, "bot");
assert.ok(localMediaWithManifestDefaultContext.params.paths[0].toLowerCase().startsWith(uploadStagingDir.toLowerCase()));
assert.equal(path.dirname(localMediaWithManifestDefaultContext.params.paths[0]).toLowerCase(), uploadStagingDir.toLowerCase());
assert.equal(localMediaWithManifestDefaultContext.params.selector, "input[type=file]");
assert.equal(Object.hasOwn(localMediaWithManifestDefaultContext.params, "inputRef"), false);
assert.equal(uploadEvent.params.selector, "input[type=file]");

const privateHost = await hook({ toolName: "browser", params: { url: "http://127.0.0.1:18789/" } });
assert.equal(privateHost.params.url, "http://127.0.0.1:18789/");

const rebindingHost = await hook({ toolName: "browser", params: { url: "https://rebinding.example/image.png" } });
assert.equal(rebindingHost.params.url, "https://rebinding.example/image.png");

const localPath = await hook({ toolName: "browser", params: { url: "C:\\Users\\Bot\\.ssh\\id_rsa" } });
assert.equal(localPath.block, true);
assert.match(localPath.blockReason, /restricted/);

const disallowedProfile = await hook({ toolName: "browser", params: { profile: "Default", url: "https://example.com" } });
assert.equal(disallowedProfile.block, true);
assert.match(disallowedProfile.blockReason, /profile is not allowed/);

const ordinaryChromeProfile = await hook({ toolName: "browser", params: { profile: "user", url: "https://example.com" } });
assert.equal(ordinaryChromeProfile.block, true);
assert.match(ordinaryChromeProfile.blockReason, /profile is not allowed/);

const isolatedProfile = await hook({ toolName: "browser", params: { profile: "isolated", url: "https://example.com" } });
assert.equal(isolatedProfile.params.profile, "isolated");

const isolatedGoogle = await hook({ toolName: "browser", params: { profile: "isolated", action: "open", targetUrl: "https://www.google.com/search?q=test" } });
assert.equal(isolatedGoogle.params.profile, "bot", "Google browser work must use the persistent Bot profile");

const profileMutation = await hook({ toolName: "browser", params: { path: "/profiles" } });
assert.equal(profileMutation.params.path, "/profiles");

console.log("browser guard plugin tests passed");

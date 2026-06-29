import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import plugin, { __testing } from "../plugins/imagebot-video-utils/index.js";
import { getBackgroundJobManager } from "../plugins/imagebot-background-jobs/index.js";

const mediaRoot = path.join(os.homedir(), ".openclaw", "media");
const inbound = path.join(mediaRoot, "inbound", "clip.mp4");
const downloaded = path.join(mediaRoot, "downloaded", "20260621", "anim.gif");

assert.equal(__testing.resolveAllowedInput(inbound), path.resolve(inbound));
assert.equal(__testing.resolveAllowedInput(downloaded), path.resolve(downloaded));

assert.throws(
  () => __testing.resolveAllowedInput(path.join(os.homedir(), "Desktop", "private.mp4")),
  /outside the bot media directory/
);

const tools = new Map();
const backgroundStoreDir = path.join(os.tmpdir(), `imagebot-video-bg-${Date.now()}`);
plugin.register({
  config: { backgroundJobs: { storeDir: backgroundStoreDir, maxConcurrent: 1 } },
  registerTool(tool, opts) {
    tools.set(opts?.name || tool.name, tool);
  }
});
assert.ok(tools.has("video_keyframes"));
assert.ok(tools.has("media_brief"));
assert.ok(Object.hasOwn(tools.get("video_keyframes").parameters.properties, "background"));
assert.ok(Object.hasOwn(tools.get("media_brief").parameters.properties, "background"));

const testDir = path.join(mediaRoot, "inbound", "video-utils-test");
await fs.mkdir(testDir, { recursive: true });
const videoPath = path.join(testDir, "unit-bg.mp4");
const videoStickerPath = path.join(testDir, "unit-video-sticker.webm");
const require = createRequire(path.resolve("plugins/imagebot-video-utils/index.js"));
const ffmpeg = require("@ffmpeg-installer/ffmpeg").path;
const madeVideo = spawnSync(ffmpeg, [
  "-hide_banner",
  "-loglevel", "error",
  "-y",
  "-f", "lavfi",
  "-i", "testsrc=duration=1:size=160x90:rate=8",
  "-pix_fmt", "yuv420p",
  videoPath
], { encoding: "utf8" });
assert.equal(madeVideo.status, 0, madeVideo.stderr);

const madeVideoSticker = spawnSync(ffmpeg, [
  "-hide_banner",
  "-loglevel", "error",
  "-y",
  "-f", "lavfi",
  "-i", "testsrc=duration=1:size=512x512:rate=12",
  "-an",
  "-c:v", "libvpx-vp9",
  "-pix_fmt", "yuva420p",
  "-b:v", "0",
  "-crf", "45",
  videoStickerPath
], { encoding: "utf8" });
assert.equal(madeVideoSticker.status, 0, madeVideoSticker.stderr);

const brief = await tools.get("media_brief").execute("media-brief", {
  video: videoPath,
  maxFrames: 4
});
assert.equal(brief.details.status, "ok");
assert.match(brief.content[0].text, /MEDIA_BRIEF ok/);
assert.match(brief.details.probeSummary, /duration|video|size/);
await fs.access(brief.details.keyframes.outputPath);

const videoStickerBrief = await tools.get("media_brief").execute("media-brief-webm-sticker", {
  video: videoStickerPath,
  maxFrames: 4
});
assert.equal(videoStickerBrief.details.status, "ok");
assert.match(videoStickerBrief.content[0].text, /MEDIA_BRIEF ok/);
assert.match(videoStickerBrief.details.input, /unit-video-sticker\.webm/);
assert.match(videoStickerBrief.details.probeSummary, /video=vp9|video=/);
await fs.access(videoStickerBrief.details.keyframes.outputPath);

const background = await tools.get("video_keyframes").execute("video-bg", {
  video: videoPath,
  maxFrames: 4,
  background: true,
  dedupe_key: "unit-video-keyframes-bg"
}, null, null, { agentId: "imagebot", chatId: "unit-chat", sessionKey: "unit-session" });
assert.equal(background.details.status, "ok");
assert.equal(background.details.background, true);
const manager = getBackgroundJobManager({ storeDir: backgroundStoreDir, maxConcurrent: 1 });
const final = await manager.waitForJob(background.details.job.id, 5000);
assert.equal(final.state, "completed");
assert.match(final.result.resultText, /VIDEO_KEYFRAMES ok/);
await fs.access(final.result.outputPath);

console.log("video utils plugin tests passed");

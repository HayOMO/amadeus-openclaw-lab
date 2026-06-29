import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin, { __testing } from "../plugins/imagebot-public-video/index.js";
import { getBackgroundJobManager } from "../plugins/imagebot-background-jobs/index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-public-video-test-"));
const mediaDir = path.join(root, "media");
const storeDir = path.join(root, "store");
const backgroundStoreDir = path.join(root, "background-jobs");
await fs.mkdir(mediaDir, { recursive: true });

const sampleInfo = {
  id: "unit-video-1",
  title: "Unit Test Video",
  uploader: "Unit Channel",
  channel: "Unit Channel",
  duration: 42,
  webpage_url: "https://example.com/watch?v=unit-video-1",
  original_url: "https://example.com/watch?v=unit-video-1",
  extractor: "unit",
  view_count: 1234,
  upload_date: "20260622",
  description: "A public video fixture."
};

const calls = [];
__testing.setYtDlpRunnerForTests(async (url, options = {}) => {
  calls.push({ url, options });
  if (options.dumpSingleJson) return sampleInfo;

  if (options.skipDownload && (options.writeSubs || options.writeAutoSubs)) {
    const out = String(options.output).replace("%(ext)s", "en.vtt");
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:01.000",
      "<c>hello from captions</c>",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "hello from captions",
      "",
      "00:00:02.000 --> 00:00:03.000",
      "second line"
    ].join("\n"), "utf8");
    return "";
  }

  if (options.output) {
    const out = String(options.output).replace("%(ext)s", "mp4");
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, Buffer.from("fake-mp4"));
    return "";
  }

  return "";
});

const tools = new Map();
plugin.register({
  config: {
    mediaDir,
    storeDir,
    maxBytes: 10 * 1024 * 1024,
    maxDurationSeconds: 120,
    backgroundJobs: { storeDir: backgroundStoreDir, maxConcurrent: 2 }
  },
  registerTool(tool, meta) {
    tools.set(meta.name, tool);
  }
});

assert.ok(tools.has("public_video"));
const publicVideo = tools.get("public_video");

const meta = await publicVideo.execute("metadata", {
  action: "metadata",
  url: "https://example.com/watch?v=unit-video-1"
});
assert.equal(meta.details.status, "ok");
assert.equal(meta.details.action, "metadata");
assert.equal(meta.details.metadata.title, "Unit Test Video");
await fs.access(meta.details.metadataPath);
assert.match(meta.content[0].text, /PUBLIC_VIDEO metadata ok/);

const subtitles = await publicVideo.execute("subtitles", {
  action: "subtitles",
  url: "https://example.com/watch?v=unit-video-1",
  languages: "en.*"
});
assert.equal(subtitles.details.status, "ok");
assert.equal(subtitles.details.action, "subtitles");
assert.match(subtitles.details.transcript, /hello from captions/);
assert.match(subtitles.details.transcript, /second line/);
assert.equal((subtitles.details.transcript.match(/hello from captions/g) || []).length, 1);
assert.match(subtitles.content[0].text, /PUBLIC_VIDEO subtitles ok/);

const download = await publicVideo.execute("download", {
  action: "download",
  url: "https://example.com/watch?v=unit-video-1"
});
assert.equal(download.details.status, "ok");
assert.equal(download.details.action, "download");
await fs.access(download.details.mediaPath);
assert.match(download.content[0].text, /MEDIA:/);

const background = await publicVideo.execute("download-bg", {
  action: "download",
  url: "https://example.com/watch?v=unit-video-1",
  background: true,
  dedupe_key: "unit-public-video-download"
}, null, null, { agentId: "imagebot", chatId: "unit-chat", sessionKey: "unit-session" });
assert.equal(background.details.status, "ok");
assert.equal(background.details.background, true);
const manager = getBackgroundJobManager({ storeDir: backgroundStoreDir, maxConcurrent: 2 });
const final = await manager.waitForJob(background.details.job.id, 3000);
assert.equal(final.state, "completed");
assert.match(final.result.resultText, /PUBLIC_VIDEO download ok/);
await fs.access(final.result.mediaPath);

const account = await publicVideo.execute("account", {
  action: "account_download",
  site: "Netease Music"
});
assert.equal(account.details.status, "ok");
assert.equal(account.details.action, "account_placeholder");
assert.equal(account.details.status, "ok");
assert.equal(account.details.result.status, "unavailable");
assert.match(account.content[0].text, /account_placeholder/);

await assert.rejects(
  () => __testing.assertPublicUrl("http://127.0.0.1/video"),
  /private|localhost|internal/i
);
await assert.rejects(
  () => __testing.assertPublicUrl("http://198.18.0.1/video"),
  /private|localhost|internal/i
);

assert.equal(
  __testing.cleanVtt("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<c>same</c>\n\n00:00:01.000 --> 00:00:02.000\nsame\n"),
  "same"
);

assert.ok(calls.some((call) => call.options.dumpSingleJson), "metadata should call yt-dlp metadata probe");
assert.ok(calls.some((call) => call.options.writeAutoSubs), "subtitles should call yt-dlp subtitle extraction");
assert.ok(calls.some((call) => call.options.maxFilesize), "download should pass a max file size");

console.log("public video plugin tests passed");

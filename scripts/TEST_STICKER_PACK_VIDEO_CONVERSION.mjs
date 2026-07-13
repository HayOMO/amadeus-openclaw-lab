import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { __testing } from "../plugins/imagebot-sticker-pack/index.js";
import { resolveFfmpeg } from "../plugins/imagebot-shared/media-runtime.mjs";

const execFileAsync = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-sticker-video-test-"));
const mediaRoot = path.join(root, "media");
const outputRoot = path.join(root, "stickers");
await fs.mkdir(mediaRoot, { recursive: true });

const ffmpeg = resolveFfmpeg(import.meta.url);
const gifPath = path.join(mediaRoot, "animated.gif");
const mp4Path = path.join(mediaRoot, "clip.mp4");
await execFileAsync(ffmpeg, [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=1.2",
  gifPath
]);
await execFileAsync(ffmpeg, [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=240x320:rate=24:duration=1.2",
  "-c:v", "mpeg4", "-q:v", "5",
  mp4Path
]);
assert.equal(await __testing.sourceStickerFormat(gifPath, { format: "static" }), "video");
assert.equal(await __testing.sourceStickerFormat(mp4Path, {}), "video");

const config = {
  mediaDir: outputRoot,
  mediaRoot,
  allowedMediaRoots: [mediaRoot, outputRoot]
};
const batch = await __testing.prepareStickerBatch(config, {
  inputs: [gifPath, mp4Path],
  concurrency: 1,
  contactSheet: true
});

assert.equal(batch.status, "ok");
assert.equal(batch.okCount, 2);
assert.ok(batch.contactSheet?.outputPath.endsWith(".png"));
await fs.access(batch.contactSheet.outputPath);

for (const item of batch.stickers) {
  assert.equal(item.stickerFormat, "video");
  assert.equal(item.mimeType, "video/webm");
  assert.ok(item.outputPath.endsWith(".webm"));
  assert.ok(item.previewPath.endsWith("-preview.png"));
  assert.ok(item.sizeBytes <= 256 * 1024);
  await fs.access(item.outputPath);
  await fs.access(item.previewPath);
  const validation = __testing.validateVideoStickerProbe(
    await __testing.probeStickerMedia(item.outputPath),
    (await fs.stat(item.outputPath)).size
  );
  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(validation.codec, "vp9");
  assert.equal(validation.hasAudio, false);
  assert.ok(validation.durationSeconds <= 3.05);
  assert.ok(validation.fps <= 30.01);
  assert.ok(validation.width === 512 || validation.height === 512);
}

const publishInputs = await __testing.stickerInputsForItems(config, {
  items: [{ input: gifPath, emoji: "🙂" }]
});
assert.equal(publishInputs.stickers[0].format, "video");
assert.equal(publishInputs.files.sticker0.mimeType, "video/webm");
assert.ok(publishInputs.files.sticker0.path.endsWith(".webm"));

console.log("sticker pack GIF/video conversion tests passed");

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveFfmpeg, resolveFfprobe } from "../plugins/imagebot-shared/media-runtime.mjs";

const previousStateDir = process.env.OPENCLAW_STATE_DIR;
const previousFfmpeg = process.env.IMAGEBOT_FFMPEG_PATH;
const previousFfprobe = process.env.IMAGEBOT_FFPROBE_PATH;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "amaduse-media-runtime-"));

try {
  process.env.OPENCLAW_STATE_DIR = root;
  delete process.env.IMAGEBOT_FFMPEG_PATH;
  delete process.env.IMAGEBOT_FFPROBE_PATH;

  const binDir = path.join(root, "runtime", "ffmpeg", "8.1.2", "bin");
  await fs.mkdir(binDir, { recursive: true });
  const ffmpegPath = path.join(binDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const ffprobePath = path.join(binDir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  await fs.writeFile(ffmpegPath, "fixture");
  await fs.writeFile(ffprobePath, "fixture");
  const manifestDir = path.join(root, "runtime", "ffmpeg");
  await fs.writeFile(path.join(manifestDir, "current.json"), JSON.stringify({
    schema: 1,
    version: "8.1.2",
    ffmpegPath,
    ffprobePath
  }));

  assert.equal(resolveFfmpeg(import.meta.url), path.resolve(ffmpegPath));
  assert.equal(resolveFfprobe(import.meta.url), path.resolve(ffprobePath));

  const overridePath = path.join(root, "override-ffmpeg");
  await fs.writeFile(overridePath, "override");
  process.env.IMAGEBOT_FFMPEG_PATH = overridePath;
  assert.equal(resolveFfmpeg(import.meta.url), path.resolve(overridePath), "explicit binary path must win over managed runtime");
} finally {
  if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = previousStateDir;
  if (previousFfmpeg === undefined) delete process.env.IMAGEBOT_FFMPEG_PATH;
  else process.env.IMAGEBOT_FFMPEG_PATH = previousFfmpeg;
  if (previousFfprobe === undefined) delete process.env.IMAGEBOT_FFPROBE_PATH;
  else process.env.IMAGEBOT_FFPROBE_PATH = previousFfprobe;
  await fs.rm(root, { recursive: true, force: true });
}

console.log("media runtime resolver tests passed");

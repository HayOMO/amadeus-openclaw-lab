import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolveFfmpeg, resolveFfprobe } from "../plugins/imagebot-shared/media-runtime.mjs";

const minimum = String(process.env.IMAGEBOT_MIN_FFMPEG_VERSION || "8.1.2");

function inspect(name, executable) {
  const result = spawnSync(executable, ["-version"], { encoding: "utf8" });
  assert.equal(result.status, 0, `${name} -version failed: ${result.stderr || result.error || "unknown error"}`);
  const firstLine = String(result.stdout || "").split(/\r?\n/)[0];
  const match = firstLine.match(/\bversion\s+(?:n)?(\d+)\.(\d+)(?:\.(\d+))?/i);
  assert.ok(match, `unable to parse ${name} version: ${firstLine}`);
  return {
    path: executable,
    version: [Number(match[1]), Number(match[2]), Number(match[3] || 0)],
    firstLine
  };
}

function atLeast(actual, expected) {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > expected[index]) return true;
    if (actual[index] < expected[index]) return false;
  }
  return true;
}

const expected = minimum.split(".").map((part) => Number(part) || 0).slice(0, 3);
while (expected.length < 3) expected.push(0);

const ffmpeg = inspect("ffmpeg", resolveFfmpeg(import.meta.url));
const ffprobe = inspect("ffprobe", resolveFfprobe(import.meta.url));
assert.ok(atLeast(ffmpeg.version, expected), `ffmpeg must be at least ${minimum}: ${ffmpeg.firstLine}`);
assert.ok(atLeast(ffprobe.version, expected), `ffprobe must be at least ${minimum}: ${ffprobe.firstLine}`);

console.log(JSON.stringify({ minimum, ffmpeg, ffprobe }, null, 2));

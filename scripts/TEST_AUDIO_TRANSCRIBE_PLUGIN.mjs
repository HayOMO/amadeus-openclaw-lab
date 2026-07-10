import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import plugin, { __testing } from "../plugins/imagebot-audio-transcribe/index.js";
import { resolveFfmpeg } from "../plugins/imagebot-shared/media-runtime.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-audio-transcribe-test-"));
const mediaRoot = path.join(root, "media");
await fs.mkdir(mediaRoot, { recursive: true });

const ffmpeg = resolveFfmpeg(import.meta.url);
const audioPath = path.join(mediaRoot, "tone.wav");
const mediaUriAudioPath = path.join(mediaRoot, "inbound", "tone.wav");
const madeAudio = spawnSync(ffmpeg, [
  "-hide_banner",
  "-loglevel", "error",
  "-y",
  "-f", "lavfi",
  "-i", "sine=frequency=440:duration=0.4",
  "-ac", "1",
  "-ar", "16000",
  audioPath
], { stdio: "inherit" });
assert.equal(madeAudio.status, 0);
await fs.mkdir(path.dirname(mediaUriAudioPath), { recursive: true });
await fs.copyFile(audioPath, mediaUriAudioPath);

const tools = new Map();
plugin.register({
  config: {
    mediaDir: path.join(root, "out-media"),
    openclawMediaRoot: mediaRoot,
    storeDir: path.join(root, "store"),
    allowedMediaRoots: [mediaRoot]
  },
  registerTool(tool, meta) {
    tools.set(meta.name, tool);
  }
});

assert.ok(tools.has("audio_transcribe"));

const probe = await tools.get("audio_transcribe").execute("probe", {
  action: "probe",
  input: audioPath
});
assert.equal(probe.details.status, "ok");
assert.equal(probe.details.action, "probe");
assert.ok(probe.details.summary.hasAudio);

const mediaUriProbe = await tools.get("audio_transcribe").execute("probe-media-uri", {
  action: "probe",
  input: "media://inbound/tone.wav (audio/wav)"
});
assert.equal(mediaUriProbe.details.status, "ok");
assert.ok(mediaUriProbe.details.summary.hasAudio);

__testing.setTranscriberForTests(async (audio, options) => {
  assert.ok(audio instanceof Float32Array);
  assert.equal(options.language, "zh");
  return { text: "测试音频转写" };
});

const transcribed = await tools.get("audio_transcribe").execute("transcribe", {
  action: "transcribe",
  input: audioPath,
  language: "zh"
});
assert.equal(transcribed.details.status, "ok");
assert.equal(transcribed.details.transcript, "测试音频转写");
await fs.access(transcribed.details.transcriptPath);
assert.match(transcribed.content[0].text, /AUDIO_TRANSCRIBE ok/);

assert.deepEqual(__testing.allowedAsrModels({ allowedModels: ["Xenova/whisper-small"] }), ["Xenova/whisper-tiny", "Xenova/whisper-small"]);
assert.equal(__testing.resolveAsrModel({}, {}), "Xenova/whisper-tiny");
assert.throws(
  () => __testing.resolveAsrModel({}, { model: "attacker/custom-asr" }),
  /model must be one of/
);
assert.equal(__testing.allowRemoteAsrModels({}), true);
assert.equal(__testing.allowRemoteAsrModels({ allowRemoteModels: false }), false);

await assert.rejects(
  () => __testing.resolveAllowedInput({ allowedMediaRoots: [mediaRoot] }, path.join(os.homedir(), "Desktop", "private.mp3")),
  /outside allowed/
);

console.log("audio transcribe plugin tests passed");

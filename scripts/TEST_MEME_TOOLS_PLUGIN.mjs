import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import plugin, { __testing } from "../plugins/imagebot-meme-tools/index.js";
import { getBackgroundJobManager } from "../plugins/imagebot-background-jobs/index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-meme-tools-test-"));
const mediaRoot = path.join(root, "media");
const outRoot = path.join(root, "out");
const bgRoot = path.join(root, "background");
await fs.mkdir(mediaRoot, { recursive: true });

const input = path.join(mediaRoot, "sample.png");
const py = `
from PIL import Image, ImageDraw
img = Image.new("RGBA", (640, 360), (40, 70, 120, 255))
d = ImageDraw.Draw(img)
d.rectangle((80, 80, 560, 280), fill=(245, 245, 255, 255))
d.text((120, 160), "meme tools test", fill=(20, 20, 30, 255))
img.save(r'''${input.replaceAll("\\", "\\\\")}''')
`;
const made = spawnSync("python", ["-c", py], { encoding: "utf8" });
assert.equal(made.status, 0, made.stderr);

const tools = new Map();
plugin.register({
  config: { mediaDir: outRoot, allowedMediaRoots: [mediaRoot], backgroundJobs: { storeDir: bgRoot, maxConcurrent: 1 } },
  registerTool(tool, meta) {
    tools.set(meta.name, tool);
  }
});

assert.ok(tools.has("meme_transform"));
assert.ok(Object.hasOwn(tools.get("meme_transform").parameters.properties, "background"));

const caption = await tools.get("meme_transform").execute("caption", {
  input,
  action: "caption",
  topText: "top caption",
  bottomText: "bottom caption"
});
assert.equal(caption.details.status, "ok");
assert.equal(caption.details.action, "caption");
await fs.access(caption.details.outputPath);
assert.match(caption.content[0].text, /MEDIA:/);

const sticker = await tools.get("meme_transform").execute("sticker", {
  input,
  action: "sticker"
});
assert.equal(sticker.details.status, "ok");
assert.equal(path.extname(sticker.details.outputPath).toLowerCase(), ".webp");

const demotivator = await tools.get("meme_transform").execute("demotivator", {
  input,
  action: "demotivator",
  topText: "实验失败",
  bottomText: "但失败得很有统计价值"
});
assert.equal(demotivator.details.status, "ok");
assert.equal(demotivator.details.action, "demotivator");
assert.equal(path.extname(demotivator.details.outputPath).toLowerCase(), ".png");

const quote = await tools.get("meme_transform").execute("quote", {
  input,
  action: "quote",
  topText: "别把玄学当实验结果",
  bottomText: "Amadeus"
});
assert.equal(quote.details.status, "ok");
assert.equal(quote.details.action, "quote");

const limitCtx = { agentId: "imagebot", chatId: "unit-chat", sessionKey: "unit-session", runId: "meme-limit-run" };
for (let index = 0; index < 3; index++) {
  const limitedOk = await tools.get("meme_transform").execute(`limit-ok-${index}`, {
    input,
    action: "caption",
    topText: `loop ${index}`
  }, null, null, limitCtx);
  assert.equal(limitedOk.details.status, "ok");
}
const limitedMeme = await tools.get("meme_transform").execute("limit-blocked", {
  input,
  action: "caption",
  topText: "loop 4"
}, null, null, limitCtx);
assert.equal(limitedMeme.details.status, "limited");
assert.match(limitedMeme.content[0].text, /3\/3/);

const background = await tools.get("meme_transform").execute("bg", {
  input,
  action: "reaction",
  text: "background meme",
  background: true,
  dedupe_key: "unit-meme-bg"
}, null, null, { agentId: "imagebot", chatId: "unit-chat", sessionKey: "unit-session" });
assert.equal(background.details.status, "ok");
assert.equal(background.details.background, true);
const manager = getBackgroundJobManager({ storeDir: bgRoot, maxConcurrent: 1 });
const final = await manager.waitForJob(background.details.job.id, 5000);
assert.equal(final.state, "completed");
assert.match(final.result.resultText, /MEME_TRANSFORM ok/);
await fs.access(final.result.mediaPath);

await assert.rejects(
  () => __testing.resolveAllowedInput({ mediaDir: outRoot, allowedMediaRoots: [mediaRoot] }, path.join(os.homedir(), "Desktop", "private.png")),
  /outside allowed/
);

console.log("meme tools plugin tests passed");

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import plugin from "../plugins/imagebot-sticker-pack/index.js";

const require = createRequire(import.meta.url);
const oldSharp = require("../plugins/imagebot-memory-search/node_modules/sharp");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-sticker-sharp-isolation-"));
const mediaRoot = path.join(root, "media");
const outRoot = path.join(root, "stickers");
const tokenPath = path.join(root, "token.txt");
await fs.mkdir(mediaRoot, { recursive: true });
await fs.writeFile(tokenPath, "TEST_TOKEN", "utf8");

const inputPath = path.join(mediaRoot, "source.png");
await oldSharp({
  create: {
    width: 96,
    height: 64,
    channels: 4,
    background: { r: 40, g: 160, b: 255, alpha: 1 }
  }
}).png().toFile(inputPath);

const tools = new Map();
plugin.register({
  config: {
    mediaDir: outRoot,
    mediaRoot,
    tokenFile: tokenPath,
    botUsername: "YOUR_BOT_USERNAME",
    allowedMediaRoots: [mediaRoot, outRoot]
  },
  registerTool(tool, meta) {
    tools.set(meta.name, tool);
  },
  registerHook() {}
});

const result = await tools.get("sticker_pack").execute("sharp-isolation", {
  action: "prepare_batch",
  inputs: [inputPath],
  contactSheet: true
});

assert.equal(result.details.status, "ok");
assert.equal(result.details.okCount, 1);
assert.ok(result.details.stickers[0].outputPath.endsWith(".webp"));
assert.ok(result.details.contactSheet.outputPath.endsWith(".png"));
await fs.access(result.details.stickers[0].outputPath);
await fs.access(result.details.contactSheet.outputPath);

console.log("sticker pack sharp isolation test passed");

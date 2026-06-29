import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  buildSafetyReviewPrompt,
  evaluateLoliNsfwRisk,
  screenImage
} from "../plugins/imagebot-shared/loli-nsfw-vision-guard.mjs";

function risk(input) {
  return evaluateLoliNsfwRisk(input, {
    loliThreshold: 0.28
  });
}

assert.equal(risk({
  predictions: {
    loliScores: [["loli", 0.01]]
  }
}).blocked, false, "ordinary adult NSFW without loli signal must not be blocked");

assert.equal(risk({
  predictions: {
    loliScores: [["loli", 0.7]]
  }
}).blocked, true, "loli image should be withheld regardless of separate NSFW signals");

const modelBlocked = risk({
  predictions: {
    loliScores: [["loli", 0.7]]
  }
});
assert.equal(modelBlocked.blocked, true);
assert.equal(modelBlocked.action, "withhold_vision");
assert.equal(modelBlocked.reason, "model_loli");

const metadataBlocked = risk({ text: "\u841d\u8389 image set" });
assert.equal(metadataBlocked.blocked, true);
assert.equal(metadataBlocked.reason, "metadata_loli");

assert.equal(risk({
  text: "shota r18 child",
  predictions: {
    loliScores: [["loli", 0.01]]
  }
}).blocked, false, "non-loli minor wording must not count as a loli signal");

const prompt = buildSafetyReviewPrompt({ blockedCount: 2 });
assert.match(prompt, /withheld 2 image/);
assert.match(prompt, /were not sent to the vision model/);

const modelPath = path.join(os.homedir(), ".openclaw", "models", "wd-v1-4-vit-tagger-v2", "model.onnx");
try {
  await fs.access(modelPath);
  const require = createRequire(path.join(process.cwd(), "plugins", "imagebot-practical-tools", "index.js"));
  const sharp = require("sharp");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loli-guard-test-"));
  const image = path.join(tmp, "blank.png");
  await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ffffff" } }).png().toFile(image);
  const result = await screenImage(image, { text: "ordinary smoke test" }, {
    dependencyDirs: [
      path.join(process.cwd(), "plugins", "imagebot-practical-tools"),
      path.join(process.cwd(), "plugins", "imagebot-memory-search")
    ]
  });
  assert.equal(result.blocked, false);
  assert.equal(result.action, "allow");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

console.log("loli vision guard tests passed");

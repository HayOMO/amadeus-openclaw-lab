import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const distDir = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Microsoft",
  "WinGet",
  "Packages",
  "OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe",
  "node-v24.15.0-win-x64",
  "node_modules",
  "openclaw",
  "dist",
);

async function importDist(name) {
  return await import(pathToFileURL(path.join(distDir, name)).href);
}

async function importDistByPrefix(prefix, marker) {
  const names = await fs.readdir(distDir);
  for (const name of names.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".js")).sort()) {
    const source = await fs.readFile(path.join(distDir, name), "utf8");
    if (!marker || source.includes(marker)) {
      return await importDist(name);
    }
  }
  throw new Error(`No dist file found for ${prefix} with marker ${marker || "(none)"}`);
}

const cfg = {
  models: {
    providers: {
      openai: {}
    }
  },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.5" },
      models: { "openai/gpt-5.5": {} },
      imageModel: { primary: "openai/gpt-5.5" }
    },
    list: [{
      id: "imagebot",
      model: "openai/gpt-5.5",
      models: { "openai/gpt-5.5": {} },
      params: {
        reasoningEffort: "medium",
        textVerbosity: "low"
      }
    }]
  },
  tools: {
    media: {
      image: {
        timeoutSeconds: 420
      }
    }
  }
};

const runner = await importDistByPrefix("runner-", "primary model supports vision natively");
const effectiveRoute = await importDistByPrefix("effective-reply-route-", "imageOrder");

const mediaDir = path.join(os.homedir(), ".openclaw", "media", "inbound", "multimodal-route-test");
await fs.mkdir(mediaDir, { recursive: true });
const imagePath = path.join(mediaDir, "native-vision.png");
await fs.writeFile(
  imagePath,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJ8Y2wAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const ctx = {
  MediaPath: imagePath,
  MediaType: "image/png",
};

const media = runner.s(ctx);
assert.equal(media.length, 1, "fixture image should be visible to OpenClaw media attachment normalization");

const nativeVisionDecision = await runner.a({
  capability: "image",
  cfg,
  ctx,
  media,
  providerRegistry: runner.t(undefined, cfg),
  activeModel: { provider: "openai", model: "gpt-5.5" },
  agentId: "imagebot",
  agentDir: process.cwd(),
  workspaceDir: process.cwd(),
});

assert.deepEqual(nativeVisionDecision.outputs, []);
assert.equal(nativeVisionDecision.decision.outcome, "skipped");
assert.equal(nativeVisionDecision.decision.attachments[0]?.chosen?.provider, "openai");
assert.equal(nativeVisionDecision.decision.attachments[0]?.chosen?.model, "gpt-5.5");
assert.equal(
  nativeVisionDecision.decision.attachments[0]?.chosen?.reason,
  "primary model supports vision natively",
  "GPT-5.5 image turns must skip text-only image understanding instead of spending an extra image-model pass",
);

const currentTurnImages = await effectiveRoute.a({
  ctx,
  cfg,
  images: undefined,
  imageOrder: undefined,
});

assert.equal(currentTurnImages.images?.length, 1, "native vision skip must still leave an image block for the chat model");
assert.equal(currentTurnImages.images[0]?.type, "image");
assert.equal(currentTurnImages.images[0]?.mimeType, "image/png");
assert.ok(currentTurnImages.images[0]?.data?.length > 0, "native image block should carry image bytes");
assert.deepEqual(currentTurnImages.imageOrder, ["inline"]);

console.log("imagebot multimodal route tests passed", {
  media: media.length,
  nativeImages: currentTurnImages.images.length,
  model: "openai/gpt-5.5",
});

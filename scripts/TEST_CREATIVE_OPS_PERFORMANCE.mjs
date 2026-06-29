import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import creativeOps from "../plugins/imagebot-creative-ops/index.js";
import agentOps from "../plugins/imagebot-agent-ops/index.js";
import featureCore from "../plugins/imagebot-feature-core/index.js";
import interactionCore from "../plugins/imagebot-interaction-core/index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-creative-perf-"));
const tools = new Map();
const hooks = [];

function register(plugin, config) {
  plugin.register({
    config,
    registerTool(tool, opts) {
      tools.set(opts?.name || tool.name, tool);
    },
    registerHook(name, handler) {
      if (name === "before_prompt_build") hooks.push(handler);
    }
  });
}

register(interactionCore, {
  botUsernames: ["YOUR_BOT_USERNAME"],
  triggerPrefixes: ["助手", "amadeus", "kurisu"],
  appendInteractionContext: true
});
register(agentOps, { storeDir: path.join(root, "agent-ops") });
register(featureCore, {
  storeDir: path.join(root, "feature-core"),
  featuresDir: path.join(process.cwd(), "features"),
  timezoneOffsetMinutes: 480
});
register(creativeOps, {
  storeDir: path.join(root, "creative-ops"),
  repoRoot: process.cwd(),
  appendFeedbackHints: true,
  allowMutatingScripts: true
});

function time(label, fn) {
  return Promise.resolve().then(async () => {
    const t0 = performance.now();
    await fn();
    return { label, ms: performance.now() - t0 };
  });
}

for (let i = 0; i < 80; i++) {
  await tools.get("image_feedback").execute(`fb-${i}`, {
    action: "record",
    rating: i % 3 === 0 ? "bad" : i % 3 === 1 ? "good" : "mixed",
    subject: `character ${i % 9}`,
    keep: "clean official anime cel style, accurate colors",
    avoid: "generic fanart drift, wrong hair color",
    notes: `synthetic feedback row ${i}`,
    tags: ["perf", "image"]
  });
}

const results = [];
results.push(await time("script route", async () => {
  await tools.get("script_action").execute("route", { action: "route", query: "backup memory to github", count: 5 });
}));
results.push(await time("command route", async () => {
  await tools.get("command_catalog").execute("route", { action: "route", query: "show generated gallery recent images", count: 5 });
}));
results.push(await time("feature route", async () => {
  await tools.get("feature_catalog").execute("route", { action: "route", query: "daily checkin leaderboard", count: 5 });
}));
results.push(await time("interaction route", async () => {
  await tools.get("interaction_pipeline").execute("route", {
    action: "evaluate",
    text: "@YOUR_BOT_USERNAME daily checkin",
    isGroup: true,
    botUsername: "YOUR_BOT_USERNAME",
    userId: "10001",
    chatId: "-100test"
  });
}));
results.push(await time("prompt search", async () => {
  await tools.get("prompt_library").execute("search", { action: "search", query: "official character wallpaper negative", count: 5 });
}));
results.push(await time("prompt compose", async () => {
  await tools.get("prompt_library").execute("compose", {
    action: "compose",
    request: "official character sticker",
    card_ids: ["recipe.official_character_generation", "recipe.meme_sticker", "negative.common_anime_failures"]
  });
}));
results.push(await time("feedback search", async () => {
  await tools.get("image_feedback").execute("search", { action: "search", query: "wrong hair color official character", count: 5 });
}));
results.push(await time("prompt hooks", async () => {
  for (const hook of hooks) {
    await hook({ prompt: "draw an official character with accurate colors and no fanart drift" }, { agentId: "imagebot", sessionKey: "perf" });
  }
}));

const maxMs = Math.max(...results.map((item) => item.ms));
assert.ok(maxMs < 250, `hot-path/local tool perf regression: ${JSON.stringify(results)}`);
for (const item of results) console.log(`${item.label}: ${item.ms.toFixed(1)}ms`);
console.log("creative-ops performance tests passed");

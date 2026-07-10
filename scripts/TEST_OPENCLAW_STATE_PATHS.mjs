import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { buildImagebotConfig } from "./BUILD_IMAGEBOT_CONFIG.mjs";
import {
  openclawHomeDir,
  openclawStateDir,
  openclawStatePath
} from "../plugins/imagebot-shared/openclaw-paths.mjs";
import { openclawMediaRoot } from "../plugins/imagebot-shared/media-uri.mjs";

const previous = {
  OPENCLAW_HOME: process.env.OPENCLAW_HOME,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR
};

try {
  const alternateHome = path.join(os.tmpdir(), "amadesu-openclaw-home");
  delete process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_HOME = alternateHome;
  assert.equal(openclawHomeDir(), path.resolve(alternateHome));
  assert.equal(openclawStateDir(), path.join(path.resolve(alternateHome), ".openclaw"));

  const alternateState = path.join(os.tmpdir(), "amadesu-openclaw-state");
  process.env.OPENCLAW_STATE_DIR = alternateState;
  assert.equal(openclawStateDir(), path.resolve(alternateState));
  assert.equal(openclawStatePath("media", "inbound"), path.join(path.resolve(alternateState), "media", "inbound"));
  assert.equal(openclawMediaRoot({}), path.join(path.resolve(alternateState), "media"));

  const built = await buildImagebotConfig({ write: false, template: true });
  const operations = new Map(built.configOps.map((operation) => [operation.path, operation.value]));
  const stateRoot = path.resolve(alternateState);

  const webSearch = operations.get("plugins.entries.web-image-search.config");
  assert.equal(webSearch.openclawMediaRoot, path.join(stateRoot, "media"));
  assert.equal(webSearch.danbooru.secretFile, path.join(stateRoot, "secrets", "danbooru-imagebot.json"));

  const gallery = operations.get("plugins.entries.imagebot-generated-gallery.config");
  assert.equal(gallery.archiveRoot, path.join(stateRoot, "media", "archive"));
  assert.equal(gallery.storeDir, path.join(stateRoot, "generated-gallery"));

  const interaction = operations.get("plugins.entries.imagebot-interaction-core.config");
  assert.equal(interaction.marsForwardDetector.statePath, path.join(stateRoot, "imagebot", "mars-forward-detector.json"));
  assert.equal(interaction.loliNsfwVisionGuard.modelDir, path.join(stateRoot, "models", "wd-v1-4-vit-tagger-v2"));

  const agentOps = operations.get("plugins.entries.imagebot-agent-ops.config");
  assert.equal(agentOps.windowStorePath, path.join(stateRoot, "agents", "imagebot", "sessions", "sessions.json.telegram-imagebot-windows.json"));

  console.log(`openclaw state path tests passed (${stateRoot})`);
} finally {
  if (previous.OPENCLAW_HOME === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = previous.OPENCLAW_HOME;
  if (previous.OPENCLAW_STATE_DIR === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = previous.OPENCLAW_STATE_DIR;
}

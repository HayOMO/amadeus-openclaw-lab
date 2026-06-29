import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __testing } from "../plugins/imagebot-feature-core/index.js";

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(name);
}

function option(name, fallback = "") {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  return fallback;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function pathExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function asPositiveInt(value, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const apply = flag("--apply") || flag("--run");
const limit = asPositiveInt(option("--limit", "50"), 50);
const configPath = path.resolve(option(
  "--config",
  path.join(os.homedir(), ".openclaw", "openclaw.json")
));
const openclawConfig = await readJson(configPath, null);
if (!openclawConfig) {
  throw new Error(`Could not read OpenClaw config: ${configPath}`);
}

const pluginConfig = openclawConfig?.plugins?.entries?.["imagebot-feature-core"]?.config || {};
const archiveConfig = __testing.gachaArchiveConfig(pluginConfig);
const archiveRoot = path.resolve(
  archiveConfig.localDir || path.join(os.homedir(), ".openclaw", "feature-core", "gacha-archive")
);
const recordsDir = path.join(archiveRoot, "records");
const names = (await fs.readdir(recordsDir).catch(() => []))
  .filter((name) => name.endsWith(".json"))
  .sort();

const candidates = [];
for (const name of names) {
  const recordPath = path.join(recordsDir, name);
  const record = await readJson(recordPath, null);
  if (!record || record.channel?.status === "ok") continue;
  const media = await pathExists(record.localPath)
    ? record.localPath
    : await pathExists(record.sendPath)
      ? record.sendPath
      : "";
  candidates.push({
    recordPath,
    archiveId: record.archiveId || path.basename(name, ".json"),
    media,
    record
  });
}

const selected = candidates.slice(0, limit);
const summary = {
  apply,
  configPath,
  archiveRoot,
  scanned: names.length,
  failedOrMissingChannel: candidates.length,
  selected: selected.length,
  repaired: 0,
  skipped: 0,
  failed: 0,
  results: []
};

for (const item of selected) {
  const base = {
    archiveId: item.archiveId,
    previousStatus: item.record.channel?.status || "missing",
    postId: item.record.postId || null,
    name: item.record.name || "",
    media: Boolean(item.media)
  };
  if (!item.media) {
    summary.skipped += 1;
    summary.results.push({ ...base, status: "skipped:no_media" });
    continue;
  }
  if (!apply) {
    summary.skipped += 1;
    summary.results.push({ ...base, status: "dry-run" });
    continue;
  }
  try {
    const archive = await __testing.runGachaArchive(pluginConfig, {
      media: item.media,
      postId: item.record.postId || "",
      name: item.record.name || "",
      rarity: item.record.rarity || "",
      score: item.record.score ?? null,
      pageUrl: item.record.pageUrl || "",
      sourceUrl: item.record.sourceUrl || "",
      primaryTags: item.record.primaryTags || [],
      archiveTags: item.record.archiveTags || [],
      characterTags: item.record.characterTags || [],
      copyrightTags: item.record.copyrightTags || [],
      artistTags: item.record.artistTags || [],
      tagString: item.record.tagString || "",
      safeStatus: item.record.safeStatus || "unknown",
      censored: Boolean(item.record.censored),
      userId: item.record.userId || "",
      chatId: item.record.chatId || "",
      displayName: item.record.displayName || "",
      caption: item.record.caption || "",
      sendToChannel: true
    });
    if (archive.channel?.status === "ok") summary.repaired += 1;
    else summary.failed += 1;
    summary.results.push({
      ...base,
      status: archive.channel?.status || "unknown",
      attempts: archive.channel?.attempts || null,
      messageId: archive.channel?.messageId || null,
      error: archive.channel?.error || ""
    });
  } catch (error) {
    summary.failed += 1;
    summary.results.push({
      ...base,
      status: "failed",
      error: String(error?.message || error).slice(0, 300)
    });
  }
}

console.log(JSON.stringify(summary, null, 2));

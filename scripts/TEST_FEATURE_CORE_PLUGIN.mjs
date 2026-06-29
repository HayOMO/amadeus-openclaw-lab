import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import featureCore, { __testing } from "../plugins/imagebot-feature-core/index.js";
import { getBackgroundJobManager } from "../plugins/imagebot-background-jobs/index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-feature-core-test-"));
const featuresDir = path.join(root, "features");
const archiveInputDir = path.join(root, "archive-input");
const gachaArchiveDir = path.join(root, "gacha-archive");
const gachaArchiveSendDir = path.join(root, "gacha-send-media");
const backgroundJobsDir = path.join(root, "background-jobs");
await fs.mkdir(featuresDir, { recursive: true });
for (const entry of await fs.readdir(path.join(process.cwd(), "features"))) {
  if (entry.endsWith(".json")) {
    await fs.copyFile(path.join(process.cwd(), "features", entry), path.join(featuresDir, entry));
  }
}
const waifuFeaturePath = path.join(featuresDir, "waifu_gacha.json");
const waifuFeature = JSON.parse(await fs.readFile(waifuFeaturePath, "utf8"));
waifuFeature.config = waifuFeature.config || {};
waifuFeature.config.danbooru = { ...(waifuFeature.config.danbooru || {}), enabled: false };
waifuFeature.actions = (waifuFeature.actions || []).map((action) => ({
  ...action,
  cooldown: { ...(action.cooldown || {}), seconds: 0 }
}));
await fs.writeFile(waifuFeaturePath, JSON.stringify(waifuFeature, null, 2), "utf8");

const tools = new Map();
const featureCoreConfig = {
  storeDir: path.join(root, "store"),
  featuresDir,
  timezoneOffsetMinutes: 480,
  backgroundJobs: { storeDir: backgroundJobsDir, maxConcurrent: 2 },
  gachaArchive: {
    enabled: true,
    localDir: gachaArchiveDir,
    sendDir: gachaArchiveSendDir,
    channelChatId: "",
    tokenFile: path.join(root, "missing-telegram.token"),
    allowedMediaRoots: [archiveInputDir]
  }
};
featureCore.register({
  config: featureCoreConfig,
  registerTool(tool, opts) {
    tools.set(opts?.name || tool.name, tool);
  }
});

assert.ok(tools.has("feature_catalog"));
assert.ok(tools.has("feature_action"));
assert.ok(tools.has("gacha_archive"));

const features = await __testing.loadFeatures({ featuresDir });
assert.ok(features.length >= 2);
assert.ok(features.some((feature) => feature.id === "checkin"));
assert.ok(features.some((feature) => feature.id === "daily_fortune"));
assert.ok(features.some((feature) => feature.id === "waifu_gacha"));
const waifuFeatureForTags = features.find((feature) => feature.id === "waifu_gacha");
const tagPlans = __testing.danbooruTagPlansForCard(waifuFeatureForTags, {
  id: "science_test",
  element: "science",
  danbooruTags: ["labcoat", "glasses", "school_uniform"]
});
assert.ok(tagPlans.length >= 3);
assert.ok(tagPlans.every((tags) => tags.length <= 4));
assert.ok(tagPlans[0].includes("labcoat"));
assert.ok(tagPlans.some((tags) => tags.includes("glasses")));
assert.deepEqual(tagPlans.at(-1), ["1girl"]);

const srBand = __testing.scoreBandForRarity(waifuFeatureForTags, "SR");
assert.deepEqual({ min: srBand.min, max: srBand.max }, { min: 51, max: 100 });
assert.equal(__testing.scoreBandTag(srBand), "score:51..100");
assert.equal(__testing.scoreInBand(80, srBand), true);
assert.equal(__testing.scoreInBand(101, srBand), false);
const urPlans = __testing.danbooruQueryPlansForRarity(waifuFeatureForTags, "UR", "unit-test-seed");
assert.deepEqual(urPlans[0].tags, ["1girl", "score:>=300", "order:random"]);
assert.deepEqual(urPlans.at(-1).tags, ["1girl", "score:>=300"]);

const percentRateConfig = __testing.danbooruConfig({
  config: {
    danbooru: {
      rates: { N: 40, R: 50, SR: 8, SSR: 1.67, UR: 0.33 },
      pity: { urHard: 300, ssrSoftStart: 50, ssrBonusPerMiss: 2 }
    }
  }
});
assert.ok(Math.abs(percentRateConfig.rates.UR - 0.0033) < 0.000001);
assert.ok(Math.abs(percentRateConfig.rates.N - 0.4) < 0.000001);
assert.ok(Math.abs(__testing.effectiveSsrRate({ pitySSR: 50 }, percentRateConfig) - 0.0367) < 0.000001);
assert.equal(__testing.gachaArchiveConfig({ gachaArchive: { channelChatId: "-100channel" } }).channelChatId, "-100channel");
assert.equal(__testing.gachaArchiveConfig({ channelChatId: "-100direct" }).channelChatId, "-100direct");
const archiveCaption = __testing.buildGachaArchiveCaption({
  postId: "12345",
  name: "Test Waifu",
  rarity: "SSR",
  score: 150,
  pageUrl: "https://safebooru.donmai.us/posts/12345",
  sourceUrl: "https://cdn.donmai.us/original/example.jpg",
  primaryTags: ["solo", "smile"],
  archiveTags: ["score_150", "1girl"],
  characterTags: ["test_girl"],
  copyrightTags: ["test_series"],
  artistTags: ["test_artist"],
  safeStatus: "clear",
  censored: false
}, "danbooru-12345-test");
assert.match(archiveCaption, /#waifu_gacha/);
assert.match(archiveCaption, /#rarity_ssr/);
assert.match(archiveCaption, /#character_test_girl/);
assert.match(archiveCaption, /#series_test_series/);
assert.match(archiveCaption, /#artist_test_artist/);
assert.match(archiveCaption, /Character: test_girl/);
assert.match(archiveCaption, /Source: https:\/\/cdn\.donmai\.us\/original\/example\.jpg/);

assert.equal(__testing.chooseRarity({ pityUR: 299, pitySSR: 0 }, "pity-ur", false, {
  rates: { N: 0.4, R: 0.5, SR: 0.08, SSR: 0.0167, UR: 0.0033 },
  pity: { urHard: 300, ssrSoftStart: 50, ssrBonusPerMiss: 0.02 }
}), "UR");
assert.ok(__testing.effectiveSsrRate({ pitySSR: 50 }, {
  rates: { SSR: 0.0167 },
  pity: { ssrSoftStart: 50, ssrBonusPerMiss: 0.02 }
}) > 0.03);

const rarityThresholds = { R: 45, SR: 120, SSR: 300, UR: 900 };
assert.equal(__testing.rarityFromPopularity(0, rarityThresholds), "N");
assert.equal(__testing.rarityFromPopularity(45, rarityThresholds), "R");
assert.equal(__testing.rarityFromPopularity(120, rarityThresholds), "SR");
assert.equal(__testing.rarityFromPopularity(300, rarityThresholds), "SSR");
assert.equal(__testing.rarityFromPopularity(900, rarityThresholds), "UR");

const goodPost = {
  id: 12345,
  rating: "g",
  file_ext: "jpg",
  image_width: 1200,
  image_height: 1600,
  score: 140,
  fav_count: 420,
  down_score: 0,
  tag_count: 42,
  file_url: "https://cdn.donmai.us/original/example.jpg",
  preview_file_url: "https://cdn.donmai.us/preview/example.jpg",
  tag_string: "1girl solo smile labcoat",
  tag_string_character: "test_girl",
  tag_string_copyright: "test_series",
  tag_string_artist: "test_artist",
  tag_string_general: "1girl solo smile labcoat"
};
assert.equal(__testing.isSafeDanbooruPost(goodPost, {
  blockedTags: [],
  minScore: 20,
  minFavCount: 0,
  minWidth: 512,
  minHeight: 512,
  minPixels: 300000,
  maxAspectRatio: 4,
  minTagCount: 12
}), true);
assert.equal(__testing.isSafeDanbooruPost({ ...goodPost, image_width: 240, image_height: 240 }, {
  blockedTags: [],
  minScore: 20,
  minFavCount: 0,
  minWidth: 512,
  minHeight: 512,
  minPixels: 300000,
  maxAspectRatio: 4,
  minTagCount: 12
}), false);
assert.equal(__testing.isSafeDanbooruPost({ ...goodPost, rating: "s" }, {
  blockedTags: [],
  minScore: 20,
  minFavCount: 0,
  minWidth: 512,
  minHeight: 512,
  minPixels: 300000,
  maxAspectRatio: 4,
  minTagCount: 12
}), false);
const safetyConfig = __testing.danbooruConfig({ config: { danbooru: { excludeTags: [] } } });
assert.equal(safetyConfig.blockedTags.includes("loli"), false);
assert.equal(__testing.isSafeDanbooruPost({
  ...goodPost,
  tag_string: `${goodPost.tag_string} loli`,
  tag_string_general: `${goodPost.tag_string_general} loli`
}, safetyConfig), true);

const postImage = __testing.pickDanbooruImage(goodPost);
assert.ok(postImage);
assert.equal(postImage.imageUrl, goodPost.file_url);
assert.equal(postImage.imageQuality, "original");
assert.equal(postImage.popularity, __testing.danbooruPopularityScore(goodPost));
const postCard = __testing.danbooruImageToCard(postImage, waifuFeatureForTags);
assert.equal(postCard.id, "danbooru:12345");
assert.equal(postCard.sourceKind, "danbooru_post");
assert.equal(postCard.rarity, "UR");
assert.match(postCard.name, /test girl/i);
const forcedPostCard = __testing.danbooruImageToCard(postImage, waifuFeatureForTags, "SR");
assert.equal(forcedPostCard.rarity, "SR");
const embeddedSeriesCard = __testing.danbooruImageToCard({
  ...postImage,
  postId: 67890,
  tags: {
    ...postImage.tags,
    character: ["la_pluma_(arknights)"],
    copyright: ["arknights"]
  }
}, waifuFeatureForTags, "R");
assert.equal(embeddedSeriesCard.name, "la pluma (arknights)");

const listed = await tools.get("feature_catalog").execute("list", { action: "list" });
assert.equal(listed.details.status, "ok");
assert.ok(listed.details.features.some((feature) => feature.id === "checkin"));
assert.ok(listed.details.features.some((feature) => feature.id === "waifu_gacha"));

const validation = await tools.get("feature_catalog").execute("validate", { action: "validate" });
assert.equal(validation.details.status, "ok");
assert.equal(validation.details.validation.ok, true);
assert.equal(validation.details.validation.summary.errors, 0);

const brokenValidation = __testing.validateFeatureManifests([{
  id: "broken_feature",
  title: "Broken",
  handler: "builtin.missing",
  triggers: ["same"],
  actions: [
    { id: "go", risk: "mystery", permission: "everyone", cooldown: { scope: "moon", seconds: -1 } },
    { id: "go" }
  ]
}, {
  id: "other_feature",
  title: "Other",
  handler: "builtin.checkin",
  triggers: ["same"],
  actions: [{ id: "checkin", description: "ok" }]
}]);
assert.equal(brokenValidation.ok, false);
assert.ok(brokenValidation.issues.some((issue) => issue.code === "unknown_handler"));
assert.ok(brokenValidation.issues.some((issue) => issue.code === "duplicate_action_id"));
assert.ok(brokenValidation.issues.some((issue) => issue.code === "duplicate_trigger"));

const routed = await tools.get("feature_catalog").execute("route", {
  action: "route",
  query: "今天签到打卡",
  count: 3
});
assert.equal(routed.details.status, "ok");
assert.equal(routed.details.results[0].feature.id, "checkin");

const gachaRouted = await tools.get("feature_catalog").execute("route-gacha", {
  action: "route",
  query: "抽二次元老婆十连",
  count: 3
});
assert.equal(gachaRouted.details.status, "ok");
assert.equal(gachaRouted.details.results[0].feature.id, "waifu_gacha");

const fortuneRouted = await tools.get("feature_catalog").execute("route-fortune", {
  action: "route",
  query: "daily fortune lab omen",
  count: 3
});
assert.equal(fortuneRouted.details.status, "ok");
assert.equal(fortuneRouted.details.results[0].feature.id, "daily_fortune");

const dryRun = await tools.get("feature_action").execute("dry", {
  feature: "checkin",
  action: "checkin",
  userId: "tg:10001",
  displayName: "Alice",
  dryRun: true
});
assert.equal(dryRun.details.status, "ok");

const backgroundDryRun = await tools.get("feature_action").execute("dry-background", {
  feature: "checkin",
  action: "checkin",
  userId: "tg:10001",
  displayName: "Alice",
  dryRun: true,
  background: true,
  dedupe_key: "unit-feature-dry-run"
}, null, null, { agentId: "imagebot", chatId: "-100test", sessionKey: "unit-session" });
assert.equal(backgroundDryRun.details.status, "ok");
assert.equal(backgroundDryRun.details.background, true);
const backgroundFeatureManager = getBackgroundJobManager({ storeDir: backgroundJobsDir, maxConcurrent: 2 });
const backgroundDryFinal = await backgroundFeatureManager.waitForJob(backgroundDryRun.details.job.id, 3000);
assert.equal(backgroundDryFinal.state, "completed");
assert.match(backgroundDryFinal.result.resultText, /FEATURE_RESULT|dryRun ok/);

const first = await tools.get("feature_action").execute("first", {
  feature: "checkin",
  action: "checkin",
  userId: "tg:10001",
  userName: "alice",
  displayName: "Alice",
  chatId: "-100test"
});
assert.equal(first.details.status, "ok");
assert.equal(first.details.result.kind, "checkin_result");
assert.equal(first.details.result.alreadyCheckedIn, false);
assert.ok(first.details.result.gainedPoints >= 5);
assert.equal(first.details.result.user.streak, 1);

const second = await tools.get("feature_action").execute("second", {
  feature: "checkin",
  action: "checkin",
  userId: "10001",
  displayName: "Alice",
  chatId: "-100test"
});
assert.equal(second.details.status, "ok");
assert.equal(second.details.result.alreadyCheckedIn, true);
assert.equal(second.details.result.gainedPoints, 0);
assert.equal(second.details.result.user.userId, "tg:10001");

const status = await tools.get("feature_action").execute("status", {
  feature: "checkin",
  action: "status",
  userId: "tg:10001"
});
assert.equal(status.details.status, "ok");
assert.equal(status.details.result.alreadyCheckedIn, true);

const leaderboard = await tools.get("feature_action").execute("leaderboard", {
  feature: "checkin",
  action: "leaderboard",
  payload: { count: 5 }
});
assert.equal(leaderboard.details.status, "ok");
assert.equal(leaderboard.details.result.users[0].userId, "tg:10001");

const fortune = await tools.get("feature_action").execute("daily-fortune", {
  feature: "daily_fortune",
  action: "draw",
  userId: "tg:10001",
  userName: "alice",
  displayName: "Alice",
  chatId: "-100test"
});
assert.equal(fortune.details.status, "ok");
assert.equal(fortune.details.result.kind, "daily_fortune_result");
assert.equal(fortune.details.result.alreadyDrawn, false);
assert.ok(fortune.details.result.result.score >= 1);
assert.match(fortune.details.result.replyText, /score/);

const fortuneRepeat = await tools.get("feature_action").execute("daily-fortune-repeat", {
  feature: "daily_fortune",
  action: "draw",
  userId: "10001",
  displayName: "Alice",
  chatId: "-100test"
});
assert.equal(fortuneRepeat.details.status, "ok");
assert.equal(fortuneRepeat.details.result.alreadyDrawn, true);
assert.equal(fortuneRepeat.details.result.result.seed, fortune.details.result.result.seed);

const fortuneLeaderboard = await tools.get("feature_action").execute("daily-fortune-board", {
  feature: "daily_fortune",
  action: "leaderboard",
  payload: { count: 5 }
});
assert.equal(fortuneLeaderboard.details.status, "ok");
assert.equal(fortuneLeaderboard.details.result.kind, "daily_fortune_leaderboard");
assert.equal(fortuneLeaderboard.details.result.users[0].userId, "tg:10001");

const dailyWaifu = await tools.get("feature_action").execute("daily-waifu", {
  feature: "waifu_gacha",
  action: "daily",
  userId: "tg:10001",
  userName: "alice",
  displayName: "Alice",
  chatId: "-100test"
});
assert.equal(dailyWaifu.details.status, "ok");
assert.equal(dailyWaifu.details.result.kind, "waifu_gacha_daily");
assert.equal(dailyWaifu.details.result.alreadyDrawn, false);
assert.ok(["N", "R", "SR", "SSR", "UR"].includes(dailyWaifu.details.result.draw.card.rarity));
assert.match(dailyWaifu.details.result.replyText, /今日老婆/);
assert.match(dailyWaifu.details.result.replyText, /[NRSU]{1,3}/);
assert.ok(Array.isArray(dailyWaifu.details.result.resultImages));
assert.equal(dailyWaifu.details.result.deliveryReview.mode, "script_cache");
assert.ok(Array.isArray(dailyWaifu.details.result.albumMedia));
assert.ok(!("tagString" in (dailyWaifu.details.result.draw.image || {})));

const dailyWaifuRepeat = await tools.get("feature_action").execute("daily-waifu-repeat", {
  feature: "waifu_gacha",
  action: "daily",
  userId: "10001",
  displayName: "Alice",
  chatId: "-100test"
});
assert.equal(dailyWaifuRepeat.details.status, "ok");
assert.equal(dailyWaifuRepeat.details.result.alreadyDrawn, true);
assert.equal(dailyWaifuRepeat.details.result.draw.card.id, dailyWaifu.details.result.draw.card.id);
assert.match(dailyWaifuRepeat.details.result.replyText, /今日已抽过/);

const singleWaifu = await tools.get("feature_action").execute("single-waifu", {
  feature: "waifu_gacha",
  action: "draw",
  userId: "tg:10001",
  displayName: "Alice",
  chatId: "-100test"
});
assert.equal(singleWaifu.details.status, "ok");
assert.equal(singleWaifu.details.result.kind, "waifu_gacha_draw");
assert.equal(singleWaifu.details.result.count, 1);
assert.match(singleWaifu.details.result.replyText, /你这次抽到的老婆是：/);
assert.ok(!("archiveCaption" in singleWaifu.details.result));
assert.ok(Array.isArray(singleWaifu.details.result.resultImages));
assert.equal(singleWaifu.details.result.deliveryReview.mode, "script_cache");
assert.ok(Array.isArray(singleWaifu.details.result.albumMedia));

const limitedWaifu = await tools.get("feature_action").execute("limited-waifu", {
  feature: "waifu_gacha",
  action: "draw",
  userId: "tg:10003",
  displayName: "Carol",
  chatId: "-100test",
  payload: { count: 99 }
});
assert.equal(limitedWaifu.details.status, "ok");
assert.equal(limitedWaifu.details.result.count, 10);
assert.equal(limitedWaifu.details.result.requestLimit.limited, true);
assert.equal(limitedWaifu.details.result.requestLimit.requestedCount, 99);
assert.equal(limitedWaifu.details.result.requestLimit.appliedCount, 10);
assert.match(limitedWaifu.details.result.replyText, /本次最多十连/);

const tenPull = await tools.get("feature_action").execute("ten-waifu", {
  feature: "waifu_gacha",
  action: "ten_pull",
  userId: "tg:10002",
  displayName: "Bob",
  chatId: "-100test"
});
assert.equal(tenPull.details.status, "ok");
assert.equal(tenPull.details.result.kind, "waifu_gacha_ten_pull");
assert.equal(tenPull.details.result.results.length, 10);
assert.ok(tenPull.details.result.results.some((item) => ["SR", "SSR", "UR"].includes(item.card.rarity)));
assert.match(tenPull.details.result.replyText, /十连结果/);
assert.match(tenPull.details.result.replyText, /本轮老婆/);
assert.ok(!("archiveCaptions" in tenPull.details.result));
assert.ok(Array.isArray(tenPull.details.result.resultImages));
assert.equal(tenPull.details.result.deliveryReview.imageCount, tenPull.details.result.resultImages.length);
assert.equal(tenPull.details.result.deliveryReview.mode, "script_cache");
assert.ok(Array.isArray(tenPull.details.result.albumMedia));

const tenPullDuplicate = await tools.get("feature_action").execute("ten-waifu-dup", {
  feature: "waifu_gacha",
  action: "ten_pull",
  userId: "tg:10002",
  displayName: "Bob",
  chatId: "-100test"
});
assert.equal(tenPullDuplicate.details.status, "ok");
assert.equal(tenPullDuplicate.details.result.duplicateRequest, true);
assert.equal(tenPullDuplicate.details.result.suppressFinalReply, true);
assert.equal(tenPullDuplicate.details.result.batchId, tenPull.details.result.batchId);
assert.match(tenPullDuplicate.details.result.replyText, /suppressed/);
assert.equal(Array.isArray(tenPullDuplicate.details.result.resultImages), false);
assert.equal(Array.isArray(tenPullDuplicate.details.result.results), false);

const drawEventsPath = path.join(root, "store", "gacha-draw-events.jsonl");
const drawEvents = (await fs.readFile(drawEventsPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.ok(drawEvents.length >= 22);
assert.ok(drawEvents.some((event) => event.batchId === tenPull.details.result.batchId && event.action === "ten_pull"));
const duplicateBatchEvents = drawEvents.filter((event) => event.batchId === tenPullDuplicate.details.result.batchId);
assert.equal(duplicateBatchEvents.length, 10);

await fs.mkdir(archiveInputDir, { recursive: true });
const archiveInputPath = path.join(archiveInputDir, "final-waifu.png");
await fs.writeFile(archiveInputPath, Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d
]));
const archived = await tools.get("gacha_archive").execute("archive-waifu", {
  media: archiveInputPath,
  batchId: tenPull.details.result.batchId,
  postId: "12345",
  name: "Test Waifu",
  rarity: "SSR",
  score: 150,
  pageUrl: "https://safebooru.donmai.us/posts/12345",
  sourceUrl: "https://cdn.donmai.us/original/example.jpg",
  primaryTags: ["test_girl", "test_series"],
  archiveTags: ["1girl", "solo", "smile", "test_series"],
  characterTags: ["test_girl"],
  copyrightTags: ["test_series"],
  artistTags: ["test_artist"],
  tagString: "1girl solo smile test_girl test_series test_artist",
  safeStatus: "clear",
  censored: false,
  userId: "tg:10002",
  chatId: "-100test"
});
assert.equal(archived.details.status, "ok");
assert.equal(archived.details.archive.postId, "12345");
assert.deepEqual(archived.details.archive.characterTags, ["test_girl"]);
assert.deepEqual(archived.details.archive.copyrightTags, ["test_series"]);
assert.deepEqual(archived.details.archive.artistTags, ["test_artist"]);
assert.match(archived.details.archive.caption, /#character_test_girl/);
assert.match(archived.details.archive.caption, /#series_test_series/);
assert.match(archived.details.archive.caption, /#artist_test_artist/);
assert.equal(archived.details.archive.channel.status, "skipped:send_disabled");
assert.match(archived.content[0].text, /MEDIA:/);
await fs.access(archived.details.archive.localPath);
await fs.access(archived.details.archive.sendPath);
assert.ok(archived.details.archive.sendPath.startsWith(gachaArchiveSendDir));
assert.match(archived.content[0].text, new RegExp(archived.details.archive.sendPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
const archiveIndexPath = path.join(gachaArchiveDir, "gacha-archive-index.jsonl");
const archiveIndex = (await fs.readFile(archiveIndexPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.ok(archiveIndex.some((entry) => entry.archiveId === archived.details.archive.archiveId));

const archivedDuplicate = await tools.get("gacha_archive").execute("archive-waifu-dup", {
  media: archiveInputPath,
  postId: "12345",
  name: "Test Waifu",
  rarity: "SSR",
  safeStatus: "clear"
});
assert.equal(archivedDuplicate.details.status, "ok");
assert.equal(archivedDuplicate.details.archive.duplicate, true);
assert.equal(archivedDuplicate.details.archive.archiveId, archived.details.archive.archiveId);

const originalFetch = globalThis.fetch;
let archiveSendAttempts = 0;
let archiveSawSpoiler = false;
const channelTokenFile = path.join(root, "telegram.token");
await fs.writeFile(channelTokenFile, "123456:test-token", "utf8");
featureCoreConfig.gachaArchive.channelChatId = "-100channel";
featureCoreConfig.gachaArchive.tokenFile = channelTokenFile;
featureCoreConfig.gachaArchive.telegramRetryDelaysMs = [1, 1, 1];
try {
  globalThis.fetch = async (_url, init) => {
    archiveSendAttempts += 1;
    if (init?.body?.get?.("has_spoiler") === "true") archiveSawSpoiler = true;
    if (archiveSendAttempts < 3) throw new Error("Network request for 'sendPhoto' failed!");
    return new Response(JSON.stringify({
      ok: true,
      result: {
        message_id: 777,
        photo: [{ file_id: "small" }, { file_id: "full" }]
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const archivedChannelRetry = await tools.get("gacha_archive").execute("archive-channel-retry", {
    media: archiveInputPath,
    postId: "67890",
    name: "Retry Waifu",
    rarity: "SR",
    score: 80,
    safeStatus: "r18",
    censored: false,
    sendToChannel: true
  });
  assert.equal(archivedChannelRetry.details.status, "ok");
  assert.equal(archivedChannelRetry.details.archive.channel.status, "ok");
  assert.equal(archivedChannelRetry.details.archive.channel.attempts, 3);
  assert.equal(archivedChannelRetry.details.archive.channel.messageId, 777);
  assert.equal(archivedChannelRetry.details.archive.channel.fileId, "full");
  assert.equal(archivedChannelRetry.details.archive.spoiler, true);
  assert.equal(archiveSawSpoiler, true);
  assert.equal(archiveSendAttempts, 3);
} finally {
  globalThis.fetch = originalFetch;
  featureCoreConfig.gachaArchive.channelChatId = "";
  featureCoreConfig.gachaArchive.tokenFile = path.join(root, "missing-telegram.token");
  delete featureCoreConfig.gachaArchive.telegramRetryDelaysMs;
}

const explicitSpoilerArchive = await tools.get("gacha_archive").execute("archive-explicit", {
  media: archiveInputPath,
  postId: "99999",
  name: "Blocked",
  rarity: "SR",
  safeStatus: "r18",
  censored: false
});
assert.equal(explicitSpoilerArchive.details.status, "ok");
assert.equal(explicitSpoilerArchive.details.archive.spoiler, true);
assert.equal(explicitSpoilerArchive.details.archive.channel.status, "skipped:send_disabled");
assert.match(explicitSpoilerArchive.content[0].text, /MEDIA:/);

const collection = await tools.get("feature_action").execute("waifu-collection", {
  feature: "waifu_gacha",
  action: "collection",
  userId: "tg:10001",
  displayName: "Alice"
});
assert.equal(collection.details.status, "ok");
assert.equal(collection.details.result.kind, "waifu_gacha_collection");
assert.ok(collection.details.result.cards.length >= 1);
assert.match(collection.details.result.replyText, /图鉴/);

const gachaProfile = await tools.get("feature_action").execute("waifu-profile", {
  feature: "waifu_gacha",
  action: "profile",
  userId: "tg:10001",
  displayName: "Alice"
});
assert.equal(gachaProfile.details.status, "ok");
assert.equal(gachaProfile.details.result.kind, "waifu_gacha_profile");
assert.equal(gachaProfile.details.result.user.userId, "tg:10001");
assert.ok(Object.hasOwn(gachaProfile.details.result.user.rarityCounts, "SSR"));
assert.match(gachaProfile.details.result.replyText, /gacha profile/);

const gachaStats = await tools.get("feature_action").execute("waifu-stats", {
  feature: "waifu_gacha",
  action: "stats"
});
assert.equal(gachaStats.details.status, "ok");
assert.equal(gachaStats.details.result.kind, "waifu_gacha_stats");
assert.ok(gachaStats.details.result.stats.totalDraws >= 1);
assert.match(gachaStats.details.result.replyText, /gacha lab stats/);

const gachaLeaderboard = await tools.get("feature_action").execute("waifu-leaderboard", {
  feature: "waifu_gacha",
  action: "leaderboard",
  payload: { count: 5 }
});
assert.equal(gachaLeaderboard.details.status, "ok");
assert.equal(gachaLeaderboard.details.result.kind, "waifu_gacha_leaderboard");
assert.ok(gachaLeaderboard.details.result.users.length >= 1);
assert.match(gachaLeaderboard.details.result.replyText, /老婆图鉴榜/);

console.log("feature-core plugin tests passed");

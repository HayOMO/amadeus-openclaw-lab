import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import plugin, { __testing } from "../plugins/imagebot-pixiv-resource/index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-pixiv-resource-test-"));
const tokenFile = path.join(root, "secrets", "pixiv-refresh.token");
const mediaDir = path.join(root, "media");
const storeDir = path.join(root, "store");
await fs.mkdir(path.dirname(tokenFile), { recursive: true });
await fs.writeFile(tokenFile, "REFRESH_TOKEN_FIXTURE", "utf8");

const sampleMeta = {
  id: 123456789,
  title: "Unit Pixiv Ranking",
  user: { id: 2468, name: "Unit Artist" },
  tags: ["original", "1girl", "unit_test"],
  total_bookmarks: 9876,
  total_view: 54321,
  page_count: 1,
  date: "2026-06-22 00:00:00"
};

const secondMeta = {
  ...sampleMeta,
  id: 123456790,
  title: "Unit Pixiv Ranking 2",
  total_bookmarks: 8765,
  total_view: 43210
};

const blockedMeta = {
  ...sampleMeta,
  id: 987654321,
  title: "Blocked Fixture",
  tags: ["R-18", "original", "1girl", "loli"],
  rating: "R-18",
  x_restrict: 1,
  sanity_level: 6
};

const adultMeta = {
  ...sampleMeta,
  id: 222222222,
  title: "Adult Fixture",
  tags: ["R-18", "original", "1girl"],
  rating: "R-18",
  x_restrict: 1,
  sanity_level: 6
};

const calls = [];
let activeDownloads = 0;
let maxActiveDownloads = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rangeFileCount(args) {
  const index = args.indexOf("--range");
  const raw = index >= 0 ? String(args[index + 1] || "1-1") : "1-1";
  const match = raw.match(/^(\d+)-(\d+)$/);
  if (!match) return 1;
  const start = Math.max(1, Number(match[1]));
  const end = Math.max(start, Number(match[2]));
  return Math.max(1, Math.min(10, end - start + 1));
}

__testing.setSpawnForTests((cmd, args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit("close", 1);
  calls.push({ cmd, args });
  queueMicrotask(async () => {
    try {
      if (args.includes("-j")) {
        const targetUrl = String(args[args.length - 1] || "");
        const events = targetUrl.includes("987654321")
          ? [
              [2, blockedMeta],
              [3, "https://i.pximg.net/img-original/blocked.jpg", blockedMeta]
            ]
          : targetUrl.includes("222222222")
            ? [
                [2, adultMeta],
                [3, "https://i.pximg.net/img-original/adult.jpg", adultMeta]
              ]
          : targetUrl.includes("123456790")
            ? [
                [2, secondMeta],
                [3, "https://i.pximg.net/img-original/unit2.jpg", secondMeta]
              ]
          : targetUrl.includes("ranking.php")
            ? [
                [2, blockedMeta],
                [3, "https://i.pximg.net/img-original/blocked.jpg", blockedMeta],
                [2, sampleMeta],
                [3, "https://i.pximg.net/img-original/unit.jpg", sampleMeta],
                [2, secondMeta],
                [3, "https://i.pximg.net/img-original/unit2.jpg", secondMeta]
              ]
            : [
                [2, sampleMeta],
                [3, "https://i.pximg.net/img-original/unit.jpg", sampleMeta]
              ];
        const output = JSON.stringify(events);
        child.stdout.emit("data", Buffer.from(output));
      } else {
        activeDownloads += 1;
        maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
        try {
          const dir = args[args.indexOf("-D") + 1];
          const targetUrl = String(args[args.length - 1] || "");
          const downloadMeta = targetUrl.includes("222222222") ? adultMeta : targetUrl.includes("123456790") ? secondMeta : sampleMeta;
          await delay(targetUrl.includes("123456789") ? 25 : 10);
          await fs.mkdir(dir, { recursive: true });
          const files = rangeFileCount(args);
          for (let index = 0; index < files; index += 1) {
            const imagePath = path.join(dir, `${downloadMeta.id}_p${index}.jpg`);
            await fs.writeFile(imagePath, Buffer.from(`fake-pixiv-image-${index}`));
            await fs.writeFile(`${imagePath}.json`, JSON.stringify(downloadMeta), "utf8");
            const old = new Date("2020-01-01T00:00:00Z");
            await fs.utimes(imagePath, old, old);
          }
        } finally {
          activeDownloads -= 1;
        }
      }
      child.emit("close", 0);
    } catch (error) {
      child.stderr.emit("data", Buffer.from(String(error?.message || error)));
      child.emit("close", 1);
    }
  });
  return child;
});

const tools = new Map();
plugin.register({
  config: { refreshTokenFile: tokenFile, mediaDir, storeDir },
  registerTool(tool, meta) {
    tools.set(meta.name, tool);
  }
});

assert.ok(tools.has("pixiv_resource"));
const pixiv = tools.get("pixiv_resource");

assert.equal(__testing.rankingMode("day"), "daily");
assert.equal(__testing.rankingMode("daily_r18"), "daily_r18");
assert.equal(__testing.rankingMode("r18g"), "r18g");
assert.equal(__testing.rankingDate("2026-06-22"), "20260622");
assert.match(__testing.rankingUrl({ mode: "week", date: "20260622" }), /mode=weekly/);
assert.throws(() => __testing.normalizePixivUrl("https://example.com/artworks/1"), /pixiv\.net/);
assert.equal(__testing.isAdultPixivMode("daily_r18"), true);
assert.equal(__testing.isAdultPixivUrl("https://www.pixiv.net/ranking.php?mode=daily_r18"), true);
assert.equal(__testing.hasAdultPixivItems([__testing.publicItem(sampleMeta, 1)], { url: "https://www.pixiv.net/ranking.php?mode=daily_r18" }), true);
assert.equal(__testing.hasBlockedSafetyTag(__testing.publicItem({
  id: 333,
  title: "General loli fixture",
  tags: ["original", "loli"],
  rating: "General",
  x_restrict: 0
}), {}, { url: "https://www.pixiv.net/ranking.php?mode=daily" }), false);
assert.equal(__testing.hasBlockedSafetyTag(__testing.publicItem({
  id: 334,
  title: "Adult loli fixture",
  tags: ["R-18", "loli"],
  rating: "R-18",
  x_restrict: 1
}), {}, { url: "https://www.pixiv.net/artworks/334" }), true);
assert.equal(__testing.readMinBookmarkCount({ minBookmarkCount: 500 }), 500);
assert.equal(__testing.readMinBookmarkCount({ minBookmarks: 200 }), 200);
assert.deepEqual(
  __testing.filterPopularityItems([
    __testing.publicItem(sampleMeta, 1),
    __testing.publicItem(secondMeta, 2)
  ], { minBookmarkCount: 9000 }),
  {
    allowed: [__testing.publicItem(sampleMeta, 1)],
    skippedPopularity: 1,
    minBookmarkCount: 9000
  }
);

const ranking = await pixiv.execute("ranking", {
  action: "ranking",
  mode: "daily_r18",
  count: 5,
  downloadCount: 2
});
assert.equal(ranking.details.status, "ok");
assert.equal(ranking.details.action, "ranking");
assert.equal(ranking.details.result.items.length, 2);
assert.equal(ranking.details.result.skippedBlocked, 1);
assert.equal(ranking.details.result.mode, "daily_r18");
assert.equal(ranking.details.media.mediaUrls.length, 2);
assert.equal(ranking.details.media.outbound, false);
assert.equal(ranking.details.media.sensitiveMedia, true);
assert.equal(ranking.details.result.sensitiveMedia, true);
assert.equal(ranking.details.media.visionContextImages, 2);
assert.equal(ranking.details.result.diagnostics.downloadConcurrency, 2);
assert.equal(ranking.details.result.diagnostics.attemptedWorks, 2);
assert.ok(maxActiveDownloads > 1, "ranking media downloads should use bounded concurrency");
assert.equal(ranking.content.some((item) => item.type === "image"), true);
assert.match(ranking.content[0].text, /PIXIV_RESOURCE ranking ok/);
assert.match(ranking.content[0].text, /download_diag: concurrency=2 attempted=2 failed=0/);
assert.match(ranking.content[0].text, /^SPOILER_MEDIA:/m);
assert.doesNotMatch(ranking.content[0].text, /^MEDIA:/m);
assert.match(ranking.content[0].text, /safety_filter: skipped=1/);
assert.equal(ranking.content[0].text.includes("Blocked Fixture"), false);

const qualityRanking = await pixiv.execute("ranking-quality", {
  action: "ranking",
  mode: "daily",
  count: 5,
  minBookmarkCount: 9000
});
assert.equal(qualityRanking.details.status, "ok");
assert.equal(qualityRanking.details.result.items.length, 1);
assert.equal(qualityRanking.details.result.items[0].id, 123456789);
assert.equal(qualityRanking.details.result.skippedPopularity, 1);
assert.match(qualityRanking.content[0].text, /quality_filter: minBookmarkCount=9000 skipped=1/);

const detail = await pixiv.execute("detail", {
  action: "detail",
  illustId: 123456789
});
assert.equal(detail.details.status, "ok");
assert.equal(detail.details.result.items[0].id, 123456789);
assert.match(detail.content[0].text, /Unit Pixiv Ranking/);

const download = await pixiv.execute("download", {
  action: "download",
  url: "https://www.pixiv.net/artworks/123456789",
  downloadCount: 1
});
assert.equal(download.details.status, "ok");
assert.equal(download.details.media.mediaUrls.length, 1);
assert.equal(download.details.media.outbound, false);
assert.equal(download.details.media.sensitiveMedia, undefined);
assert.equal(download.details.media.visionContextImages, 1);
assert.equal(download.content.some((item) => item.type === "image"), true);
assert.match(download.content[0].text, /^MEDIA:/m);
await fs.access(download.details.media.mediaUrls[0]);
const normalDownloadCall = [...calls].reverse().find((call) => !call.args.includes("-j") && String(call.args[call.args.length - 1] || "").includes("123456789"));
assert.equal(normalDownloadCall.args[normalDownloadCall.args.indexOf("--range") + 1], "1-1");

const adultDownload = await pixiv.execute("download-adult", {
  action: "download",
  illustId: 222222222,
  downloadCount: 1
});
assert.equal(adultDownload.details.status, "ok");
assert.equal(adultDownload.details.media.mediaUrls.length, 1);
assert.equal(adultDownload.details.media.outbound, false);
assert.equal(adultDownload.details.media.sensitiveMedia, true);
assert.equal(adultDownload.details.result.sensitiveMedia, true);
assert.equal(adultDownload.details.media.visionContextImages, 1);
assert.equal(adultDownload.content.some((item) => item.type === "image"), true);
assert.match(adultDownload.content[0].text, /^SPOILER_MEDIA:/m);
await fs.access(adultDownload.details.media.mediaUrls[0]);

const recent = await pixiv.execute("recent", { action: "recent", count: 5 });
assert.equal(recent.details.status, "ok");
assert.equal(recent.details.media.outbound, false);
assert.equal(recent.details.media.sensitiveMedia, true);
assert.equal(recent.details.media.visionContextImages, 3);
assert.match(recent.content[0].text, /^SPOILER_MEDIA:/m);

const downloadCallsBeforeBlocked = calls.filter((call) => !call.args.includes("-j")).length;
const blockedDownload = await pixiv.execute("download-blocked", {
  action: "download",
  illustId: 987654321,
  downloadCount: 1
});
const downloadCallsAfterBlocked = calls.filter((call) => !call.args.includes("-j")).length;
assert.equal(blockedDownload.details.status, "blocked");
assert.equal(blockedDownload.details.media.mediaUrls.length, 0);
assert.equal(blockedDownload.details.result.skippedBlocked, 1);
assert.equal(downloadCallsAfterBlocked, downloadCallsBeforeBlocked, "blocked Pixiv items must not enter media download");
assert.match(blockedDownload.content[0].text, /PIXIV_RESOURCE download blocked/);

const auth = await pixiv.execute("auth", { action: "auth_check" });
assert.equal(auth.details.status, "ok");
assert.equal(auth.details.result.ok, true);

assert.ok(calls.some((call) => call.args.includes("--config-json")), "gallery-dl must use a token config file");
assert.ok(calls.some((call) => call.args.includes("--post-range")), "gallery-dl calls should bound post range");
assert.ok(calls.some((call) => call.args.includes("--no-mtime")), "gallery-dl downloads should keep current mtimes when possible");
assert.ok(calls.every((call) => !call.args.some((arg) => String(arg).includes("REFRESH_TOKEN_FIXTURE"))), "token must not appear in process args");

__testing.resetForTests();
console.log("pixiv resource plugin tests passed");

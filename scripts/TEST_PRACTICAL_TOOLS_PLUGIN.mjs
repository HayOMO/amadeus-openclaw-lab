import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import plugin, { __testing } from "../plugins/imagebot-practical-tools/index.js";
import { getBackgroundJobManager } from "../plugins/imagebot-background-jobs/index.js";
import { __testing as manualTesting } from "../plugins/imagebot-tool-manual-search/index.js";

const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-practical-tools-test-"));
const mediaDir = path.join(storeDir, "media");
const backgroundStoreDir = path.join(storeDir, "background-jobs");
await fs.mkdir(mediaDir, { recursive: true });

const tools = new Map();
plugin.register({
  config: { storeDir, mediaDir, openclawMediaRoot: mediaDir, backgroundJobs: { storeDir: backgroundStoreDir, maxConcurrent: 2 } },
  registerTool(tool, opts) {
    tools.set(opts?.name || tool.name, tool);
  }
});

for (const name of [
  "web_snapshot",
  "web_card",
  "media_transform",
  "artifact",
  "artifact_recent",
  "artifact_search",
  "artifact_get",
  "qr_tool",
  "pdf_render",
  "av_media",
  "text_toolkit",
  "web_watch_add",
  "web_watch_list",
  "web_watch_check",
  "web_watch_delete"
]) {
  assert.ok(tools.has(name), `${name} should be registered`);
}

const blocked = await tools.get("web_snapshot").execute("blocked", { url: "http://127.0.0.1/" });
assert.equal(blocked.details.status, "failed");
assert.match(blocked.content[0].text, /private|internal/i);

const weiboPlatform = __testing.accountBrowserPlatformForUrl("https://s.weibo.com/weibo?q=test");
assert.equal(weiboPlatform.id, "weibo");
assert.equal(__testing.accountBrowserPlatformForUrl("https://example.com/"), null);
assert.equal(__testing.accountBrowserPlatformForUrl("https://music.163.com/"), null);
assert.equal(__testing.accountBrowserPlatformForUrl("https://demo.lofter.com/post/1").id, "lofter");
assert.equal(__testing.accountBrowserActionProfile([]).tier, "read");
assert.equal(__testing.accountBrowserActionProfile([{ type: "scroll" }]).tier, "light");
assert.equal(__testing.accountBrowserActionProfile([{ type: "scroll" }, { type: "wait" }, { type: "scroll" }]).tier, "light");
assert.equal(__testing.accountBrowserActionProfile([{ type: "click_text" }]).tier, "interactive");
assert.equal(__testing.classifyBrowserRiskPage(weiboPlatform, "https://passport.weibo.com/sso/signin", ""), "login_redirect");
assert.equal(__testing.classifyBrowserRiskPage(weiboPlatform, "https://s.weibo.com/weibo", "请完成验证码"), "verification_or_risk_wall");
assert.ok(__testing.accountBrowserProfileDir({ storeDir }, weiboPlatform).endsWith(path.join("browser-profiles", "account", "weibo")));
await assert.doesNotReject(() => __testing.assertBrowserRequestUrlAllowed("https://example.com/", new Map(), {
  dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }]
}));
await assert.rejects(() => __testing.assertBrowserRequestUrlAllowed("http://127.0.0.1/private"), /private|internal/i);
await assert.rejects(() => __testing.assertBrowserRequestUrlAllowed("file:///%USERPROFILE%/.ssh/id_rsa"), /scheme is blocked/i);

const riskStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-browser-risk-test-"));
const riskConfig = { storeDir: riskStoreDir, accountBrowserRisk: { minIntervalMs: 60_000, hourlyLimit: 5, dailyLimit: 10, actionLimit: 1 } };
const firstRiskClaim = await __testing.claimBrowserRiskVisit(riskConfig, weiboPlatform, "https://s.weibo.com/weibo?q=test", 1);
assert.equal(firstRiskClaim.tracked, true);
assert.equal(firstRiskClaim.platform.id, "weibo");
assert.equal(firstRiskClaim.tier, "interactive");
await assert.rejects(
  () => __testing.claimBrowserRiskVisit(riskConfig, weiboPlatform, "https://s.weibo.com/weibo?q=test2", 2),
  /up to 1 action/
);
await assert.rejects(
  () => __testing.claimBrowserRiskVisit(riskConfig, weiboPlatform, "https://s.weibo.com/weibo?q=test2", 1),
  /cooldown/
);
const lightLimitStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-browser-risk-light-limit-test-"));
const lightLimitConfig = { storeDir: lightLimitStoreDir, accountBrowserRisk: { tiers: { light: { minIntervalMs: 0, hourlyLimit: 5, dailyLimit: 10, actionLimit: 1 } } } };
await assert.rejects(
  () => __testing.claimBrowserRiskVisit(lightLimitConfig, weiboPlatform, "https://s.weibo.com/weibo?q=scrolls", [{ type: "scroll" }, { type: "wait" }]),
  /light mode allows up to 1 action/
);
const budgetStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-browser-risk-budget-test-"));
const budgetConfig = { storeDir: budgetStoreDir, accountBrowserRisk: { tiers: { read: { minIntervalMs: 0, hourlyLimit: 2, dailyLimit: 3, actionLimit: 0 } } } };
await __testing.claimBrowserRiskVisit(budgetConfig, weiboPlatform, "https://s.weibo.com/weibo?q=1", 0);
await __testing.claimBrowserRiskVisit(budgetConfig, weiboPlatform, "https://s.weibo.com/weibo?q=2", 0);
await assert.rejects(
  () => __testing.claimBrowserRiskVisit(budgetConfig, weiboPlatform, "https://s.weibo.com/weibo?q=3", 0),
  /budget/
);
const untrackedRisk = await __testing.claimBrowserRiskVisit(budgetConfig, null, "https://example.com/", 10);
assert.equal(untrackedRisk.tracked, false);
const concurrentStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-browser-risk-concurrent-test-"));
const concurrentConfig = { storeDir: concurrentStoreDir, accountBrowserRisk: { tiers: { read: { minIntervalMs: 0, hourlyLimit: 1, dailyLimit: 10, actionLimit: 0 } } } };
const concurrentResults = await Promise.allSettled([
  __testing.claimBrowserRiskVisit(concurrentConfig, weiboPlatform, "https://s.weibo.com/weibo?q=a", 0),
  __testing.claimBrowserRiskVisit(concurrentConfig, weiboPlatform, "https://s.weibo.com/weibo?q=b", 0)
]);
assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(concurrentResults.filter((result) => result.status === "rejected").length, 1);
const backoffStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-browser-risk-backoff-test-"));
const backoffConfig = { storeDir: backoffStoreDir, accountBrowserRisk: { verificationBackoffMs: 60_000, tiers: { read: { minIntervalMs: 0, hourlyLimit: 5, dailyLimit: 10, actionLimit: 0 } } } };
await __testing.claimBrowserRiskVisit(backoffConfig, weiboPlatform, "https://s.weibo.com/weibo?q=risk", 0);
await __testing.recordBrowserRiskEvent(backoffConfig, weiboPlatform, { kind: "verification_or_risk_wall", url: "https://s.weibo.com/weibo?q=risk" });
await assert.rejects(
  () => __testing.claimBrowserRiskVisit(backoffConfig, weiboPlatform, "https://s.weibo.com/weibo?q=after-risk", 0),
  /backoff/
);

assert.equal(
  __testing.classifyBrowserRiskPage(null, "https://example.com/", "Sorry, you have been blocked\nCloudflare Ray ID: test", "Attention Required! | Cloudflare"),
  "cloudflare_block"
);
assert.equal(
  __testing.classifyBrowserRiskPage(null, "https://example.com/cdn-cgi/challenge-platform/h/b", "Just a moment...\nChecking your browser", ""),
  "cloudflare_challenge"
);
const scrollPlan = __testing.readWebScrollPlan({ scrollMode: "bottom", scrollSteps: 99, scrollWaitMs: 9999 }, 768);
assert.equal(scrollPlan.mode, "bottom");
assert.equal(scrollPlan.scrollSteps, 8);
assert.equal(scrollPlan.scrollWaitMs, 2500);
const originalFetch = globalThis.fetch;
let redirectFetchCalls = 0;
__testing.clearRedirectProbeCache();
globalThis.fetch = async () => {
  redirectFetchCalls += 1;
  const error = new Error("redirect probe timed out");
  error.name = "AbortError";
  throw error;
};
try {
  const redirected = await __testing.resolveRedirects("https://example.com/slow");
  assert.equal(redirected.finalUrl, "https://example.com/slow");
  assert.match(redirected.probeError, /timed out/);
  const cachedRedirect = await __testing.resolveRedirects("https://example.com/slow");
  assert.equal(cachedRedirect.finalUrl, "https://example.com/slow");
  assert.match(cachedRedirect.probeError, /timed out/);
  assert.equal(redirectFetchCalls, 1);
  assert.equal(__testing.redirectProbeCacheStats().entries, 1);
} finally {
  globalThis.fetch = originalFetch;
  __testing.clearRedirectProbeCache();
}

const snapshot = await tools.get("web_snapshot").execute("snapshot", {
  url: "https://example.com",
  waitMs: 100,
  actions: [{ type: "scroll", pixels: 120, waitMs: 50 }],
  scrollMode: "one_page",
  scrollWaitMs: 50,
  maxTextChars: 1000
});
assert.equal(snapshot.details.status, "ok");
assert.ok(await fs.stat(snapshot.details.path).then((stat) => stat.isFile()));
assert.match(snapshot.content[0].text, /Example Domain/);
assert.match(snapshot.content[0].text, /actions: scroll:ok/);
assert.match(snapshot.content[0].text, /scroll: y=\d+\/\d+/);
assert.ok(snapshot.details.scroll);
assert.equal(snapshot.details.browserProfile, "ephemeral-public");
await assert.rejects(
  () => fs.stat(path.join(storeDir, "browser-profiles", "web-snapshot-pool")),
  /ENOENT/
);
const snapshotId = snapshot.details.artifact.artifactId;

const webCard = await tools.get("web_card").execute("web-card", {
  url: "https://example.com",
  waitMs: 100
});
assert.equal(webCard.details.status, "ok");
assert.ok(await fs.stat(webCard.details.path).then((stat) => stat.isFile()));
assert.match(webCard.content[0].text, /WEB_CARD ok/);
assert.match(webCard.content[0].text, /Example Domain/);

const input = path.join(mediaDir, "sample.png");
const py = `
from PIL import Image, ImageDraw
img = Image.new("RGBA", (640, 360), (32, 80, 160, 255))
d = ImageDraw.Draw(img)
d.rectangle((60, 60, 580, 300), fill=(240, 240, 255, 255))
d.text((90, 150), "Imagebot media_transform test", fill=(20, 20, 30, 255))
img.save(r'''${input.replaceAll("\\", "\\\\")}''')
`;
const made = spawnSync("python", ["-c", py], { encoding: "utf8" });
assert.equal(made.status, 0, made.stderr);
const mediaUriInput = path.join(mediaDir, "inbound", "uri-sample.png");
await fs.mkdir(path.dirname(mediaUriInput), { recursive: true });
await fs.copyFile(input, mediaUriInput);

const transformed = await tools.get("media_transform").execute("transform", {
  input,
  action: "compress",
  format: "jpg",
  maxEdge: 320,
  quality: 75
});
assert.equal(transformed.details.status, "ok");
assert.ok(await fs.stat(transformed.details.path).then((stat) => stat.isFile()));
assert.match(transformed.content[0].text, /MEDIA_TRANSFORM ok/);
assert.match(transformed.content[0].text, /engine: sharp/);
assert.ok(transformed.content.some((item) => item.type === "image"), "media_transform should return a visual preview for model inspection");

const transformedFromMediaUri = await tools.get("media_transform").execute("transform-media-uri", {
  input: "media://inbound/uri-sample.png (image/png)",
  action: "resize",
  maxEdge: 96,
  format: "png"
});
assert.equal(transformedFromMediaUri.details.status, "ok");
assert.equal(transformedFromMediaUri.details.width, 96);

const cropped = await tools.get("media_transform").execute("crop", {
  input,
  action: "crop",
  cropBox: "20,30,120,90",
  format: "png"
});
assert.equal(cropped.details.status, "ok");
assert.equal(cropped.details.engine, "sharp");
assert.deepEqual(cropped.details.cropBox, { left: 20, top: 30, width: 120, height: 90 });
assert.equal(cropped.details.width, 120);
assert.equal(cropped.details.height, 90);

const limitCtx = { agentId: "imagebot", chatId: "unit-chat", sessionKey: "unit-session", runId: "media-limit-run" };
for (let index = 0; index < 3; index++) {
  const limitedOk = await tools.get("media_transform").execute(`limit-ok-${index}`, {
    input,
    action: "resize",
    maxEdge: 96
  }, null, null, limitCtx);
  assert.equal(limitedOk.details.status, "ok");
}
const limitedTransform = await tools.get("media_transform").execute("limit-blocked", {
  input,
  action: "resize",
  maxEdge: 96
}, null, null, limitCtx);
assert.equal(limitedTransform.details.status, "limited");
assert.match(limitedTransform.content[0].text, /3\/3/);

const backgroundTransform = await tools.get("media_transform").execute("transform-bg", {
  input,
  action: "resize",
  format: "png",
  maxEdge: 180,
  background: true,
  dedupe_key: "unit-media-transform-bg"
}, null, null, { agentId: "imagebot", chatId: "unit-chat", sessionKey: "unit-session" });
assert.equal(backgroundTransform.details.status, "ok");
assert.equal(backgroundTransform.details.background, true);
const backgroundManager = getBackgroundJobManager({ storeDir: backgroundStoreDir, maxConcurrent: 2 });
const backgroundFinal = await backgroundManager.waitForJob(backgroundTransform.details.job.id, 3000);
assert.equal(backgroundFinal.state, "completed");
assert.equal(backgroundFinal.result.status, "ok");
assert.match(backgroundFinal.result.resultText, /MEDIA_TRANSFORM ok/);
await fs.access(backgroundFinal.result.mediaPath);

const qr = await tools.get("qr_tool").execute("qr-generate", {
  action: "generate",
  text: "https://example.com/imagebot-test"
});
assert.equal(qr.details.status, "ok");
assert.ok(await fs.stat(qr.details.path).then((stat) => stat.isFile()));

const qrDecoded = await tools.get("qr_tool").execute("qr-decode", {
  action: "decode",
  image: qr.details.path
});
assert.equal(qrDecoded.details.status, "ok");
assert.ok(qrDecoded.details.results.some((entry) => entry.rawValue === "https://example.com/imagebot-test"));

const pdfPath = path.join(mediaDir, "sample.pdf");
const pdfPy = `
from reportlab.pdfgen import canvas
c = canvas.Canvas(r'''${pdfPath.replaceAll("\\", "\\\\")}''')
c.setFont("Helvetica", 20)
c.drawString(72, 720, "Imagebot PDF render test")
c.drawString(72, 690, "Page 1")
c.showPage()
c.drawString(72, 720, "Page 2")
c.save()
`;
const madePdf = spawnSync("python", ["-c", pdfPy], { encoding: "utf8" });
assert.equal(madePdf.status, 0, madePdf.stderr);

const pdfRendered = await tools.get("pdf_render").execute("pdf-render", {
  pdf: pdfPath,
  pages: "1-2",
  maxEdge: 900
});
assert.equal(pdfRendered.details.status, "ok");
assert.ok(await fs.stat(pdfRendered.details.path).then((stat) => stat.isFile()));
assert.match(pdfRendered.content[0].text, /PDF_RENDER ok/);

const require = createRequire(path.resolve("plugins/imagebot-video-utils/index.js"));
const ffmpeg = require("@ffmpeg-installer/ffmpeg").path;
const videoPath = path.join(mediaDir, "sample.mp4");
const madeVideo = spawnSync(ffmpeg, [
  "-hide_banner",
  "-loglevel", "error",
  "-y",
  "-f", "lavfi",
  "-i", "testsrc=duration=1:size=320x180:rate=10",
  "-pix_fmt", "yuv420p",
  videoPath
], { encoding: "utf8" });
assert.equal(madeVideo.status, 0, madeVideo.stderr);

const avProbe = await tools.get("av_media").execute("av-probe", {
  input: videoPath,
  action: "probe"
});
assert.equal(avProbe.details.status, "ok");
assert.match(avProbe.content[0].text, /AV_MEDIA ok action=probe/);

const gif = await tools.get("av_media").execute("av-gif", {
  input: videoPath,
  action: "to_gif",
  duration: 1,
  maxEdge: 240
});
assert.equal(gif.details.status, "ok");
assert.ok(await fs.stat(gif.details.path).then((stat) => stat.isFile()));

const formattedJson = await tools.get("text_toolkit").execute("text-json", {
  action: "json_format",
  text: "{\"a\":1,\"b\":[2,3]}"
});
assert.equal(formattedJson.details.status, "ok");
assert.match(formattedJson.content[0].text, /"a": 1/);

const watchAdd = await tools.get("web_watch_add").execute("watch-add", {
  url: "https://example.com",
  name: "Example Domain"
});
assert.equal(watchAdd.details.status, "ok");
const watchId = watchAdd.details.watch.id;

const watchList = await tools.get("web_watch_list").execute("watch-list", {});
assert.equal(watchList.details.status, "ok");
assert.ok(watchList.details.watches.some((watch) => watch.id === watchId));

const watchCheck = await tools.get("web_watch_check").execute("watch-check", {
  id: watchId,
  update: false
});
assert.equal(watchCheck.details.status, "ok");
assert.equal(watchCheck.details.checked.length, 1);

const watchDelete = await tools.get("web_watch_delete").execute("watch-delete", { id: watchId });
assert.equal(watchDelete.details.status, "ok");
assert.equal(watchDelete.details.deleted, true);

const recent = await tools.get("artifact_recent").execute("recent", { count: 5 });
assert.equal(recent.details.status, "ok");
assert.ok(recent.details.results.length >= 2);

const searched = await tools.get("artifact_search").execute("search", { query: "Example Domain", count: 3 });
assert.equal(searched.details.status, "ok");
assert.ok(searched.details.results.some((record) => record.artifactId === snapshotId));

const got = await tools.get("artifact_get").execute("get", { id: snapshotId });
assert.equal(got.details.status, "ok");
assert.match(got.content[0].text, /MEDIA:/);

const aggregateRecent = await tools.get("artifact").execute("aggregate-recent", { action: "recent", count: 5 });
assert.equal(aggregateRecent.details.status, "ok");
assert.ok(aggregateRecent.details.results.length >= 2);

const aggregateSearch = await tools.get("artifact").execute("aggregate-search", { action: "search", query: "Example Domain", count: 3 });
assert.equal(aggregateSearch.details.status, "ok");
assert.ok(aggregateSearch.details.results.some((record) => record.artifactId === snapshotId));

const aggregateGet = await tools.get("artifact").execute("aggregate-get", { action: "get", id: snapshotId });
assert.equal(aggregateGet.details.status, "ok");
assert.match(aggregateGet.content[0].text, /MEDIA:/);

const artifactCtxA = { agentId: "imagebot", accountId: "imagebot", chatId: "artifact-chat-a", sessionKey: "artifact-session-a", senderId: "101" };
const artifactCtxB = { agentId: "imagebot", accountId: "imagebot", chatId: "artifact-chat-b", sessionKey: "artifact-session-b", senderId: "202" };
const scopedArtifactA = await __testing.recordArtifact({ storeDir }, {
  artifactId: "art_scope_a",
  kind: "unit_scope",
  source: "test",
  summary: "alpha scoped artifact",
  tags: ["scope-a"]
}, artifactCtxA);
const scopedArtifactB = await __testing.recordArtifact({ storeDir }, {
  artifactId: "art_scope_b",
  kind: "unit_scope",
  source: "test",
  summary: "beta scoped artifact",
  tags: ["scope-b"]
}, artifactCtxB);
assert.ok(scopedArtifactA.scopeKey);
assert.ok(scopedArtifactB.scopeKey);
assert.notEqual(scopedArtifactA.scopeKey, scopedArtifactB.scopeKey);

const scopedRecentA = await tools.get("artifact_recent").execute("recent-scope-a", { count: 10 }, null, null, artifactCtxA);
assert.equal(scopedRecentA.details.status, "ok");
assert.ok(scopedRecentA.details.results.some((record) => record.artifactId === "art_scope_a"));
assert.ok(!scopedRecentA.details.results.some((record) => record.artifactId === "art_scope_b"));

const scopedSearchA = await tools.get("artifact_search").execute("search-scope-a", { query: "beta scoped", count: 10 }, null, null, artifactCtxA);
assert.equal(scopedSearchA.details.status, "ok");
assert.ok(!scopedSearchA.details.results.some((record) => record.artifactId === "art_scope_b"));

const scopedGetBFromA = await tools.get("artifact_get").execute("get-scope-b-from-a", { id: "art_scope_b" }, null, null, artifactCtxA);
assert.equal(scopedGetBFromA.details.status, "no_match");

const scopedGetBFromB = await tools.get("artifact_get").execute("get-scope-b-from-b", { id: "art_scope_b" }, null, null, artifactCtxB);
assert.equal(scopedGetBFromB.details.status, "ok");

const manuals = await manualTesting.searchManuals({
  query: "webpage screenshot compress image artifact",
  focus: "practical_tools",
  count: 2
});
assert.ok(manuals.some((entry) => entry.id === "practical_tools"));

await __testing.closeBrowserContextPool();

console.log("practical-tools plugin tests passed");

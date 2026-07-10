import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import webImageSearch, { __testing } from "../plugins/web-image-search/index.js";

const tools = new Map();
const hooks = new Map();
webImageSearch.register({
  registerTool(tool, opts) {
    tools.set(opts?.name || tool.name, tool);
  },
  registerHook(name, handler, opts) {
    hooks.set(opts?.name || name, { name, handler });
  }
});

for (const name of [
  "web_text_search",
  "explicit_web_text_search",
  "web_image_search",
  "danbooru_resource",
  "download_image_url",
  "download_image_urls",
  "telegram_media_spoiler",
  "reverse_image_search"
]) {
  assert.ok(tools.has(name), `${name} should be available`);
}

for (const name of ["web_image_search", "danbooru_resource", "download_image_url", "download_image_urls", "reverse_image_search"]) {
  assert.ok(Object.hasOwn(tools.get(name).parameters.properties, "background"), `${name} should support background`);
  assert.ok(Object.hasOwn(tools.get(name).parameters.properties, "dedupe_key"), `${name} should support background dedupe`);
}
assert.ok(Object.hasOwn(tools.get("web_image_search").parameters.properties, "downloadPreviews"));
assert.ok(Object.hasOwn(tools.get("web_image_search").parameters.properties, "previewCount"));
assert.deepEqual(
  tools.get("reverse_image_search").parameters.properties.providers.items.enum,
  ["saucenao", "iqdb", "ascii2d"],
);
assert.ok(!Object.hasOwn(tools.get("reverse_image_search").parameters.properties, "googleLensFallback"));
assert.ok(!Object.hasOwn(tools.get("reverse_image_search").parameters.properties, "googleLensPages"));

const pluginSource = await fs.readFile(path.resolve("plugins/web-image-search/index.js"), "utf8");
assert.match(pluginSource, /withEphemeralPage/, "browser-backed image downloads should use ephemeral contexts");
assert.match(pluginSource, /const REVERSE_REQUEST_TIMEOUT_MS = 12_000;/, "ordinary reverse search should keep a bounded fast timeout");
assert.match(tools.get("reverse_image_search").description, /Fast reverse search/);
assert.match(tools.get("reverse_image_search").description, /SauceNAO\/IQDB/);
assert.match(tools.get("reverse_image_search").description, /not general photo identification/);
assert.match(tools.get("reverse_image_search").description, /similar-only results are not identity proof/);
assert.match(tools.get("reverse_image_search").description, /Full-browser Google Lens\/Images is broader for general photos/);
assert.doesNotMatch(tools.get("reverse_image_search").description, /natural follow-up/);
assert.match(pluginSource, /Similar-only or low-confidence candidates do not establish the input image's identity or source/);
assert.match(tools.get("reverse_image_search").parameters.properties.providers.description, /Omit for the default fast path: SauceNAO \+ IQDB/);
assert.match(tools.get("reverse_image_search").parameters.properties.providers.description, /Add ascii2d when requested/);
assert.match(tools.get("download_image_url").description, /direct image URL/);
assert.match(tools.get("download_image_url").parameters.properties.url.description, /direct image URL/);
assert.match(tools.get("download_image_urls").description, /direct image URLs/);
assert.match(tools.get("download_image_urls").parameters.properties.urls.description, /direct image URLs/);
assert.doesNotMatch(pluginSource, /google_lens|googleLensFallback|googleLensPages|Google Lens fallback/);
assert.doesNotMatch(pluginSource, /image-download-pool/, "browser-backed image downloads must not keep a persistent public profile");
assert.match(pluginSource, /AmadeusImageBot\/1\.0 \(danbooru_resource\)/, "Danbooru CDN downloads should not use the generic browser UA");
assert.ok(hooks.has("web-image-search-before-tool-call"), "web-image-search should register the image_generate reference guard");

const beforeToolCall = hooks.get("web-image-search-before-tool-call").handler;
const directRemoteReference = await beforeToolCall({
  toolName: "image_generate",
  runId: "test-image-generate-remote-ref",
  params: {
    prompt: "draw a named character with this reference",
    images: ["https://example.com/ref.png"]
  }
}, { agentId: "imagebot", runId: "test-image-generate-remote-ref" });
assert.equal(directRemoteReference.block, true);
assert.match(directRemoteReference.blockReason, /download_image_url/);
assert.match(directRemoteReference.blockReason, /https:\/\/example\.com\/ref\.png/);

const promptOnlyAfterRemoteReference = await beforeToolCall({
  toolName: "image_generate",
  runId: "test-image-generate-remote-ref",
  params: {
    prompt: "draw a named character with this reference"
  }
}, { agentId: "imagebot", runId: "test-image-generate-remote-ref" });
assert.equal(promptOnlyAfterRemoteReference.block, true);
assert.match(promptOnlyAfterRemoteReference.blockReason, /selected earlier in this run/);

const localReferenceAllowed = await beforeToolCall({
  toolName: "image_generate",
  runId: "test-image-generate-remote-ref",
  params: {
    prompt: "draw a named character with this reference",
    images: ["C:\\Users\\Bot\\.openclaw\\media\\downloaded\\20260626\\ref.png"]
  }
}, { agentId: "imagebot", runId: "test-image-generate-remote-ref" });
assert.equal(localReferenceAllowed, undefined);

const nonImagebotRemoteReference = await beforeToolCall({
  toolName: "image_generate",
  runId: "test-image-generate-other-agent",
  params: {
    prompt: "draw",
    images: ["https://example.com/ref.png"]
  }
}, { agentId: "other", runId: "test-image-generate-other-agent" });
assert.equal(nonImagebotRemoteReference, undefined);

const danbooruImageUrl = "https://cdn.donmai.us/sample/00/11/sample-safe-image.jpg";
assert.equal(__testing.isDanbooruUrl(danbooruImageUrl), true);
assert.equal(__testing.isDanbooruUrl("https://example.com/image.jpg"), false);
assert.equal(__testing.resolveDownloadTransport({ transport: "auto" }, danbooruImageUrl), "browser");
assert.equal(__testing.resolveDownloadTransport({}, danbooruImageUrl), "browser");
assert.equal(__testing.resolveDownloadTransport({}, "https://example.com/image.jpg"), "http");
assert.equal(__testing.resolveDownloadTransport({ transport: "http" }, danbooruImageUrl), "http");
assert.equal(__testing.resolveDownloadTransport({ transport: "browser" }, "https://example.com/image.jpg"), "browser");
assert.deepEqual(
  __testing.buildDanbooruQueryTags({
    tags: ["1girl", "blue_archive"],
    rating: "explicit",
    minScore: 200,
    minFavCount: 500,
    order: "favcount"
  }),
  ["1girl", "blue_archive", "rating:e", "status:active", "score:200..", "favcount:500..", "order:favcount"]
);
assert.deepEqual(
  __testing.buildDanbooruQueryTags({ query: "1girl solo", rating: "any", minBookmarkCount: 500 }),
  ["1girl", "solo", "status:active", "score:0..", "favcount:500..", "order:favcount"]
);
assert.deepEqual(
  __testing.danbooruSearchTagPlans(["1girl", "rating:e", "status:active", "score:0..", "favcount:200..", "order:favcount"]),
  [
    ["1girl", "rating:e", "status:active", "score:0..", "favcount:200..", "order:favcount"],
    ["1girl", "rating:e", "status:active", "score:0..", "favcount:200.."],
    ["1girl", "rating:e", "status:active", "favcount:200..", "order:favcount"],
    ["1girl", "rating:e", "status:active", "score:0..", "order:favcount"]
  ]
);
const normalizedDanbooruPost = __testing.normalizeDanbooruPost({
  id: 12345,
  rating: "e",
  score: 240,
  fav_count: 777,
  image_width: 1200,
  image_height: 1600,
  file_ext: "jpg",
  large_file_url: "https://cdn.donmai.us/sample/00/11/sample-test.jpg",
  file_url: "https://cdn.donmai.us/original/00/11/original-test.jpg",
  preview_file_url: "https://cdn.donmai.us/preview/00/11/preview-test.jpg",
  tag_string: "1girl blue_archive solo",
  tag_string_general: "1girl solo",
  tag_string_character: "unit_test",
  tag_string_copyright: "blue_archive",
  tag_string_artist: "unit_artist"
}, { baseUrl: "https://danbooru.donmai.us" }, { imageSize: "large" });
assert.equal(normalizedDanbooruPost.id, 12345);
assert.equal(normalizedDanbooruPost.imageUrl, "https://cdn.donmai.us/sample/00/11/sample-test.jpg");
assert.equal(normalizedDanbooruPost.postUrl, "https://danbooru.donmai.us/posts/12345");
assert.equal(normalizedDanbooruPost.favCount, 777);
const filteredDanbooruPosts = __testing.filterDanbooruPosts([normalizedDanbooruPost], { minFavCount: 800 });
assert.equal(filteredDanbooruPosts.posts.length, 0);
assert.equal(filteredDanbooruPosts.skippedQuality, 1);
const verboseResults = Array.from({ length: 8 }, (_unused, index) => ({
  title: `candidate ${index + 1}`,
  imageUrl: `https://img.example.test/${index + 1}.jpg`,
  thumbnailUrl: `https://thumb.example.test/${index + 1}.jpg`,
  sourceUrl: `https://source.example.test/${index + 1}`,
  source: "fixture",
  width: 512,
  height: 512,
  format: "jpeg"
}));
const formattedImageResults = __testing.formatResults("fixture query", verboseResults, [{
  ok: true,
  candidateIndex: 0,
  imageUrl: "https://img.example.test/1.jpg",
  path: "C:\\Users\\Bot\\.openclaw\\media\\downloaded\\20260626\\fixture-1.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 12345,
  transport: "http"
}]);
assert.match(formattedImageResults, /candidate 6/);
assert.doesNotMatch(formattedImageResults, /candidate 7/);
assert.doesNotMatch(formattedImageResults, /thumbnailUrl/);
assert.match(formattedImageResults, /Showing 6 of 8 candidates/);
assert.match(formattedImageResults, /localMedia: C:\\Users\\Bot\\.openclaw\\media\\downloaded\\20260626\\fixture-1\.jpg/);
assert.match(formattedImageResults, /Downloaded model-visible previews: 1\/1/);
assert.match(formattedImageResults, /pass useful localMedia paths/);
assert.match(formattedImageResults, /Direct public imageUrl references are blocked/);
assert.equal(__testing.shouldAutoDownloadSearchPreviews({}, { agentId: "imagebot" }, {}), true);
assert.equal(__testing.shouldAutoDownloadSearchPreviews({}, { agentId: "other" }, {}), false);
assert.equal(__testing.shouldAutoDownloadSearchPreviews({ downloadPreviews: true }, { agentId: "other" }, {}), true);
assert.equal(__testing.readSearchPreviewCount({ previewCount: 999 }, {}), 6);
assert.deepEqual(
  __testing.selectImageSearchPreviewCandidates(verboseResults, 2).map((entry) => entry.candidateIndex),
  [0, 1]
);
assert.equal(__testing.cachedDownloadTransport("https://cache-test.example/image.jpg"), "");
__testing.rememberDownloadTransport("https://cache-test.example/image.jpg", "browser");
assert.equal(__testing.cachedDownloadTransport("https://cache-test.example/another.png"), "browser");
assert.equal(__testing.resolveDownloadTransport({}, "https://cache-test.example/another.png"), "browser");
assert.deepEqual(
  __testing.downloadUrlCandidates("https://www.suruga-ya.jp/database/pics_light/game/gl608382.jpg"),
  [
    "https://cdn.suruga-ya.jp/database/pics_light/game/gl608382.jpg",
    "https://www.suruga-ya.jp/database/pics_light/game/gl608382.jpg"
  ]
);
assert.equal(__testing.sourceSafetyHintForImageUrl("https://pics.dmm.co.jp/mono/movie/adult/ssni112/ssni112pl.jpg"), "adult_or_sensitive_source");
assert.equal(__testing.sourceSafetyHintForImageUrl("https://example.com/images/cat.jpg"), "unknown");
assert.match(
  __testing.buildDownloadDeliveryGuidance({
    previewIncluded: true,
    sourceSafetyHint: "adult_or_sensitive_source"
  }),
  /included image preview is visual context/
);
assert.match(
  __testing.buildDownloadDeliveryGuidance({
    previewIncluded: true,
    sourceSafetyHint: "adult_or_sensitive_source"
  }),
  /SPOILER_MEDIA/
);

const started = [];
const finished = [];
const mapped = await __testing.mapConcurrent([0, 1, 2, 3, 4], 2, async (value) => {
  started.push(value);
  await new Promise((resolve) => setTimeout(resolve, value === 0 ? 30 : 5));
  finished.push(value);
  return value * 10;
});
assert.deepEqual(mapped, [0, 10, 20, 30, 40]);
assert.deepEqual(started.slice(0, 2), [0, 1]);
assert.ok(finished.indexOf(1) < finished.indexOf(0), "concurrent workers should not be serialized by the slow first item");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "web-image-search-test-"));
try {
  const pngPath = path.join(tempDir, "preview.png");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  );
  await fs.writeFile(pngPath, pngBytes);
  const preview = await __testing.buildToolResultImagePreview({
    path: pngPath,
    mimeType: "image/png",
    sizeBytes: pngBytes.length
  });
  assert.equal(preview?.type, "image");
  assert.equal(preview?.mimeType, "image/png");
  assert.equal(preview?.fileName, "preview.png");
  assert.equal(preview?.data, pngBytes.toString("base64"));

  const compressedPreview = await __testing.buildToolResultImagePreview({
    path: pngPath,
    mimeType: "image/png",
    sizeBytes: 1024 * 1024
  });
  assert.equal(compressedPreview?.type, "image");
  assert.equal(compressedPreview?.mimeType, "image/jpeg");
  assert.equal(compressedPreview?.fileName, "preview-preview.jpg");

  const gifPreview = await __testing.buildToolResultImagePreview({
    path: pngPath,
    mimeType: "image/gif",
    sizeBytes: pngBytes.length
  });
  assert.equal(gifPreview, null);

  const downloadedDir = path.join(os.homedir(), ".openclaw", "media", "downloaded", "test-web-image-search");
  await fs.mkdir(downloadedDir, { recursive: true });
  const localMediaPath = path.join(downloadedDir, "spoiler-test.png");
  await fs.writeFile(localMediaPath, pngBytes);
  const spoilerTool = tools.get("telegram_media_spoiler");
  const spoilerResult = await spoilerTool.execute("test", { media: `MEDIA: \`${localMediaPath}\`` });
  assert.equal(spoilerResult.details.status, "ok");
  assert.equal(spoilerResult.details.media.sensitiveMedia, true);
  assert.equal(spoilerResult.details.media.trustedLocalMedia, true);
  assert.equal(spoilerResult.details.media.outbound, false);
  assert.deepEqual(spoilerResult.details.media.mediaUrls, [localMediaPath]);
  const spoilerMediaUriResult = await spoilerTool.execute("test-media-uri", { media: "media://downloaded/test-web-image-search/spoiler-test.png (image/png)" });
  assert.equal(spoilerMediaUriResult.details.status, "ok");
  assert.deepEqual(spoilerMediaUriResult.details.media.mediaUrls, [localMediaPath]);
  const reverseMediaUriResult = await tools.get("reverse_image_search").execute("test-reverse-media-uri", {
    image: "media://downloaded/test-web-image-search/spoiler-test.png (image/png)",
    providers: ["ascii2d"]
  });
  assert.equal(reverseMediaUriResult.details.status, "ok");
  assert.equal(reverseMediaUriResult.details.input, path.basename(localMediaPath));
  assert.equal(reverseMediaUriResult.details.inputKind, "file");

  const practicalDir = path.join(os.homedir(), ".openclaw", "media", "practical-tools", "web-snapshots", "test-web-image-search");
  await fs.mkdir(practicalDir, { recursive: true });
  const snapshotMediaPath = path.join(practicalDir, "snapshot-spoiler-test.png");
  await fs.writeFile(snapshotMediaPath, pngBytes);
  const snapshotSpoilerResult = await spoilerTool.execute("test", { media: `MEDIA: \`${snapshotMediaPath}\`` });
  assert.equal(snapshotSpoilerResult.details.status, "ok");
  assert.equal(snapshotSpoilerResult.details.media.sensitiveMedia, true);
  assert.equal(snapshotSpoilerResult.details.media.trustedLocalMedia, true);
  assert.equal(snapshotSpoilerResult.details.media.outbound, false);
  assert.deepEqual(snapshotSpoilerResult.details.media.mediaUrls, [snapshotMediaPath]);
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

console.log("web-image-search plugin tests passed");

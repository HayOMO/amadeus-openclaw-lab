import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import plugin, { __testing } from "../plugins/imagebot-sticker-pack/index.js";

const require = createRequire(import.meta.url);
const sharp = require("../plugins/imagebot-sticker-pack/node_modules/sharp");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-sticker-pack-test-"));
const mediaRoot = path.join(root, "media");
const outRoot = path.join(root, "stickers");
const draftRoot = path.join(root, "drafts");
const managedSetsPath = path.join(root, "managed-sets.json");
const tokenPath = path.join(root, "token.txt");
await fs.mkdir(mediaRoot, { recursive: true });
await fs.writeFile(tokenPath, "TEST_TOKEN", "utf8");

const inputPath = path.join(mediaRoot, "source.png");
await sharp({
  create: {
    width: 96,
    height: 64,
    channels: 4,
    background: { r: 255, g: 0, b: 120, alpha: 1 }
  }
}).png().toFile(inputPath);

const mediaUriInputPath = path.join(mediaRoot, "inbound", "uri-source.png");
await fs.mkdir(path.dirname(mediaUriInputPath), { recursive: true });
await fs.copyFile(inputPath, mediaUriInputPath);

const secondInputPath = path.join(mediaRoot, "source-2.png");
await sharp({
  create: {
    width: 80,
    height: 110,
    channels: 4,
    background: { r: 0, g: 180, b: 255, alpha: 1 }
  }
}).png().toFile(secondInputPath);

const blackMatteInputPath = path.join(mediaRoot, "black-matte-edge.png");
{
  const width = 64;
  const height = 64;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const distance = Math.hypot(x - 32, y - 32);
      if (distance <= 18) {
        data[offset] = 255;
        data[offset + 1] = 255;
        data[offset + 2] = 255;
        data[offset + 3] = 255;
      } else if (distance < 23) {
        const alpha = Math.max(1, Math.min(254, Math.round(((23 - distance) / 5) * 255)));
        data[offset] = alpha;
        data[offset + 1] = alpha;
        data[offset + 2] = alpha;
        data[offset + 3] = alpha;
      }
    }
  }
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(blackMatteInputPath);
}

const animatedStickerPath = path.join(mediaRoot, "animated.tgs");
await fs.writeFile(animatedStickerPath, gzipSync(Buffer.from(JSON.stringify({
  v: "5.7.4",
  fr: 60,
  ip: 0,
  op: 60,
  w: 512,
  h: 512,
  layers: []
}), "utf8")));

async function normalizeRequestBody(body) {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  if (body && typeof body.entries === "function") {
    const out = {};
    for (const [key, value] of body.entries()) {
      if (typeof value === "string") {
        try {
          out[key] = JSON.parse(value);
        } catch {
          out[key] = value;
        }
      } else {
        out[key] = {
          name: value.name || "",
          type: value.type || "",
          size: value.size || 0
        };
      }
    }
    return out;
  }
  return null;
}

const calls = [];
__testing.setFetchForTests(async (url, options) => {
  const body = await normalizeRequestBody(options?.body);
  calls.push({ url, method: options?.method || "GET", hasBody: Boolean(options?.body), bodyType: options?.body?.constructor?.name || "", body });
  if (String(url).startsWith("https://duckduckgo.com/html/")) {
    return new Response(`
      <html><body>
        <div class="result">
          <a class="result__a" href="https://example.com/sticker-index">Mixed Telegram sticker catalog</a>
          <div class="result__snippet">A public catalog page for mixed stickers.</div>
        </div>
        <div class="result">
          <a class="result__a" href="/l/?uddg=${encodeURIComponent("https://t.me/addstickers/test_by_YOUR_BOT_USERNAME")}">Known Telegram stickers</a>
          <div class="result__snippet">Direct addstickers result.</div>
        </div>
      </body></html>
    `, { status: 200 });
  }
  if (String(url) === "https://example.com/sticker-index") {
    return new Response(`<html><body><a href="https://t.me/addstickers/mixed_source">mixed source</a></body></html>`, { status: 200 });
  }
  if (url.endsWith("/getStickerSet")) {
    if (body?.name === "mixed_source") {
      return new Response(JSON.stringify({
        ok: true,
        result: {
          name: "mixed_source",
          title: "Mixed Source",
          sticker_type: "regular",
          stickers: [
            { file_id: "static_file", file_unique_id: "uniq_static", emoji: "\uD83D\uDE42", type: "regular", width: 512, height: 512, is_animated: false, is_video: false },
            { file_id: "animated_file", file_unique_id: "uniq_animated", emoji: "\uD83D\uDE80", type: "regular", width: 512, height: 512, is_animated: true, is_video: false },
            { file_id: "video_file", file_unique_id: "uniq_video", emoji: "\uD83C\uDFAC", type: "regular", width: 512, height: 512, is_animated: false, is_video: true }
          ]
        }
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      ok: true,
      result: { name: "test_by_YOUR_BOT_USERNAME", title: "Test", sticker_type: "regular", stickers: [{ file_id: "file_1", emoji: "🙂", type: "regular", width: 512, height: 512 }] }
    }), { status: 200 });
  }
  if (url.endsWith("/getFile")) {
    const ext = body?.file_id === "animated_file" ? "tgs" : body?.file_id === "video_file" ? "webm" : "webp";
    return new Response(JSON.stringify({
      ok: true,
      result: { file_id: body?.file_id, file_unique_id: `uniq_${body?.file_id || "file"}`, file_path: `stickers/${body?.file_id || "file"}.${ext}`, file_size: 8 }
    }), { status: 200 });
  }
  if (String(url).startsWith("https://api.telegram.org/file/botTEST_TOKEN/")) {
    return new Response(Buffer.from("STICKER"), { status: 200 });
  }
  if (url.endsWith("/uploadStickerFile")) {
    return new Response(JSON.stringify({ ok: true, result: { file_id: "uploaded_file_id", file_unique_id: "uniq" } }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
});

const tools = new Map();
const hooks = new Map();
async function runHooks(name, event = {}, ctx = {}) {
  for (const handler of hooks.get(name) || []) {
    await handler(event, ctx);
  }
}
plugin.register({
  config: {
    mediaDir: outRoot,
    mediaRoot,
    draftDir: draftRoot,
    managedSetsPath,
    tokenFile: tokenPath,
    botUsername: "YOUR_BOT_USERNAME",
    allowedMediaRoots: [mediaRoot, outRoot]
  },
  registerTool(tool, meta) {
    tools.set(meta.name, tool);
  },
  registerHook(name, handler) {
    if (!hooks.has(name)) hooks.set(name, []);
    hooks.get(name).push(handler);
  }
});

assert.ok(tools.has("sticker_pack"));
assert.ok(hooks.get("before_tool_call")?.length, "sticker_pack should capture runtime context before tool execution");
assert.ok(hooks.get("after_tool_call")?.length, "sticker_pack should clear captured runtime context after tool execution");
const ownerCtx = { senderId: "12345", chatId: "unit-chat", sessionKey: "unit-session" };
const sessionKeyOnlyOwnerCtx = {
  agentId: "imagebot",
  sessionKey: "agent:imagebot:telegram:group:-1000000000001:sender:12345:window:unit-window",
  messageId: "30",
  text: "session-key-only owner context"
};
const approvedOwnerCtx = { ...ownerCtx, mutationApproved: true };
const stickerPlanCtx = { ...ownerCtx, messageId: "10", text: "plan sticker mutation" };
const stickerFollowupCtx = (overrides = {}) => ({
  ...ownerCtx,
  messageId: "11",
  text: "confirm sticker mutation",
  ...overrides
});
const nonAsciiSetName = __testing.normalizeSetName("测试 pack!!", "YOUR_BOT_USERNAME");
assert.match(nonAsciiSetName, /^pack_[a-f0-9]{6}_by_YOUR_BOT_USERNAME$/);
assert.notEqual(nonAsciiSetName, "pack_by_YOUR_BOT_USERNAME");
assert.match(__testing.normalizeSetName("千早爱音唐笑", "YOUR_BOT_USERNAME"), /^pack_[a-f0-9]{8}_by_YOUR_BOT_USERNAME$/);
assert.deepEqual(__testing.normalizeEmojiList({ emoji: "🙂😂" }), ["🙂", "😂"]);
assert.deepEqual(__testing.normalizeEmojiList({ emoji: "唐笑" }), ["🙂"]);
assert.deepEqual(__testing.normalizeKeywords({ keywords: "kurisu, lab coat" }), ["kurisu", "lab", "coat"]);
assert.equal(__testing.normalizeStickerFormat("", animatedStickerPath), "animated");
assert.equal(__testing.stickerMimeType("animated", animatedStickerPath), "application/x-tgsticker");
assert.equal(__testing.stickerMimeType("video", path.join(mediaRoot, "video.webm")), "video/webm");

const prepared = await tools.get("sticker_pack").execute("prepare", {
  action: "prepare",
  input: inputPath
});
assert.equal(prepared.details.status, "ok");
assert.ok(prepared.details.outputPath.endsWith(".webp"));
assert.equal(prepared.content.some((item) => item.type === "image"), true);
await fs.access(prepared.details.outputPath);
const preparedMeta = await sharp(prepared.details.outputPath).metadata();
assert.equal(preparedMeta.width, 512);
assert.equal(preparedMeta.height, 512);
assert.ok(prepared.details.sizeBytes <= 512 * 1024);

const mediaUriPrepared = await tools.get("sticker_pack").execute("prepare-media-uri", {
  action: "prepare",
  input: "media://inbound/uri-source.png (image/png)"
});
assert.equal(mediaUriPrepared.details.status, "ok");
assert.ok(mediaUriPrepared.details.outputPath.endsWith(".webp"));

const blackMattePrepared = await tools.get("sticker_pack").execute("prepare-black-matte", {
  action: "prepare",
  input: blackMatteInputPath,
  padding: 0,
  trim: false
});
assert.equal(blackMattePrepared.details.status, "ok");
{
  const { data } = await sharp(blackMattePrepared.details.outputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let darkSemiTransparent = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3];
    if (alpha > 16 && alpha < 240 && Math.max(data[offset], data[offset + 1], data[offset + 2]) < 160) {
      darkSemiTransparent += 1;
    }
  }
  assert.equal(darkSemiTransparent, 0, "black-matte antialiasing should be normalized before sticker resize");
}

const batch = await tools.get("sticker_pack").execute("prepare-batch", {
  action: "prepare_batch",
  inputs: [inputPath, secondInputPath],
  framing: "smart",
  contactSheet: true,
  emoji: "\uD83D\uDE42"
});
assert.equal(batch.details.status, "ok");
assert.equal(batch.details.total, 2);
assert.equal(batch.details.okCount, 2);
assert.equal(batch.details.media.mediaUrls.length, 3);
assert.ok(batch.details.contactSheet.outputPath.endsWith(".png"));
assert.equal(batch.content.some((item) => item.type === "image"), true);
await fs.access(batch.details.contactSheet.outputPath);

const exposedActions = tools.get("sticker_pack").parameters.properties.action.enum;
for (const visibleAction of [
  "plan",
  "draft",
  "get_draft",
  "review_brief",
  "review_draft",
  "review_sheet",
  "list_managed_sets",
  "set_default_set",
  "forget_managed_set",
  "publish_draft",
  "search_sources",
  "search_sets",
  "source_set",
  "download_set",
  "copy_set",
  "import_set",
  "add_from_sticker"
]) {
  assert.equal(exposedActions.includes(visibleAction), true, `${visibleAction} should be model-visible`);
}
assert.match(JSON.stringify(tools.get("sticker_pack").parameters), /download_set|copy_set|review_draft|publish_draft/);

const emptyManagedSets = await tools.get("sticker_pack").execute("managed-empty", {
  action: "list_managed_sets",
  userId: "12345"
});
assert.equal(emptyManagedSets.details.status, "ok");
assert.equal(emptyManagedSets.details.count, 0);

const addFromStickerWithoutDefault = await tools.get("sticker_pack").execute("add-from-sticker-no-default", {
  action: "add_from_sticker",
  userId: "12345",
  fileId: "sent_file_id"
});
assert.equal(addFromStickerWithoutDefault.details.status, "failed");
assert.match(addFromStickerWithoutDefault.details.error, /name\/setName|required|set_default_set/);

const defaultSet = await tools.get("sticker_pack").execute("set-default-managed", {
  action: "set_default_set",
  userId: "12345",
  name: "manual_default_by_YOUR_BOT_USERNAME",
  title: "Manual Default"
}, undefined, undefined, { senderId: "12345" });
assert.equal(defaultSet.details.status, "default_set_recorded");
assert.equal(defaultSet.details.defaultSet, "manual_default_by_YOUR_BOT_USERNAME");
await fs.access(managedSetsPath);

const addFromStickerDryRun = await tools.get("sticker_pack").execute("add-from-sticker-dry-run", {
  action: "add_from_sticker",
  userId: "12345",
  sticker: {
    file_id: "sent_file_id",
    file_unique_id: "sent_unique",
    emoji: "\uD83D\uDE42",
    is_animated: false,
    is_video: false,
    set_name: "someone_else_set"
  }
}, undefined, undefined, { senderId: "12345" });
assert.equal(addFromStickerDryRun.details.status, "add_from_sticker_dry_run");
assert.equal(addFromStickerDryRun.details.managedSet, "manual_default_by_YOUR_BOT_USERNAME");
assert.equal(addFromStickerDryRun.details.defaultUsed, true);
assert.equal(addFromStickerDryRun.details.dryRun, true);

const draft = await tools.get("sticker_pack").execute("draft", {
  action: "draft",
  name: "review draft",
  title: "Review Draft",
  inputs: [inputPath, secondInputPath],
  theme: "lab reactions"
});
assert.equal(draft.details.status, "awaiting_review");
assert.equal(draft.details.total, 2);
assert.ok(draft.details.draftId);

const reviewed = await tools.get("sticker_pack").execute("review-draft", {
  action: "review_draft",
  draftId: draft.details.draftId,
  items: [
    { index: 1, decision: "keep", emoji: "\uD83D\uDE42", keywords: "lab" },
    { index: 2, decision: "reject", reason: "duplicate" }
  ]
});
assert.equal(reviewed.details.status, "reviewed");
assert.equal(reviewed.details.keptCount, 1);

const publishDraft = await tools.get("sticker_pack").execute("publish-draft", {
  action: "publish_draft",
  draftId: draft.details.draftId,
  userId: "12345",
  dryRun: true
});
assert.equal(publishDraft.details.status, "publish_dry_run");
assert.equal(publishDraft.details.dryRun, true);

const publishPlan = await tools.get("sticker_pack").execute("publish-plan", {
  action: "plan",
  targetAction: "publish_draft",
  draftId: draft.details.draftId,
  userId: "12345",
  dryRun: false,
  reason: "unit publish"
}, undefined, undefined, { ...stickerPlanCtx, messageId: "20", text: "plan publish draft" });
assert.equal(publishPlan.details.status, "planned");
assert.equal(publishPlan.details.targetAction, "publish_draft");
assert.equal(publishPlan.details.approvalCode, undefined);

const publishedReal = await tools.get("sticker_pack").execute("publish-real", {
  action: "publish_draft",
  draftId: draft.details.draftId,
  userId: "12345",
  dryRun: false,
  plan_id: publishPlan.details.planId
}, undefined, undefined, stickerFollowupCtx({ messageId: "21", text: "publish" }));
assert.equal(publishedReal.details.status, "published");
assert.equal(publishedReal.details.dryRun, false);
assert.ok(publishedReal.details.reviewSheet?.outputPath, "publish_draft dryRun:false should render a review sheet if missing");
await fs.access(publishedReal.details.reviewSheet.outputPath);
const publishCreateCall = calls.find((call) => call.url.endsWith("/createNewStickerSet") && call.body?.name === "review_draft_by_YOUR_BOT_USERNAME");
assert.ok(publishCreateCall, "publish_draft plan should authorize the nested createNewStickerSet call");
assert.equal(publishCreateCall.body.plan_id, undefined);

const fallbackDraft = await tools.get("sticker_pack").execute("fallback-draft", {
  action: "draft",
  userId: "12345",
  name: "fallback publish",
  title: "Fallback Publish",
  items: [
    { input: prepared.details.outputPath, emoji: "\uD83D\uDE42", emojiList: ["\uD83D\uDE42"], keywords: "fallback", decision: "keep" }
  ],
  contactSheet: true
}, undefined, undefined, sessionKeyOnlyOwnerCtx);
assert.equal(fallbackDraft.details.status, "awaiting_review");

const fallbackReviewed = await tools.get("sticker_pack").execute("fallback-review", {
  action: "review_draft",
  draftId: fallbackDraft.details.draftId,
  items: [{ index: 1, decision: "keep", emoji: "\uD83D\uDE42", keywords: "fallback" }]
});
assert.equal(fallbackReviewed.details.status, "reviewed");

const fallbackPlan = await tools.get("sticker_pack").execute("fallback-plan", {
  action: "plan",
  targetAction: "publish_draft",
  draftId: fallbackDraft.details.draftId,
  userId: "12345",
  dryRun: false,
  reason: "plan target params should hydrate publish_draft"
}, undefined, undefined, sessionKeyOnlyOwnerCtx);
assert.equal(fallbackPlan.details.status, "planned");
assert.equal(fallbackPlan.details.plan.targetParams.draftId, fallbackDraft.details.draftId);
const mutationPlansPath = path.join(outRoot, "mutation-plans.json");
const legacyPlans = JSON.parse(await fs.readFile(mutationPlansPath, "utf8"));
delete legacyPlans.plans[fallbackPlan.details.planId].targetParams;
await fs.writeFile(mutationPlansPath, JSON.stringify(legacyPlans, null, 2), "utf8");

const fallbackPublished = await tools.get("sticker_pack").execute("fallback-publish-plan-only", {
  action: "publish_draft",
  plan_id: fallbackPlan.details.planId,
  dryRun: false
}, undefined, undefined, sessionKeyOnlyOwnerCtx);
assert.equal(fallbackPublished.details.status, "published");
assert.equal(fallbackPublished.details.draftId, fallbackDraft.details.draftId);
assert.ok(calls.some((call) => call.url.endsWith("/createNewStickerSet") && call.body?.name === "fallback_publish_by_YOUR_BOT_USERNAME"));

const sourceSet = await tools.get("sticker_pack").execute("source-set", {
  action: "source_set",
  sourceSet: "https://t.me/addstickers/mixed_source"
});
assert.equal(sourceSet.details.status, "ok");
assert.equal(sourceSet.details.count, 3);
assert.deepEqual(sourceSet.details.formatCounts, { static: 1, animated: 1, video: 1 });

const downloadedSet = await tools.get("sticker_pack").execute("download-set", {
  action: "download_set",
  sourceSet: "mixed_source",
  limit: 2,
  concurrency: 2
});
assert.equal(downloadedSet.details.status, "downloaded");
assert.equal(downloadedSet.details.count, 2);
assert.ok(downloadedSet.details.outputDir.startsWith(path.join(outRoot, "downloads")));
assert.ok(downloadedSet.details.manifestPath.endsWith("manifest.json"));
for (const item of downloadedSet.details.stickers) await fs.access(item.outputPath);
assert.equal(
  __testing.sanitizeTelegramText("failed https://api.telegram.org/file/botTEST_TOKEN/stickers/a.webp"),
  "failed https://api.telegram.org/file/[telegram-token-redacted]"
);
assert.equal(
  __testing.sanitizeTelegramText(`${"123456"}:${"A".repeat(36)}`),
  "[telegram-token-redacted]"
);

const copiedDryRun = await tools.get("sticker_pack").execute("copy-set-dry-run", {
  action: "copy_set",
  sourceSet: "mixed_source",
  userId: "12345",
  name: "mixed copy"
});
assert.equal(copiedDryRun.details.status, "copy_dry_run");
assert.equal(copiedDryRun.details.dryRun, true);

const copiedDirect = await tools.get("sticker_pack").execute("copy-set-direct", {
  action: "copy_set",
  sourceSet: "mixed_source",
  userId: "12345",
  name: "mixed copy",
  dryRun: false
}, undefined, undefined, ownerCtx);
assert.equal(copiedDirect.details.status, "copied");
assert.equal(copiedDirect.details.dryRun, false);

const uploaded = await tools.get("sticker_pack").execute("upload", {
  action: "upload",
  userId: "tg:12345",
  stickerPath: prepared.details.outputPath
});
assert.equal(uploaded.details.status, "upload_dry_run");
assert.equal(uploaded.details.dryRun, true);
assert.equal(calls.some((call) => call.url.endsWith("/uploadStickerFile")), false);

const uploadPlan = await tools.get("sticker_pack").execute("upload-plan", {
  action: "plan",
  targetAction: "upload",
  userId: "tg:12345",
  stickerPath: prepared.details.outputPath,
  dryRun: false,
  reason: "unit upload"
}, undefined, undefined, stickerPlanCtx);
assert.equal(uploadPlan.details.status, "planned");
assert.equal(uploadPlan.details.targetAction, "upload");
assert.equal(uploadPlan.details.approvalCode, undefined);

const uploadPlanFromSessionKey = await tools.get("sticker_pack").execute("upload-plan-session-key", {
  action: "plan",
  targetAction: "upload",
  userId: "tg:12345",
  stickerPath: prepared.details.outputPath,
  dryRun: false,
  reason: "unit upload from session key sender"
}, undefined, undefined, sessionKeyOnlyOwnerCtx);
assert.equal(uploadPlanFromSessionKey.details.status, "planned");
assert.equal(uploadPlanFromSessionKey.details.targetAction, "upload");
assert.equal(uploadPlanFromSessionKey.details.plan.context.senderId, "12345");

const uploadedReal = await tools.get("sticker_pack").execute("upload-real", {
  action: "upload",
  userId: "tg:12345",
  stickerPath: prepared.details.outputPath,
  dryRun: false,
  plan_id: uploadPlan.details.planId
}, undefined, undefined, stickerFollowupCtx());
assert.equal(uploadedReal.details.status, "ok");
assert.equal(uploadedReal.details.dryRun, false);
assert.equal(uploadedReal.details.fileId, "uploaded_file_id");
assert.ok(calls.some((call) => call.url.endsWith("/uploadStickerFile") && call.bodyType === "FormData"));

const uploadedReplay = await tools.get("sticker_pack").execute("upload-replay", {
  action: "upload",
  userId: "tg:12345",
  stickerPath: prepared.details.outputPath,
  dryRun: false,
  plan_id: uploadPlan.details.planId
}, undefined, undefined, stickerFollowupCtx({ messageId: "12" }));
assert.equal(uploadedReplay.details.status, "failed");
assert.match(uploadedReplay.details.error, /expired or already used/);

const uploadedOwnerMismatch = await tools.get("sticker_pack").execute("upload-owner-mismatch", {
  action: "upload",
  userId: "12345",
  stickerPath: prepared.details.outputPath,
  dryRun: false
}, undefined, undefined, { senderId: "99999" });
assert.equal(uploadedOwnerMismatch.details.status, "failed");
assert.match(uploadedOwnerMismatch.details.error, /owner-check/);

const uploadedLegacyFlag = await tools.get("sticker_pack").execute("upload-legacy-flag", {
  action: "upload",
  userId: "tg:12345",
  stickerPath: prepared.details.outputPath,
  dryRun: false,
  directUploadApproved: true
}, undefined, undefined, ownerCtx);
assert.equal(uploadedLegacyFlag.details.status, "ok");
assert.equal(uploadedLegacyFlag.details.dryRun, false);

const uploadedMissingContext = await tools.get("sticker_pack").execute("upload-missing-context", {
  action: "upload",
  userId: "tg:12345",
  stickerPath: prepared.details.outputPath,
  dryRun: false
});
assert.equal(uploadedMissingContext.details.status, "failed");
assert.match(uploadedMissingContext.details.error, /trusted requester context/);

const deleteDryRun = await tools.get("sticker_pack").execute("delete-dry-run", {
  action: "delete_sticker",
  fileId: "file_to_delete"
});
assert.equal(deleteDryRun.details.status, "delete_dry_run");
assert.equal(deleteDryRun.details.dryRun, true);

const deleteNoApproval = await tools.get("sticker_pack").execute("delete-no-approval", {
  action: "delete_sticker",
  fileId: "file_to_delete",
  dryRun: false
}, undefined, undefined, ownerCtx);
assert.equal(deleteNoApproval.details.status, "failed");
assert.match(deleteNoApproval.details.error, /delete confirmation|trusted runtime/);

const deletePlan = await tools.get("sticker_pack").execute("delete-plan", {
  action: "plan",
  targetAction: "delete_sticker",
  fileId: "file_to_delete_by_plan",
  dryRun: false,
  reason: "unit delete confirmation"
}, undefined, undefined, ownerCtx);
assert.equal(deletePlan.details.status, "planned");
assert.equal(deletePlan.details.approvalCode, undefined);

const deleteConfirmed = await tools.get("sticker_pack").execute("delete-confirmed", {
  action: "delete_sticker",
  fileId: "file_to_delete_by_plan",
  plan_id: deletePlan.details.planId,
  dryRun: false
}, undefined, undefined, stickerFollowupCtx({ text: "confirm delete" }));
assert.equal(deleteConfirmed.details.status, "ok");
assert.equal(deleteConfirmed.details.dryRun, false);

const deleteApproved = await tools.get("sticker_pack").execute("delete-approved", {
  action: "delete_sticker",
  fileId: "file_to_delete",
  dryRun: false
}, undefined, undefined, approvedOwnerCtx);
assert.equal(deleteApproved.details.status, "ok");
assert.equal(deleteApproved.details.dryRun, false);
assert.ok(calls.some((call) => call.url.endsWith("/deleteStickerFromSet")));

const setKeywordsDryRun = await tools.get("sticker_pack").execute("set-keywords-dry-run", {
  action: "set_keywords",
  fileId: "file_kw",
  keywords: "kurisu lab"
});
assert.equal(setKeywordsDryRun.details.status, "set_keywords_dry_run");
assert.deepEqual(setKeywordsDryRun.details.keywords, ["kurisu", "lab"]);

const setEmojiApproved = await tools.get("sticker_pack").execute("set-emoji-approved", {
  action: "set_emoji_list",
  fileId: "file_emoji",
  emoji: "\uD83D\uDE42",
  dryRun: false
}, undefined, undefined, approvedOwnerCtx);
assert.equal(setEmojiApproved.details.status, "ok");
assert.equal(setEmojiApproved.details.dryRun, false);
assert.ok(calls.some((call) => call.url.endsWith("/setStickerEmojiList")));

const createOwnerMismatch = await tools.get("sticker_pack").execute("create-owner-mismatch", {
  action: "create",
  userId: "12345",
  name: "owner mismatch",
  title: "Owner Mismatch",
  stickerPath: prepared.details.outputPath,
  emoji: "馃И",
  dryRun: false
}, undefined, undefined, { senderId: "99999" });
assert.equal(createOwnerMismatch.details.status, "failed");
assert.match(createOwnerMismatch.details.error, /owner-check/);

const uploadCallCount = calls.filter((call) => call.url.endsWith("/uploadStickerFile")).length;
assert.equal(uploadCallCount, 2);

const stickerTool = tools.get("sticker_pack");
const originalStickerToolConfig = stickerTool.config;
stickerTool.config = {
  ...originalStickerToolConfig,
  trustedDirectMutations: {
    enabled: true,
    actions: ["create"]
  }
};
try {
  const directTrustedCreate = await stickerTool.execute("create-direct-trusted", {
    action: "create",
    userId: "12345",
    name: "direct trusted",
    title: "Direct Trusted",
    stickerPath: prepared.details.outputPath,
    emoji: "\uD83D\uDE42",
    dryRun: false
  }, undefined, undefined, ownerCtx);
  assert.equal(directTrustedCreate.details.status, "ok");
  assert.equal(directTrustedCreate.details.dryRun, false);
  assert.ok(calls.some((call) => call.url.endsWith("/createNewStickerSet") && call.body?.name === "direct_trusted_by_YOUR_BOT_USERNAME"));

  const directTrustedCreateFromSessionKey = await stickerTool.execute("create-direct-session-key", {
    action: "create",
    userId: "12345",
    name: "direct session key",
    title: "Direct Session Key",
    stickerPath: prepared.details.outputPath,
    emoji: "\uD83D\uDE42",
    dryRun: false
  }, undefined, undefined, sessionKeyOnlyOwnerCtx);
  assert.equal(directTrustedCreateFromSessionKey.details.status, "ok");
  assert.equal(directTrustedCreateFromSessionKey.details.dryRun, false);
  assert.ok(calls.some((call) => call.url.endsWith("/createNewStickerSet") && call.body?.name === "direct_session_key_by_YOUR_BOT_USERNAME"));

  const directTrustedDeleteBlocked = await stickerTool.execute("delete-direct-not-allowed", {
    action: "delete_sticker",
    fileId: "file_direct_delete",
    dryRun: false
  }, undefined, undefined, ownerCtx);
  assert.equal(directTrustedDeleteBlocked.details.status, "failed");
  assert.match(directTrustedDeleteBlocked.details.error, /delete confirmation|trusted runtime/);
} finally {
  stickerTool.config = originalStickerToolConfig;
}

const hookUploadPlanParams = {
  action: "plan",
  targetAction: "upload",
  userId: "tg:12345",
  stickerPath: prepared.details.outputPath,
  dryRun: false,
  reason: "hook-captured upload"
};
await runHooks("before_tool_call", {
  toolName: "sticker_pack",
  toolCallId: "hook-upload-plan",
  runId: "hook-run",
  params: hookUploadPlanParams
}, stickerPlanCtx);
const hookUploadPlan = await tools.get("sticker_pack").execute("hook-upload-plan", hookUploadPlanParams);
assert.equal(hookUploadPlan.details.status, "planned");
await runHooks("after_tool_call", {
  toolName: "sticker_pack",
  toolCallId: "hook-upload-plan",
  runId: "hook-run",
  result: hookUploadPlan
}, stickerPlanCtx);

const hookUploadParams = {
  action: "upload",
  userId: "tg:12345",
  stickerPath: prepared.details.outputPath,
  dryRun: false,
  plan_id: hookUploadPlan.details.planId
};
await runHooks("before_tool_call", {
  toolName: "sticker_pack",
  toolCallId: "hook-upload-real",
  runId: "hook-run",
  params: hookUploadParams
}, stickerFollowupCtx());
const hookUploadedReal = await tools.get("sticker_pack").execute("hook-upload-real", hookUploadParams);
assert.equal(hookUploadedReal.details.status, "ok");
assert.equal(hookUploadedReal.details.dryRun, false);
await runHooks("after_tool_call", {
  toolName: "sticker_pack",
  toolCallId: "hook-upload-real",
  runId: "hook-run",
  result: hookUploadedReal
}, stickerFollowupCtx());

const created = await tools.get("sticker_pack").execute("create", {
  action: "create",
  userId: "12345",
  name: "lab stickers",
  title: "Lab Stickers",
  stickerPath: prepared.details.outputPath,
  emoji: "🧪"
});
assert.equal(created.details.status, "ok");
assert.equal(created.details.name, "lab_stickers_by_YOUR_BOT_USERNAME");
assert.equal(created.details.dryRun, true);

const createdReal = await tools.get("sticker_pack").execute("create-real", {
  action: "create",
  userId: "12345",
  name: "lab stickers real",
  title: "Lab Stickers Real",
  stickerPath: prepared.details.outputPath,
  emoji: "🧪",
  dryRun: false
}, undefined, undefined, approvedOwnerCtx);
assert.equal(createdReal.details.status, "ok");
assert.equal(createdReal.details.dryRun, false);
assert.ok(calls.some((call) => call.url.endsWith("/createNewStickerSet")));
const createRealCall = calls.find((call) => call.url.endsWith("/createNewStickerSet") && call.body?.name === "lab_stickers_real_by_YOUR_BOT_USERNAME");
assert.equal(createRealCall?.body?.sticker_type, undefined);
assert.equal(createRealCall?.body?.needs_repainting, undefined);

const managedAfterCreate = await tools.get("sticker_pack").execute("managed-after-create", {
  action: "list_managed_sets",
  userId: "12345"
});
assert.equal(managedAfterCreate.details.status, "ok");
assert.equal(managedAfterCreate.details.defaultSet, createdReal.details.name);
assert.ok(managedAfterCreate.details.managedSets.some((item) => item.name === createdReal.details.name && item.createdByBot));

const addStickerCallCountBefore = calls.filter((call) => call.url.endsWith("/addStickerToSet")).length;
const addFromStickerReal = await tools.get("sticker_pack").execute("add-from-sticker-real", {
  action: "add_from_sticker",
  userId: "12345",
  fileId: "sent_real_file_id",
  emoji: "\uD83D\uDE42",
  dryRun: false
}, undefined, undefined, approvedOwnerCtx);
assert.equal(addFromStickerReal.details.status, "added_from_sticker");
assert.equal(addFromStickerReal.details.managedSet, createdReal.details.name);
assert.equal(addFromStickerReal.details.dryRun, false);
assert.equal(calls.filter((call) => call.url.endsWith("/addStickerToSet")).length, addStickerCallCountBefore + 1);
const addFromStickerCall = calls.find((call) => call.url.endsWith("/addStickerToSet") && call.body?.sticker?.sticker === "sent_real_file_id");
assert.equal(addFromStickerCall?.body?.name, createdReal.details.name);

const addFromStickerOwnerMismatch = await tools.get("sticker_pack").execute("add-from-sticker-owner-mismatch", {
  action: "add_from_sticker",
  userId: "12345",
  fileId: "sent_real_file_id",
  emoji: "\uD83D\uDE42",
  dryRun: false
}, undefined, undefined, { senderId: "99999" });
assert.equal(addFromStickerOwnerMismatch.details.status, "failed");
assert.match(addFromStickerOwnerMismatch.details.error, /owner-check/);

const forgotManagedSet = await tools.get("sticker_pack").execute("forget-managed", {
  action: "forget_managed_set",
  userId: "12345",
  name: "manual_default_by_YOUR_BOT_USERNAME"
}, undefined, undefined, ownerCtx);
assert.equal(forgotManagedSet.details.status, "managed_set_forgotten");
assert.equal(forgotManagedSet.details.found, true);

const createdBatch = await tools.get("sticker_pack").execute("create-batch", {
  action: "create_batch",
  userId: "12345",
  name: "batch stickers",
  title: "Batch Stickers",
  inputs: batch.details.stickers.map((item) => item.outputPath),
  emoji: "\uD83D\uDE42",
  dryRun: true
});
assert.equal(createdBatch.details.status, "ok");
assert.equal(createdBatch.details.count, 2);
assert.equal(createdBatch.details.name, "batch_stickers_by_YOUR_BOT_USERNAME");

const defaultDryRunBatch = await tools.get("sticker_pack").execute("create-batch-default-dry-run", {
  action: "create_batch",
  userId: "12345",
  name: "default dry run batch",
  title: "Default Dry Run Batch",
  items: [
    { fileId: "file_a", emoji: "\uD83D\uDE42" },
    { fileId: "file_b", emoji: "\uD83D\uDE0E" }
  ]
});
assert.equal(defaultDryRunBatch.details.status, "ok");
assert.equal(defaultDryRunBatch.details.dryRun, true);
assert.equal(defaultDryRunBatch.details.count, 2);

const mixedRealBatch = await tools.get("sticker_pack").execute("create-batch-mixed-real", {
  action: "create_batch",
  userId: "12345",
  name: "mixed tgs static",
  title: "Mixed TGS Static",
  items: [
    { input: prepared.details.outputPath, emoji: "🙂" },
    { input: animatedStickerPath, emoji: "🚀" }
  ],
  dryRun: false
}, undefined, undefined, approvedOwnerCtx);
assert.equal(mixedRealBatch.details.status, "ok");
assert.equal(mixedRealBatch.details.dryRun, false);
const mixedCreateCall = calls.find((call) => call.url.endsWith("/createNewStickerSet") && call.body?.name === "mixed_tgs_static_by_YOUR_BOT_USERNAME");
assert.ok(mixedCreateCall, "mixed static/TGS create_batch should call createNewStickerSet");
assert.equal(mixedCreateCall.bodyType, "FormData");
assert.deepEqual(mixedCreateCall.body.stickers.map((item) => item.format), ["static", "animated"]);
assert.equal(mixedCreateCall.body.sticker0.type, "image/webp");
assert.equal(mixedCreateCall.body.sticker1.type, "application/x-tgsticker");
assert.equal(mixedCreateCall.body.sticker1.name, "animated.tgs");

const overLimitBatch = await tools.get("sticker_pack").execute("create-batch-over-limit", {
  action: "create_batch",
  userId: "12345",
  name: "too many stickers",
  title: "Too Many Stickers",
  items: Array.from({ length: 51 }, (_, index) => ({ fileId: `file_${index}`, emoji: "\uD83D\uDE42" })),
  dryRun: true
});
assert.equal(overLimitBatch.details.status, "failed");
assert.match(overLimitBatch.details.error, /up to 50/);

const addedBatch = await tools.get("sticker_pack").execute("add-batch", {
  action: "add_batch",
  userId: "12345",
  name: "batch_stickers_by_YOUR_BOT_USERNAME",
  inputs: batch.details.stickers.map((item) => item.outputPath),
  emoji: "\uD83D\uDE42",
  dryRun: true
});
assert.equal(addedBatch.details.status, "ok");
assert.equal(addedBatch.details.count, 2);

const defaultDryRunAddBatch = await tools.get("sticker_pack").execute("add-batch-default-dry-run", {
  action: "add_batch",
  userId: "12345",
  name: "batch_stickers_by_YOUR_BOT_USERNAME",
  items: [{ fileId: "file_c", emoji: "\uD83D\uDE42" }]
});
assert.equal(defaultDryRunAddBatch.details.status, "ok");
assert.equal(defaultDryRunAddBatch.details.dryRun, true);
assert.equal(defaultDryRunAddBatch.details.count, 1);

const got = await tools.get("sticker_pack").execute("get", {
  action: "get",
  name: "test_by_YOUR_BOT_USERNAME"
});
assert.equal(got.details.status, "ok");
assert.equal(got.details.count, 1);

await assert.rejects(
  () => __testing.resolveAllowedFile({ allowedMediaRoots: [mediaRoot] }, path.join(os.homedir(), "Desktop", "private.png")),
  /outside allowed/
);

console.log("sticker pack plugin tests passed");

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import mediaArtifacts, { __testing } from "../plugins/imagebot-media-artifacts/index.js";

const {
  buildMediaContext,
  resolveImageInputs,
  resolveToolMediaInputs,
  findBadGeneratedRefs,
  findUnavailableHandleRefs,
  collectGeneratedMediaPaths,
  toolResultImageContextMiddleware,
  normalizePathKey
} = __testing;

const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-media-artifacts-test-"));
const logPath = path.join(storeDir, "artifacts.jsonl");
const openclawMediaRoot = path.join(storeDir, "openclaw-media");
const inboundFromUri = path.join(openclawMediaRoot, "inbound", "current-media-id.jpg");
await fs.mkdir(path.dirname(inboundFromUri), { recursive: true });
await fs.writeFile(inboundFromUri, "fake inbound image", "utf8");

const generated = "C:\\Users\\Bot\\.openclaw\\media\\tool-image-generation\\wrong-old.png";
const source = "C:\\Users\\Bot\\.openclaw\\media\\inbound\\source-reference.jpg";
const current = "media://inbound/current-media-id.jpg (image/jpeg)";
const replyInbound = "C:\\Users\\Bot\\.openclaw\\media\\inbound\\reply.webp";

await fs.writeFile(logPath, `${JSON.stringify({
  type: "artifact",
  artifactId: "seed-generated",
  t: "2026-06-17T00:00:00.000Z",
  kind: "image",
  sourceKind: "generated",
  handle: "reply.generated.0",
  path: generated,
  pathKey: normalizePathKey(generated),
  sessionKey: "session-a",
  runId: "old-run",
  lineage: [{ path: source, sourceKind: "telegram_reply", handle: "reply.image.0" }]
})}\n`, "utf8");

const prompt = [
  `CurrentMediaPaths: ${current}`,
  `ReplyMediaPaths: ${generated}, ${replyInbound}`
].join("\n");

const context = await buildMediaContext(
  { storeDir, mediaRoot: openclawMediaRoot },
  { prompt },
  { sessionKey: "session-a", runId: "run-a" }
);

const handles = new Map(context.items.map((item) => [item.handle, item]));
assert.equal(handles.get("current.image.0")?.path, inboundFromUri);
assert.equal(handles.get("reply.image.0")?.path, replyInbound);
assert.equal(handles.get("reply.generated.0")?.path, generated);
assert.equal(handles.get("reply.generated.0.source.0")?.path, source);

const currentHandle = resolveImageInputs({ image: "current.image.0" }, context);
assert.equal(currentHandle.params.image, inboundFromUri);
assert.equal(findUnavailableHandleRefs(currentHandle.resolvedRefs).length, 0);

const staleHandle = resolveImageInputs({ image: "current.image.0" }, null);
assert.equal(findUnavailableHandleRefs(staleHandle.resolvedRefs).length, 1);
assert.equal(findUnavailableHandleRefs(staleHandle.resolvedRefs)[0].value, "current.image.0");

const clean = resolveImageInputs({ images: ["reply.generated.0.source.0"] }, context);
assert.deepEqual(clean.params.images, [source]);
assert.equal(findBadGeneratedRefs(clean.resolvedRefs, true).length, 0);

const mediaTransformHandle = resolveToolMediaInputs({ input: "current.image.0" }, context, { fields: ["input", "image"] });
assert.equal(mediaTransformHandle.params.input, inboundFromUri);
assert.equal(findUnavailableHandleRefs(mediaTransformHandle.resolvedRefs).length, 0);

const stickerHandleBatch = resolveToolMediaInputs({
  input: "current.image.0",
  inputs: ["reply.image.0"],
  items: [{ input: "reply.generated.0.source.0" }]
}, context, {
  fields: ["input", "image", "media", "stickerPath", "prepared", "file"],
  arrays: ["inputs"],
  itemArrays: ["items"],
  itemFields: ["input", "image", "media", "stickerPath", "prepared", "file"]
});
assert.equal(stickerHandleBatch.params.input, inboundFromUri);
assert.deepEqual(stickerHandleBatch.params.inputs, [replyInbound]);
assert.equal(stickerHandleBatch.params.items[0].input, source);

const missingToolHandle = resolveToolMediaInputs({ input: "current.image.0" }, null, { fields: ["input"] });
assert.equal(findUnavailableHandleRefs(missingToolHandle.resolvedRefs)[0].value, "current.image.0");

const polluted = resolveImageInputs({ images: [generated] }, context);
const bad = findBadGeneratedRefs(polluted.resolvedRefs, true);
assert.equal(bad.length, 1);
assert.equal(bad[0].value, generated);

const mediaLines = collectGeneratedMediaPaths({
  content: [{ type: "text", text: `done\nMEDIA:${generated}\n` }]
});
assert.deepEqual(mediaLines, [generated]);

const tools = new Map();
const middleware = [];
const lifecycleHooks = new Map();
mediaArtifacts.register({
  config: {
    storeDir,
    mediaRoot: openclawMediaRoot,
    allowedMediaRoots: [storeDir],
    dependencyDirs: [path.join(process.cwd(), "plugins", "imagebot-practical-tools")],
    visionContextGate: { loliVisionGuard: { enabled: false } }
  },
  registerTool(tool, meta = {}) {
    tools.set(meta.name || tool.name, tool);
  },
  registerHook(name, handler) {
    if (!lifecycleHooks.has(name)) lifecycleHooks.set(name, []);
    lifecycleHooks.get(name).push(handler);
  },
  registerAgentToolResultMiddleware(handler, options = {}) {
    middleware.push({ handler, options });
  }
});
assert.ok(tools.has("media_artifact"));
assert.ok(tools.has("media_artifact_recent"));
assert.equal(middleware.length, 1);
assert.deepEqual(middleware[0].options.runtimes, ["openclaw", "codex"]);

for (const handler of lifecycleHooks.get("before_prompt_build") || []) {
  await handler({ prompt }, { agentId: "imagebot", sessionKey: "hook-session", runId: "hook-run" });
}
const mediaRewriteHook = lifecycleHooks.get("before_tool_call")?.[0];
const rewrittenMediaTool = await mediaRewriteHook({
  toolName: "media_transform",
  params: { input: "current.image.0" },
  runId: "hook-run"
}, { agentId: "imagebot", sessionKey: "hook-session", runId: "hook-run" });
assert.equal(rewrittenMediaTool.params.input, inboundFromUri);
const blockedMissingHandle = await mediaRewriteHook({
  toolName: "meme_transform",
  params: { input: "current.image.0" },
  runId: "missing-run"
}, { agentId: "imagebot", sessionKey: "missing-session", runId: "missing-run" });
assert.equal(blockedMissingHandle.block, true);
assert.match(blockedMissingHandle.blockReason, /current\.image\.0/);

const pngPath = path.join(storeDir, "tool-result.png");
const require = createRequire(path.join(process.cwd(), "plugins", "imagebot-practical-tools", "index.js"));
await require("sharp")({ create: { width: 32, height: 32, channels: 3, background: "#44aaee" } }).png().toFile(pngPath);
const imageContext = await toolResultImageContextMiddleware({
  toolName: "synthetic_image_tool",
  result: {
    content: [{ type: "text", text: `SYNTHETIC ok\nMEDIA: \`${pngPath}\`` }],
    details: { status: "ok", media: { path: pngPath } }
  }
}, {}, {
  allowedMediaRoots: [storeDir],
  dependencyDirs: [path.join(process.cwd(), "plugins", "imagebot-practical-tools")],
  visionContextGate: { loliVisionGuard: { enabled: false } }
});
assert.equal(imageContext.result.content.filter((block) => block.type === "image").length, 1);
assert.equal(imageContext.result.details.toolResultImageContext.attachedCount, 1);

const wrappedToolCallContext = await toolResultImageContextMiddleware({
  toolName: "tool_call",
  result: {
    content: [{ type: "text", text: `WRAPPED ok\nMEDIA: \`${pngPath}\`` }],
    details: { status: "ok", media: { path: pngPath } }
  }
}, {}, {
  allowedMediaRoots: [storeDir],
  dependencyDirs: [path.join(process.cwd(), "plugins", "imagebot-practical-tools")],
  visionContextGate: { loliVisionGuard: { enabled: false } }
});
assert.equal(wrappedToolCallContext.result.content.filter((block) => block.type === "image").length, 0);
assert.equal(wrappedToolCallContext.result.details.toolResultImageContext, undefined);

const alreadyVisual = await toolResultImageContextMiddleware({
  toolName: "already_visual",
  result: {
    content: [
      { type: "text", text: `MEDIA: \`${pngPath}\`` },
      { type: "image", mimeType: "image/png", data: "abcd" }
    ],
    details: { status: "ok", media: { path: pngPath } }
  }
}, {}, {
  allowedMediaRoots: [storeDir],
  dependencyDirs: [path.join(process.cwd(), "plugins", "imagebot-practical-tools")],
  visionContextGate: { loliVisionGuard: { enabled: false } }
});
assert.equal(alreadyVisual.result.content.filter((block) => block.type === "image").length, 1);

const aggregateRecent = await tools.get("media_artifact").execute("aggregate-recent", { action: "recent", count: 3 });
assert.equal(aggregateRecent.details.status, "ok");
assert.ok(aggregateRecent.content[0].text.includes("MEDIA_ARTIFACT_RECENT"));

const aggregateLineage = await tools.get("media_artifact").execute("aggregate-lineage", { action: "lineage", id: "seed-generated" });
assert.equal(aggregateLineage.details.status, "ok");
assert.equal(aggregateLineage.details.result.artifactId, "seed-generated");

console.log("media-artifacts plugin tests passed");

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import mediaArtifacts, { __testing } from "../plugins/imagebot-media-artifacts/index.js";

const {
  buildMediaContext,
  resolveImageInputs,
  findBadGeneratedRefs,
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

const clean = resolveImageInputs({ images: ["reply.generated.0.source.0"] }, context);
assert.deepEqual(clean.params.images, [source]);
assert.equal(findBadGeneratedRefs(clean.resolvedRefs, true).length, 0);

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
mediaArtifacts.register({
  config: {
    storeDir,
    allowedMediaRoots: [storeDir],
    dependencyDirs: [path.join(process.cwd(), "plugins", "imagebot-practical-tools")],
    visionContextGate: { loliVisionGuard: { enabled: false } }
  },
  registerTool(tool, meta = {}) {
    tools.set(meta.name || tool.name, tool);
  },
  registerHook() {},
  registerAgentToolResultMiddleware(handler, options = {}) {
    middleware.push({ handler, options });
  }
});
assert.ok(tools.has("media_artifact_recent"));
assert.equal(middleware.length, 1);
assert.deepEqual(middleware[0].options.runtimes, ["openclaw", "codex"]);

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

console.log("media-artifacts plugin tests passed");

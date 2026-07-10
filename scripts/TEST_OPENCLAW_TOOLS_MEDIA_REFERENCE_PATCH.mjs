import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawDistDir } from "./OPENCLAW_RUNTIME_PATHS.mjs";

const distDir = resolveOpenClawDistDir();

async function readDistFile(prefix, requiredMarker) {
  const names = await fs.readdir(distDir);
  for (const name of names.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".js")).sort()) {
    const filePath = path.join(distDir, name);
    const source = await fs.readFile(filePath, "utf8");
    if (!requiredMarker || source.includes(requiredMarker)) return { name, source, filePath };
  }
  throw new Error(`No dist file found for ${prefix} with marker ${requiredMarker || "(none)"}`);
}

const openclawTools = await readDistFile("openclaw-tools-", "forceDocument");
const mediaReference = await readDistFile("media-reference-", "resolveMediaReferenceLocalPath");

assert.match(
  openclawTools.source,
  /import \{ [^}]* as resolveMediaReferenceLocalPath[^}]* \} from "\.\/media-reference-[^"]+\.js";/,
);
assert.match(openclawTools.source, /async function resolveMediaReferenceForLocalToolInput\(input\)/);
assert.ok(openclawTools.source.includes("if (/^media:\\/\\//i.test(input))"));
assert.match(openclawTools.source, /return await resolveMediaReferenceLocalPath\(input\)/);

const localResolverMentions = openclawTools.source.match(/\bresolveMediaReferenceForLocalToolInput\(/g) || [];
const awaitedLocalResolverCalls = openclawTools.source.match(/await resolveMediaReferenceForLocalToolInput\(/g) || [];
assert.equal(localResolverMentions.length, 5, "helper definition plus image_generate, image, music_generate, and video_generate uses");
assert.equal(awaitedLocalResolverCalls.length, 4, "all non-sandbox local media loaders must resolve media:// references before loadWebMedia");

assert.doesNotMatch(
  openclawTools.source,
  /resolvedImage\.startsWith\("file:\/\/"\) \? resolvedImage\.slice\(7\) : resolvedImage/,
);
assert.doesNotMatch(
  openclawTools.source,
  /resolvedInput\.startsWith\("file:\/\/"\) \? resolvedInput\.slice\(7\) : resolvedInput/,
);
assert.match(openclawTools.source, /const RECENT_PROBLEM_STATUSES = new Set\(\["failed", "timed_out", "cancelled", "lost"\]\)/);
assert.match(openclawTools.source, /function findRecentProblemImageGenerationTaskForSession\(sessionKey\)/);
assert.match(openclawTools.source, /RECENT_IMAGE_GENERATION_PROBLEM_STATUS_MS = 30 \* 6e4/);
assert.match(openclawTools.source, /No completion event is expected for this \$\{params\.completionLabel\}/);
assert.match(openclawTools.source, /const recentProblemTask = findRecentProblemImageGenerationTaskForSession\(sessionKey\)/);
assert.match(openclawTools.source, /buildImageGenerationTaskProblemStatusDetails\(recentProblemTask\)/);
assert.match(openclawTools.source, /failure reason from the internal event result\/error plainly/);
assert.match(mediaReference.source, /async function resolveMediaReferenceLocalPath\(\w+\)/);
assert.match(mediaReference.source, /resolveMediaBufferPath\(\w+, "inbound"\)/);

console.log("openclaw tools media reference patch tests passed", {
  openclawTools: openclawTools.name,
  mediaReference: mediaReference.name,
});

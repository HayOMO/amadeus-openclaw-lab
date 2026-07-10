import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureModelFiles, screenMediaBatch } from "../plugins/imagebot-shared/loli-nsfw-vision-guard.mjs";
import { openclawStatePath } from "../plugins/imagebot-shared/openclaw-paths.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const config = {
  modelDir: openclawStatePath("models", "wd-v1-4-vit-tagger-v2"),
  dependencyDirs: [
    path.join(repoRoot, "plugins", "imagebot-practical-tools"),
    path.join(repoRoot, "plugins", "imagebot-memory-search")
  ],
  autoDownload: true
};

const files = await ensureModelFiles(config);
console.log(JSON.stringify({
  status: "ok",
  modelPath: files.modelPath,
  tagsPath: files.tagsPath
}, null, 2));

if (process.argv.includes("--smoke")) {
  const result = await screenMediaBatch({ media: [], text: "", config });
  console.log(JSON.stringify({ smoke: result.status }, null, 2));
}

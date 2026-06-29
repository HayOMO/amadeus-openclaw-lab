import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginModule = await import(pathToFileURL(path.join(repoRoot, "plugins", "imagebot-generated-gallery", "index.js")).href);
const require = createRequire(path.join(repoRoot, "plugins", "imagebot-generated-gallery", "index.js"));
const sharp = require("sharp");

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-gallery-test-"));
const archiveRoot = path.join(tmpRoot, "archive");
const homeRoot = path.join(tmpRoot, "home");
const monthDir = path.join(archiveRoot, "2026-06");
const manifestPath = path.join(archiveRoot, "manifest.jsonl");

process.env.TELEGRAM_IMAGEBOT_MEDIA_ARCHIVE_DIR = archiveRoot;
process.env.USERPROFILE = homeRoot;
process.env.HOME = homeRoot;

const tools = new Map();
pluginModule.default.register({
  registerTool(tool) {
    tools.set(tool.name, tool);
  }
});

function sha(ch) {
  return ch.repeat(64);
}

function manifestRecord(fields) {
  return JSON.stringify({
    t: fields.t,
    tool: fields.tool ?? "image_generate",
    sourceKind: fields.sourceKind ?? "tool-image-generation",
    sourceName: fields.sourceName ?? path.basename(fields.archivedRelativePath),
    sizeBytes: fields.sizeBytes ?? 10,
    sha256: fields.sha256,
    archivedRelativePath: fields.archivedRelativePath,
    copied: true,
    sessionKeyHash: fields.sessionKeyHash ?? "test-session"
  });
}

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/l5b0JAAAAABJRU5ErkJggg==",
  "base64"
);

async function writeArchiveFile(relativePath, data = onePixelPng) {
  const filePath = path.join(archiveRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
}

async function shapePng(kind) {
  const rect = kind === "right"
    ? '<rect x="44" y="10" width="14" height="18" fill="#111"/>'
    : kind === "left-soft"
      ? '<rect x="5" y="10" width="14" height="18" fill="#111"/><rect x="20" y="13" width="8" height="12" fill="#777"/>'
      : '<rect x="4" y="10" width="14" height="18" fill="#111"/><rect x="20" y="14" width="7" height="11" fill="#777"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="40"><rect width="64" height="40" fill="#f5f5f5"/>${rect}</svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

async function runTool(name, params) {
  const tool = tools.get(name);
  assert.ok(tool, `tool registered: ${name}`);
  const result = await tool.execute("test-call", params);
  assert.equal(result.details.status, "ok", `${name} status ok`);
  return result;
}

try {
  await fs.mkdir(monthDir, { recursive: true });
  await fs.mkdir(homeRoot, { recursive: true });
  await writeArchiveFile("2026-06/older.png");
  await writeArchiveFile("2026-06/newer.png");
  await writeArchiveFile("2026-06/downloaded.png");

  const duplicateSha = sha("a");
  const initialLines = [
    manifestRecord({
      t: "2026-06-13T10:00:00.000Z",
      sha256: duplicateSha,
      sourceName: "older.png",
      archivedRelativePath: "2026-06/older.png"
    }),
    manifestRecord({
      t: "2026-06-13T10:05:00.000Z",
      sha256: sha("b"),
      sourceName: "downloaded.png",
      tool: "download_image_url",
      sourceKind: "downloaded",
      archivedRelativePath: "2026-06/downloaded.png"
    }),
    manifestRecord({
      t: "2026-06-13T10:10:00.000Z",
      sha256: sha("c"),
      sourceName: "escape.png",
      archivedRelativePath: "../escape.png"
    }),
    manifestRecord({
      t: "2026-06-13T10:15:00.000Z",
      sha256: sha("d"),
      sourceName: "notes.txt",
      archivedRelativePath: "2026-06/notes.txt"
    }),
    manifestRecord({
      t: "2026-06-13T10:20:00.000Z",
      sha256: duplicateSha,
      sourceName: "newer.png",
      archivedRelativePath: "2026-06/newer.png"
    })
  ];
  await fs.writeFile(manifestPath, `${initialLines.join("\n")}\n`, "utf8");

  const recent = await runTool("generated_gallery_recent", { count: 3 });
  const recentText = recent.content[0].text;
  assert.match(recentText, /newer\.png/);
  assert.match(recentText, /visualPreview:/);
  assert.ok(recent.content.some((item) => item.type === "image"), "recent should include a contact-sheet preview");
  assert.doesNotMatch(recentText, /older\.png/);
  assert.doesNotMatch(recentText, /escape\.png/);
  assert.doesNotMatch(recentText, /notes\.txt/);

  const search = await runTool("generated_gallery_search", { query: "newer", count: 1 });
  assert.equal(search.details.results[0].sourceName, "newer.png");
  assert.ok(search.content.some((item) => item.type === "image"), "search should include a contact-sheet preview");
  assert.ok(Object.hasOwn(tools.get("generated_gallery_search").parameters.properties, "image"), "search should support visual query image");
  assert.ok(Object.hasOwn(tools.get("generated_gallery_search").parameters.properties, "maxDistance"), "search should expose visual maxDistance");

  const downloaded = await runTool("generated_gallery_recent", { source: "downloaded", count: 2 });
  assert.equal(downloaded.details.results.length, 1);
  assert.equal(downloaded.details.results[0].sourceName, "downloaded.png");

  const stats = await runTool("generated_gallery_stats", { source: "all" });
  assert.equal(stats.details.stats.total, 2);
  assert.equal(stats.details.stats.byTool.some((entry) => entry.key === "image_generate" && entry.value === 1), true);
  assert.equal(stats.details.stats.byTool.some((entry) => entry.key === "download_image_url" && entry.value === 1), true);
  assert.match(stats.content[0].text, /GENERATED_GALLERY_STATS ok/);

  const resend = await runTool("generated_gallery_resend", { id: duplicateSha.slice(0, 16) });
  assert.equal(resend.details.media.trustedLocalMedia, true);
  assert.equal(resend.details.media.outbound, false);
  assert.equal(resend.details.media.mediaUrls.length, 1);
  assert.match(resend.content[0].text, /MEDIA:/);
  const resendPath = resend.details.media.mediaUrls[0];
  assert.ok(path.resolve(resendPath).startsWith(path.join(homeRoot, ".openclaw", "media", "gallery-resend")));
  await fs.stat(resendPath);

  const noMatch = await tools.get("generated_gallery_resend").execute("test-call", { id: sha("f").slice(0, 16) });
  assert.equal(noMatch.details.status, "no_match");

  await writeArchiveFile("2026-06/shape-left.png", await shapePng("left"));
  await writeArchiveFile("2026-06/shape-left-soft.png", await shapePng("left-soft"));
  await writeArchiveFile("2026-06/shape-right.png", await shapePng("right"));
  await fs.appendFile(manifestPath, `${[
    manifestRecord({
      t: "2026-06-13T10:30:00.000Z",
      sha256: sha("1"),
      sourceName: "shape-left.png",
      archivedRelativePath: "2026-06/shape-left.png"
    }),
    manifestRecord({
      t: "2026-06-13T10:31:00.000Z",
      sha256: sha("2"),
      sourceName: "shape-left-soft.png",
      archivedRelativePath: "2026-06/shape-left-soft.png"
    }),
    manifestRecord({
      t: "2026-06-13T10:32:00.000Z",
      sha256: sha("3"),
      sourceName: "shape-right.png",
      archivedRelativePath: "2026-06/shape-right.png"
    })
  ].join("\n")}\n`, "utf8");
  const visual = await runTool("generated_gallery_search", {
    image: path.join(archiveRoot, "2026-06", "shape-left.png"),
    source: "all",
    count: 6,
    preview: false
  });
  assert.equal(visual.details.visual, true);
  assert.equal(visual.details.results[0].sourceName, "shape-left.png");
  assert.equal(visual.details.results[0].visualDistance, 0);
  assert.match(visual.content[0].text, /mode=visual/);
  assert.match(visual.content[0].text, /visualDistance=0/);
  const visualNames = visual.details.results.map((entry) => entry.sourceName);
  assert.ok(
    visualNames.indexOf("shape-left-soft.png") !== -1 && visualNames.indexOf("shape-right.png") !== -1,
    "visual search should include both similar and contrasting shape fixtures",
  );
  assert.ok(
    visualNames.indexOf("shape-left-soft.png") < visualNames.indexOf("shape-right.png"),
    "visually similar shape should rank before contrasting shape",
  );

  const benchLines = [];
  for (let i = 0; i < 12000; i += 1) {
    const n = String(i).padStart(5, "0");
    benchLines.push(manifestRecord({
      t: `2026-06-13T11:${String(i % 60).padStart(2, "0")}:00.000Z`,
      sha256: `${String(i % 10).repeat(64)}`.slice(0, 64),
      sourceName: `bench-${n}.png`,
      archivedRelativePath: `2026-06/bench-${n}.png`
    }));
  }
  await fs.appendFile(manifestPath, `${benchLines.join("\n")}\n`, "utf8");
  const start = performance.now();
  const perfRecent = await runTool("generated_gallery_recent", { count: 6 });
  const durationMs = performance.now() - start;
  assert.ok(perfRecent.details.results.length > 0);
  assert.ok(durationMs < 1500, `large manifest recent lookup too slow: ${durationMs.toFixed(1)}ms`);
  console.log(`generated gallery tests passed; large-manifest lookup ${durationMs.toFixed(1)}ms`);
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

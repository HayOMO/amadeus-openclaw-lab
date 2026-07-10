import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { openclawStatePath } from "../plugins/imagebot-shared/openclaw-paths.mjs";

const scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const repoRoot = path.resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const DEFAULT_ROOT = openclawStatePath("media", "archive");
const DEFAULT_LIMIT = 512;
const DEFAULT_CONCURRENCY = 4;
const HASH_MAX_DISTANCE = 192;

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function readNumberArg(name, fallback, min, max) {
  const raw = Number(argValue(name, ""));
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(raw)));
}

function loadSharp() {
  const candidatePaths = [
    path.join(repoRoot, "plugins", "imagebot-generated-gallery", "node_modules"),
    path.join(repoRoot, "plugins", "imagebot-practical-tools", "node_modules"),
    path.join(repoRoot, "plugins", "imagebot-sticker-pack", "node_modules"),
    path.join(repoRoot, "node_modules")
  ];
  const resolved = require.resolve("sharp", { paths: candidatePaths });
  return require(resolved);
}

async function listImages(root, limit) {
  const files = [];
  const stack = [path.resolve(root)];
  while (stack.length && files.length < limit) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        files.push(full);
        if (files.length >= limit) break;
      }
    }
  }
  return files;
}

function bitsToHex(bits) {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    let value = 0;
    for (let j = 0; j < 4; j += 1) {
      value = (value << 1) | (bits[i + j] ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
}

function popcountBigInt(value) {
  let count = 0;
  let current = value;
  while (current > 0n) {
    count += Number(current & 1n);
    current >>= 1n;
  }
  return count;
}

function hammingHex(left, right) {
  if (!left || !right || left.length !== right.length) return HASH_MAX_DISTANCE;
  return popcountBigInt(BigInt(`0x${left}`) ^ BigInt(`0x${right}`));
}

async function rawGreyscalePixels(sharp, filePath, width, height) {
  const { data, info } = await sharp(filePath, { animated: false, limitInputPixels: 72_000_000 })
    .rotate()
    .resize(width, height, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels < 1) {
    throw new Error("unexpected pixel shape");
  }
  return data;
}

const dctCos = Array.from({ length: 8 }, (_, u) =>
  Array.from({ length: 32 }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / 64))
);
const dctScale = Array.from({ length: 8 }, (_, u) => (u === 0 ? Math.sqrt(1 / 32) : Math.sqrt(2 / 32)));

function phashFrom32x32(pixels) {
  const coeffs = [];
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let y = 0; y < 32; y += 1) {
        const row = y * 32;
        const cy = dctCos[v][y];
        for (let x = 0; x < 32; x += 1) {
          sum += (pixels[row + x] - 128) * dctCos[u][x] * cy;
        }
      }
      coeffs.push(dctScale[u] * dctScale[v] * sum);
    }
  }
  const ac = coeffs.slice(1).sort((left, right) => left - right);
  const median = ac[Math.floor(ac.length / 2)];
  return bitsToHex(coeffs.slice(1).map((value) => value >= median));
}

async function computeHashes(sharp, filePath, includePhash) {
  const t0 = performance.now();
  const averagePixels = await rawGreyscalePixels(sharp, filePath, 8, 8);
  const avg = averagePixels.reduce((sum, value) => sum + value, 0) / averagePixels.length;
  const ahash = bitsToHex([...averagePixels].map((value) => value >= avg));

  const diffPixels = await rawGreyscalePixels(sharp, filePath, 9, 8);
  const dBits = [];
  for (let y = 0; y < 8; y += 1) {
    const row = y * 9;
    for (let x = 0; x < 8; x += 1) dBits.push(diffPixels[row + x] > diffPixels[row + x + 1]);
  }
  const dhash = bitsToHex(dBits);
  const t1 = performance.now();

  let phash = "";
  let phashMs = 0;
  if (includePhash) {
    const p0 = performance.now();
    phash = phashFrom32x32(await rawGreyscalePixels(sharp, filePath, 32, 32));
    phashMs = performance.now() - p0;
  }
  return {
    filePath,
    ahash,
    dhash,
    phash,
    ahashDhashMs: t1 - t0,
    phashMs,
    totalMs: performance.now() - t0
  };
}

async function mapLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length));
  return sorted[index];
}

function summarizeMs(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  const totalMs = clean.reduce((sum, value) => sum + value, 0);
  return {
    totalMs: Number(totalMs.toFixed(2)),
    avgMs: Number((totalMs / Math.max(1, clean.length)).toFixed(3)),
    p50Ms: Number(percentile(clean, 50).toFixed(3)),
    p95Ms: Number(percentile(clean, 95).toFixed(3))
  };
}

function scanQueries(records, queryCount) {
  const queries = records.slice(0, Math.min(queryCount, records.length));
  const t0 = performance.now();
  let comparisons = 0;
  const top = [];
  for (const query of queries) {
    let best = { filePath: "", distance: Number.POSITIVE_INFINITY };
    for (const record of records) {
      comparisons += 1;
      const ad = hammingHex(query.ahash, record.ahash) + hammingHex(query.dhash, record.dhash);
      const pd = query.phash && record.phash ? hammingHex(query.phash, record.phash) : 0;
      const distance = ad + pd;
      if (distance < best.distance && record.filePath !== query.filePath) {
        best = { filePath: record.filePath, distance };
      }
    }
    top.push({ query: path.basename(query.filePath), best: path.basename(best.filePath), distance: best.distance });
  }
  const totalMs = performance.now() - t0;
  return {
    queries: queries.length,
    candidates: records.length,
    comparisons,
    totalMs: Number(totalMs.toFixed(3)),
    avgMsPerQuery: Number((totalMs / Math.max(1, queries.length)).toFixed(4)),
    comparisonsPerMs: Number((comparisons / Math.max(0.001, totalMs)).toFixed(1)),
    examples: top.slice(0, 3)
  };
}

const root = path.resolve(argValue("--root", DEFAULT_ROOT));
const limit = readNumberArg("--limit", DEFAULT_LIMIT, 1, 100_000);
const concurrency = readNumberArg("--concurrency", DEFAULT_CONCURRENCY, 1, 32);
const queryCount = readNumberArg("--queries", 20, 1, 1000);
const includePhash = !process.argv.includes("--no-phash");
const outputPath = path.resolve(argValue("--output", openclawStatePath("imagebot", "mars-image-sim-benchmark.json")));

const sharp = loadSharp();
const files = await listImages(root, limit);
if (!files.length) throw new Error(`no images found under ${root}`);
const sizes = files.map((file) => fsSync.statSync(file).size);
const startedAt = new Date().toISOString();
const t0 = performance.now();
const records = (await mapLimit(files, concurrency, async (filePath) => {
  try {
    return await computeHashes(sharp, filePath, includePhash);
  } catch (error) {
    return { filePath, error: String(error?.message || error) };
  }
})).filter((item) => !item.error);
const wallMs = performance.now() - t0;
const failed = files.length - records.length;
const scan = scanQueries(records, queryCount);
const report = {
  schema: 1,
  kind: "mars_image_similarity_benchmark",
  startedAt,
  finishedAt: new Date().toISOString(),
  root,
  limit,
  concurrency,
  includePhash,
  sharp: { sharp: sharp.versions?.sharp, vips: sharp.versions?.vips },
  files: {
    found: files.length,
    processed: records.length,
    failed,
    totalMB: Number((sizes.reduce((sum, value) => sum + value, 0) / 1024 / 1024).toFixed(2)),
    avgMB: Number((sizes.reduce((sum, value) => sum + value, 0) / Math.max(1, sizes.length) / 1024 / 1024).toFixed(3)),
    maxMB: Number((Math.max(...sizes) / 1024 / 1024).toFixed(2))
  },
  precompute: {
    wallMs: Number(wallMs.toFixed(2)),
    imagesPerSecond: Number((records.length / Math.max(0.001, wallMs / 1000)).toFixed(2)),
    ahashDhash: summarizeMs(records.map((item) => item.ahashDhashMs)),
    phash: includePhash ? summarizeMs(records.map((item) => item.phashMs)) : null,
    totalPerImage: summarizeMs(records.map((item) => item.totalMs))
  },
  scan,
  estimates: {
    precomputeMsPer1000: Number((wallMs / Math.max(1, records.length) * 1000).toFixed(0)),
    scanMsPer1000CandidatesPerQuery: Number((scan.avgMsPerQuery / Math.max(1, scan.candidates) * 1000).toFixed(4)),
    bytesPerHashRecordApprox: includePhash ? 160 : 120
  },
  recommendation: "Use exact source/url/file_unique_id first, then aHash+dHash+pHash only as a conservative image-candidate gate before LLM visual judgment."
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));

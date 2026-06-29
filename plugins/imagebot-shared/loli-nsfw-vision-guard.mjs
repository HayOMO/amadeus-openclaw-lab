import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const DEFAULT_MODEL_REPO = "SmilingWolf/wd-v1-4-vit-tagger-v2";
const MODEL_FILE = "model.onnx";
const TAGS_FILE = "selected_tags.csv";
const DEFAULT_MODEL_DIR = path.join(homeDir(), ".openclaw", "models", "wd-v1-4-vit-tagger-v2");
const DEFAULT_INPUT_SIZE = 448;
const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_LOLI_THRESHOLD = 0.28;

const LOLI_TAGS = [
  "loli"
];

const TEXT_LOLI_RE = /(?:^|[\s_#:/.-])(?:loli|lolicon)(?:$|[\s_#:/.-])|(?:\u30ed\u30ea|\u308d\u308a|\u841d\u8389|\u863f\u8389)/iu;

let runtimePromise;

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTag(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function readNumber(config, key, fallback, min, max) {
  const value = Number(isRecord(config) ? config[key] : undefined);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function resolveModelDir(config = {}) {
  return path.resolve(String(config.modelDir || "").trim() || DEFAULT_MODEL_DIR);
}

function modelFile(config = {}) {
  return path.join(resolveModelDir(config), MODEL_FILE);
}

function tagsFile(config = {}) {
  return path.join(resolveModelDir(config), TAGS_FILE);
}

function moduleCandidateBases(config = {}) {
  const bases = [];
  const add = (value) => {
    const text = String(value || "").trim();
    if (text) bases.push(path.resolve(text));
  };
  if (Array.isArray(config.dependencyDirs)) config.dependencyDirs.forEach(add);
  add(config.dependencyDir);
  add(path.join(process.cwd(), "plugins", "imagebot-practical-tools"));
  add(path.join(process.cwd(), "plugins", "web-image-search"));
  add(path.join(process.cwd(), "plugins", "imagebot-memory-search"));
  add(path.join(process.cwd(), "plugins", "imagebot-knowledge-library"));
  return [...new Set(bases)];
}

function requireFromCandidates(moduleName, config = {}) {
  const errors = [];
  for (const base of moduleCandidateBases(config)) {
    try {
      return createRequire(path.join(base, "index.js"))(moduleName);
    } catch (error) {
      errors.push(`${base}: ${error?.message || error}`);
    }
  }
  throw new Error(`Unable to load ${moduleName}; tried ${errors.join(" | ")}`);
}

async function getSharp(config = {}) {
  const mod = requireFromCandidates("sharp", config);
  return mod?.default || mod;
}

async function getOnnxRuntime(config = {}) {
  return requireFromCandidates("onnxruntime-node", config);
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

async function loadTags(config = {}) {
  const text = await fs.readFile(tagsFile(config), "utf8");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines.shift() || "");
  const nameIndex = header.indexOf("name");
  if (nameIndex < 0) throw new Error("selected_tags.csv missing name column");
  const tags = [];
  const byName = new Map();
  for (const line of lines) {
    const cells = parseCsvLine(line);
    const name = cells[nameIndex] || "";
    const normalized = normalizeTag(name);
    const entry = { name, normalized };
    const index = tags.length;
    tags.push(entry);
    if (normalized) byName.set(normalized, index);
  }
  return { tags, byName };
}

async function ensureModelFiles(config = {}) {
  const dir = resolveModelDir(config);
  await fs.mkdir(dir, { recursive: true });
  const repo = String(config.modelRepo || DEFAULT_MODEL_REPO).trim();
  for (const file of [MODEL_FILE, TAGS_FILE]) {
    const target = path.join(dir, file);
    const existing = await fs.stat(target).catch(() => null);
    if (existing?.isFile() && existing.size > 1024) continue;
    const url = `https://huggingface.co/${repo}/resolve/main/${file}`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    const chunks = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    await fs.writeFile(tmp, Buffer.concat(chunks));
    await fs.rename(tmp, target);
  }
  return { modelPath: modelFile(config), tagsPath: tagsFile(config) };
}

async function loadRuntime(config = {}) {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    if (!fsSync.existsSync(modelFile(config)) || !fsSync.existsSync(tagsFile(config))) {
      if (config.autoDownload === true) await ensureModelFiles(config);
      else throw new Error(`loli guard model missing: ${resolveModelDir(config)}`);
    }
    const [ort, sharp, labels] = await Promise.all([
      getOnnxRuntime(config),
      getSharp(config),
      loadTags(config)
    ]);
    const session = await ort.InferenceSession.create(modelFile(config), {
      executionProviders: ["cpu"]
    });
    return { ort, sharp, labels, session };
  })();
  return runtimePromise;
}

async function preprocessImage(filePath, runtime, config = {}) {
  const size = readNumber(config, "inputSize", DEFAULT_INPUT_SIZE, 224, 1024);
  const { data } = await runtime.sharp(filePath, { animated: false, limitInputPixels: false })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(size, size, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255 },
      kernel: "cubic"
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const floats = new Float32Array(size * size * 3);
  for (let index = 0; index < size * size; index += 1) {
    const src = index * 3;
    // WD tagger reference preprocessing converts RGB to BGR.
    floats[src] = data[src + 2];
    floats[src + 1] = data[src + 1];
    floats[src + 2] = data[src];
  }
  return new runtime.ort.Tensor("float32", floats, [1, size, size, 3]);
}

function scoreByName(predictions, labels, name) {
  const index = labels.byName.get(normalizeTag(name));
  if (index == null) return 0;
  const value = Number(predictions[index] || 0);
  return Number.isFinite(value) ? value : 0;
}

function pickScores(predictions, labels, names) {
  const entries = names.map((name) => [normalizeTag(name), scoreByName(predictions, labels, name)]);
  entries.sort((left, right) => right[1] - left[1]);
  return entries;
}

function textSignals(input = {}) {
  const text = [
    input.text,
    input.caption,
    input.sourceUrl,
    input.filename,
    ...(Array.isArray(input.tags) ? input.tags : [])
  ].filter(Boolean).join(" ");
  const padded = ` ${text} `;
  return {
    text,
    loli: TEXT_LOLI_RE.test(padded)
  };
}

function riskConfig(config = {}) {
  return {
    loliThreshold: readNumber(config, "loliThreshold", DEFAULT_LOLI_THRESHOLD, 0.01, 1)
  };
}

function shortHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

export function evaluateLoliNsfwRisk(input = {}, config = {}) {
  const signals = textSignals(input);
  const cfg = riskConfig(config);
  const predictions = input.predictions || {};
  const loliScores = Array.isArray(predictions.loliScores) ? predictions.loliScores : [];
  const loliScore = Math.max(0, ...loliScores.map((entry) => Number(entry?.[1] || 0)));
  const modelLoli = loliScore >= cfg.loliThreshold;
  const textBlock = signals.loli;
  const modelBlock = modelLoli;
  const blocked = textBlock || modelBlock;
  return {
    blocked,
    action: blocked ? "withhold_vision" : "allow",
    reason: textBlock ? "metadata_loli" : modelBlock ? "model_loli" : "clear",
    scores: {
      loli: Number(loliScore.toFixed(4))
    },
    signals: {
      metadataLoli: signals.loli
    }
  };
}

export async function screenImage(filePath, input = {}, config = {}) {
  const runtime = await loadRuntime(config);
  const tensor = await preprocessImage(filePath, runtime, config);
  const outputs = await runtime.session.run({ [runtime.session.inputNames[0]]: tensor });
  const raw = outputs[runtime.session.outputNames[0]];
  const predictions = raw?.data || [];
  const labels = runtime.labels;
  const loliScores = pickScores(predictions, labels, LOLI_TAGS);
  const risk = evaluateLoliNsfwRisk({
    ...input,
    filename: input.filename || path.basename(filePath),
    predictions: { loliScores }
  }, config);
  return {
    ...risk,
    pathHash: shortHash(path.resolve(filePath).toLowerCase()),
    model: {
      repo: String(config.modelRepo || DEFAULT_MODEL_REPO),
      topLoli: loliScores.slice(0, 4).map(([name, score]) => [name, Number(score.toFixed(4))])
    }
  };
}

export async function screenMediaBatch({ media = [], text = "", config = {} } = {}) {
  const maxImages = Math.trunc(readNumber(config, "maxImages", DEFAULT_MAX_IMAGES, 1, 20));
  const blocked = [];
  const allowed = [];
  const errors = [];
  let checked = 0;
  for (const item of Array.isArray(media) ? media : []) {
    const contentType = String(item?.contentType || "").toLowerCase();
    const filePath = String(item?.path || "").trim();
    if (!filePath || !contentType.startsWith("image/") || checked >= maxImages) {
      allowed.push(item);
      continue;
    }
    checked += 1;
    try {
      const result = await screenImage(filePath, {
        text,
        filename: path.basename(filePath)
      }, config);
      if (result.blocked) blocked.push({ media: item, result });
      else allowed.push(item);
    } catch (error) {
      errors.push({ pathHash: shortHash(filePath), error: String(error?.message || error) });
      allowed.push(item);
    }
  }
  return {
    blocked,
    allowed,
    checked,
    errors,
    blockedCount: blocked.length,
    status: blocked.length ? "blocked" : errors.length ? "partial" : "ok"
  };
}

export function buildSafetyReviewPrompt(result = {}) {
  const count = Number(result.blockedCount || result.blocked?.length || 0);
  if (count <= 0) return "";
  return [
    "[Safety review]",
    `Local preflight withheld ${count} image attachment(s) from visual context because the local loli guard flagged loli risk.`,
    "The withheld image bytes were not sent to the vision model. Do not infer or describe hidden image details. If relevant, say the image was not inspected for safety reasons and continue from the visible text."
  ].join("\n");
}

export { ensureModelFiles };

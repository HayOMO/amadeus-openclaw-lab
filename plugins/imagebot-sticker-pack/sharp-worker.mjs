import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const STICKER_SIZE = 512;
const STATIC_STICKER_BYTES = 512 * 1024;
const CONTACT_SHEET_TILE = 176;
const CONTACT_SHEET_PADDING = 16;

function readString(params, key, fallback = "") {
  const value = params && typeof params === "object" ? params[key] : undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function readBoolean(params, key, fallback = false) {
  const value = params && typeof params === "object" ? params[key] : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(1|true|yes|on)$/i.test(value.trim());
  return fallback;
}

function readNumber(params, key, fallback, min, max) {
  const raw = params && typeof params === "object" ? params[key] : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeFraming(value, fallback = "smart") {
  const requested = String(value || fallback).trim().toLowerCase();
  if (["smart", "contain", "cover"].includes(requested)) return requested;
  return fallback;
}

function transparentBackground() {
  return { r: 255, g: 255, b: 255, alpha: 0 };
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decisionStyle(item = {}) {
  if (item.status === "failed") return { label: "FAILED", border: "#71717a", fill: "#f4f4f5" };
  const decision = String(item.decision || "pending").toLowerCase();
  if (decision === "keep") return { label: "KEEP", border: "#16a34a", fill: "#f0fdf4" };
  if (decision === "reject") return { label: "REJECT", border: "#dc2626", fill: "#fef2f2" };
  return { label: "PENDING", border: "#d97706", fill: "#fffbeb" };
}

async function normalizeStickerAlphaEdges(image) {
  const normalized = await image.png().toBuffer();
  const raw = await sharp(normalized)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const data = Buffer.from(raw.data);
  let changed = false;
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3];
    if (alpha === 0) {
      if (data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255) {
        data[offset] = 255;
        data[offset + 1] = 255;
        data[offset + 2] = 255;
        changed = true;
      }
      continue;
    }
    if (alpha < 255) {
      const r = Math.min(255, Math.round((data[offset] * 255) / alpha));
      const g = Math.min(255, Math.round((data[offset + 1] * 255) / alpha));
      const b = Math.min(255, Math.round((data[offset + 2] * 255) / alpha));
      if (r !== data[offset] || g !== data[offset + 1] || b !== data[offset + 2]) {
        data[offset] = r;
        data[offset + 1] = g;
        data[offset + 2] = b;
        changed = true;
      }
    }
  }
  if (!changed) return normalized;
  return await sharp(data, {
    raw: {
      width: raw.info.width,
      height: raw.info.height,
      channels: 4
    }
  })
    .png()
    .toBuffer();
}

async function renderStickerBuffer(inputPath, params = {}) {
  const framing = normalizeFraming(readString(params, "framing"), readString(params, "defaultFraming", "contain"));
  const padding = readNumber(params, "padding", framing === "cover" ? 0 : 18, 0, 96);
  const target = Math.max(1, STICKER_SIZE - padding * 2);
  const trim = readBoolean(params, "trim", framing === "smart");
  const trimThreshold = readNumber(params, "trimThreshold", 12, 0, 80);
  let image = sharp(inputPath, { animated: false, limitInputPixels: 72_000_000 }).rotate().ensureAlpha();
  if (trim) image = image.trim({ threshold: trimThreshold });
  const normalized = await normalizeStickerAlphaEdges(image);
  const resized = await sharp(normalized)
    .resize(target, target, {
      fit: framing === "cover" ? "cover" : "inside",
      position: "attention",
      withoutEnlargement: false,
      background: transparentBackground()
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((STICKER_SIZE - resized.info.width) / 2);
  const top = Math.floor((STICKER_SIZE - resized.info.height) / 2);
  return {
    buffer: await sharp({
      create: {
        width: STICKER_SIZE,
        height: STICKER_SIZE,
        channels: 4,
        background: transparentBackground()
      }
    })
      .composite([{ input: resized.data, left, top }])
      .png()
      .toBuffer(),
    framing,
    padding,
    trimmed: trim
  };
}

async function writeStaticSticker(payload = {}) {
  const { inputPath, outputPath, params = {} } = payload;
  if (!inputPath || !outputPath) throw new Error("inputPath and outputPath are required");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const requestedQuality = readNumber(params, "quality", 92, 50, 98);
  const attempts = [requestedQuality, 88, 84, 80, 76, 72, 68, 64, 60, 56, 52, 50]
    .filter((value, index, list) => list.indexOf(value) === index)
    .sort((left, right) => right - left);
  const base = await renderStickerBuffer(inputPath, params);
  let lastStat = null;
  for (const quality of attempts) {
    await sharp(base.buffer)
      .webp({ quality, effort: 5, alphaQuality: Math.min(100, quality + 4) })
      .toFile(outputPath);
    const stat = await fs.stat(outputPath);
    lastStat = stat;
    if (stat.size <= STATIC_STICKER_BYTES) {
      return { ...base, quality, sizeBytes: stat.size };
    }
  }
  throw new Error(`prepared sticker is larger than ${Math.floor(STATIC_STICKER_BYTES / 1024)} KB (${Math.ceil((lastStat?.size || 0) / 1024)} KB)`);
}

async function buildContactSheet(payload = {}) {
  const { outputPath, width, height } = payload;
  const items = Array.isArray(payload.items) ? payload.items : [];
  const columns = Math.min(4, Math.max(1, items.length));
  const composites = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    const col = index % columns;
    const row = Math.floor(index / columns);
    const left = CONTACT_SHEET_PADDING + col * CONTACT_SHEET_TILE;
    const top = CONTACT_SHEET_PADDING + row * CONTACT_SHEET_TILE;
    const sticker = await sharp(item.outputPath)
      .resize(128, 128, { fit: "contain", background: transparentBackground() })
      .png()
      .toBuffer();
    const label = Buffer.from(`<svg width="${CONTACT_SHEET_TILE}" height="${CONTACT_SHEET_TILE}" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="4" width="${CONTACT_SHEET_TILE - 8}" height="${CONTACT_SHEET_TILE - 8}" rx="10" fill="#ffffff" stroke="#d4d4d8"/>
  <text x="14" y="24" font-family="Arial, sans-serif" font-size="18" fill="#18181b">${Number(item.index || 0) + 1}</text>
</svg>`);
    composites.push({ input: label, left, top });
    composites.push({ input: sticker, left: left + 24, top: top + 34 });
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 244, g: 244, b: 245, alpha: 1 }
    }
  })
    .composite(composites)
    .png()
    .toFile(outputPath);
  const stat = await fs.stat(outputPath);
  return { outputPath, sizeBytes: stat.size, width, height };
}

async function buildReviewSheet(payload = {}) {
  const { outputPath, width, height } = payload;
  const items = Array.isArray(payload.items) ? payload.items : [];
  const columns = Math.min(4, Math.max(1, items.length));
  const composites = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    const col = index % columns;
    const row = Math.floor(index / columns);
    const left = CONTACT_SHEET_PADDING + col * CONTACT_SHEET_TILE;
    const top = CONTACT_SHEET_PADDING + row * CONTACT_SHEET_TILE;
    const style = decisionStyle(item);
    const emojiState = item.emojiCount > 0 ? `emoji:${item.emojiCount}` : "emoji:missing";
    const displayIndex = Number.isInteger(item.index) ? item.index + 1 : index + 1;
    const label = Buffer.from(`<svg width="${CONTACT_SHEET_TILE}" height="${CONTACT_SHEET_TILE}" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="4" width="${CONTACT_SHEET_TILE - 8}" height="${CONTACT_SHEET_TILE - 8}" rx="10" fill="${style.fill}" stroke="${style.border}" stroke-width="4"/>
  <text x="14" y="25" font-family="Arial, sans-serif" font-size="17" font-weight="700" fill="#18181b">${displayIndex} ${escapeXml(style.label)}</text>
  <text x="14" y="${CONTACT_SHEET_TILE - 16}" font-family="Arial, sans-serif" font-size="13" fill="#3f3f46">${escapeXml(emojiState)}</text>
</svg>`);
    composites.push({ input: label, left, top });
    if (item.outputPath) {
      try {
        const sticker = await sharp(item.outputPath)
          .resize(128, 128, { fit: "contain", background: transparentBackground() })
          .png()
          .toBuffer();
        composites.push({ input: sticker, left: left + 24, top: top + 34 });
      } catch {
        // Keep the decision label even if the preview file is missing.
      }
    }
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 244, g: 244, b: 245, alpha: 1 }
    }
  })
    .composite(composites)
    .png()
    .toFile(outputPath);
  const stat = await fs.stat(outputPath);
  return { outputPath, sizeBytes: stat.size, width, height };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const request = JSON.parse(await readStdin());
  const action = request.action;
  const payload = request.payload || {};
  let result;
  if (action === "writeStaticSticker") result = await writeStaticSticker(payload);
  else if (action === "contactSheet") result = await buildContactSheet(payload);
  else if (action === "reviewSheet") result = await buildReviewSheet(payload);
  else throw new Error(`unknown sharp worker action: ${action}`);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : ""
  }));
  process.exitCode = 1;
}

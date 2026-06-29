import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const MEDIA_URI_BUCKETS = new Set([
  "downloaded",
  "gallery-resend",
  "gacha-archive",
  "inbound",
  "meme-tools",
  "practical-tools",
  "public-video",
  "sticker-pack",
  "tool-image-generation"
]);

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function openclawMediaRoot(config = {}) {
  const configured = String(config.openclawMediaRoot || config.mediaRoot || config.openclawMediaDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "media"));
}

export function stripMediaUriDecorations(value) {
  let text = String(value || "").trim().replace(/^`+|`+$/g, "");
  if (!text) return "";
  const mediaMatch = text.match(/(?:SPOILER_)?MEDIA:(?!\/\/)\s*`?([^`\r\n]+)`?/i);
  if (mediaMatch) text = mediaMatch[1].trim();
  text = text
    .replace(/\s+\|\s+.+$/, "")
    .replace(/\s+\((?:image|video|audio|application)\/[^)\r\n]+\)\s*$/i, "")
    .replace(/^`+|`+$/g, "")
    .trim();
  return text;
}

function isInside(root, target) {
  const rootNorm = path.resolve(root).toLowerCase();
  const targetNorm = path.resolve(target).toLowerCase();
  return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + path.sep);
}

export function mediaUriToLocalPath(value, config = {}) {
  const raw = stripMediaUriDecorations(value);
  if (!/^media:\/\//i.test(raw)) return "";
  const match = raw.match(/^media:\/\/([^/?#\s]+)\/([^?#]+)(?:[?#].*)?$/i);
  if (!match) return "";
  const bucket = decodeURIComponent(match[1] || "").trim().toLowerCase();
  if (!MEDIA_URI_BUCKETS.has(bucket)) return "";
  const rel = decodeURIComponent(match[2] || "").replace(/^\/+/, "");
  if (!rel || rel.includes("\0")) return "";
  const root = path.join(openclawMediaRoot(config), bucket);
  const file = path.resolve(root, rel.replace(/\//g, path.sep));
  return isInside(root, file) ? file : "";
}

export async function resolveExistingMediaUriToLocalPath(value, config = {}) {
  const local = mediaUriToLocalPath(value, config);
  if (!local) return "";
  try {
    const stat = await fs.stat(local);
    return stat.isFile() ? local : "";
  } catch {
    return "";
  }
}

export async function resolveMediaReferencePath(value, config = {}) {
  const raw = stripMediaUriDecorations(value);
  if (!raw) return "";
  const local = await resolveExistingMediaUriToLocalPath(raw, config);
  if (local) return local;
  if (isRecord(config) && config.resolveMissingMediaUri === true) return mediaUriToLocalPath(raw, config) || raw;
  return raw;
}

export async function resolveMediaReferencePaths(values = [], config = {}) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const resolved = await resolveMediaReferencePath(value, config);
    if (resolved) out.push(resolved);
  }
  return out;
}

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { backgroundToolParameters, enqueueBackgroundTool, shouldRunInBackground } from "../imagebot-background-jobs/index.js";

const TOOL_NAME = "meme_transform";
const MAX_MEDIA_BYTES = 60 * 1024 * 1024;
const PYTHON_TIMEOUT_MS = 45_000;
const IMAGE_TOOL_MAX_CALLS_PER_TURN = 3;
const TOOL_LIMIT_TTL_MS = 10 * 60 * 1000;
const INPUT_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const OUTPUT_MIME = new Map([
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"]
]);
const toolTurnCounters = new Map();

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(params, key, fallback = "") {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function readBoolean(params, key, fallback = false) {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(1|true|yes|on)$/i.test(value.trim());
  return fallback;
}

function readNumber(params, key, fallback, min, max) {
  const raw = isRecord(params) ? params[key] : undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clip(value, max = 600) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function toolTurnKey(toolName, ctx = {}) {
  const runId = String(ctx?.runId || "").trim();
  if (runId) return `${toolName}:run:${runId}`;
  const sessionKey = String(ctx?.sessionKey || ctx?.chatId || ctx?.agentId || "").trim();
  if (!sessionKey) return "";
  const bucket = Math.floor(Date.now() / TOOL_LIMIT_TTL_MS);
  return `${toolName}:session:${sessionKey}:bucket:${bucket}`;
}

function claimToolTurnCall(toolName, ctx, limit = IMAGE_TOOL_MAX_CALLS_PER_TURN) {
  const now = Date.now();
  for (const [key, entry] of toolTurnCounters) {
    if (entry.expiresAt <= now) toolTurnCounters.delete(key);
  }
  const key = toolTurnKey(toolName, ctx);
  if (!key) return { ok: true, count: 1, limit, untracked: true };
  const current = toolTurnCounters.get(key) || { count: 0, expiresAt: now + TOOL_LIMIT_TTL_MS };
  if (current.count >= limit) {
    return {
      ok: false,
      count: current.count,
      limit,
      text: `${toolName.toUpperCase()} limit: already used ${current.count}/${limit} times in this turn. Stop refactoring automatically and ask the user for a clearer next instruction if more changes are needed.`
    };
  }
  current.count += 1;
  current.expiresAt = now + TOOL_LIMIT_TTL_MS;
  toolTurnCounters.set(key, current);
  return { ok: true, count: current.count, limit };
}

function sha(value, len = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, len);
}

function safeBaseName(value, fallback = "meme") {
  const raw = String(value || fallback).trim().replace(/\.[a-z0-9]{1,8}$/i, "");
  const cleaned = raw
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

function mediaRoot(config = {}) {
  const configured = String(config.mediaDir || "").trim();
  return path.resolve(configured || path.join(homeDir(), ".openclaw", "media", "meme-tools"));
}

function allowedMediaRoots(config = {}) {
  const home = homeDir();
  const defaults = [
    path.join(home, ".openclaw", "media", "inbound"),
    path.join(home, ".openclaw", "media", "tool-image-generation"),
    path.join(home, ".openclaw", "media", "downloaded"),
    path.join(home, ".openclaw", "media", "gallery-resend"),
    path.join(home, ".openclaw", "media", "gacha-archive"),
    path.join(home, ".openclaw", "media", "practical-tools"),
    mediaRoot(config)
  ];
  const extra = Array.isArray(config.allowedMediaRoots) ? config.allowedMediaRoots : [];
  return [...defaults, ...extra].map((entry) => path.resolve(String(entry))).filter(Boolean);
}

function isInside(root, target) {
  const rootNorm = path.resolve(root).toLowerCase();
  const targetNorm = path.resolve(target).toLowerCase();
  return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + path.sep);
}

function readMediaPath(raw) {
  const value = String(raw || "").trim().replace(/^`+|`+$/g, "");
  const mediaMatch = value.match(/(?:SPOILER_)?MEDIA:\s*`?([^`\r\n]+)`?/i);
  const unwrapped = mediaMatch ? mediaMatch[1] : value;
  if (/^file:\/\//i.test(unwrapped)) return decodeURIComponent(unwrapped.replace(/^file:\/\//i, ""));
  return unwrapped;
}

async function resolveAllowedInput(config, raw) {
  const input = readMediaPath(raw);
  if (!input) throw new Error("input image path is required");
  if (/^https?:\/\//i.test(input)) throw new Error("meme_transform only accepts Telegram/bot-local media paths, not URLs");
  const resolved = path.resolve(input);
  if (!allowedMediaRoots(config).some((root) => isInside(root, resolved))) {
    throw new Error("input path is outside allowed bot media directories");
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("input path is not a file");
  if (stat.size > MAX_MEDIA_BYTES) throw new Error("input media is larger than 60 MB");
  const ext = path.extname(resolved).toLowerCase();
  if (!INPUT_EXTS.has(ext)) throw new Error(`unsupported input image type: ${ext || "unknown"}`);
  return { path: resolved, stat, ext };
}

function normalizeAction(value) {
  const action = String(value || "caption").trim().toLowerCase();
  if (["caption", "sticker", "reaction", "square", "demotivator", "quote"].includes(action)) return action;
  return "caption";
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(command)} timed out`));
    }, options.timeoutMs || PYTHON_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${path.basename(command)} exited with code ${code}`));
    });
  });
}

async function runPython(args) {
  const commands = [];
  if (process.env.PYTHON) commands.push(process.env.PYTHON);
  commands.push("python", "py");
  let lastError;
  for (const command of [...new Set(commands)]) {
    try {
      return await runProcess(command, args, { timeoutMs: PYTHON_TIMEOUT_MS });
    } catch (error) {
      lastError = error;
      if (!/ENOENT|not recognized|not found/i.test(String(error?.message || error))) break;
    }
  }
  throw lastError || new Error("python is unavailable");
}

const PY_MEME_SCRIPT = String.raw`
import json, math, sys, textwrap
from PIL import Image, ImageOps, ImageDraw, ImageFont

inp, outp, action, top_text, bottom_text, badge_text, max_edge, quality = sys.argv[1:9]
max_edge = int(max_edge)
quality = int(quality)

img = Image.open(inp)
frames = getattr(img, "n_frames", 1)
img.seek(0)
img = ImageOps.exif_transpose(img).convert("RGBA")

def fit_square(im):
    side = min(im.width, im.height)
    left = (im.width - side) // 2
    top = (im.height - side) // 2
    return im.crop((left, top, left + side, top + side))

def font_for(size):
    candidates = [
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "arial.ttf",
    ]
    for item in candidates:
        try:
            return ImageFont.truetype(item, size=size)
        except Exception:
            pass
    return ImageFont.load_default()

def wrap_text(draw, text, font, max_width):
    text = (text or "").strip()
    if not text:
        return []
    chars = list(text)
    lines, line = [], ""
    for ch in chars:
        trial = line + ch
        try:
            box = draw.textbbox((0, 0), trial, font=font, stroke_width=2)
            width = box[2] - box[0]
        except Exception:
            width = len(trial) * 10
        if width <= max_width or not line:
            line = trial
        else:
            lines.append(line)
            line = ch
    if line:
        lines.append(line)
    return lines[:4]

def draw_centered_lines(draw, lines, y, font, fill=(255,255,255,255), stroke=(0,0,0,255)):
    line_gap = max(4, font.size // 8 if hasattr(font, "size") else 4)
    for line in lines:
        box = draw.textbbox((0, 0), line, font=font, stroke_width=3)
        w, h = box[2] - box[0], box[3] - box[1]
        x = (img.width - w) / 2
        draw.text((x, y), line, font=font, fill=fill, stroke_width=3, stroke_fill=stroke)
        y += h + line_gap

if action in ("sticker", "square"):
    img = fit_square(img)
    img.thumbnail((512, 512), Image.Resampling.LANCZOS)
elif max_edge > 0:
    img.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)

if action == "demotivator":
    border = max(10, img.width // 45)
    margin = max(36, img.width // 12)
    title_font = font_for(max(28, min(72, img.width // 11)))
    sub_font = font_for(max(18, min(38, img.width // 22)))
    tmp = Image.new("RGBA", (10, 10), (0,0,0,0))
    tmp_draw = ImageDraw.Draw(tmp)
    title_lines = wrap_text(tmp_draw, top_text, title_font, int((img.width + margin * 2) * 0.86))
    sub_lines = wrap_text(tmp_draw, bottom_text, sub_font, int((img.width + margin * 2) * 0.86))
    title_h = sum((tmp_draw.textbbox((0,0), line, font=title_font, stroke_width=2)[3] - tmp_draw.textbbox((0,0), line, font=title_font, stroke_width=2)[1]) for line in title_lines)
    sub_h = sum((tmp_draw.textbbox((0,0), line, font=sub_font, stroke_width=1)[3] - tmp_draw.textbbox((0,0), line, font=sub_font, stroke_width=1)[1]) for line in sub_lines)
    canvas_w = img.width + margin * 2
    canvas_h = img.height + margin * 2 + max(60, title_h + sub_h + 54)
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 255))
    x = (canvas_w - img.width) // 2
    y = margin
    frame = Image.new("RGBA", (img.width + border * 2, img.height + border * 2), (245, 245, 245, 255))
    frame.paste(img, (border, border), img)
    canvas.paste(frame, (x - border, y - border))
    img = canvas
    draw = ImageDraw.Draw(img)
    draw_centered_lines(draw, title_lines, y + frame.height + 24, title_font, fill=(245,245,245,255), stroke=(0,0,0,255))
    if sub_lines:
        draw_centered_lines(draw, sub_lines, y + frame.height + 30 + max(34, title_h), sub_font, fill=(210,210,210,255), stroke=(0,0,0,255))

elif action == "quote":
    draw = ImageDraw.Draw(img)
    font = font_for(max(24, min(58, img.width // 12)))
    by_font = font_for(max(16, min(30, img.width // 24)))
    quote = top_text or bottom_text
    byline = bottom_text if top_text else ""
    lines = wrap_text(draw, quote, font, int(img.width * 0.78))
    line_heights = []
    for line in lines:
        box = draw.textbbox((0, 0), line, font=font, stroke_width=1)
        line_heights.append(box[3] - box[1])
    panel_h = max(int(img.height * 0.34), sum(line_heights) + 86)
    panel_y = img.height - panel_h
    overlay = Image.new("RGBA", img.size, (0,0,0,0))
    odraw = ImageDraw.Draw(overlay)
    odraw.rectangle((0, panel_y, img.width, img.height), fill=(0, 0, 0, 172))
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)
    draw_centered_lines(draw, lines, panel_y + 26, font, fill=(255,255,255,255), stroke=(0,0,0,255))
    if byline:
        by = "— " + byline.strip()[:42]
        box = draw.textbbox((0, 0), by, font=by_font, stroke_width=1)
        by_size = getattr(by_font, "size", 20)
        draw.text(((img.width - (box[2]-box[0])) / 2, img.height - max(34, by_size + 14)), by, font=by_font, fill=(230,230,230,240), stroke_width=1, stroke_fill=(0,0,0,255))

elif action in ("caption", "reaction"):
    draw = ImageDraw.Draw(img)
    font_size = max(24, min(72, img.width // 10))
    font = font_for(font_size)
    top_lines = wrap_text(draw, top_text, font, int(img.width * 0.9))
    bottom_lines = wrap_text(draw, bottom_text, font, int(img.width * 0.9))
    if top_lines:
        draw_centered_lines(draw, top_lines, max(8, img.height * 0.04), font)
    if bottom_lines:
        heights = []
        for line in bottom_lines:
            box = draw.textbbox((0, 0), line, font=font, stroke_width=3)
            heights.append(box[3] - box[1])
        y = img.height - sum(heights) - max(8, len(bottom_lines) * 6) - max(10, int(img.height * 0.04))
        draw_centered_lines(draw, bottom_lines, max(8, y), font)
    if badge_text.strip():
        badge_font = font_for(max(18, img.width // 18))
        label = badge_text.strip()[:24]
        box = draw.textbbox((0, 0), label, font=badge_font)
        pad_x, pad_y = 12, 7
        bw, bh = box[2] - box[0] + pad_x * 2, box[3] - box[1] + pad_y * 2
        x, y = img.width - bw - 10, 10
        draw.rounded_rectangle((x, y, x + bw, y + bh), radius=10, fill=(0, 0, 0, 170))
        draw.text((x + pad_x, y + pad_y), label, font=badge_font, fill=(255, 255, 255, 245))

fmt = "WEBP" if action == "sticker" else "PNG"
save_kwargs = {"format": fmt}
if fmt == "WEBP":
    save_kwargs.update({"quality": max(70, min(95, quality)), "method": 6})
else:
    save_kwargs.update({"optimize": True})
img.save(outp, **save_kwargs)
print(json.dumps({"width": img.width, "height": img.height, "frames": frames, "format": fmt.lower()}, ensure_ascii=False))
`;

async function runMemeTransform(config, params = {}) {
  const input = await resolveAllowedInput(config, readString(params, "input") || readString(params, "image"));
  const action = normalizeAction(readString(params, "action", "caption"));
  const topText = clip(readString(params, "topText") || readString(params, "text"), 120);
  const bottomText = clip(readString(params, "bottomText"), 120);
  const badgeText = clip(readString(params, "badgeText"), 40);
  const maxEdge = readNumber(params, "maxEdge", action === "sticker" ? 512 : 1280, 256, 2048);
  const quality = readNumber(params, "quality", 90, 60, 98);
  const ext = action === "sticker" ? "webp" : "png";
  const outputDir = path.join(mediaRoot(config), "meme-transform");
  await fs.mkdir(outputDir, { recursive: true });
  const filename = safeBaseName(readString(params, "filename"), `${action}-${path.basename(input.path, input.ext)}`);
  const outputPath = path.join(outputDir, `${Date.now()}-${sha(input.path + topText + bottomText, 8)}-${filename}.${ext}`);
  const { stdout } = await runPython(["-c", PY_MEME_SCRIPT, input.path, outputPath, action, topText, bottomText, badgeText, String(maxEdge), String(quality)]);
  const parsed = JSON.parse(stdout.trim() || "{}");
  const stat = await fs.stat(outputPath);
  return {
    status: "ok",
    action,
    input: path.basename(input.path),
    outputPath,
    sizeBytes: stat.size,
    width: parsed.width,
    height: parsed.height,
    frames: parsed.frames,
    mimeType: OUTPUT_MIME.get(ext) || "application/octet-stream"
  };
}

function formatResult(result) {
  return [
    `MEME_TRANSFORM ok action=${result.action}`,
    `Input: ${result.input}`,
    `Output: ${path.basename(result.outputPath)} (${result.width}x${result.height}, ${(result.sizeBytes / 1024).toFixed(1)} KB)`,
    `MEDIA: \`${result.outputPath}\``
  ].join("\n");
}

const memeTransformTool = {
  name: TOOL_NAME,
  label: "Meme Transform",
  description: "Create a captioned meme, reaction image, demotivator, quote card, square crop, or Telegram sticker-style WebP from bot-local image media.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      input: { type: "string", description: "Bot-local image path or MEDIA line from current/replied media." },
      image: { type: "string", description: "Alias for input." },
      action: { type: "string", enum: ["caption", "sticker", "reaction", "square", "demotivator", "quote"], description: "Transform kind." },
      text: { type: "string", description: "Main caption text, used as top text when topText is omitted." },
      topText: { type: "string", description: "Top caption text." },
      bottomText: { type: "string", description: "Bottom caption text." },
      badgeText: { type: "string", description: "Small corner label for reaction images." },
      maxEdge: { type: "number", description: "Output max edge, 256-2048. Sticker is always 512 max." },
      quality: { type: "number", description: "Output quality 60-98 for WebP." },
      filename: { type: "string", description: "Optional output filename hint." },
      ...backgroundToolParameters()
    },
    required: ["input"]
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    try {
      const config = memeTransformTool.config || {};
      const claimed = claimToolTurnCall(TOOL_NAME, ctx);
      if (!claimed.ok) {
        return {
          content: [{ type: "text", text: claimed.text }],
          details: { status: "limited", tool: TOOL_NAME, count: claimed.count, limit: claimed.limit }
        };
      }
      if (shouldRunInBackground(params)) {
        return await enqueueBackgroundTool({
          toolName: TOOL_NAME,
          config,
          params,
          ctx,
          kind: `${TOOL_NAME}.run`,
          label: `meme_transform ${readString(params, "action", "caption")}`,
          payload: params,
          timeoutMs: PYTHON_TIMEOUT_MS + 15_000,
          handler: async ({ payload, progress }) => {
            await progress({ percent: 10, note: "rendering meme/sticker" });
            const result = await runMemeTransform(config, payload);
            await progress({ percent: 95, note: "media ready" });
            return {
              status: "ok",
              resultText: formatResult(result),
              mediaPath: result.outputPath,
              ...result
            };
          }
        });
      }
      const result = await runMemeTransform(config, params);
      const data = await fs.readFile(result.outputPath);
      return {
        content: [
          { type: "text", text: formatResult(result) },
          { type: "image", data: data.toString("base64"), mimeType: result.mimeType, fileName: path.basename(result.outputPath) }
        ],
        details: result
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `MEME_TRANSFORM error: ${message}` }], details: { status: "failed", error: message } };
    }
  }
};

export const __testing = {
  resolveAllowedInput,
  runMemeTransform,
  allowedMediaRoots,
  mediaRoot
};

export default {
  id: "imagebot-meme-tools",
  name: "Imagebot Meme Tools",
  description: "Telegram-friendly meme and sticker transforms for bot-local media.",
  register(api) {
    memeTransformTool.config = api.config || {};
    api.registerTool(memeTransformTool, { name: TOOL_NAME });
  }
};

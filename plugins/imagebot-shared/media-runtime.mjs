import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { openclawStatePath } from "./openclaw-paths.mjs";

const COMMANDS = {
  ffmpeg: {
    env: "IMAGEBOT_FFMPEG_PATH",
    manifestKey: "ffmpegPath",
    packageName: "@ffmpeg-installer/ffmpeg"
  },
  ffprobe: {
    env: "IMAGEBOT_FFPROBE_PATH",
    manifestKey: "ffprobePath",
    packageName: "@ffprobe-installer/ffprobe"
  }
};

function existingFile(candidate) {
  const value = String(candidate || "").trim();
  if (!value) return "";
  const resolved = path.resolve(value);
  try {
    return fs.statSync(resolved).isFile() ? resolved : "";
  } catch {
    return "";
  }
}

function readRuntimeManifest() {
  const manifestPath = openclawStatePath("runtime", "ffmpeg", "current.json");
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function findOnPath(command) {
  const names = process.platform === "win32" ? [`${command}.exe`, command] : [command];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    const root = String(dir || "").replace(/^"|"$/g, "").trim();
    if (!root) continue;
    for (const name of names) {
      const found = existingFile(path.join(root, name));
      if (found) return found;
    }
  }
  return "";
}

function packageFallback(command, callerUrl) {
  const spec = COMMANDS[command];
  try {
    const require = createRequire(callerUrl || import.meta.url);
    const mod = require(spec.packageName);
    return existingFile(mod?.path ?? mod?.default?.path ?? mod?.default);
  } catch {
    return "";
  }
}

export function resolveMediaCommand(command, callerUrl) {
  const spec = COMMANDS[command];
  if (!spec) throw new Error(`unknown media command: ${command}`);

  const configured = existingFile(process.env[spec.env]);
  if (configured) return configured;

  const manifest = readRuntimeManifest();
  const managed = existingFile(manifest?.[spec.manifestKey]);
  if (managed) return managed;

  const system = findOnPath(command);
  if (system) return system;

  const fallback = packageFallback(command, callerUrl);
  if (fallback) return fallback;

  throw new Error(
    `${command} was not found. Run npm run setup:media or set ${spec.env}.`
  );
}

export function resolveFfmpeg(callerUrl) {
  return resolveMediaCommand("ffmpeg", callerUrl);
}

export function resolveFfprobe(callerUrl) {
  return resolveMediaCommand("ffprobe", callerUrl);
}

export const __testing = {
  findOnPath,
  readRuntimeManifest
};

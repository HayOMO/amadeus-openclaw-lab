import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultOpenClawPackageDir() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "Microsoft",
    "WinGet",
    "Packages",
    "OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe",
    "node-v24.15.0-win-x64",
    "node_modules",
    "openclaw",
  );
}

export function resolveOpenClawPackageDir() {
  const configured = String(process.env.OPENCLAW_RUNTIME_ROOT || "").trim();
  return path.resolve(configured || defaultOpenClawPackageDir());
}

export function resolveOpenClawDistDir() {
  return path.join(resolveOpenClawPackageDir(), "dist");
}

export function resolveOpenClawMain() {
  const configured = String(process.env.OPENCLAW_RUNTIME_MAIN || "").trim();
  return path.resolve(configured || path.join(resolveOpenClawPackageDir(), "openclaw.mjs"));
}

export function assertOpenClawRuntimeFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`OpenClaw runtime file not found: ${filePath}. Set OPENCLAW_RUNTIME_ROOT or run npm run prepare:runtime:ci.`);
  }
  return filePath;
}

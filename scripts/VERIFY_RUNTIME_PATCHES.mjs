import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function defaultRuntimeRoot() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(
    localAppData,
    "Microsoft",
    "WinGet",
    "Packages",
    "OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe",
    "node-v24.15.0-win-x64",
    "node_modules",
    "openclaw",
  );
}

function runGitApply(runtimeRoot, patchPath, reverse, options = {}) {
  const args = [
    "-C",
    runtimeRoot,
    "apply",
    ...(reverse ? ["--reverse"] : []),
    "--check",
    "--unsafe-paths",
    "--whitespace=nowarn",
    patchPath,
  ];
  if (options.disableAutocrlf !== false) {
    args.unshift("-c", "core.autocrlf=false");
  }
  const result = spawnSync("git", args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

function runGitApplyCompatible(runtimeRoot, patchPath, reverse) {
  const strict = runGitApply(runtimeRoot, patchPath, reverse, { disableAutocrlf: true });
  if (strict.ok) return strict;

  const native = runGitApply(runtimeRoot, patchPath, reverse, { disableAutocrlf: false });
  if (native.ok) return native;

  return strict;
}

const manifestPath = path.resolve(
  readOption("--manifest") || path.join(repoRoot, "patches", "openclaw-2026.6.10-runtime", "manifest.json"),
);
const runtimeRoot = path.resolve(readOption("--runtime-root") || process.env.OPENCLAW_RUNTIME_ROOT || defaultRuntimeRoot());
const strict = hasFlag("--strict");
const json = hasFlag("--json");

if (!fs.existsSync(manifestPath)) {
  throw new Error(`Manifest not found: ${manifestPath}`);
}
if (!fs.existsSync(runtimeRoot)) {
  throw new Error(`OpenClaw runtime root not found: ${runtimeRoot}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const patchDir = path.dirname(manifestPath);
const results = [];

for (const entry of manifest.patches || []) {
  const patchPath = path.join(patchDir, entry.file);
  const targetPath = path.join(runtimeRoot, entry.target.replaceAll("/", path.sep));
  const result = {
    id: entry.id,
    file: entry.file,
    target: entry.target,
    status: "FAIL",
    detail: "",
  };

  if (!fs.existsSync(patchPath)) {
    result.detail = "patch file is missing";
    results.push(result);
    continue;
  }
  if (!fs.existsSync(targetPath)) {
    result.detail = "target runtime file is missing";
    results.push(result);
    continue;
  }

  const reverseCheck = runGitApplyCompatible(runtimeRoot, patchPath, true);
  if (reverseCheck.ok) {
    result.status = "OK";
    result.detail = "patch is already applied";
    results.push(result);
    continue;
  }

  const applyCheck = runGitApplyCompatible(runtimeRoot, patchPath, false);
  if (applyCheck.ok) {
    result.status = "WARN";
    result.detail = "patch is not applied, but it applies cleanly";
  } else {
    result.status = "FAIL";
    result.detail = (applyCheck.output || reverseCheck.output || "patch check failed").split(/\r?\n/).slice(0, 3).join(" | ");
  }
  results.push(result);
}

const counts = results.reduce(
  (acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  },
  { OK: 0, WARN: 0, FAIL: 0 },
);

if (json) {
  console.log(JSON.stringify({ runtimeRoot, manifestPath, counts, results }, null, 2));
} else {
  console.log(`OpenClaw runtime: ${runtimeRoot}`);
  console.log(`Patch manifest:   ${manifestPath}`);
  for (const item of results) {
    const label = item.status.padEnd(4);
    console.log(`${label} ${item.file} -> ${item.target} (${item.detail})`);
  }
  console.log(`Summary: OK=${counts.OK || 0} WARN=${counts.WARN || 0} FAIL=${counts.FAIL || 0}`);
  if ((counts.WARN || 0) > 0 && !strict) {
    console.log("Run with --strict to make unapplied-but-compatible patches return a non-zero exit code.");
  }
}

if ((counts.FAIL || 0) > 0) process.exit(1);
if (strict && (counts.WARN || 0) > 0) process.exit(2);

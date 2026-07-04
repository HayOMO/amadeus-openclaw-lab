import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const manifestPath = path.join(repoRoot, "patches", "openclaw-2026.6.10-runtime", "manifest.json");

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
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

function run(command, args, options = {}) {
  const useWindowsCmd = process.platform === "win32" && command === "npm";
  const executable = useWindowsCmd ? process.env.ComSpec || "cmd.exe" : command;
  const finalArgs = useWindowsCmd ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(executable, finalArgs, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    shell: false,
    stdio: options.stdio || "pipe",
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}${result.error?.message || ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}: ${output}`);
  }
  return String(result.stdout || "").trim();
}

function assertSafeRuntimeRoot(runtimeRoot, force) {
  const normalized = path.resolve(runtimeRoot).toLowerCase();
  const temp = path.resolve(os.tmpdir()).toLowerCase();
  if (force || normalized.startsWith(temp)) return;
  throw new Error(`Refusing to prepare non-temp runtime root without --force: ${runtimeRoot}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const configuredRuntimeRoot = readOption("--runtime-root") || process.env.OPENCLAW_RUNTIME_ROOT || "";
const runtimeRoot = path.resolve(configuredRuntimeRoot || defaultRuntimeRoot());
const force = hasFlag("--force") || process.env.CI === "true";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-tests-"));

assertSafeRuntimeRoot(runtimeRoot, force);
fs.rmSync(runtimeRoot, { recursive: true, force: true });
fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true });

const tarball = run("npm", ["pack", `openclaw@${manifest.openclawVersion}`, "--silent"], { cwd: scratch });
const tarballName = tarball.split(/\r?\n/).filter(Boolean).at(-1);
if (!tarballName) throw new Error("npm pack did not return a tarball name");
run("tar", ["-xf", tarballName], { cwd: scratch });

const unpacked = path.join(scratch, "package");
if (!fs.existsSync(path.join(unpacked, "dist"))) throw new Error(`OpenClaw dist not found after npm pack: ${unpacked}`);
fs.cpSync(unpacked, runtimeRoot, { recursive: true });
run("npm", ["install", "--omit=dev", "--ignore-scripts", "--silent"], { cwd: runtimeRoot });

const patchDir = path.dirname(manifestPath);
for (const entry of manifest.patches || []) {
  const patchPath = path.join(patchDir, entry.file);
  run("git", ["-c", "core.autocrlf=false", "-C", runtimeRoot, "apply", "--check", "--unsafe-paths", patchPath]);
  run("git", ["-c", "core.autocrlf=false", "-C", runtimeRoot, "apply", "--unsafe-paths", patchPath]);
}

console.log(JSON.stringify({
  ok: true,
  runtimeRoot,
  openclawVersion: manifest.openclawVersion,
  patches: manifest.patches?.length || 0,
}, null, 2));

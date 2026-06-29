import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const pluginsDir = path.join(repoRoot, "plugins");

async function hasFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function hasDependencySection(pkg) {
  return ["dependencies", "optionalDependencies", "peerDependencies"].some((key) => {
    const value = pkg?.[key];
    return value && typeof value === "object" && Object.keys(value).length > 0;
  });
}

function parseAuditJson(stdout) {
  try {
    return JSON.parse(stdout || "{}");
  } catch {
    return null;
  }
}

function vulnerabilityTotal(report) {
  const vulns = report?.metadata?.vulnerabilities;
  return Number(vulns?.total || 0);
}

function vulnerabilitySummary(report) {
  const vulns = report?.metadata?.vulnerabilities || {};
  return `critical=${vulns.critical || 0} high=${vulns.high || 0} moderate=${vulns.moderate || 0} low=${vulns.low || 0} total=${vulns.total || 0}`;
}

const entries = (await fs.readdir(pluginsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const packageDirs = [];
let failed = false;
for (const name of entries) {
  const dir = path.join(pluginsDir, name);
  const packagePath = path.join(dir, "package.json");
  if (!await hasFile(packagePath)) continue;
  const pkg = await readJson(packagePath, null);
  if (!hasDependencySection(pkg)) continue;
  const lockPath = path.join(dir, "package-lock.json");
  if (!await hasFile(lockPath)) {
    failed = true;
    console.log(`${name}: missing package-lock.json; run npm install or npm run setup:plugins before auditing`);
    continue;
  }
  packageDirs.push({ name, dir });
}

for (const { name, dir } of packageDirs) {
  const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    cwd: dir,
    encoding: "utf8",
    shell: false
  });
  const report = parseAuditJson(result.stdout);
  if (!report) {
    failed = true;
    console.log(`${name}: audit-json-parse-failed exit=${result.status ?? "signal"}`);
    if (result.stderr) console.log(result.stderr.trim());
    continue;
  }
  const total = vulnerabilityTotal(report);
  console.log(`${name}: ${vulnerabilitySummary(report)}`);
  if (total > 0) failed = true;
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`plugin dependency audit passed { plugins: ${packageDirs.length} }`);
}

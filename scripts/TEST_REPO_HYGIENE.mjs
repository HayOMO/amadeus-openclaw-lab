import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function gitLines(args) {
  const output = execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function toPosix(filePath) {
  return filePath.replace(/\\/g, "/");
}

function fileExists(relativePath) {
  return fsSync.existsSync(path.resolve(repoRoot, relativePath));
}

function isTracked(relativePath) {
  return trackedPosix.includes(toPosix(relativePath));
}

const tracked = gitLines(["ls-files"]);
const trackedPosix = tracked.map(toPosix);
const deletedTrackedPosix = new Set(gitLines(["ls-files", "--deleted"]).map(toPosix));
const allowedDeletedTracked = [/^patches\/openclaw-2026\.6\.6-runtime\//];
for (const file of deletedTrackedPosix) {
  assert.ok(
    allowedDeletedTracked.some((pattern) => pattern.test(file)),
    `tracked file is missing from the working tree: ${file}`,
  );
}
const existingTrackedPosix = trackedPosix.filter((file) => !deletedTrackedPosix.has(file));

const forbiddenTracked = [
  /^\.runtime\//,
  /^logs\//,
  /^generated\//,
  /^media\//,
  /^downloads\//,
  /^tmp\//,
  /^native\/bin\//,
  /^native\/obj\//,
  /^scripts\/generated\//,
  /^scripts\/.*\.batch\.generated\.json$/,
  /(^|\/)node_modules\//,
  /\.(?:log|pid|token|secret|secrets|key|pem|p12|pfx)$/i,
];

for (const file of existingTrackedPosix) {
  assert.ok(
    !forbiddenTracked.some((pattern) => pattern.test(file)),
    `local/generated file must not be tracked: ${file}`,
  );
}

const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
assert.ok(fileExists("package-lock.json"), "root package-lock.json must be tracked so npm ci has a reproducible root");
assert.ok(isTracked("package-lock.json"), "root package-lock.json must be tracked so npm ci has a reproducible root");
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  for (const match of String(command).matchAll(/(?:^|\s)(?:\.\/)?(scripts\/[^\s"']+|\.\\scripts\\[^\s"']+|scripts\\[^\s"']+)/g)) {
    const raw = match[1].replace(/^\.[\\/]/, "").replace(/\\/g, "/");
    assert.ok(fileExists(raw), `package script ${name} references missing file: ${raw}`);
  }
}

const pluginRoot = path.join(repoRoot, "plugins");
for (const entry of await fs.readdir(pluginRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packagePath = path.join("plugins", entry.name, "package.json");
  if (!fileExists(packagePath)) continue;
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, packagePath), "utf8"));
  const hasDeps = ["dependencies", "optionalDependencies", "peerDependencies"].some((field) => {
    const value = pkg?.[field];
    return value && typeof value === "object" && Object.keys(value).length > 0;
  });
  if (hasDeps) {
    assert.ok(
      fileExists(path.join("plugins", entry.name, "package-lock.json")),
      `dependency plugin must track package-lock.json: ${entry.name}`,
    );
    assert.ok(
      isTracked(path.join("plugins", entry.name, "package-lock.json")),
      `dependency plugin must track package-lock.json: ${entry.name}`,
    );
  }
}

const readText = (relativePath) => fs.readFile(path.join(repoRoot, relativePath), "utf8");

const readme = await readText("README.md");
assert.ok(
  readme.includes("docs\\AGENT_ARCHITECTURE_ALIGNMENT.md"),
  "README must point future feature work at the agent architecture alignment anchor",
);

const alignmentDoc = await readText("docs/AGENT_ARCHITECTURE_ALIGNMENT.md");
for (const required of [
  "Progressive Disclosure",
  "Do Not Hide Capability",
  "Side Effects Live In Code",
  "tool_manual_search",
  "dryRun",
  "review_draft",
  "directImportApproved",
  "docs/MEMORY_ARCHITECTURE.md",
  "https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills",
  "https://modelcontextprotocol.io/specification/2025-06-18/server/tools",
  "https://github.com/OpenHands/software-agent-sdk",
]) {
  assert.ok(
    alignmentDoc.includes(required),
    `agent architecture alignment doc must keep anchor text: ${required}`,
  );
}

const restartScript = await fs.readFile(path.join(repoRoot, "RESTART_IMAGEBOT_GATEWAY.ps1"), "utf8");
assert.match(
  restartScript,
  /STOP_IMAGEBOT_GATEWAY\.ps1"\)\s+-Fast\b/,
  "restart must stop the old gateway in fast mode so stale stopped-state probes do not pollute final restart status",
);
const statusScript = await fs.readFile(path.join(repoRoot, "STATUS_IMAGEBOT_GATEWAY.ps1"), "utf8");
assert.match(
  statusScript,
  /upstream 'Runtime: stopped' line can refer to the optional OpenClaw service\/runtime state/,
  "status script must explain OpenClaw's optional Runtime line so launcher-managed gateway state is not misread",
);
const backupScript = await fs.readFile(path.join(repoRoot, "scripts", "BACKUP_IMAGEBOT_TO_GITHUB.ps1"), "utf8");
assert.match(backupScript, /\[switch\]\$Push/, "GitHub backup script must require an explicit -Push switch for network push");
assert.match(backupScript, /Push skipped by default/, "GitHub backup script must skip push by default");
assert.match(backupScript, /git remote get-url --push \$Remote/, "GitHub backup script must inspect the push URL before pushing");
assert.doesNotMatch(
  backupScript,
  /if\s*\(\s*-not\s+\$NoPush\s*\)\s*\{\s*Invoke-Git push/s,
  "GitHub backup script must not push by default when -NoPush is omitted",
);
const backupTaskScript = await fs.readFile(path.join(repoRoot, "scripts", "INSTALL_GITHUB_BACKUP_TASK.ps1"), "utf8");
assert.match(
  backupTaskScript,
  /-File `"\$BackupScript`"\s+-NoPush/,
  "scheduled GitHub backup task must install with -NoPush",
);

for (const entrypoint of ["imagebot-launcher.js", "imagebot-control-server.js"]) {
  const result = execFileSync(
    process.execPath,
    [entrypoint, "--self-test"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const parsed = JSON.parse(result);
  assert.equal(parsed.ok, true, `${entrypoint} self-test should pass under package type=module`);
  if (entrypoint === "imagebot-control-server.js") {
    assert.equal(parsed.featureHealth?.status, "ok", "control server self-test should include feature health");
  }
}

const markdownFiles = existingTrackedPosix.filter((file) => /\.(?:md|markdown)$/i.test(file));
const markdownLinkRe = /!?\[[^\]]*]\(([^)]+)\)/g;

for (const file of markdownFiles) {
  const source = await fs.readFile(path.join(repoRoot, file), "utf8");
  for (const match of source.matchAll(markdownLinkRe)) {
    let target = match[1].trim();
    if (!target || target.startsWith("#")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    target = target.replace(/^<|>$/g, "").split("#")[0].trim();
    if (!target) continue;
    const resolved = path.normalize(path.join(path.dirname(file), target.replace(/\\/g, "/")));
    assert.ok(fileExists(resolved), `${file} has missing markdown link target: ${target}`);
  }
}

for (const file of existingTrackedPosix) {
  if (!/\.(?:js|mjs|json|md|ps1|cmd|cs|html|css|svg|txt)$/i.test(file)) continue;
  const stat = await fs.stat(path.join(repoRoot, file));
  if (stat.size > 2 * 1024 * 1024) continue;
  const text = await fs.readFile(path.join(repoRoot, file), "utf8");
  assert.doesNotMatch(text, /gho_[A-Za-z0-9_]{20,}/, `${file} appears to contain a GitHub token`);
  assert.doesNotMatch(text, /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{32,}/, `${file} appears to contain an OpenAI-style API key`);
}

console.log("repo hygiene tests passed", {
  tracked: existingTrackedPosix.length,
  markdown: markdownFiles.length,
});

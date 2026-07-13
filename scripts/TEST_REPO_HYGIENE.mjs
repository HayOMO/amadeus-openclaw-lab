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

function topLevelYamlBlock(source, key) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start < 0) return "";
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[A-Za-z0-9_-]+:/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

const tracked = gitLines(["ls-files"]);
const trackedPosix = tracked.map(toPosix);
const deletedTrackedPosix = new Set(gitLines(["ls-files", "--deleted"]).map(toPosix));
const allowedDeletedTracked = [
  /^patches\/openclaw-2026\.6\.6-runtime\//,
  /^prompt_library\/recipes\/(?:asian_anime_tag_order|asian_social_portrait_grid|guofeng_hanfu_moodboard)\.md$/,
];
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

const workflowFiles = existingTrackedPosix.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(file));
for (const file of workflowFiles) {
  const workflow = await fs.readFile(path.join(repoRoot, file), "utf8");
  const onBlock = topLevelYamlBlock(workflow, "on");
  assert.match(onBlock, /(^|\n)\s+workflow_dispatch:/, `${file} must be manually runnable with workflow_dispatch`);
  assert.match(onBlock, /(^|\n)\s+push:/, `${file} must run on protected branch pushes`);
  assert.match(onBlock, /(^|\n)\s+pull_request:/, `${file} must run on pull requests`);
  assert.doesNotMatch(
    onBlock,
    /(^|\n)\s+(pull_request_target|schedule|workflow_run|release|deployment|registry_package):/,
    `${file} must not use high-risk automatic triggers`,
  );
  assert.match(workflow, /permissions:\s*\n\s+contents:\s+read\b/, `${file} should keep default permissions read-only`);
  assert.match(workflow, /python -m pip install -r requirements-test\.txt/, `${file} should install Python test dependencies`);
  assert.match(workflow, /npm run audit:plugins/, `${file} should audit plugin dependencies before full tests`);
  for (const match of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
    assert.match(match[1], /@[a-f0-9]{40}$/i, `${file} action reference must be pinned to a full commit SHA: ${match[1]}`);
  }
}

const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
assert.ok(fileExists("package-lock.json"), "root package-lock.json must be tracked so npm ci has a reproducible root");
assert.ok(isTracked("package-lock.json"), "root package-lock.json must be tracked so npm ci has a reproducible root");
assert.ok(fileExists(".nvmrc"), "repo must pin the Node major version for local and CI setup");
assert.equal((await fs.readFile(path.join(repoRoot, ".nvmrc"), "utf8")).trim(), "24", ".nvmrc should match the CI/OpenClaw runtime Node major");
assert.equal(packageJson.engines?.node, ">=24 <25", "package.json should declare the supported Node runtime range");
assert.ok(fileExists("requirements-test.txt"), "Python test dependency lock/range file must exist");
assert.match(packageJson.scripts?.["setup:test"] || "", /requirements-test\.txt/, "package scripts should expose setup:test for Python test deps");
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

const pluginInstallScript = await fs.readFile(path.join(repoRoot, "scripts", "INSTALL_IMAGEBOT_PLUGIN_DEPS.ps1"), "utf8");
assert.match(
  pluginInstallScript,
  /"dependencies",\s*"optionalDependencies",\s*"peerDependencies"/,
  "plugin dependency installer must include peerDependencies just like audit/setup checks",
);

const readText = (relativePath) => fs.readFile(path.join(repoRoot, relativePath), "utf8");

const readme = await readText("README.md");
assert.ok(
  /docs[\\/]AGENT_ARCHITECTURE_ALIGNMENT\.md/.test(readme),
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
  const secretPatterns = [
    ["GitHub token", /\bgh[opsru]_[A-Za-z0-9_]{20,}\b/],
    ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
    ["OpenAI/provider-style API key", /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{32,}/],
    ["Telegram bot token", /\b\d{8,12}:[A-Za-z0-9_-]{35}\b/],
    ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
    ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
    ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
    ["private key", /-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH) )?PRIVATE KEY-----/],
  ];
  for (const [label, pattern] of secretPatterns) {
    assert.doesNotMatch(text, pattern, `${file} appears to contain a ${label}`);
  }
}

console.log("repo hygiene tests passed", {
  tracked: existingTrackedPosix.length,
  markdown: markdownFiles.length,
});

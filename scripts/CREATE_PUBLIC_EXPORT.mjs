import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function argValue(name, fallback = undefined) {
  const prefix = `${name}=`;
  const direct = process.argv.find((item) => item.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return fallback;
}

const outDir = path.resolve(repoRoot, argValue("--out", path.join(".runtime", "public-export", "amadeus-openclaw-lab")));
const force = process.argv.includes("--force");

function toPosix(filePath) {
  return filePath.replace(/\\/g, "/");
}

function gitList(args) {
  const output = execFileSync("git", args, { cwd: repoRoot });
  return output.toString("utf8").split("\0").filter(Boolean).map(toPosix);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

const excludedRoots = [
  ".git/",
  ".openclaw/",
  ".runtime/",
  "logs/",
  "generated/",
  "media/",
  "downloads/",
  "tmp/",
  ".tmp/",
  "backups/imagebot-memory/",
  "backups/imagebot-memory-desktop/",
  "native/bin/",
  "native/obj/",
  "node_modules/",
];

const excludedFiles = new Set([
  "config/imagebot/settings.json",
]);

const forbiddenFilePatterns = [
  /\.token$/i,
  /\.secret$/i,
  /\.secrets$/i,
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.log$/i,
  /\.pid$/i,
  /\.batch\.generated\.json$/i,
];

function shouldCopy(relativePath) {
  const posix = toPosix(relativePath);
  if (excludedFiles.has(posix)) return false;
  if (excludedRoots.some((root) => posix === root.slice(0, -1) || posix.startsWith(root))) return false;
  if (forbiddenFilePatterns.some((pattern) => pattern.test(posix))) return false;
  return true;
}

async function ensureCleanOutDir() {
  if (isInside(repoRoot, outDir) && !isInside(path.join(repoRoot, ".runtime"), outDir)) {
    throw new Error(`refusing to write public export inside repo outside .runtime: ${outDir}`);
  }
  if (fsSync.existsSync(outDir)) {
    if (!force) throw new Error(`output directory exists; pass --force to replace it: ${outDir}`);
    await fs.rm(outDir, { recursive: true, force: true });
  }
  await fs.mkdir(outDir, { recursive: true });
}

async function copyFile(relativePath) {
  const source = path.join(repoRoot, relativePath);
  if (!fsSync.existsSync(source)) return false;
  const destination = path.join(outDir, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  return true;
}

function publicText(text) {
  return text
    .replaceAll("-1000000000000", "-1000000000000")
    .replaceAll("-1000000000001", "-1000000000001")
    .replaceAll("-1000000000002", "-1000000000002")
    .replaceAll("YOUR_BOT_USERNAME", "YOUR_BOT_USERNAME")
    .replaceAll("HayOMO/amadeus-openclaw-lab", "HayOMO/amadeus-openclaw-lab")
    .replaceAll("amadeus-openclaw-lab", "amadeus-openclaw-lab")
    .replaceAll("amadeus-openclaw-lab", "amadeus-openclaw-lab")
    .replaceAll("C:\\Users\\Bot", "%USERPROFILE%")
    .replaceAll("%USERPROFILE%", "%USERPROFILE%")
    .replaceAll("Desktop\\Amaduse", "path\\to\\amadeus-openclaw-lab")
    .replaceAll("path/to/amadeus-openclaw-lab", "path/to/amadeus-openclaw-lab");
}

async function transformTextFiles() {
  const stack = [outDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        stack.push(fullPath);
        continue;
      }
      const stat = await fs.stat(fullPath);
      if (stat.size > 25 * 1024 * 1024) continue;
      const buffer = await fs.readFile(fullPath);
      if (buffer.includes(0)) continue;
      const original = buffer.toString("utf8");
      const next = publicText(original);
      if (next !== original) await fs.writeFile(fullPath, next);
    }
  }
}

async function writeJson(relativePath, value) {
  const destination = path.join(outDir, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(relativePath, text) {
  const destination = path.join(outDir, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, text.replace(/\r?\n/g, "\n"));
}

async function writeSanitizedConfig() {
  const settings = JSON.parse(await fs.readFile(path.join(repoRoot, "config", "imagebot", "settings.json"), "utf8"));
  settings.mainGroupId = "-1000000000000";
  settings.groupIds = ["-1000000000000", "-1000000000001"];
  settings.botUsernames = ["YOUR_BOT_USERNAME"];
  settings.mentionPatterns = [
    "^@?YOUR_BOT_USERNAME\\b",
    "^@?Amadeus\\b",
    "^@?Imagebot\\b",
    "^assistant\\b",
  ];
  if (settings.gachaArchive && typeof settings.gachaArchive === "object") {
    settings.gachaArchive.channelChatId = "-1000000000002";
  }
  await writeJson("config/imagebot/settings.json", settings);

  const modelState = {
    schema: 1,
    mode: "balanced",
    model: "openai/gpt-5.5",
    reasoningEffort: "medium",
    textVerbosity: "low",
    note: "Public seed only. Runtime choices should live outside git under ~/.openclaw/imagebot/model-state.json.",
  };
  await writeJson("config/imagebot/model-state.json", modelState);
}

async function writePublicPersonaTemplates() {
  await writeText("persona/README.md", `# Persona Templates

The public export keeps persona/profile files as reproducible examples. Replace
or remove them in a private deployment if you do not want character or role
material in your local runtime.

Use \`active_system.example.md\` as a small neutral seed.
`);

  await writeText("persona/active_system.example.md", `# Active Persona Card - Example

You are a local Telegram imagebot persona.

Keep this file short. Product behavior belongs in plugins, feature manifests,
tool manuals, and tests; persona text should describe tone and identity only.

Suggested defaults:

- answer in the user's language;
- be concise for ordinary group chat;
- become more exact for technical or safety-sensitive work;
- use memory as soft continuity, not proof;
- do not reveal private paths, logs, sessions, tokens, or hidden memory.
`);
}

async function main() {
  await ensureCleanOutDir();

  const tracked = gitList(["ls-files", "-z"]);
  const untracked = gitList(["ls-files", "--others", "--exclude-standard", "-z"]);
  const copied = [];
  for (const file of [...tracked, ...untracked]) {
    if (!shouldCopy(file)) continue;
    if (await copyFile(file)) copied.push(file);
  }

  await writeSanitizedConfig();
  await writePublicPersonaTemplates();
  await transformTextFiles();

  await writeJson(".public-export.json", {
    schema: 1,
    generatedBy: "scripts/CREATE_PUBLIC_EXPORT.mjs",
    sourceRoot: "<local-private-checkout>",
    excludes: {
      roots: excludedRoots,
      files: [...excludedFiles],
    },
    sanitized: [
      "config/imagebot/settings.json",
      "config/imagebot/model-state.json",
      "Telegram group ids",
      "Telegram bot username",
      "local Windows user paths",
    ],
    copied: copied.length,
  });

  console.log(JSON.stringify({ ok: true, outDir, copied: copied.length }, null, 2));
}

await main();

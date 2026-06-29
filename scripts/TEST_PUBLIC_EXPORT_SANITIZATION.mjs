import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outDir = path.join(repoRoot, ".runtime", "test-public-export-sanitization");

function isPublicPlaceholder(value) {
  const text = String(value || "").trim();
  return (
    !text
    || text === "YOUR_BOT_USERNAME"
    || text === "1000000000"
    || /^-100000000000\d+$/.test(text)
  );
}

function privateValuesFromSettings(settings) {
  const values = [
    settings.mainGroupId,
    settings.testGroupId,
    settings.gachaArchive?.channelChatId,
    ...(Array.isArray(settings.groupIds) ? settings.groupIds : []),
    ...(Array.isArray(settings.operatorSenderIds) ? settings.operatorSenderIds : []),
    ...(Array.isArray(settings.botUsernames) ? settings.botUsernames : [])
  ];
  return [...new Set(values.map((item) => String(item || "").trim()).filter((item) => item && !isPublicPlaceholder(item)))];
}

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else {
      yield fullPath;
    }
  }
}

async function readTextIfSmall(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size > 25 * 1024 * 1024) return null;
  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

const sourceSettings = JSON.parse(await fs.readFile(path.join(repoRoot, "config", "imagebot", "settings.json"), "utf8"));
const privateValues = privateValuesFromSettings(sourceSettings);

await fs.rm(outDir, { recursive: true, force: true });
execFileSync(process.execPath, ["scripts/CREATE_PUBLIC_EXPORT.mjs", "--force", "--out", outDir], {
  cwd: repoRoot,
  stdio: "pipe"
});

const publicSettings = JSON.parse(await fs.readFile(path.join(outDir, "config", "imagebot", "settings.json"), "utf8"));
assert.equal(publicSettings.botUsernames?.[0], "YOUR_BOT_USERNAME");
assert.equal(publicSettings.mainGroupId, "-1000000000000");
assert.equal(publicSettings.testGroupId, "-1000000000001");
assert.deepEqual(publicSettings.groupIds, ["-1000000000000", "-1000000000001"]);
assert.deepEqual(publicSettings.operatorSenderIds, ["1000000000"]);
assert.equal(publicSettings.groupRoles?.["-1000000000000"], "production");
assert.equal(publicSettings.groupRoles?.["-1000000000001"], "test");
assert.ok(publicSettings.toolAccess?.operatorOnlyTools?.includes("knowledge_ingest"));
assert.ok(publicSettings.toolAccess?.operatorOnlyTools?.includes("script_action"));

if (privateValues.length) {
  for await (const filePath of walk(outDir)) {
    const text = await readTextIfSmall(filePath);
    if (text === null) continue;
    for (const value of privateValues) {
      assert.ok(!text.includes(value), `public export leaked private setting value ${value} in ${path.relative(outDir, filePath)}`);
    }
  }
}

console.log("public export sanitization tests passed", {
  privateValues: privateValues.length,
  outDir
});

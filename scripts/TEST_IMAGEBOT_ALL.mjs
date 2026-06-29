import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skip = new Set([
  "TEST_IMAGEBOT_ALL.mjs",
  "TEST_IMAGEBOT_CORE.mjs",
]);

const tests = (await fs.readdir(scriptDir))
  .filter((name) => /^TEST_.*\.mjs$/i.test(name))
  .filter((name) => !skip.has(name))
  .sort();

for (const name of tests) {
  const rel = path.join("scripts", name);
  console.log(`\n> node ${rel}`);
  const result = spawnSync("node", [rel], { cwd: path.resolve(scriptDir, ".."), stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\nimagebot all tests passed", { tests: tests.length });

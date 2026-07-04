import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawDistDir } from "./OPENCLAW_RUNTIME_PATHS.mjs";

const distDir = resolveOpenClawDistDir();

const source = await fs.readFile(path.join(distDir, "selection-BfRwHcjH.js"), "utf8");

assert.match(source, /EMBEDDED_RUN_IMAGEBOT_STAGE_WARN_TOTAL_MS = 1500/);
assert.match(source, /EMBEDDED_RUN_IMAGEBOT_STAGE_WARN_STAGE_MS = 750/);
assert.match(source, /function isImagebotEmbeddedRun\(params\)/);
assert.match(source, /params\?\.agentAccountId === "imagebot"/);
assert.match(source, /String\(params\?\.sessionKey \?\? ""\)\.includes\("agent:imagebot:"\)/);
assert.match(source, /resolveImagebotPrepStageWarnOptions\(params\)/);
assert.match(source, /accountId=\$\{params\.agentAccountId \?\? ""\}/);

console.log("embedded prep trace runtime patch tests passed");

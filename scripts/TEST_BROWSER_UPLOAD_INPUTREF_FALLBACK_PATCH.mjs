import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawDistDir } from "./OPENCLAW_RUNTIME_PATHS.mjs";

const distDir = resolveOpenClawDistDir();
const source = await fs.readFile(path.join(distDir, "pw-ai-kfCLlm0Q.js"), "utf8");

assert.match(source, /async function setInputFilesViaPlaywright\(opts\)/);
assert.match(source, /let activeLocator = locator/);
assert.match(source, /if \(inputRef && !element\)/);
assert.match(source, /page\.locator\('input\[type="file"\]'\)\.first\(\)/);
assert.match(source, /await fallbackLocator\.setInputFiles\(resolvedPaths\)/);
assert.match(source, /activeLocator = fallbackLocator/);
assert.match(source, /const handle = await activeLocator\.elementHandle\(\)/);

console.log("browser upload inputRef fallback runtime patch tests passed");

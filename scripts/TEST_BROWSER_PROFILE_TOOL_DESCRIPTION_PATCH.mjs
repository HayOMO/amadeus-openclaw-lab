import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawDistDir } from "./OPENCLAW_RUNTIME_PATHS.mjs";

const distDir = resolveOpenClawDistDir();
const files = [
  "plugin-registration-CIf1lyqW.js",
  "plugin-service-oo3g2he-.js"
];

for (const file of files) {
  const source = await fs.readFile(path.join(distDir, file), "utf8");
  assert.match(source, /Bot-owned OpenClaw-managed profile/);
  assert.match(source, /Verified login markers include Xiaohongshu, Weibo, Bilibili, Baidu\/Tieba, Zhihu, and Pixiv/);
  assert.match(source, /Google and LOFTER are not verified as logged in/);
  assert.match(source, /profile=\\\"user\\\" is blocked/);
  assert.doesNotMatch(source, /known logged-in services/);
  assert.match(source, /Google Lens\/Images is the broadest general visual-search capability/);
  assert.match(source, /profile=\\\"isolated\\\" for separate cookies and site state/);
  assert.doesNotMatch(source, /omit profile by default for the isolated OpenClaw-managed browser/);
}

console.log("browser profile tool description runtime patch tests passed");

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin, { __testing } from "../plugins/imagebot-image-skills/index.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-image-skills-test-"));
const mediaRoot = path.join(root, "media");
await fs.mkdir(mediaRoot, { recursive: true });

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);
const imagePath = path.join(mediaRoot, "kurisu.png");
await fs.writeFile(imagePath, tinyPng);

const tools = new Map();
plugin.register({
  config: { storeDir: path.join(root, "store"), allowedMediaRoots: [mediaRoot] },
  registerTool(tool, meta) {
    tools.set(meta.name, tool);
  }
});

for (const name of ["image_skill_lookup", "image_skill_save_reference", "image_skill_note_preference", "image_skill_recent"]) {
  assert.ok(tools.has(name), `${name} should be registered`);
}

const saved = await tools.get("image_skill_save_reference").execute("save", {
  character: "Makise Kurisu",
  aliases: "Kurisu, Christina, 红莉栖",
  media: imagePath,
  traits: "red hair, lab coat, sharp scientist expression",
  styleHints: "official visual novel/anime character reference"
});
assert.equal(saved.details.status, "ok");
assert.equal(saved.details.skill.name, "Makise Kurisu");
assert.ok(saved.details.reference.path.includes("imagebot-image-skills") || saved.details.reference.path.includes("store"));
await fs.access(saved.details.reference.path);

const pref = await tools.get("image_skill_note_preference").execute("pref", {
  character: "Kurisu",
  userId: "tg:123",
  userName: "alice",
  note: "prefers original outfit and sharper expression"
});
assert.equal(pref.details.status, "ok");
assert.ok(pref.details.skill.preferences.some((item) => item.userId === "tg:123"));

const lookup = await tools.get("image_skill_lookup").execute("lookup", {
  query: "Christina original outfit",
  count: 3
});
assert.equal(lookup.details.status, "ok");
assert.equal(lookup.details.results[0].name, "Makise Kurisu");
assert.match(lookup.content[0].text, /MEDIA:/);

const cjkLookup = await tools.get("image_skill_lookup").execute("lookup-cjk", {
  query: "红莉栖 原设",
  count: 3
});
assert.equal(cjkLookup.details.status, "ok");
assert.equal(cjkLookup.details.results[0].name, "Makise Kurisu");
assert.ok(__testing.extractSearchTerms("红莉栖 原设").includes("红莉栖"));

const recent = await tools.get("image_skill_recent").execute("recent", { count: 2 });
assert.equal(recent.details.status, "ok");
assert.equal(recent.details.results.length, 1);

await assert.rejects(
  () => __testing.resolveAllowedReference({ storeDir: path.join(root, "store"), allowedMediaRoots: [mediaRoot] }, path.join(os.homedir(), "Desktop", "private.png")),
  /outside allowed/
);

console.log("image skills plugin tests passed");

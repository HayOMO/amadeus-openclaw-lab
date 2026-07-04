import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const docPath = path.join(process.cwd(), "docs", "bot_feature_scouting", "feature_candidates_2026-06-29.md");
const text = await fs.readFile(docPath, "utf8");

for (const source of [
  "https://github.com/topics/bot?o=desc&s=stars",
  "https://github.com/topics/telegram-bot?o=desc&s=stars",
  "https://github.com/topics/discord-bot?o=desc&s=stars",
  "https://github.com/lss233/kirara-ai",
  "https://github.com/hubotio/hubot",
  "https://github.com/RasaHQ/rasa",
  "https://github.com/leon-ai/leon"
]) {
  assert.ok(text.includes(source), `missing source: ${source}`);
}

const rows = text.split(/\r?\n/).filter((line) => /^\|\s*\d+\s*\|/.test(line));
assert.equal(rows.length, 50, "feature candidate table must contain exactly 50 rows");

const allowed = new Set(["implemented", "implemented_partial", "conflict"]);
const counts = {};
for (const row of rows) {
  const cols = row.split("|").map((value) => value.trim());
  const index = Number(cols[1]);
  const source = cols[2];
  const feature = cols[3];
  const status = cols[4];
  const record = cols[5];
  assert.ok(index >= 1 && index <= 50, `invalid row index: ${row}`);
  assert.ok(source, `missing source/context for row ${index}`);
  assert.ok(feature, `missing feature for row ${index}`);
  assert.ok(allowed.has(status), `unexpected status for row ${index}: ${status}`);
  assert.ok(record && record.length >= 30, `weak implementation/conflict record for row ${index}`);
  if (status === "conflict") {
    assert.match(record, /outside|risk|unsafe|arbitrary|Do not|do not|requires|security|Copyright|spam|account|boundary|high-stakes|consent|audit|admin|storage|bandwidth|ToS/i, `conflict row ${index} needs a concrete reason`);
  } else {
    assert.match(record, /`[^`]+`|docs\/|scripts\/|tool|profile|contract|manual|implemented|already|supports|defines/i, `implemented row ${index} needs a local artifact or concrete implementation`);
  }
  counts[status] = (counts[status] || 0) + 1;
}

assert.ok(counts.implemented >= 10, "expected at least 10 fully implemented/covered features");
assert.ok(counts.implemented_partial >= 10, "expected at least 10 safe-subset implementations");
assert.ok(counts.conflict >= 5, "expected explicit conflict records");
assert.ok(!text.includes("| candidate_next |"), "no candidate_next rows should remain after profile pass");
assert.ok(text.includes("## First Implementation Record"), "missing implementation record section");

console.log("bot feature candidate tests passed", { rows: rows.length, counts });

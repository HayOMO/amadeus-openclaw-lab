import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const docPath = path.join(process.cwd(), "docs", "CHANNEL_ADAPTER_CONTRACT.md");
const text = await fs.readFile(docPath, "utf8");
const compactText = text.replace(/\s+/g, " ");

for (const heading of [
  "## Scope",
  "## Message Envelope",
  "## Identity",
  "## Trigger Gate",
  "## Media",
  "## Delivery",
  "## Permissions",
  "## Required Tests",
  "## Public Repository Rule"
]) {
  assert.ok(text.includes(heading), `missing section: ${heading}`);
}

for (const required of [
  "must not add a second memory system",
  "Logged-in browser automation",
  "Mass DM",
  "Admin/moderation actions",
  "Raw tokens, cookies",
  "stable bot identities",
  "Ordinary group chatter remains ignored",
  "Tool-visible media paths must stay under configured media roots",
  "Delivery must be explicit and auditable",
  "no token/cookie/local-path leakage"
]) {
  assert.ok(compactText.includes(required), `missing boundary text: ${required}`);
}

assert.match(text, /bypass\s+the\s+interaction\s+trigger\s+gate/i);

const envelopeFields = ["channel", "chatId", "senderId", "messageId", "text", "media", "timestamp"];
for (const field of envelopeFields) {
  assert.ok(text.includes(`"${field}"`), `missing envelope field: ${field}`);
}

console.log("channel adapter contract tests passed");

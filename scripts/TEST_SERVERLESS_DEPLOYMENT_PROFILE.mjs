import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const docPath = path.join(process.cwd(), "docs", "SERVERLESS_DEPLOYMENT_PROFILE.md");
const text = await fs.readFile(docPath, "utf8");
const compactText = text.replace(/\s+/g, " ");

for (const heading of [
  "## Current Decision",
  "## Allowed Use",
  "## Not Allowed By This Profile",
  "## Required Configuration",
  "## Runtime Boundaries",
  "## Test Requirements",
  "## Manual Release Checklist"
]) {
  assert.ok(text.includes(heading), `missing section: ${heading}`);
}

for (const required of [
  "Do not add scheduled GitHub Actions",
  "auto-deploy hooks",
  "public webhook exposure",
  "storing Telegram, OpenAI, GitHub, or provider tokens in the repository",
  "bypassing the existing Telegram trigger/window policy",
  "unknown-chat rejection",
  "no scheduled GitHub workflow files",
  "Deploy manually first"
]) {
  assert.ok(compactText.includes(required), `missing deployment boundary: ${required}`);
}

for (const placeholder of [
  "TELEGRAM_BOT_TOKEN=<set in provider secret store>",
  "OPENAI_API_KEY=<set in provider secret store>",
  "IMAGEBOT_ALLOWED_CHAT_IDS=<comma-separated ids in provider secret store>",
  "WEBHOOK_SECRET=<random secret in provider secret store>"
]) {
  assert.ok(text.includes(placeholder), `missing secret placeholder: ${placeholder}`);
}

console.log("serverless deployment profile tests passed");

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  boundaryFor,
  extractFeaturesFromReadme
} from "./SCOUT_GITHUB_BOT_FEATURES.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "github-bot-feature-scout-test-"));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "fixture.json");
const outDir = path.join(root, "out");

const repo = {
  full_name: "example/test-bot",
  html_url: "https://github.com/example/test-bot",
  stargazers_count: 12345
};
const readme = `
# Test Bot

## Features

- Welcome messages with per-group templates and onboarding rules.
- RSS feed monitoring with keyword filters and quiet hours.
- Mass DM campaign automation for Discord growth teams.
- GitHub release feed notifications for watched repositories.
`;

const extracted = extractFeaturesFromReadme(repo, readme);
assert.equal(extracted.length, 4);
assert.equal(extracted[0].category, "misc");
assert.equal(extracted[1].category, "feed-monitor");
assert.equal(extracted[2].boundary.status, "conflict");
assert.equal(boundaryFor("GitHub release feed notifications").status, "already_supported");

await fs.writeFile(fixturePath, JSON.stringify({
  repos: [
    { ...repo, readme },
    {
      full_name: "example/assistant-bot",
      html_url: "https://github.com/example/assistant-bot",
      stargazers_count: 9999,
      readme: `
## Capabilities
- Ticket workflows with assignment and close reasons.
- Poll creation with reminders and result summaries.
- Role menu style preference selection.
`
    }
  ]
}, null, 2));

const stdout = execFileSync(process.execPath, [
  "scripts/SCOUT_GITHUB_BOT_FEATURES.mjs",
  "--fixture",
  fixturePath,
  "--out",
  outDir,
  "--features",
  "6"
], { cwd: repoRoot, encoding: "utf8" });
const summary = JSON.parse(stdout);
assert.equal(summary.ok, true);
assert.equal(summary.features, 6);

const report = await fs.readFile(path.join(outDir, "github-bot-feature-scout.md"), "utf8");
assert.match(report, /GitHub Bot Feature Scouting/);
assert.match(report, /RSS feed monitoring/);
assert.match(report, /Mass DM campaign automation/);

const data = JSON.parse(await fs.readFile(path.join(outDir, "github-bot-feature-scout.json"), "utf8"));
assert.equal(data.features.length, 6);
assert.ok(data.features.some((feature) => feature.implementation.status === "conflict"));

console.log("github bot feature scout tests passed");

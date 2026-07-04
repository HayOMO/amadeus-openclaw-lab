import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const profiles = [
  {
    file: "OPERATIONS_CONTROL_SURFACE_PROFILE.md",
    sections: ["## Current Decision", "## Covered Candidates", "## Allowed Operations", "## Required Boundaries", "## Not Allowed", "## Test Requirements"],
    required: ["WebUI model management", "HTTP chat API endpoint", "web admin dashboard", "bind to localhost by default", "require authentication", "token/path/chat-id redaction"]
  },
  {
    file: "PLUGIN_TRUST_POLICY.md",
    sections: ["## Current Decision", "## Allowed Registry Metadata", "## Required Trust Checks", "## Not Allowed", "## Test Requirements"],
    required: ["operator-installed", "source URL and commit/tag pin", "installing plugins from arbitrary chat text", "no arbitrary shell command path"]
  },
  {
    file: "ACCOUNT_ROUTING_PROFILE.md",
    sections: ["## Current Decision", "## Allowed Use", "## Required Boundaries", "## Not Allowed", "## Test Requirements"],
    required: ["must not silently switch bot identities", "explicit account binding", "personal account automation", "token redaction"]
  },
  {
    file: "AUDIO_AND_STREAMING_OUTPUT_PROFILE.md",
    sections: ["## Current Decision", "## Voice Reply / TTS Boundaries", "## Streaming / Chunked Output Boundaries", "## Test Requirements"],
    required: ["explicitly asks for a voice reply", "voice profile allowlist", "Telegram edit-rate guard", "no partial factual claims before tool completion"]
  },
  {
    file: "OFFLINE_MODE_PROFILE.md",
    sections: ["## Current Decision", "## Allowed Use", "## Required Boundaries", "## Not Allowed", "## Test Requirements"],
    required: ["fail closed for network tools", "avoid silent fallback to hosted providers", "stale/cached source labeling", "model availability reporting"]
  },
  {
    file: "SAFE_REPO_ASSISTANT_PROFILE.md",
    sections: ["## Current Decision", "## Allowed Use", "## Required Boundaries", "## Not Allowed", "## Test Requirements"],
    required: ["Do not let the Telegram bot edit files", "avoid arbitrary local file reads", "no shell execution path", "ticket creation for follow-up work"]
  },
  {
    file: "TRIVIA_FEATURE_PROFILE.md",
    sections: ["## Current Decision", "## Allowed Use", "## Required Boundaries", "## Not Allowed", "## Test Requirements"],
    required: ["manifest-driven `feature_core`", "deterministic answer checking", "leaderboard ordering", "no copyrighted bundled question dumps"]
  }
];

for (const profile of profiles) {
  const docPath = path.join(process.cwd(), "docs", profile.file);
  const text = await fs.readFile(docPath, "utf8");
  const compact = text.replace(/\s+/g, " ");
  for (const section of profile.sections) {
    assert.ok(text.includes(section), `${profile.file} missing section: ${section}`);
  }
  for (const required of profile.required) {
    assert.ok(compact.includes(required), `${profile.file} missing required boundary: ${required}`);
  }
}

console.log("bot feature profile tests passed");

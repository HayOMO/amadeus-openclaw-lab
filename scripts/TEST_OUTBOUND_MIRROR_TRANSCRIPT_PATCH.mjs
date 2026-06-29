import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const patchDir = path.join(repoRoot, "patches", "openclaw-2026.6.10-runtime");

async function readPatch(name) {
  return await fs.readFile(path.join(patchDir, name), "utf8");
}

const transcriptPatch = await readPatch("21-transcript-detached-write-context-B0xLNm13.js.patch");
const runtimePatch = await readPatch("22-transcript-runtime-detached-export-D1O4D3P9.js.patch");
const deliverPatch = await readPatch("23-deliver-outbound-mirror-retry-BPqL55uX.js.patch");

assert.match(
  transcriptPatch,
  /async function withoutOwnedSessionTranscriptWrites\(run\)/,
  "transcript patch must expose a helper for writes outside a stale owned prompt context",
);
assert.match(
  transcriptPatch,
  /ownedTranscriptWriteContext\.exit\(run\)/,
  "detached helper should use AsyncLocalStorage.exit when available",
);
assert.match(
  runtimePatch,
  /withoutOwnedSessionTranscriptWrites/,
  "transcript.runtime must export the detached write helper for lazy delivery imports",
);
assert.match(
  deliverPatch,
  /OUTBOUND_MIRROR_RETRY_DELAYS_MS/,
  "delivery mirror should use bounded retry delays",
);
assert.match(
  deliverPatch,
  /withOutboundMirrorQueue/,
  "delivery mirror should serialize append retries per session",
);
assert.match(
  deliverPatch,
  /session file changed while embedded prompt lock was released/,
  "delivery mirror should detect embedded prompt takeover failures",
);
assert.match(
  deliverPatch,
  /detachedOwnedContext/,
  "delivery mirror logs should expose whether retry escaped the owned context",
);
assert.match(
  deliverPatch,
  /mirrored outbound delivery into session transcript after retry/,
  "delivery mirror should log successful retry repairs for later incident review",
);

console.log("outbound mirror transcript patch tests passed");

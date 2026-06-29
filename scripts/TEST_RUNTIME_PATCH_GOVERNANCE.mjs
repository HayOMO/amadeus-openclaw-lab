import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const manifestPath = path.join(repoRoot, "patches", "openclaw-2026.6.10-runtime", "manifest.json");
const contractPath = path.join(repoRoot, "policy", "runtime_patch_contract.json");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));

assert.equal(contract.schema, 1);
assert.equal(contract.hostVersion, manifest.openclawVersion);
assert.ok(contract.latestChecked?.date, "contract must record when OpenClaw surfaces were last checked");
assert.ok(contract.latestChecked?.installed, "contract must record installed OpenClaw version");
assert.ok(contract.latestChecked?.npmStable, "contract must record latest stable npm version checked");
assert.ok(Array.isArray(contract.latestChecked?.sourceUrls) && contract.latestChecked.sourceUrls.length >= 3, "contract must record source URLs used for runtime-patch decisions");
assert.ok(contract.ownerClasses && typeof contract.ownerClasses === "object");

const manifestIds = manifest.patches.map((entry) => entry.id).sort();
const contractIds = Object.keys(contract.patches || {}).sort();
assert.deepEqual(contractIds, manifestIds, "every runtime patch must have an ownership/retirement contract");

const ownerClasses = new Set(Object.keys(contract.ownerClasses));
for (const entry of manifest.patches) {
  const patch = contract.patches[entry.id];
  assert.ok(ownerClasses.has(patch.ownerClass), `${entry.id}: unknown ownerClass ${patch.ownerClass}`);
  assert.ok(["low", "medium", "high"].includes(patch.maintenanceRisk), `${entry.id}: bad maintenanceRisk`);
  assert.ok(Array.isArray(patch.publicSurfaceChecked) && patch.publicSurfaceChecked.length > 0, `${entry.id}: publicSurfaceChecked required`);
  assert.ok(typeof patch.whyRuntimePatch === "string" && patch.whyRuntimePatch.length >= 80, `${entry.id}: whyRuntimePatch must be specific`);
  assert.ok(typeof patch.retireWhen === "string" && patch.retireWhen.length >= 60, `${entry.id}: retireWhen must be specific`);
}

const highRisk = Object.entries(contract.patches).filter(([, patch]) => patch.maintenanceRisk === "high");
assert.ok(highRisk.some(([id]) => id === "telegram-imagebot-core"), "large Telegram core patch must remain flagged high-risk until split");

console.log("runtime patch governance tests passed", {
  patches: manifestIds.length,
  highRisk: highRisk.map(([id]) => id)
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const patchPath = path.join(
  repoRoot,
  "patches",
  "openclaw-2026.6.10-runtime",
  "19-openai-chatgpt-oauth-flow.runtime-CQr6awKU.js.patch",
);
const launcherPath = path.join(repoRoot, "RUN_IMAGEBOT_GATEWAY.ps1");

const patchText = await fs.readFile(patchPath, "utf8");
assert.match(
  patchText,
  /withTrustedEnvProxyGuardedFetchMode/,
  "OAuth token patch must opt into OpenClaw's trusted env-proxy guarded fetch mode",
);
assert.match(
  patchText,
  /fetchWithSsrFGuard\(withTrustedEnvProxyGuardedFetchMode\(\{/,
  "OAuth token fetch should wrap only this request in trusted env-proxy mode",
);
assert.match(
  patchText,
  /auditContext: "openai-chatgpt-oauth-token"/,
  "OAuth token audit context should remain specific for log triage",
);

const launcherText = await fs.readFile(launcherPath, "utf8");
assert.match(
  launcherText,
  /function Resolve-GatewayHttpProxyUrl/,
  "gateway launcher should resolve the current Windows proxy without editing proxy software",
);
assert.match(
  launcherText,
  /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings/,
  "gateway launcher should read the Windows user proxy setting",
);
assert.match(
  launcherText,
  /"HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"/,
  "gateway launcher should set both upper and lower case proxy env vars for Node/proxy-from-env compatibility",
);
assert.match(
  launcherText,
  /Restore-GatewayEnvironment -Snapshot \$gatewayEnvSnapshot/,
  "gateway launcher should restore its process environment after gateway exit",
);

console.log("openai chatgpt oauth proxy patch tests passed");

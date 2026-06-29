import assert from "node:assert/strict";
import {
  assertBrowserRequestUrlAllowed,
  assertPublicHostname,
  assertPublicUrl,
  isBlockedHostname,
  isPrivateIp,
  normalizePublicHttpUrl
} from "../plugins/imagebot-shared/public-network-guard.mjs";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup = async () => [{ address: "127.0.0.1", family: 4 }];
const proxyFakeLookup = async () => [{ address: "198.18.0.42", family: 4 }];

assert.equal(isBlockedHostname("localhost"), true);
assert.equal(isBlockedHostname("127.0.0.1"), true);
assert.equal(isBlockedHostname("10.0.0.1"), true);
assert.equal(isBlockedHostname("169.254.169.254"), true);
assert.equal(isBlockedHostname("example.com"), false);
assert.equal(isPrivateIp("198.18.0.42"), true);
assert.equal(isPrivateIp("198.18.0.42", { allowProxyFakeIpv4: true }), false);

assert.equal(normalizePublicHttpUrl("https://example.com/a"), "https://example.com/a");
assert.equal(normalizePublicHttpUrl("file:///C:/Windows"), "");
assert.equal(normalizePublicHttpUrl("http://127.0.0.1:3000"), "");

await assertPublicHostname("example.com", { dnsLookup: publicLookup });
await assert.rejects(
  () => assertPublicHostname("rebinding.example", { dnsLookup: privateLookup }),
  /private|internal|special-use/i
);
await assertPublicHostname("proxy-fake.example", { dnsLookup: proxyFakeLookup });

await assertPublicUrl("https://example.com/path", { dnsLookup: publicLookup });
await assert.rejects(
  () => assertPublicUrl("https://rebinding.example/path", { dnsLookup: privateLookup }),
  /private|internal|special-use/i
);

await assertBrowserRequestUrlAllowed("about:blank");
await assertBrowserRequestUrlAllowed("data:image/png;base64,AA==");
await assertBrowserRequestUrlAllowed("https://example.com/a", new Map(), { dnsLookup: publicLookup });
await assert.rejects(
  () => assertBrowserRequestUrlAllowed("https://rebinding.example/a", new Map(), { dnsLookup: privateLookup }),
  /private|internal|special-use/i
);
await assert.rejects(
  () => assertBrowserRequestUrlAllowed("file:///C:/Windows/win.ini"),
  /scheme is blocked/i
);

console.log("public network guard tests passed");

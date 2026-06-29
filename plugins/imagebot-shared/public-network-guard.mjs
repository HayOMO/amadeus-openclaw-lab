import dns from "node:dns/promises";
import net from "node:net";

const guardedBrowserContexts = new WeakSet();

export function normalizeHostname(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

export function isProxyFakeIpv4(address) {
  const parts = String(address || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 198 && (b === 18 || b === 19);
}

export function isPrivateIpv4(address) {
  const parts = String(address || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 100 && b >= 64 && b <= 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 0 && c === 0 ||
    a === 192 && b === 0 && c === 2 ||
    a === 192 && b === 168 ||
    a === 198 && (b === 18 || b === 19) ||
    a === 198 && b === 51 && c === 100 ||
    a === 203 && b === 0 && c === 113 ||
    a >= 224
  );
}

export function isPrivateIpv6(address) {
  const host = normalizeHostname(address);
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("ff") ||
    host.startsWith("2001:db8:")
  );
}

export function isPrivateIp(address, { allowProxyFakeIpv4 = false } = {}) {
  const host = normalizeHostname(address);
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    if (allowProxyFakeIpv4 && isProxyFakeIpv4(host)) return false;
    return isPrivateIpv4(host);
  }
  if (ipVersion === 6) return isPrivateIpv6(host);
  return false;
}

export function isBlockedHostname(hostname, options = {}) {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  return isPrivateIp(host, options);
}

export async function assertPublicHostname(hostname, options = {}) {
  const {
    allowProxyFakeIpv4 = true,
    dnsLookup = dns.lookup
  } = options;
  const host = normalizeHostname(hostname);
  if (isBlockedHostname(host, { allowProxyFakeIpv4 })) {
    throw new Error("private/internal hostnames are blocked");
  }
  if (net.isIP(host)) return true;

  let addresses;
  try {
    addresses = await dnsLookup(host, { all: true, order: "verbatim" });
  } catch (error) {
    throw new Error(`DNS lookup failed for ${host}: ${error?.code || error?.message || error}`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error("DNS lookup returned no addresses");
  const privateAddress = addresses.find((entry) => isPrivateIp(entry.address, { allowProxyFakeIpv4 }));
  if (privateAddress) throw new Error("URL resolves to a private/internal/special-use address");
  return true;
}

export function normalizePublicHttpUrl(raw, { allowProtocolRelative = true } = {}) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  try {
    const trimmed = raw.trim();
    const candidate = allowProtocolRelative && trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (isBlockedHostname(url.hostname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export async function assertPublicUrl(raw, options = {}) {
  const normalized = normalizePublicHttpUrl(String(raw || ""));
  if (!normalized) throw new Error("URL is not an allowed public http/https URL");
  const url = new URL(normalized);
  await assertPublicHostname(url.hostname, options);
  return url;
}

export async function assertBrowserRequestUrlAllowed(rawUrl, cache = new Map(), options = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    throw new Error("browser request URL is invalid");
  }
  if (["about:", "data:", "blob:"].includes(url.protocol)) return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`browser request scheme is blocked: ${url.protocol}`);
  }
  const hostKey = normalizeHostname(url.hostname);
  if (!cache.has(hostKey)) {
    cache.set(hostKey, assertPublicHostname(url.hostname, options).then(() => true));
  }
  await cache.get(hostKey);
  return true;
}

export async function installBrowserNetworkGuard(context, options = {}) {
  if (guardedBrowserContexts.has(context)) return;
  guardedBrowserContexts.add(context);
  const cache = new Map();
  await context.route("**/*", async (route) => {
    try {
      await assertBrowserRequestUrlAllowed(route.request().url(), cache, options);
      await route.continue();
    } catch {
      await route.abort("blockedbyclient").catch(() => {});
    }
  });
}

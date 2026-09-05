import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";

const networks = new Map();
function includes(address, ranges) {
  if (!isIP(address)) return false;
  if (!networks.has(ranges)) {
    const list = new BlockList();
    for (const cidr of ranges.split(",").map(s => s.trim()).filter(Boolean)) {
      const [ip, prefix] = cidr.split("/");
      const family = isIP(ip);
      if (!family) throw new Error("Invalid trusted proxy address");
      list.addSubnet(ip, Number(prefix ?? (family === 4 ? 32 : 128)), family === 4 ? "ipv4" : "ipv6");
    }
    networks.set(ranges, list);
  }
  return networks.get(ranges).check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
}
function normalizeAddress(value) {
  const address = String(value || "").trim().replace(/^\[|\]$/g, "");
  const plain = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
  if (plain.includes("%") || !isIP(plain)) return "";
  return isIP(plain) === 6 ? new URL(`http://[${plain}]/`).hostname.slice(1, -1) : plain;
}
export function isIpAddress(value) { return isIP(String(value || "")) !== 0; }
export function isPrivateAddress(value) {
  return includes(normalizeAddress(value), "10.0.0.0/8,127.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,::1/128,fc00::/7,fe80::/10");
}
export function isTrustedPeer(req) {
  return includes(normalizeAddress(req.socket?.remoteAddress), process.env.TRUSTED_PROXY_CIDRS || "127.0.0.1/32,::1/128");
}
function trustedEdge(address) {
  return includes(address, process.env.TRUSTED_EDGE_CIDRS || "");
}
export function fromCloudflare(req) {
  return isTrustedPeer(req) && trustedEdge(normalizeAddress(String(req.headers?.["x-forwarded-for"] || "").split(",").at(-1)));
}
export function clientAddress(req) {
  const peer = normalizeAddress(req.socket?.remoteAddress);
  if (!isTrustedPeer(req)) return peer;
  const headers = req.headers || {};
  const hops = String(headers["x-forwarded-for"] || "").split(",").map(normalizeAddress).filter(Boolean);
  if (hops.length && !trustedEdge(hops.at(-1))) return hops.at(-1);
  const cloudflare = normalizeAddress(headers["cf-connecting-ip"]);
  if (fromCloudflare(req) && cloudflare) return cloudflare;
  for (let i = hops.length - 1; i >= 0; i--) if (!trustedEdge(hops[i])) return hops[i];
  const external = normalizeAddress(headers["x-envoy-external-address"]);
  return external || peer;
}
export function clientKey(req) {
  const address = clientAddress(req);
  return address ? createHash("sha256").update(address).digest("hex").slice(0, 24) : "unknown";
}

const BROWSERS = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\//, "Chrome"],
  [/\bChrome\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

const SYSTEMS = [
  [/\bWindows NT 10/, "Windows"],
  [/\bWindows/, "Windows"],
  [/\biPhone|\biPad|\biPod/, "iOS"],
  [/\bAndroid/, "Android"],
  [/\bMac OS X|\bMacintosh/, "macOS"],
  [/\bCrOS/, "ChromeOS"],
  [/\bLinux/, "Linux"],
];

function match(table, ua) {
  for (const [pattern, label] of table) if (pattern.test(ua)) return label;
  return "";
}

// Enough to recognise a visitor's setup in a ping, nothing resembling a
// fingerprint. Unknown agents stay unknown rather than being guessed at.
export function describeClient(req) {
  const ua = String(req.headers?.["user-agent"] || "").slice(0, 400);
  const language = String(req.headers?.["accept-language"] || "")
    .split(",")[0]
    .trim()
    .slice(0, 16);
  const tablet = /\biPad\b/.test(ua) || (/\bAndroid\b/.test(ua) && !/\bMobile\b/.test(ua));
  return {
    address: clientAddress(req),
    userAgent: ua,
    country: fromCloudflare(req) && /^[A-Z]{2}$/.test(req.headers?.["cf-ipcountry"] || "") ? req.headers["cf-ipcountry"] : "",
    browser: match(BROWSERS, ua),
    system: match(SYSTEMS, ua),
    device: tablet ? "tablet" : /\bMobi|\biPhone|\bAndroid/.test(ua) ? "phone" : "desktop",
    language,
  };
}

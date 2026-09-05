import { isTrustedPeer, fromCloudflare } from "./client.mjs";
// Deciding whether a request originally arrived over plain HTTP.
//
// This is harder than reading x-forwarded-proto because public traffic reaches
// the pod as Cloudflare -> cloudflared -> Envoy's :80 listener. Envoy sets
// x-forwarded-proto from the listener it received the request on, so a browser
// request made over HTTPS can still look like "http" by the time it lands
// here. Redirecting on that alone would loop forever.
//
// Cloudflare sets cf-ray on everything it proxies and cf-visitor carries the
// scheme the browser actually used, before any tunnel hop. So:
//
//   through Cloudflare -> trust cf-visitor, and if it is missing or unreadable,
//                         do nothing rather than risk a loop
//   anything else       -> trust x-forwarded-proto, which the gateway sets
//                          correctly for LAN traffic on its own listeners
//   neither present     -> a direct hit: kubelet probes, Alloy scrapes, tests
//
// Every branch either redirects to https or leaves the request alone, so no
// input can produce a cycle.

export const CANONICAL_HOST = "giovanni.dev.br";

export function originalScheme(req) {
  if (!isTrustedPeer(req)) return req.socket?.encrypted ? "https" : "";
  const headers = req?.headers || {};
  if (fromCloudflare(req) && headers["cf-ray"]) {
    const visitor = String(headers["cf-visitor"] || "");
    // cf-visitor is a small JSON object, e.g. {"scheme":"https"}.
    const match = visitor.match(/"scheme"\s*:\s*"(https?)"/i);
    return match ? match[1].toLowerCase() : "";
  }
  const forwarded = String(headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return forwarded === "http" || forwarded === "https" ? forwarded : "";
}

// The public hostnames this site answers on. A request for anything else is
// left alone: it is either internal or something we do not own.
const PUBLIC_HOSTS = new Set([CANONICAL_HOST, `www.${CANONICAL_HOST}`]);

// Returns the absolute https URL to send the visitor to, or null to serve the
// request as-is. Wrong scheme and wrong host resolve in a single hop.
export function httpsRedirect(req) {
  const host = String(req?.headers?.host || "").split(":")[0].toLowerCase();
  if (!PUBLIC_HOSTS.has(host)) return null;
  const insecure = originalScheme(req) === "http";
  const wrongHost = host !== CANONICAL_HOST;
  if (!insecure && !wrongHost) return null;
  return `https://${CANONICAL_HOST}${req.url || "/"}`;
}

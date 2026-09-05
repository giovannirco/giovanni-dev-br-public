import { originalScheme } from "./scheme.mjs";

export function sameOrigin(req) {
  const site = String(req.headers?.["sec-fetch-site"] || "").toLowerCase();
  if (site && !["same-origin", "none"].includes(site)) return false;
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    const value = new URL(origin);
    const scheme = originalScheme(req) || (req.socket?.encrypted ? "https" : "http");
    const target = new URL(`${scheme}://${req.headers?.host}`);
    return ["http:", "https:"].includes(value.protocol) && value.origin === target.origin && value.href === `${value.origin}/`;
  } catch { return false; }
}
export function jsonContentType(req) {
  return String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase() === "application/json";
}
export function postAllowed(req) { return sameOrigin(req) && jsonContentType(req); }

// Response security headers.
//
// The site serves one static bundle and its own JSON APIs. Nothing is loaded
// from another origin, nothing is posted to another origin, and nothing here
// should ever be framed, so the policy can be tight rather than advisory.
//
// `style-src` keeps 'unsafe-inline' on purpose: the chart and dossier markup
// sets a per-body colour through a `style="--body-color:…"` attribute, and the
// colours come from the packaged catalog, not from a visitor. Scripts have no
// such exception.

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

export function securityHeaders({ https = false } = {}) {
  const headers = {
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "x-frame-options": "DENY",
  };
  // Only claim HTTPS on a request that actually arrived over it. Public traffic
  // reaches Envoy's :80 listener through the tunnel, so this is decided from
  // cf-visitor by src/scheme.mjs, not from the listener.
  if (https)
    headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  return headers;
}

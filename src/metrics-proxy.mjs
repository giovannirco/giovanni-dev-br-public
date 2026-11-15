import { createServer } from "node:http";

const QUERY_PATH = "/prometheus/api/v1/query";
const MAX_QUERY_CHARS = 4000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 8000;

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readQuery(url) {
  const names = [...url.searchParams.keys()];
  if (names.length !== 1 || names[0] !== "query") return null;
  const query = url.searchParams.get("query");
  if (!query || query.length > MAX_QUERY_CHARS) return null;
  return query;
}

export function createMetricsProxy({
  upstream = process.env.MIMIR_UPSTREAM_URL || "",
  tenant = process.env.MIMIR_TENANT || "anonymous",
  maxBytes = MAX_RESPONSE_BYTES,
  fetchImpl = fetch,
} = {}) {
  if (!upstream) throw new Error("Metrics proxy is missing upstream.");
  const root = String(upstream).replace(/\/$/, "");

  async function forward(query) {
    const response = await fetchImpl(`${root}${QUERY_PATH}?query=${encodeURIComponent(query)}`, {
      method: "GET",
      headers: { "X-Scope-OrgID": tenant, accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = Buffer.from(await response.arrayBuffer());
    return body.length > maxBytes ? null : body;
  }

  async function handle(req, res) {
    const raw = String(req.url || "");
    const url = new URL(raw, "http://proxy");
    if (req.method === "GET" && raw === "/healthz") return reply(res, 200, { ok: true });
    if (req.method !== "GET" || raw.split("?")[0] !== QUERY_PATH) return reply(res, 404, { error: "Not found." });
    const query = readQuery(url);
    if (!query) return reply(res, 400, { error: "Bad request." });
    let body = null;
    try {
      body = await forward(query);
    } catch {
      body = null;
    }
    if (!body) return reply(res, 502, { error: "Upstream unavailable." });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => reply(res, 500, { error: "Proxy error." }));
  });
}

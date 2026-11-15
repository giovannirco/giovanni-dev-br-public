import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { createRateLimit } from "./limits.mjs";

const KINDS = new Set(["launch", "relay"]);
const MAX_TEXT_CHARS = 2000;
const MAX_BODY_BYTES = 8192;
const HOUR_MS = 60 * 60_000;
const HOURLY_LIMIT = 60;
const GATEWAY_TIMEOUT_MS = 5000;

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Too large."), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseMessage(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (!KINDS.has(body.kind)) return null;
  if (typeof body.text !== "string" || !body.text || body.text.length > MAX_TEXT_CHARS) return null;
  return { kind: body.kind, text: body.text };
}

export function createNotifyRelay({
  token = process.env.NOTIFY_TOKEN || "",
  baseUrl = process.env.WAHA_BASE_URL || "",
  apiKey = process.env.WAHA_API_KEY || "",
  session = process.env.WAHA_SESSION || "default",
  chatId = process.env.WAHA_BEACON_CHAT_ID || "",
  limit = HOURLY_LIMIT,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  for (const [name, value] of Object.entries({ token, baseUrl, apiKey, chatId }))
    if (!value) throw new Error(`Notify relay is missing ${name}.`);

  const expected = digest(token);
  const root = String(baseUrl).replace(/\/$/, "");
  const budget = createRateLimit({ limit, windowMs: HOUR_MS, now });

  function authorized(req) {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return false;
    return timingSafeEqual(digest(header.slice(7)), expected);
  }

  async function deliver(text) {
    try {
      const response = await fetchImpl(`${root}/api/sendText`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Api-Key": apiKey },
        body: JSON.stringify({ session, chatId, text }),
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function handle(req, res) {
    const path = new URL(req.url, "http://relay").pathname;
    if (req.method === "GET" && path === "/healthz") return reply(res, 200, { ok: true });
    if (req.method !== "POST" || path !== "/notify") return reply(res, 404, { error: "Not found." });
    if (!authorized(req)) return reply(res, 401, { error: "Unauthorized." });

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      return reply(res, err.status === 413 ? 413 : 400, { error: "Bad request." });
    }
    const message = parseMessage(raw);
    if (!message) return reply(res, 400, { error: "Bad request." });

    const ticket = budget.take("all");
    if (!ticket.ok) return reply(res, 429, { error: "Hourly limit reached." });
    if (!(await deliver(message.text))) {
      ticket.refund();
      return reply(res, 502, { error: "Delivery failed." });
    }
    return reply(res, 200, { ok: true });
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => reply(res, 500, { error: "Relay error." }));
  });
}

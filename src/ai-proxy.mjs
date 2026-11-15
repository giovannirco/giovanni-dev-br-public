import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";

import { DEFAULT_PUBLIC_MODELS } from "./chat.mjs";
import { createRateLimit } from "./limits.mjs";
import { upstreamJson } from "./upstream.mjs";

const ROLES = new Set(["system", "user", "assistant"]);
const MAX_BODY_BYTES = 128 * 1024;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 40_000;
const MAX_TOKENS = 600;
const HOUR_MS = 60 * 60_000;
const HOURLY_BUDGET = 120;
const CHAT_TIMEOUT_MS = 45_000;
const MODELS_TIMEOUT_MS = 8000;

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

function configuredModels(env) {
  const listed = String(env.CHAT_MODELS || "").split(",").map((id) => id.trim()).filter(Boolean);
  const base = listed.length ? listed : DEFAULT_PUBLIC_MODELS;
  return [...new Set([...base, env.OPENAI_MODEL].filter(Boolean))];
}

export function createAiProxy({
  token = process.env.AI_PROXY_TOKEN || "",
  upstream = process.env.AI_UPSTREAM_URL || "",
  upstreamKey = process.env.AI_UPSTREAM_KEY || "",
  models = configuredModels(process.env),
  budget = HOURLY_BUDGET,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  for (const [name, value] of Object.entries({ token, upstream, upstreamKey }))
    if (!value) throw new Error(`AI proxy is missing ${name}.`);
  if (!models.length) throw new Error("AI proxy is missing models.");

  const expected = digest(token);
  const root = String(upstream).replace(/\/$/, "");
  const allowed = new Set(models);
  const hourly = createRateLimit({ limit: budget, windowMs: HOUR_MS, now });

  function authorized(req) {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return false;
    return timingSafeEqual(digest(header.slice(7)), expected);
  }

  function parseChat(raw) {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    if (typeof body.model !== "string" || !allowed.has(body.model)) return null;
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > MAX_MESSAGES) return null;
    let chars = 0;
    const messages = [];
    for (const message of body.messages) {
      if (!message || !ROLES.has(message.role) || typeof message.content !== "string") return null;
      chars += message.content.length;
      messages.push({ role: message.role, content: message.content });
    }
    if (chars > MAX_MESSAGE_CHARS) return null;
    const temperature = Number.isFinite(body.temperature) ? Math.min(Math.max(body.temperature, 0), 1) : 0.4;
    const requested = Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : MAX_TOKENS;
    return { model: body.model, messages, temperature, max_tokens: Math.min(requested, MAX_TOKENS), stream: body.stream === true };
  }

  async function listModels(res) {
    let data;
    try {
      const response = await fetchImpl(`${root}/models`, {
        headers: { authorization: `Bearer ${upstreamKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      });
      if (!response.ok) return reply(res, 502, { error: "Upstream unavailable." });
      data = await upstreamJson(response);
    } catch {
      return reply(res, 502, { error: "Upstream unavailable." });
    }
    if (!Array.isArray(data?.data)) return reply(res, 502, { error: "Upstream unavailable." });
    const listed = data.data
      .filter((m) => typeof m?.id === "string" && allowed.has(m.id))
      .map((m) => ({ id: m.id, object: "model", ...(typeof m.name === "string" ? { name: m.name.slice(0, 160) } : {}) }));
    return reply(res, 200, { object: "list", data: listed });
  }

  async function complete(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      return reply(res, err.status === 413 ? 413 : 400, { error: "Bad request." });
    }
    const chat = parseChat(raw);
    if (!chat) return reply(res, 400, { error: "Bad request." });
    const ticket = hourly.take("all");
    if (!ticket.ok) return reply(res, 429, { error: "Hourly budget reached." });
    let response;
    try {
      response = await fetchImpl(`${root}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${upstreamKey}` },
        body: JSON.stringify(chat),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    } catch {
      response = null;
    }
    if (!response?.ok || !response.body) {
      ticket.refund();
      return reply(res, 502, { error: "Upstream unavailable." });
    }
    const type = response.headers.get("content-type") || "";
    res.writeHead(200, {
      "content-type": type.includes("text/event-stream") ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    Readable.fromWeb(response.body).on("error", () => res.destroy()).pipe(res);
  }

  async function handle(req, res) {
    const path = String(req.url || "").split("?")[0];
    if (req.method === "GET" && path === "/healthz") return reply(res, 200, { ok: true });
    const route = `${req.method} ${path}`;
    if (route !== "GET /v1/models" && route !== "POST /v1/chat/completions") return reply(res, 404, { error: "Not found." });
    if (!authorized(req)) return reply(res, 401, { error: "Unauthorized." });
    return route === "GET /v1/models" ? listModels(res) : complete(req, res);
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => (res.headersSent ? res.destroy() : reply(res, 500, { error: "Proxy error." })));
  });
}

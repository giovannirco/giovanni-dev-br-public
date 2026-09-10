import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import {
  chatGrounding,
  chatMessages,
  chatSystemPrompt,
  completeChat,
  streamChat,
  createModelCatalog,
  publicModelIds,
} from "./src/chat.mjs";
import { createMetrics, metricsDenied } from "./src/metrics.mjs";
import { createBeacon } from "./src/beacon.mjs";
import { clientKey, describeClient, isTrustedPeer } from "./src/client.mjs";
import { createConcurrency, createRateLimit } from "./src/limits.mjs";
import { createInsight } from "./src/insight.mjs";
import { httpsRedirect, originalScheme } from "./src/scheme.mjs";
import { postAllowed } from "./src/origin.mjs";
import { readBounded, createReadCache } from "./src/upstream.mjs";
import { securityHeaders } from "./src/headers.mjs";
import {
  createLogger,
  logBeacon,
  logChat,
  logRefused,
  logRequest,
  logUpstream,
} from "./src/log.mjs";

const compress = promisify(gzip);
const compressedAssets = new Map();

const root = fileURLToPath(new URL(".", import.meta.url));
const dist = join(root, "dist");
// Resolved once: dist itself may legitimately sit behind a link, and every
// served file is compared against the resolved location.
const distReal = await realpath(dist).catch(() => dist);
const port = Number(process.env.PORT || 8080);
const mempool = (
  process.env.MEMPOOL_API_BASE || ""
).replace(/\/$/, "");

// Allowlisted mempool reads. `pick` trims the upstream body so a change there
// cannot start publishing fields nobody chose: /api/v1/blocks alone is a large
// array of full blocks, and only the tip's height and timestamp are wanted.
const bitcoinRoutes = {
  "/api/bitcoin/node": { insight: "bitcoin" },
  "/api/bitcoin/tip": { upstream: "/api/v1/blocks/tip/height" },
  "/api/bitcoin/hash": { upstream: "/api/v1/blocks/tip/hash" },
  "/api/bitcoin/fees": { upstream: "/api/v1/fees/recommended" },
  "/api/bitcoin/mempool": { upstream: "/api/v1/mempool" },
  "/api/bitcoin/price": {
    upstream: "/api/v1/prices",
    pick: (d) => ({ usd: Number(d?.USD) || null, time: Number(d?.time) || null }),
  },
  "/api/bitcoin/block": {
    upstream: "/api/v1/blocks",
    pick: (d) => {
      const tip = Array.isArray(d) ? d[0] : null;
      return {
        height: Number(tip?.height) || null,
        timestamp: Number(tip?.timestamp) || null,
        transactions: Number(tip?.tx_count) || null,
      };
    },
  },
  "/api/bitcoin/difficulty": {
    upstream: "/api/v1/difficulty-adjustment",
    pick: (d) => ({
      progress: Number(d?.progressPercent) || 0,
      change: Number(d?.difficultyChange) || 0,
      remainingBlocks: Number(d?.remainingBlocks) || null,
    }),
  },
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function json(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function proxyBitcoin(path, upstreamBase) {
  const route = bitcoinRoutes[path];
  if (!route) return null;
  const upstream = route.upstream;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${upstreamBase}${upstream}`, {
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("Bitcoin upstream unavailable");
    const text = await readBounded(r);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (path === "/api/bitcoin/tip") {
      if (!Number.isSafeInteger(data) || data < 0) throw new Error("Invalid Bitcoin height");
      data = { height: data };
    }
    if (path === "/api/bitcoin/hash") {
      const hash = typeof data === "string" ? data : text.trim();
      if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error("Invalid Bitcoin hash");
      data = { hash };
    }
    const fields = { "/api/bitcoin/mempool": ["count", "vsize", "total_fee"], "/api/bitcoin/fees": ["fastestFee", "halfHourFee", "hourFee", "economyFee", "minimumFee"] }[path];
    if (fields) data = Object.fromEntries(fields.filter(key => Object.hasOwn(data ?? {}, key)).map(key => [key, typeof data[key] === "number" && Number.isFinite(data[key]) ? data[key] : null]));
    if (route.pick && r.ok) data = route.pick(data);
    return { status: r.status, data };
  } finally {
    clearTimeout(t);
  }
}

async function staticFile(urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = normalize(join(dist, rel));
  if (!file.startsWith(dist + sep)) return null;
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    // The lexical check above is about the requested path; this one is about
    // what the filesystem actually hands back. A symlink planted in dist would
    // otherwise read a file from outside it.
    const real = await realpath(file);
    if (real !== distReal && !real.startsWith(distReal + sep)) return null;
    return {
      file,
      modified: info.mtimeMs,
      type: types[extname(file)] || "application/octet-stream",
    };
  } catch {
    if (!extname(rel)) {
      try {
        const index = await realpath(join(dist, "index.html"));
        if (!index.startsWith(distReal + sep)) return null;
        return { file: index, type: types[".html"] };
      } catch { return null; }
    }
    return null;
  }
}

export function requestPath(url) {
  return new URL(url, "http://local").pathname;
}

async function readJson(req, limit = 12_000) {
  const chunks = [];
  let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > limit) {
      const err = new Error("payload too large");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Object required");
  return parsed;
}

export function createApp({
  mempoolBase = mempool,
  lightningAddress = process.env.LIGHTNING_ADDRESS || "",
  btcpayUrl = process.env.BTCPAY_URL || "",
  openaiBaseUrl = process.env.OPENAI_BASE_URL || "",
  openaiApiKey = process.env.OPENAI_API_KEY || "",
  openaiModel = process.env.OPENAI_MODEL || "grok-4.6",
  fetchImpl = fetch,
  metrics = createMetrics(),
  beacon = createBeacon({ fetchImpl }),
  // /api/chat is public, unauthenticated, and spends Gio's own LLM gateway
  // quota. Without a ceiling one script can run the house account dry.
  chatLimit = createRateLimit({ limit: 10, windowMs: 10 * 60_000 }),
  chatBudget = createRateLimit({ limit: 120, windowMs: 60 * 60_000 }),
  chatModels = publicModelIds(),
  insight = createInsight({ fetchImpl }),
  log = createLogger(),
  // The read APIs are cheap for a visitor and not free for the cluster: each
  // one reaches mempool, Mimir or Job Scout. A browsing visitor makes a handful
  // of calls a minute, so these ceilings are invisible in normal use and stop a
  // loop from pointing the public internet at in-cluster services.
  // Concurrency, not rate: how many completions may be in flight at once. The
  // per-caller share stops one visitor holding the whole gateway while
  // everyone else waits; the total is what this pod is willing to carry.
  chatConcurrency = createConcurrency({ limit: 30, perKey: 4 }),
  readLimit = createRateLimit({ limit: 240, windowMs: 60_000 }),
  readBudget = createRateLimit({ limit: 1200, windowMs: 60_000 }),
} = {}) {
  // The configured default is always offerable, so a narrow allowlist can
  // never leave the picker empty.
  const allowed = [...new Set([...chatModels, openaiModel])];
  const bitcoinCache = createReadCache({ ttlMs: 5000 });
  const chatAttempts = createRateLimit({ limit: 30, windowMs: 60_000 });
  const telemetryLimit = createRateLimit({ limit: 120, windowMs: 60_000 });
  const telemetryBudget = createRateLimit({ limit: 1200, windowMs: 60_000 });
  const listModels = createModelCatalog({ baseUrl: openaiBaseUrl, apiKey: openaiApiKey, fetchImpl, allowed });
  function allowRead(req) {
    return readLimit.take(clientKey(req)).ok && readBudget.take("all").ok;
  }
  return createServer(async (req, res) => {
    let path;
    try { path = requestPath(req.url || "/"); } catch { json(res, 400, { error: "invalid path" }); return; }
    logRequest(log, req, res, path);
    const host = (req.headers.host || "").split(":")[0]?.toLowerCase() || "";
    // Set once, so every path below inherits them: static files, JSON, the
    // redirect, the metrics text and the chat event stream.
    for (const [name, value] of Object.entries(
      securityHeaders({ https: originalScheme(req) === "https" }),
    ))
      res.setHeader(name, value);
    // A page on another origin can make a visitor's browser POST here without
    // ever reading the reply. Refuse before a body is read or a quota charged.
    if (req.method === "POST" && !postAllowed(req)) {
      logRefused(log, req, path, "cross-origin");
      json(res, 403, { error: "cross-origin request refused" });
      return;
    }
    // Counted before the redirect, not after: this series exists to make the
    // "what scheme did the visitor really arrive on" assumption observable,
    // and redirected http requests are exactly the half worth seeing.
    if (req.method === "GET" || req.method === "HEAD") metrics.request(originalScheme(req));
    const secureUrl = httpsRedirect(req);
    if (secureUrl) {
      res.writeHead(308, { location: secureUrl });
      res.end();
      return;
    }
    try {
      if (path === "/api/chat/models" && req.method === "GET") {
        if (!allowRead(req)) {
          logRefused(log, req, path, "read-limit");
          res.setHeader("retry-after", "60");
          json(res, 429, { error: "Too many requests. Try again shortly." });
          return;
        }
        try { json(res, 200, { models: await listModels(), defaultModel: openaiModel }); }
        catch (err) {
          logUpstream(log, "llm-models", err);
          json(res, 503, { error: "Models unavailable. Try again shortly." });
        }
        return;
      }
      if (path === "/api/telemetry" && req.method === "POST") {
        if (!telemetryLimit.take(clientKey(req)).ok || !telemetryBudget.take("all").ok) {
          logRefused(log, req, path, "telemetry-limit");
          res.setHeader("retry-after", "60");
          json(res, 429, { error: "Too many events." });
          return;
        }
        let body;
        try {
          body = await readJson(req);
        } catch (err) {
          json(res, err.status || 400, { error: "invalid json" });
          return;
        }
        if (!metrics.ingest(body)) {
          json(res, 400, { error: "invalid telemetry" });
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }
      if (["/api/relay", "/api/launch"].includes(path) && req.method === "POST") {
        let body;
        try {
          body = await readJson(req);
        } catch (err) {
          json(res, err.status || 400, { error: "invalid json" });
          return;
        }
        const kind = path === "/api/launch" ? "launch" : "relay";
        try {
          const sent = await (kind === "launch" ? beacon.sendLaunch : beacon.send)(body, {
            client: { ...describeClient(req), key: clientKey(req) },
          });
          metrics.beaconSent(kind, true);
          logBeacon(log, req, { kind, outcome: "sent", visitor: typeof body.visitor === "string" ? body.visitor : "", relayId: typeof body.relayId === "string" ? body.relayId : "" });
          json(res, 200, sent);
        } catch (err) {
          // Rate-limited attempts never reached the relay, so they are not a
          // delivery failure; anything else is.
          if (err.status !== 429 && err.status !== 400) metrics.beaconSent(kind, false);
          logBeacon(log, req, { kind, outcome: err.status === 429 ? "cooling-down" : err.status === 400 ? "rejected" : "failed", status: err.status || 503, visitor: typeof body.visitor === "string" ? body.visitor : "", relayId: typeof body.relayId === "string" ? body.relayId : "" });
          if (err.status !== 429 && err.status !== 400) logUpstream(log, "waha", err);
          json(res, err.status || 503, { error: err.status === 429 ? "The relay is cooling down." : err.status === 400 ? "Unknown relay." : "Relay dark." });
        }
        return;
      }
      if (path === "/api/chat" && req.method === "POST") {
        const callerKey = clientKey(req);
        if (!chatAttempts.take(callerKey).ok || chatConcurrency.full(callerKey)) {
          logRefused(log, req, path, "chat-busy");
          res.setHeader("retry-after", "60");
          json(res, 429, { error: "Chat is busy. Try again shortly.", code: "rate_limited" });
          return;
        }
        let body;
        try {
          body = await readJson(req);
        } catch (err) {
          json(res, err.status || 400, { error: "invalid json" });
          return;
        }
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) {
          json(res, 400, { error: "prompt required" });
          return;
        }
        const caller = chatLimit.take(callerKey);
        const budget = caller.ok ? chatBudget.take("all") : caller;
        if (!budget.ok) {
          if (caller.ok) caller.refund?.();
          metrics.chatThrottled();
          logRefused(log, req, path, "chat-quota");
          res.setHeader("retry-after", String(budget.retryAfter));
          json(res, 429, {
            error: "The orbit assistant is resting. Try again shortly.",
            code: "rate_limited",
            retryAfter: budget.retryAfter,
          });
          return;
        }
        let release = null;
        // Enough to reconstruct the conversation in the logs: what was asked,
        // which orbit it was scoped to, which model answered, and what came
        // back. Streamed replies are accumulated as they go.
        const asked = process.hrtime.bigint();
        let answer = "";
        let chosen = openaiModel;
        const done = (outcome, extra = {}) =>
          logChat(log, req, {
            outcome,
            bodyId: typeof body.bodyId === "string" ? body.bodyId : "",
            model: chosen,
            streamed: Boolean(req.headers.accept?.includes("text/event-stream")),
            duration_ms: Math.round(Number(process.hrtime.bigint() - asked) / 1e3) / 1e3,
            visitor: typeof body.visitor === "string" ? body.visitor : "",
            prompt,
            reply: answer,
            ...extra,
          });
        try {
          const catalog = JSON.parse(
            await readFile(join(root, "data/projects.json"), "utf8"),
          );
          const grounding = chatGrounding(catalog, body.bodyId);
          let model = openaiModel;
          if (body.model !== undefined && body.model !== "") {
            if (typeof body.model !== "string" || !(await listModels()).some(m => m.id === body.model)) {
              // Nothing was spent, so nothing should stay charged.
              done("model_unavailable", { model: String(body.model).slice(0, 80) });
              json(res, 400, { error: "That model is unavailable. Choose another model.", code: "model_unavailable" });
              return;
            }
            model = body.model;
            chosen = model;
          }
          const controller = new AbortController();
          res.on("close", () => controller.abort());
          const options = {
            baseUrl: openaiBaseUrl, apiKey: openaiApiKey, model,
            messages: chatMessages(chatSystemPrompt(grounding), body.history, prompt),
            fetchImpl, signal: controller.signal,
          };
          if (!openaiBaseUrl || !openaiApiKey) throw Object.assign(new Error("Chat unconfigured"), { status: 503 });
          release = chatConcurrency.enter(callerKey);
          if (!release) throw Object.assign(new Error("Chat is busy"), { status: 429 });
          metrics.chatStarted();
          if (req.headers.accept?.includes("text/event-stream")) {
            for await (const text of streamChat(options)) {
              if (res.destroyed) break;
              if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
              answer += text;
              res.write(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`);
            }
            if (!res.destroyed) res.end('event: done\ndata: {}\n\n');
            done(res.destroyed ? "abandoned" : "ok");
          } else {
            const reply = await completeChat(options);
            answer = reply.content;
            if (!res.destroyed) json(res, 200, reply);
            done(res.destroyed ? "abandoned" : "ok");
          }
        } catch (err) {
          // A visitor who closes the panel mid-answer aborts the upstream
          // request on purpose. That is not the assistant failing, and
          // counting it as one would make the error rate a measure of how
          // often people stop reading.
          const abandoned = res.destroyed;
          if (!abandoned) {
            metrics.chatFail();
            logUpstream(log, "llm", err);
          }
          done(abandoned ? "abandoned" : "error", abandoned ? {} : { status: err.status || 502, error: String(err.message).slice(0, 200) });
          if (!res.destroyed) {
            if (res.headersSent) res.end('event: error\ndata: {"error":"Chat unavailable."}\n\n');
            else json(res, err.status || 502, { error: "Chat unavailable. Try again shortly." });
          }
        } finally {
          if (release) release();
          else {
            // Nothing was dispatched, so nothing should stay charged.
            caller.refund?.();
            budget.refund?.();
          }
        }
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("allow", "GET, HEAD, POST");
        json(res, 405, { error: "method not allowed" });
        return;
      }
      if (path === "/tip") {
        const addr = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lightningAddress) ? lightningAddress : "";
        const pay = /^https:\/\/[^\s]+$/.test(btcpayUrl) ? btcpayUrl : "";
        const dest = addr ? `lightning:${addr}` : pay;
        if (dest) {
          res.writeHead(302, { location: dest });
          res.end();
          return;
        }
        json(res, 200, {
          message: "Tipping is not configured.",
          lightningAddress: "",
          btcpayUrl: "",
        });
        return;
      }
      if (path === "/api/healthz") {
        json(res, 200, { ok: true });
        return;
      }
      if (path === "/metrics") {
        if (metricsDenied(req)) {
          json(res, 404, { error: "not found" });
          return;
        }
        const body = metrics.render();
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }
      if (path === "/api/tip") {
        json(res, 200, {
          lightningAddress,
          btcpayUrl,
        });
        return;
      }
      if (path === "/api/relay") {
        json(res, 200, { ready: beacon.ready() });
        return;
      }
      if (
        (path.startsWith("/api/insight/") ||
          path === "/api/catalog" ||
          path in bitcoinRoutes) &&
        !allowRead(req)
      ) {
        logRefused(log, req, path, "read-limit");
        res.setHeader("retry-after", "60");
        json(res, 429, { error: "Too many readings. Try again shortly." });
        return;
      }
      if (path.startsWith("/api/insight/")) {
        const feed = { "/api/insight/site": insight.site, "/api/insight/lab": insight.lab, "/api/insight/scout": insight.scout, "/api/insight/nodes": insight.nodes, "/api/insight/watch": insight.watch }[path];
        if (!feed) {
          json(res, 404, { error: "not found" });
          return;
        }
        try {
          json(res, 200, await feed());
        } catch (err) {
          json(res, err.status === 503 ? 503 : 502, { error: "Readings unavailable." });
        }
        return;
      }
      if (path === "/api/catalog") {
        const data = JSON.parse(
          await readFile(join(root, "data/projects.json"), "utf8"),
        );
        json(res, 200, data);
        return;
      }
      if (path in bitcoinRoutes) {
        if (bitcoinRoutes[path].insight) {
          try {
            json(res, 200, await insight[bitcoinRoutes[path].insight]());
          } catch (err) {
            json(res, err.status === 503 ? 503 : 502, { error: "Readings unavailable." });
          }
          return;
        }
        if (!mempoolBase) {
          json(res, 503, { error: "Readings unavailable." });
          return;
        }
        const proxied = await bitcoinCache(path, () => proxyBitcoin(path, mempoolBase.replace(/\/$/, "")));
        json(res, proxied.status, proxied.data);
        return;
      }
      if (path.startsWith("/api/")) {
        json(res, 404, { error: "not found" });
        return;
      }
      let decoded;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        json(res, 400, { error: "invalid path" });
        return;
      }
      const asset = await staticFile(decoded);
      if (!asset) {
        json(res, 404, { error: "not found" });
        return;
      }
      let body = await readFile(asset.file);
      const headers = {
        "content-type": asset.type,
        "x-content-type-options": "nosniff",
        "cache-control": path.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        vary: "Accept-Encoding",
      };
      if (
        (req.headers["accept-encoding"] || "").split(",").some(part => { const [encoding, quality = "q=1"] = part.trim().split(";"); return encoding === "gzip" && Number(quality.trim().replace("q=", "")) > 0; }) &&
        /\.(js|css|html|svg)$/.test(asset.file)
      ) {
        const cached = compressedAssets.get(asset.file);
        if (cached && cached.modified === asset.modified) body = cached.body;
        else {
          body = await compress(body);
          compressedAssets.set(asset.file, { modified: asset.modified, body });
        }
        headers["content-encoding"] = "gzip";
      }
      headers["content-length"] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (err) {
      json(res, 502, { error: "upstream unavailable" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const log = createLogger();
  // One line at boot saying what this process can actually reach. Names only,
  // never a credential: "waha: false" after a deploy is the fastest way to see
  // that a secret did not make it into the pod.
  log.info(
    {
      event: "start",
      port,
      model: process.env.OPENAI_MODEL || "grok-4.6",
      configured: {
        mempool: Boolean(mempool),
        llm: Boolean(process.env.OPENAI_API_KEY),
        waha: Boolean(process.env.WAHA_BASE_URL && process.env.WAHA_API_KEY && process.env.WAHA_BEACON_CHAT_ID),
        mimir: Boolean(process.env.MIMIR_URL),
        scout: Boolean(process.env.JOB_SCOUT_URL),
        tip: Boolean(process.env.LIGHTNING_ADDRESS || process.env.BTCPAY_URL),
      },
      trustedProxies: process.env.TRUSTED_PROXY_CIDRS || "",
    },
    "orrery listening",
  );
  const server = createApp({ log });
  // Envoy is in front, but this listener should still not keep a connection
  // for a request that never finishes arriving. Bodies here are at most 12KB.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.listen(port, process.env.HOST || "0.0.0.0");
}

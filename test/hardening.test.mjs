import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server.mjs";
import { clientAddress, clientKey, isIpAddress, isTrustedPeer } from "../src/client.mjs";
import { postAllowed } from "../src/origin.mjs";
import { createInsight, SITE_QUERIES } from "../src/insight.mjs";
import { readBounded, createReadCache } from "../src/upstream.mjs";
import { createRateLimit } from "../src/limits.mjs";
import { createBeacon } from "../src/beacon.mjs";
import { streamChat } from "../src/chat.mjs";

process.env.TRUSTED_PROXY_CIDRS = "127.0.0.1/32,10.77.0.0/16";
process.env.TRUSTED_EDGE_CIDRS = "10.77.0.0/16";

test("origin checks include protocol, port and exact host; JSON MIME is mandatory", () => {
  const req = origin => ({ headers: { host: "giovanni.dev.br", origin, "x-forwarded-proto": "https", "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" } });
  assert.equal(postAllowed(req("https://giovanni.dev.br")), true);
  for (const origin of ["http://giovanni.dev.br", "https://giovanni.dev.br:444", "https://www.giovanni.dev.br", "null", "https://giovanni.dev.br/path"]) assert.equal(postAllowed(req(origin)), false, origin);
  const absent = req("https://giovanni.dev.br");
  delete absent.headers["content-type"];
  assert.equal(postAllowed(absent), false);
});

test("untrusted private peers and malformed IPs cannot supply a caller key", () => {
  for (const ip of ["a:b", "1:2", ":::1", "999.1.1.1", "01.2.3.4"]) assert.equal(isIpAddress(ip), false, ip);
  const direct = ip => ({ socket: { remoteAddress: "192.168.1.8" }, headers: { "cf-connecting-ip": ip } });
  assert.equal(isTrustedPeer(direct("203.0.113.1")), false);
  assert.equal(clientKey(direct("203.0.113.1")), clientKey(direct("203.0.113.2")));
  assert.equal(isTrustedPeer({ headers: {} }), false);
  const lan = { socket: { remoteAddress: "10.77.0.9" }, headers: { "cf-connecting-ip": "203.0.113.1", "x-envoy-external-address": "10.77.0.10", "x-forwarded-for": "203.0.113.1,192.168.1.8" } };
  assert.equal(clientAddress(lan), "192.168.1.8");
  lan.headers["x-forwarded-for"] = "203.0.113.1,10.77.0.10";
  assert.equal(clientAddress(lan), "203.0.113.1");
});

test("a cold insight burst coalesces into one query set and failures back off", async () => {
  let calls = 0;
  const insight = createInsight({ mimirUrl: "http://fixture.invalid", fetchImpl: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return Response.json({ status: "success", data: { result: [] } }); } });
  await Promise.all(Array.from({ length: 5 }, () => insight.site()));
  assert.equal(calls, Object.keys(SITE_QUERIES).length + 2);
  await insight.site();
  assert.equal(calls, 17);
  let at = 0, failures = 0;
  const cache = createReadCache({ now: () => at });
  const fail = () => { failures++; throw new Error("offline"); };
  await assert.rejects(cache("fixed-key", fail));
  await assert.rejects(cache("fixed-key", fail));
  assert.equal(failures, 1);
  at = 2001;
  assert.equal(await cache("fixed-key", () => 7), 7);
});

test("upstream size rejection cancels the stream", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65)); }, cancel() { cancelled = true; } }));
  await assert.rejects(readBounded(response, 64), /too large/);
  assert.equal(cancelled, true);
});

test("refunds remove their own reservation even when another call completed later", () => {
  let at = 0;
  const limit = createRateLimit({ limit: 1, windowMs: 100, now: () => at });
  const old = limit.take("caller");
  at = 101;
  assert.equal(limit.take("caller").ok, true);
  old.refund();
  assert.equal(limit.take("caller").ok, false);
});

test("inherited relay properties never reach WAHA", async () => {
  let calls = 0;
  const beacon = createBeacon({ baseUrl: "http://fixture.invalid", apiKey: "dummy", chatId: "dummy", fetchImpl: async () => { calls++; return Response.json({}); } });
  for (const relayId of ["constructor", "__proto__", "toString"]) await assert.rejects(beacon.send({ visitor: "fixture1234", relayId }), { status: 400 });
  assert.equal(calls, 0);
});

test("invalid orbit and model do not exhaust completion budget; telemetry cannot forge chats", async () => {
  let completions = 0;
  const app = createApp({ openaiBaseUrl: "http://chat.test/v1", openaiApiKey: "dummy", chatLimit: createRateLimit({ limit: 1, windowMs: 60_000 }), chatBudget: createRateLimit({ limit: 1, windowMs: 60_000 }), fetchImpl: async url => {
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "grok-4.6" }] });
    completions++; return Response.json({ choices: [{ message: { content: "Fixture reply" } }] });
  } }).listen(0, "127.0.0.1");
  await once(app, "listening");
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/api/chat", { prompt: "Hi", bodyId: "missing" })).status, 400);
    assert.equal((await post("/api/chat", { prompt: "Hi", bodyId: "homelab", model: "not-public" })).status, 400);
    assert.equal((await post("/api/chat", { prompt: "Hi", bodyId: "homelab" })).status, 200);
    assert.equal(completions, 1);
    assert.equal((await post("/api/telemetry", { visitor: "fixture1234", event: "chat" })).status, 400);
    assert.equal((await post("/api/chat", null)).status, 400);
  } finally { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
});

test("chat rejects an endless event before accumulating unbounded memory", async () => {
  let cancelled = false;
  const fetchImpl = async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(64_000))); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(async () => { for await (const text of streamChat({ apiKey: "dummy", baseUrl: "http://fixture.invalid", messages: [], fetchImpl })) void text; }, /too large/);
  assert.equal(cancelled, true);
});

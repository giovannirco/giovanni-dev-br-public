process.env.TRUSTED_PROXY_CIDRS = "127.0.0.1/32,::1/128,10.77.0.0/16";
process.env.TRUSTED_EDGE_CIDRS = "10.77.0.0/16";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createApp } from "../server.mjs";
assert.ok(
  existsSync(new URL("../dist/index.html", import.meta.url)),
  "dist/index.html is missing — run `npm run build` before `npm test`",
);
let upstream,
  app,
  base,
  upstreamBase,
  requests = [];
before(async () => {
  upstream = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");
    const values = {
      "/api/v1/blocks/tip/height": 900123,
      "/api/v1/mempool": { count: 42, vsize: 2500000 },
      "/api/v1/fees/recommended": { fastestFee: 0, halfHourFee: 1, hourFee: 1 },
    };
    if (req.url in values) res.end(JSON.stringify(values[req.url]));
    else {
      res.statusCode = 404;
      res.end('{"error":"not found"}');
    }
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  app = createApp({
    mempoolBase: upstreamBase,
    lightningAddress: "",
    btcpayUrl: "",
  }).listen(0, "127.0.0.1");
  await once(app, "listening");
  base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => {
  await Promise.all(
    [app, upstream].map((s) => new Promise((resolve) => s.close(resolve))),
  );
});
test("health, HTML and compressed assets preserve the production contract", async () => {
  assert.deepEqual(await fetch(`${base}/api/healthz`).then((r) => r.json()), {
    ok: true,
  });
  const html = await fetch(base).then((r) => r.text());
  assert.match(html, /https:\/\/resume.giovanni.dev.br/);
  const asset = html.match(/src="([^\"]+\.js)"/)[1];
  const response = await fetch(`${base}${asset}`, {
    headers: { "accept-encoding": "gzip" },
  });
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.match(response.headers.get("cache-control"), /immutable/);
  assert.ok((await response.text()).length > 0);
});
test("only allowlisted Bitcoin GET endpoints reach mempool, preserving values and units", async () => {
  assert.deepEqual(
    await fetch(`${base}/api/bitcoin/tip?fresh=1`).then((r) => r.json()),
    { height: 900123 },
  );
  assert.deepEqual(
    await fetch(`${base}/api/bitcoin/mempool`).then((r) => r.json()),
    { count: 42, vsize: 2500000 },
  );
  assert.equal(
    (await fetch(`${base}/api/bitcoin/fees`).then((r) => r.json())).fastestFee,
    0,
  );
  const count = requests.length;
  assert.equal((await fetch(`${base}/api/bitcoin/rpc`)).status, 404);
  assert.equal(
    (await fetch(`${base}/api/bitcoin/tip`, { method: "POST", headers: { "content-type": "application/json" } })).status,
    405,
  );
  assert.equal(requests.length, count);
});
test("unconfigured tipping is honest; configuration is returned without inventing a destination", async () => {
  assert.deepEqual(await fetch(`${base}/api/tip`).then((r) => r.json()), {
    lightningAddress: "",
    btcpayUrl: "",
  });
  const tip = await fetch(`${base}/tip`);
  assert.equal(tip.status, 200);
  assert.match((await tip.json()).message, /not configured/);
  const configured = createApp({
    lightningAddress: "tips@example.com",
    btcpayUrl: "",
  }).listen(0, "127.0.0.1");
  await once(configured, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${configured.address().port}/tip`,
      { redirect: "manual" },
    );
    assert.equal(
      response.headers.get("location"),
      "lightning:tips@example.com",
    );
  } finally {
    await new Promise((resolve) => configured.close(resolve));
  }
});
test("relay is dark when unconfigured and never names the transport", async () => {
  const ready = await fetch(`${base}/api/relay`).then((r) => r.json());
  assert.deepEqual(ready, { ready: false });
  const dark = await fetch(`${base}/api/relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visitor: "anonabcdefgh", relayId: "heliograph" }),
  });
  assert.equal(dark.status, 503);
  const msg = await dark.json();
  assert.match(msg.error, /Relay dark/);
  assert.doesNotMatch(JSON.stringify(msg), /waha|whatsapp/i);
  const live = createApp({
    beacon: {
      ready: () => true,
      send: async (body) => {
        assert.equal(body.relayId, "umbra");
        return { ok: true };
      },
    },
  }).listen(0, "127.0.0.1");
  await once(live, "listening");
  try {
    const port = live.address().port;
    assert.deepEqual(
      await fetch(`http://127.0.0.1:${port}/api/relay`).then((r) => r.json()),
      { ready: true },
    );
    const ping = await fetch(`http://127.0.0.1:${port}/api/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        visitor: "anonabcdefgh",
        relayId: "umbra",
        name: "Ana",
      }),
    });
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), { ok: true });
  } finally {
    await new Promise((resolve) => live.close(resolve));
  }
});
test("encoded traversal and malformed paths cannot read outside dist", async () => {
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/%ZZ`)).status, 400);
});


test("launch endpoint uses server connection details and returns only delivery status", async () => {
  const live = createApp({ beacon: { sendLaunch: async (body, context) => {
    assert.equal(body.visitor, "anonabcdefgh");
    assert.equal(context.client.address, "203.0.113.7");
    assert.equal(context.client.country, "BR");
    assert.equal(context.client.userAgent, "browser-test");
    return { ok: true };
  } } }).listen(0, "127.0.0.1");
  await once(live, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${live.address().port}/api/launch`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7,10.77.0.118", "x-envoy-external-address": "10.77.0.118", "cf-connecting-ip": "203.0.113.7", "cf-ipcountry": "BR", "user-agent": "browser-test" },
      body: JSON.stringify({ visitor: "anonabcdefgh", client: { address: "forged" } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally { await new Promise(resolve => live.close(resolve)); }
});

test("unconfigured integrations stay offline without making upstream requests", async () => {
  let calls = 0;
  const offline = createApp({
    mempoolBase: "",
    openaiBaseUrl: "",
    openaiApiKey: "fixture-key",
    fetchImpl: async () => { calls++; throw new Error("Unexpected upstream call"); },
  }).listen(0, "127.0.0.1");
  await once(offline, "listening");
  const url = `http://127.0.0.1:${offline.address().port}`;
  try {
    for (const path of ["/api/bitcoin/tip", "/api/chat/models"]) {
      assert.equal((await fetch(url + path)).status, 503);
    }
    const chat = await fetch(url + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "What is this project?", bodyId: "homelab" }),
    });
    assert.equal(chat.status, 503);
    assert.equal(calls, 0);
    assert.equal((await fetch(url + "/api/healthz")).status, 200);
  } finally {
    await new Promise(resolve => offline.close(resolve));
  }
});

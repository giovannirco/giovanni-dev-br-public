process.env.TRUSTED_PROXY_CIDRS = "127.0.0.1/32,::1/128,10.77.0.0/16";
process.env.TRUSTED_EDGE_CIDRS = "10.77.0.0/16";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server.mjs";
import { createBeacon } from "../src/beacon.mjs";
import { createConcurrency } from "../src/limits.mjs";
import { clientAddress, clientKey, isIpAddress, isTrustedPeer } from "../src/client.mjs";
import { metricsDenied } from "../src/metrics.mjs";
import { postAllowed, sameOrigin } from "../src/origin.mjs";
import { securityHeaders } from "../src/headers.mjs";

let app, base, sends;

before(async () => {
  sends = [];
  const relay = async (url, options) => {
    sends.push({ url, body: JSON.parse(options.body || "{}") });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  app = createApp({
    beacon: createBeacon({ baseUrl: "http://relay.invalid", apiKey: "k", chatId: "c", fetchImpl: relay }),
    fetchImpl: relay,
  }).listen(0, "127.0.0.1");
  await once(app, "listening");
  base = `http://127.0.0.1:${app.address().port}`;
});

after(async () => {
  await new Promise((resolve) => app.close(resolve));
});

function post(path, headers = {}, body = { visitor: "securitytest1" }) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("a page on another origin cannot drive a visitor's browser into the relay", async () => {
  const origin = { origin: "https://evil.example" };
  const site = { "sec-fetch-site": "cross-site" };
  const plain = { "content-type": "text/plain;charset=UTF-8" };
  for (const headers of [origin, site, plain, { ...origin, ...plain }]) {
    for (const path of ["/api/launch", "/api/relay", "/api/chat", "/api/telemetry"]) {
      const response = await post(path, headers, { visitor: "securitytest1", relayId: "heliograph", prompt: "hi", event: "play" });
      assert.equal(response.status, 403, `${path} accepted ${JSON.stringify(headers)}`);
    }
  }
  assert.deepEqual(sends, [], "a refused request must not reach WAHA");
});

test("the site's own posts, and non-browser callers, are still served", async () => {
  const launched = await post("/api/launch", {
    origin: base,
    "sec-fetch-site": "same-origin",
  });
  assert.equal(launched.status, 200);
  assert.equal(sends.length, 1);
  assert.match(sends[0].body.text, /orrery launch/);
  // No Origin and no Sec-Fetch headers: curl, a probe, an in-cluster call.
  const bare = await fetch(`${base}/api/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visitor: "securitytest1", event: "play" }),
  });
  assert.equal(bare.status, 204);
  assert.ok(!sameOrigin({ headers: { host: "giovanni.dev.br", origin: "https://www.giovanni.dev.br" } }));
  assert.ok(!postAllowed({ headers: { origin: "https://giovanni.dev.br.evil.test" } }));
});

test("forwarding headers only count from a hop that could have set them", () => {
  const headers = { "x-forwarded-for": "203.0.113.41,10.77.0.120", "x-envoy-external-address": "10.77.0.120", "cf-connecting-ip": "203.0.113.41" };
  const throughIngress = { headers, socket: { remoteAddress: "10.77.0.118" } };
  const direct = { headers, socket: { remoteAddress: "203.0.113.200" } };
  assert.equal(clientAddress(throughIngress), "203.0.113.41");
  assert.equal(clientAddress(direct), "203.0.113.200");
  // Rotating the header no longer rotates the rate-limit bucket.
  const other = { headers: { "cf-connecting-ip": "203.0.113.42" }, socket: { remoteAddress: "203.0.113.200" } };
  assert.equal(clientKey(direct), clientKey(other));
  assert.ok(isTrustedPeer(throughIngress));
  assert.ok(!isTrustedPeer(direct));
});

test("only real addresses are read out of a forwarding header", () => {
  const req = {
    headers: { "cf-connecting-ip": "Gio owes me a beer\nRelay: fake" },
    socket: { remoteAddress: "10.77.0.118" },
  };
  assert.equal(clientAddress(req), "10.77.0.118");
  assert.ok(isIpAddress("203.0.113.7"));
  assert.ok(isIpAddress("2001:db8::1"));
  assert.ok(!isIpAddress("203.0.113.999"));
  assert.ok(!isIpAddress("not an address"));
});

test("every response carries the browser policy, and HSTS only over https", async () => {
  const page = await fetch(base);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(page.headers.get("strict-transport-security"), null);
  const api = await fetch(`${base}/api/healthz`);
  assert.match(api.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(api.headers.get("content-type"), "application/json; charset=utf-8");
  assert.ok(!securityHeaders({ https: false })["strict-transport-security"]);
  assert.match(securityHeaders({ https: true })["strict-transport-security"], /max-age=31536000/);
});

test("a link out of dist is not a way to read the filesystem", async () => {
  const outside = join(await mkdtemp(join(tmpdir(), "orrery-")), "secret.txt");
  await writeFile(outside, "not for the internet");
  const planted = fileURLToPath(new URL("../dist/planted.txt", import.meta.url));
  await symlink(outside, planted);
  try {
    const response = await fetch(`${base}/planted.txt`);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /not for the internet/);
  } finally {
    await unlink(planted);
  }
});

test("public readings have a ceiling that ordinary browsing never meets", async () => {
  const limited = createApp({ readLimit: { take: () => ({ ok: false, retryAfter: 60 }), refund() {} } }).listen(0, "127.0.0.1");
  await once(limited, "listening");
  const at = `http://127.0.0.1:${limited.address().port}`;
  const response = await fetch(`${at}/api/catalog`);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  // The page itself and health checks are never throttled.
  assert.equal((await fetch(`${at}/api/healthz`)).status, 200);
  assert.equal((await fetch(at)).status, 200);
  await new Promise((resolve) => limited.close(resolve));
});

test("metrics stay closed to anything that did not connect from the cluster", () => {
  assert.ok(metricsDenied({ headers: {}, socket: { remoteAddress: "203.0.113.9" } }));
  assert.ok(metricsDenied({ headers: { host: "giovanni.dev.br" }, socket: { remoteAddress: "10.77.0.5" } }));
  assert.ok(!metricsDenied({ headers: { host: "10.77.0.4:8080" }, socket: { remoteAddress: "10.77.0.5" } }));
});

test("chat concurrency is per caller as well as overall", async () => {
  // A rate limit does not stop four visitors each holding a 45-second stream,
  // and one global number lets a single visitor hold all of them.
  const open = [];
  const upstream = async () =>
    new Promise((resolve) => open.push(() => resolve(new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ))));
  const chat = createApp({ openaiBaseUrl: "http://chat.test/v1", openaiApiKey: "key", fetchImpl: upstream }).listen(0, "127.0.0.1");
  await once(chat, "listening");
  const at = `http://127.0.0.1:${chat.address().port}`;
  const ask = (address) => fetch(`${at}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(address ? { "x-forwarded-for": address } : {}) },
    body: JSON.stringify({ prompt: "What does Gio do?", bodyId: "resume" }),
  });
  try {
    const held = [ask(), ask(), ask(), ask()];
    while (open.length < 4) await new Promise((r) => setTimeout(r, 10));
    // A fifth from the same caller waits its turn; another visitor does not.
    assert.equal((await ask()).status, 429);
    const other = ask("203.0.113.77");
    while (open.length < 5) await new Promise((r) => setTimeout(r, 10));
    for (const finish of open.splice(0)) finish();
    for (const response of await Promise.all([...held, other]))
      assert.equal(response.status, 200);
    // And the caller can start again once its own are done.
    const again = ask();
    while (!open.length) await new Promise((r) => setTimeout(r, 10));
    open.splice(0).forEach((finish) => finish());
    assert.equal((await again).status, 200);
  } finally {
    await new Promise((resolve) => chat.close(resolve));
  }
});

test("one caller cannot hold every completion slot", () => {
  const slots = createConcurrency({ limit: 3, perKey: 2 });
  const mine = [slots.enter("a"), slots.enter("a")];
  assert.ok(mine.every(Boolean));
  assert.equal(slots.enter("a"), null, "a caller stops at its own share");
  assert.ok(slots.enter("b"), "another caller still gets in");
  assert.equal(slots.enter("c"), null, "the total is still a ceiling");
  mine[0]();
  mine[0]();
  assert.equal(slots.active(), 2, "releasing twice frees one slot, not two");
  assert.ok(slots.enter("c"));
});

test("the scheme a visitor really arrived on is counted, redirect or not", async () => {
  const counted = createApp().listen(0, "127.0.0.1");
  await once(counted, "listening");
  const port = counted.address().port;
  const send = (headers) => new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: "/", method: "GET", headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  try {
    // The tunnel hop has to look like the tunnel, or cf-visitor is ignored.
    assert.equal(await send({
      host: "giovanni.dev.br",
      "x-forwarded-for": "203.0.113.7,10.77.0.118",
      "cf-ray": "a",
      "cf-visitor": '{"scheme":"http"}',
    }), 308);
    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text());
    assert.match(metrics, /orrery_requests_by_scheme_total\{scheme="http"\} 1/);
  } finally {
    await new Promise((resolve) => counted.close(resolve));
  }
});

test("a tip destination is only followed when it looks like one", async () => {
  const bad = createApp({ lightningAddress: "javascript:alert(1)", btcpayUrl: "http://pay.invalid" }).listen(0, "127.0.0.1");
  await once(bad, "listening");
  const good = createApp({ lightningAddress: "gio@example.com", btcpayUrl: "" }).listen(0, "127.0.0.1");
  await once(good, "listening");
  try {
    const refused = await fetch(`http://127.0.0.1:${bad.address().port}/tip`, { redirect: "manual" });
    assert.equal(refused.status, 200);
    assert.match((await refused.json()).message, /not configured/);
    const followed = await fetch(`http://127.0.0.1:${good.address().port}/tip`, { redirect: "manual" });
    assert.equal(followed.status, 302);
    assert.equal(followed.headers.get("location"), "lightning:gio@example.com");
  } finally {
    await Promise.all([bad, good].map((s) => new Promise((resolve) => s.close(resolve))));
  }
});

test("API answers are never stored by anything in between", async () => {
  const response = await fetch(`${base}/api/healthz`);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

// Where the readings come from is deployment configuration, not public
// information. The code is published; the addresses behind it are not. This
// suite drives the server with configuration shaped like the real thing and
// asserts that none of it — hostname, port, tenant, credential or upstream
// error text — is reachable from outside, on the success path or the failure
// path. A new integration that forwards an upstream message verbatim, or a
// panel that starts printing a machine name, fails here before it ships.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { once } from "node:events";
import { createApp } from "../server.mjs";
import { createInsight } from "../src/insight.mjs";
import { createBeacon } from "../src/beacon.mjs";

// Deliberately internal-looking: private DNS, cluster service names, a LAN
// address, a tenant header value and a credential.
const PRIVATE = {
  mempool: "http://mempool.private.invalid:8999",
  openai: "http://gateway.private.invalid:8317/v1",
  openaiKey: "sk-private-gateway-key",
  mimir: "http://metrics-gateway.observability.svc.cluster.local",
  tenant: "house-tenant",
  scout: "http://desk.private.invalid:8080",
  waha: "http://10.77.0.9:3000",
  wahaKey: "waha-private-key",
  chat: "5511999999999@c.us",
};
const SECRETS = Object.values(PRIVATE);

// True regardless of what is configured: nothing public should ever carry a
// private address, an in-cluster service name or a real machine name.
const NEVER = [
  /\bsvc\.cluster\.local\b/,
  /\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
  /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
  /\bk8s-prod-\d/,
  /\bworker-\d/,
  /\bcddlabs\b/,
  // Provenance pointers into private repositories were served by /api/catalog.
  /\bcareer-ops\b/,
  /\bself-improvement\b/,
];

// Every upstream fails, and fails the way a real one does: with the address in
// the message. That is the text most likely to be forwarded by accident.
function exploding(label) {
  return async (url) => {
    throw new Error(`connect ECONNREFUSED ${url} (${label})`);
  };
}

let app, base;
before(async () => {
  app = createApp({
    mempoolBase: PRIVATE.mempool,
    openaiBaseUrl: PRIVATE.openai,
    openaiApiKey: PRIVATE.openaiKey,
    lightningAddress: "",
    btcpayUrl: "",
    fetchImpl: exploding("mempool"),
    insight: createInsight({
      mimirUrl: PRIVATE.mimir,
      mimirTenant: PRIVATE.tenant,
      scoutUrl: PRIVATE.scout,
      fetchImpl: exploding("metrics"),
    }),
    beacon: createBeacon({
      baseUrl: PRIVATE.waha,
      apiKey: PRIVATE.wahaKey,
      chatId: PRIVATE.chat,
      fetchImpl: exploding("waha"),
    }),
  }).listen(0, "127.0.0.1");
  await once(app, "listening");
  base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => {
  await new Promise((resolve) => app.close(resolve));
});

const PUBLIC_PATHS = [
  "/",
  "/api/healthz",
  "/api/catalog",
  "/api/tip",
  "/api/relay",
  "/api/chat/models",
  "/api/insight/site",
  "/api/insight/lab",
  "/api/insight/nodes",
  "/api/insight/scout",
  "/api/insight/watch",
  "/api/insight/nowhere",
  "/api/bitcoin/tip",
  "/api/bitcoin/fees",
  "/api/bitcoin/mempool",
  "/api/bitcoin/price",
  "/api/nowhere",
];

test("no public response discloses where a reading comes from", async () => {
  for (const path of PUBLIC_PATHS) {
    const response = await fetch(`${base}${path}`);
    const body = await response.text();
    // Headers travel with the body and are just as public.
    const text = `${body}\n${[...response.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}`;
    for (const secret of SECRETS)
      assert.ok(
        !text.includes(secret),
        `${path} disclosed configured value ${secret}`,
      );
    for (const pattern of NEVER)
      assert.ok(
        !pattern.test(text),
        `${path} disclosed private infrastructure matching ${pattern}`,
      );
  }
});

test("a failing upstream reports that it failed, not who it is", async () => {
  for (const path of ["/api/insight/site", "/api/insight/nodes", "/api/insight/watch", "/api/bitcoin/tip"]) {
    const response = await fetch(`${base}${path}`);
    assert.ok(response.status >= 500, `${path} should surface the failure`);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["error"], `${path} answered with more than a message`);
    assert.doesNotMatch(body.error, /ECONNREFUSED|http:|invalid/i);
  }
});

test("a relayed message never confirms the destination it was sent to", async () => {
  const response = await fetch(`${base}/api/relay`);
  const body = await response.json();
  // Configured or not is public; the endpoint, session and recipient are not.
  assert.deepEqual(Object.keys(body), ["ready"]);
  assert.equal(typeof body.ready, "boolean");
});

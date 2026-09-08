process.env.TRUSTED_PROXY_CIDRS = "127.0.0.1/32,::1/128,10.77.0.0/16";
process.env.TRUSTED_EDGE_CIDRS = "10.77.0.0/16";
import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimit } from "../src/limits.mjs";
import { clientAddress, clientKey, describeClient, isPrivateAddress } from "../src/client.mjs";

function req(headers = {}, remoteAddress = "10.77.0.9") {
  return { headers, socket: { remoteAddress } };
}

test("the window admits a burst, refuses the rest, and reopens", () => {
  let clock = 0;
  const limit = createRateLimit({ limit: 2, windowMs: 1000, now: () => clock });
  assert.equal(limit.take("a").ok, true);
  assert.equal(limit.take("a").ok, true);
  const refused = limit.take("a");
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfter >= 1);
  assert.equal(limit.take("b").ok, true, "keys are independent");
  clock += 1001;
  assert.equal(limit.take("a").ok, true, "window reopens");
});

test("a refund returns the most recent attempt", () => {
  let clock = 0;
  const limit = createRateLimit({ limit: 1, windowMs: 1000, now: () => clock });
  assert.equal(limit.take("a").ok, true);
  assert.equal(limit.take("a").ok, false);
  limit.refund("a");
  assert.equal(limit.take("a").ok, true, "a failed send does not lock out a retry");
});

test("a flood of fresh keys cannot grow the map without bound", () => {
  let clock = 0;
  const limit = createRateLimit({
    limit: 1,
    windowMs: 60_000,
    maxKeys: 64,
    now: () => clock,
  });
  for (let i = 0; i < 5000; i++) limit.take(`visitor-${i}`);
  assert.ok(limit.size() <= 64, `held ${limit.size()} keys`);
});

test("the client address skips the cluster hops Cloudflare's tunnel adds", () => {
  // The real chain in production: Cloudflare records the visitor, then Envoy
  // appends the cloudflared pod. Taking the last hop reported 10.77.0.118 for
  // a phone on mobile data, which is what this walks back from.
  assert.equal(
    clientAddress(req({ "x-forwarded-for": "200.149.158.167,10.77.0.118" })),
    "200.149.158.167",
  );
  assert.equal(
    clientAddress(req({ "x-envoy-external-address": "10.77.0.118", "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4,10.77.0.118" })),
    "203.0.113.9",
    "Cloudflare's own header wins when present",
  );
  assert.equal(
    clientAddress(req({ "x-envoy-external-address": "203.0.113.7" })),
    "203.0.113.7",
  );
  // Several private hops in a row still resolve to the public client.
  assert.equal(
    clientAddress(req({ "x-forwarded-for": "198.51.100.4, 172.16.0.9, 10.77.0.118" })),
    "172.16.0.9",
  );
  // A LAN-only chain has no public address; report the nearest hop so rate
  // limiting still has something to key on.
  assert.equal(
    clientAddress(req({ "x-forwarded-for": "192.168.1.5, 10.77.0.118" })),
    "192.168.1.5",
  );
  assert.equal(clientAddress(req({}, "::ffff:192.0.2.5")), "192.0.2.5");
});

test("private, loopback and carrier-grade NAT ranges are recognised", () => {
  for (const address of [
    "10.77.0.118", "172.16.0.9", "172.31.255.1", "192.168.1.5",
    "127.0.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1",
  ])
    assert.equal(isPrivateAddress(address), true, address);
  for (const address of ["200.149.158.167", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1"])
    assert.equal(isPrivateAddress(address), false, address);
});

test("rate-limit keys are hashed and never echo the address", () => {
  const key = clientKey(req({ "x-envoy-external-address": "203.0.113.7" }));
  assert.match(key, /^[0-9a-f]{24}$/);
  assert.doesNotMatch(key, /203\.0\.113\.7/);
  assert.equal(key, clientKey(req({ "x-envoy-external-address": "203.0.113.7" })));
  assert.notEqual(key, clientKey(req({ "x-envoy-external-address": "203.0.113.8" })));
});

test("client description reads a setup without guessing at unknown agents", () => {
  const phone = describeClient(
    req({
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "accept-language": "pt-BR,pt;q=0.9",
      "x-envoy-external-address": "203.0.113.7",
    }),
  );
  assert.deepEqual(phone, {
    address: "203.0.113.7",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    country: "",
    browser: "Safari",
    system: "iOS",
    device: "phone",
    language: "pt-BR",
  });
  const desktop = describeClient(
    req({
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    }),
  );
  assert.equal(desktop.browser, "Chrome");
  assert.equal(desktop.system, "macOS");
  assert.equal(desktop.device, "desktop");
  const unknown = describeClient(req({ "user-agent": "curl/8.4.0" }));
  assert.equal(unknown.browser, "");
  assert.equal(unknown.system, "");
});

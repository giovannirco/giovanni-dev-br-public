process.env.TRUSTED_PROXY_CIDRS = "127.0.0.1/32,::1/128,10.77.0.0/16";
process.env.TRUSTED_EDGE_CIDRS = "10.77.0.0/16";
import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createApp } from "../server.mjs";
import { httpsRedirect, originalScheme } from "../src/scheme.mjs";

const req = (headers, url = "/") => ({ headers: { "x-forwarded-for": "203.0.113.7,10.77.0.118", "x-envoy-external-address": "10.77.0.118", ...headers }, url, socket: { remoteAddress: "127.0.0.1" } });

test("Cloudflare's own header decides the scheme, not the tunnel hop", () => {
  // Public traffic is Cloudflare -> cloudflared -> Envoy :80, so Envoy can
  // report "http" for a request the browser made over HTTPS. Redirecting on
  // that would loop forever, which is the whole reason cf-visitor wins.
  assert.equal(
    originalScheme(req({ "cf-ray": "a", "cf-visitor": '{"scheme":"https"}', "x-forwarded-proto": "http" })),
    "https",
  );
  assert.equal(originalScheme(req({ "cf-ray": "a", "cf-visitor": '{"scheme":"http"}' })), "http");
  // Through Cloudflare but unreadable: report nothing and serve the request.
  assert.equal(originalScheme(req({ "cf-ray": "a" })), "");
  assert.equal(originalScheme(req({ "cf-ray": "a", "cf-visitor": "garbage" })), "");
  // Not through Cloudflare: the gateway's own header is correct per listener.
  assert.equal(originalScheme(req({ "x-forwarded-proto": "http" })), "http");
  assert.equal(originalScheme(req({ "x-forwarded-proto": "https, http" })), "https");
  assert.equal(originalScheme(req({})), "");
});

test("no combination of headers can produce a redirect loop", () => {
  const schemes = ["http", "https", "", "garbage"];
  for (const cf of schemes)
    for (const xfp of schemes)
      for (const ray of [true, false])
        for (const host of ["giovanni.dev.br", "www.giovanni.dev.br"]) {
          const headers = { host };
          if (ray) headers["cf-ray"] = "a";
          if (cf) headers["cf-visitor"] = `{"scheme":"${cf}"}`;
          if (xfp) headers["x-forwarded-proto"] = xfp;
          const target = httpsRedirect(req(headers));
          if (!target) continue;
          // Whatever it points at must be somewhere that will not bounce again:
          // https on the canonical host.
          assert.match(target, /^https:\/\/giovanni\.dev\.br\//, JSON.stringify(headers));
          // Feed the destination back in. It must be served, not redirected.
          const settled = { host: "giovanni.dev.br" };
          if (ray) {
            settled["cf-ray"] = "a";
            settled["cf-visitor"] = '{"scheme":"https"}';
          } else settled["x-forwarded-proto"] = "https";
          assert.equal(httpsRedirect(req(settled)), null, `loops from ${JSON.stringify(headers)}`);
        }
});

test("internal and direct traffic is left alone", () => {
  // kubelet probes and Alloy scrapes arrive on the pod IP with no proxy headers.
  assert.equal(httpsRedirect(req({ host: "10.77.0.5:8080" }, "/api/healthz")), null);
  assert.equal(httpsRedirect(req({ host: "giovanni-dev-br.giovanni-dev-br.svc" })), null);
  // A hostname we do not own is never redirected to ours.
  assert.equal(httpsRedirect(req({ host: "example.com", "x-forwarded-proto": "http" })), null);
});

// fetch() forbids overriding the Host header, so drive the socket directly.
function raw(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { "x-forwarded-for": "203.0.113.7,10.77.0.118", "x-envoy-external-address": "10.77.0.118", ...headers } },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode, location: response.headers.location });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("the server sends one 308 to canonical https and keeps the path", async () => {
  const app = createApp().listen(0, "127.0.0.1");
  await once(app, "listening");
  const port = app.address().port;
  try {
    const insecure = await raw(port, "/api/catalog?x=1", {
      host: "giovanni.dev.br",
      "cf-ray": "a",
      "cf-visitor": '{"scheme":"http"}',
    });
    assert.equal(insecure.status, 308);
    assert.equal(insecure.location, "https://giovanni.dev.br/api/catalog?x=1");

    // www over https still folds to the apex in a single hop.
    const www = await raw(port, "/", {
      host: "www.giovanni.dev.br",
      "cf-ray": "a",
      "cf-visitor": '{"scheme":"https"}',
    });
    assert.equal(www.status, 308);
    assert.equal(www.location, "https://giovanni.dev.br/");

    // A settled https request is served.
    const secure = await raw(port, "/api/healthz", {
      host: "giovanni.dev.br",
      "cf-ray": "a",
      "cf-visitor": '{"scheme":"https"}',
    });
    assert.equal(secure.status, 200);

    // A health probe with no proxy headers is served.
    assert.equal((await raw(port, "/api/healthz")).status, 200);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createMetricsProxy } from "../src/metrics-proxy.mjs";

async function start(overrides = {}) {
  const calls = [];
  const proxy = createMetricsProxy({
    upstream: "https://metrics.invalid/",
    tenant: "fixed-tenant",
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return new Response(JSON.stringify({ status: "success", data: { result: [] } }), { status: 200, headers: { "content-type": "application/json", "x-upstream-secret": "leak" } });
    },
    ...overrides,
  }).listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const base = `http://127.0.0.1:${proxy.address().port}`;
  return { base, calls, stop: () => new Promise((resolve) => proxy.close(resolve)) };
}

test("the proxy refuses to start without an upstream", () => {
  assert.throws(() => createMetricsProxy({ upstream: "" }), /upstream/);
});

test("an instant query is forwarded with the proxy's own tenant", async () => {
  const { base, calls, stop } = await start();
  try {
    const response = await fetch(`${base}/prometheus/api/v1/query?query=${encodeURIComponent('up{job="x"}')}`, { headers: { "X-Scope-OrgID": "caller-tenant", authorization: "Bearer caller" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "success");
    assert.equal(response.headers.get("x-upstream-secret"), null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://metrics.invalid/prometheus/api/v1/query?query=${encodeURIComponent('up{job="x"}')}`);
    assert.equal(calls[0].opts.method, "GET");
    assert.equal(calls[0].opts.headers["X-Scope-OrgID"], "fixed-tenant");
    assert.equal(calls[0].opts.headers.authorization, undefined);
  } finally {
    await stop();
  }
});

test("writes, other paths and other parameters never reach the upstream", async () => {
  const { base, calls, stop } = await start();
  try {
    const q = "query=up";
    const refused = [
      ["POST", `/prometheus/api/v1/query?${q}`],
      ["POST", "/api/v1/push"],
      ["GET", "/api/v1/push"],
      ["GET", `/prometheus/api/v1/query_range?${q}`],
      ["GET", `/prometheus/api/v1/query/../admin/tsdb/delete_series?${q}`],
      ["GET", "/prometheus/api/v1/label/__name__/values"],
      ["GET", `/loki/api/v1/query?${q}`],
      ["GET", "/prometheus/api/v1/query"],
      ["GET", `/prometheus/api/v1/query?${q}&time=1`],
      ["GET", `/prometheus/api/v1/query?${q}&query=down`],
      ["GET", `/prometheus/api/v1/query?query=${"x".repeat(4001)}`],
      ["DELETE", `/prometheus/api/v1/query?${q}`],
    ];
    for (const [method, path] of refused) {
      const response = await fetch(`${base}${path}`, { method, body: method === "POST" ? "x" : undefined });
      assert.ok([400, 404].includes(response.status), `${method} ${path.slice(0, 60)} -> ${response.status}`);
    }
    assert.equal(calls.length, 0);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    await stop();
  }
});

test("upstream errors and failures come back without upstream detail", async () => {
  const failing = await start({ fetchImpl: async () => new Response("internal host metrics-0.private:9009 exploded", { status: 500 }) });
  try {
    const response = await fetch(`${failing.base}/prometheus/api/v1/query?query=up`);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /private|9009|exploded/);
  } finally {
    await failing.stop();
  }
  const dead = await start({ fetchImpl: async () => { throw new Error("connect ECONNREFUSED 10.77.0.9:443"); } });
  try {
    const response = await fetch(`${dead.base}/prometheus/api/v1/query?query=up`);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /10\.77|ECONNREFUSED/);
  } finally {
    await dead.stop();
  }
});

test("an oversized upstream answer is refused", async () => {
  const { base, stop } = await start({ maxBytes: 64, fetchImpl: async () => new Response("x".repeat(65), { status: 200 }) });
  try {
    assert.equal((await fetch(`${base}/prometheus/api/v1/query?query=up`)).status, 502);
  } finally {
    await stop();
  }
});

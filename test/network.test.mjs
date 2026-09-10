import assert from "node:assert/strict";
import { test } from "node:test";
import { createInsight, NETWORK_QUERIES } from "../src/insight.mjs";

test("every network query returns a scalar and discards workload labels before deduplicating collectors", () => {
  const rate = /^sum\(max by \(instance\) \(sum by \(job, instance\) \(rate\((hubble_flows_processed_total\[5m\]|hubble_drop_total\[1h\]|tetragon_events_total\[5m\])\)\)\)\)$/;
  const endpoints = /^sum\(max by \(node, enforcement\) \(cilium_policy_endpoint_enforcement_status(?:\{enforcement=~"both\|ingress\|egress"\})?\)\)$/;
  for (const [key, query] of Object.entries(NETWORK_QUERIES)) {
    assert.ok(rate.test(query) || endpoints.test(query), `${key} can return unexpected labels or change the aggregation boundary`);
    assert.doesNotMatch(query, /namespace|pod|workload|binary|source|destination|without/);
  }
  assert.match(NETWORK_QUERIES.enforcedEndpoints, /enforcement=~"both\|ingress\|egress"/);
  assert.doesNotMatch(NETWORK_QUERIES.endpoints, /\{/);
});

function feed(values, calls = []) {
  return createInsight({
    mimirUrl: "https://example.com",
    fetchImpl: async (url) => {
      const query = new URL(url).searchParams.get("query");
      calls.push(query);
      const key = Object.keys(NETWORK_QUERIES).find((key) => NETWORK_QUERIES[key] === query);
      const value = values[key];
      return Response.json({ status: "success", data: { result: value === undefined ? [] : [
        { metric: { namespace: "discard", binary: "discard", destination: "discard" }, value: [1, String(value)] },
      ] } });
    },
  });
}

test("network readings publish only rounded numbers, retain zero, and cache the result", async () => {
  const calls = [];
  const insight = feed({ flowsPerSecond: 2534.1708, dropsPerSecond: 0, eventsPerSecond: 63.5375, enforcedEndpoints: 14, endpoints: 228 }, calls);
  const reading = await insight.network();
  assert.deepEqual(reading, { flowsPerSecond: 2534.2, dropsPerSecond: 0, eventsPerSecond: 63.5, enforcedEndpoints: 14, endpoints: 228, updatedAt: reading.updatedAt });
  assert.equal(await insight.network(), reading);
  assert.equal(calls.length, Object.keys(NETWORK_QUERIES).length);
  assert.doesNotMatch(JSON.stringify(reading), /discard|namespace|binary|destination/);
});

test("a silent observer and invalid readings never become a zero traffic claim", async () => {
  const reading = await feed({ dropsPerSecond: "NaN", eventsPerSecond: -1, enforcedEndpoints: 9, endpoints: 3 }).network();
  assert.equal(reading.flowsPerSecond, null);
  assert.equal(reading.dropsPerSecond, null);
  assert.equal(reading.eventsPerSecond, null);
  assert.equal(reading.enforcedEndpoints, null);
  const empty = await feed({}).network();
  for (const key of Object.keys(NETWORK_QUERIES)) assert.equal(empty[key], null);
});

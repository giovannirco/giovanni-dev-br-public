import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createInsight, BITCOIN_QUERIES } from "../src/insight.mjs";
import { bitcoinNodeRows } from "../src/bitcoin-reading.js";
import { createApp } from "../server.mjs";

function feed(values, calls = []) {
  return createInsight({
    mimirUrl: "https://example.com",
    fetchImpl: async (url) => {
      const query = new URL(url).searchParams.get("query");
      calls.push(query);
      const key = Object.keys(BITCOIN_QUERIES).find((key) => BITCOIN_QUERIES[key] === query);
      const value = values[key];
      return Response.json({ status: "success", data: { result: value === undefined ? [] : [
        { metric: { unexpected: "discard this label" }, value: [1, String(value)] },
      ] } });
    },
  });
}

test("every Bitcoin node query discards labels and collapses duplicate collectors", () => {
  for (const query of Object.values(BITCOIN_QUERIES)) {
    assert.match(query, /^max\(bitcoin_[a-z_]+\)$/);
  }
});

test("node readings pick numeric fields, cache the aggregate and preserve zero", async () => {
  const values = { peers: 0, chainBytes: 874840231616, mempoolTransactions: 0, mempoolBytes: 0, uptimeSeconds: 156257, verification: 1 };
  const calls = [];
  const insight = feed(values, calls);
  const reading = await insight.bitcoin();
  assert.deepEqual(reading, { ...values, updatedAt: reading.updatedAt });
  assert.equal(await insight.bitcoin(), reading);
  assert.equal(calls.length, Object.keys(BITCOIN_QUERIES).length);
  assert.doesNotMatch(JSON.stringify(reading), /unexpected|discard/);
});

test("missing, negative and nonfinite node readings are unknown", async () => {
  const reading = await feed({ peers: -1, chainBytes: "NaN", mempoolBytes: "Infinity", verification: 1.2 }).bitcoin();
  for (const key of Object.keys(BITCOIN_QUERIES)) assert.equal(reading[key], null, key);
  assert.deepEqual(bitcoinNodeRows(reading), [["Node", "Not reporting"]]);
});

test("verification only disappears at one and never rounds an incomplete reading to full sync", () => {
  const base = { peers: 0, chainBytes: 874840231616, mempoolTransactions: 0, mempoolBytes: 0, uptimeSeconds: 156257, verification: 1 };
  const rows = Object.fromEntries(bitcoinNodeRows(base));
  assert.equal(rows.Peers, "0");
  assert.equal(rows["Block files"], "874.8 GB");
  assert.equal(rows["Node mempool"], "0 txs · 0.0 MB");
  assert.equal(rows["Node uptime"], "1d 19h");
  assert.equal(rows.Verification, undefined);
  assert.equal(Object.fromEntries(bitcoinNodeRows({ ...base, verification: 0.999999 })).Verification, "Syncing 99.9%");
  assert.equal(Object.fromEntries(bitcoinNodeRows({ ...base, verification: null })).Verification, "Unknown");
});

test("the allowlisted node route works without a mempool connection", async () => {
  const app = createApp({ mempoolBase: "", insight: feed({ peers: 11 }) }).listen(0);
  await once(app, "listening");
  try {
    const base = new URL("http://localhost");
    base.port = String(app.address().port);
    const response = await fetch(new URL("/api/bitcoin/node", base));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).peers, 11);
    assert.equal((await fetch(new URL("/api/bitcoin/rpc", base))).status, 404);
  } finally { await new Promise((resolve) => app.close(resolve)); }
});

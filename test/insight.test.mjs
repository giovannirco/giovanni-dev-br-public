import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../server.mjs";
import { createInsight, SITE_QUERIES, LAB_QUERIES, NODE_QUERIES, WATCH_QUERIES, SCOUT_QUERIES } from "../src/insight.mjs";

function promResponse(value) {
  return Response.json({
    status: "success",
    data: { resultType: "vector", result: [{ metric: {}, value: [1, String(value)] }] },
  });
}

test("site readings come from PromQL and average flight time is derived honestly", async () => {
  const asked = [];
  const insight = createInsight({
    mimirUrl: "http://mimir.test",
    mimirTenant: "anonymous",
    fetchImpl: async (url, init) => {
      const query = decodeURIComponent(new URL(url).searchParams.get("query"));
      asked.push(query);
      assert.equal(init.headers["X-Scope-OrgID"], "anonymous");
      if (query.includes("orrery_docks_total"))
        return Response.json({
          status: "success",
          data: {
            result: [
              { metric: { body: "homelab" }, value: [1, "7.4"] },
              { metric: { body: "none" }, value: [1, "0"] },
            ],
          },
        });
      if (query.includes("play_starts")) return promResponse(20);
      if (query.includes("heartbeats")) return promResponse(80);
      return promResponse(3);
    },
  });
  const site = await insight.site();
  // 80 heartbeats over 20 flights at 15s a heartbeat is a 60s average.
  assert.equal(site.avgFlightSeconds, 60);
  assert.equal(site.flights, 20);
  assert.deepEqual(site.destinations, [{ body: "homelab", docks: 7 }]);
  assert.ok(asked.length >= Object.keys(SITE_QUERIES).length);
});

test("readings are cached so a busy orbit does not hammer Mimir", async () => {
  let calls = 0;
  let clock = 0;
  const insight = createInsight({
    mimirUrl: "http://mimir.test",
    cacheMs: 30_000,
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      return promResponse(4);
    },
  });
  await insight.lab();
  await insight.lab();
  const first = calls;
  assert.equal(first, Object.keys(LAB_QUERIES).length, "second read was cached");
  clock += 31_000;
  await insight.lab();
  assert.ok(calls > first, "cache expires");
});

test("the Job Scout desk reads only aggregate metrics, never private records", async () => {
  const asked = [];
  const insight = createInsight({
    mimirUrl: "https://metrics.test",
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, "/prometheus/api/v1/query");
      const q = new URL(url).searchParams.get("query");
      asked.push(q);
      return Response.json({ status: "success", data: { result: [{
        metric: { company: "Private company", status: "applied", cluster: "internal-cluster" },
        value: [1, q === SCOUT_QUERIES.tracked ? "251" : "0"],
      }] } });
    },
  });
  const desk = await insight.scout();
  assert.deepEqual(Object.keys(desk).sort(), ["configured", "tracked", "updatedAt"]);
  assert.equal(desk.tracked, 251);
  assert.doesNotMatch(JSON.stringify(desk), /Private|applied|internal-cluster/);
  assert.equal(asked.length, 2);
});

test("failed or absent desk refreshes never publish a stale or invented count", async () => {
  for (const refresh of [1, null]) {
    const insight = createInsight({ mimirUrl: "https://metrics.test", fetchImpl: async (url) => {
      const q = new URL(url).searchParams.get("query");
      return promResponse(q === SCOUT_QUERIES.tracked ? 251 : refresh);
    } });
    assert.equal((await insight.scout()).tracked, null);
  }
  const insight = createInsight({ mimirUrl: "", fetchImpl: async () => { throw new Error("must not call"); } });
  assert.deepEqual(await insight.scout(), { configured: false });
});

test("insight routes stay quiet about upstream detail when they fail", async () => {
  const app = createApp({
    insight: {
      site: async () => {
        throw Object.assign(new Error("mimir says http://metrics.test exploded"), { status: 502 });
      },
      lab: async () => ({ nodes: 4 }),
      scout: async () => ({ configured: false }),
    },
  }).listen(0, "127.0.0.1");
  await once(app, "listening");
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const failed = await fetch(`${base}/api/insight/site`);
    assert.equal(failed.status, 502);
    const body = await failed.text();
    assert.doesNotMatch(body, /mimir|gateway|exploded|svc\.cluster/i);
    assert.equal((await fetch(`${base}/api/insight/nope`)).status, 404);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test("bitcoin extras are trimmed to the fields the panels use", async () => {
  const app = createApp({
    mempoolBase: "http://mempool.test",
    fetchImpl: async () => new Response("{}"),
  }).listen(0, "127.0.0.1");
  await once(app, "listening");
  await new Promise((resolve) => app.close(resolve));
  // The upstream block list is a large array of full blocks; only the tip's
  // height, timestamp and transaction count are published.
  const { default: fs } = await import("node:fs");
  const server = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /"\/api\/bitcoin\/price"/);
  assert.match(server, /"\/api\/bitcoin\/block"/);
  assert.match(server, /pick:/);
});


test("missing and non-finite metrics stay unavailable while zero remains valid", async () => {
  for (const value of [null, undefined, "", "NaN", "Infinity", false, 0]) {
    const insight = createInsight({
      mimirUrl: "http://mimir.test",
      fetchImpl: async () => Response.json({
        status: "success",
        data: { result: value === undefined ? [] : [{ metric: {}, value: [1, value] }] },
      }),
    });
    const lab = await insight.lab();
    for (const key of ["nodes", "pods", "cores", "namespaces"])
      assert.equal(lab[key], value === 0 ? 0 : null, `${key}: ${String(value)}`);
    const site = await insight.site();
    assert.equal(site.flights, value === 0 ? 0 : null);
    assert.equal(site.chats, value === 0 ? 0 : null);
  }
});

// The shape the live cluster actually reports, including the two traps: a
// machine node-exporter scrapes that is not a cluster node, and a node the
// cluster lists but nothing reports for.
function nodeFeed(overrides = {}, options = {}) {
  const vectors = {
    kube_node_info: [
      { metric: { node: "worker-01" }, value: [1, "1"] },
      { metric: { node: "worker-02" }, value: [1, "1"] },
      { metric: { node: "worker-05" }, value: [1, "1"] },
    ],
    kube_node_status_condition: [
      { metric: { node: "worker-01", status: "true" }, value: [1, "1"] },
      { metric: { node: "worker-02", status: "true" }, value: [1, "1"] },
      { metric: { node: "worker-05", status: "unknown" }, value: [1, "1"] },
    ],
    kube_node_status_capacity: [
      { metric: { node: "worker-01" }, value: [1, "8"] },
      { metric: { node: "worker-02" }, value: [1, "8"] },
      { metric: { node: "worker-05" }, value: [1, "4"] },
    ],
    node_cpu_seconds_total: [
      { metric: { instance: "worker-01" }, value: [1, "0.19153645"] },
      { metric: { instance: "worker-02" }, value: [1, "0.688177"] },
      // The Proxmox host and the NAS are scraped by the same exporter job.
      { metric: { instance: "cdd-prox-01" }, value: [1, "0.03"] },
      { metric: { instance: "cdh-ds-01" }, value: [1, "0.52"] },
    ],
    node_memory_MemTotal_bytes: [
      { metric: { instance: "worker-01" }, value: [1, "33013002240"] },
      { metric: { instance: "worker-02" }, value: [1, "33013018624"] },
      { metric: { instance: "cdh-ds-01" }, value: [1, "16743624704"] },
    ],
    node_memory_MemAvailable_bytes: [
      { metric: { instance: "worker-01" }, value: [1, "21013002240"] },
      { metric: { instance: "worker-02" }, value: [1, "8013018624"] },
    ],
    kubelet_running_pods: [
      { metric: { node: "worker-01" }, value: [1, "108"] },
      // Two collectors reporting the same node must not add up to 124.
      { metric: { node: "worker-02", instance: "a" }, value: [1, "62"] },
      { metric: { node: "worker-02", instance: "b" }, value: [1, "62"] },
    ],
    ...overrides,
  };
  return createInsight({
    mimirUrl: "http://mimir.test",
    ...options,
    fetchImpl: async (url) => {
      const query = decodeURIComponent(new URL(url).searchParams.get("query"));
      const key = Object.keys(vectors).find((name) => query.includes(name));
      return Response.json({ status: "success", data: { result: key ? vectors[key] : [] } });
    },
  });
}

test("node readings follow the cluster's own inventory, not the exporter's", async () => {
  const reading = await nodeFeed().nodes();
  const names = reading.nodes.map((n) => n.name);
  // Three machines in inventory order, under labels that disclose nothing.
  assert.deepEqual(names, ["node-01", "node-02", "node-03"]);
  // The Proxmox host and the NAS report to the same exporter job and are not
  // cluster nodes. They must never appear.
  assert.ok(!names.some((n) => n.startsWith("cd")));

  const first = reading.nodes[0];
  assert.equal(first.ready, true);
  assert.equal(first.cores, 8);
  assert.equal(first.cpu, 0.1915);
  assert.equal(first.pods, 108);
  assert.equal(first.memoryTotal, 33013002240);
  assert.equal(first.memoryUsed, 33013002240 - 21013002240);
  // Duplicate collectors report the same node; 62 pods is 62, not 124.
  assert.equal(reading.nodes[1].pods, 62);
  assert.ok(reading.updatedAt);
});

test("a node the cluster lists but nothing reports for is unknown, not idle", async () => {
  const reading = await nodeFeed().nodes();
  // worker-05 sorts last in the inventory, so it is the third label.
  const silent = reading.nodes.find((n) => n.name === "node-03");
  assert.equal(silent.ready, null, "unknown readiness is not a negative condition");
  assert.equal(silent.cpu, null, "no reading is not zero utilisation");
  assert.equal(silent.memoryUsed, null);
  assert.equal(silent.memoryTotal, null);
  assert.equal(silent.pods, null, "no reading is not an empty node");
  // Capacity is known from the cluster even while the machine is silent.
  assert.equal(silent.cores, 4);
});

test("node names that are not node names never reach the browser", async () => {
  const reading = await nodeFeed({
    kube_node_info: [
      { metric: { node: "worker-01" }, value: [1, "1"] },
      { metric: { node: "<script>alert(1)</script>" }, value: [1, "1"] },
      { metric: { node: "" }, value: [1, "1"] },
    ],
  }).nodes();
  assert.deepEqual(reading.nodes.map((n) => n.name), ["node-01"]);
});

test("real node names never reach the browser, aliased or not", async () => {
  const plain = await nodeFeed().nodes();
  const aliased = await nodeFeed(
    {},
    { nodeAliases: "worker-01=alpha, worker-02 = beta" },
  ).nodes();
  for (const reading of [plain, aliased])
    for (const node of reading.nodes)
      assert.ok(
        !/worker-\d/.test(node.name),
        `upstream node name leaked as ${node.name}`,
      );
  // A configured alias is shown; a machine without one keeps its position.
  assert.deepEqual(aliased.nodes.map((n) => n.name), ["alpha", "beta", "node-03"]);
});

test("an alias that is not a safe label falls back to the position, not the name", async () => {
  const reading = await nodeFeed(
    {},
    { nodeAliases: "worker-01=<script>,worker-02=,=orphan,worker-05" },
  ).nodes();
  assert.deepEqual(reading.nodes.map((n) => n.name), ["node-01", "node-02", "node-03"]);
});

test("the lab panel counts every namespace, not only the ones holding a pod", () => {
  assert.match(LAB_QUERIES.namespaces, /kube_namespace_status_phase/);
  assert.doesNotMatch(LAB_QUERIES.namespaces, /kube_pod_info/);
});

test("readiness distinguishes false, unknown, absent and conflicting collector values", async () => {
  const row = (node, status) => ({ metric: { node, status }, value: [1, "1"] });
  const reading = await nodeFeed({ kube_node_status_condition: [row("worker-01", "false"), row("worker-02", "unknown")] }).nodes();
  assert.deepEqual(reading.nodes.map(n => n.ready), [false, null, null]);
  const conflict = await nodeFeed({ kube_node_status_condition: [row("worker-01", "true"), row("worker-01", "false")] }).nodes();
  assert.equal(conflict.nodes[0].ready, null);
});

test("inconsistent available memory never becomes negative usage", async () => {
  const reading = await nodeFeed({ node_memory_MemAvailable_bytes: [{ metric: { instance: "worker-01" }, value: [1, "999999999999"] }] }).nodes();
  assert.equal(reading.nodes[0].memoryUsed, null);
});

// Uptime Kuma's series carry monitor_name, monitor_url and monitor_hostname,
// and some of those are in-cluster DNS names. Two independent guards: the
// queries cannot ask for a per-monitor series, and the feed cannot return one.
test("no watch query can return a per-monitor series", () => {
  for (const [key, query] of Object.entries(WATCH_QUERIES)) {
    // Never name a monitor, and never group by anything that could name one.
    // monitor_id is permitted: it is an integer used to collapse duplicate
    // collectors, and the outer aggregate removes it again.
    assert.doesNotMatch(
      query,
      /monitor_name|monitor_url|monitor_hostname/,
      `${key} selects an identifying label`,
    );
    for (const [, labels] of query.matchAll(/\bby\s*\(([^)]*)\)/g)) {
      assert.deepEqual(
        labels.split(",").map((l) => l.trim()),
        ["cluster", "monitor_id"],
        `${key} groups by something other than cluster and monitor_id`,
      );
    }
    // The outermost call has to be an aggregate, so the result is one series.
    assert.match(query, /^(count|sum|min|max|avg|quantile)\s*\(/, `${key} is not an aggregate`);
  }
});

test("the watch panel publishes numbers even when Mimir returns monitor labels", async () => {
  // Exactly what the real store holds, names and in-cluster addresses included.
  const leaky = {
    metric: {
      monitor_name: "Bitcoin / Fulcrum TCP",
      monitor_hostname: "fulcrum.fulcrum.svc.cluster.local",
      monitor_url: "http://bitcoin-rpc.bitcoin.svc.cluster.local:8332/rest/chaininfo.json",
    },
    value: [1, "1"],
  };
  const insight = createInsight({
    mimirUrl: "http://mimir.test",
    fetchImpl: async () =>
      new Response(JSON.stringify({ status: "success", data: { result: [leaky] } }), {
        headers: { "content-type": "application/json" },
      }),
  });
  const watch = await insight.watch();
  assert.deepEqual(
    Object.keys(watch).sort(),
    ["certDays", "down", "monitors", "responseMs", "up", "updatedAt", "uptime30d"],
  );
  for (const [key, value] of Object.entries(watch)) {
    if (key === "updatedAt") continue;
    assert.equal(typeof value, "number", `${key} is not a number`);
  }
  assert.doesNotMatch(JSON.stringify(watch), /svc\.cluster\.local|Fulcrum|monitor_/);
});

test("a ratio outside 0..1 and a missing reading stay honest", async () => {
  const reply = (value) =>
    new Response(JSON.stringify({ status: "success", data: { result: value === null ? [] : [{ metric: {}, value: [1, String(value)] }] } }), {
      headers: { "content-type": "application/json" },
    });
  const clamped = createInsight({ mimirUrl: "http://mimir.test", fetchImpl: async () => reply(1.7) });
  assert.equal((await clamped.watch()).uptime30d, 1);
  const empty = createInsight({ mimirUrl: "http://mimir.test", fetchImpl: async () => reply(null) });
  const reading = await empty.watch();
  assert.equal(reading.uptime30d, null);
  assert.equal(reading.monitors, null);
});

test("same node names in different clusters cannot mix readings or readiness", async () => {
  const row = (cluster, labels, value) => ({ metric: { cluster, ...labels }, value: [1, String(value)] });
  const reading = await nodeFeed({
    kube_node_info: [row("private-a", { node: "worker" }, 1), row("private-b", { node: "worker" }, 1)],
    kube_node_status_condition: [row("private-a", { node: "worker", status: "true" }, 1), row("private-b", { node: "worker", status: "false" }, 1)],
    kube_node_status_capacity: [row("private-a", { node: "worker" }, 4), row("private-b", { node: "worker" }, 8)],
    node_cpu_seconds_total: [row("private-a", { instance: "worker" }, 0.2), row("private-b", { instance: "worker" }, 0.7)],
    node_memory_MemTotal_bytes: [row("private-a", { instance: "worker" }, 100), row("private-b", { instance: "worker" }, 200)],
    node_memory_MemAvailable_bytes: [row("private-a", { instance: "worker" }, 80)],
    kubelet_running_pods: [row("private-a", { node: "worker" }, 3), row("private-a", { node: "worker" }, 3), row("private-b", { node: "worker" }, 7)],
  }).nodes();
  assert.equal(reading.clusters.length, 2);
  assert.notEqual(reading.nodes[0].cluster, reading.nodes[1].cluster);
  assert.deepEqual(reading.nodes.map(({ cluster, ...node }) => node), [
    { name: "node-01", ready: true, cores: 4, cpu: 0.2, memoryUsed: 20, memoryTotal: 100, pods: 3 },
    { name: "node-02", ready: false, cores: 8, cpu: 0.7, memoryUsed: null, memoryTotal: 200, pods: 7 },
  ]);
  assert.doesNotMatch(JSON.stringify(reading), /private-|worker/);
});

test("cold panels share a bounded metrics query budget and release slots on failure", async () => {
  let active = 0, peak = 0, calls = 0;
  const insight = createInsight({ mimirUrl: "https://metrics.test", fetchImpl: async () => {
    const call = ++calls;
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    if (call === 1) throw new Error("one failed query");
    return promResponse(0);
  } });
  const results = await Promise.allSettled([insight.site(), insight.lab(), insight.nodes(), insight.watch(), insight.scout()]);
  assert.equal(results[0].status, "rejected");
  for (const result of results.slice(1)) assert.equal(result.status, "fulfilled");
  assert.ok(peak <= 4, `upstream concurrency was ${peak}`);
  assert.ok(calls > 20, "all queued panels were exercised");
  assert.equal(active, 0);
});


test("cluster aliases are explicit and stable across reordered and missing inventory", async () => {
  const row = (cluster, node) => ({ metric: { cluster, node }, value: [1, "1"] });
  const inventory = [row("private-b", "worker"), row("private-a", "worker")];
  const options = { clusterAliases: "private-a=Personal services,private-b=Production" };
  const first = await nodeFeed({ kube_node_info: inventory }, options).nodes();
  const second = await nodeFeed({ kube_node_info: inventory.slice(0, 1) }, options).nodes();
  assert.deepEqual(first.clusters.map(c => c.name), ["Personal services", "Production"]);
  assert.deepEqual(second.clusters[0], first.clusters[1]);
  assert.equal(second.nodes[0].cluster, first.nodes[1].cluster);
  assert.doesNotMatch(JSON.stringify(first), /private-|worker/);
  const invalid = await nodeFeed({ kube_node_info: inventory }, { clusterAliases: "private-a=<script>" }).nodes();
  assert.equal(invalid.clusters[0].name, "Cluster 1");
});

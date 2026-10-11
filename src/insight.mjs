import { UNIFI_QUERY, unifiReadings } from "./unifi.mjs";
import { GPU_QUERY, gpuReadings } from "./gpu.mjs";
import { createReadCache, upstreamJson } from "./upstream.mjs";
import { createHash } from "node:crypto";
// Read-only instrument panels backed by a shared metrics store. Cluster
// identity is retained while deduplicating and joining, then discarded before
// returning public readings. Job Scout contributes aggregate metrics only.
//
// Nothing here forwards a raw upstream body to the browser. Every field is
// picked and coerced, so a change upstream cannot start publishing something
// that was never meant to be public. That matters most for Job Scout, which
// holds private job-search data: only totals and a timestamp leave this file,
// never a title, company, status or URL.

const CACHE_MS = 30_000;

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function num(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, places = 0) {
  const n = num(value);
  if (n === null) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// A visitor sends a heartbeat every 15s while flying, so heartbeats per flight
// is an estimate of session length. It is an estimate, and the panel says so.
export const HEARTBEAT_SECONDS = 15;

export const SITE_QUERIES = {
  playing: "sum(orrery_visitors_playing)",
  reported: "sum(orrery_visitors_seen)",
  flights: "sum(increase(orrery_play_starts_total[24h]))",
  heartbeats: "sum(increase(orrery_heartbeats_total[24h]))",
  chats: "sum(increase(orrery_chat_messages_total[24h]))",
  chatErrors: "sum(increase(orrery_chat_errors_total[24h]))",
  throttled: "sum(increase(orrery_chat_throttled_total[24h]))",
  boosts: "sum(increase(orrery_boosts_total[24h]))",
  buoys: "sum(increase(orrery_collects_total[7d]))",
  charts: "sum(increase(orrery_chart_opens_total[24h]))",
  commOpens: "sum(increase(orrery_comm_opens_total[24h]))",
  resume: "sum(increase(orrery_resume_clicks_total[24h]))",
  notes: "sum(increase(orrery_notes_opened_total[24h]))",
  fallbacks: "sum(increase(orrery_fallback_total[24h]))",
  // Browser-reported first frame. Median over the day, in milliseconds.
  readyP50:
    "histogram_quantile(0.5, sum by (le) (rate(orrery_ready_ms_bucket[24h])))",
};

const TOP_NOTES = "topk(5, sum by (body) (increase(orrery_notes_opened_total[7d])))";

export const LAB_QUERIES = {
  clusters: "count(count by (cluster) (kube_node_info))",
  nodes: "count(max by (cluster, node) (kube_node_info))",
  pods: 'sum(max by (cluster, namespace, pod) (kube_pod_status_phase{phase="Running"}))',
  cores: 'sum(max by (cluster, node) (kube_node_status_capacity{resource="cpu"}))',
  // Every namespace, not only the ones that happen to hold a pod. The panel
  // read 64 while the cluster had 100, because the old query counted
  // namespaces with pod records.
  namespaces: 'count(max by (cluster, namespace) (kube_namespace_status_phase{phase="Active"}) == 1)',
};

// Uptime Kuma watches a few dozen services. Every series it exports carries
// monitor_name, monitor_url and monitor_hostname, and those name and address
// internal services — some of them by in-cluster DNS name. None of that is
// summarizable into a portfolio reading, so every query here aggregates the
// whole set down to one number and no query selects, groups by or returns a
// per-monitor series. What a monitor is called never enters this file.
//
// The median rather than the mean for both ratios: a handful of monitors point
// at things that are switched off on purpose and sit at zero, and a mean lets
// those decide the headline figure. The median describes the typical service,
// which is what the panel claims, and the up-versus-total count next to it
// keeps the dead ones visible rather than hidden.
//
// Every reading collapses duplicates by monitor_id first. Two collectors can
// scrape the same Uptime Kuma at once — a second scrape job briefly existed
// while this panel was being built, and the naive count read 176 monitors for
// a set of 88. monitor_id is an integer with no meaning outside the metrics
// store, so grouping by it deduplicates without naming anything.
export const WATCH_QUERIES = {
  monitors: "count(count by (cluster, monitor_id) (monitor_status))",
  up: "count(count by (cluster, monitor_id) (monitor_status == 1))",
  down: "count(count by (cluster, monitor_id) (monitor_status == 0))",
  uptime30d: 'quantile(0.5, max by (cluster, monitor_id) (monitor_uptime_ratio{window="30d"}))',
  response: 'quantile(0.5, max by (cluster, monitor_id) (monitor_response_time_seconds{window="1d"}))',
  // Expired and not-yet-issued certificates report zero or less; excluding
  // them keeps this reading "soonest real expiry" rather than a constant zero.
  certDays: "min(min by (cluster, monitor_id) (monitor_cert_days_remaining > 0))",
};

// Each gauge describes the same full node. max collapses duplicate collectors
// and discards every label before the reading reaches the application.
export const BITCOIN_QUERIES = {
  peers: "max(bitcoin_peers)",
  chainBytes: "max(bitcoin_size_on_disk)",
  mempoolTransactions: "max(bitcoin_mempool_size)",
  mempoolBytes: "max(bitcoin_mempool_bytes)",
  uptimeSeconds: "max(bitcoin_uptime)",
  verification: "max(bitcoin_verification_progress)",
};

// Event labels describe workloads; scrape keys describe collectors. Sum each
// collector's events before discarding duplicate collectors of the same target.
// In particular, Tetragon's event node label can be absent, so it cannot be
// used as the identity of the observer. Only the final scalar leaves Mimir.
const observerRate = (metric, window) =>
  `sum(max by (cluster, instance) (sum by (cluster, job, instance) (rate(${metric}[${window}]))))`;
export const NETWORK_QUERIES = {
  flowsPerSecond: observerRate("hubble_flows_processed_total", "5m"),
  dropsPerSecond: observerRate("hubble_drop_total", "1h"),
  eventsPerSecond: observerRate("tetragon_events_total", "5m"),
  // This gauge counts endpoints in each enforcement state, not policies.
  // Audit-only endpoints do not enforce; ingress, egress or both do.
  enforcedEndpoints: 'sum(max by (cluster, node, enforcement) (cilium_policy_endpoint_enforcement_status{enforcement=~"both|ingress|egress"}))',
  endpoints: "sum(max by (cluster, node, enforcement) (cilium_policy_endpoint_enforcement_status))",
};

export const SCOUT_QUERIES = {
  tracked: "sum(max by (cluster, status) (job_scout_positions))",
  refreshErrors: "max(job_scout_metrics_db_refresh_errors)",
};

// Only the unprivileged API collector supplies this feed. No guest labels.
export const PROXMOX_QUERY = '{__name__=~"orrery_proxmox_(collection_success|collection_timestamp_seconds|up|cpu_ratio|cores|memory_used_bytes|memory_total_bytes|uptime_seconds|vms_total|vms_running|containers_total|containers_running)"}';
const PROXMOX_FIELDS = {
  up: "up", cpu_ratio: "cpu", cores: "cores", memory_used_bytes: "memoryUsed",
  memory_total_bytes: "memoryTotal", uptime_seconds: "uptimeSeconds",
  vms_total: "vmsTotal", vms_running: "vmsRunning",
  containers_total: "containersTotal", containers_running: "containersRunning",
};

export const NODE_QUERIES = {
  inventory: "kube_node_info",
  ready: 'kube_node_status_condition{condition="Ready"} == 1',
  cores: 'kube_node_status_capacity{resource="cpu"}',
  cpu: '1 - avg by (cluster, instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))',
  memoryTotal: "node_memory_MemTotal_bytes",
  // Available, not free: free memory ignores reclaimable cache and would make
  // every healthy Linux box look full.
  memoryAvailable: "node_memory_MemAvailable_bytes",
  pods: "kubelet_running_pods",
};

// Node names are display aliases from the cluster, not caller input, but they
// are still upstream text on their way to a browser. Bound them.
const NODE_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
const MAX_NODES = 128;

// A real node name is infrastructure detail. Printing it on a public panel
// hands a visitor an inventory of the machines behind the site, and no reading
// on that panel needs the true name to be meaningful. Display names come from
// PUBLIC_NODE_ALIASES ("real=shown,real=shown"); anything unmapped reads as a
// positional label. The upstream name is used for correlation inside this file
// and never leaves it.
const NODE_ALIAS = /^[a-z0-9][a-z0-9 ._-]{0,23}$/i;

export function parseNodeAliases(value) {
  const aliases = new Map();
  for (const pair of String(value || "").split(",")) {
    const [name, alias] = pair.split("=").map((part) => (part || "").trim());
    // A malformed entry is dropped rather than trusted: falling back to the
    // positional label discloses nothing, falling back to the real name would.
    if (!NODE_NAME.test(name || "") || !NODE_ALIAS.test(alias || "")) continue;
    aliases.set(name, alias);
  }
  return aliases;
}

function positional(index) {
  return `node-${String(index + 1).padStart(2, "0")}`;
}

// Several collectors can report the same node; take one value per node rather
// than summing duplicates into a number twice as large as the truth.
function nodeKey(metric, label = "node") {
  const name = String(metric?.[label] || "");
  const cluster = String(metric?.cluster || "");
  if (!NODE_NAME.test(name) || cluster.length > 128 || cluster.includes("\0")) return null;
  return `${cluster}\0${name}`;
}

function byNode(rows, label = "node") {
  const out = new Map();
  for (const row of rows || []) {
    const key = nodeKey(row?.metric, label);
    const value = num(row?.value?.[1]);
    if (key === null || value === null) continue;
    const seen = out.get(key);
    if (seen === undefined || value > seen) out.set(key, value);
  }
  return out;
}

const TOP_DESTINATIONS = "topk(5, sum by (body) (increase(orrery_docks_total[7d])))";

export function createInsight({
  mimirUrl = process.env.MIMIR_URL || "",
  mimirTenant = process.env.MIMIR_TENANT || "anonymous",
  nodeAliases = process.env.PUBLIC_NODE_ALIASES || "",
  clusterAliases = process.env.PUBLIC_CLUSTER_ALIASES || "",
  proxmoxAliases = process.env.PUBLIC_PROXMOX_ALIASES || "",
  fetchImpl = fetch,
  cacheMs = CACHE_MS,
  now = () => Date.now(),
} = {}) {
  const cached = createReadCache({ ttlMs: cacheMs, now });
  const aliases = parseNodeAliases(nodeAliases);
  const clusterNames = parseNodeAliases(clusterAliases);
  const hostNames = parseNodeAliases(proxmoxAliases);

  // All panels share this budget. A cold site read alone has seventeen
  // queries; overlapping panels otherwise exhaust small Mimir query queues.
  let activeQueries = 0;
  const waitingQueries = [];
  async function promql(query) {
    if (activeQueries >= 4) await new Promise(resolve => waitingQueries.push(resolve));
    else activeQueries++;
    try {
      return await queryMetrics(query);
    } finally {
      const next = waitingQueries.shift();
      if (next) next();
      else activeQueries--;
    }
  }

  async function queryMetrics(query) {
    if (!mimirUrl) throw fail(503, "metrics unconfigured");
    const url = `${mimirUrl.replace(/\/$/, "")}/prometheus/api/v1/query?query=${encodeURIComponent(query)}`;
    const response = await fetchImpl(url, {
      headers: { "X-Scope-OrgID": mimirTenant, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw fail(502, "metrics unavailable");
    const body = await upstreamJson(response);
    if (body?.status !== "success") throw fail(502, "metrics unavailable");
    return Array.isArray(body.data?.result) ? body.data.result : [];
  }

  async function scalar(query) {
    const result = await promql(query);
    return result.length ? num(result[0].value?.[1]) : null;
  }

  async function scalars(queries) {
    const keys = Object.keys(queries);
    const values = await Promise.all(keys.map((k) => scalar(queries[k])));
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  }

  async function site() {
    return cached("site", async () => {
      const [raw, top, read] = await Promise.all([
        scalars(SITE_QUERIES),
        promql(TOP_DESTINATIONS),
        promql(TOP_NOTES),
      ]);
      const flights = round(raw.flights);
      const heartbeats = round(raw.heartbeats);
      return {
        playing: round(raw.playing),
        reported: round(raw.reported),
        flights,
        // Heartbeats per flight times the heartbeat interval. An estimate.
        avgFlightSeconds:
          flights > 0 && heartbeats !== null
            ? round((heartbeats / flights) * HEARTBEAT_SECONDS)
            : null,
        chats: round(raw.chats),
        chatErrors: round(raw.chatErrors),
        throttled: round(raw.throttled),
        boosts: round(raw.boosts),
        buoys: round(raw.buoys),
        charts: round(raw.charts),
        commOpens: round(raw.commOpens),
        resume: round(raw.resume),
        notes: round(raw.notes),
        fallbacks: round(raw.fallbacks),
        readyP50: round(raw.readyP50),
        destinations: top
          .map((row) => ({
            body: String(row.metric?.body || "").slice(0, 40),
            docks: round(row.value?.[1]),
          }))
          .filter((d) => d.body && d.body !== "none" && d.docks !== null)
          .sort((a, b) => b.docks - a.docks),
        opened: read
          .map((row) => ({
            body: String(row.metric?.body || "").slice(0, 40),
            reads: round(row.value?.[1]),
          }))
          .filter((d) => d.body && d.body !== "none" && d.reads !== null)
          .sort((a, b) => b.reads - a.reads),
        updatedAt: new Date(now()).toISOString(),
      };
    });
  }

  async function lab() {
    return cached("lab", async () => {
      const raw = await scalars(LAB_QUERIES);
      return {
        clusters: round(raw.clusters),
        nodes: round(raw.nodes),
        pods: round(raw.pods),
        cores: round(raw.cores),
        namespaces: round(raw.namespaces),
        updatedAt: new Date(now()).toISOString(),
      };
    });
  }

  // The authenticated desk API holds private records. Its metrics exporter
  // already reports counts; aggregate them inside Mimir instead of requesting
  // even one private listing. A failed exporter refresh invalidates the count.
  async function scout() {
    if (!mimirUrl) return { configured: false };
    return cached("scout", async () => {
      const raw = await scalars(SCOUT_QUERIES);
      return {
        configured: true,
        tracked: raw.refreshErrors === 0 && raw.tracked !== null && raw.tracked >= 0
          ? round(raw.tracked) : null,
        updatedAt: new Date(now()).toISOString(),
      };
    });
  }

  // The machines themselves. Everything is picked and coerced, and anything
  // missing stays missing: a node that reports nothing reads as unknown, which
  // is the honest answer and a visibly different one from idle.
  async function nodes() {
    return cached("nodes", async () => {
      const [inventory, ready, cores, cpu, memoryTotal, memoryAvailable, pods] =
        await Promise.all([
          promql(NODE_QUERIES.inventory),
          promql(NODE_QUERIES.ready),
          promql(NODE_QUERIES.cores),
          promql(NODE_QUERIES.cpu),
          promql(NODE_QUERIES.memoryTotal),
          promql(NODE_QUERIES.memoryAvailable),
          promql(NODE_QUERIES.pods),
        ]);
      const names = [...byNode(inventory).keys()].sort();
      const clusterKeys = [...new Set(names.slice(0, MAX_NODES).map(name => name.split("\0")[0]))];
      const clusters = new Map(clusterKeys.map((key, index) => [key, {
        id: `cluster-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
        name: clusterNames.get(key) || (key ? `Cluster ${index + 1}` : "Unassigned cluster"),
      }]));
      const readyNodes = new Map();
      for (const row of ready) {
        const name = nodeKey(row.metric);
        const status = row.metric?.status;
        if (name === null || num(row.value?.[1]) !== 1 || !["true", "false", "unknown"].includes(status)) continue;
        const statuses = readyNodes.get(name) || new Set();
        statuses.add(status);
        readyNodes.set(name, statuses);
      }
      const coreCounts = byNode(cores);
      // These come from node-exporter, which keys on instance and also covers
      // machines outside the cluster. The inventory above is the filter.
      const busy = byNode(cpu, "instance");
      const total = byNode(memoryTotal, "instance");
      const available = byNode(memoryAvailable, "instance");
      const running = byNode(pods, "node");
      return {
        clusters: [...clusters.values()],
        nodes: names.slice(0, MAX_NODES).map((name, index) => {
          const memory = total.get(name) ?? null;
          const free = available.get(name) ?? null;
          const statuses = readyNodes.get(name);
          const status = statuses?.size === 1 ? [...statuses][0] : "unknown";
          return {
            cluster: clusters.get(name.split("\0")[0]).id,
            name: aliases.get(name.split("\0")[1]) || positional(index),
            ready: status === "true" ? true : status === "false" ? false : null,
            cores: round(coreCounts.get(name) ?? null),
            cpu: busy.has(name) ? round(Math.min(Math.max(busy.get(name), 0), 1), 4) : null,
            memoryUsed: memory !== null && free !== null && memory > 0 && free >= 0 && free <= memory ? round(memory - free) : null,
            memoryTotal: round(memory),
            pods: round(running.get(name) ?? null),
          };
        }),
        updatedAt: new Date(now()).toISOString(),
      };
    });
  }

  // Counts and rounded aggregates only. See WATCH_QUERIES: the monitor names
  // and addresses stay in the metrics store and never reach this object.
  async function watch() {
    return cached("watch", async () => {
      const raw = await scalars(WATCH_QUERIES);
      const monitors = round(raw.monitors);
      const up = round(raw.up);
      return {
        monitors,
        up,
        down: round(raw.down),
        // A ratio is only meaningful against a known total.
        uptime30d:
          raw.uptime30d === null ? null : round(Math.min(Math.max(raw.uptime30d, 0), 1), 4),
        responseMs: raw.response === null ? null : round(raw.response * 1000),
        certDays: round(raw.certDays),
        updatedAt: new Date(now()).toISOString(),
      };
    });
  }

  async function bitcoin() {
    return cached("bitcoin", async () => {
      const raw = await scalars(BITCOIN_QUERIES);
      // Zero peers or transactions is real. Missing, negative and impossible
      // progress readings are unknown, never evidence of an idle/synced node.
      const count = (n) => n !== null && n >= 0 ? round(n) : null;
      return {
        peers: count(raw.peers),
        chainBytes: count(raw.chainBytes),
        mempoolTransactions: count(raw.mempoolTransactions),
        mempoolBytes: count(raw.mempoolBytes),
        uptimeSeconds: count(raw.uptimeSeconds),
        verification: raw.verification !== null && raw.verification >= 0 && raw.verification <= 1 ? raw.verification : null,
        updatedAt: new Date(now()).toISOString(),
      };
    });
  }

  async function proxmox() {
    return cached("proxmox", async () => {
      const rows = await promql(PROXMOX_QUERY);
      const hosts = new Map([...hostNames.keys()].map(name => [name, {}]));
      for (const row of rows) {
        const name = row.metric?.instance;
        const field = String(row.metric?.__name__ || "").replace(/^orrery_proxmox_/, "");
        if (!NODE_NAME.test(name || "") || !(Object.hasOwn(PROXMOX_FIELDS, field) || field === "collection_success" || field === "collection_timestamp_seconds")) continue;
        const host = hosts.get(name) || {};
        const value = num(row.value?.[1]);
        if (value !== null) host[field] = host[field] === undefined ? value : Math.min(host[field], value);
        hosts.set(name, host);
      }
      return {
        hosts: [...hosts].sort(([a], [b]) => a.localeCompare(b)).slice(0, 16).map(([name, raw], index) => {
          const age = now() / 1000 - raw.collection_timestamp_seconds;
          const reporting = raw.collection_success === 1 && age >= -30 && age <= 180;
          const host = { name: hostNames.get(name) || `Host ${index + 1}`, reporting };
          for (const [key, field] of Object.entries(PROXMOX_FIELDS)) {
            const value = raw[key];
            host[field] = reporting && Number.isFinite(value) && value >= 0 ? round(value, field === "cpu" ? 4 : 0) : null;
          }
          host.up = reporting && raw.up === 1 ? true : reporting && raw.up === 0 ? false : null;
          if (host.cpu > 1) host.cpu = null;
          if (host.memoryTotal === null || host.memoryTotal <= 0 || host.memoryUsed > host.memoryTotal) host.memoryUsed = null;
          for (const kind of ["vms", "containers"])
            if (host[`${kind}Total`] === null || host[`${kind}Running`] > host[`${kind}Total`]) host[`${kind}Running`] = null;
          host.updatedAt = reporting ? new Date(raw.collection_timestamp_seconds * 1000).toISOString() : null;
          return host;
        }),
        updatedAt: new Date(now()).toISOString(),
      };
    });
  }

  async function network() {
    return cached("network", async () => {
      const raw = await scalars(NETWORK_QUERIES);
      const reading = Object.fromEntries(Object.entries(raw).map(([key, value]) => [
        key, value !== null && value >= 0 ? round(value, key.endsWith("PerSecond") ? 1 : 0) : null,
      ]));
      if (reading.enforcedEndpoints !== null && reading.endpoints !== null && reading.enforcedEndpoints > reading.endpoints)
        reading.enforcedEndpoints = null;
      return { ...reading, updatedAt: new Date(now()).toISOString() };
    });
  }

  const unifi = () => cached("unifi", async () => unifiReadings(await promql(UNIFI_QUERY), now()));
  const gpu = () => cached("gpu", async () => gpuReadings(await promql(GPU_QUERY), now()));

  return { site, lab, scout, nodes, watch, bitcoin, network, proxmox, gpu, unifi, ready: () => Boolean(mimirUrl) };
}

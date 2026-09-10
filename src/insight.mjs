import { createReadCache, upstreamJson } from "./upstream.mjs";
// Live readings for the instrument panels. Two in-cluster sources, both read
// only: Mimir for the site's own telemetry and the homelab cluster, and the
// Job Scout desk for counts.
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
  nodes: "count(max by (node) (kube_node_info))",
  pods: 'sum(max by (namespace, pod) (kube_pod_status_phase{phase="Running"}))',
  cores: 'sum(max by (node) (kube_node_status_capacity{resource="cpu"}))',
  // Every namespace, not only the ones that happen to hold a pod. The panel
  // read 64 while the cluster had 100, because the old query counted
  // namespaces with pod records.
  namespaces: 'count(max by (namespace) (kube_namespace_status_phase{phase="Active"}) == 1)',
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
  monitors: "count(count by (monitor_id) (monitor_status))",
  up: "count(count by (monitor_id) (monitor_status == 1))",
  down: "count(count by (monitor_id) (monitor_status == 0))",
  uptime30d: 'quantile(0.5, max by (monitor_id) (monitor_uptime_ratio{window="30d"}))',
  response: 'quantile(0.5, max by (monitor_id) (monitor_response_time_seconds{window="1d"}))',
  // Expired and not-yet-issued certificates report zero or less; excluding
  // them keeps this reading "soonest real expiry" rather than a constant zero.
  certDays: "min(min by (monitor_id) (monitor_cert_days_remaining > 0))",
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

export const NODE_QUERIES = {
  inventory: "kube_node_info",
  ready: 'kube_node_status_condition{condition="Ready"} == 1',
  cores: 'kube_node_status_capacity{resource="cpu"}',
  cpu: '1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))',
  memoryTotal: "node_memory_MemTotal_bytes",
  // Available, not free: free memory ignores reclaimable cache and would make
  // every healthy Linux box look full.
  memoryAvailable: "node_memory_MemAvailable_bytes",
  pods: "kubelet_running_pods",
};

// Node names are display aliases from the cluster, not caller input, but they
// are still upstream text on their way to a browser. Bound them.
const NODE_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/i;
const MAX_NODES = 16;

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
function byNode(rows, label = "node") {
  const out = new Map();
  for (const row of rows || []) {
    const key = String(row?.metric?.[label] || "");
    const value = num(row?.value?.[1]);
    if (!NODE_NAME.test(key) || value === null) continue;
    const seen = out.get(key);
    if (seen === undefined || value > seen) out.set(key, value);
  }
  return out;
}

const TOP_DESTINATIONS = "topk(5, sum by (body) (increase(orrery_docks_total[7d])))";

export function createInsight({
  mimirUrl = process.env.MIMIR_URL || "",
  mimirTenant = process.env.MIMIR_TENANT || "anonymous",
  scoutUrl = process.env.JOB_SCOUT_URL || "",
  nodeAliases = process.env.PUBLIC_NODE_ALIASES || "",
  fetchImpl = fetch,
  cacheMs = CACHE_MS,
  now = () => Date.now(),
} = {}) {
  const cached = createReadCache({ ttlMs: cacheMs, now });
  const aliases = parseNodeAliases(nodeAliases);

  async function promql(query) {
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
        nodes: round(raw.nodes),
        pods: round(raw.pods),
        cores: round(raw.cores),
        namespaces: round(raw.namespaces),
        updatedAt: new Date(now()).toISOString(),
      };
    });
  }

  // Counts only. The desk holds private job-search data and none of it,
  // including company names, titles and application status, is public.
  async function scout() {
    if (!scoutUrl) return { configured: false };
    return cached("scout", async () => {
      const response = await fetchImpl(
        `${scoutUrl.replace(/\/$/, "")}/api/v1/positions?pageSize=1`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) },
      );
      if (!response.ok) throw fail(502, "desk unavailable");
      const body = await upstreamJson(response);
      const lastMovement = body?.data?.[0]?.updatedAt;
      return {
        configured: true,
        tracked: round(body?.meta?.total),
        lastMovement:
          typeof lastMovement === "string" && lastMovement.length <= 40
            ? lastMovement
            : null,
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
      const readyNodes = new Map();
      for (const row of ready) {
        const name = row.metric?.node;
        const status = row.metric?.status;
        if (!NODE_NAME.test(name || "") || num(row.value?.[1]) !== 1 || !["true", "false", "unknown"].includes(status)) continue;
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
        nodes: names.slice(0, MAX_NODES).map((name, index) => {
          const memory = total.get(name) ?? null;
          const free = available.get(name) ?? null;
          const statuses = readyNodes.get(name);
          const status = statuses?.size === 1 ? [...statuses][0] : "unknown";
          return {
            name: aliases.get(name) || positional(index),
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

  return { site, lab, scout, nodes, watch, bitcoin, ready: () => Boolean(mimirUrl) };
}

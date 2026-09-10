import "./style.css";
import "./orbit.css";
import { createComm } from "./comm.js";
import { renderChart } from "./chart.js";
import catalog from "../data/projects.json";
import { achievements, DOCK_MARGIN, nearbyEmitters, scannerChoice, positionOf, unlocks, emitterBearing } from "./flight.js";
import { bitcoinNodeRows } from "./bitcoin-reading.js";

const $ = (selector) => document.querySelector(selector);
const ids = new Set(catalog.bodies.map((b) => b.id));
const signalIds = new Set((catalog.signals || []).map((s) => s.id));
const emblems = {
  resume: "◎",
  platform: "⬡",
  observe: "⌁",
  homelab: "▤",
  bitops: "◇",
  rubinot: "✧",
  scout: "⌖",
  bitcoin: "₿",
  survey: "✺",
  cilium: "◍",
  argo: "⎇",
  "observe-mcp": "⌁",
  "checkly-mcp": "▣",
  fulcrum: "▅",
  "lab-grafana": "▦",
};
let visited = new Set();
let collected = new Set();
try {
  const saved = JSON.parse(localStorage.getItem("gc-field-notes-v1") || "[]");
  if (Array.isArray(saved))
    visited = new Set(saved.filter((id) => ids.has(id)));
  const sigs = JSON.parse(localStorage.getItem("gc-signals-v1") || "[]");
  if (Array.isArray(sigs))
    collected = new Set(sigs.filter((id) => signalIds.has(id)));
} catch {}
let world,
  started = false,
  startedAt = 0,
  fallback = false,
  low = false,
  lens = false,
  tipDestination = "",
  tipLoaded = false,
  view = "explore";
let toastTimer,
  lastFocus,
  activeDialog = null,
  lastDockId = null,
  bitcoinLoadedAt = null,
  lastHeight = null,
  btcPrice = null,
  blockMinedAt = null,
  blockTransactions = null,
  relayReady = false,
  relayExpanded = false,
  activeRelay = null;
const labels = new Map();
const totalBodies = catalog.bodies.length;
const esc = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 5500);
}
let visitor = "";
try {
  visitor = localStorage.getItem("gc-visitor-v1") || "";
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(visitor)) {
    visitor = crypto.randomUUID().replaceAll("-", "");
    localStorage.setItem("gc-visitor-v1", visitor);
  }
} catch {
  visitor = `anon${Math.random().toString(36).slice(2, 12)}`;
}
const comm = createComm({
  onOpen: () => telemetry("comm"),
  visitor,
  open: () => openDialog("#comm-hud"),
  close: closeDialog,
});
function relayUnlocked(body) {
  if (!body?.unlock) return true;
  if (body.unlock === "buoys:4") return collected.size >= 4;
  return true;
}
fetch("/api/relay")
  .then((r) => r.json())
  .then((d) => {
    relayReady = Boolean(d?.ready);
  })
  .catch(() => {});
function telemetry(event, extra = {}) {
  fetch("/api/telemetry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visitor, event, ...extra }),
    keepalive: true,
  }).catch(() => {});
}
// Any link out to the resume, from the header, intro, fallback or a dossier.
document.addEventListener("click", (e) => {
  const link = e.target.closest?.('a[href^="https://resume.giovanni.dev.br"]');
  if (link) telemetry("resume");
});
function persist() {
  try {
    localStorage.setItem("gc-field-notes-v1", JSON.stringify([...visited]));
    localStorage.setItem("gc-signals-v1", JSON.stringify([...collected]));
  } catch {}
}
function start() {
  if (fallback) return;
  if (!started) {
    started = true;
    startedAt = Date.now();
    document.body.classList.add("flying");
    $("#intro").hidden = true;
    $("#flight-guide").hidden = false;
    $("#touch-controls").hidden = false;
    $("#canopy-hud").hidden = false;
    $("#console-toggle").hidden = false;
    telemetry("play");
  }
  world?.start();
}
function closeDialog() {
  if (!activeDialog) return;
  activeDialog.close();
}
function openDialog(id) {
  closeDialog();
  lastFocus = document.activeElement;
  activeDialog = $(id);
  const cockpitPanel = id === "#comm-hud";
  world?.pause(!cockpitPanel);
  if (cockpitPanel) {
    setNotesExpanded(false);
    activeDialog.show();
  } else activeDialog.showModal();
  if (id === "#chart") drawChart();
  if (id === "#telemetry") updateFreshness();
  setScannerExpanded(false);
}
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.querySelector("[data-close]")?.addEventListener("click", closeDialog);
  dialog.addEventListener("close", () => {
    if (activeDialog === dialog) {
      activeDialog = null;
      world?.pause(false);
    }
    if (activeDialog) return;
    // `close` fires a task after the dialog is already gone, and the browser
    // has usually restored focus to whatever opened it by then. Reaching in
    // here unconditionally means a panel closed with Escape can pull focus off
    // whatever the visitor moved to in the meantime — pressing Enter on the
    // launch button and getting the chart instead. Only rescue focus that
    // would otherwise be stranded on the body.
    const active = document.activeElement;
    const moved =
      active &&
      active !== document.body &&
      !dialog.contains(active) &&
      active.isConnected &&
      active.getClientRects().length;
    if (moved) return;
    if (lastFocus?.isConnected && lastFocus.getClientRects().length)
      lastFocus.focus({ preventScroll: true });
    else $("#map-toggle").focus({ preventScroll: true });
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        closeDialog();
    }
  });
}
function navigate(id) {
  closeDialog();
  if (fallback) {
    dock(catalog.bodies.find((b) => b.id === id));
    return;
  }
  if (!started) {
    readNotes(catalog.bodies.find((b) => b.id === id), "preview");
    return;
  }
  hideStation();
  requestAnimationFrame(() => {
    world?.pause(false);
    world?.navigate(id);
  });
  $("#flight-guide").hidden = true;
  toast(
    `Course set for ${catalog.bodies.find((b) => b.id === id).name}. Steer to take over.`,
  );
}
// Bodies with a live feed get a readings strip in the orbit console. Each
// entry names an endpoint and turns its payload into label/value pairs. A
// failed or unconfigured feed says so rather than showing a zero.
function gigabytes(bytes) {
  return finite(bytes) ? `${(bytes / 1e9).toFixed(1)} GB` : "—";
}

// Label, bar, reading — on one line, because four machines have to fit in a
// panel column without scrolling past the interesting one. An unknown value
// draws an empty track rather than a full or empty bar, both of which would be
// a claim.
function meter(label, fraction, value) {
  const width = finite(fraction) ? Math.round(Math.min(Math.max(fraction, 0), 1) * 100) : 0;
  return `<div class="node-meter"><span>${esc(label)}</span><i><span style="width:${width}%"></span></i><b>${esc(value)}</b></div>`;
}

const LIVE_FEEDS = {
  bitcoin: {
    read: async (signal) => {
      const results = await Promise.allSettled([
        getJSON("/api/bitcoin/block", signal),
        getJSON("/api/bitcoin/price", signal),
        getJSON("/api/bitcoin/node", signal),
      ]);
      if (results.every((r) => r.status === "rejected")) throw new Error("Readings unavailable");
      const [block, price, node] = results.map((r) => r.status === "fulfilled" ? r.value : null);
      return { ...block, usd: price?.usd, node };
    },
    rows: (d) => [
      ["Block", number(d.height)],
      ["Price", finite(d.usd) ? `$${Math.round(d.usd).toLocaleString("en-US")}` : "—"],
      ["Since block", sinceBlock(d.timestamp * 1000) || "—"],
      ...bitcoinNodeRows(d.node),
    ],
  },
  // The machines themselves. A meter reads better than four more numbers, and
  // a machine that stopped reporting has to look different from an idle one —
  // dashed, dimmed, and saying so — rather than showing a confident 0%.
  talos: {
    url: "/api/insight/nodes",
    rows: (d) => (d.nodes?.length ? [] : null),
    unavailable: "The cluster is not reporting right now.",
    draw: (d) =>
      d.nodes?.length
        ? `<ul class="node-grid" tabindex="0" aria-label="Cluster nodes">${d.nodes
            .map((node) => {
              const known = finite(node.cpu) || finite(node.memoryTotal) || finite(node.pods);
              const memory =
                finite(node.memoryUsed) && finite(node.memoryTotal) && node.memoryTotal > 0
                  ? node.memoryUsed / node.memoryTotal
                  : null;
              return `<li class="node-card" data-state="${node.ready === false ? "not-ready" : known && node.ready === true ? "ready" : "unknown"}"><p class="node-head"><i class="node-dot" aria-hidden="true"></i>${esc(node.name)}<span>${
                known ? `${number(node.pods)} pods` : "silent"
              }</span></p><p class="node-status">${node.ready === true ? "Ready" : node.ready === false ? "Not ready" : "Readiness unknown"} · ${number(node.cores)} cores</p>${
                known
                  ? `${meter("CPU", node.cpu, finite(node.cpu) ? `${Math.round(node.cpu * 100)}%` : "—")}${meter("RAM", memory, finite(node.memoryUsed) && finite(node.memoryTotal) ? `${(node.memoryUsed / 1e9).toFixed(0)}/${(node.memoryTotal / 1e9).toFixed(0)} GB` : "—")}`
                  : `${meter("CPU", null, "—")}${meter("RAM", null, "—")}`
              }</li>`;
            })
            .join("")}</ul>`
        : "",
  },
  // Aggregates only, by construction: the feed behind this cannot return a
  // per-monitor row, so there is nothing here to accidentally render.
  watchtower: {
    url: "/api/insight/watch",
    rows: (d) =>
      finite(d.monitors)
        ? [
            ["Checks passing", finite(d.up) ? `${d.up}/${d.monitors}` : "—"],
            ["Failing", number(d.down)],
            ["Uptime · 30d (median)", finite(d.uptime30d) ? `${(d.uptime30d * 100).toFixed(1)}%` : "—"],
            ["Response (median)", finite(d.responseMs) ? `${Math.round(d.responseMs)}ms` : "—"],
            ["Soonest cert expiry", finite(d.certDays) ? `${Math.round(d.certDays)} days` : "—"],
          ]
        : null,
    unavailable: "The watch is not reporting right now.",
  },
  "lab-grafana": {
    url: "/api/insight/lab",
    rows: (d) => [
      ["Nodes", number(d.nodes)],
      ["Pods running", number(d.pods)],
      ["CPU cores", number(d.cores)],
      ["Namespaces", number(d.namespaces)],
    ],
  },
  scout: {
    url: "/api/insight/scout",
    rows: (d) =>
      d.configured
        ? [
            ["Roles tracked", number(d.tracked)],
            ["Last movement", relativeTime(d.lastMovement)],
          ]
        : null,
    unavailable: "The desk is not connected to this site.",
  },
  metrics: {
    url: "/api/insight/site",
    // The funnel, left to right: arrived, launched, read something, left for
    // the CV.
    rows: (d) => [
      ["Flying now", number(d.playing)],
      ["Flights · 24h", number(d.flights)],
      ["Dossiers read · 24h", number(d.notes)],
      ["Resume opened · 24h", number(d.resume)],
    ],
  },
  "metrics-flight": {
    url: "/api/insight/site",
    rows: (d) => [
      ["Flights · 24h", number(d.flights)],
      ["Avg flight (est.)", finite(d.avgFlightSeconds) ? `${Math.round(d.avgFlightSeconds)}s` : "—"],
      ["First frame (p50)", finite(d.readyP50) ? `${Math.round(d.readyP50)}ms` : "—"],
      ["Chart opened · 24h", number(d.charts)],
      ["No WebGL · 24h", number(d.fallbacks)],
    ],
  },
  "metrics-comm": {
    url: "/api/insight/site",
    rows: (d) => [
      ["COMM opened · 24h", number(d.commOpens)],
      ["Questions · 24h", number(d.chats)],
      ["Upstream errors", number(d.chatErrors)],
      ["Rate limited", number(d.throttled)],
    ],
  },
  "metrics-reading": {
    url: "/api/insight/site",
    rows: (d) =>
      (d.opened || []).slice(0, 5).map((row) => {
        const spec = catalog.bodies.find((b) => b.id === row.body);
        return [spec ? spec.name : row.body, number(row.reads)];
      }),
    unavailable: "No dossiers opened in the last week.",
  },
  "metrics-routes": {
    url: "/api/insight/site",
    rows: (d) =>
      (d.destinations || []).slice(0, 5).map((row) => {
        const spec = catalog.bodies.find((b) => b.id === row.body);
        return [spec ? spec.name : row.body, number(row.docks)];
      }),
    unavailable: "No orbits recorded in the last week.",
  },
};

function relativeTime(value) {
  const at = Date.parse(value || "");
  if (!Number.isFinite(at)) return "—";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

// The orbit panel and the nearby scanner read the same feeds. Without a shared
// cache, flying past Lab Grafana and then docking there asks the server twice
// for the same 30-second-old answer.
const feedCache = new Map();
const FEED_TTL = 30_000;

async function readFeed(id, feed, signal) {
  const hit = feedCache.get(id);
  if (hit && Date.now() - hit.at < FEED_TTL) return hit;
  const data = feed.read ? await feed.read(signal) : await getJSON(feed.url, signal);
  const reading = { at: Date.now(), data };
  feedCache.set(id, reading);
  return reading;
}

let liveReading = null;

// ---------------------------------------------------------------------------
// Nearby signals
//
// Readings you fly past rather than dock for. Three rules keep it calm: a
// source has to be closer than ENTER to be picked up and further than EXIT to
// be dropped, so a body you are circling does not blink in and out; a new
// source has to stay nearest for DWELL before it takes over, so two overlapping
// emitters do not trade the panel back and forth; and nothing is ever fetched
// from the render loop.
const SCANNER = { ENTER: 7, EXIT: 11, DWELL: 900, REFRESH: 30_000 };

// Two or three readings, not the whole orbit panel. Deliberately a subset of
// the same feeds, so a visitor who then enters orbit sees the same numbers.
const SCANNER_SOURCES = {
  watchtower: (d) => LIVE_FEEDS.watchtower.rows(d)?.filter((_, index) => [0, 2, 4].includes(index)) || [["Watch", "Not reporting"]],
  bitcoin: (d) => [
    ["Block", number(d.height)],
    ["Price", finite(d.usd) ? `$${Math.round(d.usd).toLocaleString("en-US")}` : "—"],
    ["Since block", sinceBlock(d.timestamp * 1000) || "—"],
  ],
  talos: (d) => {
    const nodes = d.nodes || [];
    if (!nodes.length) return [["Cluster", "Not reporting"]];
    const podReadings = nodes.filter(n => finite(n.pods));
    const reporting = nodes.filter((n) => finite(n.cpu));
    const busiest = reporting.slice().sort((a, b) => b.cpu - a.cpu)[0];
    return [
      ["Machines", `${reporting.length}/${nodes.length}`],
      ["Pods", `${podReadings.length ? number(podReadings.reduce((total, n) => total + n.pods, 0)) : "—"}${podReadings.length < nodes.length ? " · partial" : ""}`],
      ["Busiest", busiest ? `${busiest.name.replace(/^k8s-/, "")} ${Math.round(busiest.cpu * 100)}%` : "—"],
    ];
  },
  "lab-grafana": (d) => [
    ["Nodes", number(d.nodes)],
    ["Pods running", number(d.pods)],
    ["Namespaces", number(d.namespaces)],
  ],
  metrics: (d) => [
    ["Flying now", number(d.playing)],
    ["Flights · 24h", number(d.flights)],
    ["Dossiers · 24h", number(d.notes)],
  ],
  scout: (d) => (d.configured ? [["Roles tracked", number(d.tracked)]] : null),
};
const scannerIds = new Set(Object.keys(SCANNER_SOURCES).filter((id) => ids.has(id)));

const scanner = {
  expanded: false,
  maneuvering: false,
  pose: null,
  source: null,
  pinned: null,
  candidate: null,
  candidateSince: 0,
  inRange: [],
  data: null,
  received: 0,
  attempted: 0,
  failed: false,
  loading: false,
  controller: null,
  checked: 0,
};

function scannerVisible() {
  return scanner.source && started && !fallback && !activeDialog &&
    !document.body.matches(".in-orbit, .notes-open, .chart-mode, .survey-view");
}

function setScannerExpanded(expanded) {
  scanner.expanded = Boolean(expanded && scannerVisible() && !scanner.maneuvering);
  renderScanner();
}

function scannerName(id) {
  return catalog.bodies.find((b) => b.id === id)?.name || id;
}

// Called from the flight loop, so it does no work beyond distances and only
// looks at the clock a few times a second.
function scanNearby(state) {
  const now = Date.now();
  if (now - scanner.checked < 200) return;
  scanner.checked = now;
  scanner.pose = { x: state.x, z: state.z, heading: state.heading };
  // In orbit the panel is the expanded view of exactly this data. Scanning
  // alongside it would be a second reader of the same feed for no one.
  if (state.docked) {
    if (scanner.source) setScannerSource(null);
    return;
  }
  const near = nearbyEmitters(state, catalog.bodies, scannerIds, SCANNER.EXIT, scannerIds.size);
  scanner.inRange = near;
  const next = scannerChoice(scanner, near, now, SCANNER);
  if (next !== scanner.source) setScannerSource(next);
  else renderScanner();
}

function setScannerSource(id, pinned = false) {
  if (scanner.source === id && !pinned) return;
  scanner.controller?.abort();
  scanner.controller = id ? new AbortController() : null;
  scanner.source = id;
  if (!id) scanner.expanded = false;
  scanner.pinned = pinned ? id : null;
  scanner.candidate = null;
  scanner.data = null;
  scanner.received = 0;
  scanner.attempted = 0;
  scanner.failed = false;
  scanner.loading = false;
  renderScanner();
  if (id) refreshScanner();
}

async function refreshScanner() {
  const id = scanner.source;
  const feed = LIVE_FEEDS[id];
  if (!id || !feed || scanner.loading || document.hidden) return;
  scanner.loading = true;
  scanner.attempted = Date.now();
  const controller = scanner.controller;
  try {
    const reading = await readFeed(id, feed, controller.signal);
    // A late answer for a source we have already left is not this panel's
    // reading, whatever it says.
    if (scanner.source !== id || scanner.controller !== controller) return;
    scanner.data = reading.data;
    scanner.received = reading.at;
    scanner.failed = false;
  } catch {
    if (scanner.source === id && scanner.controller === controller) scanner.failed = true;
  } finally {
    if (scanner.source === id && scanner.controller === controller) scanner.loading = false;
    renderScanner();
  }
}

function renderScanner() {
  const panel = $("#nearby");
  if (!panel) return;
  const id = scanner.source;
  if (!scannerVisible()) {
    scanner.expanded = false;
    panel.dataset.state = "contact";
    $("#nearby-toggle").setAttribute("aria-expanded", "false");
    panel.hidden = true;
    return;
  }
  panel.dataset.state = scanner.expanded ? "locked" : "contact";
  $("#nearby-toggle").setAttribute("aria-expanded", String(scanner.expanded));
  $("#nearby-toggle").textContent = scanner.expanded ? "Collapse · Esc" : "Expand · F";
  const fullRows = scanner.expanded && scanner.data ? LIVE_FEEDS[id]?.rows(scanner.data) : null;
  const rows = fullRows?.length ? fullRows.slice(0, 4) : scanner.data ? SCANNER_SOURCES[id]?.(scanner.data) : null;
  const age = scanner.received ? Math.floor((Date.now() - scanner.received) / 1000) : null;
  const stale = scanner.failed || (age !== null && age > 90);
  panel.hidden = false;
  panel.classList.toggle("stale", stale);
  panel.style.setProperty("--orbit-color", catalog.bodies.find((b) => b.id === id)?.color || "#a5d9be");
  $("#nearby-name").textContent = scannerName(id);
  const rowHTML = rows?.length
    ? rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(String(value))}</dd></div>`).join("")
    : "";
  // A fresh DOM tree every scanner tick also announces the same reading over
  // and over. Update the live region only when its content actually changes.
  if ($("#nearby-rows").innerHTML !== rowHTML) $("#nearby-rows").innerHTML = rowHTML;
  $("#nearby-freshness").textContent = scanner.failed
    ? "Signal lost."
    : age === null
      ? "Scanning…"
      : `${stale ? "Stale · " : ""}${age}s ago`;
  // More than one emitter within reach: let the visitor choose rather than
  // guessing for them.
  const choices = scanner.inRange.filter((n) => n.distance <= SCANNER.ENTER).slice(0, 3);
  const sources = $("#nearby-sources");
  sources.hidden = choices.length < 2;
  panel.dataset.open = choices.length >= 2 ? "true" : "false";
  if (!sources.hidden) {
    const wanted = choices.map((n) => n.id).join(",");
    if (sources.dataset.ids !== wanted) {
      sources.dataset.ids = wanted;
      sources.innerHTML = choices
        .map((n) => `<button type="button" data-source="${esc(n.id)}">${esc(scannerName(n.id))}</button>`)
        .join("");
    }
    for (const button of sources.querySelectorAll("button"))
      button.setAttribute("aria-pressed", String(button.dataset.source === id));
  }
  renderBearing();
}

function renderBearing() {
  if (!scanner.expanded || !scanner.pose || !matchMedia("(min-width: 761px)").matches) return;
  const contacts = scanner.inRange.map(({ id }) => {
    const body = catalog.bodies.find((b) => b.id === id);
    return { id, ...emitterBearing(scanner.pose, body, catalog.bodies) };
  });
  $("#nearby-blips").innerHTML = contacts.map(({ id, bearing, distance }) => {
    const radius = Math.min(distance / SCANNER.EXIT, 1) * 70;
    return `<circle cx="${(90 + Math.sin(bearing) * radius).toFixed(1)}" cy="${(90 - Math.cos(bearing) * radius).toFixed(1)}" r="${id === scanner.source ? 4 : 2.5}" class="${id === scanner.source ? "selected" : "contact"}" />`;
  }).join("");
  const selected = contacts.find((c) => c.id === scanner.source);
  if (!selected) return;
  const degrees = Math.round(Math.abs(selected.bearing) * 180 / Math.PI);
  const direction = degrees === 0 ? "ahead" : `${degrees} degrees ${selected.bearing < 0 ? "left" : "right"}`;
  $("#nearby-bearing").setAttribute("aria-label", `${scannerName(scanner.source)}, range ${selected.distance.toFixed(1)}, bearing ${direction}`);
  $("#nearby-range").textContent = `RANGE ${selected.distance.toFixed(1)}`;
}

$("#nearby-sources")?.addEventListener("click", (event) => {
  const id = event.target.closest("button")?.dataset.source;
  if (id) setScannerSource(id, true);
});
$("#nearby-toggle").addEventListener("click", () => setScannerExpanded(!scanner.expanded));
$("#nearby").addEventListener("click", (event) => {
  if (!event.target.closest("button")) setScannerExpanded(!scanner.expanded);
});

// One timer, not the render loop: refresh at most every 30 seconds, and never
// while the tab is hidden.
setInterval(() => {
  if (!scanner.source || document.hidden) return;
  renderScanner();
  if (Date.now() - scanner.attempted >= SCANNER.REFRESH) refreshScanner();
}, 1000);

function stopLive() {
  liveReading?.controller.abort();
  liveReading = null;
}

function renderLive(reading) {
  if (liveReading !== reading || !reading.target.isConnected) return;
  reading.target.dataset.feed = reading.id;
  const rows = reading.data ? reading.feed.rows(reading.data) : null;
  const age = reading.received ? Math.max(0, Math.floor((Date.now() - reading.received) / 1000)) : null;
  const stale = reading.failed || (age !== null && age > 60);
  const status = reading.failed
    ? `Readings unavailable.${age === null ? " Retrying automatically." : ` Last received ${age}s ago.`}`
    : age === null ? "Connecting…" : `${stale ? "Stale · " : ""}Received ${age}s ago`;
  reading.target.classList.toggle("stale", stale);
  // Most feeds are a handful of labelled numbers. One is a schematic, so a
  // feed may draw its own body instead.
  const body = reading.feed.draw && reading.data
    ? reading.feed.draw(reading.data) || `<p class="live-note">${esc(reading.feed.unavailable || "No readings yet.")}</p>`
    : rows?.length
      ? `<dl>${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(String(value))}</dd></div>`).join("")}</dl>`
      : reading.data ? `<p class="live-note">${esc(reading.feed.unavailable || "No readings yet.")}</p>` : "";
  const previousGrid = reading.target.querySelector(".node-grid");
  const scrollTop = previousGrid?.scrollTop || 0;
  const restoreFocus = previousGrid && document.activeElement === previousGrid;
  reading.target.innerHTML =
    `<p class="eyebrow">${stale ? "LAST READING" : "LIVE READING"}</p>` +
    body +
    `<p class="live-freshness">${esc(status)}</p>`;
  const grid = reading.target.querySelector(".node-grid");
  if (grid) {
    grid.scrollTop = scrollTop;
    if (restoreFocus) grid.focus({ preventScroll: true });
  }
}

async function refreshLive() {
  const reading = liveReading;
  if (!reading || reading.loading || document.hidden) return;
  reading.loading = true;
  reading.attempted = Date.now();
  try {
    const cached = await readFeed(reading.id, reading.feed, reading.controller.signal);
    if (liveReading !== reading) return;
    reading.data = cached.data;
    reading.received = cached.at;
    reading.failed = false;
  } catch {
    if (liveReading !== reading) return;
    reading.failed = true;
  } finally {
    reading.loading = false;
    renderLive(reading);
  }
}

function startLive(spec, target) {
  stopLive();
  const feed = LIVE_FEEDS[spec.id];
  if (!feed || !target) return;
  liveReading = { id: spec.id, feed, target, data: null, received: null, attempted: 0, failed: false, loading: false, controller: new AbortController() };
  renderLive(liveReading);
  refreshLive();
}

setInterval(() => {
  if (!liveReading || document.hidden) return;
  renderLive(liveReading);
  if (Date.now() - liveReading.attempted >= 30_000) refreshLive();
}, 1000);

function stationHTML(spec, first, mode) {
  return `<p class="eyebrow">${mode} / ${String(catalog.bodies.indexOf(spec) + 1).padStart(2, "0")} <span class="dossier-sector">${esc(spec.sector)}</span></p><div class="dossier-emblem" style="--body-color:${spec.color}" aria-hidden="true">${emblems[spec.id] || "◉"}</div><h2 id="station-title">${esc(spec.name)}</h2><p class="dossier-subtitle">${esc(spec.subtitle)}</p><p class="dossier-lead">${esc(spec.blurb)}</p>${spec.details.map((p) => `<p>${esc(p)}</p>`).join("")}<ul class="tags">${spec.tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul><p class="field-note"><span class="eyebrow">FIELD NOTE ${first ? "RECORDED" : "REVISITED"}</span>${esc(spec.lesson)}</p>${spec.href ? `<a class="dossier-link" href="${esc(spec.href)}">${esc(spec.linkLabel)} <span aria-hidden="true">↗</span></a>` : ""}${spec.id === "bitcoin" ? '<button id="station-bitcoin" class="dossier-link">Open live telemetry ↗</button>' : ""}`;
}
function fillStation(spec) {
  const parent = catalog.bodies.find((b) => b.id === spec.parent);
  const family = catalog.bodies.filter(
    (b) => b.parent === (spec.parent || spec.id),
  );
  const destinations = parent
    ? [parent, ...family.filter((b) => b.id !== spec.id)]
    : family;
  $("#station-body").innerHTML =
    `<div class="orbit-summary"><p class="eyebrow">${spec.id === "survey" ? "SURVEY ARRAY" : "ORBIT ESTABLISHED"} / ${esc(spec.sector)}</p><h2 id="station-title">${esc(spec.name)}</h2><p>${esc(spec.blurb)}</p><div class="orbit-topics">${spec.tags
      .slice(0, 4)
      .map((tag) => `<span>${esc(tag)}</span>`)
      .join(
        "",
      )}${spec.href ? `<a href="${esc(spec.href)}">${esc(spec.linkLabel)} ↗</a>` : ""}</div></div><div class="orbit-neighbors"><p class="eyebrow">${parent ? esc(parent.name) + " / NEARBY" : "MOONS / " + destinations.length}</p><div>${destinations.map((b) => `<button data-neighbor="${b.id}" style="--body-color:${b.color}"><span>◌</span>${esc(b.name)}<span>↗</span></button>`).join("") || '<button data-neighbor="survey">Survey array ↗</button>'}</div></div>${LIVE_FEEDS[spec.id] ? '<div class="orbit-live"></div>' : ""}`;
  $("#station-body")
    .querySelectorAll("[data-neighbor]")
    .forEach((button) =>
      button.addEventListener("click", () => navigate(button.dataset.neighbor)),
    );
  // The class goes on the panel, not the scroll area: the console has a fixed
  // max height and the readings row needs the container to grow, not just the
  // inner grid.
  $("#station").classList.toggle("has-live", Boolean(LIVE_FEEDS[spec.id]));
  startLive(spec, $("#station-body .orbit-live"));
  setNotesExpanded(false);
  $("#orbit-notes-title").textContent = spec.name;
  $("#orbit-notes-content").innerHTML =
    `<p class="notes-intro">${esc(spec.blurb)}</p>${spec.details.map((p) => `<p>${esc(p)}</p>`).join("")}<ul class="tags">${spec.tags.map((tag) => `<li>${esc(tag)}</li>`).join("")}</ul><p class="field-note">${esc(spec.lesson)}</p>${spec.href ? `<a class="notes-link" href="${esc(spec.href)}">${esc(spec.linkLabel)} ↗</a>` : ""}${spec.id === "bitcoin" ? '<button id="orbit-bitcoin">Open live telemetry ↗</button>' : ""}`;
  $("#orbit-bitcoin")?.addEventListener("click", () =>
    openDialog("#telemetry"),
  );
  $("#station").hidden = false;
  $("#station").classList.add("open");
  $("#station").classList.toggle("survey-dock", spec.id === "survey");
  document.body.classList.add("in-orbit");
  document.body.style.setProperty("--orbit-color", spec.color);
  comm.setScope(spec);
}
function setNotesExpanded(expanded) {
  $("#station").classList.toggle("notes-expanded", expanded);
  document.body.classList.toggle("notes-open", expanded);
  if ($("#orbit-notes")) $("#orbit-notes").hidden = !expanded;
  $("#station-notes").setAttribute("aria-expanded", String(expanded));
  $("#station-notes").textContent = expanded ? "Close notes" : "Read notes";
}
function hideStation() {
  stopLive();
  setNotesExpanded(false);
  $("#station").hidden = true;
  $("#station").classList.remove("open", "survey-dock");
  document.body.classList.remove("in-orbit");
  comm.setScope(null);
}
function readNotes(spec, source = "orbit") {
  telemetry("notes", { body: spec.id, source });
  $("#dossier-body").innerHTML = stationHTML(
    spec,
    !visited.has(spec.id),
    "NOTES",
  ).replace('id="station-title"', 'id="dossier-title"');
  $("#dossier-body")
    .querySelector("#station-bitcoin")
    ?.addEventListener("click", () => openDialog("#telemetry"));
  openDialog("#dossier");
}
function undock() {
  hideStation();
  world?.undock();
  closeDialog();
  telemetry("undock");
}
function dock(spec) {
  if (!spec) return;
  $("#toast").classList.remove("visible");
  const before = achievements({ visited, collected, bodies: catalog.bodies }),
    first = !visited.has(spec.id);
  lastDockId = spec.id;
  visited.add(spec.id);
  persist();
  updateDiscoveries();
  $("#approach").hidden = true;
  $("#flight-guide").hidden = true;
  telemetry(spec.id === "survey" ? "survey" : "dock", { body: spec.id });
  if (fallback) readNotes(spec, "fallback");
  else fillStation(spec);
  const after = achievements({ visited, collected, bodies: catalog.bodies });
  if (after.gitops && !before.gitops)
    toast(
      "Instrument unlocked: GitOps lens. Open Instruments to trace the connection.",
    );
  else if (after.signal && !before.signal)
    toast(
      "Instrument unlocked: Signal decoder. More live context is now available.",
    );
  else if (after.surveyor && !before.surveyor)
    toast("Survey view. Select a destination on the chart.");
  else if (after.hopper && !before.hopper)
    toast("Moon hopper: three satellites logged.");
  else if (after.collector && !before.collector)
    toast("All signal buoys recovered.");
}
function collect(signal) {
  telemetry("collect", { signal: signal.id });
  const before = achievements({ visited, collected, bodies: catalog.bodies });
  collected.add(signal.id);
  persist();
  if (world?.state.collected) world.state.collected.add(signal.id);
  updateDiscoveries();
  const after = achievements({ visited, collected, bodies: catalog.bodies });
  toast(
    after.collector && !before.collector
      ? "All signal buoys recovered."
      : `Signal buoy: ${signal.name}. ${signal.note}`,
  );
}
function updateDiscoveries() {
  $("#visited-count").textContent = String(visited.size).padStart(2, "0");
  $("#visited-total").textContent = String(totalBodies).padStart(2, "0");
  $("#collect-count").textContent = String(collected.size).padStart(2, "0");
  $("#visit-marks").innerHTML = catalog.bodies
    .map(
      (b) =>
        `<i class="${visited.has(b.id) ? "visited" : ""}" style="--body-color:${b.color}"></i>`,
    )
    .join("");
  labels.forEach((el, id) => {
    el.classList.toggle("visited", visited.has(id));
    el.setAttribute(
      "aria-label",
      `Fly to ${catalog.bodies.find((b) => b.id === id).name}${visited.has(id) ? ", visited" : ""}`,
    );
  });
  const u = achievements({ visited, collected, bodies: catalog.bodies });
  $("#unlock-count").textContent =
    `${Number(u.gitops) + Number(u.signal) + Number(u.surveyor) + Number(u.hopper) + Number(u.collector)}/5`;
  $("#gitops-toggle").disabled = !u.gitops;
  $("#gitops-toggle").textContent = u.gitops
    ? lens
      ? "Hide GitOps lens"
      : "Activate GitOps lens"
    : "Visit Platform + Homelab";
  $("#gitops-badge").textContent = u.gitops ? "UNLOCKED / 01" : "LOCKED / 01";
  $("#signal-toggle").disabled = !u.signal;
  $("#signal-toggle").textContent = u.signal
    ? "Open signal decoder ↗"
    : "Visit Observability + Bitcoin";
  $("#signal-badge").textContent = u.signal ? "UNLOCKED / 02" : "LOCKED / 02";
  $("#signal-detail").hidden = !u.signal;
  $("#signal-locked").hidden = u.signal;
  $("#surveyor-badge").textContent = u.surveyor
    ? "UNLOCKED / 03"
    : "LOCKED / 03";
  $("#hopper-badge").textContent = u.hopper ? "UNLOCKED / 04" : "LOCKED / 04";
  $("#collector-badge").textContent = u.collector
    ? "UNLOCKED / 05"
    : "LOCKED / 05";
}
for (const [index, body] of catalog.bodies.entries()) {
  const label = document.createElement("button");
  label.className = `body-label${body.parent ? " moon-label" : ""}`;
  label.dataset.id = body.id;
  label.style.setProperty("--body-color", body.color);
  label.innerHTML = `<span class="label-index">${String(index + 1).padStart(2, "0")}</span><span>${esc(body.name)}<small>${esc(body.subtitle)}</small></span><span class="label-visited" aria-hidden="true">✓</span>`;
  label.addEventListener("click", () => navigate(body.id));
  labels.set(body.id, label);
  $("#body-labels").append(label);
}
let chartFocus = null;
function drawChart() {
  renderChart({
    catalog,
    visited,
    state: world?.state,
    lens,
    focus: chartFocus,
    chooseFocus(id) {
      chartFocus = id;
      drawChart();
    },
    navigate,
  });
}
function showFallback(reason) {
  if (!fallback) telemetry("fallback");
  fallback = true;
  world?.stop();
  document.body.classList.add("chart-mode");
  $("#intro").hidden = true;
  $("#fallback").hidden = false;
  $("#fallback-reason").textContent = reason;
  $("#body-labels").hidden = true;
  $("#flight-guide").hidden = true;
  $("#touch-controls").hidden = true;
  $("#approach").hidden = true;
  $("#relay-panel").hidden = true;
  $("#relay-toggle").hidden = true;
  hideStation();
  document.body.classList.remove("cockpit-view", "survey-view", "overhead-view");
  $("#canopy-hud").hidden = true;
  $("#console-toggle").hidden = true;
  document.body.classList.remove("instruments-open");
  $("#map-toggle").disabled = false;
  $("#quality-toggle").hidden = true;
  $("#camera-toggle").hidden = true;
  $("#overhead-toggle").hidden = true;
  $("#flight-status").textContent = "Chart mode";
  $("#flight-detail").textContent = "Choose a destination to read its notes.";
}
$("#launch").addEventListener("click", () => {
  if (fallback || started) return;
  fetch("/api/launch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visitor, session: sessionContext() }),
    keepalive: true,
  }).catch(() => {});
  start();
  $("#launch").blur();
});
$("#map-toggle").addEventListener("click", () => {
  telemetry("chart");
  openDialog("#chart");
});
$("#fallback-chart").addEventListener("click", () => openDialog("#chart"));
$("#guide-close").addEventListener("click", () => {
  $("#flight-guide").hidden = true;
});
$("#dock-button").addEventListener("click", () => world?.dock());
function sessionContext() {
  let timezone = "", referrer = "";
  try { referrer = new URL(document.referrer).origin; } catch {}
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {}
  return {
    timezone,
    referrer,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    screenWidth: window.screen?.width,
    screenHeight: window.screen?.height,
    visited: visited.size,
    buoys: collected.size,
    aloftMs: startedAt ? Date.now() - startedAt : 0,
  };
}
function setRelayExpanded(expanded) {
  relayExpanded = expanded;
  $("#relay-toggle").setAttribute("aria-expanded", String(expanded));
  $("#relay-panel").hidden = !expanded;
}
$("#relay-toggle").addEventListener("click", () => {
  setRelayExpanded(!relayExpanded);
  if (relayExpanded) $("#relay-who").focus({ preventScroll: true });
});
$("#relay-close").addEventListener("click", () => {
  setRelayExpanded(false);
  $("#relay-toggle").focus({ preventScroll: true });
});
$("#relay-panel").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeRelay || !relayReady) return;
  const status = $("#relay-status");
  status.textContent = "Transmitting…";
  $("#relay-send").disabled = true;
  try {
    const response = await fetch("/api/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        visitor,
        relayId: activeRelay.id,
        name: $("#relay-who").value,
        note: $("#relay-note").value,
        near: activeRelay.name,
        heading: world?.state?.heading,
        height: lastHeight,
        session: sessionContext(),
      }),
    });
    const data = await response.json().catch(() => ({}));
    status.textContent =
      response.status === 429
        ? "The relay is cooling down."
        : response.ok
          ? "Ping away. If Gio is awake, he’ll see it."
          : data.error || "Relay dark.";
    if (response.ok) {
      $("#relay-note").value = "";
      toast("Ping transmitted.");
    }
  } catch {
    status.textContent = "Relay dark.";
  } finally {
    $("#relay-send").disabled = false;
  }
});
$("#undock").addEventListener("click", closeDialog);
$("#station-notes").addEventListener("click", () => {
  if (activeDialog?.id === "comm-hud") closeDialog();
  const opening = $("#orbit-notes").hidden;
  if (opening && lastDockId) telemetry("notes", { body: lastDockId, source: "orbit" });
  setNotesExpanded(opening);
});
$("#notes-close").addEventListener("click", () => {
  setNotesExpanded(false);
  $("#station-notes").focus();
});
$("#station-undock").addEventListener("click", undock);
$("#next-body").addEventListener("click", () => {
  const index = catalog.bodies.findIndex((b) => b.id === lastDockId);
  const next =
    [
      ...catalog.bodies.slice(index + 1),
      ...catalog.bodies.slice(0, index + 1),
    ].find((b) => !visited.has(b.id)) ||
    catalog.bodies[(index + 1) % catalog.bodies.length];
  navigate(next.id);
});
$("#station-next").addEventListener("click", () => $("#next-body").click());
$("#bitcoin-toggle").addEventListener("click", () => openDialog("#telemetry"));
$("#instruments-toggle").addEventListener("click", () =>
  openDialog("#instruments"),
);
$("#help-toggle").addEventListener("click", () => openDialog("#help"));
function setConsoleOpen(open) {
  document.body.classList.toggle("instruments-open", open);
  $("#console-toggle").setAttribute("aria-pressed", String(open));
}
$("#console-toggle").addEventListener("click", () =>
  setConsoleOpen(!document.body.classList.contains("instruments-open")),
);
$("#camera-toggle").addEventListener("click", () => world?.cycleCamera());
$("#overhead-toggle")?.addEventListener("click", () => world?.setOverhead());
$("#survey-jump").addEventListener("click", () => navigate("survey"));
$("#chart-mode").addEventListener("click", () => {
  closeDialog();
  showFallback(
    "Explore the star chart without 3D, or head straight to my resume. Reload this page to return to flight.",
  );
});
$("#quality-toggle").addEventListener("click", () => world?.setLow(!low));
$("#gitops-toggle").addEventListener("click", () => {
  lens = !lens;
  world?.setLens(lens);
  $("#gitops-toggle").setAttribute("aria-pressed", String(lens));
  updateDiscoveries();
  closeDialog();
  if (fallback) openDialog("#chart");
  else
    toast(
      lens
        ? "GitOps lens active: Platform → Homelab → BitOps. Shared practice, distinct environments."
        : "GitOps lens hidden.",
    );
});
$("#signal-toggle").addEventListener("click", () => openDialog("#telemetry"));
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyF" && !e.repeat && !e.target.closest("input, textarea, select, [contenteditable]") && scannerVisible()) {
    e.preventDefault();
    setScannerExpanded(!scanner.expanded);
  }
  if (e.code === "Escape" && scanner.expanded) {
    e.preventDefault();
    setScannerExpanded(false);
    return;
  }
  if (e.code === "KeyM" && !e.repeat && !e.target.closest("input, textarea")) {
    e.preventDefault();
    if (activeDialog?.id === "chart") closeDialog();
    else if (!$("#map-toggle").disabled) openDialog("#chart");
  }
  if (
    e.code === "KeyI" &&
    !e.repeat &&
    !e.target.closest("input, textarea") &&
    started &&
    !fallback &&
    !document.body.classList.contains("in-orbit")
  ) {
    e.preventDefault();
    setConsoleOpen(!document.body.classList.contains("instruments-open"));
  }
  if (e.code === "Escape" && activeDialog && !activeDialog.matches(":modal")) {
    e.preventDefault();
    closeDialog();
    return;
  }
  if (e.code === "Escape" && !activeDialog && started) {
    if (relayExpanded) {
      setRelayExpanded(false);
      $("#relay-toggle").focus({ preventScroll: true });
      return;
    }
    if ($("#station").classList.contains("notes-expanded")) {
      setNotesExpanded(false);
      $("#station-notes").focus();
      return;
    }
    if (world?.state.docked) {
      undock();
      toast("Leaving orbit.");
    } else {
      world?.cancel();
      toast("Assisted flight cancelled. You have the controls.");
    }
  }
});
const joystick = $("#joystick");
let stickPointer = null;
function steer(e) {
  const r = joystick.getBoundingClientRect(),
    x = (e.clientX - r.left - r.width / 2) / 35,
    z = (e.clientY - r.top - r.height / 2) / 35,
    length = Math.max(1, Math.hypot(x, z));
  world?.setStick(x / length, z / length);
  $("#joystick-knob").style.transform =
    `translate(${(x / length) * 27}px, ${(z / length) * 27}px)`;
}
joystick.addEventListener("pointerdown", (e) => {
  if (!started) return;
  stickPointer = e.pointerId;
  joystick.setPointerCapture(e.pointerId);
  steer(e);
});
joystick.addEventListener("pointermove", (e) => {
  if (e.pointerId === stickPointer) steer(e);
});
function releaseStick() {
  stickPointer = null;
  world?.setStick(0, 0);
  $("#joystick-knob").style.transform = "";
}
joystick.addEventListener("pointerup", releaseStick);
joystick.addEventListener("pointercancel", releaseStick);
joystick.addEventListener("lostpointercapture", releaseStick);
window.addEventListener("blur", releaseStick);
// Pull the stick back to brake; the button is boost. Holding it burns.
$("#touch-boost").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  e.currentTarget.setPointerCapture(e.pointerId);
  $("#touch-boost").classList.add("held");
  world?.setBoost(true);
});
for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
  $("#touch-boost").addEventListener(event, () => {
    $("#touch-boost").classList.remove("held");
    world?.setBoost(false);
  });
window.addEventListener("blur", () => {
  $("#touch-boost").classList.remove("held");
  world?.setBoost(false);
});

async function getJSON(url, signal) {
  const r = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6500)]) : AbortSignal.timeout(6500),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const number = (value) =>
  finite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : "—";
let bitcoinConnection = "CONNECTING";
function updateFreshness() {
  if (bitcoinLoadedAt && Date.now() - bitcoinLoadedAt > 60_000) {
    $("#bitcoin-state").textContent = "STALE";
    $("#bitcoin-led").className = "status-dot offline";
  }
  $("#bitcoin-freshness").textContent = bitcoinLoadedAt
    ? `${bitcoinConnection === "PARTIAL" ? "Partial downlink · " : ""}Last received ${Math.floor((Date.now() - bitcoinLoadedAt) / 1000)}s ago · homelab mempool`
    : "Downlink unavailable. No live data to display; reconnecting automatically.";
}
// The block clock has to tick between polls, so it renders on its own timer.
function sinceBlock(minedAt = blockMinedAt) {
  if (!finite(minedAt) || !minedAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - minedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}
function renderBitcoinExtras() {
  const priceEl = $("#btc-price"),
    sinceEl = $("#btc-since");
  if (!priceEl || !sinceEl) return;
  priceEl.textContent = btcPrice
    ? `$${Math.round(btcPrice).toLocaleString("en-US")}`
    : "—";
  const elapsed = sinceBlock();
  sinceEl.textContent = elapsed ? `${elapsed} since block` : "—";
}
setInterval(renderBitcoinExtras, 1000);

// Coarse pointers get the touch controls, so the readout should name them.
const touchControls = matchMedia("(pointer: coarse)").matches;

let loadingBitcoin = false;
async function loadBitcoin() {
  if (document.hidden || loadingBitcoin) return;
  loadingBitcoin = true;
  const results = await Promise.allSettled([
    getJSON("/api/bitcoin/tip"),
    getJSON("/api/bitcoin/mempool"),
    getJSON("/api/bitcoin/fees"),
    getJSON("/api/bitcoin/price"),
    getJSON("/api/bitcoin/block"),
  ]);
  const data = results.map((r) => (r.status === "fulfilled" ? r.value : null)),
    [tip, mempool, fees, price, block] = data;
  btcPrice = finite(price?.usd) ? price.usd : null;
  blockMinedAt = finite(block?.timestamp) ? block.timestamp * 1000 : null;
  blockTransactions = finite(block?.transactions) ? block.transactions : null;
  renderBitcoinExtras();
  const valid = [
    finite(tip?.height),
    finite(mempool?.count),
    finite(fees?.fastestFee),
  ];
  lastHeight = valid[0] ? tip.height : lastHeight;
  $("#block").textContent = $("#telemetry-block").textContent = valid[0]
    ? number(tip.height)
    : "—";
  $("#mempool").textContent = valid[1] ? number(mempool.count) : "—";
  $("#fee").textContent = valid[2] ? number(fees.fastestFee) : "—";
  $("#fee-half").textContent = number(fees?.halfHourFee);
  $("#fee-hour").textContent = number(fees?.hourFee);
  $("#backlog").textContent = finite(mempool?.vsize)
    ? number(mempool.vsize / 1_000_000)
    : "—";
  const all = valid.every(Boolean),
    some = valid.some(Boolean);
  bitcoinConnection = all ? "LIVE" : some ? "PARTIAL" : "OFFLINE";
  $("#bitcoin-state").textContent = bitcoinConnection;
  $("#bitcoin-led").className = `status-dot ${all ? "live" : "offline"}`;
  bitcoinLoadedAt = some ? Date.now() : null;
  updateFreshness();
  loadingBitcoin = false;
}
async function loadTip() {
  try {
    const tip = await getJSON("/api/tip");
    if (
      typeof tip.lightningAddress === "string" &&
      /^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(tip.lightningAddress)
    )
      tipDestination = `lightning:${tip.lightningAddress}`;
    else if (
      typeof tip.btcpayUrl === "string" &&
      /^https?:\/\//i.test(tip.btcpayUrl)
    )
      tipDestination = tip.btcpayUrl;
    tipLoaded = true;
    $("#tip-status").textContent = tipDestination
      ? "Opens the configured payment destination."
      : "Tipping is not configured yet.";
  } catch {
    $("#tip-status").textContent =
      "Payment destination unavailable. Try again shortly.";
  }
}
$("#tip-button").addEventListener("click", async () => {
  if (!tipLoaded) await loadTip();
  if (tipDestination) window.location.assign(tipDestination);
  else
    toast(
      tipLoaded
        ? "No payment destination is configured. Thanks for the thought."
        : "Could not reach the payment settings. Please try again later.",
    );
});
// The console toggle sits above the instrument bar. The bar's height depends
// on its content and the viewport, so measure it instead of guessing.
function trackCockpitHeight() {
  const cockpit = document.querySelector("footer.cockpit");
  if (!cockpit) return;
  const apply = () =>
    document.body.style.setProperty(
      "--cockpit-height",
      `${Math.round(cockpit.getBoundingClientRect().height)}px`,
    );
  apply();
  if (typeof ResizeObserver === "function")
    new ResizeObserver(apply).observe(cockpit);
  window.addEventListener("resize", apply);
}
trackCockpitHeight();

setInterval(() => {
  if (started && !fallback && !document.hidden) telemetry("heartbeat");
}, 15_000);
loadBitcoin();
loadTip();
setInterval(loadBitcoin, 30_000);
setInterval(() => {
  if (!document.hidden) updateFreshness();
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    setScannerSource(null);
  } else {
    loadBitcoin();
    refreshLive();
  }
});
updateDiscoveries();
// `world` is only assigned once createWorld returns. On a slow device that
// build can outlast the timeout, which then declared a fallback while the
// scene was in fact coming up. The intro stayed hidden, onReady still enabled
// the launch button and wrote "Ready for flight", and pressing it hit the
// `if (fallback) return` in start(), so nothing happened. Track that
// construction began, and keep a longer net for a build that truly hangs.
let worldStarting = false;
const loadingTimeout = setTimeout(() => {
  if (!world && !worldStarting)
    showFallback(
      "The 3D scene is taking too long to start. Explore the chart, or read my resume.",
    );
}, 8000);
const buildTimeout = setTimeout(() => {
  if (!document.body.classList.contains("ready"))
    showFallback(
      "The 3D scene is taking too long to start. Explore the chart, or read my resume.",
    );
}, 25_000);
try {
  const { createWorld } = await import("./world.js");
  if (!fallback) {
    worldStarting = true;
    world = createWorld($("#scene"), catalog, {
      onDock: dock,
      onNavigate: navigate,
      onCollect: collect,
      onBoost() {
        telemetry("boost");
      },
      onView(next) {
        telemetry("camera", { mode: next });
        view = next;
        document.body.classList.toggle("cockpit-view", next === "cockpit");
        document.body.classList.toggle("survey-view", next === "survey");
        document.body.classList.toggle("overhead-view", next === "overhead");
        $("#camera-toggle").setAttribute("aria-pressed", "false");
        $("#overhead-toggle")?.setAttribute(
          "aria-pressed",
          String(next === "overhead"),
        );
        $("#camera-label").textContent = "Cycle cam";
        if ($("#overhead-label")) $("#overhead-label").textContent = "Plan cam";
      },
      onReady(value) {
        clearTimeout(loadingTimeout);
        clearTimeout(buildTimeout);
        low = value;
        // Browser-reported time to the first rendered frame. The reviews kept
        // noting real-device performance was never measured; this measures it.
        const frame = performance.getEntriesByName("orrery-first-frame")[0];
        telemetry("ready", {
          ms: Math.round(frame ? frame.startTime : performance.now()),
          quality: value ? "low" : "full",
        });
        $("#intro-flight-state").classList.add("ready");
        $("#intro-flight-state span").textContent = "Ready for flight";
        $("#launch").disabled = false;
        $("#launch").textContent = "Take the controls  ↗";
        $("#map-toggle").disabled = false;
        $("#quality-toggle").setAttribute("aria-pressed", String(low));
        $("#quality-label").textContent = low
          ? "Full graphics"
          : "Low graphics";
        document.body.classList.add("ready");
        if (world?.state) {
          for (const id of collected) world.state.collected.add(id);
        }
      },
      onFailure: showFallback,
      onQuality(value) {
        low = value;
        $("#quality-toggle").setAttribute("aria-pressed", String(low));
        $("#quality-label").textContent = low
          ? "Full graphics"
          : "Low graphics";
      },
      onProject(id, x, y, visible) {
        const el = labels.get(id);
        const spec = catalog.bodies.find((b) => b.id === id);
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
        el.style.visibility =
          visible && relayUnlocked(spec) ? "visible" : "hidden";
      },
      onFlightInput(input) {
        scanner.maneuvering = input.thrust > 0.05 || input.brake || input.boost;
        if (scanner.maneuvering && scanner.expanded) setScannerExpanded(false);
      },
      onState(state) {
        if (!started || fallback) return;
        scanNearby(state);
        const target = catalog.bodies.find((b) => b.id === state.target),
          nearest = catalog.bodies.find((b) => b.id === state.nearest),
          docked = catalog.bodies.find((b) => b.id === state.docked);
        const speed = Math.hypot(state.vx, state.vz);
        $("#flight-status").textContent = docked
          ? `${view === "survey" ? "Survey" : "Orbit"} · ${docked.name}`
          : target
            ? `En route · ${target.name}`
            : view === "cockpit"
              ? "Cockpit"
              : "Free flight";
        $("#flight-detail").textContent = target
          ? "Assisted flight · steer to take over"
          : docked
            ? "Parking orbit · Esc to leave"
            : touchControls
              ? "Drag to steer · pull back to brake · hold BOOST"
              : "W forward · A / D turn · S brake · M chart";
        $("#hud-speed").textContent = speed.toFixed(1);
        $("#notes-bearing").textContent =
          $("#orbit-bearing").textContent =
          $("#hud-heading").textContent =
            `${((state.heading * 180) / Math.PI + 360) % 360 | 0}°`;
        $("#hud-target").textContent = docked
          ? docked.name
          : target
            ? target.name
            : nearest && state.distance < 14
              ? nearest.name
              : "—";
        const approaching =
          !!nearest &&
          nearest.kind !== "relay" &&
          state.distance <= DOCK_MARGIN &&
          !docked &&
          !target &&
          !activeDialog;
        $("#approach").hidden = !approaching;
        // The Enter orbit prompt and the Console toggle share the bottom of a
        // phone screen. Let the layout move one out of the other's way.
        document.body.classList.toggle("approaching", approaching);
        if (nearest && nearest.kind !== "relay")
          $("#approach-name").textContent = `${nearest.name} · orbit available`;
        const relay =
          nearest?.kind === "relay" &&
          relayUnlocked(nearest) &&
          state.distance < DOCK_MARGIN + 1.8
            ? nearest
            : docked?.kind === "relay" && relayUnlocked(docked)
              ? docked
              : null;
        if (activeRelay?.id !== relay?.id || activeDialog) setRelayExpanded(false);
        activeRelay = relay;
        $("#relay-toggle").hidden = !relay || !relayReady || !!activeDialog;
        $("#relay-panel").hidden = !relay || !relayReady || !!activeDialog || !relayExpanded;
        if (relay) {
          $("#relay-toggle").textContent = `Ping · ${relay.name}`;
          $("#relay-title").textContent = relay.name;
          $("#relay-copy").textContent = relay.blurb;
        }
        labels.forEach((el, id) => {
          const spec = catalog.bodies.find((b) => b.id === id);
          if (spec?.unlock) el.hidden = !relayUnlocked(spec);
        });
        labels.forEach((el, id) =>
          el.classList.toggle(
            "targeted",
            id === state.target || id === state.docked,
          ),
        );
      },
    });
  }
} catch (error) {
  clearTimeout(loadingTimeout);
  clearTimeout(buildTimeout);
  console.warn("Orrery could not start:", error.message);
  showFallback(
    "This device could not start the 3D scene. Explore every destination in the chart, or read my resume.",
  );
}

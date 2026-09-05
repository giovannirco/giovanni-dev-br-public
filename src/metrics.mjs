import catalog from "../data/projects.json" with { type: "json" };
import { isPrivateAddress } from "./client.mjs";

const PLAYING_MS = 90_000;
// Visitor ids arrive from the browser, so the set of ids ever seen is
// attacker-growable. Cap it: past this point the gauge stops climbing rather
// than growing the heap against the pod's 512Mi limit.
const SEEN_CAP = 50_000;
const BODY_IDS = new Set(catalog.bodies.map((body) => body.id));
const SIGNAL_IDS = new Set(catalog.signals.map((signal) => signal.id));
const CAMERA_MODES = new Set(["overhead", "explore", "cockpit", "survey"]);
const VISITOR_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const EVENTS = new Set([
  "play",
  "heartbeat",
  "dock",
  "undock",
  "collect",
  "camera",
  "boost",
  "survey",
  "notes",
  "chart",
  "comm",
  "resume",
  "ready",
  "fallback",
]);

// Where a visitor opened a dossier from. Bounded on purpose: body ids times
// this set is the whole series count for notes.
const NOTE_SOURCES = new Set(["preview", "orbit", "fallback"]);

// Browser-reported time to the first rendered frame. Real-device performance
// was the one thing the reviews kept saying was unmeasured.
const READY_BUCKETS = [250, 500, 1000, 2000, 4000, 8000];

export function metricsDenied(req) {
  // Scrapes come from Alloy inside the cluster. A connection that did not
  // arrive from a private peer has no business reading the counters, whatever
  // it claims in its headers.
  if (!isPrivateAddress(req.socket?.remoteAddress)) return true;
  const host = (req.headers.host || "").split(":")[0]?.toLowerCase() || "";
  if (host === "giovanni.dev.br" || host === "www.giovanni.dev.br") return true;
  if (req.headers["x-forwarded-for"] || req.headers["x-envoy-external-address"])
    return true;
  return false;
}

function bump(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

export function createMetrics({ now = () => Date.now(), maxVisitors = SEEN_CAP } = {}) {
  const visitors = new Map();
  const seen = new Set();
  const docks = new Map();
  const collects = new Map();
  const cameras = new Map();
  const notes = new Map();
  const schemes = new Map();
  const readyBuckets = Object.fromEntries(READY_BUCKETS.map((b) => [b, 0]));
  let readySum = 0,
    readyCount = 0;
  const counters = {
    play: 0,
    heartbeat: 0,
    undock: 0,
    chat: 0,
    chatError: 0,
    chatThrottled: 0,
    chart: 0,
    comm: 0,
    resume: 0,
    fallback: 0,
    lowGraphics: 0,
    launch: 0,
    launchFailed: 0,
    relay: 0,
    relayFailed: 0,
    boost: 0,
    survey: 0,
    telemetryReject: 0,
  };

  function playing() {
    const time = now();
    let n = 0;
    for (const [id, at] of visitors) {
      if (time - at > PLAYING_MS) visitors.delete(id);
      else n += 1;
    }
    return n;
  }

  function ingest(body) {
    const visitor = typeof body?.visitor === "string" ? body.visitor : "";
    const event = typeof body?.event === "string" ? body.event : "";
    if (!VISITOR_RE.test(visitor) || !EVENTS.has(event) ||
        (event === "dock" && !BODY_IDS.has(body.body)) ||
        (event === "collect" && !SIGNAL_IDS.has(body.signal)) ||
        (event === "camera" && !CAMERA_MODES.has(body.mode)) ||
        (event === "notes" && (!BODY_IDS.has(body.body) || !NOTE_SOURCES.has(body.source)))) {
      counters.telemetryReject += 1;
      return false;
    }
    const time = now();
    visitors.delete(visitor);
    visitors.set(visitor, time);
    if (visitors.size > maxVisitors) {
      playing();
      while (visitors.size > maxVisitors) visitors.delete(visitors.keys().next().value);
    }
    if (seen.size < SEEN_CAP) seen.add(visitor);
    if (event === "play") counters.play += 1;
    if (event === "heartbeat") counters.heartbeat += 1;
    if (event === "undock") counters.undock += 1;
    if (event === "boost") counters.boost += 1;
    if (event === "survey") counters.survey += 1;
    if (event === "dock")
      bump(docks, body.body);
    if (event === "collect")
      bump(collects, body.signal);
    if (event === "camera")
      bump(cameras, body.mode);
    if (event === "notes") bump(notes, `${body.body}|${body.source}`);
    if (event === "chart") counters.chart += 1;
    if (event === "comm") counters.comm += 1;
    if (event === "resume") counters.resume += 1;
    if (event === "fallback") counters.fallback += 1;
    if (event === "ready") {
      const ms = Number(body.ms);
      if (Number.isFinite(ms) && ms >= 0 && ms < 600_000) {
        readySum += ms;
        readyCount += 1;
        for (const edge of READY_BUCKETS) if (ms <= edge) readyBuckets[edge] += 1;
      }
      if (body.quality === "low") counters.lowGraphics += 1;
    }
    return true;
  }

  function chatFail() {
    counters.chatError += 1;
  }

  function chatThrottled() {
    counters.chatThrottled += 1;
  }

  // Delivery health for the two WAHA paths, counted server-side because the
  // browser never learns whether the message actually landed.
  // Which scheme requests actually arrive on, so the redirect decision is
  // observable rather than assumed. Cluster-only, like the rest of /metrics.
  function request(scheme) {
    bump(schemes, scheme || "unset");
  }

  function beaconSent(kind, ok) {
    if (kind === "launch") counters[ok ? "launch" : "launchFailed"] += 1;
    else counters[ok ? "relay" : "relayFailed"] += 1;
  }

  function render() {
    const lines = [
      "# HELP orrery_up 1 when the orrery process is serving.",
      "# TYPE orrery_up gauge",
      "orrery_up 1",
      "# HELP orrery_visitors_playing Browser-reported visitor ids with a heartbeat in the last 90s. Client-supplied, so treat as reported sessions rather than verified people.",
      "# TYPE orrery_visitors_playing gauge",
      `orrery_visitors_playing ${playing()}`,
      "# HELP orrery_visitors_seen Browser-reported visitor ids observed since process start, capped at 50000. Client-supplied and inflatable; not a verified people count.",
      "# TYPE orrery_visitors_seen gauge",
      `orrery_visitors_seen ${seen.size}`,
      "# HELP orrery_play_starts_total Times a visitor began flying.",
      "# TYPE orrery_play_starts_total counter",
      `orrery_play_starts_total ${counters.play}`,
      "# HELP orrery_heartbeats_total Flight heartbeats from the cockpit.",
      "# TYPE orrery_heartbeats_total counter",
      `orrery_heartbeats_total ${counters.heartbeat}`,
      "# HELP orrery_docks_total Dockings by destination.",
      "# TYPE orrery_docks_total counter",
    ];
    for (const [body, n] of [...docks.entries()].sort())
      lines.push(`orrery_docks_total{body="${body}"} ${n}`);
    if (!docks.size) lines.push('orrery_docks_total{body="none"} 0');
    lines.push(
      "# HELP orrery_undocks_total Times a visitor left orbit.",
      "# TYPE orrery_undocks_total counter",
      `orrery_undocks_total ${counters.undock}`,
      "# HELP orrery_collects_total Signal buoys recovered.",
      "# TYPE orrery_collects_total counter",
    );
    for (const [signal, n] of [...collects.entries()].sort())
      lines.push(`orrery_collects_total{signal="${signal}"} ${n}`);
    if (!collects.size) lines.push('orrery_collects_total{signal="none"} 0');
    lines.push(
      "# HELP orrery_camera_toggles_total Camera mode changes.",
      "# TYPE orrery_camera_toggles_total counter",
    );
    for (const [mode, n] of [...cameras.entries()].sort())
      lines.push(`orrery_camera_toggles_total{mode="${mode}"} ${n}`);
    if (!cameras.size) lines.push('orrery_camera_toggles_total{mode="none"} 0');
    lines.push(
      "# HELP orrery_chat_messages_total Dock computer questions asked.",
      "# TYPE orrery_chat_messages_total counter",
      `orrery_chat_messages_total ${counters.chat}`,
      "# HELP orrery_chat_errors_total Failed dock computer replies.",
      "# TYPE orrery_chat_errors_total counter",
      `orrery_chat_errors_total ${counters.chatError}`,
      "# HELP orrery_boosts_total Boost burns.",
      "# TYPE orrery_boosts_total counter",
      `orrery_boosts_total ${counters.boost}`,
      "# HELP orrery_survey_docks_total Dockings at the survey array.",
      "# TYPE orrery_survey_docks_total counter",
      `orrery_survey_docks_total ${counters.survey}`,
      "# HELP orrery_telemetry_rejects_total Dropped telemetry payloads.",
      "# TYPE orrery_telemetry_rejects_total counter",
      `orrery_telemetry_rejects_total ${counters.telemetryReject}`,
      "# HELP orrery_chat_throttled_total Chat requests refused by the rate limit.",
      "# TYPE orrery_chat_throttled_total counter",
      `orrery_chat_throttled_total ${counters.chatThrottled}`,
      "# HELP orrery_requests_by_scheme_total Requests by the scheme the visitor originally used, from cf-visitor or x-forwarded-proto.",
      "# TYPE orrery_requests_by_scheme_total counter",
    );
    for (const [scheme, n] of [...schemes.entries()].sort())
      lines.push(`orrery_requests_by_scheme_total{scheme="${scheme}"} ${n}`);
    if (!schemes.size)
      lines.push('orrery_requests_by_scheme_total{scheme="unset"} 0');
    lines.push(
      "# HELP orrery_notes_opened_total Dossiers opened, by destination and where it was opened from.",
      "# TYPE orrery_notes_opened_total counter",
    );
    for (const [key, n] of [...notes.entries()].sort()) {
      const [body, source] = key.split("|");
      lines.push(`orrery_notes_opened_total{body="${body}",source="${source}"} ${n}`);
    }
    if (!notes.size)
      lines.push('orrery_notes_opened_total{body="none",source="none"} 0');
    lines.push(
      "# HELP orrery_chart_opens_total Times the star chart was opened.",
      "# TYPE orrery_chart_opens_total counter",
      `orrery_chart_opens_total ${counters.chart}`,
      "# HELP orrery_comm_opens_total Times the orbit assistant panel was opened, whether or not a question followed.",
      "# TYPE orrery_comm_opens_total counter",
      `orrery_comm_opens_total ${counters.comm}`,
      "# HELP orrery_resume_clicks_total Visitors who followed a link to the resume.",
      "# TYPE orrery_resume_clicks_total counter",
      `orrery_resume_clicks_total ${counters.resume}`,
      "# HELP orrery_fallback_total Sessions that could not start WebGL and fell back to chart mode.",
      "# TYPE orrery_fallback_total counter",
      `orrery_fallback_total ${counters.fallback}`,
      "# HELP orrery_low_graphics_total Sessions that started in low graphics.",
      "# TYPE orrery_low_graphics_total counter",
      `orrery_low_graphics_total ${counters.lowGraphics}`,
      "# HELP orrery_launch_notifications_total Launch pings accepted by the relay.",
      "# TYPE orrery_launch_notifications_total counter",
      `orrery_launch_notifications_total ${counters.launch}`,
      "# HELP orrery_launch_notifications_failed_total Launch pings the relay refused or dropped.",
      "# TYPE orrery_launch_notifications_failed_total counter",
      `orrery_launch_notifications_failed_total ${counters.launchFailed}`,
      "# HELP orrery_relay_pings_total Visitor relay pings accepted.",
      "# TYPE orrery_relay_pings_total counter",
      `orrery_relay_pings_total ${counters.relay}`,
      "# HELP orrery_relay_pings_failed_total Visitor relay pings the relay refused or dropped.",
      "# TYPE orrery_relay_pings_failed_total counter",
      `orrery_relay_pings_failed_total ${counters.relayFailed}`,
      "# HELP orrery_ready_ms Browser-reported milliseconds from page load to the first rendered frame.",
      "# TYPE orrery_ready_ms histogram",
    );
    let cumulative = 0;
    for (const edge of READY_BUCKETS) {
      cumulative = readyBuckets[edge];
      lines.push(`orrery_ready_ms_bucket{le="${edge}"} ${cumulative}`);
    }
    lines.push(
      `orrery_ready_ms_bucket{le="+Inf"} ${readyCount}`,
      `orrery_ready_ms_sum ${readySum}`,
      `orrery_ready_ms_count ${readyCount}`,
    );
    return lines.join("\n") + "\n";
  }

  return { chatStarted: () => { counters.chat += 1; }, ingest, render, chatFail, chatThrottled, beaconSent, request, playing };
}

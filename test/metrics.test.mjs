import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { once } from "node:events";
import { createApp } from "../server.mjs";
import { chatGrounding, chatSystemPrompt, openaiChatUrl } from "../src/chat.mjs";
import { createMetrics, metricsDenied } from "../src/metrics.mjs";
import catalog from "../data/projects.json" with { type: "json" };

let app, base;
before(async () => {
  app = createApp({
    mempoolBase: "http://127.0.0.1:9",
    openaiBaseUrl: "http://cliproxy.test/v1",
    openaiApiKey: "test-key",
    fetchImpl: async (url, init) => {
      assert.match(String(url), /\/chat\/completions$/);
      const body = JSON.parse(init.body);
      assert.equal(body.model, "grok-4.6");
      assert.equal(body.messages[0].role, "system");
      return Response.json({ model: "grok-4.6", choices: [{ message: { content: "I am docked at Homelab." } }] });
    },
  }).listen(0, "127.0.0.1");
  await once(app, "listening");
  base = `http://127.0.0.1:${app.address().port}`;
});
after(
  () => new Promise((resolve) => app.close(resolve)),
);

test("cluster scrapes /metrics; public Host or X-Forwarded-For is 404", async () => {
  assert.equal(metricsDenied({ headers: { host: "giovanni.dev.br" } }), true);
  assert.equal(
    metricsDenied({ headers: { "x-forwarded-for": "1.2.3.4" } }),
    true,
  );
  assert.equal(metricsDenied({ headers: { host: "127.0.0.1:8080" }, socket: { remoteAddress: "127.0.0.1" } }), false);
  const text = await fetch(`${base}/metrics`).then((r) => r.text());
  assert.match(text, /orrery_up 1/);
  assert.match(text, /orrery_visitors_playing/);
  assert.equal(
    (
      await fetch(`${base}/metrics`, {
        headers: { "x-forwarded-for": "1.2.3.4" },
      })
    ).status,
    404,
  );
});

test("telemetry records unique players and docks by body", async () => {
  const visitor = "visitor-alpha-01";
  assert.equal(
    (
      await fetch(`${base}/api/telemetry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visitor, event: "play" }),
      })
    ).status,
    204,
  );
  await fetch(`${base}/api/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visitor, event: "dock", body: "homelab" }),
  });
  await fetch(`${base}/api/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visitor, event: "collect", signal: "buoy-talos" }),
  });
  const text = await fetch(`${base}/metrics`).then((r) => r.text());
  assert.match(text, /orrery_visitors_playing 1/);
  assert.match(text, /orrery_visitors_seen 1/);
  assert.match(text, /orrery_play_starts_total 1/);
  assert.match(text, /orrery_docks_total\{body="homelab"\} 1/);
  assert.match(text, /orrery_collects_total\{signal="buoy-talos"\} 1/);
  assert.equal(
    (
      await fetch(`${base}/api/telemetry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visitor: "no", event: "play" }),
      })
    ).status,
    400,
  );
});

test("dock computer posts to cliproxyapi with catalog facts only", async () => {
  assert.equal(
    openaiChatUrl("http://chat.test/v1"),
    "http://chat.test/v1/chat/completions",
  );
  const grounding = chatGrounding(catalog, "homelab");
  assert.match(grounding, /Homelab/);
  assert.match(grounding, /Talos/);
  assert.doesNotMatch(grounding, /headcount/);
  assert.match(chatSystemPrompt(grounding), /resume.giovanni.dev.br/);
  const reply = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      visitor: "visitor-alpha-01",
      bodyId: "homelab",
      prompt: "What runs here?",
    }),
  }).then((r) => r.json());
  assert.match(reply.content, /Homelab/);
  const metrics = await fetch(`${base}/metrics`).then((r) => r.text());
  assert.match(metrics, /orrery_chat_messages_total 1/);
});


test("public telemetry refuses unknown or malformed labels before recording them", async () => {
  for (const [event, field] of [["dock", "body"], ["collect", "signal"], ["camera", "mode"]]) {
    for (const value of ['test"\nBAD_SAMPLE\n#', "unknown-label", null, 42]) {
      const response = await fetch(`${base}/api/telemetry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visitor: "review-bad-label", event, [field]: value }),
      });
      assert.equal(response.status, 400);
    }
  }
  const metrics = await fetch(`${base}/metrics`).then((r) => r.text());
  assert.doesNotMatch(metrics, /BAD_SAMPLE|unknown-label/);
  assert.match(metrics, /orrery_telemetry_rejects_total 13/);
});

test("active visitor storage is bounded and expires idle entries", () => {
  let time = 0;
  const metrics = createMetrics({ maxVisitors: 2, now: () => time });
  for (let i = 0; i < 100; i++)
    assert.equal(metrics.ingest({ visitor: `visitor-${i}`, event: "heartbeat" }), true);
  assert.equal(metrics.playing(), 2);
  time = 90_001;
  assert.equal(metrics.playing(), 0);
  metrics.ingest({ visitor: "visitor-new", event: "heartbeat" });
  assert.equal(metrics.playing(), 1);
});

test("exploration events are counted and their labels stay bounded", () => {
  const metrics = createMetrics();
  // What visitors open, and where from.
  assert.equal(metrics.ingest({ visitor: "anonabcdefgh", event: "notes", body: "homelab", source: "preview" }), true);
  assert.equal(metrics.ingest({ visitor: "anonabcdefgh", event: "notes", body: "homelab", source: "orbit" }), true);
  assert.equal(metrics.ingest({ visitor: "anonabcdefgh", event: "chart" }), true);
  assert.equal(metrics.ingest({ visitor: "anonabcdefgh", event: "comm" }), true);
  assert.equal(metrics.ingest({ visitor: "anonabcdefgh", event: "resume" }), true);
  assert.equal(metrics.ingest({ visitor: "anonabcdefgh", event: "fallback" }), true);

  // Unknown destinations and invented sources are refused, so a visitor
  // cannot mint Prometheus series or inject label text.
  assert.equal(metrics.ingest({ visitor: "anonabcdefgh", event: "notes", body: "not-a-body", source: "orbit" }), false);
  assert.equal(metrics.ingest({ visitor: "anonabcdefgh", event: "notes", body: "homelab", source: "made-up" }), false);
  assert.equal(metrics.ingest({ visitor: "anonabcdefgh", event: "notes", body: 'homelab"}\norrery_up 99', source: "orbit" }), false);

  const out = metrics.render();
  assert.match(out, /orrery_notes_opened_total\{body="homelab",source="preview"\} 1/);
  assert.match(out, /orrery_notes_opened_total\{body="homelab",source="orbit"\} 1/);
  assert.match(out, /orrery_chart_opens_total 1/);
  assert.match(out, /orrery_comm_opens_total 1/);
  assert.match(out, /orrery_resume_clicks_total 1/);
  assert.match(out, /orrery_fallback_total 1/);
  assert.doesNotMatch(out, /not-a-body|made-up/);
  // Every sample line must be a single well-formed metric.
  for (const line of out.split("\n"))
    if (line && !line.startsWith("#"))
      assert.match(line, /^[a-z_]+(\{[^}\n]*\})? -?[\d.e+]+$/i, `malformed: ${line}`);
});

test("first-frame timings build a monotonic histogram and reject nonsense", () => {
  const metrics = createMetrics();
  for (const ms of [840, 3200, 120]) metrics.ingest({ visitor: "anonabcdefgh", event: "ready", ms, quality: "full" });
  metrics.ingest({ visitor: "anonabcdefgh", event: "ready", ms: 600_001, quality: "low" });
  metrics.ingest({ visitor: "anonabcdefgh", event: "ready", ms: -5, quality: "full" });
  metrics.ingest({ visitor: "anonabcdefgh", event: "ready", ms: "fast", quality: "full" });
  const out = metrics.render();
  const buckets = Object.fromEntries(
    [...out.matchAll(/orrery_ready_ms_bucket\{le="([^"]+)"\} (\d+)/g)].map((m) => [m[1], Number(m[2])]),
  );
  const bucket = (le) => buckets[String(le)] ?? -1;
  assert.equal(Number(out.match(/orrery_ready_ms_count (\d+)/)[1]), 3, "only the three sane samples count");
  assert.equal(Number(out.match(/orrery_ready_ms_sum (\d+)/)[1]), 4160);
  const edges = [250, 500, 1000, 2000, 4000, 8000];
  let previous = 0;
  for (const edge of edges) {
    const value = bucket(edge);
    assert.ok(value >= previous, `bucket ${edge} must not decrease`);
    previous = value;
  }
  assert.equal(bucket(250), 1);
  assert.equal(bucket(1000), 2);
  assert.equal(bucket(4000), 3);
  // The out-of-range sample still counted as low graphics.
  assert.match(out, /orrery_low_graphics_total 1/);
});

test("relay delivery outcomes are counted, and refusals are not failures", () => {
  const metrics = createMetrics();
  metrics.beaconSent("launch", true);
  metrics.beaconSent("launch", false);
  metrics.beaconSent("relay", true);
  const out = metrics.render();
  assert.match(out, /orrery_launch_notifications_total 1/);
  assert.match(out, /orrery_launch_notifications_failed_total 1/);
  assert.match(out, /orrery_relay_pings_total 1/);
  assert.match(out, /orrery_relay_pings_failed_total 0/);
});

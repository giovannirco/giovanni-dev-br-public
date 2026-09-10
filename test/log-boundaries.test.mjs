import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { EventEmitter, once } from "node:events";
import { createLogger, logRequest, logRefused, logChat, logBeacon } from "../src/log.mjs";
import { createApp } from "../server.mjs";
import { createMetrics } from "../src/metrics.mjs";

function capture() {
  const lines = [];
  const destination = new Writable({ write(chunk, _, next) {
    for (const line of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(line));
    next();
  } });
  return { lines, log: createLogger({ level: "info", destination }) };
}

test("logging-only fields and messages are bounded and flattened without changing their inputs", () => {
  const { lines, log } = capture();
  const long = `begin\n\u0000\u0085\u2028${"x".repeat(2000)}end`;
  const req = { method: "GET", headers: {}, socket: {} };
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, statusCode: 404, writableFinished: true });
  logRequest(log, req, res, `/${long}`);
  res.emit("finish");
  res.emit("close");
  logRefused(log, req, `/${long}`, long);
  const fields = { visitor: long, bodyId: long, relayId: long, prompt: long, reply: long, model: long, outcome: "ok" };
  logChat(log, req, fields);
  logBeacon(log, req, { ...fields, kind: "relay" });
  assert.equal(fields.visitor, long);
  assert.equal(fields.prompt, long);
  assert.equal(lines.filter(l => l.event === "request").length, 1);
  for (const line of lines) {
    assert.ok(line.msg.length <= 400);
    for (const [key, value] of Object.entries(line)) {
      if (typeof value === "string") assert.doesNotMatch(value, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/, key);
    }
    if (line.path) assert.equal(line.path.length, 300);
    for (const key of ["visitor", "bodyId", "relayId"]) if (key in line) assert.equal(line[key].length, 64);
  }
  const chat = lines.find(l => l.event === "chat");
  assert.equal(chat.prompt.length, 800);
  assert.equal(chat.reply.length, 1200);
  assert.equal(chat.model.length, 80);
});

async function attempt(options, body) {
  const { lines, log } = capture();
  const metrics = createMetrics();
  const app = createApp({ log, metrics, ...options }).listen(0);
  await once(app, "listening");
  try {
    const base = new URL("http://localhost");
    base.port = String(app.address().port);
    const response = await fetch(new URL("/api/chat", base), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    await response.text();
    await new Promise(resolve => setImmediate(resolve));
    return { status: response.status, lines, metrics: metrics.render() };
  } finally { await new Promise(resolve => app.close(resolve)); }
}

test("invalid orbit, missing configuration and a capacity race never count as upstream failures", async () => {
  for (const [name, extra, bodyId, status, outcome] of [
    ["orbit", {}, "not-an-orbit", 400, "rejected"],
    ["configuration", { openaiApiKey: "" }, "homelab", 503, "unavailable"],
    ["capacity", { chatConcurrency: { full: () => false, enter: () => null } }, "homelab", 429, "busy"],
  ]) {
    let fetched = 0, refunded = 0;
    const result = await attempt({
      openaiBaseUrl: "https://example.com", openaiApiKey: "test",
      fetchImpl: async () => { fetched++; throw new Error("unexpected dispatch"); },
      chatLimit: { take: () => ({ ok: true, refund: () => refunded++ }) },
      chatBudget: { take: () => ({ ok: true, refund: () => refunded++ }) },
      ...extra,
    }, { bodyId, prompt: "Hello" });
    assert.equal(result.status, status, name);
    assert.equal(fetched, 0, name);
    assert.equal(refunded, 2, name);
    assert.equal(result.lines.find(l => l.event === "chat").outcome, outcome, name);
    assert.equal(result.lines.filter(l => l.event === "upstream").length, 0, name);
    assert.match(result.metrics, /orrery_chat_errors_total 0\n/, name);
    assert.match(result.metrics, /orrery_chat_messages_total 0\n/, name);
  }
});

test("an actual completion failure keeps its upstream log, metric and concurrency release", async () => {
  let fetched = 0, released = 0;
  const result = await attempt({
    openaiBaseUrl: "https://example.com", openaiApiKey: "test",
    fetchImpl: async () => { fetched++; return new Response("", { status: 503 }); },
    chatConcurrency: { full: () => false, enter: () => () => released++ },
  }, { bodyId: "homelab", prompt: "Hello" });
  assert.equal(result.status, 502);
  assert.equal(fetched, 1);
  assert.equal(released, 1);
  assert.equal(result.lines.find(l => l.event === "chat").outcome, "error");
  assert.equal(result.lines.find(l => l.event === "upstream").target, "llm");
  assert.match(result.metrics, /orrery_chat_errors_total 1\n/);
  assert.match(result.metrics, /orrery_chat_messages_total 1\n/);
});

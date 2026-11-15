import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createNotifyRelay } from "../src/notify-relay.mjs";

const CONFIG = {
  token: "relay-token-for-tests",
  baseUrl: "http://gateway.invalid/",
  apiKey: "gateway-key",
  session: "fixed-session",
  chatId: "fixed-chat",
};

async function start(overrides = {}) {
  const calls = [];
  const relay = createNotifyRelay({
    ...CONFIG,
    fetchImpl: async (url, opts) => {
      calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      return { ok: true, status: 201, text: async () => "gateway-reply" };
    },
    ...overrides,
  }).listen(0, "127.0.0.1");
  await once(relay, "listening");
  const base = `http://127.0.0.1:${relay.address().port}`;
  const notify = (body, headers = { authorization: `Bearer ${CONFIG.token}` }) =>
    fetch(`${base}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { relay, base, calls, notify, stop: () => new Promise((resolve) => relay.close(resolve)) };
}

test("the relay refuses to start without its token, gateway and destination", () => {
  for (const missing of ["token", "baseUrl", "apiKey", "chatId"])
    assert.throws(() => createNotifyRelay({ ...CONFIG, [missing]: "" }), new RegExp(missing));
});

test("a caller without the token never reaches the gateway", async () => {
  const { calls, notify, stop } = await start();
  try {
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: CONFIG.token }, { authorization: `Bearer ${CONFIG.token}x` }]) {
      const response = await notify({ kind: "launch", text: "hello" }, headers);
      assert.equal(response.status, 401);
    }
    assert.equal(calls.length, 0);
  } finally {
    await stop();
  }
});

test("a message goes to the fixed destination and the caller cannot choose another", async () => {
  const { calls, notify, stop } = await start();
  try {
    const response = await notify({ kind: "relay", text: "hello", chatId: "someone-else", session: "other", to: "x" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://gateway.invalid/api/sendText");
    assert.equal(calls[0].headers["X-Api-Key"], "gateway-key");
    assert.deepEqual(calls[0].body, { session: "fixed-session", chatId: "fixed-chat", text: "hello" });
  } finally {
    await stop();
  }
});

test("only the two known kinds with bounded text are accepted", async () => {
  const { calls, notify, stop } = await start();
  try {
    const bad = [
      { kind: "other", text: "hello" },
      { text: "hello" },
      { kind: "launch" },
      { kind: "launch", text: "" },
      { kind: "launch", text: 7 },
      { kind: "launch", text: "x".repeat(2001) },
      "not json",
      "[]",
    ];
    for (const body of bad) assert.equal((await notify(body)).status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal((await notify({ kind: "launch", text: "x".repeat(2000), pad: "y".repeat(9000) })).status, 413);
    assert.equal(calls.length, 0);
  } finally {
    await stop();
  }
});

test("nothing but the notify route and the health check is served", async () => {
  const { base, calls, stop } = await start();
  try {
    const auth = { authorization: `Bearer ${CONFIG.token}` };
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/notify`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${base}/api/sendText`, { method: "POST", headers: auth, body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/`, { headers: auth })).status, 404);
    assert.equal(calls.length, 0);
  } finally {
    await stop();
  }
});

test("a gateway failure is reported without its reply and does not use up the hour", async () => {
  let healthy = false;
  let sent = 0;
  const { notify, stop } = await start({
    limit: 1,
    fetchImpl: async () => {
      if (!healthy) return { ok: false, status: 500, text: async () => "gateway-secret-detail" };
      sent += 1;
      return { ok: true, status: 201 };
    },
  });
  try {
    const failed = await notify({ kind: "launch", text: "hello" });
    assert.equal(failed.status, 502);
    assert.doesNotMatch(await failed.text(), /gateway|secret|invalid/);
    healthy = true;
    assert.equal((await notify({ kind: "launch", text: "hello" })).status, 200);
    assert.equal(sent, 1);
  } finally {
    await stop();
  }
});

test("an unreachable gateway is a 502, not a crash", async () => {
  const { notify, stop } = await start({ fetchImpl: async () => { throw new Error("connect ECONNREFUSED 10.77.0.9:443"); } });
  try {
    const response = await notify({ kind: "relay", text: "hello" });
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /10\.77|ECONNREFUSED/);
  } finally {
    await stop();
  }
});

test("the relay stops at sixty messages an hour whatever the caller does", async () => {
  let clock = 0;
  const { calls, notify, stop } = await start({ now: () => clock });
  try {
    for (let n = 0; n < 60; n++) assert.equal((await notify({ kind: "launch", text: `m${n}` })).status, 200);
    clock = 59 * 60_000;
    assert.equal((await notify({ kind: "launch", text: "one too many" })).status, 429);
    assert.equal(calls.length, 60);
    clock = 60 * 60_000 + 1;
    assert.equal((await notify({ kind: "launch", text: "next hour" })).status, 200);
  } finally {
    await stop();
  }
});

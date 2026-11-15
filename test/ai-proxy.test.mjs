import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createAiProxy } from "../src/ai-proxy.mjs";

const CONFIG = {
  token: "proxy-token-for-tests",
  upstream: "http://gateway.invalid/v1/",
  upstreamKey: "gateway-client-key",
  models: ["small-a", "small-b"],
};
const AUTH = { authorization: `Bearer ${CONFIG.token}`, "content-type": "application/json" };
const CHAT = { model: "small-a", messages: [{ role: "user", content: "hi" }], temperature: 0.4, max_tokens: 280 };

async function start(overrides = {}) {
  const calls = [];
  const proxy = createAiProxy({
    ...CONFIG,
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
      if (url.endsWith("/models"))
        return Response.json({ data: [{ id: "small-a" }, { id: "frontier-xl" }, { id: "small-b", name: "Small B" }] });
      return Response.json({ choices: [{ message: { content: "hello" } }] }, { headers: { "x-gateway-account": "private" } });
    },
    ...overrides,
  }).listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const chat = (body = CHAT, headers = AUTH) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { base, calls, chat, stop: () => new Promise((resolve) => proxy.close(resolve)) };
}

test("the proxy refuses to start without its token, upstream, key and model list", () => {
  for (const missing of ["token", "upstream", "upstreamKey"])
    assert.throws(() => createAiProxy({ ...CONFIG, [missing]: "" }), new RegExp(missing));
  assert.throws(() => createAiProxy({ ...CONFIG, models: [] }), /models/);
});

test("a caller without the proxy token never reaches the gateway", async () => {
  const { base, calls, chat, stop } = await start();
  try {
    for (const headers of [{ "content-type": "application/json" }, { ...AUTH, authorization: "Bearer wrong" }, { ...AUTH, authorization: `Bearer ${CONFIG.upstreamKey}` }])
      assert.equal((await chat(CHAT, headers)).status, 401);
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    assert.equal(calls.length, 0);
  } finally {
    await stop();
  }
});

test("a completion for a listed model is forwarded with the gateway key and nothing extra", async () => {
  const { calls, chat, stop } = await start();
  try {
    const response = await chat({ ...CHAT, tools: [{ type: "function" }], user: "x", n: 5, max_tokens: 99999 });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "hello");
    assert.equal(response.headers.get("x-gateway-account"), null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://gateway.invalid/v1/chat/completions");
    assert.equal(calls[0].opts.headers.authorization, "Bearer gateway-client-key");
    assert.deepEqual(Object.keys(calls[0].body).sort(), ["max_tokens", "messages", "model", "stream", "temperature"]);
    assert.equal(calls[0].body.max_tokens, 600);
    assert.equal(calls[0].body.stream, false);
  } finally {
    await stop();
  }
});

test("models outside the list and malformed requests are refused before the gateway", async () => {
  const { calls, chat, stop } = await start();
  try {
    const bad = [
      { ...CHAT, model: "frontier-xl" },
      { ...CHAT, model: undefined },
      { ...CHAT, messages: [] },
      { ...CHAT, messages: "hi" },
      { ...CHAT, messages: [{ role: "tool", content: "x" }] },
      { ...CHAT, messages: [{ role: "user", content: { type: "image_url" } }] },
      { ...CHAT, messages: Array.from({ length: 41 }, () => ({ role: "user", content: "x" })) },
      { ...CHAT, messages: [{ role: "user", content: "x".repeat(40_001) }] },
      "not json",
    ];
    for (const body of bad) assert.equal((await chat(body)).status, 400, JSON.stringify(body).slice(0, 50));
    assert.equal((await chat({ ...CHAT, pad: "y".repeat(200_000) })).status, 413);
    assert.equal(calls.length, 0);
  } finally {
    await stop();
  }
});

test("the model list shows only listed models", async () => {
  const { base, stop } = await start();
  try {
    const response = await fetch(`${base}/v1/models`, { headers: AUTH });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.map((m) => m.id).sort(), ["small-a", "small-b"]);
  } finally {
    await stop();
  }
});

test("no other gateway route is served", async () => {
  const { base, calls, stop } = await start();
  try {
    for (const [method, path] of [["GET", "/v0/management/config"], ["POST", "/v1/embeddings"], ["POST", "/v1/responses"], ["GET", "/v1/chat/completions"], ["POST", "/v1/models"], ["GET", "/"]])
      assert.equal((await fetch(`${base}${path}`, { method, headers: AUTH, body: method === "POST" ? "{}" : undefined })).status, 404, `${method} ${path}`);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal(calls.length, 0);
  } finally {
    await stop();
  }
});

test("a streamed completion is passed through as an event stream", async () => {
  const { chat, calls, stop } = await start({
    fetchImpl: async (url, opts) => {
      calls.push({ body: JSON.parse(opts.body) });
      return new Response('data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const response = await chat({ ...CHAT, stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.match(await response.text(), /"content":"he"[\s\S]*\[DONE\]/);
    assert.equal(calls[0].body.stream, true);
  } finally {
    await stop();
  }
});

test("the hourly budget is enforced here and a failed call does not spend it", async () => {
  let clock = 0;
  let healthy = false;
  const { chat, stop } = await start({
    budget: 2,
    now: () => clock,
    fetchImpl: async () => (healthy ? Response.json({ choices: [] }) : new Response("gateway account acct-7 exhausted", { status: 500 })),
  });
  try {
    const failed = await chat();
    assert.equal(failed.status, 502);
    assert.doesNotMatch(await failed.text(), /acct-7|exhausted/);
    healthy = true;
    assert.equal((await chat()).status, 200);
    assert.equal((await chat()).status, 200);
    assert.equal((await chat()).status, 429);
    clock = 60 * 60_000 + 1;
    assert.equal((await chat()).status, 200);
  } finally {
    await stop();
  }
});

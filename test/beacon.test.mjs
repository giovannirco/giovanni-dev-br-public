import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RELAYS,
  createBeacon,
  formatPing,
  formatLaunch,
  sanitizeName,
  sanitizeNote,
} from "../src/beacon.mjs";

test("names and notes are clipped and stripped of control characters", () => {
  assert.equal(sanitizeName("  Ana\n\tMarie  "), "Ana Marie");
  assert.equal(sanitizeName("x".repeat(80)).length, 40);
  assert.equal(sanitizeNote("hello\u0007world"), "hello world");
  assert.equal(sanitizeNote("n".repeat(400)).length, 280);
});

test("formatPing never mentions the transport and carries orbit facts", () => {
  const text = formatPing({
    relayId: "umbra",
    name: "Ana",
    note: "beautiful dark",
    near: "Homelab",
    heading: 3.14159,
    height: 965764,
  });
  assert.match(text, /Umbra/);
  assert.match(text, /Ana/);
  assert.match(text, /beautiful dark/);
  assert.match(text, /Homelab/);
  assert.match(text, /180°/);
  assert.match(text, /965764/);
  assert.doesNotMatch(text, /waha|whatsapp|bitops\.svc|api key/i);
  assert.match(formatPing({ relayId: "ghost" }), /silent frequency/i);
});

test("unconfigured relay stays dark without calling the network", async () => {
  const calls = [];
  const beacon = createBeacon({
    fetchImpl: async (...a) => {
      calls.push(a);
      return { ok: true, status: 201, text: async () => "" };
    },
  });
  assert.equal(beacon.ready(), false);
  await assert.rejects(() => beacon.send({ visitor: "anonabcdefgh", relayId: "heliograph" }), {
    status: 503,
  });
  assert.equal(calls.length, 0);
});

test("unknown relay and bad visitor are rejected before send", async () => {
  const beacon = createBeacon({
    baseUrl: "http://waha.example",
    apiKey: "k",
    chatId: "120@g.us",
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });
  await assert.rejects(
    () => beacon.send({ visitor: "anonabcdefgh", relayId: "moon" }),
    { status: 400 },
  );
  await assert.rejects(
    () => beacon.send({ visitor: "nope", relayId: "heliograph" }),
    { status: 400 },
  );
});

test("successful ping posts sendText and never returns upstream bodies", async () => {
  const calls = [];
  const beacon = createBeacon({
    baseUrl: "http://waha.example/",
    apiKey: "secret-key",
    session: "default",
    chatId: "120@g.us",
    now: () => 1_000,
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 201, text: async () => "upstream-secret" };
    },
  });
  const result = await beacon.send({
    visitor: "anonabcdefgh",
    relayId: "heliograph",
    name: "Gio",
    note: "hi",
    near: "Survey array",
    heading: 0.4,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://waha.example/api/sendText");
  assert.equal(calls[0].opts.headers["X-Api-Key"], "secret-key");
  const payload = JSON.parse(calls[0].opts.body);
  assert.equal(payload.session, "default");
  assert.equal(payload.chatId, "120@g.us");
  assert.match(payload.text, /Heliograph/);
  assert.doesNotMatch(payload.text, /secret-key|waha\.example/);
});

test("rate limit cools a visitor down", async () => {
  let t = 0;
  const beacon = createBeacon({
    baseUrl: "http://waha.example",
    apiKey: "k",
    chatId: "120@g.us",
    now: () => t,
    fetchImpl: async () => ({ ok: true, status: 201, text: async () => "" }),
  });
  await beacon.send({ visitor: "anonabcdefgh", relayId: "heliograph" });
  t = 60_000;
  await assert.rejects(
    () => beacon.send({ visitor: "anonabcdefgh", relayId: "umbra" }),
    { status: 429 },
  );
  t = 16 * 60_000;
  const again = await beacon.send({ visitor: "anonabcdefgh", relayId: "umbra" });
  assert.equal(again.ok, true);
});

test("RELAYS is the public id set the catalog must use", () => {
  assert.deepEqual(Object.keys(RELAYS).sort(), ["ghost", "heliograph", "umbra"]);
});

test("a ping carries who is on the other end without naming the transport", () => {
  const text = formatPing({
    relayId: "heliograph",
    name: "Ana",
    note: "nice ship",
    near: "Homelab",
    client: {
      address: "203.0.113.7",
      browser: "Safari",
      system: "iOS",
      device: "phone",
      language: "pt-BR",
    },
    session: {
      timezone: "America/Sao_Paulo",
      screenWidth: 390,
      screenHeight: 844,
      visited: 4,
      buoys: 3,
      aloftMs: 5 * 60_000,
    },
  });
  assert.match(text, /From: 203\.0\.113\.7/);
  assert.match(text, /Setup: Safari on iOS \(phone\)/);
  assert.match(text, /Language: pt-BR/);
  assert.match(text, /Their time: \d\d:\d\d \(America\/Sao_Paulo\)/);
  assert.match(text, /Screen: 390×844/);
  assert.match(text, /Flight: 4 visited · 3 buoys · 5m aloft/);
  assert.doesNotMatch(text, /waha|whatsapp|api key/i);
});

test("a hostile session block cannot inject lines or absurd values", () => {
  const text = formatPing({
    relayId: "umbra",
    client: { address: "203.0.113.7" },
    session: {
      timezone: "Not/A Zone\nFrom: 1.1.1.1",
      screenWidth: "1e9",
      screenHeight: -5,
      visited: 10_000,
      buoys: "abc",
      aloftMs: 999 * 24 * 60 * 60_000,
    },
  });
  assert.doesNotMatch(text, /Their time/, "an invalid zone is dropped");
  assert.equal(text.split("\n").filter((l) => l.startsWith("From:")).length, 1);
  assert.doesNotMatch(text, /Screen:/, "a negative dimension is dropped");
  assert.match(text, /999 visited/, "counts are clamped, not echoed");
  assert.doesNotMatch(text, /abc/);
});

test("the cooldown follows the connection, not a rotatable visitor id", async () => {
  let t = 0;
  const sent = [];
  const beacon = createBeacon({
    baseUrl: "http://waha.example",
    apiKey: "k",
    chatId: "120@g.us",
    now: () => t,
    fetchImpl: async (_url, opts) => {
      sent.push(JSON.parse(opts.body).text);
      return { ok: true, status: 201, text: async () => "" };
    },
  });
  const ping = (visitor, key) =>
    beacon.send({ visitor, relayId: "heliograph" }, { client: { key } });
  await ping("anonabcdefgh", "client-a");
  // Clearing localStorage gives a fresh visitor id; the cooldown must hold.
  await assert.rejects(() => ping("anonzzzzzzzz", "client-a"), { status: 429 });
  await assert.rejects(() => ping("anonyyyyyyyy", "client-a"), { status: 429 });
  assert.equal(sent.length, 1);
  assert.equal((await ping("anonabcdefgh", "client-b")).ok, true);
});

test("a dark relay does not burn the visitor's cooldown", async () => {
  let t = 0,
    healthy = false;
  const beacon = createBeacon({
    baseUrl: "http://waha.example",
    apiKey: "k",
    chatId: "120@g.us",
    now: () => t,
    fetchImpl: async () =>
      healthy
        ? { ok: true, status: 201, text: async () => "" }
        : { ok: false, status: 502, text: async () => "" },
  });
  const ping = () =>
    beacon.send(
      { visitor: "anonabcdefgh", relayId: "heliograph" },
      { client: { key: "client-a" } },
    );
  await assert.rejects(ping, { status: 503 });
  healthy = true;
  assert.equal((await ping()).ok, true, "the retry is not locked out");
});


test("launch messages reuse visitor details and omit referrer secrets", () => {
  const text = formatLaunch({
    visitor: "anonabcdefgh", at: 0,
    client: { address: "203.0.113.7", browser: "Safari", system: "iOS", country: "BR", userAgent: "Safari\nInjected" },
    session: { timezone: "America/Sao_Paulo", screenWidth: 390, screenHeight: 844, viewportWidth: 390, viewportHeight: 720, referrer: "https://user:password@example.org/private?token=secret#fragment" },
  });
  assert.match(text, /orrery launch\nAction: Take the controls/);
  assert.match(text, /At: 1970-01-01T00:00:00.000Z/);
  assert.match(text, /Browser ID: anonabcdefgh/);
  assert.match(text, /From: 203.0.113.7/);
  assert.match(text, /Viewport: 390×720/);
  assert.match(text, /Country \(edge\): BR/);
  assert.match(text, /Referrer: https:\/\/example.org/);
  assert.doesNotMatch(text, /password|token|private|fragment|\nInjected/);
});

test("launches have separate connection limits and refund failed delivery", async () => {
  let healthy = false;
  const sent = [];
  const beacon = createBeacon({ baseUrl: "http://waha.example", apiKey: "k", chatId: "120@g.us", now: () => 1000,
    fetchImpl: async (_url, opts) => { if (healthy) sent.push(JSON.parse(opts.body)); return { ok: healthy }; },
  });
  const context = { client: { key: "connection-a", address: "203.0.113.7" } };
  await assert.rejects(() => beacon.sendLaunch({ visitor: "bad" }, context), { status: 400 });
  await assert.rejects(() => beacon.sendLaunch(null, context), { status: 400 });
  await assert.rejects(() => beacon.sendLaunch({ visitor: "anonabcdefgh" }, context), { status: 503 });
  healthy = true;
  for (let i = 0; i < 10; i++) await beacon.sendLaunch({ visitor: `visitor00${i}` }, context);
  await assert.rejects(() => beacon.sendLaunch({ visitor: "rotatedvisitor" }, context), { status: 429 });
  await beacon.send({ visitor: "anonabcdefgh", relayId: "heliograph" }, context);
  assert.equal(sent.length, 11);
  assert.match(sent[0].text, /orrery launch/);
  assert.match(sent[10].text, /Heliograph/);
  assert.deepEqual(Object.keys(sent[0]).sort(), ["chatId", "session", "text"]);
});

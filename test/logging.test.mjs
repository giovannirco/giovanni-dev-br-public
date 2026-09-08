process.env.TRUSTED_PROXY_CIDRS = "127.0.0.1/32,::1/128,10.77.0.0/16";
process.env.TRUSTED_EDGE_CIDRS = "10.77.0.0/16";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Writable } from "node:stream";
import { test } from "node:test";
import { createApp } from "../server.mjs";
import { createBeacon } from "../src/beacon.mjs";
import { createLogger, referrerOrigin, requestKind } from "../src/log.mjs";

// Every line must survive `| json` in Loki, so the capture parses rather than
// matches: a line that is not valid JSON fails here before it fails a
// dashboard.
function capture(level = "info") {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, next) {
      for (const line of String(chunk).split("\n").filter(Boolean))
        lines.push(JSON.parse(line));
      next();
    },
  });
  return { lines, log: createLogger({ level, destination: stream }) };
}

async function withApp(options, run) {
  const app = createApp(options).listen(0, "127.0.0.1");
  await once(app, "listening");
  try {
    return await run(`http://127.0.0.1:${app.address().port}`);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

// Flush: the access line is written on the response's finish event, which can
// land after fetch has resolved.
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test("every request leaves one parseable line describing who asked for what", async () => {
  const { lines, log } = capture();
  await withApp({ log }, async (base) => {
    const response = await fetch(`${base}/api/healthz`, {
      headers: {
        "x-forwarded-for": "203.0.113.7,10.77.0.118",
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 Version/17.0 Mobile/15E148 Safari/604.1",
        "accept-language": "pt-BR,pt;q=0.9",
        referer: "https://news.example/story?secret=1",
      },
    });
    assert.equal(response.status, 200);
    await settle();
  });
  // Health checks are probes: present at debug, absent from an info stream.
  assert.equal(lines.length, 0);

  const { lines: seen, log: debug } = capture("debug");
  await withApp({ log: debug }, async (base) => {
    await fetch(`${base}/api/catalog`, {
      headers: {
        "x-forwarded-for": "203.0.113.7,10.77.0.118",
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 Version/17.0 Mobile/15E148 Safari/604.1",
        "accept-language": "pt-BR,pt;q=0.9",
        referer: "https://news.example/story?token=secret",
      },
    });
    await fetch(`${base}/api/healthz`);
    await settle();
  });
  const request = seen.find((l) => l.path === "/api/catalog");
  assert.equal(request.event, "request");
  assert.equal(request.kind, "api");
  assert.equal(request.method, "GET");
  assert.equal(request.status, 200);
  assert.equal(request.level, "info");
  assert.equal(request.service, "giovanni-dev-br");
  assert.ok(request.duration_ms >= 0);
  assert.ok(request.bytes > 0);
  assert.equal(request.ip, "203.0.113.7", "the visitor, not the tunnel hop");
  assert.equal(request.device, "phone");
  assert.equal(request.browser, "Safari");
  assert.equal(request.system, "iOS");
  assert.equal(request.language, "pt-BR");
  // A referrer is kept as an origin: no path, no query, no token in it.
  assert.equal(request.referrer, "https://news.example");
  assert.equal(seen.find((l) => l.path === "/api/healthz").level, "debug");
});

test("a conversation is recoverable from the logs, and nothing else is", async () => {
  const { lines, log } = capture();
  const upstream = async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "The Bitcoin beacon reads Gio's own node." } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  await withApp({ log, openaiBaseUrl: "http://chat.test/v1", openaiApiKey: "super-secret-key", fetchImpl: upstream }, async (base) => {
    const response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "What runs\nin the homelab?", bodyId: "homelab", visitor: "logtestvisitor" }),
    });
    assert.equal(response.status, 200);
    await settle();
  });
  const chat = lines.find((l) => l.event === "chat");
  assert.equal(chat.outcome, "ok");
  assert.equal(chat.bodyId, "homelab");
  assert.equal(chat.visitor, "logtestvisitor");
  assert.equal(chat.streamed, false);
  assert.ok(chat.duration_ms >= 0);
  // The newline in the prompt must not have become a second log line.
  assert.equal(chat.prompt, "What runs in the homelab?");
  assert.match(chat.reply, /Bitcoin beacon/);
  assert.ok(lines.every((l) => !JSON.stringify(l).includes("super-secret-key")));
});

test("what the server turns away is logged as a warning, with the origin that asked", async () => {
  const { lines, log } = capture();
  await withApp({ log }, async (base) => {
    const refused = await fetch(`${base}/api/launch`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(refused.status, 403);
    await settle();
  });
  const refused = lines.find((l) => l.event === "refused");
  assert.equal(refused.level, "warn");
  assert.equal(refused.reason, "cross-origin");
  assert.equal(refused.origin, "https://evil.example");
  assert.equal(refused.path, "/api/launch");
  // And the access line still records the refusal's status.
  assert.equal(lines.find((l) => l.event === "request").status, 403);
});

test("a message that reached Gio's phone, or did not, says which", async () => {
  const { lines, log } = capture();
  const relay = async () => new Response("{}", { status: 500 });
  const beacon = createBeacon({ baseUrl: "http://relay.invalid", apiKey: "k", chatId: "c", fetchImpl: relay });
  await withApp({ log, beacon }, async (base) => {
    await fetch(`${base}/api/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visitor: "logtestvisitor" }),
    });
    await settle();
  });
  const launch = lines.find((l) => l.event === "launch");
  assert.equal(launch.outcome, "failed");
  assert.equal(launch.visitor, "logtestvisitor");
  const upstream = lines.find((l) => l.event === "upstream");
  assert.equal(upstream.target, "waha");
  assert.equal(upstream.level, "error");
});

test("requests are classified so a dashboard can tell traffic from probes", () => {
  assert.equal(requestKind("/"), "page");
  assert.equal(requestKind("/resume"), "page");
  assert.equal(requestKind("/assets/index-abc123.js"), "asset");
  assert.equal(requestKind("/favicon.svg"), "asset");
  assert.equal(requestKind("/api/chat"), "api");
  assert.equal(requestKind("/tip"), "api");
  assert.equal(requestKind("/api/healthz"), "probe");
  assert.equal(requestKind("/metrics"), "probe");
  assert.equal(referrerOrigin("https://x.test/a?b=c#d"), "https://x.test");
  assert.equal(referrerOrigin("javascript:alert(1)"), "");
  assert.equal(referrerOrigin(""), "");
});

test("a visitor who walks away is recorded as leaving, not as a failure", async () => {
  const { lines, log } = capture();
  // An upstream that never answers but does respect cancellation, the way
  // fetch does, so the only way this request ends is the client hanging up.
  const stalled = (_url, options) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
      );
    });
  await withApp({ log, openaiBaseUrl: "http://chat.test/v1", openaiApiKey: "key", fetchImpl: stalled }, async (base) => {
    await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Tell me about the homelab", bodyId: "homelab" }),
      signal: AbortSignal.timeout(150),
    }).catch(() => {});
    await settle();
  });
  const chat = lines.find((l) => l.event === "chat");
  assert.equal(chat.outcome, "abandoned", "leaving is not an error");
  assert.equal(
    lines.filter((l) => l.event === "upstream").length,
    0,
    "the assistant did not fail; nobody waited for it",
  );
  // The request still leaves a line, with the status nginx uses for a client
  // that hung up, so an abandoned request is not a blind spot.
  const request = lines.find((l) => l.event === "request");
  assert.equal(request.status, 499);
  assert.equal(request.aborted, true);
});

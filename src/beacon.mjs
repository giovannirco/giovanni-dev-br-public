import { createRateLimit } from "./limits.mjs";

const VISITOR_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+){0,2}$/;
const COOLDOWN_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
const HOUR_CAP = 20;

export const RELAYS = {
  heliograph: {
    name: "Heliograph",
    flavor: "survey-side flash",
  },
  umbra: {
    name: "Umbra",
    flavor: "no sun on this side",
  },
  ghost: {
    name: "Ghost frequency",
    flavor: "silent frequency",
  },
};

export function sanitizeName(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

export function sanitizeNote(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function count(value, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : null;
}

function localTime(tz) {
  if (!TZ_RE.test(String(tz || ""))) return "";
  try {
    return new Date().toLocaleTimeString("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function minutes(ms) {
  const n = count(ms, 24 * 60 * 60_000);
  if (n === null) return "";
  const total = Math.round(n / 60_000);
  return total >= 60
    ? `${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}`
    : `${total}m`;
}

export function formatPing({
  relayId,
  name = "",
  note = "",
  near = "",
  heading = null,
  height = null,
  client = {},
  session = {},
} = {}) {
  const relay = RELAYS[relayId];
  const who = sanitizeName(name) || "a visitor";
  const lines = [
    "orrery ping",
    `Relay: ${relay.name} — ${relay.flavor}`,
    `Who: ${who}`,
  ];
  const msg = sanitizeNote(note);
  if (msg) lines.push(`Note: ${msg}`);
  if (near) lines.push(`Near: ${near}`);
  if (Number.isFinite(heading)) {
    const deg = ((Math.round((heading * 180) / Math.PI) % 360) + 360) % 360;
    lines.push(`HDG ${String(deg).padStart(3, "0")}°`);
    if (relayId === "umbra" && Math.abs(deg - 180) <= 2)
      lines.push("Anti-sun alignment.");
    if (relayId === "heliograph" && deg === 13) lines.push("Lucky 013.");
  }
  if (Number.isFinite(height)) lines.push(`Node height ${height}`);

  lines.push(...visitorLines(client, session));

  if (relayId === "ghost") lines.push("They found the silent frequency.");
  if (who.toLowerCase() === "nómada" || who.toLowerCase() === "nomada")
    lines.push("Claims the ship.");
  return lines.join("\n");
}

function visitorLines(client, session) {
  const lines = [];
  const setup = [client.browser, client.system].filter(Boolean).map(sanitizeName).join(" on ");
  if (client.address) lines.push(`From: ${sanitizeNote(client.address)}`);
  if (setup) lines.push(`Setup: ${setup}${client.device ? ` (${sanitizeName(client.device)})` : ""}`);
  else if (client.device) lines.push(`Setup: ${sanitizeName(client.device)}`);
  if (client.language) lines.push(`Language: ${sanitizeName(client.language)}`);
  const clock = localTime(session.timezone);
  if (clock) lines.push(`Their time: ${clock} (${session.timezone})`);
  const w = count(session.screenWidth, 20000);
  const h = count(session.screenHeight, 20000);
  if (w && h) lines.push(`Screen: ${w}×${h}`);

  const flight = [];
  const visited = count(session.visited, 999);
  const buoys = count(session.buoys, 999);
  const aloft = minutes(session.aloftMs);
  if (visited !== null) flight.push(`${visited} visited`);
  if (buoys !== null) flight.push(`${buoys} buoys`);
  if (aloft) flight.push(`${aloft} aloft`);
  if (flight.length) lines.push(`Flight: ${flight.join(" · ")}`);

  return lines;
}

export function formatLaunch({ visitor, client = {}, session = {}, at = Date.now() } = {}) {
  const lines = ["orrery launch", 'Action: Take the controls', "Who: a visitor", `At: ${new Date(at).toISOString()}`, `Browser ID: ${sanitizeNote(visitor)}`];
  lines.push(...visitorLines(client, session));
  const width = count(session.viewportWidth, 20000);
  const height = count(session.viewportHeight, 20000);
  if (width && height) lines.push(`Viewport: ${width}×${height}`);
  if (client.country) lines.push(`Country (edge): ${sanitizeName(client.country)}`);
  if (client.userAgent) lines.push(`User agent: ${sanitizeNote(client.userAgent)}`);
  try {
    const referrer = new URL(session.referrer);
    if (["http:", "https:"].includes(referrer.protocol)) lines.push(`Referrer: ${referrer.origin}`);
  } catch {}
  return lines.join("\n");
}

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function createBeacon({
  fetchImpl = fetch,
  baseUrl = process.env.WAHA_BASE_URL || "",
  apiKey = process.env.WAHA_API_KEY || "",
  session = process.env.WAHA_SESSION || "default",
  chatId = process.env.WAHA_BEACON_CHAT_ID || "",
  now = () => Date.now(),
} = {}) {
  // Keyed on the connection, not on a browser-generated id the visitor can
  // rotate at will. The hourly cap is the backstop and stays global.
  const perClient = createRateLimit({ limit: 1, windowMs: COOLDOWN_MS, now });
  const global = createRateLimit({ limit: HOUR_CAP, windowMs: HOUR_MS, now });
  const launchClient = createRateLimit({ limit: 10, windowMs: 60_000, now });
  const launchGlobal = createRateLimit({ limit: 60, windowMs: 60_000, now });
  const root = String(baseUrl || "").replace(/\/$/, "");

  function ready() {
    return Boolean(root && apiKey && chatId);
  }

  async function send(body = {}, context = {}, launch = false) {
    body = body && typeof body === "object" ? body : {};
    const visitor = typeof body.visitor === "string" ? body.visitor : "";
    const relayId = typeof body.relayId === "string" ? body.relayId : "";
    if (!VISITOR_RE.test(visitor) || (!launch && !Object.hasOwn(RELAYS, relayId)))
      throw fail(400, "Unknown relay.");
    if (!ready()) throw fail(503, "Relay dark.");
    const client = context.client || {};
    const key = client.key || client.address || visitor;
    const clientLimit = launch ? launchClient : perClient;
    const globalLimit = launch ? launchGlobal : global;
    const caller = clientLimit.take(key);
    if (!caller.ok) throw fail(429, "The relay is cooling down.");
    const budget = globalLimit.take("all");
    if (!budget.ok) {
      caller.refund();
      throw fail(429, "The relay is cooling down.");
    }
    const text = launch ? formatLaunch({ visitor, client, session: body.session || {}, at: now() }) : formatPing({
      relayId,
      name: body.name,
      note: body.note,
      near: typeof body.near === "string" ? sanitizeName(body.near) : "",
      heading: Number(body.heading),
      height: Number(body.height),
      client,
      session: body.session || {},
    });
    let response;
    try {
      response = await fetchImpl(`${root}/api/sendText`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Api-Key": apiKey,
        },
        body: JSON.stringify({ session, chatId, text }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      caller.refund();
      budget.refund();
      throw fail(503, "Relay dark.");
    }
    if (!response.ok) {
      caller.refund();
      budget.refund();
      throw fail(503, "Relay dark.");
    }
    return { ok: true };
  }

  return { ready, send, sendLaunch: (body, context) => send(body, context, true) };
}

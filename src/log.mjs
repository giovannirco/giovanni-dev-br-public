// Structured logs, one JSON object per line on stdout.
//
// Alloy ships container stdout to Loki as-is, so the only contract that
// matters is that every line parses with `| json` and that the field names
// stay stable — dashboards are written against them. `level` is a string
// rather than pino's default number so `| json | level="error"` reads the way
// anyone would expect, and Loki's own level detection agrees with it.
//
// What is deliberately in here: the visitor's address, their coarse setup, and
// the questions they ask the orbit assistant. This is Gio's own site and the
// point is to see how it is used; the same details already go out in a launch
// ping. What is deliberately not in here: any header value beyond the ones
// named below, any credential, any upstream body.
import { pino } from "pino";
import { describeClient } from "./client.mjs";
import { originalScheme } from "./scheme.mjs";

const PROMPT_CHARS = 800;
const REPLY_CHARS = 1200;
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function createLogger({
  level = process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === "test" ? "silent" : "info"),
  destination,
} = {}) {
  return pino(
    {
      level,
      base: {
        service: "giovanni-dev-br",
        version: process.env.APP_VERSION || "",
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}

// Throws everything away. Tests inject this, and so does any caller that would
// rather not think about logging at all.
export const silentLogger = createLogger({ level: "silent" });

// Visitor-supplied text reaches these lines, so it is flattened first: a log
// line is one line, and a newline in a user agent or a prompt would otherwise
// split it into two and break `| json` on both halves.
function text(value, max) {
  return String(value ?? "")
    .replace(CONTROL, " ")
    .trim()
    .slice(0, max);
}

// Where a request landed, so a dashboard can separate a visitor loading the
// page from the browser fetching its bundle, and both from a probe.
export function requestKind(path) {
  if (path === "/api/healthz" || path === "/metrics") return "probe";
  if (path.startsWith("/api/") || path === "/tip") return "api";
  if (path.startsWith("/assets/") || /\.[a-z0-9]{2,5}$/i.test(path))
    return "asset";
  return "page";
}

// The visitor, described the same way a launch ping describes them. The
// address comes from the proxy-aware path, so it is the real caller or nothing.
export function clientFields(req) {
  const client = describeClient(req);
  return {
    ip: client.address,
    country: client.country,
    browser: client.browser,
    system: client.system,
    device: client.device,
    language: client.language,
  };
}

export function referrerOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
  } catch {
    return "";
  }
}

// Attaches the access log to a request: one line when the response finishes,
// whatever route produced it. Probes log at debug so a dashboard of real
// traffic is not two thirds kubelet.
export function logRequest(log, req, res, path) {
  const started = process.hrtime.bigint();
  const kind = requestKind(path);
  // Counted rather than read from content-length: JSON answers are chunked and
  // an event stream never has a length at all, so the header is absent exactly
  // where the number is most interesting.
  let bytes = 0;
  const { write, end } = res;
  res.write = function (chunk, ...rest) {
    if (chunk && typeof chunk !== "function") bytes += Buffer.byteLength(chunk);
    return write.call(this, chunk, ...rest);
  };
  res.end = function (chunk, ...rest) {
    if (chunk && typeof chunk !== "function") bytes += Buffer.byteLength(chunk);
    return end.call(this, chunk, ...rest);
  };
  // "close" rather than "finish" alone: a visitor who navigates away mid
  // answer never finishes the response, and a request that leaves no line is a
  // blind spot exactly where the interesting ones are. 499 is nginx's
  // convention for a client that hung up.
  let written = false;
  const emit = () => {
    if (written) return;
    written = true;
    log[kind === "probe" ? "debug" : "info"](
      {
        event: "request",
        kind,
        method: req.method,
        path: text(path, 300),
        status: res.writableFinished ? res.statusCode : 499,
        aborted: !res.writableFinished,
        duration_ms:
          Math.round(Number(process.hrtime.bigint() - started) / 1e3) / 1e3,
        bytes,
        scheme: originalScheme(req) || "unset",
        referrer: referrerOrigin(req.headers?.referer),
        ...clientFields(req),
      },
      `${req.method} ${path} ${res.writableFinished ? res.statusCode : 499}`,
    );
  };
  res.on("finish", emit);
  res.on("close", emit);
}

export function logChat(log, req, fields) {
  log.info(
    {
      event: "chat",
      ...fields,
      prompt: text(fields.prompt, PROMPT_CHARS),
      reply: text(fields.reply, REPLY_CHARS),
      ...clientFields(req),
    },
    `chat ${fields.outcome} ${fields.bodyId || "unscoped"}`,
  );
}

// A message actually left for Gio's phone, or did not.
export function logBeacon(log, req, fields) {
  log.info(
    { event: fields.kind, ...fields, ...clientFields(req) },
    `${fields.kind} ${fields.outcome}`,
  );
}

// Something a visitor did that the server declined: a cross-origin post, a
// quota, a method. These are the lines worth alerting on.
export function logRefused(log, req, path, reason) {
  log.warn(
    {
      event: "refused",
      reason,
      method: req.method,
      path: text(path, 300),
      origin: text(req.headers?.origin, 200),
      ...clientFields(req),
    },
    `refused ${reason} ${req.method} ${path}`,
  );
}

export function logUpstream(log, target, error) {
  log.error(
    {
      event: "upstream",
      target,
      status: error?.status || null,
      error: text(error?.message, 200),
    },
    `upstream ${target} failed`,
  );
}

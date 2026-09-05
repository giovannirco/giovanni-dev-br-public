export async function readBounded(response, limit = 512_000) {
  if (!response.body) return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("Upstream response too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function upstreamJson(response, limit) {
  return JSON.parse(await readBounded(response, limit));
}
export function createReadCache({ ttlMs = 30_000, failureMs = 2000, now = Date.now } = {}) {
  const entries = new Map();
  return async function cached(key, build) {
    const hit = entries.get(key);
    if (hit?.pending) return hit.pending;
    if (hit && now() < hit.expires) {
      if (hit.error) throw hit.error;
      return hit.value;
    }
    const entry = {};
    entries.set(key, entry);
    entry.pending = Promise.resolve().then(build).then(value => {
      entry.value = value;
      entry.expires = now() + ttlMs;
      return value;
    }, error => {
      entry.error = error;
      entry.expires = now() + failureMs;
      throw error;
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  };
}

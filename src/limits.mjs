// Sliding-window limiter with a hard ceiling on how many keys it will ever
// hold. Without that ceiling a loop of fresh keys grows the map forever, which
// is a slow leak against the pod's 512Mi limit rather than a rate limit.
export function createRateLimit({
  limit,
  windowMs,
  maxKeys = 4096,
  now = () => Date.now(),
}) {
  const hits = new Map();

  function dropExpired(t) {
    for (const [key, times] of hits) {
      while (times.length && t - times[0].at > windowMs) times.shift();
      if (!times.length) hits.delete(key);
    }
  }

  return {
    // Records an attempt and reports whether it is allowed.
    take(key) {
      const t = now();
      const times = hits.get(key) || [];
      // Re-inserting keeps the Map in least-recently-used order, so the
      // eviction below sheds idle keys instead of active ones.
      hits.delete(key);
      while (times.length && t - times[0].at > windowMs) times.shift();
      if (times.length >= limit) {
        hits.set(key, times);
        return {
          ok: false,
          retryAfter: Math.max(1, Math.ceil((windowMs - (t - times[0].at)) / 1000)),
        };
      }
      const ticket = { at: t };
      times.push(ticket);
      hits.set(key, times);
      if (hits.size > maxKeys) {
        dropExpired(t);
        for (const key of hits.keys()) {
          if (hits.size <= maxKeys) break;
          hits.delete(key);
        }
      }
      return { ok: true, retryAfter: 0, refund() {
        const current = hits.get(key);
        const index = current?.indexOf(ticket) ?? -1;
        if (index >= 0) current.splice(index, 1);
        if (current && !current.length) hits.delete(key);
      } };
    },
    // Gives back the most recent attempt. Tokens are spent before the work so
    // that concurrent requests cannot both slip through; when the work then
    // fails for a reason that is not the caller's fault, hand the token back
    // rather than locking them out of a retry.
    refund(key) {
      const times = hits.get(key);
      if (times?.length) times.pop();
      if (times && !times.length) hits.delete(key);
    },
    size() {
      return hits.size;
    },
  };
}

// How many completions may be open at the same time, which is a different
// question from how often someone may ask. A rate limit does not stop four
// visitors each holding a 45-second stream, and a single global number does
// not stop one visitor holding all of them: `perKey` bounds one caller's
// share, `limit` bounds what the gateway is asked to carry at once.
export function createConcurrency({ limit, perKey }) {
  const active = new Map();
  let total = 0;

  function held(key) {
    return active.get(key) || 0;
  }

  return {
    // A cheap look before the request body is read. `enter` decides for real.
    full(key) {
      return total >= limit || held(key) >= perKey;
    },
    // Returns the release function, or null when there is no room. Releasing
    // twice is a no-op, so a `finally` can call it without bookkeeping.
    enter(key) {
      if (total >= limit || held(key) >= perKey) return null;
      total += 1;
      active.set(key, held(key) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        total -= 1;
        const rest = held(key) - 1;
        if (rest > 0) active.set(key, rest);
        else active.delete(key);
      };
    },
    active() {
      return total;
    },
  };
}

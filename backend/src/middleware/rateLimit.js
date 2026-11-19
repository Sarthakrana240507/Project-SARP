// Simple in-memory fixed-window rate limiter (no extra dependency).
// Counters live in this process's memory: fine for a single server, and they reset on
// restart. A multi-server deployment would need a shared store (documented limitation).
const registry = new Set(); // every limiter, so tests can reset them all

function rateLimit({ windowMs, max, keyFn, message }) {
  const hits = new Map(); // key -> { count, resetAt }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(windowMs, 60000));
  sweep.unref();

  const middleware = (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: message || 'Too many attempts. Please try again later.',
        code: 'RATE_LIMITED',
        retry_after_seconds: retryAfter,
      });
    }
    next();
  };
  middleware.reset = () => hits.clear();
  registry.add(middleware);
  return middleware;
}

rateLimit.resetAll = () => registry.forEach((l) => l.reset()); // test helper; not reachable over HTTP

module.exports = { rateLimit };

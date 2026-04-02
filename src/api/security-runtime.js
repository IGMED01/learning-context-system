// @ts-check

/**
 * @typedef {import("node:http").IncomingMessage} IncomingMessage
 * @typedef {import("node:http").ServerResponse} ServerResponse
 */

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 120;
const DEFAULT_HEAVY_MAX = 30;
const DEFAULT_MAX_BUCKETS = 2_000;

/**
 * @param {unknown} value
 * @param {{ min: number, fallback: number }} options
 * @returns {number}
 */
function parsePositiveInt(value, options) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return options.fallback;
  }

  return Math.max(options.min, Math.trunc(numeric));
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function parseBoolean(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
function parseConnectSrcExtras(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => /^(https?|wss?):\/\/[^\s]+$/iu.test(entry));
}

/**
 * Resolves a safe CORS origin for the API runtime.
 * Defaults stay local-first unless an explicit origin is configured.
 *
 * @param {string | undefined} explicitOrigin
 * @param {string} host
 * @param {number} port
 * @returns {string}
 */
export function resolveCorsOrigin(explicitOrigin, host, port) {
  const normalizedExplicit = String(explicitOrigin ?? "").trim();
  if (normalizedExplicit && normalizedExplicit !== "*") {
    return normalizedExplicit;
  }

  const normalizedHost =
    host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host;

  return `http://${normalizedHost}:${port}`;
}

/**
 * @param {IncomingMessage} request
 * @param {boolean} trustProxy
 * @returns {string}
 */
function resolveClientIp(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      return forwarded.split(",")[0].trim();
    }
  }

  return request.socket.remoteAddress || "unknown";
}

/**
 * @param {ServerResponse} response
 */
export function applyBaseSecurityHeaders(response) {
  const connectSrcExtras = parseConnectSrcExtras(process.env.LCS_CONNECT_SRC_EXTRA);
  const connectSrc = ["'self'", ...connectSrcExtras].join(" ");

  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Origin-Agent-Cluster", "?1");
  response.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      `connect-src ${connectSrc}`
    ].join("; ")
  );
}

/**
 * @param {{
 *   heavyRoutes?: Iterable<string>,
 *   trustProxy?: boolean,
 *   windowMs?: number,
 *   maxRequests?: number,
 *   heavyMaxRequests?: number,
 *   maxBuckets?: number
 * }} [options]
 */
export function createRateLimiter(options = {}) {
  const configuredWindowMs = parsePositiveInt(
    options.windowMs ?? process.env.LCS_API_RATE_LIMIT_WINDOW_MS,
    { min: 1_000, fallback: DEFAULT_WINDOW_MS }
  );
  const configuredMaxRequests = parsePositiveInt(
    options.maxRequests ?? process.env.LCS_API_RATE_LIMIT_MAX,
    { min: 5, fallback: DEFAULT_MAX }
  );
  const configuredHeavyMaxRequests = parsePositiveInt(
    options.heavyMaxRequests ?? process.env.LCS_API_RATE_LIMIT_HEAVY_MAX,
    { min: 1, fallback: DEFAULT_HEAVY_MAX }
  );
  const heavyMaxRequests = Math.min(configuredMaxRequests, configuredHeavyMaxRequests);
  const maxBuckets = parsePositiveInt(options.maxBuckets, {
    min: 100,
    fallback: DEFAULT_MAX_BUCKETS
  });
  const trustProxy = options.trustProxy ?? parseBoolean(process.env.LCS_API_TRUST_PROXY);
  const heavyRoutes = new Set(options.heavyRoutes ?? []);

  /** @type {Map<string, { count: number, resetAt: number, lastSeenAt: number }>} */
  const buckets = new Map();
  let expiredEvictions = 0;
  let capacityEvictions = 0;

  /**
   * @param {number} now
   */
  function sweep(now) {
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
        expiredEvictions += 1;
      }
    }
  }

  /**
   * Evicts one bucket under pressure using a TTL-aware LRU strategy:
   * 1) prefer buckets closest to expiry (TTL-aware)
   * 2) tie-break by oldest lastSeenAt (LRU)
   * @param {number} now
   * @returns {boolean}
   */
  function evictOneBucket(now) {
    /** @type {string | null} */
    let candidateKey = null;
    let candidateTtl = Number.POSITIVE_INFINITY;
    let candidateLastSeen = Number.POSITIVE_INFINITY;

    for (const [key, bucket] of buckets.entries()) {
      const ttl = Math.max(0, bucket.resetAt - now);

      if (
        ttl < candidateTtl ||
        (ttl === candidateTtl && bucket.lastSeenAt < candidateLastSeen)
      ) {
        candidateKey = key;
        candidateTtl = ttl;
        candidateLastSeen = bucket.lastSeenAt;
      }
    }

    if (!candidateKey) {
      return false;
    }

    buckets.delete(candidateKey);
    capacityEvictions += 1;
    return true;
  }

  return {
    trustProxy,
    /**
     * @param {IncomingMessage} request
     * @param {string} pathname
     */
    check(request, pathname) {
      const now = Date.now();
      const clientIp = resolveClientIp(request, trustProxy);
      const isHeavyRoute = heavyRoutes.has(pathname);
      const limit = isHeavyRoute ? heavyMaxRequests : configuredMaxRequests;
      const bucketKey = `${clientIp}|${isHeavyRoute ? "heavy" : "default"}`;
      let existing = buckets.get(bucketKey);

      if (buckets.size >= maxBuckets || (existing && existing.resetAt <= now)) {
        sweep(now);
        existing = buckets.get(bucketKey);
      }

      if (!existing && buckets.size >= maxBuckets) {
        while (buckets.size >= maxBuckets && evictOneBucket(now)) {
          // Keep evicting until there is room for the incoming key.
        }
      }

      const resetAt =
        existing && existing.resetAt > now ? existing.resetAt : now + configuredWindowMs;
      const count = existing && existing.resetAt > now ? existing.count + 1 : 1;

      buckets.set(bucketKey, {
        count,
        resetAt,
        lastSeenAt: now
      });

      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000))
      };
    },
    getBucketCount() {
      return buckets.size;
    },
    getStats() {
      return {
        expiredEvictions,
        capacityEvictions,
        maxBuckets
      };
    }
  };
}

/**
 * @param {ServerResponse} response
 * @param {{ limit: number, remaining: number, retryAfterSeconds: number }} rate
 */
export function applyRateLimitHeaders(response, rate) {
  response.setHeader("X-RateLimit-Limit", String(rate.limit));
  response.setHeader("X-RateLimit-Remaining", String(rate.remaining));
  response.setHeader("X-RateLimit-Reset", String(rate.retryAfterSeconds));
}

/**
 * @param {ServerResponse} response
 * @param {{ limit: number, remaining: number, retryAfterSeconds: number }} rate
 */
export function sendRateLimitExceeded(response, rate) {
  response.writeHead(429, {
    "Content-Type": "application/json; charset=utf-8",
    "Retry-After": String(rate.retryAfterSeconds),
    "X-RateLimit-Limit": String(rate.limit),
    "X-RateLimit-Remaining": String(rate.remaining),
    "X-RateLimit-Reset": String(rate.retryAfterSeconds)
  });
  response.end(
    `${JSON.stringify(
      {
        error: true,
        message: "Rate limit exceeded.",
        reason: "rate-limited",
        retryAfterSeconds: rate.retryAfterSeconds
      },
      null,
      2
    )}\n`
  );
}

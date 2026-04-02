#!/usr/bin/env node
// @ts-check
/**
 * Production entry point — serves API + static UI from ui/dist.
 * This is the canonical boot path for the secured API runtime.
 */

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthMiddleware } from "./auth-middleware.js";
import {
  applyBaseSecurityHeaders,
  applyRateLimitHeaders,
  createRateLimiter,
  resolveCorsOrigin,
  sendRateLimitExceeded
} from "./security-runtime.js";
import { log } from "../core/logger.js";
import {
  createStartupProfiler,
  extractStaticAssetPathsFromHtml,
  parseBooleanEnv
} from "../core/startup-runtime.js";
import { resolveSafePathWithinWorkspace } from "../utils/path-utils.js";
import { migrate as migrateLocalOnlyToKnowledgeBackend } from "../migrations/migrateLocalOnlyToKnowledgeBackend.js";
import { migrate as migrateMemoryJSONLAddTimestamps } from "../migrations/migrateMemoryJSONLAddTimestamps.js";
import { migrate as migrateNotionSyncToNotionProvider } from "../migrations/migrateNotionSyncToNotionProvider.js";

// Import handlers to register all routes
import "./handlers.js";
import { handleRequest } from "./router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIST = path.resolve(__dirname, "../../ui/dist");
const MAX_STATIC_CACHE_ITEMS = 120;
/** @type {Map<string, { content: Buffer, mime: string, cacheControl: string }>} */
const staticFileCache = new Map();
const STARTUP_PROFILE_ENABLED = parseBooleanEnv(process.env.LCS_STARTUP_PROFILE_ENABLED, true);
const STARTUP_PREFETCH_ENABLED = parseBooleanEnv(process.env.LCS_STARTUP_PREFETCH_ENABLED, true);
const STARTUP_DEFERRED_WARMUP_ENABLED = parseBooleanEnv(
  process.env.LCS_STARTUP_DEFERRED_WARMUP_ENABLED,
  true
);
const STARTUP_WARMUP_DELAY_MS = parseTimeoutMs(
  process.env.LCS_STARTUP_WARMUP_DELAY_MS,
  250,
  0,
  30_000
);
const STARTUP_WARMUP_ASSET_CAP = parseIntegerInRange(
  process.env.LCS_STARTUP_WARMUP_ASSET_CAP,
  12,
  1,
  64
);
const startupProfiler = createStartupProfiler({
  enabled: STARTUP_PROFILE_ENABLED
});
/** @type {string[]} */
let prefetchedStartupAssets = [];

/**
 * @param {string | undefined} raw
 * @returns {string[]}
 */
function parseCsvEnv(raw) {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number}
 */
function parseTimeoutMs(value, fallback, min = 1_000, max = 600_000) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    return fallback;
  }

  return Math.trunc(numeric);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function parseIntegerInRange(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const normalized = Math.trunc(numeric);
  if (normalized < min || normalized > max) {
    return fallback;
  }

  return normalized;
}

/**
 * @param {string} key
 * @param {{ content: Buffer, mime: string, cacheControl: string }} value
 */
function setStaticCache(key, value) {
  if (staticFileCache.size >= MAX_STATIC_CACHE_ITEMS) {
    const oldest = staticFileCache.keys().next().value;
    if (oldest) {
      staticFileCache.delete(oldest);
    }
  }

  staticFileCache.set(key, value);
}

const MIME_TYPES = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".map":  "application/json",
};

async function runStartupMigrations() {
  const results = await Promise.allSettled([
    migrateLocalOnlyToKnowledgeBackend(process.cwd()),
    migrateMemoryJSONLAddTimestamps(process.cwd()),
    migrateNotionSyncToNotionProvider(process.cwd())
  ]);

  let failed = 0;
  for (const result of results) {
    if (result.status === "rejected") {
      failed += 1;
      log("warn", "startup migration failed", {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
      });
    }
  }

  return {
    attempted: results.length,
    failed
  };
}

async function prefetchStartupSpaIndex() {
  const indexPath = path.join(UI_DIST, "index.html");

  try {
    const cached = staticFileCache.get(indexPath);
    if (cached) {
      return {
        cached: true,
        assets: extractStaticAssetPathsFromHtml(cached.content.toString("utf8"), {
          maxAssets: STARTUP_WARMUP_ASSET_CAP
        })
      };
    }

    const content = await readFile(indexPath);
    setStaticCache(indexPath, {
      content,
      mime: "text/html; charset=utf-8",
      cacheControl: "no-cache"
    });

    return {
      cached: false,
      assets: extractStaticAssetPathsFromHtml(content.toString("utf8"), {
        maxAssets: STARTUP_WARMUP_ASSET_CAP
      })
    };
  } catch (error) {
    log("warn", "startup prefetch skipped", {
      path: indexPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      cached: false,
      assets: []
    };
  }
}

async function warmupStaticAssets(assetPaths) {
  const uniqueAssets = [...new Set(assetPaths)].slice(0, STARTUP_WARMUP_ASSET_CAP);
  const results = await Promise.allSettled(
    uniqueAssets.map(async (assetPath) => {
      const filePath = resolveSafePathWithinWorkspace(assetPath, UI_DIST, "startupWarmupPath");
      const ext = path.extname(filePath).toLowerCase();

      if (ext === ".html") {
        return {
          warmed: false
        };
      }

      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size > 512 * 1024) {
        return {
          warmed: false
        };
      }

      const content = await readFile(filePath);
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      setStaticCache(filePath, {
        content,
        mime,
        cacheControl: "public, max-age=31536000, immutable"
      });

      return {
        warmed: true
      };
    })
  );

  let warmed = 0;
  let failed = 0;

  for (const result of results) {
    if (result.status === "fulfilled" && result.value.warmed) {
      warmed += 1;
      continue;
    }

    if (result.status === "rejected") {
      failed += 1;
    }
  }

  return {
    candidates: uniqueAssets.length,
    warmed,
    failed
  };
}

async function runStartupPrefetch() {
  startupProfiler.checkpoint("startup-bootstrap-begin", {
    prefetchEnabled: STARTUP_PREFETCH_ENABLED
  });

  const tasks = [runStartupMigrations()];
  if (STARTUP_PREFETCH_ENABLED) {
    tasks.push(prefetchStartupSpaIndex());
  }

  const results = await Promise.allSettled(tasks);
  const migrationsResult = results[0];
  const prefetchResult = results[1];
  const migrationSummary =
    migrationsResult?.status === "fulfilled"
      ? migrationsResult.value
      : {
          attempted: 3,
          failed: 3
        };

  if (migrationsResult?.status === "rejected") {
    log("warn", "startup migration bootstrap failed", {
      error:
        migrationsResult.reason instanceof Error
          ? migrationsResult.reason.message
          : String(migrationsResult.reason)
    });
  }

  if (prefetchResult?.status === "fulfilled") {
    prefetchedStartupAssets = prefetchResult.value.assets;
  } else if (prefetchResult?.status === "rejected") {
    log("warn", "startup prefetch bootstrap failed", {
      error:
        prefetchResult.reason instanceof Error
          ? prefetchResult.reason.message
          : String(prefetchResult.reason)
    });
  }

  startupProfiler.checkpoint("startup-bootstrap-ready", {
    migrationFailures: migrationSummary.failed,
    prefetchedAssets: prefetchedStartupAssets.length
  });
}

async function runDeferredWarmup() {
  startupProfiler.checkpoint("startup-warmup-begin", {
    warmupEnabled: STARTUP_DEFERRED_WARMUP_ENABLED,
    prefetchedAssets: prefetchedStartupAssets.length
  });

  const [warmupResult, prefetchResult] = await Promise.allSettled([
    warmupStaticAssets(prefetchedStartupAssets),
    prefetchStartupSpaIndex()
  ]);

  const warmupSummary =
    warmupResult.status === "fulfilled"
      ? warmupResult.value
      : {
          candidates: prefetchedStartupAssets.length,
          warmed: 0,
          failed: 1
        };
  const prefetchedAssets =
    prefetchResult.status === "fulfilled" ? prefetchResult.value.assets.length : 0;

  if (warmupResult.status === "rejected") {
    log("warn", "startup deferred warmup failed", {
      error: warmupResult.reason instanceof Error ? warmupResult.reason.message : String(warmupResult.reason)
    });
  }

  if (prefetchResult.status === "rejected") {
    log("warn", "startup deferred prefetch refresh failed", {
      error:
        prefetchResult.reason instanceof Error ? prefetchResult.reason.message : String(prefetchResult.reason)
    });
  }

  startupProfiler.checkpoint("startup-warmup-ready", {
    warmedAssets: warmupSummary.warmed,
    warmupFailures: warmupSummary.failed,
    prefetchedAssets
  });

  const summary = startupProfiler.summary({
    cacheItems: staticFileCache.size
  });

  if (summary) {
    log("info", "startup profile summary", summary);
  }
}

async function scheduleDeferredWarmup() {
  if (!STARTUP_DEFERRED_WARMUP_ENABLED) {
    const summary = startupProfiler.summary({
      cacheItems: staticFileCache.size,
      warmup: "disabled"
    });
    if (summary) {
      log("info", "startup profile summary", summary);
    }
    return;
  }

  const timer = setTimeout(() => {
    void runDeferredWarmup();
  }, STARTUP_WARMUP_DELAY_MS);
  timer.unref?.();
}

await runStartupPrefetch();

/**
 * Try to serve a static file from ui/dist.
 * @param {string} urlPath
 * @param {http.ServerResponse} res
 * @returns {boolean}
 */
async function tryServeStatic(urlPath, res) {
  const rawPath = String(urlPath ?? "");
  const normalizedPath = rawPath.replace(/^[/\\]+/u, "");
  if (!normalizedPath) {
    return false;
  }

  let filePath;
  try {
    filePath = resolveSafePathWithinWorkspace(normalizedPath, UI_DIST, "staticPath");
  } catch (error) {
    log("warn", "static file path rejected", {
      path: rawPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return false;

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const cacheControl = ext === ".html"
      ? "no-cache"
      : "public, max-age=31536000, immutable";
    const cached = staticFileCache.get(filePath);
    if (cached) {
      res.writeHead(200, {
        "Content-Type": cached.mime,
        "Content-Length": cached.content.length,
        "Cache-Control": cached.cacheControl
      });
      res.end(cached.content);
      return true;
    }

    const content = await readFile(filePath);

    if (ext !== ".html" && fileStat.size <= 512 * 1024) {
      setStaticCache(filePath, { content, mime, cacheControl });
    }

    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": content.length,
      "Cache-Control": cacheControl,
    });
    res.end(content);
    return true;
  } catch (error) {
    log("warn", "static file read failed", {
      path: rawPath,
      filePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

/**
 * Serve index.html for SPA routing.
 * @param {http.ServerResponse} res
 */
async function serveSpaFallback(res) {
  const indexPath = path.join(UI_DIST, "index.html");
  try {
    const cached = staticFileCache.get(indexPath);
    if (cached) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": cached.content.length,
        "Cache-Control": "no-cache"
      });
      res.end(cached.content);
      return;
    }

    const content = await readFile(indexPath);
    setStaticCache(indexPath, {
      content,
      mime: "text/html; charset=utf-8",
      cacheControl: "no-cache"
    });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(content);
  } catch (error) {
    log("warn", "spa fallback failed", {
      path: indexPath,
      error: error instanceof Error ? error.message : String(error)
    });
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("UI not built. Run: cd ui && npm run build");
  }
}

const host = process.env.LCS_API_HOST || "127.0.0.1";
const port = Number(process.env.LCS_API_PORT || 3100);
const corsOrigin = resolveCorsOrigin(
  process.env.LCS_API_CORS_ORIGIN || process.env.LCS_API_CORS,
  host,
  port
);
const requireAuth = process.env.LCS_API_REQUIRE_AUTH !== "false";
const apiKeys = [
  ...(process.env.LCS_API_KEY ? [process.env.LCS_API_KEY] : []),
  ...parseCsvEnv(process.env.LCS_API_KEYS)
];
const jwtSecret = process.env.LCS_API_JWT_SECRET || "";
const jwtIssuer = process.env.LCS_API_JWT_ISSUER || "";
const jwtAudience = parseCsvEnv(process.env.LCS_API_JWT_AUDIENCE);
const jwtClockSkewSeconds = parseTimeoutMs(
  process.env.LCS_JWT_CLOCK_SKEW ?? process.env.LCS_API_JWT_CLOCK_SKEW_SECONDS,
  30,
  0,
  600
);
const auth = createAuthMiddleware({
  requireAuth,
  apiKeys,
  jwtSecret,
  jwtIssuer,
  jwtAudience,
  jwtClockSkewSeconds
});
const PUBLIC_API_ROUTES = new Set(["/api/health"]);
const rateLimiter = createRateLimiter({
  heavyRoutes: [
    "/api/agent",
    "/api/agent/stream",
    "/api/mitosis",
    "/api/chat",
    "/api/eval",
    "/api/rollback-check"
  ]
});

/**
 * @param {http.ServerResponse} res
 * @param {{ statusCode?: number, message: string, reason?: string }} input
 */
function sendAuthError(res, input) {
  const statusCode = input.statusCode ?? 401;
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    `${JSON.stringify(
      {
        error: true,
        message: input.message,
        reason: input.reason ?? "unauthorized"
      },
      null,
      2
    )}\n`
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  applyBaseSecurityHeaders(res);

  // API routes → router.js (handlers.js registered routes)
  if (pathname.startsWith("/api/")) {
    if (req.method !== "OPTIONS") {
      const rateLimit = rateLimiter.check(req, pathname);
      applyRateLimitHeaders(res, rateLimit);

      if (!rateLimit.allowed) {
        sendRateLimitExceeded(res, rateLimit);
        return;
      }
    }

    if (req.method !== "OPTIONS" && !PUBLIC_API_ROUTES.has(pathname)) {
      const authResult = auth.authorize({
        headers: req.headers
      });

      if (!authResult.authorized) {
        sendAuthError(res, {
          statusCode: authResult.statusCode,
          message: authResult.error ?? "Authentication required.",
          reason: authResult.reason
        });
        return;
      }
    }

    await handleRequest(req, res, { corsOrigin });
    return;
  }

  // Static files from ui/dist
  if (await tryServeStatic(pathname, res)) return;

  // SPA fallback — serve index.html for client-side routing
  await serveSpaFallback(res);
});

server.keepAliveTimeout = parseTimeoutMs(
  process.env.LCS_KEEP_ALIVE_TIMEOUT ?? process.env.LCS_API_KEEP_ALIVE_TIMEOUT,
  30_000
);
server.headersTimeout = parseTimeoutMs(
  process.env.LCS_HEADERS_TIMEOUT ?? process.env.LCS_API_HEADERS_TIMEOUT,
  30_000
);
server.requestTimeout = parseTimeoutMs(
  process.env.LCS_REQUEST_TIMEOUT ?? process.env.LCS_API_REQUEST_TIMEOUT,
  60_000
);

server.listen(port, host, () => {
  startupProfiler.checkpoint("startup-listen-ready", {
    host,
    port
  });
  console.log(`NEXUS production server listening on http://${host}:${port}`);
  console.log(`  API:  http://${host}:${port}/api/health`);
  console.log(`  UI:   http://${host}:${port}/`);
  void scheduleDeferredWarmup();
});

const shutdown = () => {
  const summary = startupProfiler.summary({
    cacheItems: staticFileCache.size,
    reason: "shutdown"
  });
  if (summary) {
    log("info", "startup profile summary", summary);
  }
  console.log("Shutting down...");
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

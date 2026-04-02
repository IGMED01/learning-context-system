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
import { resolveSafePathWithinWorkspace } from "../utils/path-utils.js";

// Import handlers to register all routes
import "./handlers.js";
import { handleRequest } from "./router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIST = path.resolve(__dirname, "../../ui/dist");
const MAX_STATIC_CACHE_ITEMS = 120;
/** @type {Map<string, { content: Buffer, mime: string, cacheControl: string }>} */
const staticFileCache = new Map();

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
  console.log(`NEXUS production server listening on http://${host}:${port}`);
  console.log(`  API:  http://${host}:${port}/api/health`);
  console.log(`  UI:   http://${host}:${port}/`);
});

const shutdown = () => {
  console.log("Shutting down...");
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

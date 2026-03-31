#!/usr/bin/env node
// @ts-check
/**
 * Production entry point — serves API + static UI from ui/dist.
 * This is the canonical boot path for the secured API runtime.
 */

import http from "node:http";
import fs from "node:fs";
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

// Import handlers to register all routes
import "./handlers.js";
import { handleRequest } from "./router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIST = path.resolve(__dirname, "../../ui/dist");

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
function tryServeStatic(urlPath, res) {
  // Prevent directory traversal
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(UI_DIST, safePath);

  if (!filePath.startsWith(UI_DIST)) return false;

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const content = fs.readFileSync(filePath);

    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": content.length,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serve index.html for SPA routing.
 * @param {http.ServerResponse} res
 */
function serveSpaFallback(res) {
  const indexPath = path.join(UI_DIST, "index.html");
  try {
    const content = fs.readFileSync(indexPath, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(content);
  } catch {
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
const jwtClockSkewSeconds = Number(process.env.LCS_API_JWT_CLOCK_SKEW_SECONDS || 30);
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
  if (tryServeStatic(pathname, res)) return;

  // SPA fallback — serve index.html for client-side routing
  serveSpaFallback(res);
});

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

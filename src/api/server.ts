/**
 * LCS API Server — HTTP entry point.
 *
 * Starts a zero-dependency HTTP server that exposes all LCS
 * functionality as REST endpoints. Designed for:
 *
 *   1. Frontend integration (CRM, Legal Salta UI)
 *   2. External system consumption (webhooks, automation)
 *   3. Development/testing (curl, Postman, etc.)
 *
 * Usage:
 *   node src/api/server.js                          → localhost:3100
 *   LCS_API_PORT=8080 node src/api/server.js        → localhost:8080
 *   LCS_API_HOST=0.0.0.0 node src/api/server.js    → all interfaces
 *   LCS_API_CORS=https://app.example.com            → restrict CORS
 *
 * Available endpoints (after boot):
 *   GET  /api/health   → system health check
 *   GET  /api/routes   → list all endpoints
 *   POST /api/recall   → query memory
 *   POST /api/teach    → generate learning packet
 *   POST /api/remember → save memory
 *   POST /api/close    → close session
 *   POST /api/ingest   → ingest documents
 *   POST /api/guard    → evaluate guard rules
 */

import { createServer } from "node:http";
import type { ApiServerConfig } from "../types/core-contracts.d.ts";

import { handleRequest, registerMiddleware } from "./router.js";
import { createGuardMiddleware } from "./guard-middleware.js";

// Side-effect import: registers all route handlers
import "./handlers.js";

// ── Config from environment ──────────────────────────────────────────

function loadServerConfig(): ApiServerConfig {
  return {
    port: parseInt(process.env.LCS_API_PORT ?? "3100", 10),
    host: process.env.LCS_API_HOST ?? "127.0.0.1",
    corsOrigin: process.env.LCS_API_CORS ?? "*",
    guardEnabled: process.env.LCS_API_GUARD !== "false"
  };
}

// ── Boot ──────────────────────────────────────────────────────────────

function boot(): void {
  const config = loadServerConfig();

  // Wire guard middleware if enabled
  if (config.guardEnabled) {
    registerMiddleware(createGuardMiddleware());
  }

  const server = createServer((req, res) => {
    handleRequest(req, res, { corsOrigin: config.corsOrigin }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: true, message }));
    });
  });

  server.listen(config.port, config.host, () => {
    const base = `http://${config.host}:${config.port}`;

    console.log("");
    console.log("  ┌─────────────────────────────────────────┐");
    console.log("  │  LCS API Server                         │");
    console.log("  │─────────────────────────────────────────│");
    console.log(`  │  Local:   ${base.padEnd(30)}│`);
    console.log(`  │  Guard:   ${(config.guardEnabled ? "enabled" : "disabled").padEnd(30)}│`);
    console.log(`  │  CORS:    ${config.corsOrigin.slice(0, 28).padEnd(30)}│`);
    console.log("  │                                         │");
    console.log("  │  Endpoints:                             │");
    console.log("  │    GET  /api/health                     │");
    console.log("  │    GET  /api/routes                     │");
    console.log("  │    POST /api/recall                     │");
    console.log("  │    POST /api/teach                      │");
    console.log("  │    POST /api/remember                   │");
    console.log("  │    POST /api/close                      │");
    console.log("  │    POST /api/ingest                     │");
    console.log("  │    POST /api/guard                      │");
    console.log("  │    POST /api/eval                       │");
    console.log("  │    GET  /api/metrics                    │");
    console.log("  │    POST /api/alerts                     │");
    console.log("  │    GET  /api/alerts                     │");
    console.log("  │    POST /api/workflow                   │");
    console.log("  │    POST /api/conversation               │");
    console.log("  │    POST /api/conversation/turn          │");
    console.log("  │    GET  /api/conversation/list          │");
    console.log("  │    POST /api/prompts                    │");
    console.log("  │    GET  /api/prompts                    │");
    console.log("  │    POST /api/prompts/rollback           │");
    console.log("  │    GET  /api/snapshots                  │");
    console.log("  │    GET  /api/model-config               │");
    console.log("  │    POST /api/model-config               │");
    console.log("  │    POST /api/rollback-check             │");
    console.log("  │    GET  /api/score-trend                │");
    console.log("  └─────────────────────────────────────────┘");
    console.log("");
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n  Shutting down LCS API Server...");
    server.close(() => {
      console.log("  Server closed.");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

boot();

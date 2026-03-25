// @ts-check

/**
 * LCS API Server — HTTP entry point.
 *
 * Usage:
 *   node src/api/server.js                          → localhost:3100
 *   LCS_API_PORT=8080 node src/api/server.js        → localhost:8080
 *   LCS_API_HOST=0.0.0.0 node src/api/server.js    → all interfaces
 *   LCS_API_CORS=https://app.example.com            → restrict CORS
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleRequest, registerMiddleware } from "./router.js";
import { createGuardMiddleware } from "./guard-middleware.js";

// Side-effect import: registers all route handlers
import "./handlers.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DEMO_HTML = resolve(__dirname, "../../demo/index.html");

// ── Config from environment ──────────────────────────────────────────

function loadServerConfig() {
  return {
    port: parseInt(process.env.LCS_API_PORT ?? "3100", 10),
    host: process.env.LCS_API_HOST ?? "127.0.0.1",
    corsOrigin: process.env.LCS_API_CORS ?? "*",
    guardEnabled: process.env.LCS_API_GUARD !== "false"
  };
}

// ── Boot ──────────────────────────────────────────────────────────────

function boot() {
  const config = loadServerConfig();

  if (config.guardEnabled) {
    registerMiddleware(createGuardMiddleware());
  }

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";

    // Serve demo UI at root
    if (req.method === "GET" && (url === "/" || url === "/demo")) {
      try {
        const html = await readFile(DEMO_HTML, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Demo not found");
      }
      return;
    }

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

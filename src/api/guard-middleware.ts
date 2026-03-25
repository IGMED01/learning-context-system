/**
 * Guard Middleware for the API layer.
 *
 * Runs the guard engine on incoming requests BEFORE they reach
 * the route handler. This mirrors the CLI guard gate but operates
 * on HTTP requests instead of argv.
 *
 * The middleware extracts the "query" field from the request body
 * and evaluates it against the project's guard config. If blocked,
 * returns 403 immediately without touching the handler.
 *
 * Paths that skip guard evaluation:
 *   - /api/health (diagnostic, no user query)
 *   - /api/routes (introspection)
 *   - /api/guard  (the guard endpoint itself — avoid recursion)
 *   - GET requests (no body to guard)
 */

import type { ApiRequest, ApiResponse, GuardConfig } from "../types/core-contracts.d.ts";
import type { Middleware } from "./router.js";

import { evaluateGuard } from "../guard/guard-engine.js";
import { errorResponse } from "./router.js";
import { loadProjectConfig } from "../io/config-file.js";

const SKIP_PATHS = new Set(["/api/health", "/api/routes", "/api/guard", "/api/metrics", "/api/alerts", "/api/conversation/list", "/api/prompts", "/api/snapshots", "/api/model-config", "/api/score-trend"]);

let cachedGuardConfig: GuardConfig | null = null;

async function getGuardConfig(): Promise<GuardConfig> {
  if (cachedGuardConfig) {
    return cachedGuardConfig;
  }

  try {
    const loaded = await loadProjectConfig({ cwd: process.cwd() });
    const guard = loaded.config.guard;

    cachedGuardConfig = {
      enabled: guard?.enabled ?? false,
      rules: guard?.rules ?? [],
      defaultBlockMessage:
        guard?.defaultBlockMessage ??
        "This query is outside the scope of this project."
    };
  } catch {
    cachedGuardConfig = {
      enabled: false,
      rules: [],
      defaultBlockMessage: "This query is outside the scope of this project."
    };
  }

  return cachedGuardConfig;
}

export function createGuardMiddleware(): Middleware {
  return async (req: ApiRequest, next: () => Promise<ApiResponse>): Promise<ApiResponse> => {
    // Skip guard for non-guarded paths and GET requests
    if (req.method !== "POST" || SKIP_PATHS.has(req.path)) {
      return next();
    }

    const guardConfig = await getGuardConfig();

    // If guard is disabled, pass through
    if (!guardConfig.enabled) {
      return next();
    }

    // Extract the query-like field from the request body
    const query =
      typeof req.body.query === "string" ? req.body.query :
      typeof req.body.task === "string" ? req.body.task :
      typeof req.body.objective === "string" ? req.body.objective :
      typeof req.body.content === "string" ? req.body.content :
      "";

    // No query to guard — pass through
    if (query.trim().length === 0) {
      return next();
    }

    const guardResult = evaluateGuard(
      {
        query,
        project: typeof req.body.project === "string" ? req.body.project : "",
        command: req.path.replace("/api/", "")
      },
      guardConfig
    );

    if (guardResult.blocked) {
      return errorResponse(403, guardResult.userMessage, {
        guard: {
          blocked: true,
          blockedBy: guardResult.blockedBy,
          results: guardResult.results,
          durationMs: guardResult.durationMs
        }
      });
    }

    return next();
  };
}

/** Reset cached config — useful for testing */
export function resetGuardConfigCache(): void {
  cachedGuardConfig = null;
}

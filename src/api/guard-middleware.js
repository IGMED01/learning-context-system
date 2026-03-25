// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").ApiRequest} ApiRequest
 * @typedef {import("../types/core-contracts.d.ts").ApiResponse} ApiResponse
 * @typedef {import("../types/core-contracts.d.ts").GuardConfig} GuardConfig
 * @typedef {import("./router.js").Middleware} Middleware
 */

import { evaluateGuard } from "../guard/guard-engine.js";
import { errorResponse } from "./router.js";
import { loadProjectConfig } from "../io/config-file.js";

const SKIP_PATHS = new Set(["/api/health", "/api/routes", "/api/guard", "/api/metrics", "/api/alerts", "/api/conversation/list", "/api/prompts", "/api/snapshots", "/api/model-config", "/api/score-trend"]);

/** @type {GuardConfig | null} */
let cachedGuardConfig = null;

/**
 * @returns {Promise<GuardConfig>}
 */
async function getGuardConfig() {
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

/**
 * @returns {Middleware}
 */
export function createGuardMiddleware() {
  return async (/** @type {ApiRequest} */ req, /** @type {() => Promise<ApiResponse>} */ next) => {
    if (req.method !== "POST" || SKIP_PATHS.has(req.path)) {
      return next();
    }

    const guardConfig = await getGuardConfig();

    if (!guardConfig.enabled) {
      return next();
    }

    const query =
      typeof req.body.query === "string" ? req.body.query :
      typeof req.body.task === "string" ? req.body.task :
      typeof req.body.objective === "string" ? req.body.objective :
      typeof req.body.content === "string" ? req.body.content :
      "";

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

export function resetGuardConfigCache() {
  cachedGuardConfig = null;
}

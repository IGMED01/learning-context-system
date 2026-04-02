// @ts-check

import { registerCommand } from "../../core/command-registry.js";
import {
  formatSessionCosts,
  getSessionCosts,
  restoreSessionCosts
} from "../../observability/cost-tracker.js";
import { jsonResponse } from "../router.js";

registerCommand({
  name: "costs.get",
  method: "GET",
  path: "/api/costs/:sessionId",
  handler: async (req) => {
    const sessionId = String(req.params?.sessionId ?? "").trim();
    if (!sessionId) {
      return jsonResponse(400, {
        status: "error",
        error: "Missing sessionId."
      });
    }

    const cwd =
      typeof req.headers?.["x-data-dir"] === "string" && req.headers["x-data-dir"].trim()
        ? req.headers["x-data-dir"].trim()
        : process.cwd();

    let costs = getSessionCosts(sessionId);
    if (!costs) {
      costs = await restoreSessionCosts(sessionId, cwd);
    }

    if (!costs) {
      return jsonResponse(404, {
        status: "error",
        error: "Session not found.",
        sessionId
      });
    }

    return jsonResponse(200, {
      status: "ok",
      sessionId,
      costs,
      summary: formatSessionCosts(sessionId)
    });
  }
});


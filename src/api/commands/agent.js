// @ts-check

import path from "node:path";
import { registerCommand } from "../../core/command-registry.js";
import { resolveEndpointContextProfile } from "../../context/context-mode.js";
import { runAgentWithRecovery } from "../../orchestration/agent-query-loop.js";
import { startBackgroundSummary } from "../../orchestration/agent-summarizer.js";
import { log } from "../../core/logger.js";
import { resolveSafePathWithinWorkspace as resolveWorkspacePath } from "../../utils/path-utils.js";

const API_WORKSPACE_ROOT = path.resolve(process.cwd());

/**
 * @param {number | undefined} value
 * @param {{ min: number, max: number, fallback: number }} range
 */
function clampInt(value, range) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return range.fallback;
  }

  const normalized = Math.trunc(value);
  return Math.max(range.min, Math.min(range.max, normalized));
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} error
 */
function normalizeErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error ?? "unknown error");
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @param {string} corsOrigin
 */
function sendJson(res, status, body, corsOrigin) {
  if (res.writableEnded) {
    return;
  }

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-API-Key, X-Project, X-Data-Dir, X-Request-Id",
    "Access-Control-Max-Age": "86400"
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {Record<string, unknown>} event
 */
function sendSseEvent(res, event) {
  if (res.writableEnded || res.destroyed) {
    return false;
  }

  res.write(`data: ${JSON.stringify(event)}\n\n`);
  return true;
}

/**
 * @typedef {{
 *   runAgentWithRecoveryFn?: typeof runAgentWithRecovery
 *   startBackgroundSummaryFn?: typeof startBackgroundSummary
 * }} AgentStreamDependencies
 */

/**
 * @param {AgentStreamDependencies} [deps]
 */
export function createAgentStreamRawHandler(deps = {}) {
  const runAgentWithRecoveryFn = typeof deps.runAgentWithRecoveryFn === "function"
    ? deps.runAgentWithRecoveryFn
    : runAgentWithRecovery;
  const startBackgroundSummaryFn = typeof deps.startBackgroundSummaryFn === "function"
    ? deps.startBackgroundSummaryFn
    : startBackgroundSummary;

  /**
   * @param {import("../../types/core-contracts.d.ts").ApiRequest} req
   * @param {{
   *   httpReq: import("node:http").IncomingMessage,
   *   httpRes: import("node:http").ServerResponse,
   *   corsOrigin: string
   * }} context
   */
  return async (req, context) => {
    const body = asRecord(req.body);
    const task = typeof body.task === "string" ? body.task.trim() : "";

    if (!task) {
      sendJson(context.httpRes, 400, {
        error: true,
        message: "Missing required field: task"
      }, context.corsOrigin);
      return true;
    }

    if (task.length > 4000) {
      sendJson(context.httpRes, 400, {
        error: true,
        message: "Field 'task' exceeds max length (4000 chars)."
      }, context.corsOrigin);
      return true;
    }

    let workspace = API_WORKSPACE_ROOT;

    try {
      workspace =
        typeof body.workspace === "string"
          ? resolveWorkspacePath(body.workspace, API_WORKSPACE_ROOT, "workspace")
          : API_WORKSPACE_ROOT;
    } catch (error) {
      sendJson(context.httpRes, 400, {
        error: true,
        message: normalizeErrorMessage(error)
      }, context.corsOrigin);
      return true;
    }

    const changedFiles =
      Array.isArray(body.changedFiles)
        ? body.changedFiles.filter((value) => typeof value === "string").slice(0, 100)
        : [];
    const objective = typeof body.objective === "string" ? body.objective : "";
    const contextProfile = resolveEndpointContextProfile("agent", {
      tokenBudget: typeof body.tokenBudget === "number" ? body.tokenBudget : undefined,
      maxChunks: typeof body.maxChunks === "number" ? body.maxChunks : undefined
    }, {
      query: `${task} ${objective}`.trim(),
      changedFilesCount: changedFiles.length,
      chunkCount: changedFiles.length
    });

    const agentType = ["coder", "reviewer", "tester", "analyst", "security"].includes(String(body.agentType))
      ? /** @type {"coder" | "reviewer" | "tester" | "analyst" | "security"} */ (body.agentType)
      : "coder";

    const streamOptions = {
      task,
      objective,
      workspace,
      changedFiles,
      focus: typeof body.focus === "string" ? body.focus : undefined,
      project: typeof body.project === "string" ? body.project : "default",
      agentType,
      tokenBudget: contextProfile.tokenBudget,
      maxChunks: contextProfile.maxChunks,
      runGate: body.runGate === true,
      language: typeof body.language === "string" ? body.language : undefined,
      framework: typeof body.framework === "string" ? body.framework : undefined,
      useSwarm: body.useSwarm === true,
      swarmAgents: clampInt(
        typeof body.swarmAgents === "number" ? body.swarmAgents : undefined,
        { min: 1, max: 8, fallback: 3 }
      ),
      scoringProfile: contextProfile.scoringProfile
    };

    const response = context.httpRes;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": context.corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-API-Key, X-Project, X-Data-Dir, X-Request-Id",
      "Access-Control-Max-Age": "86400"
    });
    response.write(": stream-open\n\n");

    const abortController = new AbortController();
    const onClose = () => abortController.abort();
    context.httpReq.socket?.once("close", onClose);
    /** @type {string[]} */
    const currentTranscript = [];

    sendSseEvent(response, {
      phase: "meta",
      status: "started",
      contextMode: contextProfile.mode,
      tokenBudget: contextProfile.tokenBudget,
      maxChunks: contextProfile.maxChunks
    });

    const summaryController = startBackgroundSummaryFn(
      `agent-stream:${task}`,
      () => currentTranscript,
      (summary) => {
        sendSseEvent(response, {
          phase: "summary",
          text: summary
        });
      }
    );

    try {
      const generator = runAgentWithRecoveryFn({
        ...streamOptions,
        signal: abortController.signal
      });

      for await (const event of generator) {
        currentTranscript.push(JSON.stringify(event));
        if (currentTranscript.length > 100) {
          currentTranscript.splice(0, currentTranscript.length - 100);
        }

        if (!sendSseEvent(response, event)) {
          break;
        }
      }
    } catch (error) {
      const message = normalizeErrorMessage(error);
      log("warn", "agent stream failed", {
        error: message
      });
      sendSseEvent(response, {
        phase: "error",
        status: "failed",
        error: message
      });
    } finally {
      summaryController.stop();
      context.httpReq.socket?.off("close", onClose);
      if (!response.writableEnded) {
        response.end();
      }
    }

    return true;
  };
}

registerCommand({
  name: "agent.stream",
  method: "POST",
  path: "/api/agent/stream",
  rawHandler: createAgentStreamRawHandler()
});

// @ts-check

import { spawnNexusAgent } from "./nexus-agent-orchestrator.js";
import { runRepairLoop } from "./repair-loop.js";
import {
  TASK_STATUS,
  TASK_TYPES,
  createTask,
  isTerminal,
  updateTaskStatus
} from "../core/task.js";

/**
 * @typedef {{
 *   task: string,
 *   objective?: string,
 *   workspace?: string,
 *   changedFiles?: string[],
 *   focus?: string,
 *   project?: string,
 *   agentType?: "coder" | "reviewer" | "tester" | "analyst" | "security",
 *   tokenBudget?: number,
 *   maxChunks?: number,
 *   runGate?: boolean,
 *   language?: string,
 *   framework?: string,
 *   useSwarm?: boolean,
 *   swarmAgents?: number,
 *   scoringProfile?: string,
 *   sddProfile?: string,
 *   signal?: AbortSignal,
 *   maxRepairIterations?: number
 * }} AgentQueryLoopOptions
 */

/**
 * @typedef {{
 *   spawnAgent?: typeof spawnNexusAgent,
 *   repairLoop?: typeof runRepairLoop
 * }} AgentQueryLoopDependencies
 */

/**
 * @typedef {{
 *   phase: "select" | "axioms" | "agent" | "repair" | "done",
 *   status: "started" | "done" | "success" | "failed" | "cancelled",
 *   taskId: string,
 *   attempt?: number,
 *   error?: string
 * }} AgentQueryLoopEvent
 */

/**
 * @typedef {{
 *   success: boolean,
 *   output: string,
 *   taskId: string,
 *   error?: string,
 *   attempts: number
 * }} AgentQueryLoopResult
 */

/**
 * @param {unknown} value
 */
function isAbortSignalLike(value) {
  return Boolean(value) && typeof value === "object" && "aborted" in /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 */
function normalizeMaxRepairIterations(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 3;
  }

  return Math.max(0, Math.min(10, Math.trunc(value)));
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
 * @param {string} taskId
 * @param {number} attempts
 * @returns {AgentQueryLoopResult}
 */
function buildCancelledResult(taskId, attempts) {
  return {
    success: false,
    output: "",
    taskId,
    error: "cancelled",
    attempts
  };
}

/**
 * @param {() => void} cancelTask
 * @param {string} taskId
 * @param {number} attempts
 * @returns {AgentQueryLoopResult}
 */
function finalizeCancelled(cancelTask, taskId, attempts) {
  cancelTask("cancelled");
  return buildCancelledResult(taskId, attempts);
}

/**
 * Query loop with recovery path (agent retry + single-step repair attempt).
 *
 * Yields progress events suitable for streaming consumers.
 *
 * @param {AgentQueryLoopOptions} opts
 * @param {AgentQueryLoopDependencies} [deps]
 * @returns {AsyncGenerator<AgentQueryLoopEvent, AgentQueryLoopResult, void>}
 */
export async function* runAgentWithRecovery(opts, deps = {}) {
  const input = opts && typeof opts === "object" ? opts : /** @type {AgentQueryLoopOptions} */ ({ task: "agent-query" });
  const workspace = typeof input.workspace === "string" && input.workspace.trim()
    ? input.workspace.trim()
    : process.cwd();
  const maxRepairIterations = normalizeMaxRepairIterations(input.maxRepairIterations);
  const signal = isAbortSignalLike(input.signal)
    ? /** @type {AbortSignal} */ (input.signal)
    : undefined;
  const spawnAgent = typeof deps.spawnAgent === "function" ? deps.spawnAgent : spawnNexusAgent;
  const repairLoop = typeof deps.repairLoop === "function" ? deps.repairLoop : runRepairLoop;

  const task = createTask(TASK_TYPES.AGENT, input.task, {
    workspace,
    maxRepairIterations
  });

  updateTaskStatus(task.id, TASK_STATUS.RUNNING);

  const cancelTask = (reason = "cancelled") => {
    if (!isTerminal(task.status)) {
      updateTaskStatus(task.id, TASK_STATUS.CANCELLED, reason);
    }
  };

  const isCancelled = () => signal?.aborted || task.abortController.signal.aborted;

  /** @type {(() => void) | null} */
  let detachAbort = null;

  if (signal) {
    const onAbort = () => {
      task.abortController.abort();
      cancelTask("cancelled");
    };

    signal.addEventListener("abort", onAbort, { once: true });
    detachAbort = () => signal.removeEventListener("abort", onAbort);
  }

  /** @type {string | null} */
  let recoveredOutput = null;
  let attempts = 0;
  let lastError = "Max iterations reached";

  try {
    if (isCancelled()) {
      yield { phase: "done", status: "cancelled", taskId: task.id };
      return finalizeCancelled(cancelTask, task.id, attempts);
    }

    yield { phase: "select", status: "started", taskId: task.id };
    if (isCancelled()) {
      yield { phase: "select", status: "cancelled", taskId: task.id };
      yield { phase: "done", status: "cancelled", taskId: task.id };
      return finalizeCancelled(cancelTask, task.id, attempts);
    }
    yield { phase: "select", status: "done", taskId: task.id };

    yield { phase: "axioms", status: "started", taskId: task.id };
    if (isCancelled()) {
      yield { phase: "axioms", status: "cancelled", taskId: task.id };
      yield { phase: "done", status: "cancelled", taskId: task.id };
      return finalizeCancelled(cancelTask, task.id, attempts);
    }
    yield { phase: "axioms", status: "done", taskId: task.id };

    for (let index = 0; index <= maxRepairIterations; index += 1) {
      const attempt = index + 1;

      if (isCancelled()) {
        yield { phase: "agent", status: "cancelled", taskId: task.id, attempt };
        yield { phase: "done", status: "cancelled", taskId: task.id };
        return finalizeCancelled(cancelTask, task.id, attempts);
      }

      attempts = attempt;
      yield { phase: "agent", status: "started", taskId: task.id, attempt };

      const agentResult = await spawnAgent({
        ...input,
        workspace,
        signal: task.abortController.signal
      });

      if (isCancelled()) {
        yield { phase: "agent", status: "cancelled", taskId: task.id, attempt };
        yield { phase: "done", status: "cancelled", taskId: task.id };
        return finalizeCancelled(cancelTask, task.id, attempts);
      }

      if (agentResult.success) {
        recoveredOutput = typeof agentResult.output === "string" ? agentResult.output : "";
        yield { phase: "agent", status: "success", taskId: task.id, attempt };
        break;
      }

      const failedOutput = typeof agentResult.output === "string" ? agentResult.output : "";
      lastError = typeof agentResult.error === "string" && agentResult.error
        ? agentResult.error
        : "Agent execution failed";
      yield {
        phase: "agent",
        status: "failed",
        taskId: task.id,
        attempt,
        error: lastError
      };

      if (index >= maxRepairIterations || !failedOutput.trim()) {
        continue;
      }

      yield { phase: "repair", status: "started", taskId: task.id, attempt };

      const repairResult = await repairLoop({
        code: failedOutput,
        cwd: workspace,
        maxIterations: 1,
        signal: task.abortController.signal
      });

      if (isCancelled() || repairResult.reason === "cancelled") {
        yield { phase: "repair", status: "cancelled", taskId: task.id, attempt };
        yield { phase: "done", status: "cancelled", taskId: task.id };
        return finalizeCancelled(cancelTask, task.id, attempts);
      }

      if (repairResult.success) {
        recoveredOutput = repairResult.finalCode;
        yield { phase: "repair", status: "success", taskId: task.id, attempt };
        break;
      }

      lastError = repairResult.reason;
      yield {
        phase: "repair",
        status: "failed",
        taskId: task.id,
        attempt,
        error: repairResult.reason
      };
    }

    if (recoveredOutput === null) {
      updateTaskStatus(task.id, TASK_STATUS.FAILED, lastError);
      yield { phase: "done", status: "failed", taskId: task.id, error: lastError };

      return {
        success: false,
        output: "",
        taskId: task.id,
        error: lastError,
        attempts
      };
    }

    updateTaskStatus(task.id, TASK_STATUS.COMPLETED);
    yield { phase: "done", status: "success", taskId: task.id };

    return {
      success: true,
      output: recoveredOutput,
      taskId: task.id,
      attempts
    };
  } catch (error) {
    const message = normalizeErrorMessage(error);

    if (isCancelled() || message.toLowerCase() === "aborted" || message.toLowerCase() === "cancelled") {
      cancelTask("cancelled");
      yield { phase: "done", status: "cancelled", taskId: task.id };
      return buildCancelledResult(task.id, attempts);
    }

    updateTaskStatus(task.id, TASK_STATUS.FAILED, message);
    yield { phase: "done", status: "failed", taskId: task.id, error: message };

    return {
      success: false,
      output: "",
      taskId: task.id,
      error: message,
      attempts
    };
  } finally {
    detachAbort?.();
  }
}

// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").WorkflowDef} WorkflowDef
 * @typedef {import("../types/core-contracts.d.ts").WorkflowStepDef} WorkflowStepDef
 * @typedef {import("../types/core-contracts.d.ts").WorkflowStepResult} WorkflowStepResult
 * @typedef {import("../types/core-contracts.d.ts").WorkflowResult} WorkflowResult
 * @typedef {import("../types/core-contracts.d.ts").ActionDef} ActionDef
 * @typedef {(params: Record<string, unknown>) => Promise<Record<string, unknown>>} StepExecutor
 */

import { runCli } from "../cli/app.js";
import { evaluateGuard } from "../guard/guard-engine.js";
import { executeAction } from "./action-executor.js";
import { withRetry } from "./retry-policy.js";
import { createTrace } from "../observability/trace.js";

// ── Template Resolution ──────────────────────────────────────────────

/**
 * @param {Record<string, unknown>} params
 * @param {Record<string, unknown>} input
 * @param {Map<string, Record<string, unknown>>} stepOutputs
 * @returns {Record<string, unknown>}
 */
function resolveParams(params, input, stepOutputs) {
  /** @type {Record<string, unknown>} */
  const resolved = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.startsWith("$")) {
      resolved[key] = resolveRef(value, input, stepOutputs);
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

/**
 * @param {string} ref
 * @param {Record<string, unknown>} input
 * @param {Map<string, Record<string, unknown>>} stepOutputs
 * @returns {unknown}
 */
function resolveRef(ref, input, stepOutputs) {
  if (ref.startsWith("$input.")) {
    const field = ref.slice("$input.".length);
    return input[field];
  }

  if (ref.startsWith("$steps.")) {
    const rest = ref.slice("$steps.".length);
    const dotIndex = rest.indexOf(".");
    if (dotIndex < 0) return undefined;

    const stepName = rest.slice(0, dotIndex);
    const field = rest.slice(dotIndex + 1);
    const stepOutput = stepOutputs.get(stepName);
    return stepOutput?.[field];
  }

  return ref;
}

// ── Step Executors ───────────────────────────────────────────────────

/** @type {Record<string, StepExecutor>} */
const stepExecutors = {
  async ingest(params) {
    const source = String(params.source ?? "markdown");
    const path = String(params.path ?? ".");
    const project = String(params.project ?? "");

    const result = await runCli([
      "ingest", "--source", source, "--path", path,
      ...(project ? ["--project", project] : []),
      "--format", "json"
    ]);

    return { exitCode: result.exitCode, stdout: result.stdout };
  },

  async recall(params) {
    const query = String(params.query ?? "");
    const project = String(params.project ?? "");

    const result = await runCli([
      "recall", "--query", query,
      ...(project ? ["--project", project] : []),
      "--format", "json"
    ]);

    return { exitCode: result.exitCode, stdout: result.stdout };
  },

  async guard(params) {
    const query = String(params.query ?? "");
    const project = String(params.project ?? "");

    const evaluation = evaluateGuard(
      { query, project, command: "workflow" },
      {
        enabled: true,
        rules: Array.isArray(params.rules)
          ? /** @type {any[]} */ (params.rules)
          : [{ type: "input-validation", enabled: true, params: { blockInjection: true } }],
        defaultBlockMessage: String(params.blockMessage ?? "Blocked by guard.")
      }
    );

    if (evaluation.blocked) {
      throw new Error(`Guard blocked: ${evaluation.userMessage}`);
    }

    return {
      blocked: evaluation.blocked,
      warned: evaluation.warned,
      durationMs: evaluation.durationMs
    };
  },

  async teach(params) {
    const task = String(params.task ?? "");
    const objective = String(params.objective ?? "");
    const workspace = String(params.workspace ?? ".");

    const result = await runCli([
      "teach", "--task", task, "--objective", objective,
      "--workspace", workspace, "--format", "json", "--no-recall"
    ]);

    return { exitCode: result.exitCode, stdout: result.stdout };
  },

  async remember(params) {
    const title = String(params.title ?? "");
    const content = String(params.content ?? "");
    const project = String(params.project ?? "");

    const result = await runCli([
      "remember", "--title", title, "--content", content,
      ...(project ? ["--project", project] : []),
      "--format", "json"
    ]);

    return { exitCode: result.exitCode, stdout: result.stdout };
  },

  async action(params) {
    const actionType = String(params.actionType ?? "log");
    const actionParams = /** @type {Record<string, unknown>} */ (params.actionParams ?? params);

    /** @type {ActionDef} */
    const actionDef = {
      type: /** @type {ActionDef["type"]} */ (actionType),
      params: actionParams
    };

    const result = await executeAction(actionDef);
    return { ...result };
  },

  async respond(params) {
    return {
      response: params.template
        ? String(params.template)
        : JSON.stringify(params, null, 2)
    };
  }
};

// ── Engine ───────────────────────────────────────────────────────────

/**
 * @param {WorkflowDef} workflow
 * @param {Record<string, unknown>} [input]
 * @returns {Promise<WorkflowResult>}
 */
export async function executeWorkflow(workflow, input = {}) {
  const trace = createTrace(`workflow:${workflow.id}`);
  const startMs = Date.now();
  /** @type {Map<string, Record<string, unknown>>} */
  const stepOutputs = new Map();
  /** @type {WorkflowStepResult[]} */
  const stepResults = [];
  /** @type {WorkflowResult["status"]} */
  let overallStatus = "completed";

  for (const step of workflow.steps) {
    const stepSpan = trace.startLayer(step.name);
    const stepStartMs = Date.now();

    if (step.condition) {
      const condValue = resolveRef(`$${step.condition}`, input, stepOutputs);
      if (!condValue) {
        stepResults.push({
          stepName: step.name,
          type: step.type,
          status: "skipped",
          durationMs: 0,
          output: { reason: `Condition '${step.condition}' was falsy` }
        });
        stepSpan.end({ skipped: true });
        continue;
      }
    }

    const executor = stepExecutors[step.type];
    if (!executor) {
      /** @type {WorkflowStepResult} */
      const result = {
        stepName: step.name,
        type: step.type,
        status: "error",
        durationMs: Date.now() - stepStartMs,
        output: {},
        error: `Unknown step type: ${step.type}`
      };
      stepResults.push(result);
      stepSpan.end({ error: result.error });

      if (!step.optional) {
        overallStatus = "failed";
        break;
      }
      overallStatus = "partial";
      continue;
    }

    try {
      const resolvedParams = resolveParams(step.params, input, stepOutputs);
      const output = await withRetry(() => executor(resolvedParams), { maxRetries: step.optional ? 1 : 2 });

      stepOutputs.set(step.name, output);
      stepResults.push({
        stepName: step.name,
        type: step.type,
        status: "success",
        durationMs: Date.now() - stepStartMs,
        output
      });
      stepSpan.end();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      stepResults.push({
        stepName: step.name,
        type: step.type,
        status: "error",
        durationMs: Date.now() - stepStartMs,
        output: {},
        error: errorMsg
      });
      stepSpan.end({ error: errorMsg });

      if (!step.optional) {
        overallStatus = "failed";
        break;
      }
      overallStatus = "partial";
    }
  }

  trace.finish(overallStatus === "completed" ? "success" : overallStatus === "partial" ? "degraded" : "error");

  const lastSuccess = [...stepOutputs.values()].pop() ?? {};

  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: overallStatus,
    startedAt: new Date(startMs).toISOString(),
    durationMs: Date.now() - startMs,
    steps: stepResults,
    finalOutput: lastSuccess
  };
}

/**
 * @param {string} type
 * @param {StepExecutor} executor
 */
export function registerStepExecutor(type, executor) {
  stepExecutors[type] = executor;
}

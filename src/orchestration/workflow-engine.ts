/**
 * Workflow Engine — declarative multi-step pipeline executor.
 *
 * Workflows are defined as ordered arrays of steps:
 *   ingest → guard → recall → teach → action → respond
 *
 * Each step maps to a CLI command or orchestration primitive.
 * Steps can be conditional, optional, and pass data forward
 * via a shared context object.
 *
 * Example workflow:
 *   {
 *     id: "legal-query",
 *     name: "Legal Document Query",
 *     steps: [
 *       { name: "guard-check", type: "guard", params: { query: "$input.query" } },
 *       { name: "search", type: "recall", params: { query: "$input.query", project: "legal-salta" } },
 *       { name: "save-log", type: "action", params: { actionType: "log", message: "Query processed" }, optional: true }
 *     ]
 *   }
 */

import type {
  WorkflowDef,
  WorkflowStepDef,
  WorkflowStepResult,
  WorkflowResult,
  ActionDef
} from "../types/core-contracts.d.ts";

import { runCli } from "../cli/app.js";
import { evaluateGuard } from "../guard/guard-engine.js";
import { executeAction } from "./action-executor.js";
import { withRetry } from "./retry-policy.js";
import { createTrace } from "../observability/trace.js";

// ── Template Resolution ──────────────────────────────────────────────

/**
 * Resolves $input.x and $steps.stepName.x references in params.
 */
function resolveParams(
  params: Record<string, unknown>,
  input: Record<string, unknown>,
  stepOutputs: Map<string, Record<string, unknown>>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.startsWith("$")) {
      resolved[key] = resolveRef(value, input, stepOutputs);
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

function resolveRef(
  ref: string,
  input: Record<string, unknown>,
  stepOutputs: Map<string, Record<string, unknown>>
): unknown {
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

type StepExecutor = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

const stepExecutors: Record<string, StepExecutor> = {
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
          ? params.rules as { type: string; enabled: boolean; params: Record<string, unknown> }[]
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
    const actionParams = (params.actionParams as Record<string, unknown>) ?? params;

    const actionDef: ActionDef = {
      type: actionType as ActionDef["type"],
      params: actionParams
    };

    const result = await executeAction(actionDef);
    return { ...result };
  },

  async respond(params) {
    // Terminal step — formats the accumulated output
    return {
      response: params.template
        ? String(params.template)
        : JSON.stringify(params, null, 2)
    };
  }
};

// ── Engine ───────────────────────────────────────────────────────────

export async function executeWorkflow(
  workflow: WorkflowDef,
  input: Record<string, unknown> = {}
): Promise<WorkflowResult> {
  const trace = createTrace(`workflow:${workflow.id}`);
  const startMs = Date.now();
  const stepOutputs = new Map<string, Record<string, unknown>>();
  const stepResults: WorkflowStepResult[] = [];
  let overallStatus: WorkflowResult["status"] = "completed";

  for (const step of workflow.steps) {
    const stepSpan = trace.startLayer(step.name);
    const stepStartMs = Date.now();

    // Evaluate condition if present
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
      const result: WorkflowStepResult = {
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

  // Final output = last successful step's output
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

export function registerStepExecutor(type: string, executor: StepExecutor): void {
  stepExecutors[type] = executor;
}

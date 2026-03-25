/**
 * API Route Handlers — maps HTTP endpoints to CLI core logic.
 *
 * Each handler extracts parameters from the JSON request body,
 * delegates to the existing CLI pipeline via `runCli()`, and
 * returns a structured JSON response.
 *
 * This is a thin adapter layer — all business logic lives in
 * the CLI commands. The API just provides HTTP access to them.
 *
 * Endpoint mapping:
 *   POST /api/recall     → lcs recall --query <q> --project <p>
 *   POST /api/teach      → lcs teach --task <t> --objective <o> ...
 *   POST /api/remember   → lcs remember --title <t> --content <c>
 *   POST /api/close      → lcs close --summary <s>
 *   POST /api/ingest     → lcs ingest --source <s> --path <p>
 *   POST /api/guard      → evaluateGuard() directly
 *   GET  /api/health     → lcs doctor
 *   GET  /api/routes     → list registered routes
 */

import type { ApiRequest, ApiResponse, AlertRule, EvalSuite } from "../types/core-contracts.d.ts";
import type { GuardConfig, GuardInput } from "../types/core-contracts.d.ts";

import { runCli } from "../cli/app.js";
import { evaluateGuard, formatGuardResultAsText } from "../guard/guard-engine.js";
import { registerRoute, jsonResponse, errorResponse, getRegisteredRoutes } from "./router.js";
import { getMetricsSnapshot, registerAlertRule, listAlertRules } from "../observability/live-metrics.js";
import { runEvalSuite, loadEvalSuite } from "../eval/eval-runner.js";
import { executeWorkflow } from "../orchestration/workflow-engine.js";
import { savePromptVersion, getCurrentPrompt, getPromptHistory, rollbackPrompt, listPrompts } from "../versioning/prompt-versioning.js";
import { loadSnapshots, getScoreTrend } from "../versioning/context-snapshot.js";
import { getCurrentModelConfig, updateModelConfig, getModelConfigHistory } from "../versioning/model-config.js";
import { checkAndRollback } from "../versioning/rollback-engine.js";
import { createSession, getSession, addTurn, buildConversationContext, listSessions } from "../orchestration/conversation-manager.js";

// ── Helpers ──────────────────────────────────────────────────────────

function requireField(body: Record<string, unknown>, field: string): string {
  const value = body[field];

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required field: "${field}"`);
  }

  return value.trim();
}

function optionalField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Field "${field}" must be a string.`);
  }

  return value.trim() || undefined;
}

function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Field "${field}" must be a number.`);
  }

  return value;
}

/**
 * Builds a CLI argv array from a map of options.
 * Converts { query: "test", project: "foo" } → ["--query", "test", "--project", "foo"]
 */
function buildArgv(command: string, opts: Record<string, string | undefined>): string[] {
  const argv = [command, "--format", "json"];

  for (const [key, value] of Object.entries(opts)) {
    if (value !== undefined) {
      argv.push(`--${key}`, value);
    }
  }

  return argv;
}

/**
 * Runs a CLI command and returns the result as an API response.
 */
async function runCliCommand(argv: string[]): Promise<ApiResponse> {
  const result = await runCli(argv);

  if (result.exitCode !== 0) {
    const errorBody = tryParseJson(result.stderr || result.stdout || "");

    return errorResponse(
      result.exitCode === 1 ? 400 : 500,
      errorBody?.message ?? result.stderr ?? "Command failed",
      errorBody ?? { stdout: result.stdout, stderr: result.stderr }
    );
  }

  const parsed = tryParseJson(result.stdout ?? "");

  return jsonResponse(200, parsed ?? { output: result.stdout });
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

// ── POST /api/recall ─────────────────────────────────────────────────

registerRoute("POST", "/api/recall", async (req: ApiRequest): Promise<ApiResponse> => {
  const query = optionalField(req.body, "query");
  const project = optionalField(req.body, "project");
  const scope = optionalField(req.body, "scope");
  const type = optionalField(req.body, "type");
  const limit = optionalNumber(req.body, "limit");

  const argv = buildArgv("recall", {
    query,
    project,
    scope,
    type,
    limit: limit !== undefined ? String(limit) : undefined
  });

  return runCliCommand(argv);
});

// ── POST /api/teach ──────────────────────────────────────────────────

registerRoute("POST", "/api/teach", async (req: ApiRequest): Promise<ApiResponse> => {
  const task = optionalField(req.body, "task");
  const objective = optionalField(req.body, "objective");
  const focus = optionalField(req.body, "focus");
  const workspace = optionalField(req.body, "workspace");
  const input = optionalField(req.body, "input");
  const project = optionalField(req.body, "project");
  const changedFiles = optionalField(req.body, "changedFiles");
  const tokenBudget = optionalNumber(req.body, "tokenBudget");
  const maxChunks = optionalNumber(req.body, "maxChunks");

  if (!task && !objective) {
    return errorResponse(400, "At least one of 'task' or 'objective' is required.");
  }

  if (!workspace && !input) {
    return errorResponse(400, "Either 'workspace' or 'input' is required.");
  }

  const argv = buildArgv("teach", {
    task,
    objective,
    focus,
    workspace,
    input,
    project,
    "changed-files": changedFiles,
    "token-budget": tokenBudget !== undefined ? String(tokenBudget) : undefined,
    "max-chunks": maxChunks !== undefined ? String(maxChunks) : undefined
  });

  return runCliCommand(argv);
});

// ── POST /api/remember ───────────────────────────────────────────────

registerRoute("POST", "/api/remember", async (req: ApiRequest): Promise<ApiResponse> => {
  const title = requireField(req.body, "title");
  const content = requireField(req.body, "content");
  const project = optionalField(req.body, "project");
  const type = optionalField(req.body, "type");
  const scope = optionalField(req.body, "scope");

  const argv = buildArgv("remember", {
    title,
    content,
    project,
    type,
    scope
  });

  return runCliCommand(argv);
});

// ── POST /api/close ──────────────────────────────────────────────────

registerRoute("POST", "/api/close", async (req: ApiRequest): Promise<ApiResponse> => {
  const summary = requireField(req.body, "summary");
  const learned = optionalField(req.body, "learned");
  const next = optionalField(req.body, "next");
  const title = optionalField(req.body, "title");
  const project = optionalField(req.body, "project");

  const argv = buildArgv("close", {
    summary,
    learned,
    next,
    title,
    project
  });

  return runCliCommand(argv);
});

// ── POST /api/ingest ─────────────────────────────────────────────────

registerRoute("POST", "/api/ingest", async (req: ApiRequest): Promise<ApiResponse> => {
  const source = requireField(req.body, "source");
  const path = requireField(req.body, "path");
  const project = optionalField(req.body, "project");
  const dryRun = req.body.dryRun === true;

  const opts: Record<string, string | undefined> = {
    source,
    path,
    project
  };

  if (dryRun) {
    opts["dry-run"] = "true";
  }

  const argv = buildArgv("ingest", opts);

  return runCliCommand(argv);
});

// ── POST /api/guard ──────────────────────────────────────────────────
// Direct access to the guard engine — useful for frontend pre-validation

registerRoute("POST", "/api/guard", async (req: ApiRequest): Promise<ApiResponse> => {
  const query = requireField(req.body, "query");
  const project = optionalField(req.body, "project") ?? "";
  const command = optionalField(req.body, "command") ?? "recall";

  const guardInput: GuardInput = { query, project, command };

  // If a custom config is provided in the request, use it.
  // Otherwise use a minimal default (enabled with input-validation only).
  const configBody = req.body.config;
  let guardConfig: GuardConfig;

  if (configBody && typeof configBody === "object" && !Array.isArray(configBody)) {
    const cfg = configBody as Record<string, unknown>;
    guardConfig = {
      enabled: cfg.enabled !== false,
      rules: Array.isArray(cfg.rules) ? cfg.rules as GuardConfig["rules"] : [],
      defaultBlockMessage: typeof cfg.defaultBlockMessage === "string"
        ? cfg.defaultBlockMessage
        : "This query is outside the scope of this project."
    };
  } else {
    guardConfig = {
      enabled: true,
      rules: [{ type: "input-validation", enabled: true, params: { blockInjection: true } }],
      defaultBlockMessage: "This query is outside the scope of this project."
    };
  }

  const result = evaluateGuard(guardInput, guardConfig);

  return jsonResponse(result.blocked ? 403 : 200, {
    blocked: result.blocked,
    warned: result.warned,
    blockedBy: result.blockedBy,
    userMessage: result.userMessage,
    results: result.results,
    durationMs: result.durationMs
  });
});

// ── GET /api/health ──────────────────────────────────────────────────

registerRoute("GET", "/api/health", async (_req: ApiRequest): Promise<ApiResponse> => {
  const result = await runCli(["doctor", "--format", "json"]);
  const parsed = tryParseJson(result.stdout ?? "");

  return jsonResponse(result.exitCode === 0 ? 200 : 503, {
    status: result.exitCode === 0 ? "healthy" : "degraded",
    ...(parsed ?? {})
  });
});

// ── GET /api/routes ──────────────────────────────────────────────────

registerRoute("GET", "/api/routes", async (_req: ApiRequest): Promise<ApiResponse> => {
  const routes = getRegisteredRoutes();

  return jsonResponse(200, {
    routes: routes.map((r) => ({
      method: r.method,
      path: r.path
    }))
  });
});

// ── GET /api/metrics (S6) ────────────────────────────────────────────

registerRoute("GET", "/api/metrics", async (_req: ApiRequest): Promise<ApiResponse> => {
  const snapshot = getMetricsSnapshot();
  return jsonResponse(200, snapshot as unknown as Record<string, unknown>);
});

// ── POST /api/alerts (S6) ────────────────────────────────────────────

registerRoute("POST", "/api/alerts", async (req: ApiRequest): Promise<ApiResponse> => {
  const name = requireField(req.body, "name");
  const condition = requireField(req.body, "condition");
  const threshold = req.body.threshold;

  if (typeof threshold !== "number" || Number.isNaN(threshold)) {
    return errorResponse(400, "Field 'threshold' must be a number.");
  }

  const validConditions = ["error_rate_above", "latency_above", "block_rate_above"];
  if (!validConditions.includes(condition)) {
    return errorResponse(400, `Invalid condition. Must be one of: ${validConditions.join(", ")}`);
  }

  const webhookUrl = optionalField(req.body, "webhookUrl");

  registerAlertRule({
    name,
    condition: condition as AlertRule["condition"],
    threshold,
    webhookUrl
  });

  return jsonResponse(201, {
    created: true,
    rule: { name, condition, threshold, webhookUrl },
    totalRules: listAlertRules().length
  });
});

// ── GET /api/alerts (S6) ─────────────────────────────────────────────

registerRoute("GET", "/api/alerts", async (_req: ApiRequest): Promise<ApiResponse> => {
  return jsonResponse(200, { rules: listAlertRules() });
});

// ── POST /api/eval (S5) ──────────────────────────────────────────────

registerRoute("POST", "/api/eval", async (req: ApiRequest): Promise<ApiResponse> => {
  const suitePath = optionalField(req.body, "suitePath");
  const minScore = typeof req.body.minScore === "number" ? req.body.minScore : 0.5;

  let suite: EvalSuite;

  if (suitePath) {
    const { resolve } = await import("node:path");
    suite = await loadEvalSuite(resolve(suitePath));
  } else if (req.body.suite && typeof req.body.suite === "object") {
    suite = req.body.suite as EvalSuite;
  } else {
    return errorResponse(400, "Provide either 'suitePath' (file path) or 'suite' (inline object).");
  }

  const projectOverride = optionalField(req.body, "project");
  if (projectOverride) {
    suite.project = projectOverride;
  }

  const report = await runEvalSuite(suite, { minScore, consistencyRuns: 2 });

  return jsonResponse(
    report.ciGate.passed ? 200 : 422,
    report as unknown as Record<string, unknown>
  );
});

// ── POST /api/workflow (S7) ──────────────────────────────────────────

registerRoute("POST", "/api/workflow", async (req: ApiRequest): Promise<ApiResponse> => {
  const workflow = req.body.workflow as Record<string, unknown> | undefined;

  if (!workflow || !Array.isArray(workflow.steps)) {
    return errorResponse(400, "Field 'workflow' must be an object with id, name, and steps array.");
  }

  const input = typeof req.body.input === "object" && req.body.input !== null
    ? req.body.input as Record<string, unknown>
    : {};

  const result = await executeWorkflow(
    workflow as unknown as import("../types/core-contracts.d.ts").WorkflowDef,
    input
  );

  const status = result.status === "completed" ? 200 : result.status === "partial" ? 207 : 500;
  return jsonResponse(status, result as unknown as Record<string, unknown>);
});

// ── POST /api/conversation (S7) ──────────────────────────────────────

registerRoute("POST", "/api/conversation", async (req: ApiRequest): Promise<ApiResponse> => {
  const project = optionalField(req.body, "project") ?? "";
  const session = createSession(project);

  return jsonResponse(201, {
    sessionId: session.sessionId,
    project: session.project,
    createdAt: session.createdAt
  });
});

// ── POST /api/conversation/turn (S7) ─────────────────────────────────

registerRoute("POST", "/api/conversation/turn", async (req: ApiRequest): Promise<ApiResponse> => {
  const sessionId = requireField(req.body, "sessionId");
  const content = requireField(req.body, "content");
  const project = optionalField(req.body, "project");

  const session = getSession(sessionId);
  if (!session) {
    return errorResponse(404, `Session '${sessionId}' not found.`);
  }

  addTurn(sessionId, "user", content);

  const conversationContext = buildConversationContext(sessionId);

  const recallResult = await runCli([
    "recall",
    "--query", content,
    ...(project || session.project ? ["--project", project || session.project] : []),
    "--format", "json"
  ]);

  const systemContent = recallResult.stdout ?? "";
  addTurn(sessionId, "system", systemContent, {
    exitCode: recallResult.exitCode,
    turnCount: session.turns.length
  });

  return jsonResponse(200, {
    sessionId,
    turnCount: session.turns.length,
    response: systemContent,
    conversationContext: conversationContext.slice(-2000)
  });
});

// ── GET /api/conversation/list (S7) ──────────────────────────────────

registerRoute("GET", "/api/conversation/list", async (_req: ApiRequest): Promise<ApiResponse> => {
  const sessions = listSessions();

  return jsonResponse(200, {
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      project: s.project,
      turnCount: s.turns.length,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    }))
  });
});

// ── POST /api/prompts (S8) ───────────────────────────────────────────

registerRoute("POST", "/api/prompts", async (req: ApiRequest): Promise<ApiResponse> => {
  const name = requireField(req.body, "name");
  const content = requireField(req.body, "content");
  const metadata = typeof req.body.metadata === "object" ? req.body.metadata as Record<string, unknown> : undefined;

  const version = await savePromptVersion(name, content, metadata);
  return jsonResponse(201, version as unknown as Record<string, unknown>);
});

// ── GET /api/prompts (S8) ────────────────────────────────────────────

registerRoute("GET", "/api/prompts", async (_req: ApiRequest): Promise<ApiResponse> => {
  const names = await listPrompts();
  return jsonResponse(200, { prompts: names });
});

// ── POST /api/prompts/rollback (S8) ──────────────────────────────────

registerRoute("POST", "/api/prompts/rollback", async (req: ApiRequest): Promise<ApiResponse> => {
  const name = requireField(req.body, "name");
  const toVersion = req.body.toVersion;

  if (typeof toVersion !== "number") {
    return errorResponse(400, "Field 'toVersion' must be a number.");
  }

  const result = await rollbackPrompt(name, toVersion);
  if (!result) {
    return errorResponse(404, `Version ${toVersion} not found for prompt '${name}'.`);
  }

  return jsonResponse(200, result as unknown as Record<string, unknown>);
});

// ── GET /api/snapshots (S8) ──────────────────────────────────────────

registerRoute("GET", "/api/snapshots", async (req: ApiRequest): Promise<ApiResponse> => {
  const project = typeof req.headers["x-project"] === "string" ? req.headers["x-project"] : "default";
  const snapshots = await loadSnapshots(project, { limit: 20 });
  return jsonResponse(200, { project, snapshots });
});

// ── GET /api/model-config (S8) ───────────────────────────────────────

registerRoute("GET", "/api/model-config", async (_req: ApiRequest): Promise<ApiResponse> => {
  const current = await getCurrentModelConfig();
  const history = await getModelConfigHistory();
  return jsonResponse(200, { current, history: history.slice(0, 10) } as unknown as Record<string, unknown>);
});

// ── POST /api/model-config (S8) ─────────────────────────────────────

registerRoute("POST", "/api/model-config", async (req: ApiRequest): Promise<ApiResponse> => {
  const modelId = optionalField(req.body, "modelId");
  const temperature = typeof req.body.temperature === "number" ? req.body.temperature : undefined;
  const maxTokens = typeof req.body.maxTokens === "number" ? req.body.maxTokens : undefined;

  const updated = await updateModelConfig({ modelId, temperature, maxTokens });
  return jsonResponse(200, updated as unknown as Record<string, unknown>);
});

// ── POST /api/rollback-check (S8) ────────────────────────────────────

registerRoute("POST", "/api/rollback-check", async (req: ApiRequest): Promise<ApiResponse> => {
  const project = requireField(req.body, "project");
  const promptName = requireField(req.body, "promptName");
  const dropThreshold = typeof req.body.dropThreshold === "number" ? req.body.dropThreshold : 0.10;

  const suitePath = optionalField(req.body, "suitePath");
  let evalSuite: import("../types/core-contracts.d.ts").EvalSuite;

  if (suitePath) {
    const { resolve } = await import("node:path");
    evalSuite = await loadEvalSuite(resolve(suitePath));
  } else if (req.body.suite && typeof req.body.suite === "object") {
    evalSuite = req.body.suite as import("../types/core-contracts.d.ts").EvalSuite;
  } else {
    return errorResponse(400, "Provide either 'suitePath' or 'suite' for the eval suite.");
  }

  const result = await checkAndRollback({ evalSuite, project, promptName, dropThreshold });
  return jsonResponse(200, result as unknown as Record<string, unknown>);
});

// ── GET /api/score-trend (S8) ────────────────────────────────────────

registerRoute("GET", "/api/score-trend", async (req: ApiRequest): Promise<ApiResponse> => {
  const project = typeof req.headers["x-project"] === "string" ? req.headers["x-project"] : "default";
  const trend = await getScoreTrend(project);
  return jsonResponse(200, { project, trend });
});

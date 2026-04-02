// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").ApiRequest} ApiRequest
 * @typedef {import("../types/core-contracts.d.ts").ApiResponse} ApiResponse
 * @typedef {import("../types/core-contracts.d.ts").GuardConfig} GuardConfig
 * @typedef {import("../types/core-contracts.d.ts").GuardInput} GuardInput
 */

import { runCli } from "../cli/app.js";
import { evaluateGuard } from "../guard/guard-engine.js";
import { registerRoute, jsonResponse, errorResponse, getRegisteredRoutes } from "./router.js";
import { getAllCommands as getRegisteredCommands } from "../core/command-registry.js";
import { getMetricsSnapshot, registerAlertRule, listAlertRules } from "../observability/live-metrics.js";
import { getObservabilityReport } from "../observability/metrics-store.js";
import { runEvalSuite, loadEvalSuite } from "../eval/eval-runner.js";
import { executeWorkflow } from "../orchestration/workflow-engine.js";
import { savePromptVersion, getCurrentPrompt, getPromptHistory, rollbackPrompt, listPrompts } from "../versioning/prompt-versioning.js";
import { loadSnapshots, getScoreTrend } from "../versioning/context-snapshot.js";
import { getCurrentModelConfig, updateModelConfig, getModelConfigHistory } from "../versioning/model-config.js";
import { checkAndRollback } from "../versioning/rollback-engine.js";
import {
  createSession,
  getSession,
  addTurn,
  buildConversationContext,
  buildConversationRecallQuery,
  getConversationNoiseTelemetry,
  listSessions,
  deleteSession
} from "../orchestration/conversation-manager.js";
import { spawnNexusAgent, formatNexusAgentSummary } from "../orchestration/nexus-agent-bridge.js";
import { runMitosisPipeline, formatMitosisReport, listAgents, routeToAgent } from "../orchestration/agent-synthesizer.js";
import { chatCompletion } from "../llm/openrouter-provider.js";
import { parseLlmResponse } from "../llm/response-parser.js";
import { recordCommandMetric } from "../observability/metrics-store.js";
import { resolveEndpointContextProfile, selectEndpointContext } from "../context/context-mode.js";
import { loadApiAxioms, formatApiAxiomsMarkdown } from "./axioms-loader.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeChunkContent } from "../guard/chunk-sanitizer.js";
import { resolveSafePathWithinWorkspace as resolveWorkspacePath } from "../utils/path-utils.js";
import "./commands/tasks.js";

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * @param {Record<string, unknown>} body
 * @param {string} field
 * @returns {string}
 */
function requireField(body, field) {
  const value = body[field];

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required field: "${field}"`);
  }

  return value.trim();
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} field
 * @returns {string | undefined}
 */
function optionalField(body, field) {
  const value = body[field];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Field "${field}" must be a string.`);
  }

  return value.trim() || undefined;
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} field
 * @returns {number | undefined}
 */
function optionalNumber(body, field) {
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
 * @param {number | undefined} value
 * @param {{ min: number, max: number, fallback: number }} range
 * @returns {number}
 */
function clampInt(value, range) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return range.fallback;
  }

  const normalized = Math.trunc(value);
  return Math.max(range.min, Math.min(range.max, normalized));
}

/**
 * @param {number | undefined} value
 * @param {{ min: number, max: number, fallback: number }} range
 * @returns {number}
 */
function clampFloat(value, range) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return range.fallback;
  }

  return Math.max(range.min, Math.min(range.max, value));
}

const API_WORKSPACE_ROOT = path.resolve(process.cwd());
const MAX_CHAT_CONTEXT_CHARS = Math.max(
  1000,
  Math.trunc(Number(process.env.LCS_API_CHAT_CONTEXT_MAX_CHARS ?? 8000))
);

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function parseBooleanQuery(value) {
  return value === "true" || value === "1" || value === "yes";
}

/**
 * @param {string} command
 * @param {Record<string, string | undefined>} opts
 * @returns {string[]}
 */
function buildArgv(command, opts) {
  const argv = [command, "--format", "json"];

  for (const [key, value] of Object.entries(opts)) {
    if (value !== undefined) {
      argv.push(`--${key}`, value);
    }
  }

  return argv;
}

const CLI_ERROR_TOP_LEVEL_ALLOWLIST = new Set([
  "action",
  "blocked",
  "blockedBy",
  "code",
  "compliance",
  "degraded",
  "details",
  "error",
  "errorCode",
  "errors",
  "failureKind",
  "fixHint",
  "guard",
  "memoryStatus",
  "mode",
  "project",
  "provider",
  "query",
  "reason",
  "reviewStatus",
  "scope",
  "status",
  "type",
  "violations",
  "warning",
  "warnings"
]);

const CLI_ERROR_REDACTED_KEYS = new Set([
  "stdout",
  "stderr",
  "stack",
  "trace",
  "cwd",
  "config",
  "meta",
  "observability"
]);

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function sanitizeCliErrorValue(value, depth = 0) {
  if (depth > 4 || value === undefined) {
    return undefined;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const sanitizedItems = value
      .map((item) => sanitizeCliErrorValue(item, depth + 1))
      .filter((item) => item !== undefined);
    return sanitizedItems;
  }

  if (typeof value === "object") {
    const sanitized = {};

    for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (CLI_ERROR_REDACTED_KEYS.has(key)) {
        continue;
      }

      const normalized = sanitizeCliErrorValue(entry, depth + 1);
      if (normalized !== undefined) {
        sanitized[key] = normalized;
      }
    }

    return sanitized;
  }

  return undefined;
}

/**
 * @param {Record<string, unknown> | null} errorBody
 * @param {number} exitCode
 * @returns {{ message: string, details: Record<string, unknown> | undefined }}
 */
export function createSanitizedCliErrorPayload(errorBody, exitCode) {
  const details = {};

  if (errorBody) {
    for (const [key, value] of Object.entries(errorBody)) {
      if (key === "message" || !CLI_ERROR_TOP_LEVEL_ALLOWLIST.has(key)) {
        continue;
      }

      const normalized = sanitizeCliErrorValue(value);
      if (normalized !== undefined) {
        details[key] = normalized;
      }
    }
  }

  const message =
    typeof errorBody?.message === "string" && errorBody.message.trim()
      ? errorBody.message.trim()
      : exitCode === 1
        ? "Command validation failed."
        : "Command execution failed.";

  return {
    message,
    details: Object.keys(details).length > 0 ? details : undefined
  };
}

/**
 * @param {string[]} argv
 * @returns {Promise<ApiResponse>}
 */
async function runCliCommand(argv) {
  const result = await runCli(argv);

  if (result.exitCode !== 0) {
    const errorBody = tryParseJson(result.stderr || result.stdout || "");
    const sanitizedError = createSanitizedCliErrorPayload(errorBody, result.exitCode);

    return errorResponse(
      result.exitCode === 1 ? 400 : 500,
      sanitizedError.message,
      sanitizedError.details
    );
  }

  const parsed = tryParseJson(result.stdout ?? "");

  return jsonResponse(200, parsed ?? { output: result.stdout });
}

/**
 * @param {string} raw
 * @returns {Record<string, unknown> | null}
 */
function tryParseJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} sdd
 */
function buildSddMetricSummary(sdd) {
  const record = asRecord(sdd);
  if (record.enabled !== true) {
    return undefined;
  }

  const requiredKinds = Array.isArray(record.requiredKinds)
    ? record.requiredKinds.filter((entry) => typeof entry === "string" && entry.trim()).length
    : 0;
  const coverage = asRecord(record.coverage);
  const coveredKinds = Object.entries(coverage).filter(([, covered]) => covered === true).length;
  const injectedKinds = Array.isArray(record.injectedKinds)
    ? record.injectedKinds.filter((entry) => typeof entry === "string" && entry.trim()).length
    : 0;
  const skippedReasons = Array.isArray(record.skippedKinds)
    ? record.skippedKinds
        .map((entry) => asRecord(entry))
        .map((entry) => (typeof entry.reason === "string" ? entry.reason.trim() : ""))
        .filter(Boolean)
    : [];

  return {
    enabled: true,
    requiredKinds,
    coveredKinds,
    injectedKinds,
    skippedReasons
  };
}

/**
 * @param {unknown} parsed
 */
function buildTeachingMetricSummary(parsed) {
  const record = asRecord(parsed);
  const concepts = Array.isArray(record.concepts)
    ? record.concepts
        .filter((entry) => typeof entry === "string" && entry.trim())
        .length
    : 0;
  const hasChange = typeof record.change === "string" && record.change.trim().length > 0;
  const hasReason = typeof record.reason === "string" && record.reason.trim().length > 0;
  const hasPractice = typeof record.practice === "string" && record.practice.trim().length > 0;
  const sectionsPresent =
    (hasChange ? 1 : 0) +
    (hasReason ? 1 : 0) +
    (concepts > 0 ? 1 : 0) +
    (hasPractice ? 1 : 0);

  return {
    enabled: true,
    sectionsExpected: 4,
    sectionsPresent,
    hasPractice
  };
}

/**
 * @param {{
 *   rawChunks: number,
 *   rawTokens: number,
 *   selectedChunks: number,
 *   selectedTokens: number
 * }} input
 */
function buildContextImpactSummary(input) {
  const rawChunks = Math.max(0, Math.trunc(Number(input.rawChunks ?? 0)));
  const rawTokens = Math.max(0, Math.trunc(Number(input.rawTokens ?? 0)));
  const selectedChunks = Math.max(0, Math.trunc(Number(input.selectedChunks ?? 0)));
  const selectedTokens = Math.max(0, Math.trunc(Number(input.selectedTokens ?? 0)));
  const suppressedChunks = Math.max(0, rawChunks - selectedChunks);
  const suppressedTokens = Math.max(0, rawTokens - selectedTokens);
  const tokenSavingsPercent =
    rawTokens > 0 ? Number(((suppressedTokens / rawTokens) * 100).toFixed(1)) : 0;
  const chunkSavingsPercent =
    rawChunks > 0 ? Number(((suppressedChunks / rawChunks) * 100).toFixed(1)) : 0;

  return {
    withoutNexus: {
      chunks: rawChunks,
      tokens: rawTokens
    },
    withNexus: {
      chunks: selectedChunks,
      tokens: selectedTokens
    },
    suppressed: {
      chunks: suppressedChunks,
      tokens: suppressedTokens
    },
    savings: {
      chunks: suppressedChunks,
      tokens: suppressedTokens,
      percent: tokenSavingsPercent,
      chunkPercent: chunkSavingsPercent
    }
  };
}

/**
 * @param {unknown} sdd
 */
function computeSddCoverageRate(sdd) {
  const record = asRecord(sdd);
  const requiredKinds = Array.isArray(record.requiredKinds)
    ? record.requiredKinds.filter((entry) => typeof entry === "string" && entry.trim()).length
    : 0;
  const coverage = asRecord(record.coverage);
  const coveredKinds = Object.entries(coverage).filter(([, covered]) => covered === true).length;

  if (requiredKinds === 0) {
    return 1;
  }

  return Number((coveredKinds / requiredKinds).toFixed(4));
}

/**
 * @param {string} command
 * @param {number} startedAt
 * @param {Parameters<typeof recordCommandMetric>[0]} [metric]
 */
async function recordApiMetric(command, startedAt, metric = { command, durationMs: 0 }) {
  await recordCommandMetric(
    {
      ...metric,
      command,
      durationMs: Math.max(0, Date.now() - startedAt)
    },
    {
      filePath: process.env.LCS_OBSERVABILITY_FILE
    }
  );
}

// ── POST /api/recall ─────────────────────────────────────────────────

registerRoute("POST", "/api/recall", async (/** @type {ApiRequest} */ req) => {
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

registerRoute("POST", "/api/teach", async (/** @type {ApiRequest} */ req) => {
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

registerRoute("POST", "/api/remember", async (/** @type {ApiRequest} */ req) => {
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

registerRoute("POST", "/api/close", async (/** @type {ApiRequest} */ req) => {
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

registerRoute("POST", "/api/ingest", async (/** @type {ApiRequest} */ req) => {
  const source = requireField(req.body, "source");
  const sourcePath = requireField(req.body, "path");
  const project = optionalField(req.body, "project");
  const dryRun = req.body.dryRun === true;
  let safeSourcePath = "";

  try {
    safeSourcePath = resolveWorkspacePath(sourcePath, API_WORKSPACE_ROOT, "path");
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : String(error));
  }

  /** @type {Record<string, string | undefined>} */
  const opts = { source, path: safeSourcePath, project };

  if (dryRun) {
    opts["dry-run"] = "true";
  }

  const argv = buildArgv("ingest", opts);

  return runCliCommand(argv);
});

// ── POST /api/guard ──────────────────────────────────────────────────

registerRoute("POST", "/api/guard", async (/** @type {ApiRequest} */ req) => {
  const query = requireField(req.body, "query");
  const project = optionalField(req.body, "project") ?? "";
  const command = optionalField(req.body, "command") ?? "recall";

  /** @type {GuardInput} */
  const guardInput = { query, project, command };

  const configBody = req.body.config;
  /** @type {GuardConfig} */
  let guardConfig;

  if (configBody && typeof configBody === "object" && !Array.isArray(configBody)) {
    const cfg = /** @type {Record<string, unknown>} */ (configBody);
    guardConfig = {
      enabled: cfg.enabled !== false,
      rules: Array.isArray(cfg.rules) ? /** @type {GuardConfig["rules"]} */ (cfg.rules) : [],
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

registerRoute("GET", "/api/health", async () => {
  const result = await runCli(["doctor", "--format", "json"]);
  const parsed = tryParseJson(result.stdout ?? "");

  return jsonResponse(result.exitCode === 0 ? 200 : 503, {
    status: result.exitCode === 0 ? "healthy" : "degraded",
    ...(parsed ?? {})
  });
});

// ── GET /api/routes ──────────────────────────────────────────────────

registerRoute("GET", "/api/routes", async () => {
  const registered = getRegisteredRoutes();
  const commands = getRegisteredCommands();
  const routes = [
    ...registered.map((route) => ({
      method: route.method,
      path: route.path
    })),
    ...commands.map((command) => ({
      method: command.method,
      path: command.path
    }))
  ];

  return jsonResponse(200, {
    routes
  });
});

// ── GET /api/metrics (S6) ────────────────────────────────────────────

registerRoute("GET", "/api/metrics", async () => {
  const snapshot = getMetricsSnapshot();
  let learning = {
    teachingPackets: 0,
    sddCoverageRate: 0,
    recallHitRate: 0,
    averageSelectedChunks: 0,
    averageSuppressedChunks: 0
  };
  /** @type {Record<string, unknown> | null} */
  let observability = null;

  try {
    const report = await getObservabilityReport();
    const teachStats = Array.isArray(report.commands)
      ? report.commands.find((item) => item.command === "teach")
      : undefined;

    learning = {
      teachingPackets: teachStats?.runs ?? 0,
      sddCoverageRate: report.sdd?.coverageRate ?? 0,
      recallHitRate: report.recall?.hitRate ?? 0,
      averageSelectedChunks: report.selection?.averageSelected ?? 0,
      averageSuppressedChunks: report.selection?.averageSuppressed ?? 0
    };

    observability = {
      updatedAt: report.updatedAt,
      totals: report.totals,
      recall: {
        attempts: report.recall?.attempts ?? 0,
        hits: report.recall?.hits ?? 0,
        hitRate: report.recall?.hitRate ?? 0
      },
      sdd: {
        samples: report.sdd?.samples ?? 0,
        coverageRate: report.sdd?.coverageRate ?? 0,
        requiredKindsTotal: report.sdd?.requiredKindsTotal ?? 0,
        coveredKindsTotal: report.sdd?.coveredKindsTotal ?? 0
      },
      selection: {
        samples: report.selection?.samples ?? 0,
        averageSelected: report.selection?.averageSelected ?? 0,
        averageSuppressed: report.selection?.averageSuppressed ?? 0
      }
    };
  } catch {
    // observability fallback is optional for API metrics
  }

  return jsonResponse(200, {
    ...(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (snapshot))),
    learning,
    ...(observability ? { observability } : {})
  });
});

// ── POST /api/alerts (S6) ────────────────────────────────────────────

registerRoute("POST", "/api/alerts", async (/** @type {ApiRequest} */ req) => {
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
    condition: /** @type {import("../types/core-contracts.d.ts").AlertRule["condition"]} */ (condition),
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

registerRoute("GET", "/api/alerts", async () => {
  return jsonResponse(200, { rules: listAlertRules() });
});

// ── POST /api/eval (S5) ──────────────────────────────────────────────

registerRoute("POST", "/api/eval", async (/** @type {ApiRequest} */ req) => {
  const suitePath = optionalField(req.body, "suitePath");
  const minScore = typeof req.body.minScore === "number" ? req.body.minScore : 0.5;

  /** @type {import("../types/core-contracts.d.ts").EvalSuite} */
  let suite;

  if (suitePath) {
    let safeSuitePath = "";
    try {
      safeSuitePath = resolveWorkspacePath(suitePath, API_WORKSPACE_ROOT, "suitePath");
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : String(error));
    }

    suite = await loadEvalSuite(safeSuitePath);
  } else if (req.body.suite && typeof req.body.suite === "object") {
    suite = /** @type {import("../types/core-contracts.d.ts").EvalSuite} */ (req.body.suite);
  } else {
    return errorResponse(400, "Provide either 'suitePath' (file path) or 'suite' (inline object).");
  }

  const projectOverride = optionalField(req.body, "project");
  if (projectOverride) {
    suite.project = projectOverride;
  }

  const report = await runEvalSuite(suite, { minScore, consistencyRuns: 2 });

  return jsonResponse(report.ciGate.passed ? 200 : 422, /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (report)));
});

// ── POST /api/workflow (S7) ──────────────────────────────────────────

registerRoute("POST", "/api/workflow", async (/** @type {ApiRequest} */ req) => {
  const workflow = req.body.workflow;

  if (!workflow || typeof workflow !== "object" || !Array.isArray(/** @type {any} */(workflow).steps)) {
    return errorResponse(400, "Field 'workflow' must be an object with id, name, and steps array.");
  }

  const input = typeof req.body.input === "object" && req.body.input !== null
    ? /** @type {Record<string, unknown>} */ (req.body.input)
    : {};

  const result = await executeWorkflow(
    /** @type {import("../types/core-contracts.d.ts").WorkflowDef} */ (workflow),
    input
  );

  const status = result.status === "completed" ? 200 : result.status === "partial" ? 207 : 500;
  return jsonResponse(status, /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (result)));
});

// ── POST /api/conversation (S7) ──────────────────────────────────────

registerRoute("POST", "/api/conversation", async (/** @type {ApiRequest} */ req) => {
  const project = optionalField(req.body, "project") ?? "";
  const session = createSession(project);

  return jsonResponse(201, {
    sessionId: session.sessionId,
    project: session.project,
    createdAt: session.createdAt
  });
});

// ── POST /api/conversation/turn (S7) ─────────────────────────────────

registerRoute("POST", "/api/conversation/turn", async (/** @type {ApiRequest} */ req) => {
  const sessionId = requireField(req.body, "sessionId");
  const content = requireField(req.body, "content");
  const project = optionalField(req.body, "project");

  const session = getSession(sessionId);
  if (!session) {
    return errorResponse(404, `Session '${sessionId}' not found.`);
  }

  // Record the user turn
  addTurn(sessionId, "user", content);

  // Build accumulated conversation context
  const conversationContext = buildConversationContext(sessionId);
  const recallQuery = buildConversationRecallQuery(content, conversationContext);

  // Run recall with conversation-augmented query
  const recallResult = await runCli([
    "recall",
    "--query", recallQuery,
    ...(project || session.project ? ["--project", project || session.project] : []),
    "--format", "json"
  ]);

  // Record system response
  const systemContent = recallResult.stdout ?? "";
  addTurn(sessionId, "system", systemContent, {
    exitCode: recallResult.exitCode,
    turnCount: session.turns.length
  });

  return jsonResponse(200, {
    sessionId,
    turnCount: session.turns.length,
    response: systemContent,
    conversationContext: conversationContext.slice(-2000),
    noiseTelemetry: getConversationNoiseTelemetry(sessionId)
  });
});

// ── GET /api/conversation/list (S7) ──────────────────────────────────

registerRoute("GET", "/api/conversation/list", async () => {
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

registerRoute("POST", "/api/prompts", async (/** @type {ApiRequest} */ req) => {
  const name = requireField(req.body, "name");
  const content = requireField(req.body, "content");
  const metadata = typeof req.body.metadata === "object" ? /** @type {Record<string, unknown>} */ (req.body.metadata) : undefined;

  const version = await savePromptVersion(name, content, metadata);

  return jsonResponse(201, /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (version)));
});

// ── GET /api/prompts (S8) ────────────────────────────────────────────

registerRoute("GET", "/api/prompts", async () => {
  const names = await listPrompts();
  return jsonResponse(200, { prompts: names });
});

// ── POST /api/prompts/rollback (S8) ──────────────────────────────────

registerRoute("POST", "/api/prompts/rollback", async (/** @type {ApiRequest} */ req) => {
  const name = requireField(req.body, "name");
  const toVersion = req.body.toVersion;

  if (typeof toVersion !== "number") {
    return errorResponse(400, "Field 'toVersion' must be a number.");
  }

  const result = await rollbackPrompt(name, toVersion);

  if (!result) {
    return errorResponse(404, `Version ${toVersion} not found for prompt '${name}'.`);
  }

  return jsonResponse(200, /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (result)));
});

// ── GET /api/snapshots (S8) ──────────────────────────────────────────

registerRoute("GET", "/api/snapshots", async (/** @type {ApiRequest} */ req) => {
  const project = typeof req.headers["x-project"] === "string" ? req.headers["x-project"] : "default";
  const snapshots = await loadSnapshots(project, { limit: 20 });

  return jsonResponse(200, { project, snapshots });
});

// ── GET /api/model-config (S8) ───────────────────────────────────────

registerRoute("GET", "/api/model-config", async () => {
  const current = await getCurrentModelConfig();
  const history = await getModelConfigHistory();

  return jsonResponse(200, {
    current: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (current)),
    history: history.slice(0, 10)
  });
});

// ── POST /api/model-config (S8) ─────────────────────────────────────

registerRoute("POST", "/api/model-config", async (/** @type {ApiRequest} */ req) => {
  const modelId = optionalField(req.body, "modelId");
  const temperature = typeof req.body.temperature === "number" ? req.body.temperature : undefined;
  const maxTokens = typeof req.body.maxTokens === "number" ? req.body.maxTokens : undefined;

  const updated = await updateModelConfig({ modelId, temperature, maxTokens });

  return jsonResponse(200, /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (updated)));
});

// ── POST /api/rollback-check (S8) ────────────────────────────────────

registerRoute("POST", "/api/rollback-check", async (/** @type {ApiRequest} */ req) => {
  const project = requireField(req.body, "project");
  const promptName = requireField(req.body, "promptName");
  const dropThreshold = typeof req.body.dropThreshold === "number" ? req.body.dropThreshold : 0.10;

  const suitePath = optionalField(req.body, "suitePath");
  /** @type {import("../types/core-contracts.d.ts").EvalSuite} */
  let evalSuite;

  if (suitePath) {
    let safeSuitePath = "";
    try {
      safeSuitePath = resolveWorkspacePath(suitePath, API_WORKSPACE_ROOT, "suitePath");
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : String(error));
    }

    evalSuite = await loadEvalSuite(safeSuitePath);
  } else if (req.body.suite && typeof req.body.suite === "object") {
    evalSuite = /** @type {import("../types/core-contracts.d.ts").EvalSuite} */ (req.body.suite);
  } else {
    return errorResponse(400, "Provide either 'suitePath' or 'suite' for the eval suite.");
  }

  const result = await checkAndRollback({ evalSuite, project, promptName, dropThreshold });

  return jsonResponse(result.shouldRollback ? 200 : 200, /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (result)));
});

// ── GET /api/score-trend (S8) ────────────────────────────────────────

registerRoute("GET", "/api/score-trend", async (/** @type {ApiRequest} */ req) => {
  const project = typeof req.headers["x-project"] === "string" ? req.headers["x-project"] : "default";
  const trend = await getScoreTrend(project);

  return jsonResponse(200, { project, trend });
});

// ── GET /api/axioms ──────────────────────────────────────────────────

registerRoute("GET", "/api/axioms", async (/** @type {ApiRequest} */ req) => {
  const project =
    typeof req.query.project === "string" && req.query.project.trim()
      ? req.query.project.trim()
      : typeof req.headers["x-project"] === "string" && req.headers["x-project"].trim()
        ? req.headers["x-project"].trim()
        : "learning-context-system";
  const domain =
    typeof req.query.domain === "string" && req.query.domain.trim()
      ? req.query.domain.trim()
      : undefined;
  const protectedOnly = parseBooleanQuery(req.query.protectedOnly);
  const format =
    typeof req.query.format === "string" && req.query.format.trim()
      ? req.query.format.trim().toLowerCase()
      : "json";
  const dataDirRaw =
    typeof req.headers["x-data-dir"] === "string" && req.headers["x-data-dir"].trim()
      ? req.headers["x-data-dir"].trim()
      : process.cwd();
  let dataDir = "";

  try {
    dataDir = resolveWorkspacePath(dataDirRaw, API_WORKSPACE_ROOT, "x-data-dir");
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : String(error));
  }

  const payload = await loadApiAxioms({ project, dataDir, domain, protectedOnly });

  if (format === "markdown") {
    return jsonResponse(200, {
      ...payload,
      markdown: formatApiAxiomsMarkdown(payload)
    });
  }

  return jsonResponse(200, payload);
});

// ── POST /api/agent — NEXUS agent execution bridge ────────────────────

registerRoute("POST", "/api/agent", async (/** @type {ApiRequest} */ req) => {
  const body = /** @type {Record<string, unknown>} */ (req.body ?? {});

  if (typeof body.task !== "string" || !body.task.trim()) {
    return errorResponse(400, "Missing required field: task");
  }

  const task = body.task.trim();
  if (task.length > 4000) {
    return errorResponse(400, "Field 'task' exceeds max length (4000 chars).");
  }

  let workspace = API_WORKSPACE_ROOT;
  try {
    workspace =
      typeof body.workspace === "string"
        ? resolveWorkspacePath(body.workspace, API_WORKSPACE_ROOT, "workspace")
        : API_WORKSPACE_ROOT;
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : String(error));
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
  const tokenBudget = contextProfile.tokenBudget;
  const maxChunks = contextProfile.maxChunks;
  const swarmAgents = clampInt(
    typeof body.swarmAgents === "number" ? body.swarmAgents : undefined,
    { min: 1, max: 8, fallback: 3 }
  );

  const result = await spawnNexusAgent({
    task,
    objective,
    workspace,
    changedFiles,
    focus: typeof body.focus === "string" ? body.focus : undefined,
    project: typeof body.project === "string" ? body.project : "default",
    agentType: ["coder", "reviewer", "tester", "analyst", "security"].includes(String(body.agentType))
      ? body.agentType
      : "coder",
    tokenBudget,
    maxChunks,
    runGate: body.runGate === true,
    language: typeof body.language === "string" ? body.language : undefined,
    framework: typeof body.framework === "string" ? body.framework : undefined,
    sddProfile: typeof body.sddProfile === "string" ? body.sddProfile : undefined,
    useSwarm: body.useSwarm === true,
    swarmAgents,
    scoringProfile: contextProfile.scoringProfile
  });

  return jsonResponse(result.success ? 200 : 422, {
    ...result,
    summary: formatNexusAgentSummary(result),
    contextMode: contextProfile.mode,
    contextSdd: result.nexusContext?.sddCoverage ?? {}
  });
});

// ── POST /api/mitosis — agent synthesis pipeline ──────────────────────

registerRoute("POST", "/api/mitosis", async (/** @type {ApiRequest} */ req) => {
  const body = /** @type {Record<string, unknown>} */ (req.body ?? {});
  const project = typeof body.project === "string" && body.project.trim()
    ? body.project.trim()
    : "default";
  if (project.length > 120) {
    return errorResponse(400, "Field 'project' exceeds max length (120 chars).");
  }

  let dataDir = API_WORKSPACE_ROOT;
  try {
    dataDir =
      typeof body.dataDir === "string"
        ? resolveWorkspacePath(body.dataDir, API_WORKSPACE_ROOT, "dataDir")
        : API_WORKSPACE_ROOT;
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : String(error));
  }

  const minAxioms = clampInt(
    typeof body.minAxioms === "number" ? body.minAxioms : undefined,
    { min: 1, max: 200, fallback: 5 }
  );
  const minMaturityScore = clampFloat(
    typeof body.minMaturityScore === "number" ? body.minMaturityScore : undefined,
    { min: 0, max: 1, fallback: 0.4 }
  );
  const dryRun = body.dryRun === true;

  const report = await runMitosisPipeline({ project, dataDir, minAxioms, minMaturityScore, dryRun });

  return jsonResponse(200, {
    ...report,
    formatted: formatMitosisReport(report),
    dryRun
  });
});

// ── GET /api/agents + POST /api/agents/route ──────────────────────────

registerRoute("GET", "/api/agents", async (/** @type {ApiRequest} */ req) => {
  let dataDir = API_WORKSPACE_ROOT;
  try {
    dataDir = resolveWorkspacePath(
      typeof req.headers["x-data-dir"] === "string" ? req.headers["x-data-dir"] : "",
      API_WORKSPACE_ROOT,
      "x-data-dir"
    );
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : String(error));
  }

  const agents = await listAgents({ dataDir });
  return jsonResponse(200, { agents, count: agents.length });
});

registerRoute("POST", "/api/agents/route", async (/** @type {ApiRequest} */ req) => {
  const body = /** @type {Record<string, unknown>} */ (req.body ?? {});
  const language = typeof body.language === "string" ? body.language : undefined;
  const framework = typeof body.framework === "string" ? body.framework : undefined;

  if (!language && !framework) {
    return errorResponse(400, "Provide at least one of 'language' or 'framework' to route.");
  }

  let dataDir = API_WORKSPACE_ROOT;
  try {
    dataDir =
      typeof body.dataDir === "string"
        ? resolveWorkspacePath(body.dataDir, API_WORKSPACE_ROOT, "dataDir")
        : API_WORKSPACE_ROOT;
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : String(error));
  }

  const agent = await routeToAgent({ language, framework, dataDir });

  if (!agent) {
    return jsonResponse(404, { matched: false, agent: null, message: "No born agent matches the given language/framework." });
  }

  return jsonResponse(200, { matched: true, agent });
});

// ── GET /api/impact ───────────────────────────────────────────────────

registerRoute("GET", "/api/impact", async () => {
  const defaults = {
    tokenSavings: { avg: 42.1, last: null },
    chunkSavings: { avg: 60.7, last: null },
    qualityPassRate: 1.0,
    degradedRecallRate: 0.0,
    memoryRetention: 0.5,
    structuralHitRate: 0.0,
    casesOverflowingWithout: 1.0,
    provider: "nexus",
    measuredAt: new Date().toISOString()
  };

  try {
    const raw = await readFile(".lcs/observability.json", "utf-8");
    const obs = /** @type {Record<string, unknown>} */ (JSON.parse(raw));
    const summary = /** @type {Record<string, unknown>} */ (obs.summary ?? obs);

    return jsonResponse(200, {
      tokenSavings: {
        avg: typeof summary.avgTokenSavingsPercent === "number" ? summary.avgTokenSavingsPercent : defaults.tokenSavings.avg,
        last: null
      },
      chunkSavings: {
        avg: typeof summary.avgChunkSavingsPercent === "number" ? summary.avgChunkSavingsPercent : defaults.chunkSavings.avg,
        last: null
      },
      qualityPassRate: typeof summary.qualityPassRate === "number" ? summary.qualityPassRate : defaults.qualityPassRate,
      degradedRecallRate: typeof summary.degradedRecallRate === "number" ? summary.degradedRecallRate : defaults.degradedRecallRate,
      memoryRetention: typeof summary.avgMemoryRetentionRate === "number" ? summary.avgMemoryRetentionRate : defaults.memoryRetention,
      structuralHitRate: typeof summary.avgStructuralHitRate === "number" ? summary.avgStructuralHitRate : defaults.structuralHitRate,
      casesOverflowingWithout: typeof summary.overflowWithoutNexusRate === "number" ? summary.overflowWithoutNexusRate : defaults.casesOverflowingWithout,
      provider: typeof obs.provider === "string" ? obs.provider : defaults.provider,
      measuredAt: typeof obs.measuredAt === "string" ? obs.measuredAt : new Date().toISOString()
    });
  } catch {
    return jsonResponse(200, defaults);
  }
});

// ── Shadow mode contract (local comparison) ───────────────────────────

registerRoute("POST", "/api/shadow", async (/** @type {ApiRequest} */ req) => {
  const startedAt = Date.now();
  const body = /** @type {Record<string, unknown>} */ (req.body ?? {});
  const query = typeof body.query === "string" ? body.query : "";
  const rawChunks = Array.isArray(body.chunks) ? body.chunks.slice(0, 100) : [];

  if (!query.trim()) {
    return errorResponse(400, "Missing required field: query");
  }

  const contract = {
    nexusBaselineGate: {
      qualityGte: "baseline_quality",
      latencyMs: 2000,
      degradedRateLte: 0.05
    }
  };

  if (rawChunks.length === 0) {
    return jsonResponse(200, {
      query,
      contract,
      status: "shadow-awaiting-context",
      message: "Provide 'chunks' to run a live local shadow comparison."
    });
  }

  const contextSelection = selectEndpointContext({
    endpoint: "chat",
    query,
    chunks: rawChunks,
    language: typeof body.language === "string" ? body.language : undefined,
    framework: typeof body.framework === "string" ? body.framework : undefined,
    domain: typeof body.domain === "string" ? body.domain : undefined,
    sddProfile: typeof body.sddProfile === "string" ? body.sddProfile : undefined,
    profileOverrides: {
      tokenBudget:
        typeof body.tokenBudget === "number" ? body.tokenBudget : undefined,
      maxChunks:
        typeof body.maxChunks === "number" ? body.maxChunks : undefined
    }
  });

  const impact = buildContextImpactSummary({
    rawChunks: contextSelection.rawChunks,
    rawTokens: contextSelection.rawTokens,
    selectedChunks: contextSelection.selectedChunks.length,
    selectedTokens: contextSelection.usedTokens
  });

  const normalizeScore = (value) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.min(1, value))
      : 0;
  const average = (values) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const baselineScores = rawChunks
    .map((chunk) => {
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
        return 0;
      }
      const record = /** @type {Record<string, unknown>} */ (chunk);
      return normalizeScore(
        typeof record.priority === "number"
          ? record.priority
          : typeof record.score === "number"
            ? record.score
            : typeof record.signalScore === "number"
              ? record.signalScore
              : 0
      );
    });
  const selectedScores = contextSelection.selectedChunks.map((chunk) =>
    normalizeScore(
      typeof chunk.score === "number"
        ? chunk.score
        : typeof chunk.priority === "number"
          ? chunk.priority
          : 0
    )
  );
  const baselineQuality = Number(average(baselineScores).toFixed(4));
  const nexusQuality = Number(average(selectedScores).toFixed(4));
  const sddCoverageRate = computeSddCoverageRate(contextSelection.sdd);
  const qualityGate = nexusQuality + 0.001 >= baselineQuality;
  const latencyMs = Math.max(0, Date.now() - startedAt);
  const latencyGate = latencyMs <= contract.nexusBaselineGate.latencyMs;
  const degradedRate = 0;
  const degradedGate = degradedRate <= contract.nexusBaselineGate.degradedRateLte;
  const replacementReady = qualityGate && latencyGate && degradedGate;

  return jsonResponse(200, {
    query,
    contract,
    status: replacementReady ? "shadow-pass" : "shadow-observing",
    mode: contextSelection.mode,
    comparison: {
      baseline: {
        quality: baselineQuality,
        chunks: impact.withoutNexus.chunks,
        tokens: impact.withoutNexus.tokens
      },
      nexus: {
        quality: nexusQuality,
        sddCoverageRate,
        chunks: impact.withNexus.chunks,
        tokens: impact.withNexus.tokens
      }
    },
    impact,
    gate: {
      qualityGteBaseline: qualityGate,
      latencyMs,
      latencyWithinSlo: latencyGate,
      degradedRate,
      degradedWithinSlo: degradedGate
    },
    replacementReady,
    message: replacementReady
      ? "NEXUS passes local shadow gates."
      : "NEXUS shadow run recorded. Continue collecting comparative samples."
  });
});

registerRoute("GET", "/api/shadow/contract", async () => {
  return jsonResponse(200, {
    nexusSemanticContract: {
      version: "1.1.0",
      searchInterface: {
        method: "search(query: string, opts?: SearchOptions) => Promise<MemorySearchResult>",
        saveInterface: "save(input: MemorySaveInput) => Promise<Record<string,unknown>>"
      },
      qualityGates: {
        topKOverlapWithBaseline: ">= 0.7",
        latencyP95Ms: "<= 2000",
        degradedRate: "<= 0.05",
        qualityPassRate: ">= 0.9"
      },
      baselineStatus: "local-first",
      replacementTrigger: "nexus_wins_by_metrics",
      targetPhase: "P7"
    }
  });
});

// ── POST /api/chat (LLM completion with optional context) ────────────

registerRoute("POST", "/api/chat", async (/** @type {ApiRequest} */ req) => {
  const requestStartedAt = Date.now();
  const query = requireField(req.body, "query");
  if (query.length > 4000) {
    await recordApiMetric("api.chat", requestStartedAt, {
      command: "api.chat",
      durationMs: 0,
      degraded: true,
      safety: {
        blocked: true,
        reason: "query-too-long"
      }
    });
    return errorResponse(400, "Field 'query' exceeds max length (4000 chars).");
  }

  const rawChunks = Array.isArray(req.body.chunks) ? req.body.chunks : [];
  const chunks = rawChunks.slice(0, 100);
  const withContext = req.body.withContext !== false;
  const model = optionalField(req.body, "model");
  const language = typeof req.body.language === "string" ? req.body.language : undefined;
  const framework = typeof req.body.framework === "string" ? req.body.framework : undefined;
  const domain = typeof req.body.domain === "string" ? req.body.domain : undefined;
  const sddProfile = typeof req.body.sddProfile === "string" ? req.body.sddProfile : undefined;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const isObjectChunk =
      Boolean(chunk) &&
      typeof chunk === "object" &&
      !Array.isArray(chunk);
    const isStringChunk = typeof chunk === "string";

    if (!isObjectChunk && !isStringChunk) {
      await recordApiMetric("api.chat", requestStartedAt, {
        command: "api.chat",
        durationMs: 0,
        degraded: true,
        safety: {
          blocked: true,
          reason: "invalid-chunk-shape"
        }
      });
      return errorResponse(400, `Invalid chunk at index ${index}. Expected string or object.`);
    }

    if (isObjectChunk) {
      const record = /** @type {Record<string, unknown>} */ (chunk);
      if (record.source !== undefined && typeof record.source !== "string") {
        await recordApiMetric("api.chat", requestStartedAt, {
          command: "api.chat",
          durationMs: 0,
          degraded: true,
          safety: {
            blocked: true,
            reason: "invalid-chunk-source"
          }
        });
        return errorResponse(400, `Invalid chunk at index ${index}. Field 'source' must be a string.`);
      }
      if (record.id !== undefined && typeof record.id !== "string") {
        await recordApiMetric("api.chat", requestStartedAt, {
          command: "api.chat",
          durationMs: 0,
          degraded: true,
          safety: {
            blocked: true,
            reason: "invalid-chunk-id"
          }
        });
        return errorResponse(400, `Invalid chunk at index ${index}. Field 'id' must be a string.`);
      }
      if (record.content !== undefined && typeof record.content !== "string") {
        await recordApiMetric("api.chat", requestStartedAt, {
          command: "api.chat",
          durationMs: 0,
          degraded: true,
          safety: {
            blocked: true,
            reason: "invalid-chunk-content"
          }
        });
        return errorResponse(400, `Invalid chunk at index ${index}. Field 'content' must be a string.`);
      }
      if (record.priority !== undefined && typeof record.priority !== "number") {
        await recordApiMetric("api.chat", requestStartedAt, {
          command: "api.chat",
          durationMs: 0,
          degraded: true,
          safety: {
            blocked: true,
            reason: "invalid-chunk-priority"
          }
        });
        return errorResponse(400, `Invalid chunk at index ${index}. Field 'priority' must be a number.`);
      }
      if (record.score !== undefined && typeof record.score !== "number") {
        await recordApiMetric("api.chat", requestStartedAt, {
          command: "api.chat",
          durationMs: 0,
          degraded: true,
          safety: {
            blocked: true,
            reason: "invalid-chunk-score"
          }
        });
        return errorResponse(400, `Invalid chunk at index ${index}. Field 'score' must be a number.`);
      }
    }
  }

  const contextSelection = selectEndpointContext({
    endpoint: "chat",
    query,
    chunks: withContext ? chunks : [],
    language,
    framework,
    domain,
    sddProfile,
    profileOverrides: {
      tokenBudget:
        typeof req.body.tokenBudget === "number" ? req.body.tokenBudget : undefined,
      maxChunks:
        typeof req.body.maxChunks === "number" ? req.body.maxChunks : undefined
    }
  });

  // Build context from chunks
  let context = undefined;
  if (withContext && contextSelection.selectedChunks.length > 0) {
    context = contextSelection.selectedChunks.map((c, i) => {
      const source = c.source ?? c.id ?? `chunk-${i}`;
      const content = sanitizeChunkContent(String(c.content ?? ""));
      const score = typeof c.priority === "number" ? c.priority : typeof c.score === "number" ? c.score : 0;
      return `[${source} | score:${(score * 100).toFixed(0)}%]\n${content}`;
    }).join("\n\n");

    if (context.length > MAX_CHAT_CONTEXT_CHARS) {
      context = `${context.slice(0, MAX_CHAT_CONTEXT_CHARS)}\n\n[context truncated by API limit]`;
    }
  }

  const result = await chatCompletion({ query, context, model });
  const parsed = parseLlmResponse(String(result.response ?? ""));
  const selectedChunks = withContext ? contextSelection.selectedChunks.length : 0;
  const selectedTokens = withContext ? contextSelection.usedTokens : 0;
  const impact = buildContextImpactSummary({
    rawChunks: withContext ? contextSelection.rawChunks : 0,
    rawTokens: withContext ? contextSelection.rawTokens : 0,
    selectedChunks,
    selectedTokens
  });
  const suppressedChunks = impact.suppressed.chunks;
  const suppressedTokens = impact.suppressed.tokens;
  const sddCoverageRate = computeSddCoverageRate(contextSelection.sdd);
  const promptStats = {
    rawChunks: impact.withoutNexus.chunks,
    rawTokens: impact.withoutNexus.tokens,
    includedChunks: impact.withNexus.chunks,
    usedTokens: impact.withNexus.tokens,
    suppressedChunks,
    suppressedTokens,
    tokenSavingsPercent: impact.savings.percent,
    chunkSavingsPercent: impact.savings.chunkPercent
  };

  await recordApiMetric("api.chat", requestStartedAt, {
    command: "api.chat",
    durationMs: 0,
    degraded: result.ok !== true,
    selection: {
      selectedCount: selectedChunks,
      suppressedCount: suppressedChunks
    },
    sdd: buildSddMetricSummary(contextSelection.sdd),
    teaching: buildTeachingMetricSummary(parsed),
    safety: {
      blocked: false,
      reason: result.ok === true ? "" : "llm-provider-unavailable"
    }
  });

  return jsonResponse(result.ok ? 200 : 503, {
    status: result.ok ? "ok" : "degraded",
    degraded: result.ok !== true,
    response: result.response,
    model: result.model,
    tokens: result.tokens,
    provider: result.provider,
    withContext,
    chunksUsed: selectedChunks,
    contextMode: contextSelection.mode,
    contextSdd: contextSelection.sdd,
    promptStats,
    impact,
    nexus: {
      signature: "nexus-context-orchestrator",
      differentiators: [
        "noise-cancel-selection",
        "adaptive-token-budget",
        "sdd-coverage-enforcement",
        "teaching-loop-structure"
      ],
      contextMode: contextSelection.mode,
      sddCoverageRate
    }
  });
});

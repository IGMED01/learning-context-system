// @ts-check

/**
 * Code Gate v2 — Tool Interface Pattern.
 *
 * - Gate tools are declarative units (`src/tools/gate-tools/*.js`)
 * - Orchestration runs selected tools in parallel
 * - Error formatting helpers are isolated in `code-gate-errors.js`
 */

import { resolveGateTools } from "../tools/gate-tools/index.js";
import {
  buildCodeGateEnv,
  readPackageJson
} from "../tools/gate-tools/shared.js";
import { createStaticToolPermissionContext } from "../orchestration/tool-permission.js";

/** @typedef {import("../types/core-contracts.d.ts").CodeGateStatus} CodeGateStatus */
/** @typedef {import("../types/core-contracts.d.ts").CodeGateResult} CodeGateResult */
/** @typedef {import("../types/core-contracts.d.ts").CodeGateToolResult["tool"]} CodeGateToolName */

export { buildCodeGateEnv };
export { formatGateErrors, getGateErrors } from "./code-gate-errors.js";

const DEFAULT_TOOLS = /** @type {CodeGateToolName[]} */ (["typecheck", "lint", "build"]);
const CODE_GATE_PERMISSION_SCOPE = "code-gate";

/**
 * @param {string | undefined} raw
 * @returns {string[]}
 */
function parseCsv(raw) {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * @param {{ permissionContext?: { resolve?: Function } }} opts
 */
function resolvePermissionContext(opts) {
  if (opts?.permissionContext && typeof opts.permissionContext.resolve === "function") {
    return opts.permissionContext;
  }

  const blockedTools = parseCsv(process.env.LCS_CODE_GATE_BLOCKED_TOOLS);
  if (!blockedTools.length) {
    return null;
  }

  return createStaticToolPermissionContext({
    blockedTools,
    defaultDecision: "allow"
  });
}

/**
 * @param {CodeGateToolName[] | undefined} requestedTools
 */
function pickTools(requestedTools) {
  if (Array.isArray(requestedTools) && requestedTools.length > 0) {
    return resolveGateTools(requestedTools);
  }

  return resolveGateTools(DEFAULT_TOOLS);
}

/**
 * Run the Code Gate for a given workspace.
 *
 * @param {{
 *   cwd?: string,
 *   tools?: CodeGateToolName[],
 *   skipOnMissing?: boolean,
 *   permissionContext?: { resolve?: (request: { tool: string, scope?: string, metadata?: Record<string, unknown> }) => Promise<{ allowed: boolean, source?: string, reason?: string }> }
 * }} [opts]
 * @returns {Promise<CodeGateResult>}
 */
export async function runCodeGate(opts = {}) {
  const startedAt = Date.now();
  const cwd = opts.cwd ?? process.cwd();
  const pkg = (await readPackageJson(cwd)) ?? {};
  const activeTools = pickTools(opts.tools);
  const permissionContext = resolvePermissionContext(opts);
  const results = await Promise.all(
    activeTools.map(async (tool) => {
      if (permissionContext) {
        const decision = await permissionContext.resolve({
          tool: tool.name,
          scope: CODE_GATE_PERMISSION_SCOPE,
          metadata: { cwd }
        });

        if (decision && decision.allowed === false) {
          return {
            tool: tool.name,
            status: "skipped",
            errors: [
              {
                tool: tool.name,
                severity: "warning",
                message: `Skipped by permission context (${decision.source ?? "unknown"}): ${decision.reason ?? "denied"}`
              }
            ],
            durationMs: 0,
            raw: ""
          };
        }
      }

      return tool.run(cwd, pkg);
    })
  );

  const errorCount = results.flatMap((result) => result.errors).filter((e) => e.severity === "error").length;
  const warningCount = results.flatMap((result) => result.errors).filter((e) => e.severity === "warning").length;
  const hasFail = results.some((result) => result.status === "fail");
  const allSkipped = results.length === 0 || results.every((result) => result.status === "skipped");
  const hasDegraded = results.some((result) => result.status === "degraded");

  /** @type {CodeGateStatus} */
  const status = hasFail
    ? "fail"
    : allSkipped
      ? "skipped"
      : hasDegraded
        ? "degraded"
        : "pass";

  return {
    status,
    tools: results,
    errorCount,
    warningCount,
    durationMs: Date.now() - startedAt,
    passed: status === "pass" || status === "skipped"
  };
}

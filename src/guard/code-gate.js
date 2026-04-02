// @ts-check

/**
 * Code Gate v2 — Tool Interface Pattern.
 *
 * - Gate tools are declarative units (`src/tools/gate-tools/*.js`)
 * - Orchestration runs selected tools in parallel
 * - Error formatting helpers are isolated in `code-gate-errors.js`
 */

import { allGateTools, resolveGateTools } from "../tools/gate-tools/index.js";
import {
  buildCodeGateEnv,
  readPackageJson
} from "../tools/gate-tools/shared.js";

/** @typedef {import("../types/core-contracts.d.ts").CodeGateStatus} CodeGateStatus */
/** @typedef {import("../types/core-contracts.d.ts").CodeGateResult} CodeGateResult */
/** @typedef {import("../types/core-contracts.d.ts").CodeGateToolResult["tool"]} CodeGateToolName */

export { buildCodeGateEnv };
export { formatGateErrors, getGateErrors } from "./code-gate-errors.js";

const DEFAULT_TOOLS = /** @type {CodeGateToolName[]} */ (["typecheck", "lint", "build"]);

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
 *   skipOnMissing?: boolean
 * }} [opts]
 * @returns {Promise<CodeGateResult>}
 */
export async function runCodeGate(opts = {}) {
  const startedAt = Date.now();
  const cwd = opts.cwd ?? process.cwd();
  const pkg = (await readPackageJson(cwd)) ?? {};
  const activeTools = pickTools(opts.tools);

  const results = await Promise.all(activeTools.map((tool) => tool.run(cwd, pkg)));

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

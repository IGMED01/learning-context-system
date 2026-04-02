// @ts-check

import { buildGateTool } from "../gate-tool.js";
import { GATE_TIMEOUT_MS, runGateCommand } from "./shared.js";

/** @typedef {import("../../types/core-contracts.d.ts").CodeGateError} CodeGateError */

/**
 * @param {Record<string, unknown>} pkg
 */
function hasTestScript(pkg) {
  const scripts = /** @type {Record<string, unknown>} */ (pkg.scripts ?? {});
  return typeof scripts.test === "string" && scripts.test.trim().length > 0;
}

/**
 * Parse npm test output into structured errors.
 *
 * @param {string} output
 * @returns {CodeGateError[]}
 */
function parseTestErrors(output) {
  /** @type {CodeGateError[]} */
  const errors = [];

  for (const line of output.split("\n")) {
    const tapMatch = line.match(/^not ok\s+\d+\s+-\s+(.+)$/);
    if (tapMatch) {
      errors.push({
        message: tapMatch[1].trim(),
        severity: "error",
        tool: "test"
      });
      continue;
    }

    if (/^\s*(Error:|AssertionError:)/i.test(line)) {
      errors.push({
        message: line.trim(),
        severity: "error",
        tool: "test"
      });
    }
  }

  return errors;
}

export const testTool = buildGateTool({
  name: "test",
  displayName: "Test",
  timeoutMs: GATE_TIMEOUT_MS * 3,
  shouldRunFn: async (_cwd, pkg) => hasTestScript(pkg),
  skipMessageFn: () => "No test script in package.json",
  checkFn: async (cwd) =>
    runGateCommand({
      command: "npm",
      args: ["test"],
      cwd,
      timeoutMs: GATE_TIMEOUT_MS * 3,
      envOverrides: { NODE_ENV: "test" }
    }),
  parseFn: parseTestErrors
});

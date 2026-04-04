// @ts-check

import { buildGateTool } from "../gate-tool.js";
import { GATE_TIMEOUT_MS, runGateCommand } from "./shared.js";

/** @typedef {import("../../types/core-contracts.d.ts").CodeGateError} CodeGateError */

/**
 * @param {Record<string, unknown>} pkg
 */
function hasBuildScript(pkg) {
  const scripts = /** @type {Record<string, unknown>} */ (pkg.scripts ?? {});
  return typeof scripts.build === "string" && scripts.build.trim().length > 0;
}

/**
 * Parse generic build output into structured errors.
 *
 * @param {string} output
 * @returns {CodeGateError[]}
 */
function parseBuildErrors(output) {
  /** @type {CodeGateError[]} */
  const errors = [];

  for (const line of output.split("\n")) {
    const tscMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)$/);
    if (tscMatch) {
      errors.push({
        file: tscMatch[1].trim(),
        line: parseInt(tscMatch[2], 10),
        column: parseInt(tscMatch[3], 10),
        severity: tscMatch[4] === "error" ? "error" : "warning",
        code: `TS${tscMatch[5]}`,
        message: tscMatch[6].trim(),
        tool: "build"
      });
      continue;
    }

    const errorMatch = line.match(/^\s*error:\s+(.+)$/i);
    if (errorMatch) {
      errors.push({
        message: errorMatch[1].trim(),
        severity: "error",
        tool: "build"
      });
    }
  }

  return errors;
}

export const buildTool = buildGateTool({
  name: "build",
  displayName: "Build",
  timeoutMs: GATE_TIMEOUT_MS * 2,
  shouldRunFn: async (_cwd, pkg) => hasBuildScript(pkg),
  skipMessageFn: () => "No build script in package.json",
  checkFn: async (cwd) =>
    runGateCommand({
      command: "npm",
      args: ["run", "build"],
      cwd,
      timeoutMs: GATE_TIMEOUT_MS * 2
    }),
  parseFn: parseBuildErrors
});

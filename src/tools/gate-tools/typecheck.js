// @ts-check

import path from "node:path";
import { buildGateTool } from "../gate-tool.js";
import { fileExists, GATE_TIMEOUT_MS, runGateCommand } from "./shared.js";

/** @typedef {import("../../types/core-contracts.d.ts").CodeGateError} CodeGateError */

/**
 * Parse tsc output into structured errors.
 * Format: "path/to/file.ts(line,col): error TS1234: message"
 *
 * @param {string} output
 * @returns {CodeGateError[]}
 */
function parseTscErrors(output) {
  /** @type {CodeGateError[]} */
  const errors = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)$/);
    if (!match) {
      continue;
    }

    errors.push({
      file: match[1].trim(),
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      severity: match[4] === "error" ? "error" : "warning",
      code: `TS${match[5]}`,
      message: match[6].trim(),
      tool: "typecheck"
    });
  }

  return errors;
}

export const typecheckTool = buildGateTool({
  name: "typecheck",
  displayName: "Typecheck",
  timeoutMs: GATE_TIMEOUT_MS,
  shouldRunFn: async (cwd) => fileExists(path.join(cwd, "tsconfig.json")),
  skipMessageFn: () => "No tsconfig.json found",
  checkFn: async (cwd) =>
    runGateCommand({
      command: "npx",
      args: ["tsc", "--noEmit", "--pretty", "false"],
      cwd,
      timeoutMs: GATE_TIMEOUT_MS
    }),
  parseFn: parseTscErrors
});

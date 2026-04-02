// @ts-check

import path from "node:path";
import { buildGateTool } from "../gate-tool.js";
import { fileExists, GATE_TIMEOUT_MS, runGateCommand } from "./shared.js";

/** @typedef {import("../../types/core-contracts.d.ts").CodeGateError} CodeGateError */

/**
 * @param {Record<string, unknown>} pkg
 */
function hasLintScript(pkg) {
  const scripts = /** @type {Record<string, unknown>} */ (pkg.scripts ?? {});
  return typeof scripts.lint === "string" && scripts.lint.trim().length > 0;
}

/**
 * @param {string} cwd
 */
async function hasEslintConfig(cwd) {
  const configs = await Promise.all([
    fileExists(path.join(cwd, ".eslintrc.js")),
    fileExists(path.join(cwd, ".eslintrc.json")),
    fileExists(path.join(cwd, "eslint.config.js")),
    fileExists(path.join(cwd, ".eslintrc.cjs"))
  ]);

  return configs.some(Boolean);
}

/**
 * Parse ESLint output into structured errors.
 *
 * @param {string} output
 * @returns {CodeGateError[]}
 */
function parseEslintErrors(output) {
  /** @type {CodeGateError[]} */
  const errors = [];

  try {
    const results = JSON.parse(output);
    if (!Array.isArray(results)) {
      return errors;
    }

    for (const result of results) {
      const filePath = String(result.filePath ?? "");
      for (const message of result.messages ?? []) {
        errors.push({
          file: filePath,
          line: message.line,
          column: message.column,
          code: message.ruleId ?? undefined,
          message: String(message.message ?? ""),
          severity: message.severity === 2 ? "error" : "warning",
          tool: "lint"
        });
      }
    }
    return errors;
  } catch {
    // Fall through to line-by-line parser.
  }

  for (const line of output.split("\n")) {
    const match = line.match(
      /^(.+?):\s+line\s+(\d+),\s+col\s+(\d+),\s+(Error|Warning)\s+-\s+(.+?)(?:\s+\((.+?)\))?$/i
    );
    if (!match) {
      continue;
    }

    errors.push({
      file: match[1].trim(),
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      severity: match[4].toLowerCase() === "error" ? "error" : "warning",
      message: match[5].trim(),
      code: match[6]?.trim(),
      tool: "lint"
    });
  }

  return errors;
}

export const lintTool = buildGateTool({
  name: "lint",
  displayName: "Lint",
  timeoutMs: GATE_TIMEOUT_MS,
  shouldRunFn: async (cwd, pkg) => hasLintScript(pkg) || (await hasEslintConfig(cwd)),
  skipMessageFn: () => "No lint script or ESLint config found",
  checkFn: async (cwd, pkg) => {
    const args = hasLintScript(pkg) ? ["run", "lint"] : ["eslint", "--format", "json", "."];
    return runGateCommand({
      command: "npm",
      args,
      cwd,
      timeoutMs: GATE_TIMEOUT_MS
    });
  },
  parseFn: parseEslintErrors
});

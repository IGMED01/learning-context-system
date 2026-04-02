// @ts-check

/** @typedef {import("../types/core-contracts.d.ts").CodeGateError} CodeGateError */
/** @typedef {import("../types/core-contracts.d.ts").CodeGateResult} CodeGateResult */

/**
 * Get only failing errors from a gate result, suitable for repair prompts.
 *
 * @param {CodeGateResult} result
 * @returns {CodeGateError[]}
 */
export function getGateErrors(result) {
  return result.tools.flatMap((tool) => tool.errors).filter((entry) => entry.severity === "error");
}

/**
 * Format gate errors as a compact string for LLM repair prompts.
 *
 * @param {CodeGateError[]} errors
 * @param {number} [maxErrors]
 * @returns {string}
 */
export function formatGateErrors(errors, maxErrors = 10) {
  const sliced = errors.slice(0, maxErrors);
  const lines = sliced.map((entry) => {
    const location = entry.file
      ? `${entry.file}${entry.line ? `:${entry.line}` : ""}${entry.column ? `:${entry.column}` : ""}`
      : "";
    const code = entry.code ? ` [${entry.code}]` : "";
    return `${entry.tool.toUpperCase()}${code} ${location ? `(${location})` : ""}: ${entry.message}`;
  });

  if (errors.length > maxErrors) {
    lines.push(`... and ${errors.length - maxErrors} more errors`);
  }

  return lines.join("\n");
}

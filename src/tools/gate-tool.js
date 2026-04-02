// @ts-check

/** @typedef {import("../types/core-contracts.d.ts").CodeGateError} CodeGateError */
/** @typedef {import("../types/core-contracts.d.ts").CodeGateToolResult} CodeGateToolResult */

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * @typedef {{
 *   name: "lint" | "typecheck" | "build" | "test",
 *   displayName?: string,
 *   timeoutMs?: number,
 *   shouldRunFn?: (cwd: string, pkg: Record<string, unknown>) => Promise<boolean> | boolean,
 *   skipMessageFn?: (cwd: string, pkg: Record<string, unknown>) => Promise<string> | string,
 *   checkFn: (cwd: string, pkg: Record<string, unknown>, meta: { timeoutMs: number }) => Promise<string | { stdout?: string, stderr?: string }>,
 *   parseFn: (output: string) => CodeGateError[]
 * }} GateToolDefinition
 */

/**
 * @param {unknown} output
 * @returns {string}
 */
function normalizeRunOutput(output) {
  if (typeof output === "string") {
    return output.trim();
  }

  if (typeof output === "object" && output) {
    const stdout =
      "stdout" in output && typeof output.stdout === "string" ? output.stdout : "";
    const stderr =
      "stderr" in output && typeof output.stderr === "string" ? output.stderr : "";
    return [stdout, stderr].filter(Boolean).join("\n").trim();
  }

  return String(output ?? "").trim();
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function rawErrorOutput(error) {
  if (typeof error === "object" && error) {
    const stdout =
      "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    const stderr =
      "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    if (stdout || stderr) {
      return [stdout, stderr].filter(Boolean).join("\n").trim();
    }
  }

  if (error instanceof Error) {
    return error.message.trim();
  }

  return String(error ?? "").trim();
}

export class GateTool {
  /**
   * @param {GateToolDefinition} definition
   */
  constructor(definition) {
    this.name = definition.name;
    this.displayName = definition.displayName ?? definition.name;
    this.timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.checkFn = definition.checkFn;
    this.parseFn = definition.parseFn;
    this.shouldRunFn = definition.shouldRunFn;
    this.skipMessageFn = definition.skipMessageFn;
  }

  /**
   * @param {string} cwd
   * @param {Record<string, unknown>} pkg
   */
  async isEnabled(cwd, pkg) {
    if (typeof this.shouldRunFn !== "function") {
      return true;
    }

    return Boolean(await this.shouldRunFn(cwd, pkg));
  }

  /**
   * @param {string} cwd
   * @param {Record<string, unknown>} pkg
   * @returns {Promise<CodeGateToolResult>}
   */
  async run(cwd, pkg) {
    const startedAt = Date.now();
    const shouldRun = await this.isEnabled(cwd, pkg);

    if (!shouldRun) {
      const skipMessage =
        typeof this.skipMessageFn === "function"
          ? await this.skipMessageFn(cwd, pkg)
          : `${this.displayName} not available`;
      return {
        tool: this.name,
        status: "skipped",
        errors: [],
        durationMs: 0,
        raw: skipMessage
      };
    }

    try {
      const output = await this.checkFn(cwd, pkg, { timeoutMs: this.timeoutMs });
      const raw = normalizeRunOutput(output);
      const errors = this.parseFn(raw);
      const hasErrors = errors.some((entry) => entry.severity === "error");

      return {
        tool: this.name,
        status: hasErrors ? "fail" : "pass",
        errors,
        durationMs: Date.now() - startedAt,
        raw
      };
    } catch (error) {
      const raw = rawErrorOutput(error);
      const errors = this.parseFn(raw);

      return {
        tool: this.name,
        status: errors.length ? "fail" : "degraded",
        errors,
        durationMs: Date.now() - startedAt,
        raw
      };
    }
  }
}

/**
 * @param {GateToolDefinition} definition
 */
export function buildGateTool(definition) {
  return new GateTool(definition);
}

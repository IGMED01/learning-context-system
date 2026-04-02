// @ts-check

import { spawnNexusAgent } from "./nexus-agent-orchestrator.js";
import { log } from "../core/logger.js";

const DEFAULT_SUMMARY_INTERVAL_MS = 30_000;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return false;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function parseIntervalMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1000) {
    return DEFAULT_SUMMARY_INTERVAL_MS;
  }

  return Math.trunc(numeric);
}

/**
 * @param {string[]} transcript
 * @param {string} previousSummary
 */
function buildSummaryPrompt(transcript, previousSummary) {
  return [
    "Describe in 3-5 words (present tense) what this agent is currently doing.",
    "Examples: 'Reading workspace files', 'Fixing null check', 'Analyzing test results'.",
    previousSummary ? `Previous summary: \"${previousSummary}\" — avoid repeating it.` : "",
    "Transcript (last 20 messages):",
    transcript.slice(-20).join("\n")
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * @param {string} text
 */
function normalizeSummaryText(text) {
  return String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 100);
}

/**
 * @typedef {{
 *   stop: () => void
 * }} BackgroundSummaryController
 */

/**
 * @typedef {{
 *   summarize?: (input: {
 *     operationId: string,
 *     transcript: string[],
 *     previousSummary: string,
 *     signal: AbortSignal
 *   }) => Promise<{ success: boolean, output?: string }>,
 *   intervalMs?: number
 * }} BackgroundSummaryOptions
 */

/**
 * @param {string} operationId
 * @param {() => string[]} getTranscript
 * @param {(summary: string) => void} onSummary
 * @param {BackgroundSummaryOptions} [options]
 * @returns {BackgroundSummaryController}
 */
export function startBackgroundSummary(operationId, getTranscript, onSummary, options = {}) {
  if (parseBoolean(process.env.LCS_DISABLE_AGENT_SUMMARY ?? "false")) {
    return { stop() {} };
  }

  const summaryIntervalMs = Number.isFinite(Number(options.intervalMs))
    ? Math.max(1, Math.trunc(Number(options.intervalMs)))
    : parseIntervalMs(process.env.LCS_SUMMARY_INTERVAL ?? DEFAULT_SUMMARY_INTERVAL_MS);

  const summarize = typeof options.summarize === "function"
    ? options.summarize
    : async ({ transcript, previousSummary, signal }) => {
        const result = await spawnNexusAgent({
          task: buildSummaryPrompt(transcript, previousSummary),
          signal,
          maxTokens: 50,
          runGate: false,
          project: "default",
          changedFiles: [],
          objective: "",
          focus: ""
        });

        return {
          success: result.success,
          output: result.output
        };
      };

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timeoutId = null;
  /** @type {AbortController | null} */
  let currentAbort = null;
  let previousSummary = "";
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) {
      return;
    }

    timeoutId = setTimeout(runSummary, summaryIntervalMs);
  };

  const runSummary = async () => {
    if (stopped) {
      return;
    }

    const transcript = getTranscript();
    if (!Array.isArray(transcript) || transcript.length === 0) {
      scheduleNext();
      return;
    }

    currentAbort = new AbortController();

    try {
      const result = await summarize({
        operationId,
        transcript,
        previousSummary,
        signal: currentAbort.signal
      });

      if (result?.success && result.output) {
        const summary = normalizeSummaryText(result.output);
        if (summary && summary !== previousSummary) {
          previousSummary = summary;
          onSummary(summary);
        }
      }
    } catch (error) {
      if (currentAbort?.signal.aborted) {
        return;
      }

      log("warn", "background summary failed", {
        operationId,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      currentAbort = null;
      if (!stopped) {
        scheduleNext();
      }
    }
  };

  scheduleNext();

  return {
    stop() {
      stopped = true;

      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      if (currentAbort) {
        currentAbort.abort();
        currentAbort = null;
      }
    }
  };
}

export { buildSummaryPrompt, normalizeSummaryText };

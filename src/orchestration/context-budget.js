// @ts-check

import { log } from "../core/logger.js";

const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

const state = {
  consecutiveFailures: 0,
  compacted: false
};

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 */
function parseInteger(raw, fallback) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(parsed));
}

/**
 * @param {string | undefined} raw
 */
function parseBoolean(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return false;
  }

  const normalized = String(raw).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function getThresholds() {
  return {
    contextWindow: parseInteger(process.env.LCS_CONTEXT_WINDOW, 200000),
    summaryOutputMax: parseInteger(process.env.LCS_SUMMARY_OUTPUT_MAX, 20000),
    autocompactBuffer: parseInteger(process.env.LCS_AUTOCOMPACT_BUFFER, 13000),
    warningBuffer: parseInteger(process.env.LCS_WARNING_BUFFER, 20000),
    blockingBuffer: parseInteger(process.env.LCS_BLOCKING_BUFFER, 3000)
  };
}

/**
 * @param {number} currentTokens
 */
export function calculateTokenBudgetState(currentTokens) {
  const thresholds = getThresholds();
  const safeTokens = Number.isFinite(currentTokens) ? Math.max(0, currentTokens) : 0;
  const effectiveWindow = Math.max(1, thresholds.contextWindow - thresholds.summaryOutputMax);
  const tokensLeft = thresholds.contextWindow - safeTokens;
  const pctLeft = tokensLeft / Math.max(1, thresholds.contextWindow);
  const aboveWarning = safeTokens > effectiveWindow - thresholds.warningBuffer;
  const aboveAutocompact = safeTokens > effectiveWindow - thresholds.autocompactBuffer;
  const aboveBlocking = safeTokens > thresholds.contextWindow - thresholds.blockingBuffer;
  const autoCompactDisabled = parseBoolean(process.env.LCS_DISABLE_AUTO_COMPACT);

  return {
    pctLeft,
    aboveWarning,
    aboveAutocompact,
    aboveBlocking,
    shouldCompact:
      aboveAutocompact &&
      !autoCompactDisabled &&
      state.consecutiveFailures < MAX_CONSECUTIVE_COMPACT_FAILURES
  };
}

export function recordCompactFailure() {
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
    log("warn", "auto-compact circuit breaker open", {
      failures: state.consecutiveFailures
    });
  }
}

export function recordCompactSuccess() {
  state.consecutiveFailures = 0;
  state.compacted = true;
}

export function resetCompactState() {
  state.consecutiveFailures = 0;
  state.compacted = false;
}

/**
 * Test helper to introspect breaker state.
 */
export function getCompactState() {
  return {
    consecutiveFailures: state.consecutiveFailures,
    compacted: state.compacted,
    maxConsecutiveFailures: MAX_CONSECUTIVE_COMPACT_FAILURES
  };
}

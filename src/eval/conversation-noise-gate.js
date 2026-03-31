// @ts-check

/**
 * @typedef {{
 *   turns: number,
 *   contextP95Tokens: number,
 *   anchorHitRate: number,
 *   noiseRatio: number,
 *   redundancyRatio: number,
 *   contextHalfLife: number
 * }} ConversationNoiseScenario
 */

/**
 * @typedef {{
 *   minTokenReduction?: number,
 *   minOptimizedAnchorHitRate?: number,
 *   maxAnchorHitRateDrop?: number,
 *   minRedundancyRatio?: number
 * }} ConversationNoiseThresholdsInput
 */

/**
 * @param {unknown} value
 */
function toFiniteNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }

  return value;
}

/**
 * @param {number} value
 */
function round(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * @param {ConversationNoiseThresholdsInput} [input]
 */
export function normalizeConversationNoiseThresholds(input = {}) {
  return {
    minTokenReduction: Math.max(0, Math.min(1, toFiniteNumber(input.minTokenReduction ?? 0.25))),
    minOptimizedAnchorHitRate: Math.max(
      0,
      Math.min(1, toFiniteNumber(input.minOptimizedAnchorHitRate ?? 0.9))
    ),
    maxAnchorHitRateDrop: Math.max(0, Math.min(1, toFiniteNumber(input.maxAnchorHitRateDrop ?? 0.05))),
    minRedundancyRatio: Math.max(0, Math.min(1, toFiniteNumber(input.minRedundancyRatio ?? 0.6)))
  };
}

/**
 * @param {{
 *   baseline: ConversationNoiseScenario,
 *   optimized: ConversationNoiseScenario,
 *   thresholds?: ConversationNoiseThresholdsInput
 * }} input
 */
export function evaluateConversationNoiseGate(input) {
  const thresholds = normalizeConversationNoiseThresholds(input.thresholds);
  const baseline = input.baseline;
  const optimized = input.optimized;
  const tokenReduction =
    baseline.contextP95Tokens > 0
      ? (baseline.contextP95Tokens - optimized.contextP95Tokens) / baseline.contextP95Tokens
      : 0;
  const anchorHitRateDrop = baseline.anchorHitRate - optimized.anchorHitRate;

  const checks = [
    {
      id: "token-reduction-p95",
      passed: tokenReduction >= thresholds.minTokenReduction,
      detail: `tokenReduction=${round(tokenReduction)} (required >= ${round(thresholds.minTokenReduction)})`
    },
    {
      id: "optimized-anchor-hit-rate",
      passed: optimized.anchorHitRate >= thresholds.minOptimizedAnchorHitRate,
      detail: `optimizedAnchorHitRate=${round(optimized.anchorHitRate)} (required >= ${round(thresholds.minOptimizedAnchorHitRate)})`
    },
    {
      id: "anchor-hit-rate-drop",
      passed: anchorHitRateDrop <= thresholds.maxAnchorHitRateDrop,
      detail: `anchorHitRateDrop=${round(anchorHitRateDrop)} (required <= ${round(thresholds.maxAnchorHitRateDrop)})`
    },
    {
      id: "redundancy-suppression",
      passed: optimized.redundancyRatio >= thresholds.minRedundancyRatio,
      detail: `optimizedRedundancyRatio=${round(optimized.redundancyRatio)} (required >= ${round(thresholds.minRedundancyRatio)})`
    }
  ];

  const failures = checks.filter((check) => !check.passed).map((check) => check.detail);

  return {
    passed: failures.length === 0,
    thresholds,
    checks,
    failures,
    summary: {
      turns: Math.max(baseline.turns, optimized.turns),
      baseline: {
        contextP95Tokens: baseline.contextP95Tokens,
        anchorHitRate: round(baseline.anchorHitRate),
        noiseRatio: round(baseline.noiseRatio),
        redundancyRatio: round(baseline.redundancyRatio),
        contextHalfLife: round(baseline.contextHalfLife)
      },
      optimized: {
        contextP95Tokens: optimized.contextP95Tokens,
        anchorHitRate: round(optimized.anchorHitRate),
        noiseRatio: round(optimized.noiseRatio),
        redundancyRatio: round(optimized.redundancyRatio),
        contextHalfLife: round(optimized.contextHalfLife)
      },
      tokenReduction: round(tokenReduction),
      anchorHitRateDrop: round(anchorHitRateDrop)
    }
  };
}

/**
 * @param {ReturnType<typeof evaluateConversationNoiseGate>} report
 */
export function formatConversationNoiseGateReport(report) {
  const lines = [
    "Conversation noise gate:",
    `- passed: ${report.passed ? "yes" : "no"}`,
    `- turns: ${report.summary.turns}`,
    `- baseline p95 tokens: ${report.summary.baseline.contextP95Tokens}`,
    `- optimized p95 tokens: ${report.summary.optimized.contextP95Tokens}`,
    `- token reduction: ${report.summary.tokenReduction}`,
    `- baseline anchor hit rate: ${report.summary.baseline.anchorHitRate}`,
    `- optimized anchor hit rate: ${report.summary.optimized.anchorHitRate}`,
    `- anchor hit drop: ${report.summary.anchorHitRateDrop}`,
    `- optimized redundancy ratio: ${report.summary.optimized.redundancyRatio}`,
    `- optimized context half life: ${report.summary.optimized.contextHalfLife}`,
    "",
    "Checks:"
  ];

  for (const check of report.checks) {
    lines.push(`- [${check.passed ? "pass" : "fail"}] ${check.id}: ${check.detail}`);
  }

  return lines.join("\n");
}


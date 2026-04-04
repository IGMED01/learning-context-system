// @ts-check

/**
 * @typedef {{
 *   id?: string,
 *   originalQuery: string,
 *   expectedKeywords: string[],
 *   baselineRewrite: string,
 *   candidateRewrite: string
 * }} Ft4QueryRewriteCase
 */

/**
 * @typedef {{
 *   minCandidateKeywordRecall?: number,
 *   minKeywordRecallLift?: number,
 *   minRewriteRate?: number,
 *   minIntentPreservationRate?: number,
 *   maxLengthRatio?: number
 * }} Ft4QueryRewriteThresholdsInput
 */

/**
 * @param {unknown} value
 */
function toFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * @param {number} value
 */
function clampUnit(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * @param {number} value
 */
function round(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * @param {string} value
 */
function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * @param {string} value
 */
function toTokenSet(value) {
  return new Set(
    normalizeText(value)
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  );
}

/**
 * @param {string} text
 * @param {string[]} keywords
 */
function keywordRecall(text, keywords) {
  const normalized = normalizeText(text);
  const targets = keywords
    .map((keyword) => normalizeText(keyword))
    .filter(Boolean);

  if (!targets.length) {
    return 1;
  }

  const matched = targets.filter((keyword) => normalized.includes(keyword)).length;
  return matched / targets.length;
}

/**
 * @param {string} original
 * @param {string} rewritten
 */
function intentPreserved(original, rewritten) {
  const originalTokens = toTokenSet(original);
  const rewrittenTokens = toTokenSet(rewritten);

  if (!originalTokens.size) {
    return rewrittenTokens.size === 0 ? 1 : 0;
  }

  let shared = 0;
  for (const token of originalTokens) {
    if (rewrittenTokens.has(token)) {
      shared += 1;
    }
  }

  return shared / originalTokens.size;
}

/**
 * @param {string} value
 */
function countWords(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(" ").length : 0;
}

/**
 * @param {Ft4QueryRewriteThresholdsInput | undefined} input
 */
export function normalizeFt4QueryRewriteThresholds(input = {}) {
  return {
    minCandidateKeywordRecall: clampUnit(toFiniteNumber(input.minCandidateKeywordRecall ?? 0.88)),
    minKeywordRecallLift: clampUnit(toFiniteNumber(input.minKeywordRecallLift ?? 0.15)),
    minRewriteRate: clampUnit(toFiniteNumber(input.minRewriteRate ?? 0.65)),
    minIntentPreservationRate: clampUnit(toFiniteNumber(input.minIntentPreservationRate ?? 0.85)),
    maxLengthRatio: Math.max(0.5, Math.min(4, toFiniteNumber(input.maxLengthRatio ?? 1.9)))
  };
}

/**
 * @param {{
 *   suiteName: string,
 *   cases: Ft4QueryRewriteCase[],
 *   thresholds?: Ft4QueryRewriteThresholdsInput
 * }} input
 */
export function evaluateFt4QueryRewriteGate(input) {
  const thresholds = normalizeFt4QueryRewriteThresholds(input.thresholds);
  const cases = Array.isArray(input.cases) ? input.cases : [];
  const normalizedCases = cases.map((entry, index) => {
    const originalQuery = String(entry.originalQuery ?? "");
    const baselineRewrite = String(entry.baselineRewrite ?? "");
    const candidateRewrite = String(entry.candidateRewrite ?? "");
    const keywords = Array.isArray(entry.expectedKeywords)
      ? entry.expectedKeywords.map((keyword) => String(keyword ?? "")).filter(Boolean)
      : [];
    const originalWordCount = Math.max(1, countWords(originalQuery));
    const candidateWordCount = countWords(candidateRewrite);
    const baselineKeywordRecall = keywordRecall(baselineRewrite, keywords);
    const candidateKeywordRecall = keywordRecall(candidateRewrite, keywords);
    const rewriteApplied = normalizeText(candidateRewrite) !== normalizeText(originalQuery);
    const intentScore = intentPreserved(originalQuery, candidateRewrite);
    const lengthRatio = candidateWordCount / originalWordCount;

    return {
      id: String(entry.id ?? `case-${index + 1}`),
      originalQuery,
      expectedKeywords: keywords,
      baselineRewrite,
      candidateRewrite,
      baselineKeywordRecall,
      candidateKeywordRecall,
      rewriteApplied,
      intentScore,
      lengthRatio
    };
  });

  const totalCases = normalizedCases.length || 1;
  const baselineKeywordRecall =
    normalizedCases.reduce((sum, entry) => sum + entry.baselineKeywordRecall, 0) / totalCases;
  const candidateKeywordRecall =
    normalizedCases.reduce((sum, entry) => sum + entry.candidateKeywordRecall, 0) / totalCases;
  const rewriteRate =
    normalizedCases.filter((entry) => entry.rewriteApplied).length / totalCases;
  const intentPreservationRate =
    normalizedCases.filter((entry) => entry.intentScore >= 0.25).length / totalCases;
  const maxLengthRatio = normalizedCases.reduce(
    (max, entry) => Math.max(max, entry.lengthRatio),
    0
  );
  const keywordRecallLift = Math.max(0, candidateKeywordRecall - baselineKeywordRecall);

  const checks = [
    {
      id: "min-candidate-keyword-recall",
      passed: candidateKeywordRecall >= thresholds.minCandidateKeywordRecall,
      detail: `candidateKeywordRecall=${round(candidateKeywordRecall)} (required >= ${round(
        thresholds.minCandidateKeywordRecall
      )})`
    },
    {
      id: "min-keyword-recall-lift",
      passed: keywordRecallLift >= thresholds.minKeywordRecallLift,
      detail: `keywordRecallLift=${round(keywordRecallLift)} (required >= ${round(
        thresholds.minKeywordRecallLift
      )})`
    },
    {
      id: "min-rewrite-rate",
      passed: rewriteRate >= thresholds.minRewriteRate,
      detail: `rewriteRate=${round(rewriteRate)} (required >= ${round(thresholds.minRewriteRate)})`
    },
    {
      id: "min-intent-preservation-rate",
      passed: intentPreservationRate >= thresholds.minIntentPreservationRate,
      detail: `intentPreservationRate=${round(intentPreservationRate)} (required >= ${round(
        thresholds.minIntentPreservationRate
      )})`
    },
    {
      id: "max-length-ratio",
      passed: maxLengthRatio <= thresholds.maxLengthRatio,
      detail: `maxLengthRatio=${round(maxLengthRatio)} (required <= ${round(thresholds.maxLengthRatio)})`
    }
  ];

  return {
    passed: checks.every((entry) => entry.passed),
    suiteName: input.suiteName,
    thresholds,
    checks,
    summary: {
      cases: normalizedCases.length,
      baselineKeywordRecall: round(baselineKeywordRecall),
      candidateKeywordRecall: round(candidateKeywordRecall),
      keywordRecallLift: round(keywordRecallLift),
      rewriteRate: round(rewriteRate),
      intentPreservationRate: round(intentPreservationRate),
      maxLengthRatio: round(maxLengthRatio)
    },
    cases: normalizedCases.map((entry) => ({
      id: entry.id,
      baselineKeywordRecall: round(entry.baselineKeywordRecall),
      candidateKeywordRecall: round(entry.candidateKeywordRecall),
      rewriteApplied: entry.rewriteApplied,
      intentScore: round(entry.intentScore),
      lengthRatio: round(entry.lengthRatio)
    }))
  };
}

/**
 * @param {ReturnType<typeof evaluateFt4QueryRewriteGate>} report
 */
export function formatFt4QueryRewriteGateReport(report) {
  const lines = [
    "FT-4 query rewrite gate:",
    `- suite: ${report.suiteName}`,
    `- passed: ${report.passed ? "yes" : "no"}`,
    `- cases: ${report.summary.cases}`,
    `- baseline keyword recall: ${report.summary.baselineKeywordRecall}`,
    `- candidate keyword recall: ${report.summary.candidateKeywordRecall}`,
    `- keyword recall lift: ${report.summary.keywordRecallLift}`,
    `- rewrite rate: ${report.summary.rewriteRate}`,
    `- intent preservation rate: ${report.summary.intentPreservationRate}`,
    `- max length ratio: ${report.summary.maxLengthRatio}`,
    "",
    "Checks:"
  ];

  for (const check of report.checks) {
    lines.push(`- [${check.passed ? "pass" : "fail"}] ${check.id}: ${check.detail}`);
  }

  return lines.join("\n");
}

// @ts-check

/**
 * @typedef { "low" | "medium" | "high" | "critical" | "unknown" } RiskLabel
 */

/**
 * @typedef {{
 *   id?: string,
 *   input?: string,
 *   expectedRisk: string,
 *   baselineRisk: string,
 *   candidateRisk: string
 * }} Ft3RiskCase
 */

/**
 * @typedef {{
 *   minCandidateAccuracy?: number,
 *   minCandidateMacroF1?: number,
 *   minHighRiskRecall?: number,
 *   minAccuracyLift?: number,
 *   maxUnderRiskRate?: number,
 *   maxUnknownRate?: number
 * }} Ft3RiskThresholdsInput
 */

const RISK_RANK = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

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
 * @returns {RiskLabel}
 */
function normalizeRiskLabel(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "critical") {
    return "critical";
  }

  if (normalized === "high") {
    return "high";
  }

  if (normalized === "medium" || normalized === "med") {
    return "medium";
  }

  if (normalized === "low") {
    return "low";
  }

  return "unknown";
}

/**
 * @param {Array<{ expected: RiskLabel, predicted: RiskLabel }>} rows
 */
function computeClassifierMetrics(rows) {
  const labels = new Set(rows.map((entry) => entry.expected).filter((label) => label !== "unknown"));
  const correct = rows.filter((entry) => entry.predicted === entry.expected).length;
  const unknownCount = rows.filter((entry) => entry.predicted === "unknown").length;
  const highRiskRows = rows.filter((entry) => entry.expected === "high" || entry.expected === "critical");
  const highRiskRecovered = highRiskRows.filter(
    (entry) => RISK_RANK[entry.predicted] >= RISK_RANK.high
  ).length;
  const underRiskRows = rows.filter(
    (entry) =>
      entry.expected !== "unknown" &&
      entry.predicted !== "unknown" &&
      RISK_RANK[entry.predicted] < RISK_RANK[entry.expected]
  ).length;
  const f1Scores = [];

  for (const label of labels) {
    const tp = rows.filter((entry) => entry.expected === label && entry.predicted === label).length;
    const fp = rows.filter((entry) => entry.expected !== label && entry.predicted === label).length;
    const fn = rows.filter((entry) => entry.expected === label && entry.predicted !== label).length;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    f1Scores.push(f1);
  }

  return {
    accuracy: rows.length ? correct / rows.length : 0,
    macroF1: f1Scores.length ? f1Scores.reduce((sum, value) => sum + value, 0) / f1Scores.length : 0,
    highRiskRecall: highRiskRows.length ? highRiskRecovered / highRiskRows.length : 1,
    underRiskRate: rows.length ? underRiskRows / rows.length : 0,
    unknownRate: rows.length ? unknownCount / rows.length : 1
  };
}

/**
 * @param {Ft3RiskThresholdsInput | undefined} input
 */
export function normalizeFt3RiskThresholds(input = {}) {
  return {
    minCandidateAccuracy: clampUnit(toFiniteNumber(input.minCandidateAccuracy ?? 0.88)),
    minCandidateMacroF1: clampUnit(toFiniteNumber(input.minCandidateMacroF1 ?? 0.85)),
    minHighRiskRecall: clampUnit(toFiniteNumber(input.minHighRiskRecall ?? 0.9)),
    minAccuracyLift: clampUnit(toFiniteNumber(input.minAccuracyLift ?? 0.12)),
    maxUnderRiskRate: clampUnit(toFiniteNumber(input.maxUnderRiskRate ?? 0.1)),
    maxUnknownRate: clampUnit(toFiniteNumber(input.maxUnknownRate ?? 0.05))
  };
}

/**
 * @param {{
 *   suiteName: string,
 *   cases: Ft3RiskCase[],
 *   thresholds?: Ft3RiskThresholdsInput
 * }} input
 */
export function evaluateFt3RiskGate(input) {
  const thresholds = normalizeFt3RiskThresholds(input.thresholds);
  const cases = Array.isArray(input.cases) ? input.cases : [];
  const normalizedCases = cases.map((entry, index) => ({
    id: String(entry.id ?? `case-${index + 1}`),
    input: String(entry.input ?? ""),
    expected: normalizeRiskLabel(entry.expectedRisk),
    baseline: normalizeRiskLabel(entry.baselineRisk),
    candidate: normalizeRiskLabel(entry.candidateRisk)
  }));

  const baseline = computeClassifierMetrics(
    normalizedCases.map((entry) => ({ expected: entry.expected, predicted: entry.baseline }))
  );
  const candidate = computeClassifierMetrics(
    normalizedCases.map((entry) => ({ expected: entry.expected, predicted: entry.candidate }))
  );
  const accuracyLift = Math.max(0, candidate.accuracy - baseline.accuracy);

  const checks = [
    {
      id: "min-candidate-accuracy",
      passed: candidate.accuracy >= thresholds.minCandidateAccuracy,
      detail: `candidateAccuracy=${round(candidate.accuracy)} (required >= ${round(
        thresholds.minCandidateAccuracy
      )})`
    },
    {
      id: "min-candidate-macro-f1",
      passed: candidate.macroF1 >= thresholds.minCandidateMacroF1,
      detail: `candidateMacroF1=${round(candidate.macroF1)} (required >= ${round(
        thresholds.minCandidateMacroF1
      )})`
    },
    {
      id: "min-high-risk-recall",
      passed: candidate.highRiskRecall >= thresholds.minHighRiskRecall,
      detail: `candidateHighRiskRecall=${round(candidate.highRiskRecall)} (required >= ${round(
        thresholds.minHighRiskRecall
      )})`
    },
    {
      id: "min-accuracy-lift",
      passed: accuracyLift >= thresholds.minAccuracyLift,
      detail: `accuracyLift=${round(accuracyLift)} (required >= ${round(thresholds.minAccuracyLift)})`
    },
    {
      id: "max-under-risk-rate",
      passed: candidate.underRiskRate <= thresholds.maxUnderRiskRate,
      detail: `candidateUnderRiskRate=${round(candidate.underRiskRate)} (required <= ${round(
        thresholds.maxUnderRiskRate
      )})`
    },
    {
      id: "max-unknown-rate",
      passed: candidate.unknownRate <= thresholds.maxUnknownRate,
      detail: `candidateUnknownRate=${round(candidate.unknownRate)} (required <= ${round(
        thresholds.maxUnknownRate
      )})`
    }
  ];

  return {
    passed: checks.every((entry) => entry.passed),
    suiteName: input.suiteName,
    thresholds,
    checks,
    summary: {
      cases: normalizedCases.length,
      baselineAccuracy: round(baseline.accuracy),
      candidateAccuracy: round(candidate.accuracy),
      baselineMacroF1: round(baseline.macroF1),
      candidateMacroF1: round(candidate.macroF1),
      baselineHighRiskRecall: round(baseline.highRiskRecall),
      candidateHighRiskRecall: round(candidate.highRiskRecall),
      baselineUnderRiskRate: round(baseline.underRiskRate),
      candidateUnderRiskRate: round(candidate.underRiskRate),
      baselineUnknownRate: round(baseline.unknownRate),
      candidateUnknownRate: round(candidate.unknownRate),
      accuracyLift: round(accuracyLift)
    },
    cases: normalizedCases.map((entry) => ({
      id: entry.id,
      expectedRisk: entry.expected,
      baselineRisk: entry.baseline,
      candidateRisk: entry.candidate,
      baselinePass: entry.expected === entry.baseline,
      candidatePass: entry.expected === entry.candidate,
      underRisked:
        entry.expected !== "unknown" &&
        entry.candidate !== "unknown" &&
        RISK_RANK[entry.candidate] < RISK_RANK[entry.expected]
    }))
  };
}

/**
 * @param {ReturnType<typeof evaluateFt3RiskGate>} report
 */
export function formatFt3RiskGateReport(report) {
  const lines = [
    "FT-3 risk classifier gate:",
    `- suite: ${report.suiteName}`,
    `- passed: ${report.passed ? "yes" : "no"}`,
    `- cases: ${report.summary.cases}`,
    `- baseline accuracy: ${report.summary.baselineAccuracy}`,
    `- candidate accuracy: ${report.summary.candidateAccuracy}`,
    `- baseline macro F1: ${report.summary.baselineMacroF1}`,
    `- candidate macro F1: ${report.summary.candidateMacroF1}`,
    `- baseline high-risk recall: ${report.summary.baselineHighRiskRecall}`,
    `- candidate high-risk recall: ${report.summary.candidateHighRiskRecall}`,
    `- candidate under-risk rate: ${report.summary.candidateUnderRiskRate}`,
    `- candidate unknown rate: ${report.summary.candidateUnknownRate}`,
    `- accuracy lift: ${report.summary.accuracyLift}`,
    "",
    "Checks:"
  ];

  for (const check of report.checks) {
    lines.push(`- [${check.passed ? "pass" : "fail"}] ${check.id}: ${check.detail}`);
  }

  return lines.join("\n");
}

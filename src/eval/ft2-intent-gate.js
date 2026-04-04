// @ts-check

/**
 * @typedef {{
 *   id?: string,
 *   input?: string,
 *   expectedIntent: string,
 *   baselineIntent: string,
 *   candidateIntent: string
 * }} Ft2IntentCase
 */

/**
 * @typedef {{
 *   minCandidateAccuracy?: number,
 *   minCandidateMacroF1?: number,
 *   minAccuracyLift?: number,
 *   minMacroF1Lift?: number,
 *   maxUnknownRate?: number
 * }} Ft2IntentThresholdsInput
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
function normalizeLabel(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * @param {Ft2IntentThresholdsInput | undefined} input
 */
export function normalizeFt2IntentThresholds(input = {}) {
  return {
    minCandidateAccuracy: clampUnit(toFiniteNumber(input.minCandidateAccuracy ?? 0.9)),
    minCandidateMacroF1: clampUnit(toFiniteNumber(input.minCandidateMacroF1 ?? 0.88)),
    minAccuracyLift: clampUnit(toFiniteNumber(input.minAccuracyLift ?? 0.15)),
    minMacroF1Lift: clampUnit(toFiniteNumber(input.minMacroF1Lift ?? 0.15)),
    maxUnknownRate: clampUnit(toFiniteNumber(input.maxUnknownRate ?? 0.05))
  };
}

/**
 * @param {Array<{ expected: string, predicted: string }>} rows
 */
function computeClassifierMetrics(rows) {
  const labels = new Set(rows.map((entry) => entry.expected).filter(Boolean));

  if (!labels.size) {
    return {
      accuracy: 0,
      macroF1: 0,
      unknownRate: 1
    };
  }

  const correct = rows.filter((entry) => entry.predicted === entry.expected).length;
  const unknownCount = rows.filter((entry) => !entry.predicted).length;
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
    unknownRate: rows.length ? unknownCount / rows.length : 1
  };
}

/**
 * @param {{
 *   suiteName: string,
 *   cases: Ft2IntentCase[],
 *   thresholds?: Ft2IntentThresholdsInput
 * }} input
 */
export function evaluateFt2IntentGate(input) {
  const thresholds = normalizeFt2IntentThresholds(input.thresholds);
  const cases = Array.isArray(input.cases) ? input.cases : [];
  const normalizedCases = cases.map((entry, index) => ({
    id: String(entry.id ?? `case-${index + 1}`),
    input: String(entry.input ?? ""),
    expected: normalizeLabel(entry.expectedIntent),
    baseline: normalizeLabel(entry.baselineIntent),
    candidate: normalizeLabel(entry.candidateIntent)
  }));

  const baseline = computeClassifierMetrics(
    normalizedCases.map((entry) => ({ expected: entry.expected, predicted: entry.baseline }))
  );
  const candidate = computeClassifierMetrics(
    normalizedCases.map((entry) => ({ expected: entry.expected, predicted: entry.candidate }))
  );
  const accuracyLift = Math.max(0, candidate.accuracy - baseline.accuracy);
  const macroF1Lift = Math.max(0, candidate.macroF1 - baseline.macroF1);

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
      id: "min-accuracy-lift",
      passed: accuracyLift >= thresholds.minAccuracyLift,
      detail: `accuracyLift=${round(accuracyLift)} (required >= ${round(thresholds.minAccuracyLift)})`
    },
    {
      id: "min-macro-f1-lift",
      passed: macroF1Lift >= thresholds.minMacroF1Lift,
      detail: `macroF1Lift=${round(macroF1Lift)} (required >= ${round(thresholds.minMacroF1Lift)})`
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
      baselineUnknownRate: round(baseline.unknownRate),
      candidateUnknownRate: round(candidate.unknownRate),
      accuracyLift: round(accuracyLift),
      macroF1Lift: round(macroF1Lift)
    },
    cases: normalizedCases.map((entry) => ({
      id: entry.id,
      expectedIntent: entry.expected,
      baselineIntent: entry.baseline,
      candidateIntent: entry.candidate,
      baselinePass: entry.expected === entry.baseline,
      candidatePass: entry.expected === entry.candidate
    }))
  };
}

/**
 * @param {ReturnType<typeof evaluateFt2IntentGate>} report
 */
export function formatFt2IntentGateReport(report) {
  const lines = [
    "FT-2 intent routing gate:",
    `- suite: ${report.suiteName}`,
    `- passed: ${report.passed ? "yes" : "no"}`,
    `- cases: ${report.summary.cases}`,
    `- baseline accuracy: ${report.summary.baselineAccuracy}`,
    `- candidate accuracy: ${report.summary.candidateAccuracy}`,
    `- baseline macro F1: ${report.summary.baselineMacroF1}`,
    `- candidate macro F1: ${report.summary.candidateMacroF1}`,
    `- accuracy lift: ${report.summary.accuracyLift}`,
    `- macro F1 lift: ${report.summary.macroF1Lift}`,
    `- candidate unknown rate: ${report.summary.candidateUnknownRate}`,
    "",
    "Checks:"
  ];

  for (const check of report.checks) {
    lines.push(`- [${check.passed ? "pass" : "fail"}] ${check.id}: ${check.detail}`);
  }

  return lines.join("\n");
}


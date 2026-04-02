// @ts-check

import { parseLlmResponse } from "../llm/response-parser.js";

/**
 * @typedef {{
 *   id?: string,
 *   task?: string,
 *   baselineOutput: string,
 *   candidateOutput: string
 * }} Ft1FormatCase
 */

/**
 * @typedef {{
 *   minCasePassRate?: number,
 *   minCandidateSectionCoverage?: number,
 *   minCandidatePracticeRate?: number,
 *   minCandidateHeadingCoverage?: number,
 *   minCoverageLift?: number,
 *   minPracticeLift?: number
 * }} Ft1FormatThresholdsInput
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
function round(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * @param {number} value
 */
function clampUnit(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * @param {number[]} values
 */
function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * @param {Ft1FormatThresholdsInput | undefined} input
 */
export function normalizeFt1FormatThresholds(input = {}) {
  return {
    minCasePassRate: clampUnit(toFiniteNumber(input.minCasePassRate ?? 0.9)),
    minCandidateSectionCoverage: clampUnit(
      toFiniteNumber(input.minCandidateSectionCoverage ?? 0.95)
    ),
    minCandidatePracticeRate: clampUnit(toFiniteNumber(input.minCandidatePracticeRate ?? 0.95)),
    minCandidateHeadingCoverage: clampUnit(
      toFiniteNumber(input.minCandidateHeadingCoverage ?? 0.95)
    ),
    minCoverageLift: clampUnit(toFiniteNumber(input.minCoverageLift ?? 0.2)),
    minPracticeLift: clampUnit(toFiniteNumber(input.minPracticeLift ?? 0.2))
  };
}

/**
 * @param {string} output
 */
function analyzeOutput(output) {
  const text = String(output ?? "");
  const parsed = parseLlmResponse(text);
  const hasChange = Boolean(parsed.change.trim());
  const hasReason = Boolean(parsed.reason.trim());
  const hasConcepts = parsed.concepts.length > 0;
  const hasPractice = Boolean(parsed.practice.trim());
  const sectionsPresent =
    (hasChange ? 1 : 0) + (hasReason ? 1 : 0) + (hasConcepts ? 1 : 0) + (hasPractice ? 1 : 0);
  const headingCoverage =
    (/\bchange\s*:/iu.test(text) ? 1 : 0) +
    (/\breason\s*:/iu.test(text) ? 1 : 0) +
    (/\bconcepts?\s*:/iu.test(text) ? 1 : 0) +
    (/\bpractice\s*:/iu.test(text) ? 1 : 0);

  return {
    hasChange,
    hasReason,
    hasConcepts,
    hasPractice,
    sectionCoverage: sectionsPresent / 4,
    headingCoverage: headingCoverage / 4
  };
}

/**
 * @param {{
 *   suiteName: string,
 *   cases: Ft1FormatCase[],
 *   thresholds?: Ft1FormatThresholdsInput
 * }} input
 */
export function evaluateFt1FormatGate(input) {
  const thresholds = normalizeFt1FormatThresholds(input.thresholds);
  const cases = Array.isArray(input.cases) ? input.cases : [];

  const evaluations = cases.map((entry, index) => {
    const baseline = analyzeOutput(entry.baselineOutput);
    const candidate = analyzeOutput(entry.candidateOutput);
    const pass =
      candidate.sectionCoverage === 1 &&
      candidate.headingCoverage === 1 &&
      candidate.hasPractice &&
      candidate.sectionCoverage >= baseline.sectionCoverage &&
      Number(candidate.hasPractice) >= Number(baseline.hasPractice);

    return {
      id: String(entry.id ?? `case-${index + 1}`),
      task: String(entry.task ?? ""),
      pass,
      baseline,
      candidate
    };
  });

  const casePassRate = evaluations.length
    ? evaluations.filter((entry) => entry.pass).length / evaluations.length
    : 0;
  const baselineSectionCoverage = average(
    evaluations.map((entry) => entry.baseline.sectionCoverage)
  );
  const candidateSectionCoverage = average(
    evaluations.map((entry) => entry.candidate.sectionCoverage)
  );
  const baselinePracticeRate = average(
    evaluations.map((entry) => (entry.baseline.hasPractice ? 1 : 0))
  );
  const candidatePracticeRate = average(
    evaluations.map((entry) => (entry.candidate.hasPractice ? 1 : 0))
  );
  const candidateHeadingCoverage = average(
    evaluations.map((entry) => entry.candidate.headingCoverage)
  );
  const coverageLift = Math.max(0, candidateSectionCoverage - baselineSectionCoverage);
  const practiceLift = Math.max(0, candidatePracticeRate - baselinePracticeRate);

  const checks = [
    {
      id: "min-case-pass-rate",
      passed: casePassRate >= thresholds.minCasePassRate,
      detail: `casePassRate=${round(casePassRate)} (required >= ${round(thresholds.minCasePassRate)})`
    },
    {
      id: "min-candidate-section-coverage",
      passed: candidateSectionCoverage >= thresholds.minCandidateSectionCoverage,
      detail: `candidateSectionCoverage=${round(candidateSectionCoverage)} (required >= ${round(
        thresholds.minCandidateSectionCoverage
      )})`
    },
    {
      id: "min-candidate-practice-rate",
      passed: candidatePracticeRate >= thresholds.minCandidatePracticeRate,
      detail: `candidatePracticeRate=${round(candidatePracticeRate)} (required >= ${round(
        thresholds.minCandidatePracticeRate
      )})`
    },
    {
      id: "min-candidate-heading-coverage",
      passed: candidateHeadingCoverage >= thresholds.minCandidateHeadingCoverage,
      detail: `candidateHeadingCoverage=${round(candidateHeadingCoverage)} (required >= ${round(
        thresholds.minCandidateHeadingCoverage
      )})`
    },
    {
      id: "min-coverage-lift",
      passed: coverageLift >= thresholds.minCoverageLift,
      detail: `coverageLift=${round(coverageLift)} (required >= ${round(thresholds.minCoverageLift)})`
    },
    {
      id: "min-practice-lift",
      passed: practiceLift >= thresholds.minPracticeLift,
      detail: `practiceLift=${round(practiceLift)} (required >= ${round(thresholds.minPracticeLift)})`
    }
  ];

  return {
    passed: checks.every((entry) => entry.passed),
    suiteName: input.suiteName,
    thresholds,
    checks,
    summary: {
      cases: evaluations.length,
      casePassRate: round(casePassRate),
      baselineSectionCoverage: round(baselineSectionCoverage),
      candidateSectionCoverage: round(candidateSectionCoverage),
      baselinePracticeRate: round(baselinePracticeRate),
      candidatePracticeRate: round(candidatePracticeRate),
      candidateHeadingCoverage: round(candidateHeadingCoverage),
      coverageLift: round(coverageLift),
      practiceLift: round(practiceLift)
    },
    cases: evaluations
  };
}

/**
 * @param {ReturnType<typeof evaluateFt1FormatGate>} report
 */
export function formatFt1FormatGateReport(report) {
  const lines = [
    "FT-1 format pilot gate:",
    `- suite: ${report.suiteName}`,
    `- passed: ${report.passed ? "yes" : "no"}`,
    `- cases: ${report.summary.cases}`,
    `- case pass rate: ${report.summary.casePassRate}`,
    `- baseline section coverage: ${report.summary.baselineSectionCoverage}`,
    `- candidate section coverage: ${report.summary.candidateSectionCoverage}`,
    `- baseline practice rate: ${report.summary.baselinePracticeRate}`,
    `- candidate practice rate: ${report.summary.candidatePracticeRate}`,
    `- candidate heading coverage: ${report.summary.candidateHeadingCoverage}`,
    `- coverage lift: ${report.summary.coverageLift}`,
    `- practice lift: ${report.summary.practiceLift}`,
    "",
    "Checks:"
  ];

  for (const check of report.checks) {
    lines.push(`- [${check.passed ? "pass" : "fail"}] ${check.id}: ${check.detail}`);
  }

  lines.push("");
  lines.push("Cases:");
  for (const entry of report.cases) {
    lines.push(
      `- ${entry.pass ? "PASS" : "FAIL"} ${entry.id} coverage=${round(
        entry.candidate.sectionCoverage
      )} heading=${round(entry.candidate.headingCoverage)} practice=${entry.candidate.hasPractice ? "yes" : "no"}`
    );
  }

  return lines.join("\n");
}


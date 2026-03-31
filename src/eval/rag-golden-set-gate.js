// @ts-check

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
 * @param {string} value
 */
function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * @param {{
 *   minCases?: number,
 *   minDomains?: number,
 *   minProjects?: number,
 *   minUniqueQueryRate?: number,
 *   maxExpectedDocsPerCase?: number
 * }} [input]
 */
export function normalizeRagGoldenSetThresholds(input = {}) {
  return {
    minCases: Math.max(1, Math.trunc(toFiniteNumber(input.minCases ?? 200))),
    minDomains: Math.max(1, Math.trunc(toFiniteNumber(input.minDomains ?? 8))),
    minProjects: Math.max(1, Math.trunc(toFiniteNumber(input.minProjects ?? 8))),
    minUniqueQueryRate: Math.max(0, Math.min(1, toFiniteNumber(input.minUniqueQueryRate ?? 0.98))),
    maxExpectedDocsPerCase: Math.max(
      1,
      Math.trunc(toFiniteNumber(input.maxExpectedDocsPerCase ?? 3))
    )
  };
}

/**
 * @param {{
 *   suite: string,
 *   documents: Array<{ id: string, project: string, domain: string, title: string, content: string }>,
 *   cases: Array<{ id: string, project: string, domain: string, query: string, expectedDocIds: string[] }>,
 *   thresholds?: {
 *     minCases?: number,
 *     minDomains?: number,
 *     minProjects?: number,
 *     minUniqueQueryRate?: number,
 *     maxExpectedDocsPerCase?: number
 *   }
 * }} input
 */
export function evaluateRagGoldenSetGate(input) {
  const thresholds = normalizeRagGoldenSetThresholds(input.thresholds);
  const cases = Array.isArray(input.cases) ? input.cases : [];
  const documents = Array.isArray(input.documents) ? input.documents : [];
  const domains = new Set(cases.map((entry) => entry.domain));
  const projects = new Set(cases.map((entry) => entry.project));
  const uniqueQueries = new Set(cases.map((entry) => normalizeText(entry.query)));
  const uniqueQueryRate = cases.length ? uniqueQueries.size / cases.length : 0;
  const maxExpectedDocsPerCase = cases.reduce(
    (max, entry) => Math.max(max, entry.expectedDocIds.length),
    0
  );
  const avgExpectedDocsPerCase = cases.length
    ? cases.reduce((sum, entry) => sum + entry.expectedDocIds.length, 0) / cases.length
    : 0;

  const checks = [
    {
      id: "min-cases",
      passed: cases.length >= thresholds.minCases,
      detail: `cases=${cases.length} (required >= ${thresholds.minCases})`
    },
    {
      id: "min-domains",
      passed: domains.size >= thresholds.minDomains,
      detail: `domains=${domains.size} (required >= ${thresholds.minDomains})`
    },
    {
      id: "min-projects",
      passed: projects.size >= thresholds.minProjects,
      detail: `projects=${projects.size} (required >= ${thresholds.minProjects})`
    },
    {
      id: "min-unique-query-rate",
      passed: uniqueQueryRate >= thresholds.minUniqueQueryRate,
      detail: `uniqueQueryRate=${round(uniqueQueryRate)} (required >= ${round(thresholds.minUniqueQueryRate)})`
    },
    {
      id: "max-expected-docs-per-case",
      passed: maxExpectedDocsPerCase <= thresholds.maxExpectedDocsPerCase,
      detail: `maxExpectedDocsPerCase=${maxExpectedDocsPerCase} (required <= ${thresholds.maxExpectedDocsPerCase})`
    }
  ];

  const failures = checks.filter((check) => !check.passed).map((check) => check.detail);

  return {
    passed: failures.length === 0,
    suite: input.suite,
    checks,
    failures,
    thresholds,
    summary: {
      cases: cases.length,
      documents: documents.length,
      domains: domains.size,
      projects: projects.size,
      uniqueQueryRate: round(uniqueQueryRate),
      avgExpectedDocsPerCase: round(avgExpectedDocsPerCase),
      maxExpectedDocsPerCase
    }
  };
}

/**
 * @param {ReturnType<typeof evaluateRagGoldenSetGate>} report
 */
export function formatRagGoldenSetGateReport(report) {
  const lines = [
    "RAG golden set gate:",
    `- suite: ${report.suite}`,
    `- passed: ${report.passed ? "yes" : "no"}`,
    `- cases: ${report.summary.cases}`,
    `- documents: ${report.summary.documents}`,
    `- domains: ${report.summary.domains}`,
    `- projects: ${report.summary.projects}`,
    `- unique query rate: ${report.summary.uniqueQueryRate}`,
    `- avg expected docs/case: ${report.summary.avgExpectedDocsPerCase}`,
    `- max expected docs/case: ${report.summary.maxExpectedDocsPerCase}`,
    "",
    "Checks:"
  ];

  for (const check of report.checks) {
    lines.push(`- [${check.passed ? "pass" : "fail"}] ${check.id}: ${check.detail}`);
  }

  return lines.join("\n");
}


// @ts-check

/**
 * @typedef {{
 *   name: string,
 *   endpoint: "ask" | "chat",
 *   expectedSources: string[],
 *   rankedSources: string[],
 *   latencyMs: number,
 *   retrievedChunks?: number,
 *   error?: string
 * }} RetrievalCaseInput
 */

/**
 * @typedef {{
 *   minCasePassRate?: number,
 *   minRecallAtK?: number,
 *   minMrr?: number,
 *   minNdcgAtK?: number,
 *   maxErrorRate?: number,
 *   maxP95LatencyMs?: number
 * }} RetrievalGateThresholdsInput
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
 * @param {string} value
 */
function normalizeSource(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
}

/**
 * @param {string[]} expectedSources
 * @param {string[]} rankedSources
 */
export function computeRecallAtK(expectedSources, rankedSources) {
  const expected = new Set(expectedSources.map(normalizeSource).filter(Boolean));
  if (expected.size === 0) {
    return 1;
  }

  const ranked = rankedSources.map(normalizeSource);
  let hits = 0;
  for (const source of expected) {
    if (ranked.includes(source)) {
      hits += 1;
    }
  }

  return round(hits / expected.size);
}

/**
 * @param {string[]} expectedSources
 * @param {string[]} rankedSources
 */
export function computeMrr(expectedSources, rankedSources) {
  const expected = new Set(expectedSources.map(normalizeSource).filter(Boolean));
  if (expected.size === 0) {
    return 1;
  }

  const ranked = rankedSources.map(normalizeSource);
  for (let index = 0; index < ranked.length; index += 1) {
    if (expected.has(ranked[index])) {
      return round(1 / (index + 1));
    }
  }

  return 0;
}

/**
 * @param {string[]} expectedSources
 * @param {string[]} rankedSources
 */
export function computeNdcgAtK(expectedSources, rankedSources) {
  const expected = new Set(expectedSources.map(normalizeSource).filter(Boolean));
  if (expected.size === 0) {
    return 1;
  }

  const ranked = rankedSources.map(normalizeSource);
  const k = Math.max(1, ranked.length);
  let dcg = 0;

  for (let index = 0; index < Math.min(k, ranked.length); index += 1) {
    const relevant = expected.has(ranked[index]) ? 1 : 0;
    const gain = Math.pow(2, relevant) - 1;
    const discount = Math.log2(index + 2);
    dcg += gain / discount;
  }

  const idealRelevant = Math.min(expected.size, k);
  let idcg = 0;
  for (let index = 0; index < idealRelevant; index += 1) {
    const gain = Math.pow(2, 1) - 1;
    const discount = Math.log2(index + 2);
    idcg += gain / discount;
  }

  if (idcg === 0) {
    return 1;
  }

  return round(dcg / idcg);
}

/**
 * @param {number[]} values
 * @param {number} percentile
 */
function percentile(values, percentile) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const normalized = Math.max(0, Math.min(100, percentile));
  const index = Math.ceil((normalized / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

/**
 * @param {number[]} values
 */
function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * @param {RetrievalGateThresholdsInput} [input]
 */
export function normalizeRetrievalGateThresholds(input = {}) {
  return {
    minCasePassRate: Math.max(0, Math.min(1, toFiniteNumber(input.minCasePassRate ?? 0.9))),
    minRecallAtK: Math.max(0, Math.min(1, toFiniteNumber(input.minRecallAtK ?? 0.7))),
    minMrr: Math.max(0, Math.min(1, toFiniteNumber(input.minMrr ?? 0.55))),
    minNdcgAtK: Math.max(0, Math.min(1, toFiniteNumber(input.minNdcgAtK ?? 0.65))),
    maxErrorRate: Math.max(0, Math.min(1, toFiniteNumber(input.maxErrorRate ?? 0.05))),
    maxP95LatencyMs: Math.max(100, Math.round(toFiniteNumber(input.maxP95LatencyMs ?? 1800)))
  };
}

/**
 * @param {{
 *   cases: RetrievalCaseInput[],
 *   thresholds?: RetrievalGateThresholdsInput
 * }} input
 */
export function evaluateRetrievalFirstGate(input) {
  const thresholds = normalizeRetrievalGateThresholds(input.thresholds);
  const normalizedCases = Array.isArray(input.cases) ? input.cases : [];
  const cases = normalizedCases.map((entry) => {
    const recallAtK = computeRecallAtK(entry.expectedSources, entry.rankedSources);
    const mrr = computeMrr(entry.expectedSources, entry.rankedSources);
    const ndcgAtK = computeNdcgAtK(entry.expectedSources, entry.rankedSources);
    const latencyMs = Math.max(0, Math.round(toFiniteNumber(entry.latencyMs)));
    const error = String(entry.error ?? "").trim();
    const retrievedChunks = Math.max(0, Math.round(toFiniteNumber(entry.retrievedChunks)));
    const passed =
      !error &&
      recallAtK >= thresholds.minRecallAtK &&
      mrr >= thresholds.minMrr &&
      ndcgAtK >= thresholds.minNdcgAtK;

    return {
      name: entry.name,
      endpoint: entry.endpoint,
      expectedSources: entry.expectedSources,
      rankedSources: entry.rankedSources,
      recallAtK,
      mrr,
      ndcgAtK,
      latencyMs,
      retrievedChunks,
      error,
      passed
    };
  });

  const casePassRate = cases.length
    ? cases.filter((entry) => entry.passed).length / cases.length
    : 1;
  const avgRecallAtK = average(cases.map((entry) => entry.recallAtK));
  const avgMrr = average(cases.map((entry) => entry.mrr));
  const avgNdcgAtK = average(cases.map((entry) => entry.ndcgAtK));
  const p95LatencyMs = percentile(cases.map((entry) => entry.latencyMs), 95);
  const errorRate = cases.length
    ? cases.filter((entry) => Boolean(entry.error)).length / cases.length
    : 0;

  const checks = [
    {
      id: "min-case-pass-rate",
      passed: casePassRate >= thresholds.minCasePassRate,
      detail: `casePassRate=${round(casePassRate)} (required >= ${round(thresholds.minCasePassRate)})`
    },
    {
      id: "min-recall-at-k",
      passed: avgRecallAtK >= thresholds.minRecallAtK,
      detail: `avgRecallAtK=${round(avgRecallAtK)} (required >= ${round(thresholds.minRecallAtK)})`
    },
    {
      id: "min-mrr",
      passed: avgMrr >= thresholds.minMrr,
      detail: `avgMrr=${round(avgMrr)} (required >= ${round(thresholds.minMrr)})`
    },
    {
      id: "min-ndcg-at-k",
      passed: avgNdcgAtK >= thresholds.minNdcgAtK,
      detail: `avgNdcgAtK=${round(avgNdcgAtK)} (required >= ${round(thresholds.minNdcgAtK)})`
    },
    {
      id: "max-error-rate",
      passed: errorRate <= thresholds.maxErrorRate,
      detail: `errorRate=${round(errorRate)} (required <= ${round(thresholds.maxErrorRate)})`
    },
    {
      id: "max-p95-latency",
      passed: p95LatencyMs <= thresholds.maxP95LatencyMs,
      detail: `p95LatencyMs=${p95LatencyMs} (required <= ${thresholds.maxP95LatencyMs})`
    }
  ];

  const failures = checks.filter((check) => !check.passed).map((check) => check.detail);

  return {
    passed: failures.length === 0,
    thresholds,
    checks,
    failures,
    summary: {
      cases: cases.length,
      casePassRate: round(casePassRate),
      avgRecallAtK: round(avgRecallAtK),
      avgMrr: round(avgMrr),
      avgNdcgAtK: round(avgNdcgAtK),
      errorRate: round(errorRate),
      p95LatencyMs
    },
    cases
  };
}

/**
 * @param {ReturnType<typeof evaluateRetrievalFirstGate>} report
 */
export function formatRetrievalFirstGateReport(report) {
  const lines = [
    "Retrieval-first gate:",
    `- passed: ${report.passed ? "yes" : "no"}`,
    `- cases: ${report.summary.cases}`,
    `- case pass rate: ${report.summary.casePassRate}`,
    `- avg Recall@k: ${report.summary.avgRecallAtK}`,
    `- avg MRR: ${report.summary.avgMrr}`,
    `- avg nDCG@k: ${report.summary.avgNdcgAtK}`,
    `- error rate: ${report.summary.errorRate}`,
    `- p95 latency (ms): ${report.summary.p95LatencyMs}`,
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
      `- ${entry.passed ? "PASS" : "FAIL"} ${entry.name} (${entry.endpoint}) recall=${entry.recallAtK} mrr=${entry.mrr} ndcg=${entry.ndcgAtK} latency=${entry.latencyMs}ms error=${entry.error || "none"}`
    );
  }

  return lines.join("\n");
}


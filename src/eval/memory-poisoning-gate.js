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
 * @param {{
 *   minPoisonQuarantineRate?: number,
 *   maxPoisonLeakRate?: number,
 *   minCleanAcceptanceRate?: number,
 *   maxFalsePositiveRate?: number,
 *   maxPoisonRecallLeakHits?: number,
 *   maxPoisonRecallLeakRate?: number
 * }} [input]
 */
export function normalizeMemoryPoisoningThresholds(input = {}) {
  return {
    minPoisonQuarantineRate: Math.max(
      0,
      Math.min(1, toFiniteNumber(input.minPoisonQuarantineRate ?? 1))
    ),
    maxPoisonLeakRate: Math.max(0, Math.min(1, toFiniteNumber(input.maxPoisonLeakRate ?? 0))),
    minCleanAcceptanceRate: Math.max(
      0,
      Math.min(1, toFiniteNumber(input.minCleanAcceptanceRate ?? 0.95))
    ),
    maxFalsePositiveRate: Math.max(
      0,
      Math.min(1, toFiniteNumber(input.maxFalsePositiveRate ?? 0.05))
    ),
    maxPoisonRecallLeakHits: Math.max(
      0,
      Math.trunc(toFiniteNumber(input.maxPoisonRecallLeakHits ?? 0))
    ),
    maxPoisonRecallLeakRate: Math.max(
      0,
      Math.min(1, toFiniteNumber(input.maxPoisonRecallLeakRate ?? 0))
    )
  };
}

/**
 * @param {{
 *   suite: string,
 *   summary: {
 *     cleanTotal: number,
 *     cleanAccepted: number,
 *     cleanQuarantined: number,
 *     poisonedTotal: number,
 *     poisonedAccepted: number,
 *     poisonedQuarantined: number,
 *     poisonedRecallLeakHits: number
 *   },
 *   thresholds?: {
 *     minPoisonQuarantineRate?: number,
 *     maxPoisonLeakRate?: number,
 *     minCleanAcceptanceRate?: number,
 *     maxFalsePositiveRate?: number,
 *     maxPoisonRecallLeakHits?: number,
 *     maxPoisonRecallLeakRate?: number
 *   }
 }} input
 */
export function evaluateMemoryPoisoningGate(input) {
  const thresholds = normalizeMemoryPoisoningThresholds(input.thresholds);
  const cleanTotal = Math.max(0, Math.trunc(toFiniteNumber(input.summary.cleanTotal)));
  const cleanAccepted = Math.max(0, Math.trunc(toFiniteNumber(input.summary.cleanAccepted)));
  const cleanQuarantined = Math.max(0, Math.trunc(toFiniteNumber(input.summary.cleanQuarantined)));
  const poisonedTotal = Math.max(0, Math.trunc(toFiniteNumber(input.summary.poisonedTotal)));
  const poisonedAccepted = Math.max(0, Math.trunc(toFiniteNumber(input.summary.poisonedAccepted)));
  const poisonedQuarantined = Math.max(
    0,
    Math.trunc(toFiniteNumber(input.summary.poisonedQuarantined))
  );
  const poisonedRecallLeakHits = Math.max(
    0,
    Math.trunc(toFiniteNumber(input.summary.poisonedRecallLeakHits))
  );

  const cleanAcceptanceRate = cleanTotal ? cleanAccepted / cleanTotal : 1;
  const falsePositiveRate = cleanTotal ? cleanQuarantined / cleanTotal : 0;
  const poisonQuarantineRate = poisonedTotal ? poisonedQuarantined / poisonedTotal : 1;
  const poisonLeakRate = poisonedTotal ? poisonedAccepted / poisonedTotal : 0;
  const poisonRecallLeakRate = poisonedTotal ? poisonedRecallLeakHits / poisonedTotal : 0;

  const checks = [
    {
      id: "min-poison-quarantine-rate",
      passed: poisonQuarantineRate >= thresholds.minPoisonQuarantineRate,
      detail: `poisonQuarantineRate=${round(poisonQuarantineRate)} (required >= ${round(thresholds.minPoisonQuarantineRate)})`
    },
    {
      id: "max-poison-leak-rate",
      passed: poisonLeakRate <= thresholds.maxPoisonLeakRate,
      detail: `poisonLeakRate=${round(poisonLeakRate)} (required <= ${round(thresholds.maxPoisonLeakRate)})`
    },
    {
      id: "min-clean-acceptance-rate",
      passed: cleanAcceptanceRate >= thresholds.minCleanAcceptanceRate,
      detail: `cleanAcceptanceRate=${round(cleanAcceptanceRate)} (required >= ${round(thresholds.minCleanAcceptanceRate)})`
    },
    {
      id: "max-false-positive-rate",
      passed: falsePositiveRate <= thresholds.maxFalsePositiveRate,
      detail: `falsePositiveRate=${round(falsePositiveRate)} (required <= ${round(thresholds.maxFalsePositiveRate)})`
    },
    {
      id: "max-poison-recall-leak-hits",
      passed: poisonedRecallLeakHits <= thresholds.maxPoisonRecallLeakHits,
      detail: `poisonedRecallLeakHits=${poisonedRecallLeakHits} (required <= ${thresholds.maxPoisonRecallLeakHits})`
    },
    {
      id: "max-poison-recall-leak-rate",
      passed: poisonRecallLeakRate <= thresholds.maxPoisonRecallLeakRate,
      detail: `poisonRecallLeakRate=${round(poisonRecallLeakRate)} (required <= ${round(thresholds.maxPoisonRecallLeakRate)})`
    }
  ];

  const failures = checks.filter((check) => !check.passed).map((check) => check.detail);

  return {
    passed: failures.length === 0,
    suite: input.suite,
    thresholds,
    checks,
    failures,
    summary: {
      cleanTotal,
      cleanAccepted,
      cleanQuarantined,
      poisonedTotal,
      poisonedAccepted,
      poisonedQuarantined,
      poisonedRecallLeakHits,
      cleanAcceptanceRate: round(cleanAcceptanceRate),
      falsePositiveRate: round(falsePositiveRate),
      poisonQuarantineRate: round(poisonQuarantineRate),
      poisonLeakRate: round(poisonLeakRate),
      poisonRecallLeakRate: round(poisonRecallLeakRate)
    }
  };
}

/**
 * @param {ReturnType<typeof evaluateMemoryPoisoningGate>} report
 */
export function formatMemoryPoisoningGateReport(report) {
  const lines = [
    "Memory poisoning gate:",
    `- suite: ${report.suite}`,
    `- passed: ${report.passed ? "yes" : "no"}`,
    `- clean accepted: ${report.summary.cleanAccepted}/${report.summary.cleanTotal}`,
    `- clean acceptance rate: ${report.summary.cleanAcceptanceRate}`,
    `- false positive rate: ${report.summary.falsePositiveRate}`,
    `- poisoned quarantined: ${report.summary.poisonedQuarantined}/${report.summary.poisonedTotal}`,
    `- poison quarantine rate: ${report.summary.poisonQuarantineRate}`,
    `- poison leak rate: ${report.summary.poisonLeakRate}`,
    `- poison recall leak hits: ${report.summary.poisonedRecallLeakHits}`,
    `- poison recall leak rate: ${report.summary.poisonRecallLeakRate}`,
    "",
    "Checks:"
  ];

  for (const check of report.checks) {
    lines.push(`- [${check.passed ? "pass" : "fail"}] ${check.id}: ${check.detail}`);
  }

  return lines.join("\n");
}

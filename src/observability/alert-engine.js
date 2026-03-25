// @ts-check

/**
 * @param {unknown} value
 */
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * NEXUS:8 — evaluate observability report and return alert status.
 * @param {{
 *   totals?: {
 *     blockedRate?: number,
 *     degradedRate?: number,
 *     averageDurationMs?: number,
 *     runs?: number
 *   },
 *   recall?: {
 *     hitRate?: number,
 *     attempts?: number
 *   }
 * }} report
 * @param {{
 *   blockedRateMax?: number,
 *   degradedRateMax?: number,
 *   recallHitRateMin?: number,
 *   averageDurationMsMax?: number,
 *   minRuns?: number
 * }} [thresholds]
 */
export function evaluateObservabilityAlerts(report, thresholds = {}) {
  const limits = {
    blockedRateMax: finite(thresholds.blockedRateMax || 0.25),
    degradedRateMax: finite(thresholds.degradedRateMax || 0.35),
    recallHitRateMin: finite(thresholds.recallHitRateMin || 0.15),
    averageDurationMsMax: finite(thresholds.averageDurationMsMax || 1500),
    minRuns: Math.max(0, Math.trunc(finite(thresholds.minRuns || 20)))
  };

  const blockedRate = finite(report?.totals?.blockedRate);
  const degradedRate = finite(report?.totals?.degradedRate);
  const recallHitRate = finite(report?.recall?.hitRate);
  const averageDurationMs = finite(report?.totals?.averageDurationMs);
  const runs = Math.max(0, Math.trunc(finite(report?.totals?.runs)));

  const checks = [
    {
      id: "min-runs",
      pass: runs >= limits.minRuns,
      value: runs,
      threshold: limits.minRuns,
      comparator: ">="
    },
    {
      id: "blocked-rate",
      pass: blockedRate <= limits.blockedRateMax,
      value: blockedRate,
      threshold: limits.blockedRateMax,
      comparator: "<="
    },
    {
      id: "degraded-rate",
      pass: degradedRate <= limits.degradedRateMax,
      value: degradedRate,
      threshold: limits.degradedRateMax,
      comparator: "<="
    },
    {
      id: "recall-hit-rate",
      pass: recallHitRate >= limits.recallHitRateMin,
      value: recallHitRate,
      threshold: limits.recallHitRateMin,
      comparator: ">="
    },
    {
      id: "average-duration-ms",
      pass: averageDurationMs <= limits.averageDurationMsMax,
      value: averageDurationMs,
      threshold: limits.averageDurationMsMax,
      comparator: "<="
    }
  ];

  const failed = checks.filter((check) => !check.pass);

  return {
    status: failed.length ? "alert" : "ok",
    checks,
    failed,
    thresholds: limits,
    metrics: {
      runs,
      blockedRate,
      degradedRate,
      recallHitRate,
      averageDurationMs
    }
  };
}

/**
 * @param {ReturnType<typeof evaluateObservabilityAlerts>} report
 */
export function formatObservabilityAlertReport(report) {
  const lines = [`Observability alerts: ${report.status.toUpperCase()}`, ""];

  for (const check of report.checks) {
    lines.push(
      `- ${check.id}: ${check.value} ${check.comparator} ${check.threshold} -> ${check.pass ? "PASS" : "FAIL"}`
    );
  }

  if (report.failed.length) {
    lines.push("");
    lines.push("Failed checks:");
    for (const check of report.failed) {
      lines.push(`- ${check.id}`);
    }
  }

  return lines.join("\n");
}
// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").MetricsSnapshot} MetricsSnapshot
 * @typedef {import("../types/core-contracts.d.ts").AlertRule} AlertRule
 * @typedef {import("../types/core-contracts.d.ts").RequestTrace} RequestTrace
 */

/**
 * @typedef {{
 *   timestamp: number,
 *   command: string,
 *   durationMs: number,
 *   outcome: "success" | "degraded" | "blocked" | "error",
 *   errorLayer?: string
 * }} RequestRecord
 */

const WINDOW_MS = 5 * 60 * 1000;

/** @type {RequestRecord[]} */
const records = [];

/** @type {AlertRule[]} */
const alertRules = [];

let serverStartMs = Date.now();

// ── Recording ────────────────────────────────────────────────────────

/**
 * @param {RequestTrace} trace
 */
export function recordRequest(trace) {
  /** @type {RequestRecord} */
  const record = {
    timestamp: Date.now(),
    command: trace.command,
    durationMs: trace.durationMs,
    outcome: trace.outcome,
    errorLayer: trace.error ? (trace.layers.at(-1)?.name ?? "unknown") : undefined
  };

  records.push(record);
  pruneOldRecords();
  evaluateAlerts();
}

function pruneOldRecords() {
  const cutoff = Date.now() - WINDOW_MS;
  while (records.length > 0 && records[0].timestamp < cutoff) {
    records.shift();
  }
}

// ── Snapshot ─────────────────────────────────────────────────────────

/**
 * @returns {MetricsSnapshot}
 */
export function getMetricsSnapshot() {
  pruneOldRecords();

  const now = Date.now();
  const windowRecords = records.filter((r) => r.timestamp >= now - WINDOW_MS);
  const windowMinutes = Math.max(1, WINDOW_MS / 60_000);

  /** @type {Record<string, number>} */
  const byCommand = {};
  for (const r of windowRecords) {
    byCommand[r.command] = (byCommand[r.command] ?? 0) + 1;
  }

  const durations = windowRecords.map((r) => r.durationMs).sort((a, b) => a - b);

  const errorRecords = windowRecords.filter((r) => r.outcome === "error");
  /** @type {Record<string, number>} */
  const errorsByLayer = {};
  for (const r of errorRecords) {
    const layer = r.errorLayer ?? "unknown";
    errorsByLayer[layer] = (errorsByLayer[layer] ?? 0) + 1;
  }

  const blockedCount = windowRecords.filter((r) => r.outcome === "blocked").length;

  return {
    timestamp: new Date().toISOString(),
    uptime: Math.round((now - serverStartMs) / 1000),
    requests: {
      total: windowRecords.length,
      perMinute: round(windowRecords.length / windowMinutes),
      byCommand
    },
    latency: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      average: round(
        durations.length > 0
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : 0
      )
    },
    recall: {
      hitRate: 0,
      avgChunksReturned: 0
    },
    errors: {
      total: errorRecords.length,
      rate: round(windowRecords.length > 0 ? errorRecords.length / windowRecords.length : 0),
      byLayer: errorsByLayer
    },
    guard: {
      blocked: blockedCount,
      blockRate: round(windowRecords.length > 0 ? blockedCount / windowRecords.length : 0)
    }
  };
}

// ── Percentile ───────────────────────────────────────────────────────

/**
 * @param {number[]} sorted
 * @param {number} p
 * @returns {number}
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * @param {number} n
 * @returns {number}
 */
function round(n) {
  return Math.round(n * 1000) / 1000;
}

// ── Alerting ─────────────────────────────────────────────────────────

/**
 * @param {AlertRule} rule
 */
export function registerAlertRule(rule) {
  alertRules.push(rule);
}

/**
 * @returns {AlertRule[]}
 */
export function listAlertRules() {
  return [...alertRules];
}

function evaluateAlerts() {
  const snapshot = getMetricsSnapshot();

  for (const rule of alertRules) {
    let currentValue = 0;

    switch (rule.condition) {
      case "error_rate_above":
        currentValue = snapshot.errors.rate;
        break;
      case "latency_above":
        currentValue = snapshot.latency.p95;
        break;
      case "block_rate_above":
        currentValue = snapshot.guard.blockRate;
        break;
    }

    if (currentValue > rule.threshold) {
      fireAlert(rule, currentValue);
    }
  }
}

/**
 * @param {AlertRule} rule
 * @param {number} currentValue
 */
async function fireAlert(rule, currentValue) {
  const payload = {
    alert: rule.name,
    condition: rule.condition,
    threshold: rule.threshold,
    currentValue,
    timestamp: new Date().toISOString()
  };

  console.log(JSON.stringify({ level: "alert", ...payload }));

  if (rule.webhookUrl) {
    try {
      await fetch(rule.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch {
      // Alerting should never crash the server
    }
  }
}

export function resetMetrics() {
  records.length = 0;
  alertRules.length = 0;
  serverStartMs = Date.now();
}

/**
 * Live Metrics Collector — S6: In-memory runtime metrics.
 *
 * Collects request/latency/error data in a sliding window
 * and exposes a snapshot for the /metrics API endpoint.
 *
 * Designed for server-mode (API layer). The existing
 * metrics-store.js handles persistent file-based observability;
 * this module handles ephemeral runtime metrics.
 *
 * Features:
 *   - Sliding window (default 5 minutes) for rate calculations
 *   - Percentile latency (p50, p95, p99)
 *   - Per-command request counts
 *   - Error tracking by layer
 *   - Guard block rate
 *   - Alert rule evaluation with webhook dispatch
 */

import type { MetricsSnapshot, AlertRule, RequestTrace } from "../types/core-contracts.d.ts";

// ── Data Structures ──────────────────────────────────────────────────

interface RequestRecord {
  timestamp: number;
  command: string;
  durationMs: number;
  outcome: "success" | "degraded" | "blocked" | "error";
  errorLayer?: string;
}

const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const records: RequestRecord[] = [];
const alertRules: AlertRule[] = [];
let serverStartMs = Date.now();

// ── Recording ────────────────────────────────────────────────────────

export function recordRequest(trace: RequestTrace): void {
  const record: RequestRecord = {
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

function pruneOldRecords(): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (records.length > 0 && records[0].timestamp < cutoff) {
    records.shift();
  }
}

// ── Snapshot ─────────────────────────────────────────────────────────

export function getMetricsSnapshot(): MetricsSnapshot {
  pruneOldRecords();

  const now = Date.now();
  const windowRecords = records.filter((r) => r.timestamp >= now - WINDOW_MS);
  const windowMinutes = Math.max(1, WINDOW_MS / 60_000);

  // Per-command counts
  const byCommand: Record<string, number> = {};
  for (const r of windowRecords) {
    byCommand[r.command] = (byCommand[r.command] ?? 0) + 1;
  }

  // Latency percentiles
  const durations = windowRecords.map((r) => r.durationMs).sort((a, b) => a - b);

  // Errors by layer
  const errorRecords = windowRecords.filter((r) => r.outcome === "error");
  const errorsByLayer: Record<string, number> = {};
  for (const r of errorRecords) {
    const layer = r.errorLayer ?? "unknown";
    errorsByLayer[layer] = (errorsByLayer[layer] ?? 0) + 1;
  }

  // Guard blocks
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
      hitRate: 0, // TODO: wire from recall layer traces
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Alerting ─────────────────────────────────────────────────────────

export function registerAlertRule(rule: AlertRule): void {
  alertRules.push(rule);
}

export function listAlertRules(): AlertRule[] {
  return [...alertRules];
}

function evaluateAlerts(): void {
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

async function fireAlert(rule: AlertRule, currentValue: number): Promise<void> {
  const payload = {
    alert: rule.name,
    condition: rule.condition,
    threshold: rule.threshold,
    currentValue,
    timestamp: new Date().toISOString()
  };

  // Log to structured output
  console.log(JSON.stringify({ level: "alert", ...payload }));

  // Webhook if configured
  if (rule.webhookUrl) {
    try {
      await fetch(rule.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch {
      // Swallow — alerting should never crash the server
    }
  }
}

/** Reset metrics — useful for testing */
export function resetMetrics(): void {
  records.length = 0;
  alertRules.length = 0;
  serverStartMs = Date.now();
}

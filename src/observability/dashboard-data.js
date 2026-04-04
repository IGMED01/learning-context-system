// @ts-check

import { getObservabilityReport } from "./metrics-store.js";

/**
 * NEXUS:8 — shape dashboard-ready observability data.
 * @param {{
 *   metrics?: Awaited<ReturnType<typeof getObservabilityReport>>,
 *   includeCommandTable?: boolean,
 *   topCommands?: number,
 *   agentTraces?: Array<{ phase: string, agent: string, status: string, durationMs: number }>
 * }} [options]
 */
export async function buildDashboardData(options = {}) {
  const metrics = options.metrics ?? (await getObservabilityReport());
  const topCommands = Math.max(1, Math.trunc(options.topCommands ?? 5));

  const commandRows = [...metrics.commands]
    .sort((left, right) => right.runs - left.runs)
    .slice(0, topCommands);

  // Aggregate agent pipeline traces into observability
  const agentTraces = options.agentTraces ?? [];
  const agentStats = aggregateAgentTraces(agentTraces);

  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: metrics.schemaVersion,
    health: {
      degradedRate: metrics.totals.degradedRate,
      blockedRate: metrics.totals.blockedRate,
      averageDurationMs: metrics.totals.averageDurationMs,
      recallHitRate: metrics.recall.hitRate
    },
    totals: metrics.totals,
    recall: metrics.recall,
    selection: metrics.selection,
    safety: metrics.safety,
    commands: options.includeCommandTable === false ? [] : commandRows,
    agents: agentStats
  };
}

/**
 * Aggregate agent pipeline traces into per-agent and per-phase stats.
 * @param {Array<{ phase: string, agent: string, status: string, durationMs: number }>} traces
 */
function aggregateAgentTraces(traces) {
  if (!traces.length) {
    return { totalPhases: 0, byAgent: {}, byPhase: {} };
  }

  /** @type {Record<string, { runs: number, totalMs: number, failures: number }>} */
  const byAgent = {};
  /** @type {Record<string, { runs: number, totalMs: number, failures: number }>} */
  const byPhase = {};

  for (const t of traces) {
    // By agent
    if (!byAgent[t.agent]) byAgent[t.agent] = { runs: 0, totalMs: 0, failures: 0 };
    byAgent[t.agent].runs += 1;
    byAgent[t.agent].totalMs += t.durationMs;
    if (t.status === "failed" || t.status === "blocked") byAgent[t.agent].failures += 1;

    // By phase
    if (!byPhase[t.phase]) byPhase[t.phase] = { runs: 0, totalMs: 0, failures: 0 };
    byPhase[t.phase].runs += 1;
    byPhase[t.phase].totalMs += t.durationMs;
    if (t.status === "failed" || t.status === "blocked") byPhase[t.phase].failures += 1;
  }

  return { totalPhases: traces.length, byAgent, byPhase };
}

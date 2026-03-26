// @ts-check

import { tokenize } from "../context/noise-canceler.js";
import { loadWorkspaceChunks } from "../io/workspace-chunks.js";
import { buildLearningPacket } from "../learning/mentor-loop.js";
import { resolveAutoTeachRecall } from "../memory/engram-auto-orchestrator.js";

/**
 * @typedef {import("../contracts/vertical-benchmark-contracts.js").parseVerticalBenchmarkFile extends (...args: any[]) => infer R ? R["cases"][number] : never} VerticalComparisonCase
 */

function toPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function ratio(part, total) {
  if (!total) {
    return 1;
  }

  return part / total;
}

/**
 * @param {string} text
 */
function estimateTokens(text) {
  return tokenize(String(text ?? "")).length;
}

/**
 * @param {Array<{ kind?: string }>} chunks
 */
function summarizeKinds(chunks) {
  /** @type {Record<string, number>} */
  const counts = {};

  for (const chunk of chunks) {
    const key = String(chunk.kind ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

/**
 * @param {Array<{ source?: string }>} chunks
 */
function summarizeOrigins(chunks) {
  let workspace = 0;
  let memory = 0;

  for (const chunk of chunks) {
    if (String(chunk.source ?? "").startsWith("engram://")) {
      memory += 1;
      continue;
    }

    workspace += 1;
  }

  return {
    workspace,
    memory
  };
}

/**
 * @param {string[]} values
 */
function normalizeList(values) {
  return values.map((value) => String(value ?? "").trim()).filter(Boolean);
}

/**
 * @param {string} project
 * @param {Array<{ query: string, observationId: string, type: string, title: string, body: string, timestamp: string }>} memories
 */
function createBenchmarkSearchMemories(project, memories) {
  return async (query, options = {}) => {
    const normalizedQuery = String(query ?? "").trim();
    const matches = memories.filter((entry) => entry.query === normalizedQuery);

    if (!matches.length) {
      return {
        stdout: "No memories found for that query."
      };
    }

    const lines = [`Found ${matches.length} memories:`, ""];

    for (const [index, memory] of matches.entries()) {
      lines.push(`[${index + 1}] #${memory.observationId} (${memory.type}) — ${memory.title}`);
      lines.push(`    ${memory.body}`);
      lines.push(
        `    ${memory.timestamp} | project: ${options.project ?? project} | scope: ${options.scope ?? "project"}`
      );
    }

    return {
      stdout: lines.join("\n")
    };
  };
}

/**
 * @param {VerticalComparisonCase} entry
 */
export async function runNexusComparisonCase(entry) {
  const workspace = await loadWorkspaceChunks(entry.input.workspace);
  const searchMemories = createBenchmarkSearchMemories(
    entry.input.project,
    entry.provider.memories
  );
  const recall = await resolveAutoTeachRecall({
    task: entry.input.task,
    objective: entry.input.objective,
    focus: `${entry.input.task} ${entry.input.objective}`.trim(),
    changedFiles: entry.input.changedFiles,
    project: entry.input.project,
    explicitQuery: entry.input.recallQuery,
    noRecall: entry.input.noRecall,
    autoRecall: true,
    limit: 3,
    scope: "project",
    strictRecall: false,
    baseChunks: workspace.payload.chunks,
    searchMemories
  });
  const packet = buildLearningPacket({
    task: entry.input.task,
    objective: entry.input.objective,
    focus: `${entry.input.task} ${entry.input.objective}`.trim(),
    changedFiles: entry.input.changedFiles,
    chunks: recall.chunks,
    tokenBudget: entry.input.tokenBudget,
    maxChunks: entry.input.maxChunks,
    debug: true
  });

  const rawChunks = recall.chunks;
  const rawTokens = rawChunks.reduce((total, chunk) => total + estimateTokens(chunk.content), 0);
  const selectedChunks = packet.selectedContext.length;
  const selectedTokens = packet.diagnostics.usedTokens;
  const suppressedChunks = packet.suppressedContext.length;
  const suppressedTokens = Math.max(0, rawTokens - selectedTokens);
  const selectedSources = packet.selectedContext.map((chunk) => chunk.source);
  const selectedMemoryChunks = packet.selectedContext.filter((chunk) =>
    String(chunk.source ?? "").startsWith("engram://")
  ).length;
  const suppressedMemoryChunks = packet.suppressedContext.filter((chunk) =>
    String(chunk.source ?? "").startsWith("engram://") ||
    String(chunk.id ?? "").startsWith("engram-memory-")
  ).length;
  const recoveredMemoryChunks = recall.memoryRecall.recoveredChunks;
  const memoryRetentionRate =
    recoveredMemoryChunks > 0 ? selectedMemoryChunks / recoveredMemoryChunks : 1;
  const codeFocusPass = packet.teachingSections.codeFocus?.source === entry.expectations.codeFocus;
  const relatedTestPass =
    packet.teachingSections.relatedTests?.[0]?.source === entry.expectations.relatedTest;
  const noiseExclusionPass = entry.expectations.excludedSources.every(
    (source) => !selectedSources.includes(source)
  );
  const memoryBehaviorPass =
    recall.memoryRecall.status === entry.expectations.memoryRecallStatus &&
    selectedMemoryChunks === entry.expectations.selectedMemoryChunks &&
    suppressedMemoryChunks === entry.expectations.suppressedMemoryChunks;
  const qualityPass =
    codeFocusPass && relatedTestPass && noiseExclusionPass && memoryBehaviorPass;

  return {
    name: entry.name,
    workspace: entry.input.workspace,
    task: entry.input.task,
    objective: entry.input.objective,
    tokenBudget: entry.input.tokenBudget,
    maxChunks: entry.input.maxChunks,
    withoutNexus: {
      chunks: rawChunks.length,
      tokens: rawTokens,
      origins: summarizeOrigins(rawChunks),
      kinds: summarizeKinds(rawChunks),
      overTokenBudget: rawTokens > entry.input.tokenBudget,
      overChunkBudget: rawChunks.length > entry.input.maxChunks
    },
    withNexus: {
      chunks: selectedChunks,
      tokens: selectedTokens,
      suppressedChunks,
      suppressedTokens,
      origins: summarizeOrigins(packet.selectedContext),
      kinds: summarizeKinds(packet.selectedContext),
      selectedSources
    },
    savings: {
      chunks: Math.max(0, rawChunks.length - selectedChunks),
      tokens: suppressedTokens,
      percent: rawTokens > 0 ? round((suppressedTokens / rawTokens) * 100) : 0
    },
    memory: {
      status: recall.memoryRecall.status,
      recoveredChunks: recoveredMemoryChunks,
      selectedChunks: selectedMemoryChunks,
      suppressedChunks: suppressedMemoryChunks,
      retentionRate: round(memoryRetentionRate * 100) / 100
    },
    quality: {
      pass: qualityPass,
      codeFocusPass,
      relatedTestPass,
      noiseExclusionPass,
      memoryBehaviorPass
    }
  };
}

/**
 * @param {VerticalComparisonCase[]} cases
 */
export async function runNexusComparisonSuite(cases) {
  const results = [];

  for (const entry of cases) {
    results.push(await runNexusComparisonCase(entry));
  }

  const avgRawChunks = average(results.map((result) => result.withoutNexus.chunks));
  const avgSelectedChunks = average(results.map((result) => result.withNexus.chunks));
  const avgRawTokens = average(results.map((result) => result.withoutNexus.tokens));
  const avgSelectedTokens = average(results.map((result) => result.withNexus.tokens));
  const avgTokenSavingsPercent = average(results.map((result) => result.savings.percent));
  const avgChunkSavingsPercent = average(
    results.map((result) =>
      result.withoutNexus.chunks > 0
        ? ((result.withoutNexus.chunks - result.withNexus.chunks) / result.withoutNexus.chunks) * 100
        : 0
    )
  );
  const overflowWithoutNexusRate = ratio(
    results.filter((result) => result.withoutNexus.overTokenBudget || result.withoutNexus.overChunkBudget)
      .length,
    results.length
  );
  const memoryCases = results.filter((result) => result.memory.recoveredChunks > 0);
  const avgMemoryRetentionRate = memoryCases.length
    ? average(memoryCases.map((result) => result.memory.retentionRate))
    : 1;
  const qualityPassRate = ratio(
    results.filter((result) => result.quality.pass).length,
    results.length
  );

  /** @type {string[]} */
  const improvements = [];

  if (overflowWithoutNexusRate >= 0.5) {
    improvements.push(
      "Priorizar visibilidad operativa de `impact` en UI/API: la mayoría de los casos sin NEXUS exceden presupuesto."
    );
  }

  if (avgSelectedTokens >= average(results.map((result) => result.tokenBudget)) * 0.9) {
    improvements.push(
      "Evaluar compresión jerárquica adicional: el contexto seleccionado queda demasiado cerca del presupuesto."
    );
  }

  if (avgMemoryRetentionRate < 0.8) {
    improvements.push(
      "Revisar `recallReserveRatio` y `recallBoost`: la memoria útil no está reteniéndose lo suficiente."
    );
  }

  if (results.length < 4) {
    improvements.push(
      "Ampliar el corpus comparativo: agregar casos del repo NEXUS real y del sitio del hackathon para medir valor fuera del vertical TypeScript."
    );
  }

  return {
    status: qualityPassRate === 1 ? "ok" : "warn",
    summary: {
      cases: results.length,
      avgRawChunks: round(avgRawChunks),
      avgSelectedChunks: round(avgSelectedChunks),
      avgRawTokens: round(avgRawTokens),
      avgSelectedTokens: round(avgSelectedTokens),
      avgChunkSavingsPercent: round(avgChunkSavingsPercent),
      avgTokenSavingsPercent: round(avgTokenSavingsPercent),
      overflowWithoutNexusRate: round(overflowWithoutNexusRate * 100) / 100,
      avgMemoryRetentionRate: round(avgMemoryRetentionRate * 100) / 100,
      qualityPassRate: round(qualityPassRate * 100) / 100
    },
    improvements,
    results
  };
}

/**
 * @param {Awaited<ReturnType<typeof runNexusComparisonSuite>>} report
 */
export function formatNexusComparisonReport(report) {
  const lines = ["# NEXUS vs raw-context benchmark", ""];

  for (const result of report.results) {
    lines.push(`- ${result.quality.pass ? "PASS" : "WARN"} ${result.name}`);
    lines.push(`  workspace: ${result.workspace}`);
    lines.push(
      `  withoutNexus: ${result.withoutNexus.chunks} chunks / ${result.withoutNexus.tokens} tokens / memory=${result.withoutNexus.origins.memory}`
    );
    lines.push(
      `  withNexus: ${result.withNexus.chunks} chunks / ${result.withNexus.tokens} tokens / memory=${result.withNexus.origins.memory}`
    );
    lines.push(
      `  savings: ${result.savings.chunks} chunks / ${result.savings.tokens} tokens / ${result.savings.percent}%`
    );
    lines.push(
      `  memory: status=${result.memory.status} recovered=${result.memory.recoveredChunks} selected=${result.memory.selectedChunks} suppressed=${result.memory.suppressedChunks}`
    );
    lines.push(
      `  quality: code=${result.quality.codeFocusPass ? "yes" : "no"} test=${result.quality.relatedTestPass ? "yes" : "no"} noise=${result.quality.noiseExclusionPass ? "yes" : "no"} memory=${result.quality.memoryBehaviorPass ? "yes" : "no"}`
    );
    lines.push("");
  }

  lines.push("## Summary");
  lines.push(`- Cases: ${report.summary.cases}`);
  lines.push(`- Avg raw chunks: ${report.summary.avgRawChunks}`);
  lines.push(`- Avg NEXUS chunks: ${report.summary.avgSelectedChunks}`);
  lines.push(`- Avg raw tokens: ${report.summary.avgRawTokens}`);
  lines.push(`- Avg NEXUS tokens: ${report.summary.avgSelectedTokens}`);
  lines.push(`- Avg chunk savings: ${toPercent(report.summary.avgChunkSavingsPercent / 100)}`);
  lines.push(`- Avg token savings: ${toPercent(report.summary.avgTokenSavingsPercent / 100)}`);
  lines.push(
    `- Cases overflowing without NEXUS: ${toPercent(report.summary.overflowWithoutNexusRate)}`
  );
  lines.push(
    `- Avg memory retention: ${toPercent(report.summary.avgMemoryRetentionRate)}`
  );
  lines.push(`- Quality pass rate: ${toPercent(report.summary.qualityPassRate)}`);

  if (report.improvements.length > 0) {
    lines.push("");
    lines.push("## Improvement signals");
    for (const improvement of normalizeList(report.improvements)) {
      lines.push(`- ${improvement}`);
    }
  }

  return lines.join("\n");
}

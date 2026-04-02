// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseRecallBenchmarkFile } from "../src/contracts/recall-benchmark-contracts.js";
import { resolveTeachRecall } from "../src/memory/teach-recall.js";

function toPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
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

function normalizeText(text = "") {
  return String(text)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function terms(text = "") {
  return normalizeText(text).split(/\s+/u).filter(Boolean);
}

function buildSearchOutput(rules, query, fallbackProject = "") {
  if (!rules.length) {
    return "No memories found for that query.";
  }

  const lines = [`Found ${rules.length} memories:`, ""];

  for (const [index, rule] of rules.entries()) {
    lines.push(`[${index + 1}] #${rule.observationId} (${rule.type}) — ${rule.title}`);
    lines.push(`    ${rule.body}`);
    lines.push(
      `    ${rule.timestamp} | project: ${rule.project || fallbackProject || "global"} | scope: ${rule.scope}`
    );
  }

  return lines.join("\n");
}

function toIsoTimestamp(value) {
  const parsed = new Date(String(value ?? "").replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) {
    return new Date("2026-03-17T00:00:00.000Z").toISOString();
  }
  return parsed.toISOString();
}

function ruleMatchesQuery(rule, query) {
  const queryTerms = terms(query);
  const requiresAll = rule.requiresAll ?? [];
  const requiresAny = rule.requiresAny ?? [];

  const allOk = requiresAll.every((term) => queryTerms.includes(normalizeText(term)));
  const anyOk =
    !requiresAny.length || requiresAny.some((term) => queryTerms.includes(normalizeText(term)));

  return allOk && anyOk;
}

async function runCase(entry) {
  const seenQueries = [];
  const result = await resolveTeachRecall({
    task: entry.input.task,
    objective: entry.input.objective,
    focus: entry.input.focus,
    changedFiles: entry.input.changedFiles,
    project: entry.input.project,
    explicitQuery: entry.input.explicitQuery,
    limit: entry.input.limit,
    strictRecall: entry.input.strictRecall,
    baseChunks: entry.input.baseChunks,
    async search(query) {
      seenQueries.push(query);

      if (entry.provider.failMessage) {
        throw new Error(entry.provider.failMessage);
      }

      const matches = entry.provider.rules.filter((rule) => ruleMatchesQuery(rule, query));
      const entries = matches.map((rule) => ({
        id: rule.observationId
          ? rule.observationId.startsWith("engram-memory-")
            ? rule.observationId
            : `engram-memory-${rule.observationId}`
          : `benchmark-${normalizeText(rule.title).replace(/\s+/g, "-") || "memory"}`,
        title: rule.title,
        content: rule.body,
        type: rule.type,
        project: rule.project || entry.input.project || "global",
        scope: rule.scope || "project",
        topic: "",
        createdAt: toIsoTimestamp(rule.timestamp)
      }));
      return {
        entries,
        provider: "benchmark-mock",
        providerChain: ["benchmark-mock"],
        stdout: buildSearchOutput(matches, query, entry.input.project)
      };
    }
  });

  const recoveredIds = result.memoryRecall.recoveredMemoryIds ?? [];
  const requiredHits = entry.expectations.recoveredIds.filter((id) => recoveredIds.includes(id)).length;
  const requiredRecall = ratio(requiredHits, entry.expectations.recoveredIds.length);
  const exactChunkPass =
    entry.expectations.exactRecoveredChunks === -1 ||
    result.memoryRecall.recoveredChunks === entry.expectations.exactRecoveredChunks;
  const statusPass = result.memoryRecall.status === entry.expectations.status;
  const minRecoveredPass = result.memoryRecall.recoveredChunks >= entry.expectations.minRecoveredChunks;
  const queryLimitPass = result.memoryRecall.queriesTried.length <= entry.expectations.maxQueriesTried;
  const firstMatchPass =
    result.memoryRecall.status !== "recalled" ||
    result.memoryRecall.firstMatchIndex <= entry.expectations.maxFirstMatchIndex;
  const pass =
    statusPass && minRecoveredPass && exactChunkPass && queryLimitPass && firstMatchPass && requiredRecall === 1;

  const queryEfficiency =
    result.memoryRecall.status !== "recalled"
      ? 1
      : ratio(1, Math.max(1, result.memoryRecall.firstMatchIndex + 1));

  return {
    name: entry.name,
    pass,
    status: result.memoryRecall.status,
    recoveredIds,
    queriesTried: result.memoryRecall.queriesTried,
    firstMatchIndex: result.memoryRecall.firstMatchIndex,
    statusPass,
    requiredRecall,
    queryLimitPass,
    firstMatchPass,
    exactChunkPass,
    queryEfficiency
  };
}

function formatCase(result) {
  return [
    `- ${result.pass ? "PASS" : "FAIL"} ${result.name}`,
    `  status: ${result.status}`,
    `  recoveredIds: ${result.recoveredIds.join(", ") || "none"}`,
    `  queriesTried: ${result.queriesTried.join(" | ") || "none"}`,
    `  firstMatchIndex: ${result.firstMatchIndex}`,
    `  requiredRecall: ${toPercent(result.requiredRecall)}`,
    `  queryEfficiency: ${toPercent(result.queryEfficiency)}`,
    `  queryLimitPass: ${result.queryLimitPass ? "yes" : "no"}`,
    `  firstMatchPass: ${result.firstMatchPass ? "yes" : "no"}`,
    `  exactChunkPass: ${result.exactChunkPass ? "yes" : "no"}`
  ].join("\n");
}

async function main() {
  const benchmarkPath = path.resolve("benchmark/recall-benchmark.json");
  const raw = await readFile(benchmarkPath, "utf8");
  const payload = parseRecallBenchmarkFile(raw, benchmarkPath);
  const results = [];

  for (const entry of payload.cases) {
    results.push(await runCase(entry));
  }

  console.log("# Recall Benchmark");
  console.log("");

  for (const result of results) {
    console.log(formatCase(result));
    console.log("");
  }

  const summary = {
    passRate: ratio(results.filter((result) => result.pass).length, results.length),
    avgRequiredRecall: average(results.map((result) => result.requiredRecall)),
    avgQueryEfficiency: average(results.map((result) => result.queryEfficiency)),
    queryLimitPassRate: ratio(results.filter((result) => result.queryLimitPass).length, results.length),
    firstMatchPassRate: ratio(results.filter((result) => result.firstMatchPass).length, results.length)
  };

  console.log("## Summary");
  console.log(`- Cases: ${results.length}`);
  console.log(`- Pass rate: ${toPercent(summary.passRate)}`);
  console.log(`- Avg required recall: ${toPercent(summary.avgRequiredRecall)}`);
  console.log(`- Avg query efficiency: ${toPercent(summary.avgQueryEfficiency)}`);
  console.log(`- Query-limit pass rate: ${toPercent(summary.queryLimitPassRate)}`);
  console.log(`- First-match pass rate: ${toPercent(summary.firstMatchPassRate)}`);

  if (summary.passRate < 1) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

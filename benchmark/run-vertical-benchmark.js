// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";

import { runCli } from "../src/cli/app.js";
import { parseVerticalBenchmarkFile } from "../src/contracts/vertical-benchmark-contracts.js";

function toPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function ratio(part, total) {
  if (!total) {
    return 1;
  }

  return part / total;
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function buildMemoryStdout(memory, project) {
  return [
    "Found 1 memories:",
    "",
    `[1] #${memory.observationId} (${memory.type}) — ${memory.title}`,
    `    ${memory.body}`,
    `    ${memory.timestamp} | project: ${project} | scope: project`
  ].join("\n");
}

function createFakeEngramClient(provider, project) {
  return {
    async recallContext() {
      return {
        mode: "context",
        project,
        query: "",
        stdout: "No previous session memories found.",
        dataDir: ".engram"
      };
    },
    async searchMemories(query, options) {
      const memory = provider.memories.find((item) => item.query === query);

      return {
        mode: "search",
        project: options?.project ?? project,
        query,
        type: options?.type ?? "",
        scope: options?.scope ?? "",
        limit: options?.limit ?? null,
        stdout: memory ? buildMemoryStdout(memory, options?.project ?? project) : "No memories found for that query.",
        dataDir: ".engram"
      };
    },
    async saveMemory() {
      throw new Error("not used");
    },
    async closeSession() {
      throw new Error("not used");
    }
  };
}

async function runCase(entry) {
  const argv = [
    "teach",
    "--workspace",
    entry.input.workspace,
    "--task",
    entry.input.task,
    "--objective",
    entry.input.objective,
    "--changed-files",
    entry.input.changedFiles.join(","),
    "--project",
    entry.input.project,
    "--token-budget",
    String(entry.input.tokenBudget),
    "--max-chunks",
    String(entry.input.maxChunks),
    "--format",
    "json"
  ];

  if (entry.input.noRecall) {
    argv.push("--no-recall");
  }

  if (entry.input.recallQuery) {
    argv.push("--recall-query", entry.input.recallQuery);
  }

  const result = await runCli(argv, {
    engramClient: createFakeEngramClient(entry.provider, entry.input.project)
  });
  const parsed = JSON.parse(result.stdout);
  const selectedSources = parsed.selectedContext.map((chunk) => chunk.source);
  const codeFocusPass = parsed.teachingSections.codeFocus?.source === entry.expectations.codeFocus;
  const relatedTestPass =
    parsed.teachingSections.relatedTests?.[0]?.source === entry.expectations.relatedTest;
  const noiseExclusionPass = entry.expectations.excludedSources.every(
    (source) => !selectedSources.includes(source)
  );
  const memoryBehaviorPass =
    parsed.memoryRecall.status === entry.expectations.memoryRecallStatus &&
    parsed.memoryRecall.selectedChunks === entry.expectations.selectedMemoryChunks &&
    parsed.memoryRecall.suppressedChunks === entry.expectations.suppressedMemoryChunks;
  const pass = codeFocusPass && relatedTestPass && noiseExclusionPass && memoryBehaviorPass;

  return {
    name: entry.name,
    pass,
    selectedSources,
    codeFocusPass,
    relatedTestPass,
    noiseExclusionPass,
    memoryBehaviorPass
  };
}

function formatCase(result) {
  return [
    `- ${result.pass ? "PASS" : "FAIL"} ${result.name}`,
    `  selectedSources: ${result.selectedSources.join(", ") || "none"}`,
    `  codeFocusPass: ${result.codeFocusPass ? "yes" : "no"}`,
    `  relatedTestPass: ${result.relatedTestPass ? "yes" : "no"}`,
    `  noiseExclusionPass: ${result.noiseExclusionPass ? "yes" : "no"}`,
    `  memoryBehaviorPass: ${result.memoryBehaviorPass ? "yes" : "no"}`
  ].join("\n");
}

async function main() {
  const benchmarkPath = path.resolve("benchmark/vertical-benchmark.json");
  const raw = await readFile(benchmarkPath, "utf8");
  const payload = parseVerticalBenchmarkFile(raw, benchmarkPath);
  const results = [];

  for (const entry of payload.cases) {
    results.push(await runCase(entry));
  }

  console.log("# Vertical Benchmark");
  console.log("");

  for (const result of results) {
    console.log(formatCase(result));
    console.log("");
  }

  const summary = {
    passRate: ratio(results.filter((result) => result.pass).length, results.length),
    codeFocusPassRate: ratio(results.filter((result) => result.codeFocusPass).length, results.length),
    relatedTestPassRate: ratio(results.filter((result) => result.relatedTestPass).length, results.length),
    noiseExclusionPassRate: ratio(results.filter((result) => result.noiseExclusionPass).length, results.length),
    memoryBehaviorPassRate: ratio(results.filter((result) => result.memoryBehaviorPass).length, results.length),
    avgSignalPassRate: average(
      results.map((result) =>
        average([
          result.codeFocusPass ? 1 : 0,
          result.relatedTestPass ? 1 : 0,
          result.noiseExclusionPass ? 1 : 0,
          result.memoryBehaviorPass ? 1 : 0
        ])
      )
    )
  };

  console.log("## Summary");
  console.log(`- Cases: ${results.length}`);
  console.log(`- Pass rate: ${toPercent(summary.passRate)}`);
  console.log(`- Code-focus pass rate: ${toPercent(summary.codeFocusPassRate)}`);
  console.log(`- Related-test pass rate: ${toPercent(summary.relatedTestPassRate)}`);
  console.log(`- Noise-exclusion pass rate: ${toPercent(summary.noiseExclusionPassRate)}`);
  console.log(`- Memory-behavior pass rate: ${toPercent(summary.memoryBehaviorPassRate)}`);
  console.log(`- Avg signal pass rate: ${toPercent(summary.avgSignalPassRate)}`);

  if (summary.passRate < 1) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

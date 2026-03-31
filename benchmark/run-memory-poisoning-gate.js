#!/usr/bin/env node
// @ts-check

import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { createDefaultExecutors } from "../src/orchestration/default-executors.js";
import {
  evaluateMemoryPoisoningGate,
  formatMemoryPoisoningGateReport
} from "../src/eval/memory-poisoning-gate.js";

/**
 * @param {string[]} argv
 * @param {string} key
 * @param {string} fallback
 */
function option(argv, key, fallback) {
  const index = argv.indexOf(`--${key}`);
  if (index === -1) {
    return fallback;
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    return fallback;
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function toRatio(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, parsed));
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function toCount(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(parsed));
}

/**
 * @param {unknown} chunk
 * @param {string} label
 */
function parseChunk(chunk, label) {
  assertObject(chunk, label);
  const row = /** @type {Record<string, unknown>} */ (chunk);
  return {
    id: assertString(row.id, `${label}.id`),
    source: assertString(row.source, `${label}.source`),
    kind: typeof row.kind === "string" && row.kind.trim() ? row.kind.trim() : "doc",
    content: assertString(row.content, `${label}.content`),
    probe: typeof row.probe === "string" && row.probe.trim() ? row.probe.trim() : ""
  };
}

/**
 * @param {string} raw
 * @param {string} sourceLabel
 */
function parseBenchmark(raw, sourceLabel) {
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(
      `${sourceLabel} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  assertObject(parsed, sourceLabel);
  const payload = /** @type {Record<string, unknown>} */ (parsed);
  const thresholdsInput =
    payload.thresholds && typeof payload.thresholds === "object" && !Array.isArray(payload.thresholds)
      ? /** @type {Record<string, unknown>} */ (payload.thresholds)
      : {};
  const cleanChunksRaw = Array.isArray(payload.cleanChunks) ? payload.cleanChunks : [];
  const poisonedChunksRaw = Array.isArray(payload.poisonedChunks) ? payload.poisonedChunks : [];

  if (!cleanChunksRaw.length) {
    throw new Error(`${sourceLabel}.cleanChunks must be a non-empty array.`);
  }
  if (!poisonedChunksRaw.length) {
    throw new Error(`${sourceLabel}.poisonedChunks must be a non-empty array.`);
  }

  return {
    suite: typeof payload.suite === "string" && payload.suite.trim()
      ? payload.suite.trim()
      : "memory-poisoning",
    project: typeof payload.project === "string" && payload.project.trim()
      ? payload.project.trim()
      : "memory-poisoning-gate",
    thresholds: {
      minPoisonQuarantineRate: toRatio(thresholdsInput.minPoisonQuarantineRate, 1),
      maxPoisonLeakRate: toRatio(thresholdsInput.maxPoisonLeakRate, 0),
      minCleanAcceptanceRate: toRatio(thresholdsInput.minCleanAcceptanceRate, 0.95),
      maxFalsePositiveRate: toRatio(thresholdsInput.maxFalsePositiveRate, 0.05),
      maxPoisonRecallLeakHits: toCount(thresholdsInput.maxPoisonRecallLeakHits, 0),
      maxPoisonRecallLeakRate: toRatio(thresholdsInput.maxPoisonRecallLeakRate, 0)
    },
    cleanChunks: cleanChunksRaw.map((chunk, index) => parseChunk(chunk, `cleanChunks[${index}]`)),
    poisonedChunks: poisonedChunksRaw.map((chunk, index) =>
      parseChunk(chunk, `poisonedChunks[${index}]`)
    )
  };
}

/**
 * @param {ReturnType<typeof parseBenchmark>} benchmark
 */
async function runSimulation(benchmark) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "nexus-memory-poisoning-"));
  const executors = createDefaultExecutors({
    repositoryFilePath: path.join(tempRoot, "chunks.jsonl")
  });

  try {
    const cleanStore = await executors.store({
      input: {
        projectId: benchmark.project,
        ingest: {
          adapter: "synthetic-benchmark"
        },
        chunks: benchmark.cleanChunks.map((chunk) => ({
          id: chunk.id,
          source: chunk.source,
          kind: chunk.kind,
          content: chunk.content,
          metadata: {
            ingestedBy: "adapter:synthetic-benchmark",
            preChunked: true
          }
        }))
      }
    });

    const poisonStore = await executors.store({
      input: {
        projectId: benchmark.project,
        ingest: {
          adapter: "synthetic-benchmark"
        },
        chunks: benchmark.poisonedChunks.map((chunk) => ({
          id: chunk.id,
          source: chunk.source,
          kind: chunk.kind,
          content: chunk.content,
          metadata: {
            ingestedBy: "adapter:synthetic-benchmark",
            preChunked: true
          }
        }))
      }
    });

    const poisonedIds = new Set(benchmark.poisonedChunks.map((chunk) => chunk.id));
    const leakedPoisonedIds = new Set();
    const probes = [];

    for (const chunk of benchmark.poisonedChunks) {
      const query = chunk.probe || chunk.id;
      const recall = await executors.recall({
        input: {
          projectId: benchmark.project,
          query,
          limit: 8
        }
      });

      const leakedIds = recall.results
        .map((entry) => String(entry.id ?? ""))
        .filter((id) => poisonedIds.has(id));

      for (const id of leakedIds) {
        leakedPoisonedIds.add(id);
      }

      probes.push({
        query,
        leakedIds
      });
    }

    return {
      summary: {
        cleanTotal: benchmark.cleanChunks.length,
        cleanAccepted: cleanStore.storedCount,
        cleanQuarantined: cleanStore.quarantinedCount,
        poisonedTotal: benchmark.poisonedChunks.length,
        poisonedAccepted: poisonStore.storedCount,
        poisonedQuarantined: poisonStore.quarantinedCount,
        poisonedRecallLeakHits: leakedPoisonedIds.size
      },
      details: {
        cleanStore,
        poisonStore,
        probes,
        leakedPoisonedIds: [...leakedPoisonedIds]
      }
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const format = option(argv, "format", "text").toLowerCase();
  const filePath = path.resolve(option(argv, "file", "benchmark/memory-poisoning-benchmark.json"));

  if (format !== "text" && format !== "json") {
    throw new Error("Option --format must be 'text' or 'json'.");
  }

  const raw = await readFile(filePath, "utf8");
  const benchmark = parseBenchmark(raw, filePath);
  const simulation = await runSimulation(benchmark);
  const report = evaluateMemoryPoisoningGate({
    suite: benchmark.suite,
    summary: simulation.summary,
    thresholds: benchmark.thresholds
  });
  const output = {
    suite: benchmark.suite,
    source: filePath,
    ...report,
    simulation: simulation.details
  };

  if (format === "json") {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(formatMemoryPoisoningGateReport(report));
  }

  if (!report.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

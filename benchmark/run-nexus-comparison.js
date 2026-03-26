#!/usr/bin/env node
// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseVerticalBenchmarkFile } from "../src/contracts/vertical-benchmark-contracts.js";
import {
  formatNexusComparisonReport,
  runNexusComparisonSuite
} from "../src/benchmark/nexus-comparison.js";

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

async function main() {
  const argv = process.argv.slice(2);
  const filePath = path.resolve(option(argv, "file", "benchmark/vertical-benchmark.json"));
  const format = option(argv, "format", "text").toLowerCase();

  if (format !== "text" && format !== "json") {
    throw new Error("Option --format must be 'text' or 'json'.");
  }

  const raw = await readFile(filePath, "utf8");
  const payload = parseVerticalBenchmarkFile(raw, filePath);
  const report = await runNexusComparisonSuite(payload.cases);
  const enriched = {
    source: filePath,
    ...report
  };

  if (format === "json") {
    console.log(JSON.stringify(enriched, null, 2));
  } else {
    console.log(formatNexusComparisonReport(enriched));
  }

  if (report.status !== "ok") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

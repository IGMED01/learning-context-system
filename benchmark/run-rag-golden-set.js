#!/usr/bin/env node
// @ts-check

import path from "node:path";
import { readFile } from "node:fs/promises";

import { parseRagGoldenSetFile } from "../src/contracts/rag-golden-set-contracts.js";
import {
  evaluateRagGoldenSetGate,
  formatRagGoldenSetGateReport
} from "../src/eval/rag-golden-set-gate.js";

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
 * @param {string[]} argv
 * @param {string} key
 */
function numberOption(argv, key) {
  const index = argv.indexOf(`--${key}`);
  if (index === -1) {
    return undefined;
  }

  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

const argv = process.argv.slice(2);
const format = option(argv, "format", "text").toLowerCase();
const filePath = path.resolve(option(argv, "file", "benchmark/rag-golden-set-200.json"));
const minCases = numberOption(argv, "min-cases");

if (format !== "text" && format !== "json") {
  throw new Error("Option --format must be 'text' or 'json'.");
}

const raw = await readFile(filePath, "utf8");
const suite = parseRagGoldenSetFile(raw, filePath, {
  minCases
});
const report = evaluateRagGoldenSetGate({
  suite: suite.suite,
  documents: suite.documents,
  cases: suite.cases,
  thresholds: {
    minCases
  }
});

if (format === "json") {
  console.log(
    JSON.stringify(
      {
        source: filePath,
        ...report
      },
      null,
      2
    )
  );
} else {
  console.log(formatRagGoldenSetGateReport(report));
}

if (!report.passed) {
  process.exitCode = 1;
}

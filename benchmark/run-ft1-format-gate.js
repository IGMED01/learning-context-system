#!/usr/bin/env node
// @ts-check

import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  evaluateFt1FormatGate,
  formatFt1FormatGateReport
} from "../src/eval/ft1-format-gate.js";

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

const argv = process.argv.slice(2);
const format = option(argv, "format", "text").toLowerCase();
const filePath = path.resolve(option(argv, "file", "benchmark/ft1-format-benchmark.json"));

if (format !== "text" && format !== "json") {
  throw new Error("Option --format must be 'text' or 'json'.");
}

const raw = await readFile(filePath, "utf8");
const parsed = JSON.parse(raw.replace(/^\uFEFF/u, ""));
assertObject(parsed, "ft1 format payload");

const record = /** @type {Record<string, unknown>} */ (parsed);
if (!Array.isArray(record.cases) || record.cases.length === 0) {
  throw new Error("ft1 format payload must include a non-empty 'cases' array.");
}

const thresholdsInput =
  record.thresholds && typeof record.thresholds === "object" && !Array.isArray(record.thresholds)
    ? /** @type {Record<string, unknown>} */ (record.thresholds)
    : {};

const result = evaluateFt1FormatGate({
  suiteName:
    typeof record.suite === "string" && record.suite.trim() ? record.suite.trim() : "ft1-format-pilot",
  thresholds: {
    minCasePassRate:
      typeof thresholdsInput.minCasePassRate === "number"
        ? thresholdsInput.minCasePassRate
        : undefined,
    minCandidateSectionCoverage:
      typeof thresholdsInput.minCandidateSectionCoverage === "number"
        ? thresholdsInput.minCandidateSectionCoverage
        : undefined,
    minCandidatePracticeRate:
      typeof thresholdsInput.minCandidatePracticeRate === "number"
        ? thresholdsInput.minCandidatePracticeRate
        : undefined,
    minCandidateHeadingCoverage:
      typeof thresholdsInput.minCandidateHeadingCoverage === "number"
        ? thresholdsInput.minCandidateHeadingCoverage
        : undefined,
    minCoverageLift:
      typeof thresholdsInput.minCoverageLift === "number"
        ? thresholdsInput.minCoverageLift
        : undefined,
    minPracticeLift:
      typeof thresholdsInput.minPracticeLift === "number"
        ? thresholdsInput.minPracticeLift
        : undefined
  },
  cases: record.cases
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry, index) => {
      const sample = /** @type {Record<string, unknown>} */ (entry);
      return {
        id: typeof sample.id === "string" ? sample.id : `ft1-${index + 1}`,
        task: typeof sample.task === "string" ? sample.task : "",
        baselineOutput: assertString(sample.baselineOutput, `cases[${index}].baselineOutput`),
        candidateOutput: assertString(sample.candidateOutput, `cases[${index}].candidateOutput`)
      };
    })
});

if (format === "json") {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatFt1FormatGateReport(result));
}

if (!result.passed) {
  process.exitCode = 1;
}


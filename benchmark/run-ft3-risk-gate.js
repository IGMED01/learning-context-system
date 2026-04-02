#!/usr/bin/env node
// @ts-check

import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  evaluateFt3RiskGate,
  formatFt3RiskGateReport
} from "../src/eval/ft3-risk-gate.js";

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
const filePath = path.resolve(option(argv, "file", "benchmark/ft3-risk-benchmark.json"));

if (format !== "text" && format !== "json") {
  throw new Error("Option --format must be 'text' or 'json'.");
}

const raw = await readFile(filePath, "utf8");
const parsed = JSON.parse(raw.replace(/^\uFEFF/u, ""));
assertObject(parsed, "ft3 risk payload");

const record = /** @type {Record<string, unknown>} */ (parsed);
if (!Array.isArray(record.cases) || record.cases.length === 0) {
  throw new Error("ft3 risk payload must include a non-empty 'cases' array.");
}

const thresholdsInput =
  record.thresholds && typeof record.thresholds === "object" && !Array.isArray(record.thresholds)
    ? /** @type {Record<string, unknown>} */ (record.thresholds)
    : {};

const result = evaluateFt3RiskGate({
  suiteName: typeof record.suite === "string" && record.suite.trim() ? record.suite.trim() : "ft3-risk-pilot",
  thresholds: {
    minCandidateAccuracy:
      typeof thresholdsInput.minCandidateAccuracy === "number"
        ? thresholdsInput.minCandidateAccuracy
        : undefined,
    minCandidateMacroF1:
      typeof thresholdsInput.minCandidateMacroF1 === "number"
        ? thresholdsInput.minCandidateMacroF1
        : undefined,
    minHighRiskRecall:
      typeof thresholdsInput.minHighRiskRecall === "number"
        ? thresholdsInput.minHighRiskRecall
        : undefined,
    minAccuracyLift:
      typeof thresholdsInput.minAccuracyLift === "number"
        ? thresholdsInput.minAccuracyLift
        : undefined,
    maxUnderRiskRate:
      typeof thresholdsInput.maxUnderRiskRate === "number"
        ? thresholdsInput.maxUnderRiskRate
        : undefined,
    maxUnknownRate:
      typeof thresholdsInput.maxUnknownRate === "number"
        ? thresholdsInput.maxUnknownRate
        : undefined
  },
  cases: record.cases
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry, index) => {
      const sample = /** @type {Record<string, unknown>} */ (entry);
      return {
        id: typeof sample.id === "string" ? sample.id : `ft3-${index + 1}`,
        input: typeof sample.input === "string" ? sample.input : "",
        expectedRisk: assertString(sample.expectedRisk, `cases[${index}].expectedRisk`),
        baselineRisk: assertString(sample.baselineRisk, `cases[${index}].baselineRisk`),
        candidateRisk: assertString(sample.candidateRisk, `cases[${index}].candidateRisk`)
      };
    })
});

if (format === "json") {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatFt3RiskGateReport(result));
}

if (!result.passed) {
  process.exitCode = 1;
}

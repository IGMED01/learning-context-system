#!/usr/bin/env node
// @ts-check

import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  evaluateFt4QueryRewriteGate,
  formatFt4QueryRewriteGateReport
} from "../src/eval/ft4-query-rewrite-gate.js";

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
const filePath = path.resolve(option(argv, "file", "benchmark/ft4-query-rewrite-benchmark.json"));

if (format !== "text" && format !== "json") {
  throw new Error("Option --format must be 'text' or 'json'.");
}

const raw = await readFile(filePath, "utf8");
const parsed = JSON.parse(raw.replace(/^\uFEFF/u, ""));
assertObject(parsed, "ft4 query rewrite payload");

const record = /** @type {Record<string, unknown>} */ (parsed);
if (!Array.isArray(record.cases) || record.cases.length === 0) {
  throw new Error("ft4 query rewrite payload must include a non-empty 'cases' array.");
}

const thresholdsInput =
  record.thresholds && typeof record.thresholds === "object" && !Array.isArray(record.thresholds)
    ? /** @type {Record<string, unknown>} */ (record.thresholds)
    : {};

const result = evaluateFt4QueryRewriteGate({
  suiteName:
    typeof record.suite === "string" && record.suite.trim() ? record.suite.trim() : "ft4-query-rewrite-pilot",
  thresholds: {
    minCandidateKeywordRecall:
      typeof thresholdsInput.minCandidateKeywordRecall === "number"
        ? thresholdsInput.minCandidateKeywordRecall
        : undefined,
    minKeywordRecallLift:
      typeof thresholdsInput.minKeywordRecallLift === "number"
        ? thresholdsInput.minKeywordRecallLift
        : undefined,
    minRewriteRate:
      typeof thresholdsInput.minRewriteRate === "number"
        ? thresholdsInput.minRewriteRate
        : undefined,
    minIntentPreservationRate:
      typeof thresholdsInput.minIntentPreservationRate === "number"
        ? thresholdsInput.minIntentPreservationRate
        : undefined,
    maxLengthRatio:
      typeof thresholdsInput.maxLengthRatio === "number"
        ? thresholdsInput.maxLengthRatio
        : undefined
  },
  cases: record.cases
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry, index) => {
      const sample = /** @type {Record<string, unknown>} */ (entry);
      const keywords = Array.isArray(sample.expectedKeywords)
        ? sample.expectedKeywords.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [];
      if (!keywords.length) {
        throw new Error(`cases[${index}].expectedKeywords must include at least one keyword.`);
      }

      return {
        id: typeof sample.id === "string" ? sample.id : `ft4-${index + 1}`,
        originalQuery: assertString(sample.originalQuery, `cases[${index}].originalQuery`),
        expectedKeywords: keywords,
        baselineRewrite: assertString(sample.baselineRewrite, `cases[${index}].baselineRewrite`),
        candidateRewrite: assertString(sample.candidateRewrite, `cases[${index}].candidateRewrite`)
      };
    })
});

if (format === "json") {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatFt4QueryRewriteGateReport(result));
}

if (!result.passed) {
  process.exitCode = 1;
}

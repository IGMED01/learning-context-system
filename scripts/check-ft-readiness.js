import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  evaluateFineTuningReadinessGate,
  formatFineTuningReadinessReport
} from "../src/eval/fine-tuning-readiness-gate.js";

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

const argv = process.argv.slice(2);
const format = option(argv, "format", "text").toLowerCase();
const filePath = path.resolve(option(argv, "file", "benchmark/ft-readiness-dataset.json"));

if (format !== "text" && format !== "json") {
  throw new Error("Option --format must be 'text' or 'json'.");
}

const raw = await readFile(filePath, "utf8");
const payload = JSON.parse(raw.replace(/^\uFEFF/u, ""));
assertObject(payload, "dataset payload");

const record = /** @type {Record<string, unknown>} */ (payload);
const samples = Array.isArray(record.samples)
  ? record.samples
      .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      .map((entry) => /** @type {Record<string, unknown>} */ (entry))
      .map((entry) => ({
        id: typeof entry.id === "string" ? entry.id : "",
        input: typeof entry.input === "string" ? entry.input : "",
        output: typeof entry.output === "string" ? entry.output : "",
        intent: typeof entry.intent === "string" ? entry.intent : "",
        risk: typeof entry.risk === "string" ? entry.risk : ""
      }))
  : [];
const thresholds =
  record.thresholds && typeof record.thresholds === "object" && !Array.isArray(record.thresholds)
    ? /** @type {Record<string, unknown>} */ (record.thresholds)
    : {};

const result = evaluateFineTuningReadinessGate({
  datasetName: typeof record.dataset === "string" && record.dataset.trim() ? record.dataset : filePath,
  samples,
  thresholds: {
    minSamples: typeof thresholds.minSamples === "number" ? thresholds.minSamples : undefined,
    maxDuplicateRate:
      typeof thresholds.maxDuplicateRate === "number" ? thresholds.maxDuplicateRate : undefined,
    maxSecretRate: typeof thresholds.maxSecretRate === "number" ? thresholds.maxSecretRate : undefined,
    minSectionCoverage:
      typeof thresholds.minSectionCoverage === "number" ? thresholds.minSectionCoverage : undefined,
    minPracticeRate:
      typeof thresholds.minPracticeRate === "number" ? thresholds.minPracticeRate : undefined,
    minIntentLabels:
      typeof thresholds.minIntentLabels === "number" ? thresholds.minIntentLabels : undefined
  }
});

if (format === "json") {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatFineTuningReadinessReport(result));
}

if (!result.passed) {
  process.exitCode = 1;
}


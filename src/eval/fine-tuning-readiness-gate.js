// @ts-check

import { parseLlmResponse } from "../llm/response-parser.js";

/**
 * @typedef {{
 *   id?: string,
 *   input: string,
 *   output: string,
 *   intent?: string,
 *   risk?: string
 * }} FineTuningSample
 */

/**
 * @typedef {{
 *   minSamples?: number,
 *   maxDuplicateRate?: number,
 *   maxSecretRate?: number,
 *   minSectionCoverage?: number,
 *   minPracticeRate?: number,
 *   minIntentLabels?: number
 * }} FineTuningReadinessThresholdsInput
 */

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9]{16,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bghp_[A-Za-z0-9]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9_\-\.=]{20,}\b/iu,
  /\bpassword\s*[:=]\s*['"]?[^\s'"]{6,}/iu
];

/**
 * @param {unknown} value
 */
function toFiniteNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }

  return value;
}

/**
 * @param {number} value
 */
function round(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * @param {string} text
 */
function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * @param {FineTuningReadinessThresholdsInput} [input]
 */
export function normalizeFineTuningReadinessThresholds(input = {}) {
  return {
    minSamples: Math.max(1, Math.round(toFiniteNumber(input.minSamples ?? 20))),
    maxDuplicateRate: Math.max(0, Math.min(1, toFiniteNumber(input.maxDuplicateRate ?? 0.08))),
    maxSecretRate: Math.max(0, Math.min(1, toFiniteNumber(input.maxSecretRate ?? 0))),
    minSectionCoverage: Math.max(0, Math.min(1, toFiniteNumber(input.minSectionCoverage ?? 0.9))),
    minPracticeRate: Math.max(0, Math.min(1, toFiniteNumber(input.minPracticeRate ?? 0.85))),
    minIntentLabels: Math.max(1, Math.round(toFiniteNumber(input.minIntentLabels ?? 3)))
  };
}

/**
 * @param {FineTuningSample[]} samples
 */
function collectDuplicateRate(samples) {
  const signatures = new Map();

  for (const sample of samples) {
    const key = `${normalizeText(sample.input)}::${normalizeText(sample.output)}`;
    signatures.set(key, (signatures.get(key) ?? 0) + 1);
  }

  const duplicateCount = [...signatures.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count - 1, 0);

  return {
    duplicateCount,
    duplicateRate: samples.length ? duplicateCount / samples.length : 0
  };
}

/**
 * @param {FineTuningSample[]} samples
 */
function collectSectionMetrics(samples) {
  let sectionCoverageTotal = 0;
  let practiceCount = 0;

  for (const sample of samples) {
    const parsed = parseLlmResponse(sample.output);
    const hasChange = Boolean(parsed.change.trim());
    const hasReason = Boolean(parsed.reason.trim());
    const hasConcepts = parsed.concepts.length > 0;
    const hasPractice = Boolean(parsed.practice.trim());
    const sectionsPresent =
      (hasChange ? 1 : 0) +
      (hasReason ? 1 : 0) +
      (hasConcepts ? 1 : 0) +
      (hasPractice ? 1 : 0);

    sectionCoverageTotal += sectionsPresent / 4;
    if (hasPractice) {
      practiceCount += 1;
    }
  }

  return {
    sectionCoverageRate: samples.length ? sectionCoverageTotal / samples.length : 0,
    practiceRate: samples.length ? practiceCount / samples.length : 0
  };
}

/**
 * @param {FineTuningSample[]} samples
 */
function collectSecretMetrics(samples) {
  const findings = [];

  for (const sample of samples) {
    const output = String(sample.output ?? "");
    const input = String(sample.input ?? "");
    const payload = `${input}\n${output}`;
    const matched = SECRET_PATTERNS.some((pattern) => pattern.test(payload));

    if (matched) {
      findings.push(sample.id ?? "unknown");
    }
  }

  return {
    secretsFound: findings.length,
    secretRate: samples.length ? findings.length / samples.length : 0,
    sampleIds: findings
  };
}

/**
 * @param {FineTuningSample[]} samples
 */
function collectIntentMetrics(samples) {
  const labels = new Set(
    samples
      .map((sample) => String(sample.intent ?? "").trim().toLowerCase())
      .filter(Boolean)
  );

  return {
    uniqueIntentLabels: labels.size,
    labels: [...labels]
  };
}

/**
 * @param {{
 *   datasetName: string,
 *   samples: FineTuningSample[],
 *   thresholds?: FineTuningReadinessThresholdsInput
 * }} input
 */
export function evaluateFineTuningReadinessGate(input) {
  const thresholds = normalizeFineTuningReadinessThresholds(input.thresholds);
  const samples = Array.isArray(input.samples) ? input.samples : [];
  const duplicates = collectDuplicateRate(samples);
  const sections = collectSectionMetrics(samples);
  const secrets = collectSecretMetrics(samples);
  const intents = collectIntentMetrics(samples);

  const checks = [
    {
      id: "min-samples",
      passed: samples.length >= thresholds.minSamples,
      detail: `samples=${samples.length} (required >= ${thresholds.minSamples})`
    },
    {
      id: "max-duplicate-rate",
      passed: duplicates.duplicateRate <= thresholds.maxDuplicateRate,
      detail: `duplicateRate=${round(duplicates.duplicateRate)} (required <= ${round(thresholds.maxDuplicateRate)})`
    },
    {
      id: "max-secret-rate",
      passed: secrets.secretRate <= thresholds.maxSecretRate,
      detail: `secretRate=${round(secrets.secretRate)} (required <= ${round(thresholds.maxSecretRate)})`
    },
    {
      id: "min-section-coverage",
      passed: sections.sectionCoverageRate >= thresholds.minSectionCoverage,
      detail: `sectionCoverageRate=${round(sections.sectionCoverageRate)} (required >= ${round(thresholds.minSectionCoverage)})`
    },
    {
      id: "min-practice-rate",
      passed: sections.practiceRate >= thresholds.minPracticeRate,
      detail: `practiceRate=${round(sections.practiceRate)} (required >= ${round(thresholds.minPracticeRate)})`
    },
    {
      id: "min-intent-labels",
      passed: intents.uniqueIntentLabels >= thresholds.minIntentLabels,
      detail: `uniqueIntentLabels=${intents.uniqueIntentLabels} (required >= ${thresholds.minIntentLabels})`
    }
  ];

  const failures = checks.filter((check) => !check.passed).map((check) => check.detail);

  return {
    passed: failures.length === 0,
    datasetName: input.datasetName,
    thresholds,
    checks,
    failures,
    metrics: {
      samples: samples.length,
      duplicateCount: duplicates.duplicateCount,
      duplicateRate: round(duplicates.duplicateRate),
      secretsFound: secrets.secretsFound,
      secretRate: round(secrets.secretRate),
      secretSampleIds: secrets.sampleIds,
      sectionCoverageRate: round(sections.sectionCoverageRate),
      practiceRate: round(sections.practiceRate),
      uniqueIntentLabels: intents.uniqueIntentLabels,
      intentLabels: intents.labels
    }
  };
}

/**
 * @param {ReturnType<typeof evaluateFineTuningReadinessGate>} report
 */
export function formatFineTuningReadinessReport(report) {
  const lines = [
    "Fine-tuning readiness gate:",
    `- dataset: ${report.datasetName}`,
    `- passed: ${report.passed ? "yes" : "no"}`,
    `- samples: ${report.metrics.samples}`,
    `- duplicate rate: ${report.metrics.duplicateRate}`,
    `- secret rate: ${report.metrics.secretRate}`,
    `- section coverage rate: ${report.metrics.sectionCoverageRate}`,
    `- practice rate: ${report.metrics.practiceRate}`,
    `- unique intent labels: ${report.metrics.uniqueIntentLabels}`,
    "",
    "Checks:"
  ];

  for (const check of report.checks) {
    lines.push(`- [${check.passed ? "pass" : "fail"}] ${check.id}: ${check.detail}`);
  }

  if (report.metrics.secretSampleIds.length) {
    lines.push("");
    lines.push(`Secret-like findings in samples: ${report.metrics.secretSampleIds.join(", ")}`);
  }

  return lines.join("\n");
}


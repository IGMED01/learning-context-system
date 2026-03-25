// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";

import { evaluateCiGate } from "./ci-gate.js";
import { scoreResponseConsistency } from "./consistency-scorer.js";

/**
 * @param {unknown} value
 */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} value
 */
function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @param {unknown} value
 */
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * @param {unknown} value
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} value
 */
function asStringArray(value) {
  return asArray(value)
    .map((entry) => asString(entry))
    .filter(Boolean);
}

/**
 * @param {string} filePath
 */
export async function loadDomainEvalSuite(filePath) {
  const resolved = path.resolve(filePath);
  const raw = await readFile(resolved, "utf8");
  const payload = JSON.parse(raw.replace(/^\uFEFF/u, ""));
  const root = asRecord(payload);

  return {
    filePath: resolved,
    suite: asString(root.suite) || path.basename(resolved),
    thresholds: asRecord(root.thresholds),
    cases: asArray(root.cases),
    qualityPolicy: asRecord(root.qualityPolicy)
  };
}

/**
 * @param {Array<{ content?: string }>} responses
 */
function consistencyFromResponses(responses) {
  const normalized = responses
    .map((entry, index) => ({
      id: `response-${index + 1}`,
      content: asString(entry?.content)
    }))
    .filter((entry) => entry.content.length > 0);

  if (!normalized.length) {
    return {
      score: 0,
      status: "empty",
      pairs: []
    };
  }

  return scoreResponseConsistency(normalized);
}

/**
 * @param {{
 *   suite: string,
 *   thresholds?: Record<string, unknown>,
 *   qualityPolicy?: Record<string, unknown>,
 *   cases: unknown[]
 * }} suite
 */
export function runDomainEvalSuite(suite) {
  const baseThresholds = {
    consistency: 0.65,
    relevance: 0.7,
    safety: 0.85,
    cost: 180,
    ...suite.thresholds
  };
  const qualityPolicy = asRecord(suite.qualityPolicy);
  const minCasesPerDomain = Math.max(1, Math.trunc(asNumber(qualityPolicy.minCasesPerDomain || 1)));
  const requiredDomains = [...new Set(asStringArray(qualityPolicy.requiredDomains))].sort((a, b) =>
    a.localeCompare(b)
  );

  const normalizedCases = suite.cases.map((entry, index) => {
    const current = asRecord(entry);
    const domain = asString(current.domain) || "general";
    const name = asString(current.name) || `case-${index + 1}`;
    const scoreInput = asRecord(current.scores);
    const responses = asArray(current.responses).map((item) => asRecord(item));
    const consistency = responses.length
      ? consistencyFromResponses(responses)
      : {
          score: asNumber(scoreInput.consistency),
          status: "provided",
          pairs: []
        };
    const thresholds = {
      ...baseThresholds,
      ...asRecord(current.thresholds)
    };
    const gate = evaluateCiGate({
      scores: {
        consistency: consistency.score,
        relevance: asNumber(scoreInput.relevance),
        safety: asNumber(scoreInput.safety),
        cost: asNumber(scoreInput.cost)
      },
      thresholds: {
        consistency: asNumber(thresholds.consistency),
        relevance: asNumber(thresholds.relevance),
        safety: asNumber(thresholds.safety),
        cost: asNumber(thresholds.cost)
      }
    });

    return {
      id: index + 1,
      domain,
      name,
      gate,
      consistency
    };
  });

  const domains = [...new Set(normalizedCases.map((entry) => entry.domain))].sort((a, b) =>
    a.localeCompare(b)
  );

  const byDomain = domains.map((domain) => {
    const domainCases = normalizedCases.filter((entry) => entry.domain === domain);
    const passed = domainCases.filter((entry) => entry.gate.status === "pass").length;

    return {
      domain,
      total: domainCases.length,
      passed,
      failed: domainCases.length - passed,
      passRate: domainCases.length ? Number((passed / domainCases.length).toFixed(4)) : 1,
      status: domainCases.length - passed > 0 ? "blocked" : "pass"
    };
  });

  const failedCases = normalizedCases.filter((entry) => entry.gate.status !== "pass");
  const failedDomains = byDomain.filter((entry) => entry.failed > 0).map((entry) => entry.domain);
  const missingRequiredDomains = requiredDomains.filter(
    (domain) => !byDomain.some((entry) => entry.domain === domain)
  );
  const insufficientCoverageDomains = byDomain
    .filter((entry) => entry.total < minCasesPerDomain)
    .map((entry) => entry.domain);
  const blockedByCoverage = missingRequiredDomains.length > 0 || insufficientCoverageDomains.length > 0;

  return {
    suite: suite.suite,
    status: failedCases.length || blockedByCoverage ? "blocked" : "pass",
    summary: {
      totalCases: normalizedCases.length,
      passedCases: normalizedCases.length - failedCases.length,
      failedCases: failedCases.length,
      totalDomains: byDomain.length,
      failedDomains: failedDomains.length,
      missingRequiredDomains: missingRequiredDomains.length,
      insufficientCoverageDomains: insufficientCoverageDomains.length
    },
    qualityPolicy: {
      minCasesPerDomain,
      requiredDomains
    },
    coverage: {
      missingRequiredDomains,
      insufficientCoverageDomains
    },
    byDomain,
    cases: normalizedCases,
    failedCases
  };
}

/**
 * @param {ReturnType<typeof runDomainEvalSuite>} report
 */
export function formatDomainEvalSuiteReport(report) {
  const lines = [
    `Domain Eval Suite: ${report.suite}`,
    `Status: ${report.status.toUpperCase()}`,
    "",
    "By domain:"
  ];

  for (const domain of report.byDomain) {
    lines.push(
      `- ${domain.domain}: ${domain.passed}/${domain.total} pass (${(domain.passRate * 100).toFixed(1)}%)`
    );
  }

  lines.push("");
  lines.push("Cases:");

  for (const entry of report.cases) {
    const failedMetrics = entry.gate.failed.map((metric) => metric.metric).join(", ") || "none";
    lines.push(
      `- [${entry.gate.status === "pass" ? "PASS" : "BLOCK"}] ${entry.domain} :: ${entry.name} | failed: ${failedMetrics}`
    );
  }

  if (report.coverage?.missingRequiredDomains?.length || report.coverage?.insufficientCoverageDomains?.length) {
    lines.push("");
    lines.push("Coverage policy:");
    lines.push(
      `- minCasesPerDomain: ${report.qualityPolicy?.minCasesPerDomain ?? 1}`
    );

    if (report.coverage.missingRequiredDomains.length) {
      lines.push(
        `- missing required domains: ${report.coverage.missingRequiredDomains.join(", ")}`
      );
    }

    if (report.coverage.insufficientCoverageDomains.length) {
      lines.push(
        `- insufficient domain coverage: ${report.coverage.insufficientCoverageDomains.join(", ")}`
      );
    }
  }

  return lines.join("\n");
}

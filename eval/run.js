#!/usr/bin/env node
// @ts-check

/**
 * CLI entry point for running eval suites.
 *
 * Usage:
 *   node eval/run.js --project salta --suite eval/suites/legal-basics.json
 *   node eval/run.js --project salta --suite eval/suites/legal-basics.json --min-score 0.7
 */

import { resolve } from "node:path";
import { runEvalSuite, loadEvalSuite } from "../src/eval/eval-runner.js";

// ── Parse args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);

/** @param {string} name @returns {string | undefined} */
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const suitePath = getArg("suite");
const projectOverride = getArg("project");
const minScore = parseFloat(getArg("min-score") ?? "0.5");

if (!suitePath) {
  console.error("Usage: node eval/run.js --suite <path> [--project <name>] [--min-score <0-1>]");
  process.exit(1);
}

// ── Run ──────────────────────────────────────────────────────────────

const suite = await loadEvalSuite(resolve(suitePath));

if (projectOverride) {
  suite.project = projectOverride;
}

console.log(`\n  Running eval suite: ${suite.name}`);
console.log(`  Project: ${suite.project}`);
console.log(`  Cases: ${suite.cases.length}`);
console.log(`  Min score: ${minScore}\n`);

const report = await runEvalSuite(suite, { minScore, consistencyRuns: 2 });

// ── Output ───────────────────────────────────────────────────────────

console.log("  Results:");
console.log("  ─────────────────────────────────────");

for (const r of report.results) {
  const status = r.passed ? "PASS" : "FAIL";
  const icon = r.passed ? "✓" : "✗";
  console.log(`  ${icon} [${status}] ${r.caseId}: acc=${r.scores.accuracy} rel=${r.scores.relevance} con=${r.scores.consistency}`);
}

console.log("  ─────────────────────────────────────");
console.log(`  Pass rate: ${report.passRate} (${report.passedCases}/${report.totalCases})`);
console.log(`  Avg scores: accuracy=${report.averageScores.accuracy} relevance=${report.averageScores.relevance} consistency=${report.averageScores.consistency}`);
console.log(`  Duration: ${report.durationMs}ms`);
console.log(`  CI gate: ${report.ciGate.passed ? "PASSED" : "FAILED"} (${report.ciGate.actualScore} >= ${report.ciGate.minimumScore})`);
console.log("");

// Write full report to stdout as JSON if piped
if (!process.stdout.isTTY) {
  process.stdout.write(JSON.stringify(report, null, 2));
}

process.exit(report.ciGate.passed ? 0 : 1);

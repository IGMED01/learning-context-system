/**
 * Eval Runner — S5: Real evaluation metrics for LCS.
 *
 * Executes a suite of test cases against the recall/teach pipeline
 * and measures accuracy, relevance, and consistency.
 *
 * Three metrics:
 *   - Accuracy:    Does the recalled content contain the expected answer?
 *   - Relevance:   Were the correct chunks selected?
 *   - Consistency:  Does the same query return the same results across runs?
 *
 * Usage:
 *   import { runEvalSuite } from "./eval-runner.js";
 *   const report = await runEvalSuite(suite, { memoryClient, minScore: 0.7 });
 *
 * CI gate:
 *   The report includes a `ciGate.passed` boolean that fails the build
 *   if the average score drops below the configured minimum.
 */

import type {
  EvalSuite,
  EvalCase,
  EvalCaseResult,
  EvalReport,
  EvalMetricName
} from "../types/core-contracts.d.ts";

import { runCli } from "../cli/app.js";

// ── Metrics ──────────────────────────────────────────────────────────

/**
 * Accuracy: How much of the expected answer appears in the actual output.
 * Uses token overlap — simple but effective for recall-based systems.
 */
export function scoreAccuracy(expected: string, actual: string): number {
  if (!expected.trim() || !actual.trim()) return 0;

  const expectedTokens = tokenize(expected);
  const actualTokens = new Set(tokenize(actual));

  if (expectedTokens.length === 0) return 0;

  let hits = 0;
  for (const token of expectedTokens) {
    if (actualTokens.has(token)) hits++;
  }

  return hits / expectedTokens.length;
}

/**
 * Relevance: How many of the expected chunk IDs appear in the actual results.
 * Precision-recall F1 score over chunk IDs.
 */
export function scoreRelevance(expectedIds: string[], actualIds: string[]): number {
  if (expectedIds.length === 0) return 1; // No expectation = auto-pass

  const expectedSet = new Set(expectedIds);
  const actualSet = new Set(actualIds);

  let truePositives = 0;
  for (const id of actualSet) {
    if (expectedSet.has(id)) truePositives++;
  }

  if (truePositives === 0) return 0;

  const precision = truePositives / actualSet.size;
  const recall = truePositives / expectedSet.size;

  return (2 * precision * recall) / (precision + recall);
}

/**
 * Consistency: Run the same query N times and measure overlap.
 * Returns 1.0 if all runs return identical results, 0.0 if completely different.
 */
export async function scoreConsistency(
  query: string,
  project: string,
  runs: number = 3
): Promise<number> {
  const results: string[][] = [];

  for (let i = 0; i < runs; i++) {
    const result = await runCli([
      "recall", "--query", query, "--project", project, "--format", "json"
    ]);

    const parsed = tryParseJson(result.stdout ?? "");
    const chunkIds = extractChunkIds(parsed);
    results.push(chunkIds);
  }

  if (results.length < 2) return 1;

  // Jaccard similarity across all pairs
  let totalSimilarity = 0;
  let pairs = 0;

  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      totalSimilarity += jaccardSimilarity(results[i], results[j]);
      pairs++;
    }
  }

  return pairs > 0 ? totalSimilarity / pairs : 1;
}

// ── Helpers ──────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);

  return union.size > 0 ? intersection.size / union.size : 1;
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function extractChunkIds(parsed: Record<string, unknown> | null): string[] {
  if (!parsed) return [];

  // Navigate the CLI JSON contract to find chunk IDs
  const data = parsed.data as Record<string, unknown> | undefined;
  if (!data) return [];

  const stdout = typeof data.stdout === "string" ? data.stdout : "";
  const chunks = Array.isArray(data.chunks) ? data.chunks : [];

  if (chunks.length > 0) {
    return chunks
      .map((c: Record<string, unknown>) => typeof c.id === "string" ? c.id : "")
      .filter((id: string) => id.length > 0);
  }

  // Fallback: extract IDs from stdout text
  const idMatches = stdout.match(/id["']?\s*[:=]\s*["']([^"']+)["']/g) ?? [];
  return idMatches.map((m: string) => m.replace(/.*["']([^"']+)["'].*/, "$1"));
}

function extractContent(parsed: Record<string, unknown> | null): string {
  if (!parsed) return "";

  const data = parsed.data as Record<string, unknown> | undefined;
  if (!data) return "";

  if (typeof data.stdout === "string") return data.stdout;
  if (typeof data.content === "string") return data.content;

  return JSON.stringify(data);
}

// ── Runner ───────────────────────────────────────────────────────────

export interface EvalRunnerOptions {
  minScore?: number;
  consistencyRuns?: number;
  verbose?: boolean;
}

async function runSingleCase(
  evalCase: EvalCase,
  project: string,
  options: EvalRunnerOptions
): Promise<EvalCaseResult> {
  const startMs = Date.now();

  // Run recall query
  const result = await runCli([
    "recall", "--query", evalCase.query, "--project", project, "--format", "json"
  ]);

  const parsed = tryParseJson(result.stdout ?? "");
  const actualContent = extractContent(parsed);
  const actualChunkIds = extractChunkIds(parsed);

  // Score each metric
  const accuracy = scoreAccuracy(evalCase.expectedAnswer, actualContent);
  const relevance = scoreRelevance(evalCase.expectedChunkIds ?? [], actualChunkIds);
  const consistency = await scoreConsistency(
    evalCase.query,
    project,
    options.consistencyRuns ?? 2
  );

  const scores: Record<EvalMetricName, number> = {
    accuracy: round(accuracy),
    relevance: round(relevance),
    consistency: round(consistency)
  };

  const avgScore = (accuracy + relevance + consistency) / 3;
  const minScore = options.minScore ?? 0.5;

  return {
    caseId: evalCase.id,
    query: evalCase.query,
    passed: avgScore >= minScore,
    scores,
    actualAnswer: actualContent.slice(0, 500),
    actualChunkIds,
    durationMs: Date.now() - startMs
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export async function runEvalSuite(
  suite: EvalSuite,
  options: EvalRunnerOptions = {}
): Promise<EvalReport> {
  const startMs = Date.now();
  const minScore = options.minScore ?? 0.5;
  const results: EvalCaseResult[] = [];

  for (const evalCase of suite.cases) {
    const result = await runSingleCase(evalCase, suite.project, options);
    results.push(result);
  }

  const passedCases = results.filter((r) => r.passed).length;
  const failedCases = results.length - passedCases;

  // Average across all metrics
  const avgScores: Record<EvalMetricName, number> = {
    accuracy: 0,
    relevance: 0,
    consistency: 0
  };

  for (const r of results) {
    avgScores.accuracy += r.scores.accuracy;
    avgScores.relevance += r.scores.relevance;
    avgScores.consistency += r.scores.consistency;
  }

  const n = results.length || 1;
  avgScores.accuracy = round(avgScores.accuracy / n);
  avgScores.relevance = round(avgScores.relevance / n);
  avgScores.consistency = round(avgScores.consistency / n);

  const overallScore = round(
    (avgScores.accuracy + avgScores.relevance + avgScores.consistency) / 3
  );

  return {
    suite: suite.name,
    project: suite.project,
    runAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    totalCases: results.length,
    passedCases,
    failedCases,
    passRate: round(passedCases / (results.length || 1)),
    averageScores: avgScores,
    results,
    ciGate: {
      passed: overallScore >= minScore,
      minimumScore: minScore,
      actualScore: overallScore
    }
  };
}

/**
 * Load an eval suite from a JSON file.
 */
export async function loadEvalSuite(filePath: string): Promise<EvalSuite> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed.name || !parsed.project || !Array.isArray(parsed.cases)) {
    throw new Error(`Invalid eval suite file: must have name, project, and cases array.`);
  }

  return parsed as EvalSuite;
}

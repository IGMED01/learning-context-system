// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").EvalSuite} EvalSuite
 * @typedef {import("../types/core-contracts.d.ts").EvalCase} EvalCase
 * @typedef {import("../types/core-contracts.d.ts").EvalCaseResult} EvalCaseResult
 * @typedef {import("../types/core-contracts.d.ts").EvalReport} EvalReport
 * @typedef {import("../types/core-contracts.d.ts").EvalMetricName} EvalMetricName
 * @typedef {{ minScore?: number, consistencyRuns?: number, verbose?: boolean }} EvalRunnerOptions
 */

import { runCli } from "../cli/app.js";

// ── Metrics ──────────────────────────────────────────────────────────

/**
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/**
 * @param {string} expected
 * @param {string} actual
 * @returns {number}
 */
export function scoreAccuracy(expected, actual) {
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
 * @param {string[]} expectedIds
 * @param {string[]} actualIds
 * @returns {number}
 */
export function scoreRelevance(expectedIds, actualIds) {
  if (expectedIds.length === 0) return 1;

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
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
function jaccardSimilarity(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);

  return union.size > 0 ? intersection.size / union.size : 1;
}

/**
 * @param {string} raw
 * @returns {Record<string, unknown> | null}
 */
function tryParseJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown> | null} parsed
 * @returns {string[]}
 */
function extractChunkIds(parsed) {
  if (!parsed) return [];

  const data = /** @type {Record<string, unknown> | undefined} */ (parsed.data);
  if (!data) return [];

  const chunks = Array.isArray(data.chunks) ? data.chunks : [];

  if (chunks.length > 0) {
    return chunks
      .map((/** @type {Record<string, unknown>} */ c) => typeof c.id === "string" ? c.id : "")
      .filter((/** @type {string} */ id) => id.length > 0);
  }

  const stdout = typeof data.stdout === "string" ? data.stdout : "";
  const idMatches = stdout.match(/id["']?\s*[:=]\s*["']([^"']+)["']/g) ?? [];
  return idMatches.map((/** @type {string} */ m) => m.replace(/.*["']([^"']+)["'].*/, "$1"));
}

/**
 * @param {Record<string, unknown> | null} parsed
 * @returns {string}
 */
function extractContent(parsed) {
  if (!parsed) return "";

  const data = /** @type {Record<string, unknown> | undefined} */ (parsed.data);
  if (!data) return "";

  if (typeof data.stdout === "string") return data.stdout;
  if (typeof data.content === "string") return data.content;

  return JSON.stringify(data);
}

/**
 * @param {number} n
 * @returns {number}
 */
function round(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * @param {string} query
 * @param {string} project
 * @param {number} [runs]
 * @returns {Promise<number>}
 */
export async function scoreConsistency(query, project, runs = 3) {
  /** @type {string[][]} */
  const results = [];

  for (let i = 0; i < runs; i++) {
    const result = await runCli([
      "recall", "--query", query, "--project", project, "--format", "json"
    ]);

    const parsed = tryParseJson(result.stdout ?? "");
    const chunkIds = extractChunkIds(parsed);
    results.push(chunkIds);
  }

  if (results.length < 2) return 1;

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

// ── Runner ───────────────────────────────────────────────────────────

/**
 * @param {EvalCase} evalCase
 * @param {string} project
 * @param {EvalRunnerOptions} options
 * @returns {Promise<EvalCaseResult>}
 */
async function runSingleCase(evalCase, project, options) {
  const startMs = Date.now();

  const result = await runCli([
    "recall", "--query", evalCase.query, "--project", project, "--format", "json"
  ]);

  const parsed = tryParseJson(result.stdout ?? "");
  const actualContent = extractContent(parsed);
  const actualChunkIds = extractChunkIds(parsed);

  const accuracy = scoreAccuracy(evalCase.expectedAnswer, actualContent);
  const relevance = scoreRelevance(evalCase.expectedChunkIds ?? [], actualChunkIds);
  const consistency = await scoreConsistency(
    evalCase.query,
    project,
    options.consistencyRuns ?? 2
  );

  /** @type {Record<EvalMetricName, number>} */
  const scores = {
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

/**
 * @param {EvalSuite} suite
 * @param {EvalRunnerOptions} [options]
 * @returns {Promise<EvalReport>}
 */
export async function runEvalSuite(suite, options = {}) {
  const startMs = Date.now();
  const minScore = options.minScore ?? 0.5;
  /** @type {EvalCaseResult[]} */
  const results = [];

  for (const evalCase of suite.cases) {
    const result = await runSingleCase(evalCase, suite.project, options);
    results.push(result);
  }

  const passedCases = results.filter((r) => r.passed).length;
  const failedCases = results.length - passedCases;

  /** @type {Record<EvalMetricName, number>} */
  const avgScores = { accuracy: 0, relevance: 0, consistency: 0 };

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
 * @param {string} filePath
 * @returns {Promise<EvalSuite>}
 */
export async function loadEvalSuite(filePath) {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed.name || !parsed.project || !Array.isArray(parsed.cases)) {
    throw new Error("Invalid eval suite file: must have name, project, and cases array.");
  }

  return /** @type {EvalSuite} */ (parsed);
}

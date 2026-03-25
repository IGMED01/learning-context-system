// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").RollbackCheck} RollbackCheck
 * @typedef {import("../types/core-contracts.d.ts").EvalSuite} EvalSuite
 * @typedef {{ dropThreshold?: number, evalSuite: EvalSuite, project: string, promptName: string, baseDir?: string }} RollbackEngineOptions
 */

import { runEvalSuite } from "../eval/eval-runner.js";
import { getPromptHistory, rollbackPrompt } from "./prompt-versioning.js";
import { saveSnapshot, getScoreTrend } from "./context-snapshot.js";

/**
 * @param {RollbackEngineOptions} options
 * @returns {Promise<RollbackCheck>}
 */
export async function checkAndRollback(options) {
  const threshold = options.dropThreshold ?? 0.10;

  const trend = await getScoreTrend(options.project, 2, options.baseDir);
  const previousScore = trend.length > 0 ? trend[0].evalScore : 1.0;

  const report = await runEvalSuite(options.evalSuite, { minScore: 0 });
  const currentScore = report.ciGate.actualScore;

  const dropPercent = previousScore > 0
    ? (previousScore - currentScore) / previousScore
    : 0;

  await saveSnapshot({
    project: options.project,
    command: "rollback-check",
    query: `eval:${options.evalSuite.name}`,
    selectedChunkIds: [],
    evalScore: currentScore,
    promptVersionId: options.promptName
  });

  if (dropPercent > threshold) {
    const history = await getPromptHistory(options.promptName, options.baseDir);
    const previousVersion = history.currentVersion - 1;

    /** @type {number | undefined} */
    let rolledBackTo;

    if (previousVersion >= 1) {
      const rollbackResult = await rollbackPrompt(options.promptName, previousVersion, options.baseDir);
      rolledBackTo = rollbackResult?.version;
    }

    return {
      shouldRollback: true,
      reason: `Eval score dropped ${(dropPercent * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(1)}%)`,
      previousScore,
      currentScore,
      dropPercent: Math.round(dropPercent * 1000) / 1000,
      threshold,
      rolledBackTo
    };
  }

  return {
    shouldRollback: false,
    reason: dropPercent > 0
      ? `Score dropped ${(dropPercent * 100).toFixed(1)}% but within threshold (${(threshold * 100).toFixed(1)}%)`
      : "Score stable or improved",
    previousScore,
    currentScore,
    dropPercent: Math.round(dropPercent * 1000) / 1000,
    threshold
  };
}

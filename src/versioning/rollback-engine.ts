/**
 * Rollback Engine — S8: Automatic rollback when eval scores drop.
 *
 * The core safety net: when a prompt or config change causes
 * eval scores to drop more than a threshold (default 10%),
 * automatically rollback to the previous version.
 *
 * Flow:
 *   1. Save new prompt version
 *   2. Run eval suite
 *   3. Compare score to previous snapshot
 *   4. If drop > threshold → rollback prompt + notify
 *   5. Save context snapshot with result
 */

import type { RollbackCheck, EvalSuite } from "../types/core-contracts.d.ts";

import { runEvalSuite } from "../eval/eval-runner.js";
import { getPromptHistory, rollbackPrompt } from "./prompt-versioning.js";
import { saveSnapshot, getScoreTrend } from "./context-snapshot.js";

export interface RollbackEngineOptions {
  dropThreshold?: number;  // Default 0.10 (10%)
  evalSuite: EvalSuite;
  project: string;
  promptName: string;
  baseDir?: string;
}

export async function checkAndRollback(options: RollbackEngineOptions): Promise<RollbackCheck> {
  const threshold = options.dropThreshold ?? 0.10;

  // 1. Get previous score from trend
  const trend = await getScoreTrend(options.project, 2, options.baseDir);
  const previousScore = trend.length > 0 ? trend[0].evalScore : 1.0;

  // 2. Run eval suite with current config
  const report = await runEvalSuite(options.evalSuite, { minScore: 0 });
  const currentScore = report.ciGate.actualScore;

  // 3. Calculate drop
  const dropPercent = previousScore > 0
    ? (previousScore - currentScore) / previousScore
    : 0;

  // 4. Save snapshot regardless
  await saveSnapshot({
    project: options.project,
    command: "rollback-check",
    query: `eval:${options.evalSuite.name}`,
    selectedChunkIds: [],
    evalScore: currentScore,
    promptVersionId: options.promptName
  });

  // 5. Check if rollback needed
  if (dropPercent > threshold) {
    // Find the version before the current one
    const history = await getPromptHistory(options.promptName, options.baseDir);
    const previousVersion = history.currentVersion - 1;

    let rolledBackTo: number | undefined;

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

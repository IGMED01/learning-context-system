// @ts-check

import { buildRollbackPlan } from "./rollback-engine.js";

/**
 * NEXUS:9 — policy wrapper for rollback planning.
 * @param {{
 *   minScore?: number,
 *   preferPrevious?: boolean,
 *   requireAtLeastVersions?: number
 * }} [options]
 */
export function createRollbackPolicy(options = {}) {
  const minScore =
    typeof options.minScore === "number" && Number.isFinite(options.minScore)
      ? Math.max(0, Math.min(1, options.minScore))
      : 0.75;
  const preferPrevious = options.preferPrevious !== false;
  const requireAtLeastVersions = Math.max(
    1,
    Math.min(20, Math.trunc(Number(options.requireAtLeastVersions ?? 2)))
  );

  return {
    minScore,
    preferPrevious,
    requireAtLeastVersions,

    /**
     * @param {{ listVersions: (promptKey: string) => Promise<Array<{ id: string, version: number, createdAt: string }>> }} store
     * @param {{
     *   promptKey: string,
     *   evalScoresByVersion?: Record<string, number>,
     *   minScore?: number,
     *   preferPrevious?: boolean
     * }} input
     */
    async buildPlan(store, input) {
      const list = await store.listVersions(input.promptKey);

      if (list.length < requireAtLeastVersions) {
        return {
          promptKey: input.promptKey,
          status: "insufficient-history",
          required: requireAtLeastVersions,
          available: list.length,
          selected: null,
          considered: list.map((entry) => ({
            id: entry.id,
            version: entry.version,
            score: 0
          }))
        };
      }

      return buildRollbackPlan(store, {
        promptKey: input.promptKey,
        evalScoresByVersion: input.evalScoresByVersion,
        minScore:
          typeof input.minScore === "number" && Number.isFinite(input.minScore)
            ? input.minScore
            : minScore,
        preferPrevious:
          typeof input.preferPrevious === "boolean" ? input.preferPrevious : preferPrevious
      });
    }
  };
}
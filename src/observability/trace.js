// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").RequestTrace} RequestTrace
 * @typedef {import("../types/core-contracts.d.ts").TraceLayer} TraceLayer
 * @typedef {{ end(metadata?: Record<string, unknown>): void }} LayerSpan
 * @typedef {{ readonly traceId: string, readonly command: string, startLayer(name: string): LayerSpan, finish(outcome: RequestTrace["outcome"], error?: string): void, toJSON(): RequestTrace }} Trace
 */

import { randomUUID } from "node:crypto";

/**
 * @param {string} command
 * @returns {Trace}
 */
export function createTrace(command) {
  const traceId = randomUUID();
  const startedAt = new Date();
  const baseMs = Date.now();
  /** @type {TraceLayer[]} */
  const layers = [];
  /** @type {RequestTrace["outcome"]} */
  let finalOutcome = "success";
  /** @type {string | undefined} */
  let finalError;
  let finishedMs = 0;

  return {
    traceId,
    command,

    /** @param {string} name @returns {LayerSpan} */
    startLayer(name) {
      const layerStartMs = Date.now() - baseMs;

      return {
        /** @param {Record<string, unknown>} [metadata] */
        end(metadata) {
          const layerEndMs = Date.now() - baseMs;
          layers.push({
            name,
            startMs: layerStartMs,
            endMs: layerEndMs,
            durationMs: layerEndMs - layerStartMs,
            metadata
          });
        }
      };
    },

    /** @param {RequestTrace["outcome"]} outcome @param {string} [error] */
    finish(outcome, error) {
      finalOutcome = outcome;
      finalError = error;
      finishedMs = Date.now();
    },

    /** @returns {RequestTrace} */
    toJSON() {
      const endMs = finishedMs || Date.now();
      return {
        traceId,
        command,
        startedAt: startedAt.toISOString(),
        durationMs: endMs - baseMs,
        layers,
        outcome: finalOutcome,
        error: finalError
      };
    }
  };
}

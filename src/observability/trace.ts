/**
 * Request Tracing — S6: Structured per-request traces.
 *
 * Tracks time spent in each layer of the pipeline:
 *   guard → recall → selection → response
 *
 * Every request gets a unique traceId. Layers are timed
 * individually and the full trace is emitted as structured JSON.
 *
 * Usage:
 *   const trace = createTrace("recall");
 *   const guardSpan = trace.startLayer("guard");
 *   // ... do guard work ...
 *   guardSpan.end();
 *   trace.finish("success");
 *   console.log(trace.toJSON());
 */

import type { RequestTrace, TraceLayer } from "../types/core-contracts.d.ts";

import { randomUUID } from "node:crypto";

export interface LayerSpan {
  end(metadata?: Record<string, unknown>): void;
}

export interface Trace {
  readonly traceId: string;
  readonly command: string;
  startLayer(name: string): LayerSpan;
  finish(outcome: RequestTrace["outcome"], error?: string): void;
  toJSON(): RequestTrace;
}

export function createTrace(command: string): Trace {
  const traceId = randomUUID();
  const startedAt = new Date();
  const baseMs = Date.now();
  const layers: TraceLayer[] = [];
  let finalOutcome: RequestTrace["outcome"] = "success";
  let finalError: string | undefined;
  let finishedMs = 0;

  return {
    traceId,
    command,

    startLayer(name: string): LayerSpan {
      const layerStartMs = Date.now() - baseMs;

      return {
        end(metadata?: Record<string, unknown>) {
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

    finish(outcome: RequestTrace["outcome"], error?: string) {
      finalOutcome = outcome;
      finalError = error;
      finishedMs = Date.now();
    },

    toJSON(): RequestTrace {
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

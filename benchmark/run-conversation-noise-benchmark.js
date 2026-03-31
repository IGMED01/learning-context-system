#!/usr/bin/env node
// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  addTurn,
  buildConversationContext,
  createSession,
  getConversationNoiseTelemetry,
  resetAllSessions
} from "../src/orchestration/conversation-manager.js";
import {
  evaluateConversationNoiseGate,
  formatConversationNoiseGateReport
} from "../src/eval/conversation-noise-gate.js";

/**
 * @param {string[]} argv
 * @param {string} key
 * @param {string} fallback
 */
function option(argv, key, fallback) {
  const index = argv.indexOf(`--${key}`);
  if (index === -1) {
    return fallback;
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    return fallback;
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [range]
 */
function toInt(value, fallback, range = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const normalized = Math.trunc(parsed);
  const min = range.min ?? Number.MIN_SAFE_INTEGER;
  const max = range.max ?? Number.MAX_SAFE_INTEGER;
  return Math.max(min, Math.min(max, normalized));
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [range]
 */
function toFloat(value, fallback, range = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const min = range.min ?? Number.MIN_SAFE_INTEGER;
  const max = range.max ?? Number.MAX_SAFE_INTEGER;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * @param {number[]} values
 * @param {number} pct
 */
function percentile(values, pct) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((Math.max(0, Math.min(100, pct)) / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

/**
 * @param {string} text
 */
function estimateTokens(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.ceil(normalized.length / 4));
}

/**
 * @param {string} role
 * @param {number} turn
 * @param {string | undefined} anchor
 */
function buildTurnContent(role, turn, anchor) {
  const commonNoise =
    role === "user"
      ? "Necesito contexto general del proyecto y repetir lineamientos sin cambios."
      : "Respuesta general: aplicar validación, tests y políticas de seguridad.";
  const repeatedNoise = "NOISE_DUPLICATE: repetir resumen operativo base.";
  const signal =
    role === "user"
      ? "Signal: revisar auth boundary y orden de validación."
      : "Signal: confirmar 401 en token inválido y mantener trazabilidad.";
  const pulse = "";
  const anchorLine = anchor ? `${anchor} -> conservar este dato crítico en contexto.` : "";

  return [commonNoise, repeatedNoise, signal, pulse, anchorLine].filter(Boolean).join(" ");
}

/**
 * @param {Record<string, string | undefined>} patch
 * @param {() => Promise<unknown>} run
 */
async function withPatchedEnv(patch, run) {
  /** @type {Record<string, string | undefined>} */
  const previous = {};

  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * @param {{
 *   turns: number,
 *   contextWindowTurns: number,
 *   measureAfterTurn: number,
 *   anchors: Array<{ turn: number, label: string }>,
 *   env: {
 *     summaryEvery: number,
 *     summaryKeepTurns: number,
 *     maxTurns: number,
 *     contextMaxChars: number
 *   },
 *   scenarioName: string
 * }} input
 */
async function runScenario(input) {
  resetAllSessions();

  return withPatchedEnv(
    {
      LCS_CONVERSATION_SUMMARY_EVERY: String(input.env.summaryEvery),
      LCS_CONVERSATION_SUMMARY_KEEP_TURNS: String(input.env.summaryKeepTurns),
      LCS_CONVERSATION_MAX_TURNS: String(input.env.maxTurns),
      LCS_CONVERSATION_CONTEXT_MAX_CHARS: String(input.env.contextMaxChars)
    },
    async () => {
      const session = createSession(`conversation-noise-${input.scenarioName}`);
      const activeAnchors = input.anchors
        .map((entry) => ({
          turn: toInt(entry.turn, 0, { min: 1 }),
          label: String(entry.label ?? "").trim()
        }))
        .filter((entry) => entry.turn > 0 && entry.label);

      /** @type {number[]} */
      const tokensSeries = [];
      let anchorChecks = 0;
      let anchorHits = 0;

      for (let turn = 1; turn <= input.turns; turn += 1) {
        const role = turn % 2 === 1 ? "user" : "system";
        const anchor = activeAnchors.find((entry) => entry.turn === turn)?.label;
        const content = buildTurnContent(role, turn, anchor);
        addTurn(session.sessionId, role, content, {
          turn,
          scenario: input.scenarioName
        });

        const context = buildConversationContext(session.sessionId, input.contextWindowTurns);
        const contextTokens = estimateTokens(context);
        if (turn > input.measureAfterTurn) {
          tokensSeries.push(contextTokens);
        }

        const expectedAnchors = activeAnchors.filter((entry) => entry.turn <= turn);
        for (const expected of expectedAnchors) {
          anchorChecks += 1;
          if (context.includes(expected.label)) {
            anchorHits += 1;
          }
        }
      }

      const telemetry = getConversationNoiseTelemetry(session.sessionId);
      const contextP95Tokens = Math.max(0, Math.round(percentile(tokensSeries, 95)));
      const anchorHitRate = anchorChecks > 0 ? anchorHits / anchorChecks : 1;

      return {
        turns: input.turns,
        contextP95Tokens,
        anchorHitRate,
        noiseRatio: Number(telemetry.noise_ratio ?? 0),
        redundancyRatio: Number(telemetry.redundancy_ratio ?? 0),
        contextHalfLife: Number(telemetry.context_half_life ?? 1)
      };
    }
  );
}

/**
 * @param {string} raw
 * @param {string} sourceLabel
 */
function parseBenchmark(raw, sourceLabel) {
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(
      `${sourceLabel} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  assertObject(parsed, sourceLabel);
  const payload = /** @type {Record<string, unknown>} */ (parsed);
  const thresholdsRaw =
    payload.thresholds && typeof payload.thresholds === "object" && !Array.isArray(payload.thresholds)
      ? /** @type {Record<string, unknown>} */ (payload.thresholds)
      : {};
  const baselineRaw =
    payload.baseline && typeof payload.baseline === "object" && !Array.isArray(payload.baseline)
      ? /** @type {Record<string, unknown>} */ (payload.baseline)
      : {};
  const optimizedRaw =
    payload.optimized && typeof payload.optimized === "object" && !Array.isArray(payload.optimized)
      ? /** @type {Record<string, unknown>} */ (payload.optimized)
      : {};

  const anchors = Array.isArray(payload.anchors)
    ? payload.anchors
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => /** @type {Record<string, unknown>} */ (entry))
        .map((entry) => ({
          turn: toInt(entry.turn, 0, { min: 1 }),
          label: String(entry.label ?? "").trim()
        }))
        .filter((entry) => entry.turn > 0 && entry.label)
    : [];

  return {
    suite: typeof payload.suite === "string" ? payload.suite : "conversation-noise",
    turns: toInt(payload.turns, 100, { min: 20, max: 600 }),
    contextWindowTurns: toInt(payload.contextWindowTurns, 100, { min: 1, max: 600 }),
    measureAfterTurn: toInt(payload.measureAfterTurn, 40, { min: 1, max: 590 }),
    anchors,
    thresholds: {
      minTokenReduction: toFloat(thresholdsRaw.minTokenReduction, 0.25, { min: 0, max: 1 }),
      minOptimizedAnchorHitRate: toFloat(thresholdsRaw.minOptimizedAnchorHitRate, 0.9, { min: 0, max: 1 }),
      maxAnchorHitRateDrop: toFloat(thresholdsRaw.maxAnchorHitRateDrop, 0.05, { min: 0, max: 1 }),
      minRedundancyRatio: toFloat(thresholdsRaw.minRedundancyRatio, 0.6, { min: 0, max: 1 })
    },
    baseline: {
      summaryEvery: toInt(baselineRaw.summaryEvery, 0, { min: 0, max: 500 }),
      summaryKeepTurns: toInt(baselineRaw.summaryKeepTurns, 8, { min: 1, max: 200 }),
      maxTurns: toInt(baselineRaw.maxTurns, 240, { min: 1, max: 1000 }),
      contextMaxChars: toInt(baselineRaw.contextMaxChars, 12_000, { min: 500, max: 20_000 })
    },
    optimized: {
      summaryEvery: toInt(optimizedRaw.summaryEvery, 8, { min: 0, max: 500 }),
      summaryKeepTurns: toInt(optimizedRaw.summaryKeepTurns, 8, { min: 1, max: 200 }),
      maxTurns: toInt(optimizedRaw.maxTurns, 120, { min: 1, max: 1000 }),
      contextMaxChars: toInt(optimizedRaw.contextMaxChars, 12_000, { min: 500, max: 20_000 })
    }
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const format = option(argv, "format", "text").toLowerCase();
  const filePath = path.resolve(option(argv, "file", "benchmark/conversation-noise-benchmark.json"));

  if (format !== "text" && format !== "json") {
    throw new Error("Option --format must be 'text' or 'json'.");
  }

  const raw = await readFile(filePath, "utf8");
  const benchmark = parseBenchmark(raw, filePath);

  const baseline = await runScenario({
    turns: benchmark.turns,
    contextWindowTurns: benchmark.contextWindowTurns,
    measureAfterTurn: benchmark.measureAfterTurn,
    anchors: benchmark.anchors,
    env: benchmark.baseline,
    scenarioName: "baseline"
  });
  const optimized = await runScenario({
    turns: benchmark.turns,
    contextWindowTurns: benchmark.contextWindowTurns,
    measureAfterTurn: benchmark.measureAfterTurn,
    anchors: benchmark.anchors,
    env: benchmark.optimized,
    scenarioName: "optimized"
  });

  const report = evaluateConversationNoiseGate({
    baseline,
    optimized,
    thresholds: benchmark.thresholds
  });
  const output = {
    suite: benchmark.suite,
    source: filePath,
    ...report
  };

  if (format === "json") {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(formatConversationNoiseGateReport(report));
  }

  if (!report.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

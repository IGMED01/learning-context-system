// @ts-check

import { selectContextWindow } from "../context/noise-canceler.js";
import { selectEndpointContext } from "../context/context-mode.js";

/** @typedef {import("../types/core-contracts.d.ts").Chunk} Chunk */
/** @typedef {import("../types/core-contracts.d.ts").SelectedChunk} SelectedChunk */
/** @typedef {import("../types/core-contracts.d.ts").PacketChunk} PacketChunk */
/** @typedef {import("../types/core-contracts.d.ts").PacketSuppressedChunk} PacketSuppressedChunk */
/** @typedef {import("../types/core-contracts.d.ts").TeachingSections} TeachingSections */
/** @typedef {import("../types/core-contracts.d.ts").LearningPacket} LearningPacket */
/** @typedef {import("../types/core-contracts.d.ts").ContextSelectionResult} ContextSelectionResult */

/**
 * @param {Array<Record<string, unknown>>} chunks
 */
function summarizeOrigins(chunks) {
  /** @type {Record<string, number>} */
  const counts = {};

  for (const chunk of chunks) {
    const origin = String(chunk.origin ?? "unknown").trim() || "unknown";
    counts[origin] = (counts[origin] ?? 0) + 1;
  }

  return counts;
}

/**
 * @param {Array<{ reason?: string }>} chunks
 */
function summarizeReasons(chunks) {
  /** @type {Record<string, number>} */
  const counts = {};

  for (const chunk of chunks) {
    const reason = String(chunk.reason ?? "unknown").trim() || "unknown";
    counts[reason] = (counts[reason] ?? 0) + 1;
  }

  return counts;
}

/**
 * @param {unknown} error
 */
function classifySelectorReason(error) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("timeout")) {
    return "timeout";
  }

  return "selector-error";
}

/**
 * @param {string} source
 */
function normalizeSource(source = "") {
  return String(source).replace(/\\/gu, "/").toLowerCase();
}

/**
 * @param {string} source
 * @param {string[]} [changedFiles]
 */
function sourceTouchesChangedFile(source, changedFiles = []) {
  const normalizedSource = normalizeSource(source);

  return changedFiles.some((file) => {
    const normalizedFile = normalizeSource(file);
    return (
      normalizedSource === normalizedFile ||
      normalizedSource.endsWith(`/${normalizedFile}`) ||
      normalizedSource.includes(normalizedFile)
    );
  });
}

/**
 * @param {string} content
 */
function extractMemoryType(content = "") {
  const match = String(content).match(/Memory type:\s*([^.]+)/iu);
  return match?.[1]?.trim().toLowerCase() ?? "memory";
}

/**
 * @param {SelectedChunk} chunk
 * @param {boolean} [debug]
 * @returns {PacketChunk}
 */
function toPacketChunk(chunk, debug = false) {
  return {
    id: chunk.id,
    source: chunk.source,
    kind: chunk.kind,
    origin: chunk.origin,
    score: Number(chunk.score.toFixed(3)),
    content: chunk.content,
    ...(chunk.kind === "memory" ? { memoryType: extractMemoryType(chunk.content) } : {}),
    ...(debug
      ? {
          tokenCount: chunk.tokenCount,
          diagnostics: chunk.diagnostics
        }
      : {})
  };
}

/**
 * @param {PacketChunk[]} selectedContext
 * @param {string[]} [changedFiles]
 * @returns {TeachingSections}
 */
function summarizeTeachingSections(selectedContext, changedFiles = []) {
  const codeFocus =
    selectedContext.find(
      (chunk) => chunk.kind === "code" && sourceTouchesChangedFile(chunk.source, changedFiles)
    ) ??
    selectedContext.find((chunk) => chunk.kind === "code") ??
    null;
  const relatedTests = selectedContext.filter((chunk) => chunk.kind === "test");
  const historicalMemory = selectedContext.filter((chunk) => chunk.kind === "memory");
  const supportingContext = selectedContext.filter(
    (chunk) => chunk.id !== codeFocus?.id && chunk.kind !== "test" && chunk.kind !== "memory"
  );
  /** @type {string[]} */
  const flow = [];

  if (codeFocus) {
    flow.push(`Empeza por ${codeFocus.source}: es el ancla del cambio.`);
  }

  if (relatedTests[0]) {
    flow.push(`Valida con ${relatedTests[0].source}: confirma el comportamiento esperado.`);
  }

  if (historicalMemory[0]) {
    const memoryType = historicalMemory[0].memoryType ?? "memory";
    flow.push(
      `Usa ${historicalMemory[0].source} como contexto historico (${memoryType}), no como reemplazo del codigo actual.`
    );
  }

  return {
    codeFocus,
    relatedTests,
    historicalMemory,
    supportingContext,
    flow
  };
}

/**
 * @param {{
 *   task: string,
 *   focus?: string,
 *   objective: string,
 *   changedFiles?: string[],
 *   chunks?: Chunk[],
 *   tokenBudget?: number,
 *   maxChunks?: number,
 *   minScore?: number,
 *   sentenceBudget?: number,
 *   language?: string,
 *   framework?: string,
 *   sddProfile?: string,
 *   selector?: typeof selectEndpointContext,
  *   debug?: boolean
 * }} input
 * @returns {LearningPacket}
 */
export function buildLearningPacket(input) {
  const {
    task,
    focus,
    objective,
    changedFiles = [],
    chunks = [],
    tokenBudget = 350,
    maxChunks,
    minScore,
    sentenceBudget,
    language,
    framework,
    sddProfile,
    selector = selectEndpointContext,
    debug = false
  } = input;
  const focusQuery = focus || `${task} ${objective}`.trim();
  const normalizedChunks = Array.isArray(chunks) ? chunks : [];

  /** @type {ContextSelectionResult} */
  let context;
  /** @type {"ok" | "degraded"} */
  let selectorStatus = "ok";
  let selectorReason = "";
  let sddDiagnostics;

  try {
    const selected = selector({
      endpoint: "teach",
      query: focusQuery,
      chunks: normalizedChunks,
      changedFiles,
      language,
      framework,
      sddProfile,
      forceSelection: true,
      profileOverrides: {
        tokenBudget,
        maxChunks: typeof maxChunks === "number" ? maxChunks : 6,
        minScore,
        sentenceBudget,
        sourceBudgets: {
          chat: 0
        }
      }
    });

    context = {
      focus: focusQuery,
      tokenBudget: selected.profile.tokenBudget,
      usedTokens: selected.usedTokens,
      selected: /** @type {SelectedChunk[]} */ (selected.selectedChunks),
      suppressed: /** @type {import("../types/core-contracts.d.ts").SuppressedChunk[]} */ (
        selected.suppressedChunks
      ),
      summary: {
        selectedCount: selected.selectedChunks.length,
        suppressedCount: selected.suppressedChunks.length,
        selectedOrigins: summarizeOrigins(
          /** @type {Record<string, unknown>[]} */ (selected.selectedChunks)
        ),
        suppressedOrigins: summarizeOrigins(
          /** @type {Record<string, unknown>[]} */ (selected.suppressedChunks)
        ),
        suppressionReasons: summarizeReasons(selected.suppressedChunks)
      }
    };
    sddDiagnostics = selected.sdd;
  } catch (error) {
    selectorStatus = "degraded";
    selectorReason = classifySelectorReason(error);
    context = /** @type {ContextSelectionResult} */ (
      selectContextWindow(normalizedChunks, {
        focus: focusQuery,
        tokenBudget,
        maxChunks,
        minScore,
        sentenceBudget,
        changedFiles
      })
    );
  }
  const selectedContext = context.selected.map(
    /** @param {SelectedChunk} chunk */ (chunk) => toPacketChunk(chunk, debug)
  );
  const teachingSections = summarizeTeachingSections(selectedContext, changedFiles);

  return {
    objective,
    task,
    changedFiles,
    teachingChecklist: [
      "Explicar primero la intencion del cambio.",
      "Relacionar cada fragmento con un concepto tecnico.",
      "Mostrar el trade-off principal de la solucion.",
      "Cerrar con una practica corta o siguiente paso."
    ],
    teachingSections,
    selectedContext,
    suppressedContext: context.suppressed.map(
      /** @param {import("../types/core-contracts.d.ts").SuppressedChunk} chunk */ (chunk) =>
        /** @type {PacketSuppressedChunk} */ ({
          id: chunk.id,
          reason: chunk.reason,
          score: chunk.score,
          origin: chunk.origin,
          ...(debug
            ? {
                source: chunk.source,
                kind: chunk.kind,
                tokenCount: chunk.tokenCount,
                diagnostics: chunk.diagnostics
              }
            : {})
        })
    ),
    diagnostics: {
      focus: context.focus,
      tokenBudget: context.tokenBudget,
      usedTokens: context.usedTokens,
      summary: context.summary,
      selectorStatus,
      ...(selectorReason ? { selectorReason } : {}),
      ...(sddDiagnostics ? { sdd: sddDiagnostics } : {})
    }
  };
}

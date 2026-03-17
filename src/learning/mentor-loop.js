import { selectContextWindow } from "../context/noise-canceler.js";

function normalizeSource(source = "") {
  return String(source).replace(/\\/gu, "/").toLowerCase();
}

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

function extractMemoryType(content = "") {
  const match = String(content).match(/Memory type:\s*([^.]+)/iu);
  return match?.[1]?.trim().toLowerCase() ?? "memory";
}

function toPacketChunk(chunk, debug = false) {
  return {
    id: chunk.id,
    source: chunk.source,
    kind: chunk.kind,
    score: Number(chunk.score.toFixed(3)),
    content: chunk.content,
    ...(chunk.kind === "memory" ? { memoryType: extractMemoryType(chunk.content) } : {}),
    ...(debug
      ? {
          origin: chunk.origin,
          tokenCount: chunk.tokenCount,
          diagnostics: chunk.diagnostics
        }
      : {})
  };
}

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
    (chunk) =>
      chunk.id !== codeFocus?.id &&
      chunk.kind !== "test" &&
      chunk.kind !== "memory"
  );
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
    debug = false
  } = input;

  const context = selectContextWindow(chunks, {
    focus: focus || `${task} ${objective}`.trim(),
    tokenBudget,
    maxChunks,
    minScore,
    sentenceBudget,
    changedFiles
  });
  const selectedContext = context.selected.map((chunk) => toPacketChunk(chunk, debug));
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
    suppressedContext: context.suppressed.map((chunk) => ({
      id: chunk.id,
      reason: chunk.reason,
      score: chunk.score,
      ...(debug
        ? {
            source: chunk.source,
            kind: chunk.kind,
            origin: chunk.origin,
            tokenCount: chunk.tokenCount,
            diagnostics: chunk.diagnostics
          }
        : {})
    })),
    diagnostics: {
      focus: context.focus,
      tokenBudget: context.tokenBudget,
      usedTokens: context.usedTokens,
      summary: context.summary
    }
  };
}

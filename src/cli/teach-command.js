// @ts-check

import { buildLearningPacket } from "../learning/mentor-loop.js";
import { createLocalMemoryStore } from "../memory/local-memory-store.js";
import { createResilientMemoryClient } from "../memory/resilient-memory-client.js";
import {
  buildAcceptedMemoryMetadata,
  evaluateMemoryWrite,
  quarantineMemoryWrite
} from "../memory/memory-hygiene.js";
import {
  buildTeachAutoRememberPayload,
  resolveAutoTeachRecall
} from "../memory/memory-auto-orchestrator.js";
import { createAxiomInjector } from "../memory/axiom-injector.js";
import { legacySearchStdoutToEntries } from "../memory/memory-utils.js";
import { formatLearningPacketAsText } from "./formatters.js";
import {
  assertNumberRules,
  listOption,
  numberOption,
  requireOption
} from "./arg-parser.js";

/** @typedef {import("../types/core-contracts.d.ts").ScanStats} ScanStats */
/** @typedef {import("../types/core-contracts.d.ts").RuntimeMeta} RuntimeMeta */
/** @typedef {import("../types/core-contracts.d.ts").LearningPacket} LearningPacket */
/** @typedef {import("../types/core-contracts.d.ts").MemoryRecallState} MemoryRecallState */
/** @typedef {import("../contracts/context-contracts.js").ChunkFile} ChunkFile */

/**
 * @typedef {Record<string, string>} CliOptions
 */

/**
 * @typedef {Awaited<ReturnType<typeof import("../io/config-file.js").loadProjectConfig>>} LoadedConfigInfo
 */

/**
 * @typedef {MemoryRecallState & {
 *   selectedChunkIds?: string[],
 *   suppressedChunkIds?: string[]
 * }} RenderMemoryRecallState
 */

/**
 * @typedef {LearningPacket & {
 *   scanStats?: ScanStats,
 *   memoryRecall: RenderMemoryRecallState,
 *   autoMemory?: {
 *     autoRecallEnabled: boolean,
 *     autoRememberEnabled: boolean,
 *     rememberAttempted: boolean,
 *     rememberSaved: boolean,
 *     rememberStatus?: string,
 *     rememberTitle: string,
 *     rememberError: string,
 *     rememberRedactionCount: number,
 *     rememberSensitivePathCount: number
 *   },
 *   debug?: {
 *     selectedOrigins: Record<string, number>,
 *     suppressedOrigins: Record<string, number>,
 *     suppressionReasons: Record<string, number>
 *   }
 * }} LearningPacketWithMemory
 */

/**
 * @typedef {{
 *   tokenBudget: number,
 *   maxChunks: number,
 *   minScore: number,
 *   sentenceBudget: number
 * }} NumericOptions
 */

/**
 * @typedef {{
 *   path: string,
 *   payload: ChunkFile,
 *   stats?: ScanStats
 * }} ChunkSourceResult
 */

/**
 * @typedef {{
 *   memoryClient?: ReturnType<typeof createResilientMemoryClient>,
 *   engramClient?: ReturnType<typeof createResilientMemoryClient>,
 *   axiomInjector?: { retrieve?: (context?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>> }
 * }} AppDependencies
 */

/**
 * @param {AppDependencies} [dependencies]
 */
function getInjectedMemoryClient(dependencies = {}) {
  if (dependencies.memoryClient) {
    return dependencies.memoryClient;
  }

  if (dependencies.engramClient) {
    return dependencies.engramClient;
  }

  return null;
}

/**
 * @typedef {{
 *   options: CliOptions,
 *   loadedConfig: LoadedConfigInfo,
 *   source: ChunkSourceResult,
 *   numeric: NumericOptions,
 *   format: "json" | "text",
 *   debugEnabled: boolean,
 *   startedAt: number,
 *   dependencies?: AppDependencies,
 *   serializeCommandResult: (
 *     command: string,
 *     payload: object | string,
 *     format: "json" | "text",
 *     configInfo: LoadedConfigInfo,
 *     meta?: Partial<import("../types/core-contracts.d.ts").CliContractMeta>
 *   ) => string,
 *   buildRuntimeMeta: (
 *     startedAt: number,
 *     options?: {
 *       debug?: boolean,
 *       scanStats?: ScanStats | null
 *     }
 *   ) => RuntimeMeta
 * }} RunTeachCommandInput
 */

/**
 * @param {AppDependencies} [dependencies]
 * @returns {ReturnType<typeof createResilientMemoryClient>}
 */
function getMemoryClient(options, dependencies = {}) {
  const injectedMemoryClient = getInjectedMemoryClient(dependencies);
  if (injectedMemoryClient) {
    return injectedMemoryClient;
  }

  const local = createLocalMemoryStore({
    filePath: options["memory-fallback-file"],
    baseDir: options["memory-base-dir"]
  });

  return createResilientMemoryClient({
    primary: local,
    fallback: local
  });
}

/**
 * @param {ReturnType<typeof createResilientMemoryClient>} memoryClient
 * @param {string} query
 * @param {{ project?: string, scope?: string, type?: string, limit?: number }} [options]
 */
async function searchMemoryClient(memoryClient, query, options = {}) {
  if (typeof memoryClient.search === "function") {
    const result = await memoryClient.search(query, options);

    if (Array.isArray(result?.entries)) {
      return result;
    }

    const stdout = typeof result?.stdout === "string" ? result.stdout : "";
    return {
      ...result,
      entries: legacySearchStdoutToEntries(stdout, { project: options.project }),
      stdout,
      provider:
        typeof result?.provider === "string" && result.provider.trim()
          ? result.provider
          : "memory"
    };
  }

  const legacyResult = await memoryClient.searchMemories(query, options);
  return {
    entries: legacySearchStdoutToEntries(legacyResult.stdout, { project: options.project }),
    stdout: legacyResult.stdout,
    provider:
      typeof legacyResult.provider === "string" && legacyResult.provider.trim()
        ? legacyResult.provider
        : "memory"
  };
}

/**
 * @param {ReturnType<typeof createResilientMemoryClient>} memoryClient
 * @param {import("../types/core-contracts.d.ts").MemorySaveInput} input
 */
async function saveMemoryClient(memoryClient, input) {
  if (typeof memoryClient.save === "function") {
    return memoryClient.save(input);
  }

  if (typeof memoryClient.saveMemory === "function") {
    return memoryClient.saveMemory(input);
  }

  throw new Error("save()/saveMemory() not supported by the configured memory client.");
}

/**
 * @param {{ id?: string, source?: string, origin?: string }} chunk
 * @param {Set<string>} recoveredMemoryIds
 */
function isRecalledSelectionChunk(chunk, recoveredMemoryIds) {
  const chunkId = String(chunk.id ?? "").trim();
  if (chunkId && recoveredMemoryIds.has(chunkId)) {
    return true;
  }

  return (
    String(chunk.source ?? "").startsWith("engram://") ||
    String(chunk.source ?? "").startsWith("memory://") ||
    chunk.origin === "memory"
  );
}

/**
 * @param {CliOptions} options
 * @param {string} key
 * @param {boolean} [fallback]
 */
function booleanOption(options, key, fallback = false) {
  const value = options[key];

  if (value === undefined) {
    return fallback;
  }

  if (value !== "true" && value !== "false") {
    throw new Error(`Option --${key} must be true or false.`);
  }

  return value === "true";
}

/**
 * @param {string | undefined} value
 * @param {boolean} fallback
 */
function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 */
function parseIntegerEnv(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(parsed));
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 */
function parseScoreEnv(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, parsed));
}

/**
 * @param {string[]} changedFiles
 * @param {string} task
 * @param {string} objective
 * @param {string} focus
 */
function buildAxiomFocusTerms(changedFiles, task, objective, focus) {
  const source = [...changedFiles, task, objective, focus].join(" ").toLowerCase();
  return Array.from(
    new Set(
      source
        .split(/[^a-z0-9_./-]+/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length >= 4)
    )
  ).slice(0, 20);
}

/**
 * @param {string} message
 */
function classifyRememberStatus(message) {
  const normalized = String(message || "").toLowerCase();
  if (
    normalized.includes("degraded") ||
    normalized.includes("fallback") ||
    normalized.includes("partial")
  ) {
    return "degradedRecall";
  }

  if (
    normalized.includes("unavailable") ||
    normalized.includes("timeout") ||
    normalized.includes("locked") ||
    normalized.includes("refused") ||
    normalized.includes("econn")
  ) {
    return "unavailable";
  }

  return "failed";
}

/**
 * @param {LearningPacketWithMemory} packet
 * @param {number} durationMs
 * @param {boolean} degraded
 */
function buildTeachObservability(packet, durationMs, degraded) {
  const selectedCount = packet.diagnostics.summary?.selectedCount ?? packet.selectedContext.length;
  const suppressedCount =
    packet.diagnostics.summary?.suppressedCount ?? packet.suppressedContext.length;
  const requiredKinds = ["code", "test", "memory"];
  const selectedKinds = new Set(
    packet.selectedContext
      .map((chunk) => String(chunk.kind ?? "").trim().toLowerCase())
      .filter(Boolean)
  );
  const coveredKinds = requiredKinds.filter((kind) => selectedKinds.has(kind)).length;
  const skippedReasons = [];

  if (!selectedKinds.has("code")) {
    skippedReasons.push("missing-code-anchor");
  }

  if (!selectedKinds.has("test")) {
    skippedReasons.push("missing-test-anchor");
  }

  if (!selectedKinds.has("memory")) {
    skippedReasons.push("missing-memory-anchor");
  }

  return {
    metricsVersion: "1.0.0",
    event: {
      command: "teach",
      durationMs: Math.max(0, durationMs),
      degraded
    },
    selection: {
      selectedCount,
      suppressedCount
    },
    recall: {
      attempted: packet.memoryRecall.enabled === true,
      status: packet.memoryRecall.status,
      recoveredChunks: packet.memoryRecall.recoveredChunks,
      selectedChunks: packet.memoryRecall.selectedChunks,
      suppressedChunks: packet.memoryRecall.suppressedChunks,
      hit: packet.memoryRecall.recoveredChunks > 0
    },
    sdd: {
      enabled: true,
      requiredKinds: requiredKinds.length,
      coveredKinds,
      injectedKinds: 0,
      skippedReasons
    }
  };
}

/**
 * @param {RunTeachCommandInput} input
 */
export async function runTeachCommand(input) {
  const { options, loadedConfig, source, numeric, format, debugEnabled, startedAt } = input;
  const { payload, path, stats } = source;
  const dependencies = input.dependencies ?? {};
  const task = requireOption(options, "task");
  const objective = requireOption(options, "objective");
  const changedFiles = listOption(options, "changed-files");
  const focus = options.focus ?? `${task} ${objective}`;
  const axiomInjectionDisabled = parseBooleanEnv(
    process.env.LCS_TEACH_AXIOM_INJECTION_DISABLED,
    false
  );
  const axiomMax = parseIntegerEnv(process.env.LCS_TEACH_MAX_AXIOMS, 3);
  const axiomMinScore = parseScoreEnv(process.env.LCS_TEACH_AXIOM_MIN_MATCH_SCORE, 0.5);
  const axiomMinMatches = parseIntegerEnv(process.env.LCS_TEACH_AXIOM_MIN_MATCHES, 1);
  const memoryClient = getMemoryClient(options, dependencies);
  const memoryScope = options["memory-scope"] ?? "project";
  const memoryType = options["memory-type"];
  const noRecall = booleanOption(options, "no-recall", false);
  const autoRecall = booleanOption(options, "auto-recall", loadedConfig.config.memory.autoRecall);
  const strictRecall = booleanOption(
    options,
    "strict-recall",
    loadedConfig.config.memory.strictRecall
  );
  const autoRemember = booleanOption(
    options,
    "auto-remember",
    loadedConfig.config.memory.autoRemember
  );
  const memoryLimit = assertNumberRules(numberOption(options, "memory-limit", 3), "memory-limit", {
    min: 1,
    integer: true
  });
  const teachChunks = await resolveAutoTeachRecall({
    task,
    objective,
    focus,
    changedFiles,
    project: options.project,
    explicitQuery: options["recall-query"],
    noRecall,
    autoRecall,
    limit: memoryLimit,
    scope: memoryScope,
    type: memoryType,
    strictRecall,
    baseChunks: payload.chunks,
    search: (query, searchOptions) => searchMemoryClient(memoryClient, query, searchOptions)
  });
  const packet = buildLearningPacket({
    task,
    objective,
    focus,
    changedFiles,
    chunks: teachChunks.chunks,
    tokenBudget: numeric.tokenBudget,
    maxChunks: numeric.maxChunks,
    sentenceBudget: numeric.sentenceBudget,
    minScore: numeric.minScore,
    debug: debugEnabled
  });
  const packetDiagnostics = packet.diagnostics ?? {};
  const axiomDiagnostics = {
    status: "skipped",
    count: 0,
    reason: "below-threshold"
  };

  if (!axiomInjectionDisabled) {
    const injector =
      dependencies.axiomInjector ??
      createAxiomInjector({
        project: options.project || loadedConfig.config.project,
        maxAxioms: axiomMax,
        minMatchScore: axiomMinScore
      });

    if (!injector || typeof injector.retrieve !== "function") {
      axiomDiagnostics.status = "degraded";
      axiomDiagnostics.reason = "injector-unavailable";
    } else {
      try {
        const axioms = await injector.retrieve({
          focusTerms: buildAxiomFocusTerms(changedFiles, task, objective, focus),
          pathScope: changedFiles[0] || undefined
        });
        const normalizedAxioms = Array.isArray(axioms)
          ? axioms
              .map((entry) => ({
                type: String(entry.type ?? "code-axiom"),
                title: String(entry.title ?? "").trim(),
                body: String(entry.body ?? "").trim(),
                tags: Array.isArray(entry.tags)
                  ? entry.tags.filter((tag) => typeof tag === "string")
                  : undefined
              }))
              .filter((entry) => entry.title && entry.body)
          : [];
        axiomDiagnostics.count = normalizedAxioms.length;

        if (normalizedAxioms.length >= axiomMinMatches) {
          packet.teachingSections = {
            ...packet.teachingSections,
            relevantAxioms: normalizedAxioms
          };
          axiomDiagnostics.status = "injected";
          axiomDiagnostics.reason = "threshold-met";
        }
      } catch {
        axiomDiagnostics.status = "degraded";
        axiomDiagnostics.reason = "injector-failed";
      }
    }
  } else {
    axiomDiagnostics.reason = "disabled";
  }

  packet.diagnostics = {
    ...packetDiagnostics,
    axiomInjection: /** @type {"injected" | "skipped" | "degraded"} */ (axiomDiagnostics.status),
    axiomCount: axiomDiagnostics.count,
    axiomReason: axiomDiagnostics.reason
  };
  const recoveredMemoryIds = new Set(
    Array.isArray(teachChunks.memoryRecall.recoveredMemoryIds)
      ? teachChunks.memoryRecall.recoveredMemoryIds
          .filter((entry) => typeof entry === "string" && entry.trim())
          .map((entry) => entry.trim())
      : []
  );
  const selectedMemoryChunkIds = packet.selectedContext
    .filter((chunk) => isRecalledSelectionChunk(chunk, recoveredMemoryIds))
    .map((chunk) => chunk.id);
  const suppressedMemoryChunkIds = packet.suppressedContext
    .filter((chunk) => isRecalledSelectionChunk(chunk, recoveredMemoryIds))
    .map((chunk) => chunk.id);
  const packetWithMemory = /** @type {LearningPacketWithMemory} */ ({
    ...packet,
    ...(stats ? { scanStats: stats } : {}),
    memoryRecall: {
      ...teachChunks.memoryRecall,
      degraded: teachChunks.memoryRecall.degraded === true,
      selectedChunks: selectedMemoryChunkIds.length,
      suppressedChunks: suppressedMemoryChunkIds.length,
      ...(debugEnabled
        ? {
            selectedChunkIds: selectedMemoryChunkIds,
            suppressedChunkIds: suppressedMemoryChunkIds
          }
        : {})
    }
  });
  packetWithMemory.autoMemory = {
    autoRecallEnabled: teachChunks.autoRecallEnabled === true,
    autoRememberEnabled: autoRemember,
    rememberAttempted: false,
    rememberSaved: false,
    rememberStatus: "idle",
    rememberTitle: "",
    rememberError: "",
    rememberRedactionCount: 0,
    rememberSensitivePathCount: 0
  };

  if (autoRemember) {
    packetWithMemory.autoMemory.rememberAttempted = true;

    try {
      const rememberInput = buildTeachAutoRememberPayload({
        task,
        objective,
        changedFiles,
        selectedSources: packet.selectedContext.map((chunk) => chunk.source),
        project: options.project,
        recallState: packetWithMemory.memoryRecall,
        selectionDiagnostics: {
          selectorStatus: packet.diagnostics.selectorStatus,
          selectorReason: packet.diagnostics.selectorReason,
          selectedCount: packet.diagnostics.summary?.selectedCount,
          suppressedCount: packet.diagnostics.summary?.suppressedCount,
          suppressionReasons: packet.diagnostics.summary?.suppressionReasons,
          sdd: packet.diagnostics.sdd
        },
        axiomDiagnostics: {
          status: packet.diagnostics.axiomInjection,
          count: packet.diagnostics.axiomCount,
          reason: packet.diagnostics.axiomReason
        },
        memoryType,
        memoryScope,
        security: loadedConfig.config.security
      });
      packetWithMemory.autoMemory.rememberRedactionCount = rememberInput.security.redactionCount;
      packetWithMemory.autoMemory.rememberSensitivePathCount =
        rememberInput.security.sensitivePathCount;
      packetWithMemory.autoMemory.rememberTitle = rememberInput.title;
      const hygiene = evaluateMemoryWrite({
        title: rememberInput.title,
        content: rememberInput.content,
        type: rememberInput.type,
        scope: rememberInput.scope,
        project: rememberInput.project,
        sourceKind: "auto-remember"
      });

      if (hygiene.action === "quarantine") {
        await quarantineMemoryWrite({
          cwd: process.cwd(),
          quarantineDir: options["memory-quarantine-dir"],
          title: rememberInput.title,
          content: rememberInput.content,
          type: rememberInput.type,
          scope: rememberInput.scope,
          project: rememberInput.project,
          sourceKind: "auto-remember",
          reasons: hygiene.reasons
        });
        packetWithMemory.autoMemory.rememberSaved = false;
        packetWithMemory.autoMemory.rememberStatus = "quarantined";
        packetWithMemory.autoMemory.rememberError = hygiene.reasons.join(", ");
      } else {
        const rememberResult = await saveMemoryClient(memoryClient, {
          title: rememberInput.title,
          content: rememberInput.content,
          type: rememberInput.type,
          scope: rememberInput.scope,
          project: rememberInput.project,
          ...buildAcceptedMemoryMetadata(hygiene, { sourceKind: "auto-remember" })
        });
        packetWithMemory.autoMemory.rememberSaved = true;
        packetWithMemory.autoMemory.rememberStatus = "accepted";
        if (rememberResult?.warning) {
          packetWithMemory.autoMemory.rememberError = rememberResult.warning;
          packetWithMemory.autoMemory.rememberStatus = classifyRememberStatus(rememberResult.warning);
        }
      }
    } catch (error) {
      const rememberError = error instanceof Error ? error.message : String(error);
      packetWithMemory.autoMemory.rememberStatus = classifyRememberStatus(rememberError);
      packetWithMemory.autoMemory.rememberError = rememberError;
    }
  }

  if (debugEnabled) {
    packetWithMemory.debug = {
      selectedOrigins: packet.diagnostics.summary?.selectedOrigins ?? {},
      suppressedOrigins: packet.diagnostics.summary?.suppressedOrigins ?? {},
      suppressionReasons: packet.diagnostics.summary?.suppressionReasons ?? {}
    };
  }

  /** @type {string[]} */
  const warnings = [];

  if (packetWithMemory.memoryRecall.degraded && packetWithMemory.memoryRecall.error) {
    warnings.push(packetWithMemory.memoryRecall.error);
  }

  if (
    packetWithMemory.memoryRecall.status === "skipped" &&
    packetWithMemory.memoryRecall.reason === "low-signal-task"
  ) {
    warnings.push(
      "Auto recall skipped: low-signal task. Add --changed-files or --recall-query to force memory recall."
    );
  }

  if (
    packetWithMemory.autoMemory?.rememberError &&
    !packetWithMemory.autoMemory.rememberSaved
  ) {
    if (packetWithMemory.autoMemory.rememberStatus === "quarantined") {
      warnings.push(
        `Auto remember quarantined by hygiene gate: ${packetWithMemory.autoMemory.rememberError}`
      );
    } else {
      warnings.push(`Auto remember failed: ${packetWithMemory.autoMemory.rememberError}`);
    }
  }

  if (
    packetWithMemory.autoMemory?.rememberSaved &&
    packetWithMemory.autoMemory?.rememberError
  ) {
    warnings.push(`Auto remember fallback: ${packetWithMemory.autoMemory.rememberError}`);
  }

  if ((packetWithMemory.autoMemory?.rememberRedactionCount ?? 0) > 0) {
    warnings.push(
      `Auto remember redacted ${packetWithMemory.autoMemory.rememberRedactionCount} secret fragment(s).`
    );
  }

  if ((packetWithMemory.autoMemory?.rememberSensitivePathCount ?? 0) > 0) {
    warnings.push(
      `Auto remember sanitized ${packetWithMemory.autoMemory.rememberSensitivePathCount} sensitive path(s).`
    );
  }

  const degraded =
    packetWithMemory.memoryRecall.degraded === true ||
    Boolean(
      packetWithMemory.autoMemory?.rememberError &&
        packetWithMemory.autoMemory.rememberSaved === false
    );
  const observability = buildTeachObservability(packetWithMemory, Date.now() - startedAt, degraded);

  return {
    exitCode: 0,
    stdout:
      format === "text"
        ? formatLearningPacketAsText(packetWithMemory, { debug: debugEnabled })
        : input.serializeCommandResult(
            "teach",
            {
              input: path,
              observability,
              ...packetWithMemory
            },
            format,
            loadedConfig,
            {
              degraded,
              warnings,
              ...input.buildRuntimeMeta(startedAt, { debug: debugEnabled, scanStats: stats ?? null })
            }
          ),
    metrics: {
      degraded,
      selection: observability.selection,
      recall: observability.recall,
      sdd: observability.sdd
    }
  };
}

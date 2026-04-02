// @ts-check

import { buildLearningPacket } from "../learning/mentor-loop.js";
import { createLocalMemoryStore } from "../memory/local-memory-store.js";
import { createObsidianMemoryProvider } from "../memory/obsidian-memory-provider.js";
import { createParallelMemoryClient } from "../memory/parallel-memory-client.js";
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
import { legacySearchStdoutToEntries, memoryEntriesToChunks } from "../memory/memory-utils.js";
import {
  buildSecuritySideQueries,
  buildSecurityTeachingBlock,
  DEFAULT_SECURITY_ENFORCEMENT
} from "../security/security-learning-loop.js";
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
 *   securityTeaching?: import("../types/core-contracts.d.ts").SecurityTeachingBlock,
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
 *   memoryClient?: import("../types/core-contracts.d.ts").MemoryProvider,
 *   engramClient?: import("../types/core-contracts.d.ts").MemoryProvider,
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
 * @param {string | undefined} value
 * @returns {"resilient" | "parallel" | "local-only"}
 */
function parseMemoryBackendMode(value) {
  if (!value || value === "true") {
    return "resilient";
  }

  if (value === "engram-only") {
    return "resilient";
  }

  if (value === "resilient" || value === "parallel" || value === "local-only") {
    return value;
  }

  throw new Error("Option --memory-backend must be one of: resilient, parallel, local-only.");
}

/**
 * @param {string | undefined} value
 * @returns {"strict" | "relaxed"}
 */
function parseMemoryIsolationMode(value) {
  if (!value || value === "true") {
    return "strict";
  }

  if (value === "strict" || value === "relaxed") {
    return value;
  }

  throw new Error("Option --memory-isolation must be one of: strict, relaxed.");
}

/**
 * @param {string | undefined} value
 * @returns {"auto" | "on" | "off"}
 */
function parseSecurityFocusMode(value) {
  if (!value || value === "true") {
    return "auto";
  }

  if (value === "auto" || value === "on" || value === "off") {
    return value;
  }

  throw new Error("Option --security-focus must be one of: auto, on, off.");
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
 * @returns {import("../types/core-contracts.d.ts").MemoryProvider}
 */
function getMemoryClient(options, dependencies = {}) {
  const injectedMemoryClient = getInjectedMemoryClient(dependencies);
  if (injectedMemoryClient) {
    return injectedMemoryClient;
  }

  const backendMode = parseMemoryBackendMode(options["memory-backend"]);
  const isolationMode = parseMemoryIsolationMode(options["memory-isolation"]);

  const local = createLocalMemoryStore({
    filePath: options["memory-fallback-file"],
    baseDir: options["memory-base-dir"]
  });

  if (backendMode === "local-only") {
    return local;
  }

  if (backendMode === "parallel") {
    const obsidian = createObsidianMemoryProvider({
      cwd: process.cwd(),
      vaultDir: options["obsidian-vault"],
      pollIntervalMs: numberOption(options, "obsidian-poll-interval-ms", 30_000)
    });

    return createParallelMemoryClient({
      primary: /** @type {any} */ (local),
      secondary: /** @type {any} */ (obsidian),
      isolation: isolationMode
    });
  }

  return createResilientMemoryClient({
    primary: local,
    fallback: local
  });
}

/**
 * @param {import("../types/core-contracts.d.ts").MemoryProvider} memoryClient
 * @param {string} query
 * @param {{
 *   project?: string,
 *   scope?: string,
 *   type?: string,
 *   language?: string,
 *   securityOnly?: boolean,
 *   isolationMode?: "strict" | "relaxed",
 *   changedFiles?: string[],
 *   limit?: number
 * }} [options]
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
 * @param {import("../types/core-contracts.d.ts").MemoryProvider} memoryClient
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
 * @param {string[]} changedFiles
 * @returns {string}
 */
function inferMemoryLanguage(changedFiles) {
  /** @type {Record<string, string>} */
  const extensionLanguageMap = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".go": "go",
    ".py": "python",
    ".java": "java",
    ".rb": "ruby",
    ".rs": "rust",
    ".php": "php",
    ".cs": "csharp"
  };

  /** @type {Map<string, number>} */
  const scores = new Map();

  for (const file of changedFiles) {
    const normalized = String(file ?? "").trim().toLowerCase();
    const extension = normalized.match(/\.[a-z0-9]+$/u)?.[0] ?? "";
    const language = extensionLanguageMap[extension];
    if (!language) {
      continue;
    }
    scores.set(language, (scores.get(language) ?? 0) + 1);
  }

  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  return ranked[0]?.[0] ?? "";
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
    },
    security: {
      recallAttempted:
        packet.memoryRecall.enabled === true &&
        packet.memoryRecall.queriesTried.some((query) => /security|risk|guard|auth|token|secret/iu.test(query)),
      recallHit:
        packet.memoryRecall.recoveredChunks > 0 &&
        packet.memoryRecall.matchedQueries.some((query) => /security|risk|guard|auth|token|secret/iu.test(query)),
      criticalBlocked: packet.securityTeaching?.blocked === true,
      falsePositiveBlock: false,
      memorySaved: packet.autoMemory?.rememberSaved ? 1 : 0,
      quarantined: packet.autoMemory?.rememberStatus === "quarantined" ? 1 : 0
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
  const securityLearningConfig =
    loadedConfig.config.security &&
    typeof loadedConfig.config.security === "object" &&
    loadedConfig.config.security.learning &&
    typeof loadedConfig.config.security.learning === "object"
      ? /** @type {Record<string, unknown>} */ (loadedConfig.config.security.learning)
      : {};
  const memoryScope = options["memory-scope"] ?? "project";
  const memoryType = options["memory-type"];
  const memoryIsolation = parseMemoryIsolationMode(
    options["memory-isolation"] ?? loadedConfig.config.memory.isolation
  );
  const explicitMemoryLanguage =
    typeof options["memory-language"] === "string" ? options["memory-language"].trim().toLowerCase() : "";
  const inferredMemoryLanguage = inferMemoryLanguage(changedFiles);
  const memoryLanguage = explicitMemoryLanguage || inferredMemoryLanguage;
  const securityFocus = parseSecurityFocusMode(
    options["security-focus"] ??
      (typeof securityLearningConfig.defaultFocus === "string"
        ? String(securityLearningConfig.defaultFocus)
        : "auto")
  );
  const securityLearningEnabled = securityLearningConfig.enabled !== false;
  const securityEnforcement =
    typeof securityLearningConfig.enforcement === "string"
      ? String(securityLearningConfig.enforcement)
      : DEFAULT_SECURITY_ENFORCEMENT;
  const securityStrictIsolation =
    securityLearningConfig.strictIsolation !== false && memoryIsolation !== "relaxed";
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
  const alreadySurfacedMemoryIds = listOption(options, "already-surfaced-memory-ids");
  const usedTools = listOption(options, "used-tools");
  let teachChunks = await resolveAutoTeachRecall({
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
    language: memoryLanguage,
    isolationMode: memoryIsolation,
    strictRecall,
    alreadySurfacedMemoryIds,
    usedTools,
    baseChunks: payload.chunks,
    search: (query, searchOptions) =>
      searchMemoryClient(memoryClient, query, {
        ...searchOptions,
        isolationMode: memoryIsolation,
        changedFiles,
        language: searchOptions?.language ?? memoryLanguage
      })
  });
  /** @type {import("../types/core-contracts.d.ts").MemoryEntry[]} */
  let recoveredSecurityEntries = [];

  if (
    securityLearningEnabled &&
    securityFocus !== "off" &&
    teachChunks.memoryRecall.enabled === true
  ) {
    const securitySideQueries = buildSecuritySideQueries({
      task,
      objective,
      focus,
      changedFiles,
      recentRiskTaxonomyIds: []
    });

    if (securitySideQueries.length) {
      /** @type {Map<string, import("../types/core-contracts.d.ts").MemoryEntry>} */
      const sideEntriesById = new Map();
      /** @type {string[]} */
      const securityQueriesTried = [];
      /** @type {string[]} */
      const securityQueriesMatched = [];
      const maxSecurityQueries = Math.min(3, securitySideQueries.length);

      for (const securityQuery of securitySideQueries.slice(0, maxSecurityQueries)) {
        securityQueriesTried.push(securityQuery);
        try {
          // eslint-disable-next-line no-await-in-loop
          const sideResult = await searchMemoryClient(memoryClient, securityQuery, {
            project: options.project,
            scope: memoryScope,
            type: undefined,
            language: memoryLanguage,
            securityOnly: true,
            isolationMode: memoryIsolation,
            changedFiles,
            limit: Math.max(2, memoryLimit)
          });
          const entries = Array.isArray(sideResult.entries) ? sideResult.entries : [];
          const securityEntries = entries.filter((entry) => {
            const type = String(entry.type ?? "").toLowerCase();
            const riskTaxonomy = /** @type {Record<string, unknown>} */ (entry).riskTaxonomy;
            return type.includes("security") || typeof riskTaxonomy === "string";
          });

          if (securityEntries.length) {
            securityQueriesMatched.push(securityQuery);
          }

          for (const entry of securityEntries) {
            const id = String(entry.id ?? "").trim() || `${securityQuery}:${entry.title}`;
            if (!sideEntriesById.has(id)) {
              sideEntriesById.set(id, entry);
            }
          }
        } catch {
          // ignore security side-query failures to keep teach stable
        }
      }

      recoveredSecurityEntries = [...sideEntriesById.values()].slice(0, Math.max(memoryLimit, 3));

      if (securityQueriesTried.length) {
        const mergedQueries = [
          ...(Array.isArray(teachChunks.memoryRecall.queriesTried)
            ? teachChunks.memoryRecall.queriesTried
            : []),
          ...securityQueriesTried
        ];
        teachChunks.memoryRecall.queriesTried = [...new Set(mergedQueries)];
      }

      if (securityQueriesMatched.length) {
        const sideChunks = memoryEntriesToChunks(recoveredSecurityEntries, {
          query: securityQueriesMatched[0],
          project: options.project
        });
        const knownIds = new Set(teachChunks.chunks.map((chunk) => chunk.id));
        const uniqueSideChunks = sideChunks.filter((chunk) => !knownIds.has(chunk.id));

        if (uniqueSideChunks.length) {
          teachChunks = {
            ...teachChunks,
            chunks: [...teachChunks.chunks, ...uniqueSideChunks],
            memoryRecall: {
              ...teachChunks.memoryRecall,
              status: "recalled",
              reason:
                teachChunks.memoryRecall.reason ||
                (teachChunks.memoryRecall.recoveredChunks > 0 ? "" : "security-side-query"),
              matchedQueries: [
                ...new Set([
                  ...(Array.isArray(teachChunks.memoryRecall.matchedQueries)
                    ? teachChunks.memoryRecall.matchedQueries
                    : []),
                  ...securityQueriesMatched
                ])
              ],
              recoveredChunks: teachChunks.memoryRecall.recoveredChunks + uniqueSideChunks.length,
              recoveredMemoryIds: [
                ...new Set([
                  ...(Array.isArray(teachChunks.memoryRecall.recoveredMemoryIds)
                    ? teachChunks.memoryRecall.recoveredMemoryIds
                    : []),
                  ...uniqueSideChunks.map((chunk) => chunk.id)
                ])
              ],
              sideQueryUsed: true
            }
          };
        }
      }
    }
  }

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
  packetWithMemory.securityTeaching = buildSecurityTeachingBlock({
    mode: securityFocus,
    task,
    objective,
    changedFiles,
    selectedContext: packetWithMemory.selectedContext,
    recoveredSecurityEntries,
    enforcement: securityEnforcement
  });
  if (packetWithMemory.securityTeaching?.enabled) {
    const riskLabel = packetWithMemory.securityTeaching.risk?.label || "security best practices";
    packetWithMemory.teachingChecklist = [
      ...packetWithMemory.teachingChecklist,
      `Security guardrail: apply "${riskLabel}" with explicit tests and safe defaults.`
    ];
  }
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

  if (autoRemember && packetWithMemory.securityTeaching?.blocked !== true) {
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
        memoryLanguage,
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
          language: rememberInput.language,
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
          language: rememberInput.language,
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
  } else if (autoRemember && packetWithMemory.securityTeaching?.blocked === true) {
    packetWithMemory.autoMemory.rememberAttempted = false;
    packetWithMemory.autoMemory.rememberSaved = false;
    packetWithMemory.autoMemory.rememberStatus = "failed";
    packetWithMemory.autoMemory.rememberError = "blocked by critical security guardrail";
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
    packetWithMemory.memoryRecall.status === "empty" &&
    packetWithMemory.memoryRecall.reason === "already-surfaced"
  ) {
    warnings.push(
      "Auto recall skipped repeated memories: all candidate memories were already surfaced in this flow."
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

  if (packetWithMemory.securityTeaching?.blocked) {
    warnings.push(
      `Critical security block: ${packetWithMemory.securityTeaching.reasons?.join(", ") || "policy enforcement"}`
    );
  }

  const blockedBySecurity = packetWithMemory.securityTeaching?.blocked === true;
  const degraded =
    packetWithMemory.memoryRecall.degraded === true ||
    Boolean(
      packetWithMemory.autoMemory?.rememberError &&
        packetWithMemory.autoMemory.rememberSaved === false
    ) ||
    blockedBySecurity;
  const observability = buildTeachObservability(packetWithMemory, Date.now() - startedAt, degraded);

  return {
    exitCode: blockedBySecurity ? 1 : 0,
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
      sdd: observability.sdd,
      security: observability.security
    }
  };
}

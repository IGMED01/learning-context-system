// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").MemoryProvider} MemoryProvider
 * @typedef {import("../types/core-contracts.d.ts").MemorySearchOptions} MemorySearchOptions
 * @typedef {import("../types/core-contracts.d.ts").MemorySaveInput} MemorySaveInput
 * @typedef {import("../types/core-contracts.d.ts").MemoryCloseInput} MemoryCloseInput
 * @typedef {import("../types/core-contracts.d.ts").MemorySearchResult} MemorySearchResult
 * @typedef {import("../types/core-contracts.d.ts").MemorySaveResult} MemorySaveResult
 * @typedef {import("../types/core-contracts.d.ts").MemoryHealthResult} MemoryHealthResult
 * @typedef {import("../types/core-contracts.d.ts").MemoryEntry} MemoryEntry
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} error
 * @returns {"binary-missing" | "timeout" | "malformed-output" | "unknown"}
 */
export function classifyMemoryFailure(error) {
  const message = toErrorMessage(error).toLowerCase();

  if (/enoent|cannot find|not recognized as an internal or external command/i.test(message)) {
    return "binary-missing";
  }

  if (/etimedout|timed out|timeout|killed|sigterm/i.test(message)) {
    return "timeout";
  }

  if (/malformed|parse|unexpected output|unexpected token|invalid format/i.test(message)) {
    return "malformed-output";
  }

  return "unknown";
}

/**
 * @param {"binary-missing" | "timeout" | "malformed-output" | "unknown"} failureKind
 */
export function memoryFailureFixHint(failureKind) {
  if (failureKind === "binary-missing") {
    return "Verify --engram-bin path or learning-context.config.json -> engram.binaryPath.";
  }

  if (failureKind === "timeout") {
    return "Retry recall, reduce query scope, and verify Engram runtime health.";
  }

  if (failureKind === "malformed-output") {
    return "Update Engram and validate output format with doctor + recall --debug.";
  }

  return "Run doctor and verify Engram binary and data directory settings.";
}

/**
 * @param {string} operation
 * @param {unknown} error
 * @returns {string}
 */
function fallbackWarning(operation, error) {
  const kind = classifyMemoryFailure(error);
  return `Engram failed during ${operation}; using local fallback memory store (${kind}).`;
}

/**
 * Creates a resilient memory client that implements MemoryProvider.
 * Tries primary (Engram) first, falls back to local store on failure.
 *
 * @param {{
 *   primary: {
 *     name?: string,
 *     config?: { dataDir?: string },
 *     search?: (query: string, options?: MemorySearchOptions) => Promise<MemorySearchResult>,
 *     save?: (input: MemorySaveInput) => Promise<MemorySaveResult>,
 *     delete?: (id: string, project?: string) => Promise<{ deleted: boolean, id: string }>,
 *     list?: (options?: { project?: string, limit?: number }) => Promise<MemoryEntry[]>,
 *     health?: () => Promise<MemoryHealthResult>,
 *     recallContext: (project?: string) => Promise<Record<string, unknown> & { stdout?: string }>,
 *     searchMemories: (query: string, options?: MemorySearchOptions) => Promise<Record<string, unknown> & { stdout: string }>,
 *     saveMemory: (input: MemorySaveInput) => Promise<Record<string, unknown>>,
 *     closeSession: (input: MemoryCloseInput) => Promise<Record<string, unknown>>
 *   },
 *   fallback: {
 *     name?: string,
 *     config?: { dataDir?: string, filePath?: string },
 *     search?: (query: string, options?: MemorySearchOptions) => Promise<MemorySearchResult>,
 *     save?: (input: MemorySaveInput) => Promise<MemorySaveResult>,
 *     delete?: (id: string, project?: string) => Promise<{ deleted: boolean, id: string }>,
 *     list?: (options?: { project?: string, limit?: number }) => Promise<MemoryEntry[]>,
 *     health?: () => Promise<MemoryHealthResult>,
 *     recallContext: (project?: string) => Promise<Record<string, unknown> & { stdout?: string }>,
 *     searchMemories: (query: string, options?: MemorySearchOptions) => Promise<Record<string, unknown> & { stdout: string }>,
 *     saveMemory: (input: MemorySaveInput) => Promise<Record<string, unknown>>,
 *     closeSession: (input: MemoryCloseInput) => Promise<Record<string, unknown>>
 *   },
 *   enabled?: boolean
 * }} input
 */
export function createResilientMemoryClient(input) {
  const enabled = input.enabled !== false;
  const primary = input.primary;
  const fallback = input.fallback;

  /**
   * @template T
   * @param {string} operation
   * @param {() => Promise<T>} runPrimary
   * @param {() => Promise<T>} runFallback
   * @returns {Promise<T & { provider: string, degraded?: boolean, warning?: string, error?: string, failureKind?: string, fixHint?: string }>}
   */
  async function withFallback(operation, runPrimary, runFallback) {
    try {
      const result = await runPrimary();
      return {
        ...(/** @type {T & Record<string, unknown>} */ (result)),
        provider: "engram"
      };
    } catch (primaryError) {
      if (!enabled) {
        throw primaryError;
      }

      const failureKind = classifyMemoryFailure(primaryError);
      const warning = fallbackWarning(operation, primaryError);

      try {
        const fallbackResult = await runFallback();
        return {
          ...(/** @type {T & Record<string, unknown>} */ (fallbackResult)),
          provider: "local",
          degraded: true,
          warning,
          error: toErrorMessage(primaryError),
          failureKind,
          fixHint: memoryFailureFixHint(failureKind)
        };
      } catch (fallbackError) {
        throw new Error(
          [
            `Primary memory backend failed (${operation}): ${toErrorMessage(primaryError)}`,
            `Fallback memory backend failed (${operation}): ${toErrorMessage(fallbackError)}`
          ].join("\n")
        );
      }
    }
  }

  return {
    name: "resilient",
    config: primary.config ?? fallback.config ?? {},

    // ── MemoryProvider interface ──

    /**
     * @param {string} query
     * @param {MemorySearchOptions} [options]
     * @returns {Promise<MemorySearchResult>}
     */
    search(query, options = {}) {
      if (!primary.search || !fallback.search) {
        throw new Error("search() not supported by underlying providers");
      }

      return withFallback(
        "search",
        () => /** @type {Function} */ (primary.search)(query, options),
        () => /** @type {Function} */ (fallback.search)(query, options)
      );
    },

    /**
     * @param {MemorySaveInput} saveInput
     * @returns {Promise<MemorySaveResult>}
     */
    save(saveInput) {
      if (!primary.save || !fallback.save) {
        throw new Error("save() not supported by underlying providers");
      }

      return withFallback(
        "save",
        () => /** @type {Function} */ (primary.save)(saveInput),
        () => /** @type {Function} */ (fallback.save)(saveInput)
      );
    },

    /**
     * @param {string} id
     * @param {string} [project]
     * @returns {Promise<{ deleted: boolean, id: string }>}
     */
    delete(id, project) {
      if (!primary.delete || !fallback.delete) {
        throw new Error("delete() not supported by underlying providers");
      }

      return withFallback(
        "delete",
        () => /** @type {Function} */ (primary.delete)(id, project),
        () => /** @type {Function} */ (fallback.delete)(id, project)
      );
    },

    /**
     * @param {{ project?: string, limit?: number }} [listOpts]
     * @returns {Promise<MemoryEntry[]>}
     */
    list(listOpts = {}) {
      if (!primary.list || !fallback.list) {
        throw new Error("list() not supported by underlying providers");
      }

      return withFallback(
        "list",
        () => /** @type {Function} */ (primary.list)(listOpts),
        () => /** @type {Function} */ (fallback.list)(listOpts)
      );
    },

    /**
     * @returns {Promise<MemoryHealthResult>}
     */
    async health() {
      const primaryHealth = primary.health
        ? await primary.health()
        : { healthy: false, provider: "engram", detail: "health() not implemented" };

      if (primaryHealth.healthy) {
        return primaryHealth;
      }

      const fallbackHealth = fallback.health
        ? await fallback.health()
        : { healthy: false, provider: "local", detail: "health() not implemented" };

      return {
        healthy: fallbackHealth.healthy,
        provider: fallbackHealth.healthy ? "local (degraded)" : "none",
        detail: `Primary: ${primaryHealth.detail}. Fallback: ${fallbackHealth.detail}`
      };
    },

    // ── Legacy compatibility ──

    /**
     * @param {string} [project]
     */
    recallContext(project) {
      return withFallback(
        "recallContext",
        () => primary.recallContext(project),
        () => fallback.recallContext(project)
      );
    },
    /**
     * @param {string} query
     * @param {MemorySearchOptions} [options]
     */
    searchMemories(query, options = {}) {
      return withFallback(
        "searchMemories",
        () => primary.searchMemories(query, options),
        () => fallback.searchMemories(query, options)
      );
    },
    /**
     * @param {MemorySaveInput} payload
     */
    saveMemory(payload) {
      return withFallback(
        "saveMemory",
        () => primary.saveMemory(payload),
        () => fallback.saveMemory(payload)
      );
    },
    /**
     * @param {MemoryCloseInput} payload
     */
    closeSession(payload) {
      return withFallback(
        "closeSession",
        () => primary.closeSession(payload),
        () => fallback.closeSession(payload)
      );
    }
  };
}

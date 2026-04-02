// @ts-check

import { buildCloseSummaryContent } from "./memory-utils.js";
import {
  applyMetadataGating,
  dedupeMemoryEntries,
  rankHybridMemoryEntries,
  toMemoryContextStdout,
  toMemorySearchStdout
} from "./memory-search-ranking.js";

/** @typedef {import("../types/core-contracts.d.ts").MemoryProvider} MemoryProvider */
/** @typedef {import("../types/core-contracts.d.ts").MemoryEntry} MemoryEntry */
/** @typedef {import("../types/core-contracts.d.ts").MemorySearchOptions} MemorySearchOptions */
/** @typedef {import("../types/core-contracts.d.ts").MemorySaveInput} MemorySaveInput */
/** @typedef {import("../types/core-contracts.d.ts").MemoryCloseInput} MemoryCloseInput */

/**
 * @param {unknown} value
 */
function toErrorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

/**
 * @param {unknown} value
 * @param {"strict" | "relaxed"} fallback
 */
function normalizeIsolation(value, fallback = "strict") {
  if (value === "strict" || value === "relaxed") {
    return value;
  }

  return fallback;
}

/**
 * @param {PromiseSettledResult<unknown>[]} settled
 */
function collectFailures(settled) {
  return settled
    .filter((entry) => entry.status === "rejected")
    .map((entry) => toErrorMessage(entry.reason));
}

/**
 * @param {PromiseSettledResult<unknown>[]} settled
 */
function collectSuccessfulProviders(settled) {
  /** @type {string[]} */
  const providers = [];
  for (const entry of settled) {
    if (entry.status !== "fulfilled") {
      continue;
    }
    const value = /** @type {Record<string, unknown>} */ (entry.value);
    const provider = typeof value.provider === "string" ? value.provider : "";
    if (provider && !providers.includes(provider)) {
      providers.push(provider);
    }
  }
  return providers;
}

/**
 * @param {MemoryEntry[]} entries
 * @param {string} query
 * @param {MemorySearchOptions} options
 */
function mergeAndRankEntries(entries, query, options) {
  const requestedLimit = Math.max(1, Math.trunc(options.limit ?? 5));
  const gated = applyMetadataGating(entries, options);
  if (!query.trim()) {
    return dedupeMemoryEntries(gated)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, requestedLimit);
  }

  return rankHybridMemoryEntries(gated, {
    query,
    options: {
      ...options,
      limit: requestedLimit
    }
  });
}

/**
 * @param {{
 *   primary: MemoryProvider,
 *   secondary: MemoryProvider,
 *   isolation?: "strict" | "relaxed"
 * }} input
 * @returns {MemoryProvider}
 */
export function createParallelMemoryClient(input) {
  const defaultIsolation = normalizeIsolation(input.isolation, "strict");
  const primaryName = input.primary?.name || "local";
  const secondaryName = input.secondary?.name || "obsidian";

  /**
   * @param {string} query
   * @param {MemorySearchOptions} [searchOptions]
   */
  async function search(query, searchOptions = {}) {
    const options = {
      ...searchOptions,
      isolationMode: normalizeIsolation(searchOptions.isolationMode, defaultIsolation)
    };
    const settled = await Promise.allSettled([
      input.primary.search(query, options),
      input.secondary.search(query, options)
    ]);

    const failures = collectFailures(settled);
    if (failures.length === settled.length) {
      throw new Error(`Parallel memory search failed: ${failures.join(" | ")}`);
    }

    /** @type {MemoryEntry[]} */
    const allEntries = [];
    for (const entry of settled) {
      if (entry.status !== "fulfilled") {
        continue;
      }
      const result = /** @type {{ entries?: MemoryEntry[] }} */ (entry.value);
      if (Array.isArray(result.entries)) {
        allEntries.push(...result.entries);
      }
    }

    const ranked = mergeAndRankEntries(allEntries, query, options);
    const providerChain = collectSuccessfulProviders(settled);
    const warning =
      failures.length > 0
        ? `Parallel recall degraded (${failures.join(" | ")}).`
        : undefined;

    return {
      entries: ranked,
      stdout: toMemorySearchStdout(ranked),
      provider: "parallel",
      providerChain: providerChain.length ? providerChain : [primaryName, secondaryName],
      degraded: failures.length > 0,
      warning,
      error: failures.length > 0 ? failures.join(" | ") : undefined
    };
  }

  /**
   * @param {MemorySaveInput} saveInput
   */
  async function save(saveInput) {
    const settled = await Promise.allSettled([
      input.primary.save(saveInput),
      input.secondary.save(saveInput)
    ]);
    const failures = collectFailures(settled);
    if (failures.length === settled.length) {
      throw new Error(`Parallel memory save failed: ${failures.join(" | ")}`);
    }

    const primaryResult =
      settled[0].status === "fulfilled"
        ? /** @type {{ id?: string, stdout?: string }} */ (settled[0].value)
        : null;
    const secondaryResult =
      settled[1].status === "fulfilled"
        ? /** @type {{ id?: string, stdout?: string }} */ (settled[1].value)
        : null;

    const id = primaryResult?.id || secondaryResult?.id || `parallel-${Date.now()}`;
    const stdout = primaryResult?.stdout || secondaryResult?.stdout || `Saved memory #${id}`;
    const providerChain = collectSuccessfulProviders(settled);
    return {
      id,
      stdout,
      provider: "parallel",
      providerChain: providerChain.length ? providerChain : [primaryName, secondaryName],
      degraded: failures.length > 0,
      warning:
        failures.length > 0
          ? `Parallel write degraded (${failures.join(" | ")}).`
          : undefined
    };
  }

  /**
   * @param {string} id
   * @param {string} [project]
   */
  async function deleteMemory(id, project) {
    const settled = await Promise.allSettled([
      input.primary.delete(id, project),
      input.secondary.delete(id, project)
    ]);

    const deleted = settled.some(
      (entry) => entry.status === "fulfilled" && entry.value?.deleted === true
    );
    return {
      deleted,
      id
    };
  }

  /**
   * @param {{ project?: string, limit?: number }} [listOptions]
   */
  async function list(listOptions = {}) {
    const settled = await Promise.allSettled([
      input.primary.list(listOptions),
      input.secondary.list(listOptions)
    ]);

    /** @type {MemoryEntry[]} */
    const allEntries = [];
    for (const entry of settled) {
      if (entry.status !== "fulfilled" || !Array.isArray(entry.value)) {
        continue;
      }
      allEntries.push(...entry.value);
    }

    return dedupeMemoryEntries(allEntries)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, Math.max(1, Math.trunc(listOptions.limit ?? 50)));
  }

  async function health() {
    const settled = await Promise.allSettled([input.primary.health(), input.secondary.health()]);
    const healthyCount = settled.filter(
      (entry) => entry.status === "fulfilled" && entry.value.healthy
    ).length;
    const failures = collectFailures(settled);

    return {
      healthy: healthyCount > 0,
      provider: "parallel",
      detail:
        failures.length > 0
          ? `Parallel memory degraded: ${failures.join(" | ")}`
          : `Parallel memory healthy (${primaryName} + ${secondaryName}).`
    };
  }

  /**
   * @param {string} [project]
   */
  async function recallContext(project) {
    const result = await search("", {
      project,
      limit: 5,
      isolationMode: defaultIsolation
    });
    return {
      mode: "context",
      project: project ?? "",
      query: "",
      scope: "",
      type: "",
      limit: 5,
      stdout: toMemoryContextStdout(result.entries, project),
      stderr: "",
      provider: "parallel",
      providerChain: result.providerChain,
      degraded: result.degraded === true,
      warning: result.warning
    };
  }

  /**
   * @param {string} query
   * @param {MemorySearchOptions} [searchOptions]
   */
  async function searchMemories(query, searchOptions = {}) {
    const result = await search(query, searchOptions);
    return {
      mode: "search",
      query,
      project: searchOptions.project ?? "",
      scope: searchOptions.scope ?? "",
      type: searchOptions.type ?? "",
      language: searchOptions.language ?? "",
      limit: searchOptions.limit ?? 5,
      stdout: result.stdout,
      stderr: "",
      provider: "parallel",
      providerChain: result.providerChain,
      degraded: result.degraded === true,
      warning: result.warning
    };
  }

  /**
   * @param {MemorySaveInput} saveInput
   */
  async function saveMemory(saveInput) {
    const result = await save(saveInput);
    return {
      action: "save",
      title: saveInput.title,
      content: saveInput.content,
      type: saveInput.type ?? "learning",
      language: saveInput.language ?? "",
      project: saveInput.project ?? "",
      scope: saveInput.scope ?? "project",
      topic: saveInput.topic ?? "",
      stdout: result.stdout,
      stderr: "",
      provider: "parallel",
      providerChain: result.providerChain,
      degraded: result.degraded === true,
      warning: result.warning
    };
  }

  /**
   * @param {MemoryCloseInput} closeInput
   */
  async function closeSession(closeInput) {
    const closedAt = new Date().toISOString();
    const title = closeInput.title ?? `Session close - ${closedAt.slice(0, 10)}`;
    const content = buildCloseSummaryContent({
      summary: closeInput.summary,
      learned: closeInput.learned,
      next: closeInput.next,
      workspace: process.cwd(),
      closedAt
    });
    const saved = await saveMemory({
      title,
      content,
      type: closeInput.type ?? "learning",
      language: closeInput.language,
      project: closeInput.project,
      scope: closeInput.scope ?? "project",
      topic: ""
    });

    return {
      ...saved,
      action: "close",
      title,
      summary: closeInput.summary,
      learned: closeInput.learned ?? "",
      next: closeInput.next ?? "",
      content
    };
  }

  return /** @type {MemoryProvider} */ ({
    name: "parallel",
    config: {
      isolation: defaultIsolation,
      primary: primaryName,
      secondary: secondaryName
    },
    search,
    save,
    delete: deleteMemory,
    list,
    health,
    recallContext,
    searchMemories,
    saveMemory,
    closeSession,
    async stop() {
      await /** @type {any} */ (input.primary).stop?.();
      await /** @type {any} */ (input.secondary).stop?.();
    }
  });
}

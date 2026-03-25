// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").AuditEntry} AuditEntry
 * @typedef {import("../types/core-contracts.d.ts").AuditQueryFilters} AuditQueryFilters
 * @typedef {import("../types/core-contracts.d.ts").AuditStats} AuditStats
 * @typedef {import("../types/core-contracts.d.ts").OutputAuditor} OutputAuditor
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

// ── Auditor Factory ──────────────────────────────────────────────────

/**
 * Create an output auditor instance.
 *
 * @param {{ logDir?: string }} [options]
 * @returns {OutputAuditor}
 */
export function createOutputAuditor(options) {
  const logDir = options?.logDir ?? join(process.cwd(), ".lcs", "audit");
  const logFile = join(logDir, "output-guard.jsonl");

  /** @type {AuditEntry[] | null} */
  let cache = null;
  let cacheStale = true;

  function ensureDir() {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }

  /**
   * @returns {AuditEntry[]}
   */
  function loadCache() {
    if (cache !== null && !cacheStale) {
      return cache;
    }

    if (!existsSync(logFile)) {
      cache = [];
      cacheStale = false;
      return cache;
    }

    const raw = readFileSync(logFile, "utf-8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    /** @type {AuditEntry[]} */
    const entries = [];

    for (const line of lines) {
      try {
        entries.push(/** @type {AuditEntry} */ (JSON.parse(line)));
      } catch {
        // Skip malformed lines
      }
    }

    cache = entries;
    cacheStale = false;
    return cache;
  }

  return {
    /**
     * @param {AuditEntry} entry
     * @returns {Promise<void>}
     */
    async log(entry) {
      ensureDir();
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(logFile, line, "utf-8");
      cacheStale = true;
    },

    /**
     * @param {AuditQueryFilters} [filters]
     * @returns {Promise<AuditEntry[]>}
     */
    async query(filters) {
      let entries = loadCache();

      if (!filters) {
        return [...entries];
      }

      if (filters.project) {
        entries = entries.filter((e) => e.project === filters.project);
      }

      if (typeof filters.blocked === "boolean") {
        entries = entries.filter((e) => e.blocked === filters.blocked);
      }

      if (filters.since) {
        const sinceDate = filters.since;
        entries = entries.filter((e) => e.timestamp >= sinceDate);
      }

      if (typeof filters.limit === "number" && filters.limit > 0) {
        entries = entries.slice(-filters.limit);
      }

      return [...entries];
    },

    /**
     * @returns {Promise<AuditStats>}
     */
    async stats() {
      const entries = loadCache();

      let blocked = 0;
      let modified = 0;
      let passedClean = 0;
      /** @type {Record<string, number>} */
      const byRule = {};

      for (const entry of entries) {
        if (entry.blocked) {
          blocked++;
        } else if (entry.modified) {
          modified++;
        } else {
          passedClean++;
        }

        for (const rule of entry.rules) {
          byRule[rule] = (byRule[rule] ?? 0) + 1;
        }
      }

      return {
        total: entries.length,
        blocked,
        modified,
        passedClean,
        byRule
      };
    }
  };
}

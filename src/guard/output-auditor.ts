/**
 * Output Auditor — logs all output guard evaluations for compliance/auditing.
 *
 * Storage: `.lcs/audit/output-guard.jsonl` (append-only JSONL)
 *
 * Design decisions:
 * - Append-only JSONL for simplicity and crash-safety
 * - In-memory cache for stats/query to avoid re-reading the full file
 * - Lazy directory creation on first write
 * - No external dependencies — uses only node:fs and node:path
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

import type {
  AuditEntry,
  AuditQueryFilters,
  AuditStats,
  OutputAuditor
} from "../types/core-contracts.d.ts";

// ── Auditor Factory ──────────────────────────────────────────────────

/**
 * Create an output auditor instance.
 *
 * @param options.logDir — directory for audit logs (default: `.lcs/audit`)
 */
export function createOutputAuditor(options?: { logDir?: string }): OutputAuditor {
  const logDir = options?.logDir ?? join(process.cwd(), ".lcs", "audit");
  const logFile = join(logDir, "output-guard.jsonl");

  /** In-memory cache of all entries — populated lazily on first query/stats */
  let cache: AuditEntry[] | null = null;
  let cacheStale = true;

  function ensureDir(): void {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }

  function loadCache(): AuditEntry[] {
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
    const entries: AuditEntry[] = [];

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip malformed lines
      }
    }

    cache = entries;
    cacheStale = false;
    return cache;
  }

  return {
    async log(entry: AuditEntry): Promise<void> {
      ensureDir();
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(logFile, line, "utf-8");
      cacheStale = true;
    },

    async query(filters?: AuditQueryFilters): Promise<AuditEntry[]> {
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

    async stats(): Promise<AuditStats> {
      const entries = loadCache();

      let blocked = 0;
      let modified = 0;
      let passedClean = 0;
      const byRule: Record<string, number> = {};

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

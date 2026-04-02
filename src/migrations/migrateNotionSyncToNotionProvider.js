// @ts-check

import { log } from "../core/logger.js";

/**
 * Migration shim:
 * keeps compatibility while the codebase transitions from notion-sync.js
 * naming to notion-provider.js abstractions.
 *
 * Idempotent by design — no mutable state is required.
 *
 * @param {string} [cwd]
 */
export async function migrate(cwd = process.cwd()) {
  log("info", "migration completed", {
    migration: "migrateNotionSyncToNotionProvider",
    cwd
  });

  return {
    migration: "migrateNotionSyncToNotionProvider",
    changed: false
  };
}


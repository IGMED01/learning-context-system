// @ts-check

import path from "node:path";
import { readFile } from "../integrations/fs-safe.js";
import { atomicWrite } from "../integrations/fs-safe.js";
import { log } from "../core/logger.js";
import { resolveKnowledgeSyncConfig } from "../integrations/knowledge-resolver.js";

/**
 * @param {string} cwd
 * @param {string} fileName
 */
async function migrateConfigFile(cwd, fileName) {
  const configPath = path.join(cwd, fileName);

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const config = parsed && typeof parsed === "object" ? parsed : {};
    const record = /** @type {Record<string, unknown>} */ (config);

    if (record.sync && typeof record.sync === "object" && !Array.isArray(record.sync)) {
      const normalized = resolveKnowledgeSyncConfig(
        /** @type {Record<string, unknown>} */ (record.sync)
      );
      record.sync = normalized;
      await atomicWrite(configPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      return {
        migrated: true,
        file: configPath
      };
    }

    const memory = record.memory && typeof record.memory === "object" && !Array.isArray(record.memory)
      ? /** @type {Record<string, unknown>} */ (record.memory)
      : {};
    const backend = typeof memory.backend === "string" ? memory.backend : "";
    const sync = resolveKnowledgeSyncConfig({
      knowledgeBackend: backend === "local-only" ? "local-only" : undefined
    });
    record.sync = sync;

    await atomicWrite(configPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    return {
      migrated: true,
      file: configPath
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {
        migrated: false,
        file: configPath
      };
    }

    log("warn", "migration migrateLocalOnlyToKnowledgeBackend failed for config", {
      file: configPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      migrated: false,
      file: configPath
    };
  }
}

/**
 * @param {string} [cwd]
 */
export async function migrate(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const targets = [
    "learning-context.config.json",
    "learning-context.config.production.json"
  ];
  const results = [];

  for (const target of targets) {
    results.push(await migrateConfigFile(root, target));
  }

  log("info", "migration completed", {
    migration: "migrateLocalOnlyToKnowledgeBackend",
    migratedFiles: results.filter((entry) => entry.migrated).length
  });

  return {
    migration: "migrateLocalOnlyToKnowledgeBackend",
    results
  };
}


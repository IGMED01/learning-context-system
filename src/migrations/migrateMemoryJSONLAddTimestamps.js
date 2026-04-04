// @ts-check

import path from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { readFile, atomicWrite } from "../integrations/fs-safe.js";
import { log } from "../core/logger.js";

/**
 * @param {unknown} value
 */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} value
 * @param {string} fallbackIso
 */
function normalizeIso(value, fallbackIso) {
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value.trim());
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return fallbackIso;
}

/**
 * @param {unknown} value
 * @param {string} fallbackIso
 */
function normalizeMs(value, fallbackIso) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }

  const parsed = Date.parse(fallbackIso);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * @param {string} filePath
 */
async function migrateFile(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);

    let changed = false;
    const migrated = lines.map((line) => {
      try {
        const parsed = JSON.parse(line);
        const entry = asRecord(parsed);
        const fallback = new Date().toISOString();
        const createdAt = normalizeIso(entry.createdAt, fallback);
        const updatedAt = normalizeIso(entry.updatedAt, createdAt);
        const createdAtMs = normalizeMs(entry.createdAtMs, createdAt);
        const updatedAtMs = normalizeMs(entry.updatedAtMs, updatedAt);
        const next = {
          ...entry,
          createdAt,
          updatedAt,
          createdAtMs,
          updatedAtMs
        };

        if (
          entry.createdAt !== createdAt ||
          entry.updatedAt !== updatedAt ||
          entry.createdAtMs !== createdAtMs ||
          entry.updatedAtMs !== updatedAtMs
        ) {
          changed = true;
        }

        return JSON.stringify(next);
      } catch {
        return line;
      }
    });

    if (!changed) {
      return {
        filePath,
        changed: false,
        lines: lines.length
      };
    }

    await atomicWrite(filePath, `${migrated.join("\n")}\n`, "utf8");
    return {
      filePath,
      changed: true,
      lines: lines.length
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {
        filePath,
        changed: false,
        lines: 0
      };
    }

    log("warn", "migration migrateMemoryJSONLAddTimestamps failed for file", {
      filePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      filePath,
      changed: false,
      lines: 0
    };
  }
}

/**
 * @param {string} memoryRoot
 */
async function listCandidateFiles(memoryRoot) {
  /** @type {string[]} */
  const files = [];
  await mkdir(memoryRoot, { recursive: true });
  const projects = await readdir(memoryRoot, { withFileTypes: true });

  for (const project of projects) {
    if (!project.isDirectory()) {
      continue;
    }
    const base = path.join(memoryRoot, project.name);
    files.push(path.join(base, "memories.jsonl"));
    files.push(path.join(base, "temp-memories.jsonl"));
  }

  return files;
}

/**
 * @param {string} [cwd]
 */
export async function migrate(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const memoryRoot = path.join(root, ".lcs", "memory");
  const files = await listCandidateFiles(memoryRoot);
  const results = [];

  for (const file of files) {
    results.push(await migrateFile(file));
  }

  const changedFiles = results.filter((entry) => entry.changed).length;
  log("info", "migration completed", {
    migration: "migrateMemoryJSONLAddTimestamps",
    changedFiles,
    scannedFiles: results.length
  });

  return {
    migration: "migrateMemoryJSONLAddTimestamps",
    changedFiles,
    scannedFiles: results.length,
    results
  };
}


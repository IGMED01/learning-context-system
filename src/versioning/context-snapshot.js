// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").ContextSnapshot} ContextSnapshot
 */

import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_SNAPSHOTS_DIR = ".lcs/snapshots";

/**
 * @param {string} project
 * @param {string} [baseDir]
 */
function snapshotFilePath(project, baseDir) {
  const slug = project.replace(/[^a-z0-9_-]/gi, "-").toLowerCase() || "default";
  return join(resolve(baseDir ?? process.cwd(), DEFAULT_SNAPSHOTS_DIR), `${slug}.jsonl`);
}

/**
 * @param {Omit<ContextSnapshot, "snapshotId" | "timestamp">} snapshot
 * @returns {Promise<ContextSnapshot>}
 */
export async function saveSnapshot(snapshot) {
  /** @type {ContextSnapshot} */
  const full = {
    ...snapshot,
    snapshotId: randomUUID(),
    timestamp: new Date().toISOString()
  };

  const filePath = snapshotFilePath(snapshot.project);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(full) + "\n", "utf8");

  return full;
}

/**
 * @param {string} project
 * @param {{ limit?: number, baseDir?: string }} [options]
 * @returns {Promise<ContextSnapshot[]>}
 */
export async function loadSnapshots(project, options) {
  const filePath = snapshotFilePath(project, options?.baseDir);

  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw.trim().split("\n").filter((l) => l.trim());

    const snapshots = lines.map((line) => {
      try {
        return /** @type {ContextSnapshot} */ (JSON.parse(line));
      } catch {
        return null;
      }
    }).filter((/** @type {ContextSnapshot | null} */ s) => s !== null);

    snapshots.reverse();

    if (options?.limit) {
      return snapshots.slice(0, options.limit);
    }

    return snapshots;
  } catch {
    return [];
  }
}

/**
 * @param {string} project
 * @param {string} [baseDir]
 * @returns {Promise<ContextSnapshot | undefined>}
 */
export async function getLatestSnapshot(project, baseDir) {
  const snapshots = await loadSnapshots(project, { limit: 1, baseDir });
  return snapshots[0];
}

/**
 * @param {string} project
 * @param {number} [limit]
 * @param {string} [baseDir]
 * @returns {Promise<{ snapshotId: string, timestamp: string, evalScore: number }[]>}
 */
export async function getScoreTrend(project, limit = 10, baseDir) {
  const snapshots = await loadSnapshots(project, { baseDir });

  return snapshots
    .filter((s) => typeof s.evalScore === "number")
    .slice(0, limit)
    .map((s) => ({
      snapshotId: s.snapshotId,
      timestamp: s.timestamp,
      evalScore: /** @type {number} */ (s.evalScore)
    }));
}

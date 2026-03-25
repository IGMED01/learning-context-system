/**
 * Context Snapshot — S8: Auditable record of each run's state.
 *
 * Captures what chunks were selected, what guard evaluated,
 * what prompt version was active, and what model was used.
 * Stored as JSONL in `.lcs/snapshots/{project}.jsonl`.
 */

import type { ContextSnapshot } from "../types/core-contracts.d.ts";

import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_SNAPSHOTS_DIR = ".lcs/snapshots";

function snapshotFilePath(project: string, baseDir?: string): string {
  const slug = project.replace(/[^a-z0-9_-]/gi, "-").toLowerCase() || "default";
  return join(resolve(baseDir ?? process.cwd(), DEFAULT_SNAPSHOTS_DIR), `${slug}.jsonl`);
}

export async function saveSnapshot(
  snapshot: Omit<ContextSnapshot, "snapshotId" | "timestamp">
): Promise<ContextSnapshot> {
  const full: ContextSnapshot = {
    ...snapshot,
    snapshotId: randomUUID(),
    timestamp: new Date().toISOString()
  };

  const filePath = snapshotFilePath(snapshot.project);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(full) + "\n", "utf8");

  return full;
}

export async function loadSnapshots(
  project: string,
  options?: { limit?: number; baseDir?: string }
): Promise<ContextSnapshot[]> {
  const filePath = snapshotFilePath(project, options?.baseDir);

  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw.trim().split("\n").filter((l) => l.trim());

    const snapshots = lines.map((line) => {
      try {
        return JSON.parse(line) as ContextSnapshot;
      } catch {
        return null;
      }
    }).filter((s): s is ContextSnapshot => s !== null);

    // Return most recent first
    snapshots.reverse();

    if (options?.limit) {
      return snapshots.slice(0, options.limit);
    }

    return snapshots;
  } catch {
    return [];
  }
}

export async function getLatestSnapshot(
  project: string,
  baseDir?: string
): Promise<ContextSnapshot | undefined> {
  const snapshots = await loadSnapshots(project, { limit: 1, baseDir });
  return snapshots[0];
}

/**
 * Get the eval score trend for a project (last N snapshots that have scores).
 */
export async function getScoreTrend(
  project: string,
  limit: number = 10,
  baseDir?: string
): Promise<{ snapshotId: string; timestamp: string; evalScore: number }[]> {
  const snapshots = await loadSnapshots(project, { baseDir });

  return snapshots
    .filter((s) => typeof s.evalScore === "number")
    .slice(0, limit)
    .map((s) => ({
      snapshotId: s.snapshotId,
      timestamp: s.timestamp,
      evalScore: s.evalScore!
    }));
}

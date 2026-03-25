// @ts-check

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_FILE_PATH = ".lcs/sync-drift.json";

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
 */
function toFinite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * @param {string} filePath
 */
async function loadState(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = asRecord(JSON.parse(raw.replace(/^\uFEFF/u, "")));
    return {
      history: Array.isArray(parsed.history)
        ? parsed.history.map((entry) => asRecord(entry))
        : []
    };
  } catch {
    return {
      history: []
    };
  }
}

/**
 * @param {string} filePath
 * @param {{ history: Record<string, unknown>[] }} state
 */
async function saveState(filePath, state) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * @param {Record<string, unknown>[]} history
 */
function summarize(history) {
  if (!history.length) {
    return {
      samples: 0,
      avgCreated: 0,
      avgChanged: 0,
      avgDeleted: 0,
      avgDiscovered: 0,
      avgChangeRatio: 0
    };
  }

  let created = 0;
  let changed = 0;
  let deleted = 0;
  let discovered = 0;

  for (const item of history) {
    created += toFinite(item.created);
    changed += toFinite(item.changed);
    deleted += toFinite(item.deleted);
    discovered += toFinite(item.discovered);
  }

  const samples = history.length;
  const avgCreated = created / samples;
  const avgChanged = changed / samples;
  const avgDeleted = deleted / samples;
  const avgDiscovered = discovered / samples;
  const avgChangeRatio = avgDiscovered
    ? (avgCreated + avgChanged + avgDeleted) / avgDiscovered
    : 0;

  return {
    samples,
    avgCreated: Number(avgCreated.toFixed(3)),
    avgChanged: Number(avgChanged.toFixed(3)),
    avgDeleted: Number(avgDeleted.toFixed(3)),
    avgDiscovered: Number(avgDiscovered.toFixed(3)),
    avgChangeRatio: Number(avgChangeRatio.toFixed(4))
  };
}

/**
 * NEXUS:0 — monitor drift between sync runs.
 * @param {{ filePath?: string, maxHistory?: number }} [options]
 */
export function createSyncDriftMonitor(options = {}) {
  const filePath = path.resolve(options.filePath ?? DEFAULT_FILE_PATH);
  const maxHistory = Math.max(5, Math.min(200, Math.trunc(Number(options.maxHistory ?? 60))));

  return {
    filePath,
    maxHistory,

    /**
     * @param {{
     *   status?: string,
     *   summary?: {
     *     discovered?: number,
     *     created?: number,
     *     changed?: number,
     *     deleted?: number,
     *     unchanged?: number
     *   }
     * }} input
     */
    async record(input) {
      const state = await loadState(filePath);
      const summary = asRecord(input.summary);
      const discovered = Math.max(0, Math.trunc(toFinite(summary.discovered)));
      const created = Math.max(0, Math.trunc(toFinite(summary.created)));
      const changed = Math.max(0, Math.trunc(toFinite(summary.changed)));
      const deleted = Math.max(0, Math.trunc(toFinite(summary.deleted)));
      const unchanged = Math.max(0, Math.trunc(toFinite(summary.unchanged)));
      const totalChange = created + changed + deleted;
      const changeRatio = discovered ? totalChange / discovered : 0;

      const snapshot = {
        at: new Date().toISOString(),
        status: typeof input.status === "string" ? input.status : "unknown",
        discovered,
        created,
        changed,
        deleted,
        unchanged,
        totalChange,
        changeRatio: Number(changeRatio.toFixed(4))
      };

      state.history.push(snapshot);
      state.history = state.history.slice(-maxHistory);

      await saveState(filePath, state);

      return {
        latest: snapshot,
        summary: summarize(state.history),
        historySize: state.history.length
      };
    },

    async getReport() {
      const state = await loadState(filePath);
      const history = state.history;
      const latest = history.length ? history[history.length - 1] : null;

      return {
        filePath,
        maxHistory,
        latest,
        summary: summarize(history),
        history
      };
    }
  };
}
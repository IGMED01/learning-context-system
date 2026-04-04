// @ts-check

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const OBSERVABILITY_SCHEMA_VERSION = "1.0.0";
const DEFAULT_OBSERVABILITY_FILE = ".lcs/observability.json";
const METRIC_FLUSH_INTERVAL_MS = 1_000;
const METRIC_BUFFER_FLUSH_THRESHOLD = 100;
/** @type {Map<string, CommandMetric[]>} */
const metricBufferByPath = new Map();
/** @type {Map<string, NodeJS.Timeout>} */
const metricFlushTimers = new Map();
/** @type {Map<string, Promise<{ flushed: number, error: string }>>} */
const metricFlushInFlight = new Map();
let metricShutdownHooksRegistered = false;

/**
 * @typedef {{
 *   command: string,
 *   durationMs: number,
 *   degraded?: boolean,
 *   selection?: {
 *     selectedCount?: number,
 *     suppressedCount?: number
 *   },
 *   sdd?: {
 *     enabled?: boolean,
 *     requiredKinds?: number,
 *     coveredKinds?: number,
 *     injectedKinds?: number,
 *     skippedReasons?: string[]
 *   },
 *   teaching?: {
 *     enabled?: boolean,
 *     sectionsPresent?: number,
 *     sectionsExpected?: number,
 *     hasPractice?: boolean
 *   },
 *   recall?: {
 *     attempted?: boolean,
 *     status?: string,
 *     recoveredChunks?: number,
 *     selectedChunks?: number,
 *     suppressedChunks?: number,
 *     hit?: boolean
 *   },
 *   safety?: {
 *     blocked?: boolean,
 *     reason?: string,
 *     preventedError?: boolean
 *   },
 *   security?: {
 *     recallAttempted?: boolean,
 *     recallHit?: boolean,
 *     criticalBlocked?: boolean,
 *     falsePositiveBlock?: boolean,
 *     memorySaved?: number,
 *     quarantined?: number
 *   }
 * }} CommandMetric
 */

/**
 * @param {unknown} value
 */
function toFiniteNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }

  return value;
}

/**
 * @param {number} value
 */
function round(value) {
  return Math.round(value * 1000) / 1000;
}

function defaultStore() {
  return {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    updatedAt: "",
    totals: {
      runs: 0,
      degradedRuns: 0,
      durationMsTotal: 0,
      blockedRuns: 0,
      preventedErrors: 0
    },
    commands: {},
    recall: {
      attempts: 0,
      hits: 0,
      recoveredChunksTotal: 0,
      selectedChunksTotal: 0,
      suppressedChunksTotal: 0,
      byStatus: {}
    },
    selection: {
      selectedTotal: 0,
      suppressedTotal: 0,
      samples: 0
    },
    sdd: {
      samples: 0,
      requiredKindsTotal: 0,
      coveredKindsTotal: 0,
      injectedKindsTotal: 0,
      bySkippedReason: {}
    },
    teaching: {
      samples: 0,
      sectionsPresentTotal: 0,
      sectionsExpectedTotal: 0,
      practiceCount: 0
    },
    safety: {
      blockedRuns: 0,
      preventedErrors: 0,
      byReason: {}
    },
    security: {
      recallAttempts: 0,
      recallHits: 0,
      criticalBlockCount: 0,
      falsePositiveBlocks: 0,
      memoryGrowth: 0,
      quarantined: 0
    }
  };
}

/**
 * @param {unknown} value
 */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {Record<string, unknown>} record
 */
function normalizedStore(record) {
  const defaults = defaultStore();
  const totals = asRecord(record.totals);
  const recall = asRecord(record.recall);
  const selection = asRecord(record.selection);
  const sdd = asRecord(record.sdd);
  const teaching = asRecord(record.teaching);
  const safety = asRecord(record.safety);
  const security = asRecord(record.security);
  const commands = asRecord(record.commands);

  return {
    schemaVersion:
      typeof record.schemaVersion === "string" && record.schemaVersion.trim()
        ? record.schemaVersion
        : defaults.schemaVersion,
    updatedAt:
      typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt : "",
    totals: {
      runs: toFiniteNumber(totals.runs),
      degradedRuns: toFiniteNumber(totals.degradedRuns),
      durationMsTotal: toFiniteNumber(totals.durationMsTotal),
      blockedRuns: toFiniteNumber(totals.blockedRuns),
      preventedErrors: toFiniteNumber(totals.preventedErrors)
    },
    commands,
    recall: {
      attempts: toFiniteNumber(recall.attempts),
      hits: toFiniteNumber(recall.hits),
      recoveredChunksTotal: toFiniteNumber(recall.recoveredChunksTotal),
      selectedChunksTotal: toFiniteNumber(recall.selectedChunksTotal),
      suppressedChunksTotal: toFiniteNumber(recall.suppressedChunksTotal),
      byStatus: asRecord(recall.byStatus)
    },
    selection: {
      selectedTotal: toFiniteNumber(selection.selectedTotal),
      suppressedTotal: toFiniteNumber(selection.suppressedTotal),
      samples: toFiniteNumber(selection.samples)
    },
    sdd: {
      samples: toFiniteNumber(sdd.samples),
      requiredKindsTotal: toFiniteNumber(sdd.requiredKindsTotal),
      coveredKindsTotal: toFiniteNumber(sdd.coveredKindsTotal),
      injectedKindsTotal: toFiniteNumber(sdd.injectedKindsTotal),
      bySkippedReason: asRecord(sdd.bySkippedReason)
    },
    teaching: {
      samples: toFiniteNumber(teaching.samples),
      sectionsPresentTotal: toFiniteNumber(teaching.sectionsPresentTotal),
      sectionsExpectedTotal: toFiniteNumber(teaching.sectionsExpectedTotal),
      practiceCount: toFiniteNumber(teaching.practiceCount)
    },
    safety: {
      blockedRuns: toFiniteNumber(safety.blockedRuns),
      preventedErrors: toFiniteNumber(safety.preventedErrors),
      byReason: asRecord(safety.byReason)
    },
    security: {
      recallAttempts: toFiniteNumber(security.recallAttempts),
      recallHits: toFiniteNumber(security.recallHits),
      criticalBlockCount: toFiniteNumber(security.criticalBlockCount),
      falsePositiveBlocks: toFiniteNumber(security.falsePositiveBlocks),
      memoryGrowth: toFiniteNumber(security.memoryGrowth),
      quarantined: toFiniteNumber(security.quarantined)
    }
  };
}

/**
 * @param {string} filePath
 */
async function loadStore(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/u, ""));

    return {
      found: true,
      error: "",
      store: normalizedStore(asRecord(parsed))
    };
  } catch (error) {
    if (error instanceof Error && /ENOENT/i.test(error.message)) {
      return {
        found: false,
        error: "",
        store: defaultStore()
      };
    }

    return {
      found: false,
      error: error instanceof Error ? error.message : String(error),
      store: defaultStore()
    };
  }
}

/**
 * @param {ReturnType<typeof normalizedStore>} store
 * @param {CommandMetric} metric
 */
function applyMetric(store, metric) {
  const now = new Date().toISOString();
  const durationMs = Math.max(0, Math.round(toFiniteNumber(metric.durationMs)));
  const degraded = metric.degraded === true;
  const command = metric.command.trim() || "unknown";
  const commandStats = asRecord(store.commands[command]);

  store.updatedAt = now;
  store.totals.runs += 1;
  store.totals.durationMsTotal += durationMs;

  if (degraded) {
    store.totals.degradedRuns += 1;
  }

  store.commands[command] = {
    runs: toFiniteNumber(commandStats.runs) + 1,
    degradedRuns: toFiniteNumber(commandStats.degradedRuns) + (degraded ? 1 : 0),
    blockedRuns: toFiniteNumber(commandStats.blockedRuns),
    durationMsTotal: toFiniteNumber(commandStats.durationMsTotal) + durationMs,
    lastDurationMs: durationMs,
    lastRunAt: now
  };

  if (metric.safety?.blocked) {
    const safetySummary = store.safety;
    const safetyReasonCounts = asRecord(safetySummary.byReason);
    const safetyReason = metric.safety.reason?.trim() || "unknown";
    const currentCommandStats = asRecord(store.commands[command]);

    safetySummary.blockedRuns += 1;
    safetySummary.byReason = safetyReasonCounts;
    safetyReasonCounts[safetyReason] = toFiniteNumber(safetyReasonCounts[safetyReason]) + 1;
    store.totals.blockedRuns += 1;
    store.commands[command] = {
      ...currentCommandStats,
      blockedRuns: toFiniteNumber(currentCommandStats.blockedRuns) + 1
    };
  }

  if (metric.safety?.preventedError) {
    store.safety.preventedErrors += 1;
    store.totals.preventedErrors += 1;
  }

  const selectedCount = Math.max(0, Math.round(toFiniteNumber(metric.selection?.selectedCount)));
  const suppressedCount = Math.max(0, Math.round(toFiniteNumber(metric.selection?.suppressedCount)));

  if (selectedCount > 0 || suppressedCount > 0) {
    store.selection.samples += 1;
    store.selection.selectedTotal += selectedCount;
    store.selection.suppressedTotal += suppressedCount;
  }

  if (metric.sdd?.enabled) {
    const requiredKinds = Math.max(
      0,
      Math.round(toFiniteNumber(metric.sdd.requiredKinds))
    );
    const coveredKinds = Math.max(
      0,
      Math.min(requiredKinds, Math.round(toFiniteNumber(metric.sdd.coveredKinds)))
    );
    const injectedKinds = Math.max(
      0,
      Math.round(toFiniteNumber(metric.sdd.injectedKinds))
    );
    const skippedReasons = Array.isArray(metric.sdd.skippedReasons)
      ? metric.sdd.skippedReasons
          .filter((entry) => typeof entry === "string" && entry.trim())
          .map((entry) => entry.trim())
      : [];
    const bySkippedReason = asRecord(store.sdd.bySkippedReason);

    store.sdd.samples += 1;
    store.sdd.requiredKindsTotal += requiredKinds;
    store.sdd.coveredKindsTotal += coveredKinds;
    store.sdd.injectedKindsTotal += injectedKinds;
    store.sdd.bySkippedReason = bySkippedReason;

    for (const reason of skippedReasons) {
      bySkippedReason[reason] = toFiniteNumber(bySkippedReason[reason]) + 1;
    }
  }

  if (metric.teaching?.enabled) {
    const sectionsExpected = Math.max(
      0,
      Math.round(toFiniteNumber(metric.teaching.sectionsExpected))
    );
    const sectionsPresent = Math.max(
      0,
      Math.min(sectionsExpected, Math.round(toFiniteNumber(metric.teaching.sectionsPresent)))
    );
    const hasPractice = metric.teaching.hasPractice === true;

    store.teaching.samples += 1;
    store.teaching.sectionsPresentTotal += sectionsPresent;
    store.teaching.sectionsExpectedTotal += sectionsExpected;
    if (hasPractice) {
      store.teaching.practiceCount += 1;
    }
  }

  if (metric.recall?.attempted) {
    const recoveredChunks = Math.max(
      0,
      Math.round(toFiniteNumber(metric.recall.recoveredChunks))
    );
    const selectedChunks = Math.max(0, Math.round(toFiniteNumber(metric.recall.selectedChunks)));
    const suppressedChunks = Math.max(
      0,
      Math.round(toFiniteNumber(metric.recall.suppressedChunks))
    );
    const hit = metric.recall.hit === true || recoveredChunks > 0;
    const status = metric.recall.status?.trim() || "unknown";
    const statusCounts = asRecord(store.recall.byStatus);

    store.recall.attempts += 1;
    store.recall.recoveredChunksTotal += recoveredChunks;
    store.recall.selectedChunksTotal += selectedChunks;
    store.recall.suppressedChunksTotal += suppressedChunks;
    store.recall.byStatus = statusCounts;
    statusCounts[status] = toFiniteNumber(statusCounts[status]) + 1;

    if (hit) {
      store.recall.hits += 1;
    }
  }

  if (metric.security) {
    if (metric.security.recallAttempted) {
      store.security.recallAttempts += 1;
    }

    if (metric.security.recallHit) {
      store.security.recallHits += 1;
    }

    if (metric.security.criticalBlocked) {
      store.security.criticalBlockCount += 1;
    }

    if (metric.security.falsePositiveBlock) {
      store.security.falsePositiveBlocks += 1;
    }

    store.security.memoryGrowth += Math.max(0, Math.round(toFiniteNumber(metric.security.memorySaved)));
    store.security.quarantined += Math.max(0, Math.round(toFiniteNumber(metric.security.quarantined)));
  }
}

/**
 * @param {string} filePath
 * @param {ReturnType<typeof normalizedStore>} store
 */
async function persistStore(filePath, store) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

/**
 * @param {{ cwd?: string, filePath?: string }} [options]
 */
function resolveMetricsPath(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const override = options.filePath ?? process.env.LCS_OBSERVABILITY_FILE ?? DEFAULT_OBSERVABILITY_FILE;

  return path.resolve(cwd, override);
}

/**
 * @param {string} filePath
 */
function getMetricBuffer(filePath) {
  let queue = metricBufferByPath.get(filePath);
  if (!queue) {
    queue = [];
    metricBufferByPath.set(filePath, queue);
  }

  return queue;
}

/**
 * @param {string} filePath
 */
function clearMetricFlushTimer(filePath) {
  const timer = metricFlushTimers.get(filePath);
  if (timer) {
    clearTimeout(timer);
    metricFlushTimers.delete(filePath);
  }
}

/**
 * @param {string} filePath
 */
function scheduleMetricFlush(filePath) {
  if (metricFlushTimers.has(filePath)) {
    return;
  }

  const timer = setTimeout(() => {
    metricFlushTimers.delete(filePath);
    void flushMetricsPath(filePath);
  }, METRIC_FLUSH_INTERVAL_MS);
  timer.unref?.();
  metricFlushTimers.set(filePath, timer);
}

/**
 * @param {string} filePath
 * @returns {Promise<{ flushed: number, error: string }>}
 */
async function flushMetricsPath(filePath) {
  const inFlight = metricFlushInFlight.get(filePath);
  if (inFlight) {
    return inFlight;
  }

  clearMetricFlushTimer(filePath);

  const run = (async () => {
    const queue = getMetricBuffer(filePath);
    if (queue.length === 0) {
      return { flushed: 0, error: "" };
    }

    const batch = queue.splice(0, queue.length);

    try {
      const loaded = await loadStore(filePath);
      for (const metric of batch) {
        applyMetric(loaded.store, metric);
      }
      await persistStore(filePath, loaded.store);
      return {
        flushed: batch.length,
        error: ""
      };
    } catch (error) {
      // Requeue at the front to avoid dropping metrics.
      queue.unshift(...batch);
      return {
        flushed: 0,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  })();

  metricFlushInFlight.set(filePath, run);
  try {
    return await run;
  } finally {
    metricFlushInFlight.delete(filePath);
  }
}

/**
 * @returns {Promise<void>}
 */
async function flushAllMetrics() {
  const paths = new Set([
    ...metricBufferByPath.keys(),
    ...metricFlushInFlight.keys()
  ]);

  for (const filePath of paths) {
    // eslint-disable-next-line no-await-in-loop
    await flushMetricsPath(filePath);
  }
}

function registerMetricShutdownHooks() {
  if (metricShutdownHooksRegistered) {
    return;
  }

  metricShutdownHooksRegistered = true;

  process.once("SIGTERM", () => {
    void flushAllMetrics();
  });

  process.once("beforeExit", () => {
    if (![...metricBufferByPath.values()].some((queue) => queue.length > 0)) {
      return;
    }

    return flushAllMetrics();
  });
}

/**
 * @param {CommandMetric} metric
 * @param {{ cwd?: string, filePath?: string }} [options]
 */
export async function recordCommandMetric(metric, options = {}) {
  const filePath = resolveMetricsPath(options);

  try {
    registerMetricShutdownHooks();
    const queue = getMetricBuffer(filePath);
    queue.push(metric);

    if (queue.length >= METRIC_BUFFER_FLUSH_THRESHOLD) {
      const flushed = await flushMetricsPath(filePath);
      return {
        stored: !flushed.error,
        filePath,
        error: flushed.error
      };
    }

    scheduleMetricFlush(filePath);

    return {
      stored: true,
      filePath,
      error: ""
    };
  } catch (error) {
    return {
      stored: false,
      filePath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * @param {Record<string, unknown>} commands
 */
function commandSummary(commands) {
  return Object.entries(commands)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([command, raw]) => {
      const item = asRecord(raw);
      const runs = toFiniteNumber(item.runs);
      const degradedRuns = toFiniteNumber(item.degradedRuns);
      const blockedRuns = toFiniteNumber(item.blockedRuns);
      const durationMsTotal = toFiniteNumber(item.durationMsTotal);

      return {
        command,
        runs,
        degradedRuns,
        blockedRuns,
        degradedRate: runs ? round(degradedRuns / runs) : 0,
        blockedRate: runs ? round(blockedRuns / runs) : 0,
        averageDurationMs: runs ? round(durationMsTotal / runs) : 0,
        lastDurationMs: toFiniteNumber(item.lastDurationMs),
        lastRunAt: typeof item.lastRunAt === "string" ? item.lastRunAt : ""
      };
    });
}

/**
 * @param {{ cwd?: string, filePath?: string }} [options]
 */
export async function getObservabilityReport(options = {}) {
  const filePath = resolveMetricsPath(options);
  const flushResult = await flushMetricsPath(filePath);
  const loaded = await loadStore(filePath);
  const totals = loaded.store.totals;
  const recall = loaded.store.recall;
  const selection = loaded.store.selection;
  const sdd = loaded.store.sdd;
  const teaching = loaded.store.teaching;
  const safety = loaded.store.safety;
  const security = loaded.store.security;
  const sddCoverageRate = sdd.requiredKindsTotal
    ? round(sdd.coveredKindsTotal / sdd.requiredKindsTotal)
    : 0;
  const teachingCoverageRate = teaching.sectionsExpectedTotal
    ? round(teaching.sectionsPresentTotal / teaching.sectionsExpectedTotal)
    : 0;
  const teachingPracticeRate = teaching.samples
    ? round(teaching.practiceCount / teaching.samples)
    : 0;

  return {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    filePath,
    found: loaded.found,
    loadError: flushResult.error || loaded.error,
    updatedAt: loaded.store.updatedAt,
    totals: {
      runs: totals.runs,
      degradedRuns: totals.degradedRuns,
      blockedRuns: totals.blockedRuns,
      preventedErrors: totals.preventedErrors,
      degradedRate: totals.runs ? round(totals.degradedRuns / totals.runs) : 0,
      blockedRate: totals.runs ? round(totals.blockedRuns / totals.runs) : 0,
      averageDurationMs: totals.runs ? round(totals.durationMsTotal / totals.runs) : 0
    },
    commands: commandSummary(loaded.store.commands),
    recall: {
      attempts: recall.attempts,
      hits: recall.hits,
      hitRate: recall.attempts ? round(recall.hits / recall.attempts) : 0,
      recoveredChunksTotal: recall.recoveredChunksTotal,
      selectedChunksTotal: recall.selectedChunksTotal,
      suppressedChunksTotal: recall.suppressedChunksTotal,
      byStatus: recall.byStatus
    },
    selection: {
      samples: selection.samples,
      selectedTotal: selection.selectedTotal,
      suppressedTotal: selection.suppressedTotal,
      averageSelected: selection.samples ? round(selection.selectedTotal / selection.samples) : 0,
      averageSuppressed: selection.samples
        ? round(selection.suppressedTotal / selection.samples)
        : 0
    },
    sdd: {
      samples: sdd.samples,
      requiredKindsTotal: sdd.requiredKindsTotal,
      coveredKindsTotal: sdd.coveredKindsTotal,
      injectedKindsTotal: sdd.injectedKindsTotal,
      coverageRate: sddCoverageRate,
      bySkippedReason: sdd.bySkippedReason,
      metrics: {
        sdd_coverage_rate: sddCoverageRate,
        sdd_injected_kinds: sdd.injectedKindsTotal,
        sdd_skipped_reason: sdd.bySkippedReason
      }
    },
    teaching: {
      samples: teaching.samples,
      sectionsPresentTotal: teaching.sectionsPresentTotal,
      sectionsExpectedTotal: teaching.sectionsExpectedTotal,
      practiceCount: teaching.practiceCount,
      coverageRate: teachingCoverageRate,
      practiceRate: teachingPracticeRate,
      metrics: {
        teaching_coverage_rate: teachingCoverageRate,
        teaching_practice_rate: teachingPracticeRate
      }
    },
    safety: {
      blockedRuns: safety.blockedRuns,
      preventedErrors: safety.preventedErrors,
      byReason: safety.byReason
    },
    security: {
      recallAttempts: security.recallAttempts,
      recallHits: security.recallHits,
      securityRecallHitRateAt5: security.recallAttempts
        ? round(security.recallHits / security.recallAttempts)
        : 0,
      criticalBlockCount: security.criticalBlockCount,
      falsePositiveBlocks: security.falsePositiveBlocks,
      falsePositiveBlockRate: security.criticalBlockCount
        ? round(security.falsePositiveBlocks / security.criticalBlockCount)
        : 0,
      securityMemoryGrowth: security.memoryGrowth,
      quarantined: security.quarantined,
      quarantineRate:
        security.memoryGrowth + security.quarantined > 0
          ? round(security.quarantined / (security.memoryGrowth + security.quarantined))
          : 0
    }
  };
}

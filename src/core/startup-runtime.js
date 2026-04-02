// @ts-check

/**
 * Parse a boolean-like environment/config value.
 *
 * @param {unknown} value
 * @param {boolean} [fallback]
 */
export function parseBooleanEnv(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

/**
 * Extract local static asset paths from a HTML document.
 * Paths are normalized without leading slash and with query/hash removed.
 *
 * @param {string} html
 * @param {{ maxAssets?: number }} [options]
 */
export function extractStaticAssetPathsFromHtml(html, options = {}) {
  const maxAssets = Number.isFinite(Number(options.maxAssets))
    ? Math.max(1, Math.min(64, Math.trunc(Number(options.maxAssets))))
    : 12;
  const source = String(html ?? "");
  const seen = new Set();
  const matches = source.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/giu);

  for (const match of matches) {
    const candidate = String(match[1] ?? "").trim();
    if (!candidate) {
      continue;
    }

    if (
      candidate.startsWith("http://") ||
      candidate.startsWith("https://") ||
      candidate.startsWith("data:") ||
      candidate.startsWith("mailto:") ||
      candidate.startsWith("#")
    ) {
      continue;
    }

    const sanitized = candidate.split(/[?#]/u)[0]?.replace(/^[/\\]+/u, "").trim();

    if (!sanitized || sanitized.includes("..")) {
      continue;
    }

    seen.add(sanitized);

    if (seen.size >= maxAssets) {
      break;
    }
  }

  return [...seen];
}

/**
 * @typedef {{
 *   phase: string,
 *   elapsedMs: number,
 *   context: Record<string, unknown>
 * }} StartupCheckpoint
 */

/**
 * @typedef {{
 *   enabled: boolean,
 *   startedAt: number,
 *   checkpoint: (phase: string, context?: Record<string, unknown>) => StartupCheckpoint | null,
 *   summary: (context?: Record<string, unknown>) => {
 *     totalMs: number,
 *     checkpoints: StartupCheckpoint[],
 *     context: Record<string, unknown>
 *   } | null,
 *   getCheckpoints: () => StartupCheckpoint[]
 * }} StartupProfiler
 */

/**
 * Lightweight startup profiler with injectable clock for deterministic tests.
 *
 * @param {{ enabled?: boolean, now?: () => number }} [options]
 * @returns {StartupProfiler}
 */
export function createStartupProfiler(options = {}) {
  const enabled = options.enabled !== false;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const startedAt = now();
  /** @type {StartupCheckpoint[]} */
  const checkpoints = [];

  return {
    enabled,
    startedAt,
    checkpoint(phase, context = {}) {
      if (!enabled) {
        return null;
      }

      const entry = {
        phase: String(phase ?? "").trim() || "unknown",
        elapsedMs: Math.max(0, now() - startedAt),
        context
      };
      checkpoints.push(entry);
      return entry;
    },
    summary(context = {}) {
      if (!enabled) {
        return null;
      }

      return {
        totalMs: Math.max(0, now() - startedAt),
        checkpoints: checkpoints.map((entry) => ({ ...entry })),
        context
      };
    },
    getCheckpoints() {
      return checkpoints.map((entry) => ({ ...entry }));
    }
  };
}


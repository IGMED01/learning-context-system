// @ts-check

const MS_PER_DAY = 86_400_000;
const DEFAULT_STALE_THRESHOLD_DAYS = 1;

/**
 * @param {unknown} value
 */
function asFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

/**
 * Calculates memory age in full days.
 * Future timestamps are clamped to 0 (clock skew protection).
 *
 * @param {number} mtimeMs
 * @returns {number}
 */
export function memoryAgeDays(mtimeMs) {
  const timestampMs = asFiniteNumber(mtimeMs);
  if (!Number.isFinite(timestampMs)) {
    return 0;
  }

  const ageMs = Date.now() - timestampMs;
  if (ageMs <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(ageMs / MS_PER_DAY));
}

/**
 * Returns freshness caveat text for stale memories.
 * Empty string means the memory is considered fresh.
 *
 * @param {number} mtimeMs
 * @param {number} [staleThresholdDays]
 * @returns {string}
 */
export function memoryFreshnessText(mtimeMs, staleThresholdDays = DEFAULT_STALE_THRESHOLD_DAYS) {
  const threshold = Number.isFinite(Number(staleThresholdDays))
    ? Math.max(0, Math.trunc(Number(staleThresholdDays)))
    : DEFAULT_STALE_THRESHOLD_DAYS;
  const days = memoryAgeDays(mtimeMs);

  if (days <= threshold) {
    return "";
  }

  return (
    `Note: This memory is ${days} day${days === 1 ? "" : "s"} old. ` +
    "It is a point-in-time observation. Verify against current state before acting on it."
  );
}

/**
 * Dual-constraint truncation: line cap first, then byte cap.
 * Keeps UTF-8 boundaries by truncating at line granularity.
 *
 * @param {string} content
 * @param {number} [maxLines]
 * @param {number} [maxBytes]
 * @returns {{ content: string, wasLineTruncated: boolean, wasByteTruncated: boolean }}
 */
export function truncateMemoryContent(content, maxLines = 200, maxBytes = 25_600) {
  const normalized = typeof content === "string" ? content : String(content ?? "");
  const normalizedMaxLines = Number.isFinite(Number(maxLines))
    ? Math.max(1, Math.trunc(Number(maxLines)))
    : 200;
  const normalizedMaxBytes = Number.isFinite(Number(maxBytes))
    ? Math.max(32, Math.trunc(Number(maxBytes)))
    : 25_600;

  let result = normalized;
  let wasLineTruncated = false;
  let wasByteTruncated = false;

  const lines = result.split("\n");
  if (lines.length > normalizedMaxLines) {
    result = lines.slice(0, normalizedMaxLines).join("\n");
    wasLineTruncated = true;
  }

  if (Buffer.byteLength(result, "utf8") > normalizedMaxBytes) {
    let byteCount = 0;
    /** @type {string[]} */
    const truncatedLines = [];

    for (const line of result.split("\n")) {
      const candidate = truncatedLines.length > 0 ? `\n${line}` : line;
      const candidateBytes = Buffer.byteLength(candidate, "utf8");
      if (byteCount + candidateBytes > normalizedMaxBytes) {
        break;
      }

      truncatedLines.push(line);
      byteCount += candidateBytes;
    }

    result = truncatedLines.join("\n");
    wasByteTruncated = true;
  }

  return {
    content: result,
    wasLineTruncated,
    wasByteTruncated
  };
}

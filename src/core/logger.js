// @ts-check

const LEVELS = {
  info: 0,
  warn: 1,
  error: 2
};

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|api[-_]?key|cookie)/i;

function resolveMinLevel() {
  const raw = String(process.env.LCS_LOG_LEVEL ?? "warn").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, raw)
    ? LEVELS[/** @type {"info" | "warn" | "error"} */ (raw)]
    : LEVELS.warn;
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function sanitizeValue(value, depth = 0) {
  if (depth > 3) {
    return "[Truncated]";
  }

  if (typeof value === "string") {
    return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeValue(entry, depth + 1));
  }

  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const sanitized = {};
    for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = REDACTED;
        continue;
      }
      sanitized[key] = sanitizeValue(entry, depth + 1);
    }
    return sanitized;
  }

  return value;
}

/**
 * Structured logger for NEXUS runtime.
 *
 * @param {"info" | "warn" | "error"} level
 * @param {string} message
 * @param {Record<string, unknown>} [context]
 */
export function log(level, message, context = {}) {
  const normalizedLevel = LEVELS[level] !== undefined ? level : "warn";

  if (LEVELS[normalizedLevel] < resolveMinLevel()) {
    return;
  }

  const payload = {
    timestamp: new Date().toISOString(),
    level: normalizedLevel,
    message: String(message ?? ""),
    context: sanitizeValue(context)
  };

  const line = JSON.stringify(payload);
  if (normalizedLevel === "error") {
    console.error(line);
    return;
  }

  if (normalizedLevel === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

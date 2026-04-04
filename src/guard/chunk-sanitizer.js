// @ts-check

const INJECTION_PATTERNS = [
  /(^|\n)\s*system\s*:.*(?=\n|$)/giu,
  /(^|\n)\s*ignore\s+(?:previous|all|above).*(?=\n|$)/giu,
  /(^|\n)\s*you\s+are\s+now.*(?=\n|$)/giu,
  /(^|\n)\s*disregard.*(?=\n|$)/giu
];

const INLINE_CONTROL_PATTERN = /<\|.*?\|>/gu;

/**
 * Sanitizes suspicious prompt-control fragments from chunk content.
 * Keeps regular code/content untouched while neutralizing common injections.
 *
 * @param {string} content
 * @returns {string}
 */
export function sanitizeChunkContent(content) {
  let sanitized = String(content ?? "");

  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "$1[SANITIZED]");
  }

  sanitized = sanitized.replace(INLINE_CONTROL_PATTERN, "[SANITIZED]");

  return sanitized;
}

/**
 * @template {Record<string, unknown>} T
 * @param {T[]} chunks
 * @returns {T[]}
 */
export function sanitizeChunks(chunks) {
  return chunks.map((chunk) => {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
      return chunk;
    }

    const record = /** @type {Record<string, unknown>} */ (chunk);
    const content =
      typeof record.content === "string"
        ? sanitizeChunkContent(record.content)
        : record.content;

    return /** @type {T} */ ({
      ...record,
      content
    });
  });
}

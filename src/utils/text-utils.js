// @ts-check

/**
 * text-utils.js — NEXUS Shared Text Utilities
 *
 * Consolidates repeated helpers that appeared in 29+ locations across the codebase:
 *   - tokenize()     (was duplicated ×13 in memory, search, context modules)
 *   - slugify()      (was duplicated ×13 in memory, storage, CLI modules)
 *   - compactText()  (was duplicated ×7  as compactLine/compact/normalize)
 *   - sleep()        (was duplicated ×4  as inline setTimeout promises)
 *   - toErrorMessage() (was duplicated ×3 as error instanceof Error checks)
 *
 * All consumers should import from here instead of defining inline.
 */

// ── Stopwords ──────────────────────────────────────────────────────────

/**
 * Common stopwords filtered from search queries and indexed documents.
 * Covers English and Spanish (used in NEXUS Spanish-language workflows).
 * @type {ReadonlySet<string>}
 */
export const STOPWORDS = new Set([
  // English
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "he", "in", "is", "it", "its", "of", "on", "or", "the",
  "to", "was", "were", "will", "with",
  // Spanish
  "de", "del", "el", "en", "es", "la", "las", "lo", "los",
  "que", "se", "un", "una", "y"
]);

// ── Text normalization ─────────────────────────────────────────────────

/**
 * Compact a string: collapse whitespace, trim edges.
 *
 * @param {string} value
 * @returns {string}
 */
export function compactText(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}

/**
 * Truncate a string to `maxLength`, compacting whitespace first.
 * Appends "..." when the string exceeds the limit.
 *
 * @param {string} value
 * @param {number} maxLength
 * @returns {string}
 */
export function truncate(value, maxLength) {
  const compacted = compactText(value);
  return compacted.length > maxLength
    ? `${compacted.slice(0, maxLength - 3)}...`
    : compacted;
}

// ── Slugification ──────────────────────────────────────────────────────

/**
 * Convert a string to a URL-safe slug.
 *
 * Steps:
 *   1. compact whitespace
 *   2. lowercase
 *   3. replace non-alphanumeric runs with "-"
 *   4. strip leading/trailing dashes
 *
 * Returns `"item"` for empty input (safe for use as a filename segment).
 *
 * @param {string} value
 * @param {{ fallback?: string }} [opts]
 * @returns {string}
 */
export function slugify(value, opts = {}) {
  const slug = compactText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/(^-|-$)/gu, "");

  return slug || opts.fallback || "item";
}

// ── Tokenization ───────────────────────────────────────────────────────

/**
 * Tokenize text into normalized terms, filtering stopwords.
 *
 * - Lowercases input
 * - Preserves accented Latin characters (U+00E0–U+024F)
 * - Removes punctuation
 * - Splits on whitespace
 * - Filters single-character tokens and stopwords
 *
 * @param {string} text
 * @param {{ stopwords?: ReadonlySet<string> }} [opts]
 * @returns {string[]}
 */
export function tokenize(text, opts = {}) {
  const stops = opts.stopwords ?? STOPWORDS;
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u00e0-\u024f]+/gu, " ")
    .split(/\s+/u)
    .filter((t) => t.length > 1 && !stops.has(t));
}

// ── Async helpers ──────────────────────────────────────────────────────

/**
 * Await a fixed delay.  Wraps `setTimeout` as a promise.
 * Using this avoids spawning inline arrow-function timers everywhere.
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Error helpers ──────────────────────────────────────────────────────

/**
 * Extract a human-readable message from any thrown value.
 * Avoids the repetitive `error instanceof Error ? error.message : String(error)` pattern.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * Build a structured error object from any thrown value.
 * Useful when you need both a message and the original cause.
 *
 * @param {unknown} error
 * @param {string} [context] - Optional prefix for the message
 * @returns {{ message: string, cause: unknown }}
 */
export function toErrorInfo(error, context) {
  const message = context
    ? `${context}: ${toErrorMessage(error)}`
    : toErrorMessage(error);
  return { message, cause: error };
}

/**
 * Tokenize without stopword filtering, preserving Unicode via NFKD normalization.
 * Used by legacy retrievers and eval scoring that need raw token overlap, not ranked search.
 * Distinct from `tokenize()` which applies stopwords and is tuned for TF-IDF search.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function tokenizeRaw(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
}

// ── TF-IDF primitives ──────────────────────────────────────────────────

/**
 * Compute term frequency: count of each term / total terms.
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
export function termFrequency(tokens) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const total = tokens.length || 1;
  /** @type {Map<string, number>} */
  const tf = new Map();
  for (const [term, count] of counts) tf.set(term, count / total);
  return tf;
}

/**
 * Compute smoothed IDF for query terms across a corpus of TF maps.
 * Formula: log((N + 1) / (df + 1)) + 1
 * @param {string[]} queryTerms
 * @param {Map<string, number>[]} documentTFs
 * @returns {Map<string, number>}
 */
export function inverseDocumentFrequency(queryTerms, documentTFs) {
  const N = documentTFs.length || 1;
  /** @type {Map<string, number>} */
  const idf = new Map();
  for (const term of queryTerms) {
    const df = documentTFs.filter((tf) => tf.has(term)).length;
    idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
  }
  return idf;
}

/**
 * Score a single document against query terms using TF-IDF.
 * @param {Map<string, number>} docTF
 * @param {string[]} queryTerms
 * @param {Map<string, number>} idf
 * @returns {number}
 */
export function tfidfScore(docTF, queryTerms, idf) {
  let score = 0;
  for (const term of queryTerms) score += (docTF.get(term) ?? 0) * (idf.get(term) ?? 1);
  return score;
}

// ── ID generation ──────────────────────────────────────────────────────

/**
 * Generate a time-sortable unique ID string.
 * Format: `<compacted-ISO-timestamp>-<slugified-label-prefix>`
 *
 * Example: `"20260331T120000000Z-my-memory-title"`
 *
 * @param {string} label   - Human label to embed (e.g. entry title)
 * @param {Date}  [date]   - Timestamp to use (defaults to now)
 * @param {number} [maxLabelLength] - Max slug chars from label (default 20)
 * @returns {string}
 */
export function makeTimestampId(label, date, maxLabelLength = 20) {
  const ts = (date ?? new Date()).toISOString().replace(/[-:.TZ]/gu, "");
  const slug = slugify(label, { fallback: "entry" }).slice(0, maxLabelLength);
  return `${ts}-${slug}`;
}

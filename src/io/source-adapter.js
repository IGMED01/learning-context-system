// @ts-check

/** @typedef {import("../types/core-contracts.d.ts").Chunk} Chunk */
/** @typedef {import("../types/core-contracts.d.ts").ChunkKind} ChunkKind */
/** @typedef {import("../types/core-contracts.d.ts").ScanStats} ScanStats */

/**
 * @typedef {{
 *   items: string[],
 *   skipped: number
 * }} SourceAdapterScanResult
 */

/**
 * @typedef {{
 *   chunks: Chunk[],
 *   stats: ScanStats
 * }} SourceAdapterReadResult
 */

/**
 * @typedef {{
 *   project?: string,
 *   maxContentChars?: number,
 *   security?: {
 *     redactSensitiveContent?: boolean,
 *     allowSensitivePaths?: string[]
 *   }
 * }} SourceAdapterOptions
 */

/**
 * @typedef {{
 *   readonly name: string,
 *   readonly supportedExtensions: string[],
 *   scan: (sourcePath: string, options?: SourceAdapterOptions) => Promise<SourceAdapterScanResult>,
 *   read: (sourcePath: string, options?: SourceAdapterOptions) => Promise<SourceAdapterReadResult>
 * }} SourceAdapter
 */

// ── Source Adapter Registry ──────────────────────────────────────────

/** @type {Map<string, SourceAdapter>} */
const adapters = new Map();

/**
 * @param {SourceAdapter} adapter
 */
export function registerAdapter(adapter) {
  adapters.set(adapter.name, adapter);
}

/**
 * @param {string} name
 * @returns {SourceAdapter | undefined}
 */
export function getAdapter(name) {
  return adapters.get(name);
}

/**
 * @returns {string[]}
 */
export function listAdapters() {
  return [...adapters.keys()];
}

// ── Shared Helpers ───────────────────────────────────────────────────

/**
 * @param {string} source
 * @returns {ChunkKind}
 */
export function classifyChunkKind(source) {
  const normalized = source.replace(/\\/g, "/").toLowerCase();

  if (normalized.endsWith(".pdf")) return "doc";
  if (normalized.endsWith(".md") || normalized.endsWith(".txt")) return "doc";
  if (normalized.endsWith(".log")) return "log";
  if (normalized.includes("/test/") || normalized.includes(".test.") || normalized.includes(".spec.")) return "test";
  if (normalized.includes("/docs/") || normalized === "readme.md") return "spec";
  if (/\.(js|ts|tsx|go|py|mjs|cjs)$/.test(normalized)) return "code";

  return "doc";
}

/**
 * @param {ChunkKind} kind
 */
export function defaultChunkSignals(kind) {
  switch (kind) {
    case "code": return { certainty: 0.92, recency: 0.75, teachingValue: 0.72, priority: 0.86 };
    case "test": return { certainty: 0.93, recency: 0.74, teachingValue: 0.8, priority: 0.84 };
    case "spec": return { certainty: 0.88, recency: 0.7, teachingValue: 0.82, priority: 0.78 };
    case "memory": return { certainty: 0.82, recency: 0.8, teachingValue: 0.86, priority: 0.78 };
    case "log": return { certainty: 0.35, recency: 0.6, teachingValue: 0.1, priority: 0.15 };
    case "chat": return { certainty: 0.45, recency: 0.5, teachingValue: 0.25, priority: 0.2 };
    default: return { certainty: 0.7, recency: 0.65, teachingValue: 0.6, priority: 0.55 };
  }
}

/**
 * Signals tuned for legal/normative documents.
 */
export function legalDocSignals() {
  return { certainty: 0.90, recency: 0.72, teachingValue: 0.88, priority: 0.85 };
}

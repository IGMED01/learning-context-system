import type { Chunk, ChunkKind, ScanStats } from "../types/core-contracts.d.ts";

// ── SourceAdapter Interface ──────────────────────────────────────────

export interface SourceAdapterScanResult {
  /** Discovered file/item paths relative to the source root */
  items: string[];
  /** How many items were skipped (security, extension filter, etc.) */
  skipped: number;
}

export interface SourceAdapterReadResult {
  chunks: Chunk[];
  stats: ScanStats;
}

export interface SourceAdapterOptions {
  /** Project name for scoping chunks */
  project?: string;
  /** Maximum characters per chunk content */
  maxContentChars?: number;
  /** Security options passed through to redaction */
  security?: {
    redactSensitiveContent?: boolean;
    allowSensitivePaths?: string[];
  };
}

/**
 * Formal contract for all source adapters.
 * Each adapter knows how to scan a source for items and read them into Chunk[].
 */
export interface SourceAdapter {
  /** Unique adapter name (e.g., "filesystem", "pdf", "markdown") */
  readonly name: string;
  /** File extensions or patterns this adapter handles */
  readonly supportedExtensions: string[];

  /** Discover available items at the given path */
  scan(sourcePath: string, options?: SourceAdapterOptions): Promise<SourceAdapterScanResult>;

  /** Read all items and convert to chunks */
  read(sourcePath: string, options?: SourceAdapterOptions): Promise<SourceAdapterReadResult>;
}

// ── Source Adapter Registry ──────────────────────────────────────────

const adapters = new Map<string, SourceAdapter>();

export function registerAdapter(adapter: SourceAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getAdapter(name: string): SourceAdapter | undefined {
  return adapters.get(name);
}

export function listAdapters(): string[] {
  return [...adapters.keys()];
}

// ── Shared Helpers ───────────────────────────────────────────────────

export function classifyChunkKind(source: string): ChunkKind {
  const normalized = source.replace(/\\/g, "/").toLowerCase();

  if (normalized.endsWith(".pdf")) return "doc";
  if (normalized.endsWith(".md") || normalized.endsWith(".txt")) return "doc";
  if (normalized.endsWith(".log")) return "log";
  if (normalized.includes("/test/") || normalized.includes(".test.") || normalized.includes(".spec.")) return "test";
  if (normalized.includes("/docs/") || normalized === "readme.md") return "spec";
  if (/\.(js|ts|tsx|go|py|mjs|cjs)$/.test(normalized)) return "code";

  return "doc";
}

export function defaultChunkSignals(kind: ChunkKind): {
  certainty: number;
  recency: number;
  teachingValue: number;
  priority: number;
} {
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
 * Higher certainty and teaching value than generic docs.
 */
export function legalDocSignals(): {
  certainty: number;
  recency: number;
  teachingValue: number;
  priority: number;
} {
  return { certainty: 0.90, recency: 0.72, teachingValue: 0.88, priority: 0.85 };
}

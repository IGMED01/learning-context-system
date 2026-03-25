/**
 * Chunk Repository — NEXUS:2: Unified CRUD for persisted chunks.
 *
 * Storage format: .lcs/chunks/{project-slug}/chunks.jsonl
 * One chunk per line, JSON-encoded.
 *
 * Search uses TF-IDF ranking (reimplemented here, independent of
 * the memory store's TF-IDF to keep concerns separate).
 */

import type {
  Chunk,
  ChunkKind,
  ScoredChunk,
  ChunkRepository as ChunkRepositoryType,
  ChunkRepositoryStats
} from "../types/core-contracts.d.ts";

import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

// ── Constants ────────────────────────────────────────────────────────

/** Common stopwords filtered from search queries and documents */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "de", "del", "el", "en",
  "es", "for", "from", "has", "he", "in", "is", "it", "its", "la", "las",
  "lo", "los", "of", "on", "or", "que", "se", "the", "to", "un", "una",
  "was", "were", "will", "with", "y"
]);

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Slugify a project id for use as a directory name.
 */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/(^-|-$)/gu, "");

  return slug || "_default";
}

// ── TF-IDF Search Engine ─────────────────────────────────────────────

/**
 * Tokenize text into normalized terms, filtering stopwords.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u00e0-\u024f]+/gu, " ")
    .split(/\s+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Compute term frequency: count of each term / total terms.
 */
function termFrequency(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const total = tokens.length || 1;
  const tf = new Map<string, number>();

  for (const [term, count] of counts) {
    tf.set(term, count / total);
  }

  return tf;
}

/**
 * Compute inverse document frequency for query terms across a corpus.
 */
function inverseDocumentFrequency(
  queryTerms: string[],
  documentTFs: Map<string, number>[]
): Map<string, number> {
  const N = documentTFs.length || 1;
  const idf = new Map<string, number>();

  for (const term of queryTerms) {
    let docsWithTerm = 0;

    for (const tf of documentTFs) {
      if (tf.has(term)) {
        docsWithTerm++;
      }
    }

    // Smoothed IDF: log((N + 1) / (docsWithTerm + 1)) + 1
    idf.set(term, Math.log((N + 1) / (docsWithTerm + 1)) + 1);
  }

  return idf;
}

/**
 * Score a single document against query terms using TF-IDF.
 */
function tfidfScore(
  docTF: Map<string, number>,
  queryTerms: string[],
  idf: Map<string, number>
): number {
  let score = 0;

  for (const term of queryTerms) {
    const tf = docTF.get(term) ?? 0;
    const idfVal = idf.get(term) ?? 1;
    score += tf * idfVal;
  }

  return score;
}

/**
 * Build searchable text from a chunk.
 */
function chunkToSearchText(chunk: Chunk): string {
  return `${chunk.source} ${chunk.kind} ${chunk.content}`;
}

// ── Persistence ──────────────────────────────────────────────────────

function projectDir(baseDir: string, projectId: string): string {
  return path.join(baseDir, slugify(projectId));
}

function chunksFilePath(baseDir: string, projectId: string): string {
  return path.join(projectDir(baseDir, projectId), "chunks.jsonl");
}

async function readChunks(filePath: string): Promise<Chunk[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);

    const chunks: Chunk[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);

        if (!parsed || typeof parsed !== "object") {
          continue;
        }

        const c = parsed as Record<string, unknown>;

        chunks.push({
          id: typeof c.id === "string" ? c.id : "",
          source: typeof c.source === "string" ? c.source : "",
          kind: (typeof c.kind === "string" ? c.kind : "doc") as ChunkKind,
          content: typeof c.content === "string" ? c.content : "",
          certainty: typeof c.certainty === "number" ? c.certainty : undefined,
          recency: typeof c.recency === "number" ? c.recency : undefined,
          teachingValue: typeof c.teachingValue === "number" ? c.teachingValue : undefined,
          priority: typeof c.priority === "number" ? c.priority : undefined,
          tokens: Array.isArray(c.tokens) ? c.tokens : undefined,
          tags: (c.tags && typeof c.tags === "object") ? c.tags as Record<string, unknown> : undefined
        });
      } catch {
        // skip malformed lines
      }
    }

    return chunks;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }
}

async function writeChunks(filePath: string, chunks: Chunk[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload = chunks.map((c) => JSON.stringify(c)).join("\n");
  await writeFile(filePath, payload ? `${payload}\n` : "", "utf8");
}

// ── Factory ──────────────────────────────────────────────────────────

export function createChunkRepository(
  options?: { baseDir?: string }
): ChunkRepositoryType {
  const baseDir = path.resolve(options?.baseDir ?? ".lcs/chunks");

  async function save(
    projectId: string,
    chunks: Chunk[]
  ): Promise<{ saved: number }> {
    if (!chunks.length) {
      return { saved: 0 };
    }

    const fp = chunksFilePath(baseDir, projectId);
    const existing = await readChunks(fp);
    const existingIds = new Set(existing.map((c) => c.id));

    // Upsert: replace existing chunks with same id, add new ones
    const updated = new Map<string, Chunk>();

    for (const c of existing) {
      updated.set(c.id, c);
    }

    let savedCount = 0;

    for (const c of chunks) {
      updated.set(c.id, c);

      if (!existingIds.has(c.id)) {
        savedCount++;
      } else {
        savedCount++;
      }
    }

    await writeChunks(fp, Array.from(updated.values()));

    return { saved: chunks.length };
  }

  async function load(projectId: string): Promise<Chunk[]> {
    return readChunks(chunksFilePath(baseDir, projectId));
  }

  async function remove(
    projectId: string,
    chunkIds: string[]
  ): Promise<{ removed: number }> {
    const fp = chunksFilePath(baseDir, projectId);
    const existing = await readChunks(fp);
    const toRemove = new Set(chunkIds);
    const filtered = existing.filter((c) => !toRemove.has(c.id));
    const removedCount = existing.length - filtered.length;

    if (removedCount > 0) {
      await writeChunks(fp, filtered);
    }

    return { removed: removedCount };
  }

  async function search(
    projectId: string,
    query: string,
    limit?: number
  ): Promise<ScoredChunk[]> {
    const chunks = await readChunks(chunksFilePath(baseDir, projectId));
    const queryTerms = tokenize(query);
    const maxResults = Math.max(1, Math.trunc(limit ?? 10));

    if (!queryTerms.length || !chunks.length) {
      return [];
    }

    // Build TF for all documents
    const docs = chunks.map((chunk) => ({
      chunk,
      tf: termFrequency(tokenize(chunkToSearchText(chunk)))
    }));

    // Compute IDF across the corpus
    const idf = inverseDocumentFrequency(
      queryTerms,
      docs.map((d) => d.tf)
    );

    // Score and rank
    const scored: ScoredChunk[] = [];

    for (const doc of docs) {
      const score = tfidfScore(doc.tf, queryTerms, idf);

      if (score > 0) {
        scored.push({ chunk: doc.chunk, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, maxResults);
  }

  async function stats(projectId: string): Promise<ChunkRepositoryStats> {
    const fp = chunksFilePath(baseDir, projectId);
    const chunks = await readChunks(fp);

    const byKind: Record<string, number> = {};

    for (const chunk of chunks) {
      byKind[chunk.kind] = (byKind[chunk.kind] ?? 0) + 1;
    }

    let sizeBytes = 0;

    try {
      const s = await stat(fp);
      sizeBytes = s.size;
    } catch {
      // file doesn't exist = 0 bytes
    }

    return {
      totalChunks: chunks.length,
      byKind,
      sizeBytes
    };
  }

  async function listProjects(): Promise<string[]> {
    try {
      const dirs = await readdir(baseDir, { withFileTypes: true });

      const projects: string[] = [];

      for (const dirent of dirs) {
        if (dirent.isDirectory()) {
          projects.push(dirent.name);
        }
      }

      return projects.sort();
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        return [];
      }

      throw error;
    }
  }

  async function clear(projectId: string): Promise<void> {
    const fp = chunksFilePath(baseDir, projectId);

    try {
      await writeChunks(fp, []);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        return;
      }

      throw error;
    }
  }

  return {
    save,
    load,
    remove,
    search,
    stats,
    listProjects,
    clear
  };
}

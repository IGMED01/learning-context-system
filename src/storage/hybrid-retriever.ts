/**
 * Hybrid Retriever — NEXUS:2: Combines BM25, TF-IDF, and signal scores.
 *
 * Retrieval pipeline:
 *   1. BM25 search → top 3*limit candidates
 *   2. TF-IDF on those candidates
 *   3. Signal score from chunk metadata (certainty + teachingValue + priority) / 3
 *   4. Normalize each score set to [0,1]
 *   5. Weighted combination → final score
 *   6. Sort, filter by minScore, return top limit
 */

import type {
  Chunk,
  ChunkKind,
  BM25Index as BM25IndexType,
  HybridRetriever as HybridRetrieverType,
  HybridRetrieverOptions,
  HybridResult
} from "../types/core-contracts.d.ts";

import { createBM25Index } from "./bm25-index.js";

// ── Constants ────────────────────────────────────────────────────────

/** Common stopwords filtered from search queries and documents */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "de", "del", "el", "en",
  "es", "for", "from", "has", "he", "in", "is", "it", "its", "la", "las",
  "lo", "los", "of", "on", "or", "que", "se", "the", "to", "un", "una",
  "was", "were", "will", "with", "y"
]);

// ── TF-IDF (local reimplementation for retriever scope) ─────────────

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

// ── Factory ──────────────────────────────────────────────────────────

export function createHybridRetriever(
  options?: HybridRetrieverOptions
): HybridRetrieverType {
  const bm25Weight = options?.bm25Weight ?? 0.4;
  const tfidfWeight = options?.tfidfWeight ?? 0.3;
  const signalWeight = options?.signalWeight ?? 0.3;

  const bm25 = createBM25Index();

  /** All indexed chunks, keyed by id */
  const chunkMap = new Map<string, Chunk>();

  function index(chunks: Chunk[]): void {
    bm25.clear();
    chunkMap.clear();

    for (const chunk of chunks) {
      chunkMap.set(chunk.id, chunk);
      bm25.addDocument(chunk.id, chunkToSearchText(chunk));
    }
  }

  function search(
    query: string,
    searchOptions?: {
      limit?: number;
      minScore?: number;
      kindFilter?: ChunkKind[];
    }
  ): HybridResult[] {
    const limit = Math.max(1, Math.trunc(searchOptions?.limit ?? 10));
    const minScore = searchOptions?.minScore ?? 0;
    const kindFilter = searchOptions?.kindFilter;

    if (chunkMap.size === 0) {
      return [];
    }

    // Step 1: BM25 search — get top 3*limit candidates
    const bm25Results = bm25.search(query, 3 * limit);

    if (!bm25Results.length) {
      return [];
    }

    // Collect candidate chunks (apply kind filter)
    const candidates: Array<{ chunk: Chunk; bm25Score: number }> = [];

    for (const result of bm25Results) {
      const chunk = chunkMap.get(result.id);

      if (!chunk) {
        continue;
      }

      if (kindFilter && kindFilter.length > 0 && !kindFilter.includes(chunk.kind)) {
        continue;
      }

      candidates.push({ chunk, bm25Score: result.score });
    }

    if (!candidates.length) {
      return [];
    }

    // Step 2: TF-IDF on the candidates
    const queryTerms = tokenize(query);
    const docTFs = candidates.map((c) =>
      termFrequency(tokenize(chunkToSearchText(c.chunk)))
    );
    const idf = inverseDocumentFrequency(queryTerms, docTFs);

    const tfidfScores: number[] = candidates.map((c, i) =>
      tfidfScore(docTFs[i], queryTerms, idf)
    );

    // Step 3: Signal scores from metadata
    const signalScores: number[] = candidates.map((c) => {
      const certainty = c.chunk.certainty ?? 0;
      const teachingValue = c.chunk.teachingValue ?? 0;
      const priority = c.chunk.priority ?? 0;
      return (certainty + teachingValue + priority) / 3;
    });

    // Step 4: Normalize each score set to [0,1]
    const maxBM25 = Math.max(...candidates.map((c) => c.bm25Score));
    const maxTFIDF = Math.max(...tfidfScores);
    const maxSignal = Math.max(...signalScores);

    const normBM25 = candidates.map((c) =>
      maxBM25 > 0 ? c.bm25Score / maxBM25 : 0
    );
    const normTFIDF = tfidfScores.map((s) =>
      maxTFIDF > 0 ? s / maxTFIDF : 0
    );
    const normSignal = signalScores.map((s) =>
      maxSignal > 0 ? s / maxSignal : 0
    );

    // Step 5: Weighted combination
    const results: HybridResult[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const finalScore =
        bm25Weight * normBM25[i] +
        tfidfWeight * normTFIDF[i] +
        signalWeight * normSignal[i];

      if (finalScore >= minScore) {
        results.push({
          chunk: candidates[i].chunk,
          score: finalScore,
          breakdown: {
            bm25: normBM25[i],
            tfidf: normTFIDF[i],
            signal: normSignal[i]
          }
        });
      }
    }

    // Step 6: Sort and limit
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  function size(): number {
    return chunkMap.size;
  }

  return {
    index,
    search,
    size
  };
}

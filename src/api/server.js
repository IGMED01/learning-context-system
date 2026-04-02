// @ts-check

import http from "node:http";
import path from "node:path";
import { createAuthMiddleware } from "./auth-middleware.js";
import { selectEndpointContext } from "../context/context-mode.js";
import {
  applyBaseSecurityHeaders,
  applyRateLimitHeaders,
  createRateLimiter,
  resolveCorsOrigin,
  sendRateLimitExceeded
} from "./security-runtime.js";
import { enforceOutputGuard } from "../guard/output-guard.js";
import { checkOutputCompliance } from "../guard/compliance-checker.js";
import { createOutputAuditor } from "../guard/output-auditor.js";
import {
  listDomainGuardPolicyProfiles,
  resolveDomainGuardPolicy
} from "../guard/domain-policy-profiles.js";
import { sanitizeChunkContent } from "../guard/chunk-sanitizer.js";
import { buildLlmPrompt } from "../llm/prompt-builder.js";
import { parseLlmResponse } from "../llm/response-parser.js";
import { createLlmProviderRegistry } from "../llm/provider.js";
import { createClaudeProvider } from "../llm/claude-provider.js";
import { createOpenAiProvider } from "../llm/openai-provider.js";
import { createSyncScheduler } from "../sync/sync-scheduler.js";
import { createSyncDriftMonitor } from "../sync/drift-monitor.js";
import { createSyncRuntime } from "../sync/sync-runtime.js";
import { createPipelineBuilder, buildDefaultNexusPipeline } from "../orchestration/pipeline-builder.js";
import { createDefaultExecutors } from "../orchestration/default-executors.js";
import { loadDomainEvalSuite, runDomainEvalSuite } from "../eval/domain-eval-suite.js";
import { buildDashboardData } from "../observability/dashboard-data.js";
import { evaluateObservabilityAlerts } from "../observability/alert-engine.js";
import { getObservabilityReport, recordCommandMetric } from "../observability/metrics-store.js";
import { createPromptVersionStore } from "../versioning/prompt-version-store.js";
import { createRollbackPolicy } from "../versioning/rollback-policy.js";
import { buildNexusOpenApiSpec } from "../interface/nexus-openapi.js";
import { buildNexusDemoPage } from "../interface/nexus-demo-page.js";

/**
 * @param {http.IncomingMessage} request
 */
async function readJsonBody(request) {
  const configuredMaxBytes = Number(process.env.LCS_API_MAX_BODY_BYTES ?? 1024 * 1024);
  const maxBodyBytes =
    Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 1024
      ? Math.trunc(configuredMaxBytes)
      : 1024 * 1024;
  /** @type {Buffer[]} */
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const normalizedChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += normalizedChunk.length;

    if (totalBytes > maxBodyBytes) {
      throw new Error(`Request body too large. Max bytes: ${maxBodyBytes}.`);
    }

    chunks.push(normalizedChunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON request body.");
  }
}

/**
 * @param {http.ServerResponse} response
 * @param {number} statusCode
 * @param {unknown} payload
 */
function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * @param {http.ServerResponse} response
 * @param {number} statusCode
 * @param {string} html
 */
function sendHtml(response, statusCode, html) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(html);
}

/**
 * @param {string} text
 */
function estimateTokenCount(text) {
  const normalized = String(text ?? "").trim();

  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.ceil(normalized.length / 4));
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
 * @param {unknown} value
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function createRequestId() {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {{
 *   rawChunks?: number,
 *   rawTokens?: number,
 *   selectedChunks?: number,
 *   selectedTokens?: number,
 *   suppressedChunks?: number,
 *   suppressedTokens?: number
 * }} input
 */
function buildContextImpact(input) {
  const rawChunks = Math.max(0, Math.trunc(Number(input.rawChunks ?? 0)));
  const rawTokens = Math.max(0, Math.trunc(Number(input.rawTokens ?? 0)));
  const selectedChunks = Math.max(0, Math.trunc(Number(input.selectedChunks ?? 0)));
  const selectedTokens = Math.max(0, Math.trunc(Number(input.selectedTokens ?? 0)));
  const inferredSuppressedChunks = Math.max(0, rawChunks - selectedChunks);
  const inferredSuppressedTokens = Math.max(0, rawTokens - selectedTokens);
  const suppressedChunks = Number.isFinite(Number(input.suppressedChunks))
    ? Math.max(0, Math.trunc(Number(input.suppressedChunks)))
    : inferredSuppressedChunks;
  const suppressedTokens = Number.isFinite(Number(input.suppressedTokens))
    ? Math.max(0, Math.trunc(Number(input.suppressedTokens)))
    : inferredSuppressedTokens;
  const savingsPercent =
    rawTokens > 0 ? Number(((suppressedTokens / rawTokens) * 100).toFixed(1)) : 0;

  return {
    withoutNexus: {
      chunks: rawChunks,
      tokens: rawTokens
    },
    withNexus: {
      chunks: selectedChunks,
      tokens: selectedTokens
    },
    suppressed: {
      chunks: suppressedChunks,
      tokens: suppressedTokens
    },
    savings: {
      chunks: suppressedChunks,
      tokens: suppressedTokens,
      percent: savingsPercent
    }
  };
}

/**
 * @param {unknown} sdd
 */
function buildSddMetricSummary(sdd) {
  const record = asRecord(sdd);
  if (record.enabled !== true) {
    return undefined;
  }

  const requiredKinds = Array.isArray(record.requiredKinds)
    ? record.requiredKinds.filter((entry) => typeof entry === "string" && entry.trim()).length
    : 0;
  const coverage = asRecord(record.coverage);
  const coveredKinds = Object.entries(coverage).filter(([, covered]) => covered === true).length;
  const injectedKinds = Array.isArray(record.injectedKinds)
    ? record.injectedKinds.filter((entry) => typeof entry === "string" && entry.trim()).length
    : 0;
  const skippedReasons = Array.isArray(record.skippedKinds)
    ? record.skippedKinds
        .map((entry) => asRecord(entry))
        .map((entry) => (typeof entry.reason === "string" ? entry.reason.trim() : ""))
        .filter(Boolean)
    : [];

  return {
    enabled: true,
    requiredKinds,
    coveredKinds,
    injectedKinds,
    skippedReasons
  };
}

/**
 * @param {unknown} parsed
 */
function buildTeachingMetricSummary(parsed) {
  const record = asRecord(parsed);
  const concepts = Array.isArray(record.concepts)
    ? record.concepts
        .filter((entry) => typeof entry === "string" && entry.trim())
        .length
    : 0;
  const hasChange = typeof record.change === "string" && record.change.trim().length > 0;
  const hasReason = typeof record.reason === "string" && record.reason.trim().length > 0;
  const hasPractice = typeof record.practice === "string" && record.practice.trim().length > 0;
  const sectionsPresent =
    (hasChange ? 1 : 0) +
    (hasReason ? 1 : 0) +
    (concepts > 0 ? 1 : 0) +
    (hasPractice ? 1 : 0);

  return {
    enabled: true,
    sectionsExpected: 4,
    sectionsPresent,
    hasPractice
  };
}

const DEFAULT_RAG_LIMIT = 8;
const DEFAULT_RAG_RERANK_TOP_K = 12;
const RAG_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "con",
  "de",
  "del",
  "el",
  "en",
  "es",
  "for",
  "from",
  "in",
  "is",
  "la",
  "las",
  "los",
  "of",
  "on",
  "or",
  "para",
  "por",
  "que",
  "the",
  "to",
  "un",
  "una",
  "with",
  "y"
]);

/**
 * @param {unknown} value
 * @param {boolean} fallback
 */
function normalizeBooleanFlag(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * @param {number | undefined} value
 * @param {{ min: number, max: number, fallback: number }} range
 */
function clampInteger(value, range) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return range.fallback;
  }

  const normalized = Math.trunc(value);
  return Math.max(range.min, Math.min(range.max, normalized));
}

/**
 * @param {string} value
 */
function tokenizeRagText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 1 && !RAG_STOPWORDS.has(entry));
}

/**
 * @param {string[]} queryTokens
 * @param {string[]} chunkTokens
 */
function overlapScore(queryTokens, chunkTokens) {
  if (!queryTokens.length || !chunkTokens.length) {
    return 0;
  }

  const chunkSet = new Set(chunkTokens);
  const overlap = queryTokens.filter((token) => chunkSet.has(token)).length;

  return overlap / Math.max(1, queryTokens.length);
}

/**
 * @param {string} query
 * @param {string} content
 */
function phraseScore(query, content) {
  const normalizedQuery = String(query ?? "").toLowerCase().trim();
  const normalizedContent = String(content ?? "").toLowerCase();
  if (!normalizedQuery || !normalizedContent) {
    return 0;
  }

  if (normalizedContent.includes(normalizedQuery)) {
    return 1;
  }

  const queryTerms = tokenizeRagText(normalizedQuery);
  if (queryTerms.length < 2) {
    return 0;
  }

  const bigrams = [];
  for (let index = 0; index < queryTerms.length - 1; index += 1) {
    bigrams.push(`${queryTerms[index]} ${queryTerms[index + 1]}`);
  }

  const matches = bigrams.filter((bigram) => normalizedContent.includes(bigram)).length;
  return matches / Math.max(1, bigrams.length);
}

/**
 * @param {Record<string, unknown>} chunk
 */
function ragKindPrior(chunk) {
  const kind = String(chunk.kind ?? "doc").toLowerCase();
  if (kind === "spec") {
    return 1;
  }
  if (kind === "test") {
    return 0.9;
  }
  if (kind === "code") {
    return 0.85;
  }
  if (kind === "doc") {
    return 0.7;
  }
  if (kind === "memory") {
    return 0.65;
  }

  return 0.5;
}

/**
 * @param {Record<string, unknown>} chunk
 * @param {string} query
 */
function scoreRagSemanticChunk(chunk, query) {
  const queryTokens = tokenizeRagText(query);
  const contentTokens = tokenizeRagText(String(chunk.content ?? ""));
  const sourceTokens = tokenizeRagText(String(chunk.source ?? ""));
  const overlap = overlapScore(queryTokens, contentTokens);
  const sourceOverlap = overlapScore(queryTokens, sourceTokens);
  const phrase = phraseScore(query, String(chunk.content ?? ""));
  const kindPrior = ragKindPrior(chunk);

  return Number(
    (
      overlap * 0.5 +
      phrase * 0.2 +
      sourceOverlap * 0.1 +
      kindPrior * 0.2
    ).toFixed(6)
  );
}

/**
 * @param {Array<Record<string, unknown>>} chunks
 * @param {string} query
 * @param {{ rerankTopK: number }} options
 */
function rerankRagChunks(chunks, query, options) {
  if (!chunks.length) {
    return {
      chunks: [],
      applied: false
    };
  }

  const rerankTopK = clampInteger(options.rerankTopK, {
    min: 1,
    max: 48,
    fallback: DEFAULT_RAG_RERANK_TOP_K
  });
  const candidates = chunks.slice(0, rerankTopK);
  const rerankedCandidates = candidates
    .map((chunk, index) => {
      const retrievalScore =
        typeof chunk.retrievalScore === "number" && Number.isFinite(chunk.retrievalScore)
          ? chunk.retrievalScore
          : typeof chunk.priority === "number" && Number.isFinite(chunk.priority)
            ? chunk.priority
            : 0;
      const semanticScore = scoreRagSemanticChunk(chunk, query);
      const finalScore = Number((retrievalScore * 0.65 + semanticScore * 0.35).toFixed(6));

      return {
        chunk: {
          ...chunk,
          retrievalScore,
          semanticScore,
          priority: finalScore
        },
        index,
        finalScore
      };
    })
    .sort((left, right) => right.finalScore - left.finalScore);

  const tail = chunks.slice(rerankTopK);
  const reranked = [
    ...rerankedCandidates.map((entry) => entry.chunk),
    ...tail
  ];

  return {
    chunks: reranked,
    applied: true
  };
}

/**
 * @param {number[]} left
 * @param {number[]} right
 */
function cosineSimilarity(left, right) {
  if (!left.length || !right.length) {
    return 0;
  }

  const size = Math.min(left.length, right.length);
  if (!size) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < size; index += 1) {
    const leftValue = Number.isFinite(left[index]) ? left[index] : 0;
    const rightValue = Number.isFinite(right[index]) ? right[index] : 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/**
 * @param {string} value
 * @param {number} maxChars
 */
function clipEmbeddingText(value, maxChars = 1_600) {
  const normalized = String(value ?? "").trim().replace(/\s+/gu, " ");
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return normalized.slice(0, Math.max(0, maxChars));
}

/**
 * @param {{
 *   registry: ReturnType<typeof createLlmProviderRegistry>,
 *   provider: string,
 *   model?: string,
 *   query: string,
 *   chunks: Array<Record<string, unknown>>,
 *   rerankTopK: number
 * }} input
 */
async function rerankRagChunksWithEmbeddings(input) {
  const provider = input.registry.get(input.provider);

  if (typeof provider.embed !== "function") {
    return {
      chunks: input.chunks,
      applied: false,
      provider: provider.provider,
      model: input.model ?? "",
      reason: `provider '${provider.provider}' does not support embeddings`
    };
  }

  if (!input.chunks.length) {
    return {
      chunks: [],
      applied: false,
      provider: provider.provider,
      model: input.model ?? "",
      reason: "no-chunks"
    };
  }

  const rerankTopK = clampInteger(input.rerankTopK, {
    min: 1,
    max: 48,
    fallback: DEFAULT_RAG_RERANK_TOP_K
  });
  const candidates = input.chunks.slice(0, rerankTopK);
  const queryEmbedding = await provider.embed(clipEmbeddingText(input.query, 900), {
    model: input.model
  });

  if (!Array.isArray(queryEmbedding.vector) || !queryEmbedding.vector.length) {
    return {
      chunks: input.chunks,
      applied: false,
      provider: provider.provider,
      model: input.model ?? "",
      reason: "empty-query-embedding"
    };
  }

  const rerankedCandidates = await Promise.all(
    candidates.map(async (chunk, index) => {
      const retrievalScore =
        typeof chunk.retrievalScore === "number" && Number.isFinite(chunk.retrievalScore)
          ? chunk.retrievalScore
          : typeof chunk.priority === "number" && Number.isFinite(chunk.priority)
            ? chunk.priority
            : 0;
      const embeddingInput = clipEmbeddingText(
        `${String(chunk.source ?? "")}\n${String(chunk.content ?? "")}`,
        1_600
      );
      const chunkEmbedding = await provider.embed(embeddingInput, {
        model: input.model
      });
      const cosine = cosineSimilarity(queryEmbedding.vector, chunkEmbedding.vector);
      const semanticScore = Number((((cosine + 1) / 2)).toFixed(6));
      const finalScore = Number((retrievalScore * 0.6 + semanticScore * 0.4).toFixed(6));

      return {
        chunk: {
          ...chunk,
          retrievalScore,
          vectorScore: semanticScore,
          semanticScore,
          priority: finalScore
        },
        index,
        finalScore
      };
    })
  );

  rerankedCandidates.sort((left, right) => right.finalScore - left.finalScore);
  const tail = input.chunks.slice(rerankTopK);

  return {
    chunks: [
      ...rerankedCandidates.map((entry) => entry.chunk),
      ...tail
    ],
    applied: true,
    provider: provider.provider,
    model: queryEmbedding.model || input.model || "",
    reason: ""
  };
}

/**
 * @param {Array<Record<string, unknown>>} chunks
 */
function dedupeContextChunks(chunks) {
  const seen = new Set();
  /** @type {Array<Record<string, unknown>>} */
  const deduped = [];

  for (const chunk of chunks) {
    const id = String(chunk.id ?? "").trim();
    const source = String(chunk.source ?? "").trim();
    const content = String(chunk.content ?? "").trim();
    const key = id || `${source}::${content.slice(0, 160)}`;

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(chunk);
  }

  return deduped;
}

/**
 * @param {Array<Record<string, unknown>>} chunks
 * @param {string} query
 * @param {number} limit
 */
function computeRagQualityProxy(chunks, query, limit) {
  const top = chunks.slice(0, Math.max(1, limit));
  if (!top.length) {
    return {
      mrr: 0,
      recallAtK: 0,
      ndcgAtK: 0
    };
  }

  const relevances = top.map((chunk) => scoreRagSemanticChunk(chunk, query));
  const firstRelevantIndex = relevances.findIndex((score) => score >= 0.2);
  const mrr = firstRelevantIndex >= 0 ? Number((1 / (firstRelevantIndex + 1)).toFixed(4)) : 0;
  const recallAtK = Number(
    (
      relevances.filter((score) => score >= 0.2).length / Math.max(1, top.length)
    ).toFixed(4)
  );
  const dcg = relevances.reduce((sum, rel, index) => {
    const gain = Math.pow(2, rel) - 1;
    const discount = Math.log2(index + 2);
    return sum + gain / discount;
  }, 0);
  const sorted = [...relevances].sort((left, right) => right - left);
  const idcg = sorted.reduce((sum, rel, index) => {
    const gain = Math.pow(2, rel) - 1;
    const discount = Math.log2(index + 2);
    return sum + gain / discount;
  }, 0);
  const ndcgAtK = idcg > 0 ? Number((dcg / idcg).toFixed(4)) : 0;

  return {
    mrr,
    recallAtK,
    ndcgAtK
  };
}

/**
 * @param {Record<string, unknown>} promptRequest
 * @param {"ask" | "chat"} endpoint
 * @param {Array<Record<string, unknown>>} explicitChunks
 * @param {(context: { input: unknown }) => Promise<Record<string, unknown>>} recallExecutor
 * @param {ReturnType<typeof createLlmProviderRegistry>} registry
 */
async function resolveRagAugmentedChunks(
  promptRequest,
  endpoint,
  explicitChunks,
  recallExecutor,
  registry
) {
  const includeContext = promptRequest.withContext !== false;
  const rag = asRecord(promptRequest.rag);
  const enabled = includeContext && normalizeBooleanFlag(rag.enabled, true);
  const autoRetrieve = normalizeBooleanFlag(rag.autoRetrieve, true);
  const rerank = normalizeBooleanFlag(rag.rerank, true);
  const forceRetrieve = normalizeBooleanFlag(rag.force, false);
  const envAutoRetrieve = process.env.LCS_RAG_AUTO_RETRIEVE !== "false";
  const envRerank = process.env.LCS_RAG_ENABLE_RERANK !== "false";
  const envEmbeddingsEnabled = process.env.LCS_RAG_EMBEDDINGS_ENABLED === "true";
  const project = String(promptRequest.project ?? "default").trim() || "default";
  const query = `${promptRequest.query ?? ""} ${promptRequest.task ?? ""} ${promptRequest.objective ?? ""}`.trim();
  const embeddingRequested = normalizeBooleanFlag(rag.embeddings, true);
  const embeddingProvider = String(
    rag.embeddingProvider ?? process.env.LCS_RAG_EMBEDDINGS_PROVIDER ?? "openai"
  )
    .trim();
  const embeddingModel = String(
    rag.embeddingModel ?? process.env.LCS_RAG_EMBEDDINGS_MODEL ?? "text-embedding-3-small"
  )
    .trim();
  const limit = clampInteger(
    typeof rag.limit === "number" ? rag.limit : undefined,
    { min: 1, max: 24, fallback: DEFAULT_RAG_LIMIT }
  );
  const rerankTopK = clampInteger(
    typeof rag.rerankTopK === "number" ? rag.rerankTopK : undefined,
    { min: 1, max: 48, fallback: DEFAULT_RAG_RERANK_TOP_K }
  );
  const shouldRetrieve =
    enabled &&
    envAutoRetrieve &&
    autoRetrieve &&
    Boolean(query) &&
    (forceRetrieve || explicitChunks.length === 0);

  /** @type {Array<Record<string, unknown>>} */
  let retrievedChunks = [];
  let retrievalError = "";

  if (shouldRetrieve) {
    try {
      const recallState = await recallExecutor({
        input: {
          projectId: project,
          query,
          limit
        }
      });
      const results = asArray(asRecord(recallState).results);
      retrievedChunks = results.map((entry, index) => {
        const normalized = normalizeLegacyChunk(entry, index);
        const breakdown = asRecord(asRecord(entry).breakdown);
        const bm25 = Number(breakdown.bm25 ?? 0);
        const tfidf = Number(breakdown.tfidf ?? 0);
        const signal = Number(breakdown.signal ?? 0);
        return {
          id: normalized.id,
          source: normalized.source,
          kind: normalized.kind,
          content: normalized.content,
          priority: normalized.priority,
          retrievalScore: normalized.score,
          retrievalBreakdown: {
            bm25: Number.isFinite(bm25) ? bm25 : 0,
            tfidf: Number.isFinite(tfidf) ? tfidf : 0,
            signal: Number.isFinite(signal) ? signal : 0
          },
          tags: {
            origin: "rag-auto"
          }
        };
      });
    } catch (error) {
      retrievalError = error instanceof Error ? error.message : String(error);
      retrievedChunks = [];
    }
  }

  const shouldAttemptEmbeddingRerank =
    retrievedChunks.length > 0 &&
    rerank &&
    envRerank &&
    embeddingRequested &&
    envEmbeddingsEnabled &&
    Boolean(embeddingProvider) &&
    Boolean(query);
  let embeddingMeta = {
    requested: embeddingRequested,
    enabledByEnv: envEmbeddingsEnabled,
    applied: false,
    provider: "",
    model: embeddingModel,
    error: ""
  };
  /** @type {{ chunks: Array<Record<string, unknown>>, applied: boolean }} */
  let rerankResult;

  if (shouldAttemptEmbeddingRerank) {
    try {
      const embeddingRerank = await rerankRagChunksWithEmbeddings({
        registry,
        provider: embeddingProvider,
        model: embeddingModel,
        query,
        chunks: retrievedChunks,
        rerankTopK
      });

      rerankResult = {
        chunks: embeddingRerank.chunks,
        applied: embeddingRerank.applied
      };
      embeddingMeta = {
        ...embeddingMeta,
        applied: embeddingRerank.applied,
        provider: embeddingRerank.provider,
        model: embeddingRerank.model || embeddingModel,
        error: embeddingRerank.reason || ""
      };
    } catch (error) {
      embeddingMeta = {
        ...embeddingMeta,
        provider: embeddingProvider,
        error: error instanceof Error ? error.message : String(error)
      };
      rerankResult = rerankRagChunks(retrievedChunks, query, { rerankTopK });
    }
  } else {
    rerankResult =
      retrievedChunks.length > 0 && rerank && envRerank
        ? rerankRagChunks(retrievedChunks, query, { rerankTopK })
        : { chunks: retrievedChunks, applied: false };
  }
  const selectedRetrieved = rerankResult.chunks.slice(0, limit);
  const mergedChunks = dedupeContextChunks([...explicitChunks, ...selectedRetrieved]);
  const quality = computeRagQualityProxy(selectedRetrieved, query, limit);

  return {
    chunks: mergedChunks,
    rag: {
      enabled,
      endpoint,
      autoRetrieve: shouldRetrieve,
      project,
      query,
      explicitChunks: explicitChunks.length,
      retrievedChunks: selectedRetrieved.length,
      mergedChunks: mergedChunks.length,
      rerankApplied: rerankResult.applied,
      rerankTopK: rerankResult.applied ? rerankTopK : 0,
      embeddingRequested: embeddingMeta.requested,
      embeddingApplied: embeddingMeta.applied,
      embeddingProvider: embeddingMeta.provider,
      embeddingModel: embeddingMeta.model,
      embeddingError: embeddingMeta.error,
      quality,
      topSources: selectedRetrieved.slice(0, 5).map((chunk) => String(chunk.source ?? "")),
      error: retrievalError
    },
    recallMetric: {
      attempted: shouldRetrieve,
      status: shouldRetrieve
        ? retrievalError
          ? "failed"
          : selectedRetrieved.length
            ? "recalled"
            : "empty"
        : "skipped",
      recoveredChunks: selectedRetrieved.length,
      selectedChunks: selectedRetrieved.length,
      suppressedChunks: Math.max(0, explicitChunks.length + selectedRetrieved.length - mergedChunks.length),
      hit: selectedRetrieved.length > 0
    }
  };
}

/**
 * @param {unknown} entry
 * @param {number} index
 */
function normalizeLegacyChunk(entry, index = 0) {
  const record = asRecord(entry);
  const chunkRecord = asRecord(record.chunk);
  const id =
    String(record.id ?? chunkRecord.id ?? `chunk-${index + 1}`).trim() ||
    `chunk-${index + 1}`;
  const source =
    String(record.source ?? chunkRecord.source ?? id).trim() || id;
  const content = String(record.content ?? chunkRecord.content ?? "");
  const score = Number(record.score ?? record.priority ?? chunkRecord.priority ?? 0);
  const safeScore = Number.isFinite(score) ? Math.max(0, score) : 0;
  const tokens = estimateTokenCount(content);

  return {
    id,
    source,
    kind: String(record.kind ?? chunkRecord.kind ?? "doc"),
    content,
    score: safeScore,
    priority: safeScore,
    tokens
  };
}

/**
 * @param {http.ServerResponse} response
 * @param {number} statusCode
 * @param {{
 *   requestId: string,
 *   code: string,
 *   message: string,
 *   details?: Record<string, unknown>
 * }} input
 */
function sendErrorJson(response, statusCode, input) {
  sendJson(response, statusCode, {
    status: "error",
    error: input.message,
    errorCode: input.code,
    requestId: input.requestId,
    details: input.details ?? {}
  });
}

/**
 * @param {http.IncomingMessage} request
 */
function getRequestUrl(request) {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
}

/**
 * @param {string} workspaceRoot
 * @param {string} candidate
 * @param {string} label
 */
function resolveSafePathWithinWorkspace(workspaceRoot, candidate, label) {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed === ".") {
    return workspaceRoot;
  }

  const resolved = path.resolve(workspaceRoot, trimmed);
  if (resolved === workspaceRoot || resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    return resolved;
  }

  throw new Error(`${label} must stay inside workspace root.`);
}

/**
 * @param {unknown} input
 * @param {string} workspaceRoot
 * @returns {Record<string, unknown>}
 */
function normalizePipelineInput(input, workspaceRoot) {
  const record = asRecord(input);
  const normalized = {
    ...record
  };

  for (const key of ["path", "sourcePath", "inputPath"]) {
    const value = record[key];

    if (typeof value !== "string") {
      continue;
    }

    normalized[key] = resolveSafePathWithinWorkspace(workspaceRoot, value, key);
  }

  return normalized;
}

/**
 * @param {unknown} value
 */
function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {{ ok: true, value: number | undefined } | { ok: false, message: string }}
 */
function normalizeOptionalFiniteNumber(value, field) {
  if (value === undefined) {
    return {
      ok: true,
      value: undefined
    };
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      ok: false,
      message: `Field '${field}' must be a finite number.`
    };
  }

  return {
    ok: true,
    value
  };
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {{
 *   ok: true,
 *   value: Partial<Record<"workspace" | "memory" | "chat", number>> | undefined
 * } | {
 *   ok: false,
 *   message: string
 * }}
 */
function normalizeOptionalSourceBudgets(value, field) {
  if (value === undefined) {
    return {
      ok: true,
      value: undefined
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      message: `Field '${field}' must be an object with workspace/memory/chat numeric ratios.`
    };
  }

  const record = /** @type {Record<string, unknown>} */ (value);
  /** @type {Partial<Record<"workspace" | "memory" | "chat", number>>} */
  const parsed = {};

  for (const key of ["workspace", "memory", "chat"]) {
    if (!(key in record)) {
      continue;
    }

    const numeric = record[key];
    if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
      return {
        ok: false,
        message: `Field '${field}.${key}' must be a finite number between 0 and 1.`
      };
    }

    if (numeric < 0 || numeric > 1) {
      return {
        ok: false,
        message: `Field '${field}.${key}' must be between 0 and 1.`
      };
    }

    parsed[/** @type {"workspace" | "memory" | "chat"} */ (key)] = numeric;
  }

  return {
    ok: true,
    value: Object.keys(parsed).length ? parsed : undefined
  };
}

/**
 * @param {unknown} chunksInput
 * @returns {{ ok: true, chunks: Record<string, unknown>[] } | { ok: false, message: string }}
 */
function normalizePromptChunks(chunksInput) {
  if (!Array.isArray(chunksInput)) {
    return {
      ok: true,
      chunks: []
    };
  }

  const chunks = chunksInput.slice(0, 100);
  /** @type {Record<string, unknown>[]} */
  const normalized = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];

    if (typeof chunk === "string") {
      const content = sanitizeChunkContent(chunk.trim());

      if (!content) {
        continue;
      }

      const id = `chunk-${index + 1}`;
      normalized.push({
        id,
        source: id,
        kind: "doc",
        content
      });
      continue;
    }

    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
      return {
        ok: false,
        message: `Invalid chunk at index ${index}. Expected string or object.`
      };
    }

    const record = asRecord(chunk);

    if (record.source !== undefined && typeof record.source !== "string") {
      return {
        ok: false,
        message: `Invalid chunk at index ${index}. Field 'source' must be a string.`
      };
    }
    if (record.id !== undefined && typeof record.id !== "string") {
      return {
        ok: false,
        message: `Invalid chunk at index ${index}. Field 'id' must be a string.`
      };
    }
    if (record.content !== undefined && typeof record.content !== "string") {
      return {
        ok: false,
        message: `Invalid chunk at index ${index}. Field 'content' must be a string.`
      };
    }
    if (record.priority !== undefined && typeof record.priority !== "number") {
      return {
        ok: false,
        message: `Invalid chunk at index ${index}. Field 'priority' must be a number.`
      };
    }
    if (record.score !== undefined && typeof record.score !== "number") {
      return {
        ok: false,
        message: `Invalid chunk at index ${index}. Field 'score' must be a number.`
      };
    }
    if (record.kind !== undefined && typeof record.kind !== "string") {
      return {
        ok: false,
        message: `Invalid chunk at index ${index}. Field 'kind' must be a string.`
      };
    }

    const id =
      typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : `chunk-${index + 1}`;
    const source =
      typeof record.source === "string" && record.source.trim()
        ? record.source.trim()
        : id;

    normalized.push({
      ...record,
      id,
      source,
      kind: typeof record.kind === "string" && record.kind.trim() ? record.kind.trim() : "doc",
      content: typeof record.content === "string" ? sanitizeChunkContent(record.content) : ""
    });
  }

  return {
    ok: true,
    chunks: normalized
  };
}

/**
 * @param {Record<string, unknown>} body
 * @param {"ask" | "chat"} endpoint
 */
function normalizePromptRequest(body, endpoint) {
  const query =
    endpoint === "ask"
      ? String(body.question ?? "").trim()
      : String(body.query ?? body.question ?? "").trim();

  if (!query) {
    return {
      ok: false,
      errorCode: endpoint === "ask" ? "missing_question" : "missing_query",
      errorMessage:
        endpoint === "ask"
          ? "Missing 'question' in request body."
          : "Missing 'query' in request body."
    };
  }

  if (query.length > 4000) {
    return {
      ok: false,
      errorCode: "query_too_long",
      errorMessage:
        endpoint === "ask"
          ? "Field 'question' exceeds max length (4000 chars)."
          : "Field 'query' exceeds max length (4000 chars)."
    };
  }

  const tokenBudget = normalizeOptionalFiniteNumber(body.tokenBudget, "tokenBudget");
  if (!tokenBudget.ok) {
    return {
      ok: false,
      errorCode: "invalid_token_budget",
      errorMessage: tokenBudget.message
    };
  }

  const maxChunks = normalizeOptionalFiniteNumber(body.maxChunks, "maxChunks");
  if (!maxChunks.ok) {
    return {
      ok: false,
      errorCode: "invalid_max_chunks",
      errorMessage: maxChunks.message
    };
  }

  const sourceBudgets = normalizeOptionalSourceBudgets(body.sourceBudgets, "sourceBudgets");
  if (!sourceBudgets.ok) {
    return {
      ok: false,
      errorCode: "invalid_source_budgets",
      errorMessage: sourceBudgets.message
    };
  }

  const chunks = normalizePromptChunks(body.withContext === false ? [] : body.chunks);
  if (!chunks.ok) {
    return {
      ok: false,
      errorCode: "invalid_chunks",
      errorMessage: chunks.message
    };
  }

  const ragRecord = asRecord(body.rag);
  const ragLimit = normalizeOptionalFiniteNumber(
    ragRecord.limit ?? body.ragLimit,
    "ragLimit"
  );
  if (!ragLimit.ok) {
    return {
      ok: false,
      errorCode: "invalid_rag_limit",
      errorMessage: ragLimit.message
    };
  }
  const ragRerankTopK = normalizeOptionalFiniteNumber(
    ragRecord.rerankTopK ?? body.ragRerankTopK,
    "ragRerankTopK"
  );
  if (!ragRerankTopK.ok) {
    return {
      ok: false,
      errorCode: "invalid_rag_rerank_top_k",
      errorMessage: ragRerankTopK.message
    };
  }

  return {
    ok: true,
    value: {
      query,
      task: normalizeOptionalText(body.task),
      objective: normalizeOptionalText(body.objective),
      language: body.language === "es" || body.language === "en" ? body.language : undefined,
      framework: normalizeOptionalText(body.framework),
      domain: normalizeOptionalText(body.domain),
      sddProfile: normalizeOptionalText(body.sddProfile),
      project: normalizeOptionalText(body.project),
      provider: normalizeOptionalText(body.provider),
      fallbackProviders: Array.isArray(body.fallbackProviders)
        ? body.fallbackProviders
            .filter((value) => typeof value === "string" && value.trim())
            .map((value) => value.trim())
            .slice(0, 8)
        : [],
      attemptTimeoutMs:
        typeof body.attemptTimeoutMs === "number" && Number.isFinite(body.attemptTimeoutMs)
          ? body.attemptTimeoutMs
          : undefined,
      model: normalizeOptionalText(body.model),
      withContext: body.withContext !== false,
      chunks: chunks.chunks,
      tokenBudget: tokenBudget.value,
      maxChunks: maxChunks.value,
      sourceBudgets: sourceBudgets.value,
      rag: {
        enabled: normalizeBooleanFlag(ragRecord.enabled ?? body.ragEnabled, true),
        autoRetrieve: normalizeBooleanFlag(
          ragRecord.autoRetrieve ?? body.ragAutoRetrieve,
          true
        ),
        force: normalizeBooleanFlag(ragRecord.force ?? body.ragForce, false),
        limit: ragLimit.value,
        rerank: normalizeBooleanFlag(ragRecord.rerank ?? body.ragRerank, true),
        rerankTopK: ragRerankTopK.value,
        embeddings: normalizeBooleanFlag(ragRecord.embeddings ?? body.ragEmbeddings, true),
        embeddingProvider: normalizeOptionalText(
          ragRecord.embeddingProvider ?? body.ragEmbeddingProvider
        ),
        embeddingModel: normalizeOptionalText(
          ragRecord.embeddingModel ?? body.ragEmbeddingModel
        )
      },
      guardPolicyProfile: normalizeOptionalText(body.guardPolicyProfile),
      guard: asRecord(body.guard),
      compliance: asRecord(body.compliance)
    }
  };
}

/**
 * NEXUS:10 — HTTP server exposing ask/guard/sync orchestration endpoints.
 * @param {{
 *   host?: string,
 *   port?: number,
 *   auth?: {
 *     requireAuth?: boolean,
 *     apiKeys?: string[],
 *     jwtSecret?: string
 *   },
 *   llm?: {
 *     defaultProvider?: string,
 *     providers?: Array<import("../llm/provider.js").LlmProvider>,
 *     claude?: Parameters<typeof createClaudeProvider>[0],
 *     openai?: Parameters<typeof createOpenAiProvider>[0],
 *     attemptTimeoutMs?: number,
 *     tokenBudget?: number,
 *     maxChunks?: number
 *   },
 *   sync?: {
 *     rootPath?: string,
 *     intervalMs?: number,
 *     stateFilePath?: string,
 *     manifestFilePath?: string,
 *     versionFilePath?: string,
 *     repositoryBaseDir?: string,
 *     projectId?: string,
 *     maxCharsPerChunk?: number,
 *     security?: Parameters<import("../security/secret-redaction.js").resolveSecurityPolicy>[0],
 *     autoStart?: boolean,
 *     driftFilePath?: string,
 *     driftMaxHistory?: number
 *   },
 *   repositoryFilePath?: string,
 *   outputAuditFilePath?: string,
 *   observabilityFilePath?: string,
 *   promptVersionFilePath?: string,
 *   openApi?: {
 *     title?: string,
 *     version?: string,
 *     description?: string
 *   },
 *   rollbackPolicy?: {
 *     minScore?: number,
 *     preferPrevious?: boolean,
 *     requireAtLeastVersions?: number
 *   },
 *   evals?: {
 *     defaultDomainSuitePath?: string
 *   }
 * }} [options]
 */
export function createNexusApiServer(options = {}) {
  const auth = createAuthMiddleware(options.auth);
  const outputAuditor = createOutputAuditor({
    filePath: options.outputAuditFilePath
  });

  const registry = createLlmProviderRegistry({
    defaultProvider: options.llm?.defaultProvider,
    providers: options.llm?.providers
  });

  if (!registry.list().length) {
    registry.register(createClaudeProvider(options.llm?.claude));
  }

  const hasOpenAiKey = typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim();
  if (hasOpenAiKey && !registry.list().includes("openai")) {
    registry.register(createOpenAiProvider(options.llm?.openai));
  }

  const syncRootPath = path.resolve(options.sync?.rootPath ?? process.cwd());
  const apiWorkspaceRoot = syncRootPath;
  const defaultExecutors = createDefaultExecutors({
    repositoryBaseDir: options.sync?.repositoryBaseDir,
    repositoryFilePath: options.repositoryFilePath,
    resolveSourcePath(sourcePath) {
      return resolveSafePathWithinWorkspace(apiWorkspaceRoot, sourcePath, "sourcePath");
    }
  });
  const pipelineBuilder = createPipelineBuilder({
    executors: {
      ingest: defaultExecutors.ingest,
      process: defaultExecutors.process,
      store: defaultExecutors.store,
      recall: defaultExecutors.recall
    }
  });
  const syncRuntime = createSyncRuntime({
    rootPath: syncRootPath,
    projectId: options.sync?.projectId,
    stateFilePath: options.sync?.stateFilePath,
    manifestFilePath: options.sync?.manifestFilePath,
    versionFilePath: options.sync?.versionFilePath,
    repositoryBaseDir: options.sync?.repositoryBaseDir,
    maxCharsPerChunk: options.sync?.maxCharsPerChunk,
    security: options.sync?.security
  });
  const driftMonitor = createSyncDriftMonitor({
    filePath: options.sync?.driftFilePath,
    maxHistory: options.sync?.driftMaxHistory
  });

  let lastSyncResult = {
    status: "never",
    runId: "",
    summary: {
      discovered: 0,
      created: 0,
      changed: 0,
      deleted: 0,
      unchanged: 0,
      filesChanged: 0,
      filesSkipped: 0,
      chunksProcessed: 0,
      chunksPersisted: 0,
      chunksCreated: 0,
      chunksUpdated: 0,
      chunksUnchanged: 0,
      chunksTombstoned: 0,
      duplicatesDetected: 0,
      redactionsApplied: 0
    },
    startedAt: "",
    finishedAt: "",
    files: {
      created: [],
      changed: [],
      deleted: [],
      unchanged: []
    },
    errors: [],
    warnings: [],
    runtime: {
      engine: "nexus-sync-internal",
      dedupScope: "per-source",
      repositoryBaseDir: syncRuntime.repositoryBaseDir
    }
  };

  const scheduler = createSyncScheduler({
    intervalMs: options.sync?.intervalMs,
    autoStart: options.sync?.autoStart,
    async onTick() {
      const startedAt = new Date().toISOString();
      try {
        const result = await syncRuntime.run();
        lastSyncResult = {
          ...result
        };
        await driftMonitor.record(lastSyncResult);

        if (result.status === "error") {
          throw new Error(result.errors?.[0] || "Sync runtime failed.");
        }
      } catch (error) {
        lastSyncResult = {
          status: "error",
          runId: "",
          startedAt,
          finishedAt: new Date().toISOString(),
          summary: {
            discovered: 0,
            created: 0,
            changed: 0,
            deleted: 0,
            unchanged: 0,
            filesChanged: 0,
            filesSkipped: 0,
            chunksProcessed: 0,
            chunksPersisted: 0,
            chunksCreated: 0,
            chunksUpdated: 0,
            chunksUnchanged: 0,
            chunksTombstoned: 0,
            duplicatesDetected: 0,
            redactionsApplied: 0
          },
          files: {
            created: [],
            changed: [],
            deleted: [],
            unchanged: []
          },
          errors: [error instanceof Error ? error.message : String(error)],
          warnings: [],
          runtime: {
            engine: "nexus-sync-internal",
            dedupScope: "per-source",
            repositoryBaseDir: syncRuntime.repositoryBaseDir
          }
        };
        await driftMonitor.record(lastSyncResult);
        throw error;
      }
    }
  });
  const observabilityFilePath = options.observabilityFilePath;
  const promptVersionStore = createPromptVersionStore({
    filePath: options.promptVersionFilePath
  });
  const rollbackPolicy = createRollbackPolicy(options.rollbackPolicy);
  const defaultDomainSuitePath = path.resolve(
    options.evals?.defaultDomainSuitePath ?? "benchmark/domain-eval-suite.json"
  );
  const openApiSpec = buildNexusOpenApiSpec({
    title: options.openApi?.title,
    version: options.openApi?.version,
    description: options.openApi?.description
  });
  const demoPage = buildNexusDemoPage();
  const compatibilityRoutes = [
    "GET /api/health",
    "GET /api/routes",
    "GET /api/metrics",
    "POST /api/remember",
    "POST /api/recall",
    "POST /api/chat",
    "POST /api/guard",
    "GET /api/openapi.json",
    "GET /api/demo",
    "GET /api/guard/policies",
    "POST /api/guard/output",
    "POST /api/pipeline/run",
    "POST /api/ask",
    "GET /api/sync/status",
    "GET /api/sync/drift",
    "POST /api/sync",
    "GET /api/observability/dashboard",
    "GET /api/observability/alerts",
    "POST /api/evals/domain-suite",
    "GET /api/versioning/prompts",
    "POST /api/versioning/prompts",
    "GET /api/versioning/compare",
    "POST /api/versioning/rollback-plan"
  ];

  const host = options.host ?? "127.0.0.1";
  const port = Math.max(0, Number(options.port ?? 8787));
  const corsOrigin = resolveCorsOrigin(
    options.corsOrigin ?? process.env.LCS_API_CORS_ORIGIN ?? process.env.LCS_API_CORS,
    host,
    port
  );
  const rateLimiter = createRateLimiter({
    heavyRoutes: ["/api/chat", "/api/ask", "/api/evals/domain-suite", "/api/sync", "/api/pipeline/run"]
  });
  const publicCompatibilityPaths = new Set(["/api/health"]);

  /**
   * @param {string} command
   * @param {number} startedAt
   * @param {Parameters<typeof recordCommandMetric>[0]} [metric]
   */
  async function recordApiMetric(command, startedAt, metric = { command, durationMs: 0 }) {
    await recordCommandMetric(
      {
        ...metric,
        command,
        durationMs: Math.max(0, Date.now() - startedAt)
      },
      {
        filePath: observabilityFilePath
      }
    );
  }

  const server = http.createServer(async (request, response) => {
    const requestStartedAt = Date.now();
    const requestId = createRequestId();
    response.setHeader("x-request-id", requestId);
    applyBaseSecurityHeaders(response);

    try {
      const method = request.method ?? "GET";
      const requestUrl = getRequestUrl(request);
      const pathname = requestUrl.pathname || "/";
      response.setHeader("Access-Control-Allow-Origin", corsOrigin);
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-API-Key, X-Project, X-Data-Dir, X-Request-Id"
      );
      response.setHeader("Access-Control-Max-Age", "86400");

      if (pathname.startsWith("/api/") && method === "OPTIONS") {
        response.writeHead(204, { "Content-Type": "application/json" });
        response.end();
        return;
      }

      if (pathname.startsWith("/api/") && method !== "OPTIONS") {
        const rateLimit = rateLimiter.check(request, pathname);
        applyRateLimitHeaders(response, rateLimit);

        if (!rateLimit.allowed) {
          sendRateLimitExceeded(response, rateLimit);
          await recordApiMetric("api.rate_limited", requestStartedAt, {
            command: "api.rate_limited",
            durationMs: 0,
            degraded: true,
            safety: {
              blocked: true,
              reason: "rate-limited"
            }
          });
          return;
        }
      }

      if (pathname.startsWith("/api/") && method !== "OPTIONS" && !publicCompatibilityPaths.has(pathname)) {
        const earlyCompatibilityPath = new Set([
          "/api/routes",
          "/api/metrics",
          "/api/openapi.json",
          "/api/demo",
          "/api/guard/policies"
        ]);

        if (earlyCompatibilityPath.has(pathname)) {
          const authResult = auth.authorize({
            headers: request.headers
          });

          if (!authResult.authorized) {
            sendErrorJson(response, authResult.statusCode ?? 401, {
              requestId,
              code: "auth_unauthorized",
              message: authResult.error ?? "Unauthorized request.",
              details: {
                reason: authResult.reason ?? "unauthorized"
              }
            });
            await recordApiMetric(`api${pathname.replace(/^\/api/, "").replaceAll("/", ".")}`, requestStartedAt, {
              command: `api${pathname.replace(/^\/api/, "").replaceAll("/", ".")}`,
              durationMs: 0,
              degraded: true,
              safety: {
                blocked: true,
                reason: authResult.reason ?? "unauthorized"
              }
            });
            return;
          }
        }
      }

      if (method === "GET" && pathname === "/api/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "nexus-api",
          time: new Date().toISOString()
        });
        await recordApiMetric("api.health", requestStartedAt);
        return;
      }

      if (method === "GET" && pathname === "/api/routes") {
        sendJson(response, 200, {
          status: "ok",
          routes: compatibilityRoutes
        });
        await recordApiMetric("api.routes", requestStartedAt);
        return;
      }

      if (method === "GET" && pathname === "/api/metrics") {
        const report = await getObservabilityReport({
          filePath: observabilityFilePath
        });
        const totalRequests = report.totals?.runs ?? 0;
        const blocked = report.totals?.blockedRuns ?? 0;
        const errorRate = report.totals?.degradedRate ?? 0;
        const averageDurationMs = report.totals?.averageDurationMs ?? 0;

        sendJson(response, 200, {
          totalRequests,
          p95: averageDurationMs,
          errorRate,
          blocked,
          latency: {
            p95: averageDurationMs
          },
          requests: {
            total: totalRequests
          },
          errors: {
            rate: errorRate
          },
          guard: {
            blocked
          },
          recall: report.recall ?? {},
          selection: report.selection ?? {},
          totals: report.totals ?? {}
        });
        await recordApiMetric("api.metrics", requestStartedAt);
        return;
      }

      if (method === "GET" && pathname === "/api/openapi.json") {
        sendJson(response, 200, {
          ...openApiSpec,
          servers: [
            {
              url: `http://${request.headers.host ?? `${host}:${port}`}`
            }
          ]
        });
        await recordApiMetric("api.openapi", requestStartedAt);
        return;
      }

      if (method === "GET" && pathname === "/api/demo") {
        sendHtml(response, 200, demoPage);
        await recordApiMetric("api.demo", requestStartedAt);
        return;
      }

      if (method === "GET" && pathname === "/api/guard/policies") {
        sendJson(response, 200, {
          status: "ok",
          profiles: listDomainGuardPolicyProfiles()
        });
        await recordApiMetric("api.guard.policies", requestStartedAt);
        return;
      }

      const authResult = auth.authorize({
        headers: request.headers
      });

      if (!authResult.authorized) {
        sendErrorJson(response, authResult.statusCode ?? 401, {
          requestId,
          code: "auth_unauthorized",
          message: authResult.error ?? "Unauthorized request.",
          details: {
            reason: authResult.reason ?? "unauthorized"
          }
        });
        await recordApiMetric("api.auth.blocked", requestStartedAt, {
          command: "api.auth.blocked",
          durationMs: 0,
          degraded: true,
          safety: {
            blocked: true,
            reason: authResult.reason ?? "unauthorized"
          }
        });
        return;
      }

      if (method === "POST" && pathname === "/api/remember") {
        const body = /** @type {{ title?: string, source?: string, content?: string, text?: string, type?: string, kind?: string, project?: string }} */ (
          await readJsonBody(request)
        );
        const title = String(body.title ?? body.source ?? "document").trim() || "document";
        const content = String(body.content ?? body.text ?? "").trim();
        const kind = String(body.type ?? body.kind ?? "doc").trim() || "doc";
        const project = String(body.project ?? "").trim();

        if (!content) {
          sendErrorJson(response, 400, {
            requestId,
            code: "missing_content",
            message: "Missing 'content' in request body."
          });
          await recordApiMetric("api.remember", requestStartedAt, {
            command: "api.remember",
            durationMs: 0,
            degraded: true,
            safety: {
              blocked: true,
              reason: "missing-content"
            }
          });
          return;
        }

        const ingestState = await defaultExecutors.ingest({
          input: {
            documents: [
              {
                source: title,
                content,
                kind
              }
            ],
            projectId: project || "default",
            query: "",
            limit: 1
          }
        });
        const processState = await defaultExecutors.process({
          input: ingestState
        });
        const storeState = await defaultExecutors.store({
          input: processState
        });
        const chunks = asArray(asRecord(processState).chunks);
        const firstChunk = asRecord(chunks[0]);
        const storedProject = String(asRecord(storeState).projectId ?? project).trim() || "default";

        sendJson(response, 200, {
          status: "ok",
          id: String(firstChunk.id ?? requestId),
          title,
          kind,
          project: storedProject,
          stored: Number(asRecord(storeState).storedCount ?? 0),
          chunks: chunks.length,
          tokens: estimateTokenCount(content),
          repositoryFilePath: String(asRecord(storeState).repositoryFilePath ?? "")
        });
        await recordApiMetric("api.remember", requestStartedAt);
        return;
      }

      if (method === "POST" && pathname === "/api/recall") {
        const body = /** @type {{ query?: string, limit?: number, project?: string }} */ (await readJsonBody(request));
        const query = String(body.query ?? "").trim();
        const project = String(body.project ?? "").trim();
        const limit =
          typeof body.limit === "number" && Number.isFinite(body.limit)
            ? Math.max(1, Math.trunc(body.limit))
            : 8;

        if (!query) {
          sendErrorJson(response, 400, {
            requestId,
            code: "missing_query",
            message: "Missing 'query' in request body."
          });
          await recordApiMetric("api.recall", requestStartedAt, {
            command: "api.recall",
            durationMs: 0,
            degraded: true,
            recall: {
              attempted: true,
              status: "failed",
              recoveredChunks: 0,
              selectedChunks: 0,
              suppressedChunks: 0,
              hit: false
            },
            safety: {
              blocked: true,
              reason: "missing-query"
            }
          });
          return;
        }

        const recallState = await defaultExecutors.recall({
          input: {
            projectId: project || "default",
            query,
            limit
          }
        });
        const recallResults = asArray(asRecord(recallState).results);
        const chunks = recallResults.map((entry, index) => normalizeLegacyChunk(entry, index));
        const tokenTotal = chunks.reduce((sum, chunk) => sum + estimateTokenCount(chunk.content), 0);
        const recalledProject = String(asRecord(recallState).projectId ?? project).trim() || "default";

        sendJson(response, 200, {
          status: "ok",
          query,
          project: recalledProject,
          chunks,
          total: chunks.length,
          stats: {
            chunks: chunks.length,
            tokens: tokenTotal,
            hit: chunks.length > 0
          }
        });
        await recordApiMetric("api.recall", requestStartedAt, {
          command: "api.recall",
          durationMs: 0,
          recall: {
            attempted: true,
            status: chunks.length ? "recalled" : "empty",
            recoveredChunks: chunks.length,
            selectedChunks: chunks.length,
            suppressedChunks: 0,
            hit: chunks.length > 0
          },
          selection: {
            selectedCount: chunks.length,
            suppressedCount: 0
          }
        });
        return;
      }

      if (method === "POST" && pathname === "/api/chat") {
        const payload = normalizePromptRequest(
          asRecord(await readJsonBody(request)),
          "chat"
        );

        if (!payload.ok) {
          sendErrorJson(response, 400, {
            requestId,
            code: payload.errorCode,
            message: payload.errorMessage
          });
          await recordApiMetric("api.chat", requestStartedAt, {
            command: "api.chat",
            durationMs: 0,
            degraded: true,
            safety: {
              blocked: true,
              reason: payload.errorCode
            }
          });
          return;
        }

        const promptRequest = payload.value;
        const includeContext = promptRequest.withContext;
        const explicitChunks = includeContext ? promptRequest.chunks : [];
        const ragContext = await resolveRagAugmentedChunks(
          /** @type {Record<string, unknown>} */ (promptRequest),
          "chat",
          explicitChunks,
          defaultExecutors.recall,
          registry
        );
        const sourceChunks = ragContext.chunks;
        const contextSelection = selectEndpointContext({
          endpoint: "chat",
          query: `${promptRequest.query} ${promptRequest.task ?? ""} ${promptRequest.objective ?? ""}`.trim(),
          chunks: sourceChunks,
          language: promptRequest.language,
          framework: promptRequest.framework,
          domain: promptRequest.domain,
          sddProfile: promptRequest.sddProfile,
          profileOverrides: {
            tokenBudget:
              typeof promptRequest.tokenBudget === "number"
                ? promptRequest.tokenBudget
                : options.llm?.tokenBudget,
            maxChunks:
              typeof promptRequest.maxChunks === "number"
                ? promptRequest.maxChunks
                : options.llm?.maxChunks,
            sourceBudgets:
              promptRequest.sourceBudgets &&
              typeof promptRequest.sourceBudgets === "object" &&
              !Array.isArray(promptRequest.sourceBudgets)
                ? promptRequest.sourceBudgets
                : undefined
          }
        });
        const promptChunks = contextSelection.selectedChunks.map((entry, index) => {
          const normalized = normalizeLegacyChunk(entry, index);
          return {
            id: normalized.id,
            source: normalized.source,
            kind: normalized.kind,
            content: normalized.content,
            priority: normalized.priority
          };
        });

        const builtPrompt = buildLlmPrompt({
          question: promptRequest.query,
          task: promptRequest.task,
          objective: promptRequest.objective,
          language: promptRequest.language,
          chunks: promptChunks,
          tokenBudget: contextSelection.profile.tokenBudget,
          maxChunks: contextSelection.profile.maxChunks
        });
        const contextImpact = buildContextImpact({
          rawChunks: contextSelection.rawChunks,
          rawTokens: contextSelection.rawTokens,
          selectedChunks: builtPrompt.context.includedChunks.length,
          selectedTokens: contextSelection.usedTokens,
          suppressedChunks: builtPrompt.context.suppressedChunks.length
        });

        try {
          const generation = await registry.generateWithFallback(builtPrompt.prompt, {
            provider: promptRequest.provider,
            fallbackProviders: promptRequest.fallbackProviders,
            attemptTimeoutMs: Number(
              promptRequest.attemptTimeoutMs ?? options.llm?.attemptTimeoutMs ?? 0
            ),
            options: {
              model: promptRequest.model
            }
          });
          const generated = generation.generated;
          const parsed = parseLlmResponse(generated.content);
          const compliance = checkOutputCompliance(generated.content, /** @type {any} */ (promptRequest.compliance));
          const guardPolicy = resolveDomainGuardPolicy(
            promptRequest.guardPolicyProfile,
            promptRequest.guard
          );
          const guard = enforceOutputGuard(generated.content, /** @type {any} */ (guardPolicy));
          const isBlocked = !(guard.allowed && compliance.compliant);

          await outputAuditor.record({
            action: guard.action,
            reasons: [...guard.reasons, ...compliance.violations],
            outputLength: guard.output.length,
            source: "api:chat",
            metadata: {
              provider: generation.provider,
              fallbackAttempts: generation.attempts,
              compliant: compliance.compliant
            }
          });

          sendJson(response, isBlocked ? 422 : 200, {
            status: isBlocked ? "blocked" : "ok",
            response: guard.output,
            provider: generation.provider,
            model: generated.model,
            usage: generated.usage ?? {},
            blocked: isBlocked,
            promptStats: builtPrompt.context.stats,
            prompt: {
              language: builtPrompt.language,
              stats: builtPrompt.context.stats,
              includedChunks: builtPrompt.context.includedChunks.length,
              suppressedChunks: builtPrompt.context.suppressedChunks.length
            },
            context: {
              mode: contextSelection.mode,
              profile: contextSelection.profile.endpoint,
              rag: ragContext.rag,
              sdd: contextSelection.sdd,
              rawChunks: contextSelection.rawChunks,
              rawTokens: contextSelection.rawTokens,
              selectedChunks: builtPrompt.context.includedChunks.length,
              selectedTokens: builtPrompt.context.stats.usedTokens,
              suppressedChunks: builtPrompt.context.suppressedChunks.length
            },
            impact: contextImpact,
            fallback: {
              attempts: generation.attempts,
              summary: generation.summary
            },
            parsed,
            guard,
            compliance
          });
          await recordApiMetric("api.chat", requestStartedAt, {
            command: "api.chat",
            durationMs: 0,
            degraded: generation.summary.failedAttempts > 0,
            selection: {
              selectedCount: builtPrompt.context.includedChunks.length,
              suppressedCount: builtPrompt.context.suppressedChunks.length
            },
            recall: ragContext.recallMetric,
            sdd: buildSddMetricSummary(contextSelection.sdd),
            teaching: buildTeachingMetricSummary(parsed),
            safety: {
              blocked: isBlocked,
              reason: guard.reasons[0] ?? compliance.violations[0] ?? ""
            }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const preview = promptChunks
            .slice(0, 2)
            .map((chunk, index) => {
              const source = String(chunk.source ?? `chunk-${index + 1}`);
              const excerpt = String(chunk.content ?? "").trim().slice(0, 220);
              return `${index + 1}) [${source}] ${excerpt}`;
            });
          const fallbackResponse = [
            "⚠ NEXUS está en modo degradado (sin proveedor LLM disponible).",
            "",
            promptChunks.length
              ? "Resumen de contexto recuperado:"
              : "No hay chunks recuperados para esta consulta.",
            ...preview
          ]
            .filter(Boolean)
            .join("\n");

          sendJson(response, 200, {
            status: "degraded",
            degraded: true,
            response: fallbackResponse,
            provider: "offline-fallback",
            model: "none",
            usage: {
              inputTokens: builtPrompt.context.stats.usedTokens,
              outputTokens: estimateTokenCount(fallbackResponse)
            },
            blocked: false,
            promptStats: builtPrompt.context.stats,
            context: {
              mode: contextSelection.mode,
              profile: contextSelection.profile.endpoint,
              rag: ragContext.rag,
              sdd: contextSelection.sdd,
              rawChunks: contextSelection.rawChunks,
              rawTokens: contextSelection.rawTokens,
              selectedChunks: builtPrompt.context.includedChunks.length,
              selectedTokens: builtPrompt.context.stats.usedTokens,
              suppressedChunks: builtPrompt.context.suppressedChunks.length
            },
            impact: contextImpact,
            fallback: {
              attempts: 0,
              summary: {
                attemptedProviders: 0,
                failedAttempts: 0,
                succeededAfterRetries: false
              }
            },
            error: message
          });
          await recordApiMetric("api.chat", requestStartedAt, {
            command: "api.chat",
            durationMs: 0,
            degraded: true,
            selection: {
              selectedCount: builtPrompt.context.includedChunks.length,
              suppressedCount: builtPrompt.context.suppressedChunks.length
            },
            recall: ragContext.recallMetric,
            sdd: buildSddMetricSummary(contextSelection.sdd),
            teaching: buildTeachingMetricSummary(undefined),
            safety: {
              blocked: false,
              reason: "llm-provider-unavailable"
            }
          });
        }
        return;
      }

      if (method === "POST" && pathname === "/api/guard") {
        const guardStartedAt = Date.now();
        const body = /** @type {{ query?: string, output?: string, guardPolicyProfile?: string, guard?: object, compliance?: object }} */ (
          await readJsonBody(request)
        );
        const output = String(body.query ?? body.output ?? "");
        const compliance = checkOutputCompliance(output, /** @type {any} */ (body.compliance ?? {}));
        const guardPolicy = resolveDomainGuardPolicy(
          body.guardPolicyProfile,
          /** @type {Record<string, unknown>} */ (body.guard ?? {})
        );
        const guard = enforceOutputGuard(output, /** @type {any} */ (guardPolicy));
        const blocked = !(guard.allowed && compliance.compliant);
        const reason = guard.reasons[0] ?? compliance.violations[0] ?? "";

        sendJson(response, blocked ? 403 : 200, {
          status: blocked ? "blocked" : "ok",
          blocked,
          warned: !blocked && (guard.reasons.length > 0 || compliance.violations.length > 0),
          blockedBy: reason,
          userMessage: blocked ? reason || "Request blocked by guard policy." : "Allowed by guard policy.",
          results: [
            ...guard.reasons.map((entry) => ({
              type: "guard",
              message: entry
            })),
            ...compliance.violations.map((entry) => ({
              type: "compliance",
              message: entry
            }))
          ],
          durationMs: Math.max(0, Date.now() - guardStartedAt),
          guard,
          compliance
        });
        await recordApiMetric("api.guard", requestStartedAt, {
          command: "api.guard",
          durationMs: 0,
          safety: {
            blocked,
            reason
          }
        });
        return;
      }

      if (method === "GET" && pathname === "/api/sync/status") {
        sendJson(response, 200, {
          status: "ok",
          scheduler: scheduler.getStatus(),
          lastSync: lastSyncResult
        });
        await recordApiMetric("api.sync.status", requestStartedAt);
        return;
      }

      if (method === "GET" && pathname === "/api/sync/drift") {
        const report = await driftMonitor.getReport({
          warningRatio: Number(requestUrl.searchParams.get("warningRatio") ?? 0),
          criticalRatio: Number(requestUrl.searchParams.get("criticalRatio") ?? 0),
          spikeMultiplier: Number(requestUrl.searchParams.get("spikeMultiplier") ?? 0),
          baselineWindow: Number(requestUrl.searchParams.get("baselineWindow") ?? 0)
        });
        sendJson(response, 200, {
          status: "ok",
          drift: report
        });
        await recordApiMetric("api.sync.drift", requestStartedAt);
        return;
      }

      if (method === "POST" && pathname === "/api/sync") {
        await scheduler.runNow();
        sendJson(response, 200, {
          status: "ok",
          scheduler: scheduler.getStatus(),
          lastSync: lastSyncResult
        });
        await recordApiMetric("api.sync.run", requestStartedAt);
        return;
      }

      if (method === "GET" && pathname === "/api/observability/dashboard") {
        const topCommands = Math.max(
          1,
          Math.trunc(Number(requestUrl.searchParams.get("topCommands") ?? 8))
        );
        const report = await getObservabilityReport({
          filePath: observabilityFilePath
        });
        const dashboard = await buildDashboardData({
          metrics: report,
          topCommands
        });

        sendJson(response, 200, {
          status: "ok",
          dashboard
        });
        await recordApiMetric("api.observability.dashboard", requestStartedAt);
        return;
      }

      if (method === "GET" && pathname === "/api/observability/alerts") {
        const thresholds = {
          blockedRateMax: Number(requestUrl.searchParams.get("blockedRateMax") ?? 0.25),
          degradedRateMax: Number(requestUrl.searchParams.get("degradedRateMax") ?? 0.35),
          recallHitRateMin: Number(requestUrl.searchParams.get("recallHitRateMin") ?? 0.15),
          averageDurationMsMax: Number(requestUrl.searchParams.get("averageDurationMsMax") ?? 1500),
          minRuns: Number(requestUrl.searchParams.get("minRuns") ?? 20)
        };
        const report = await getObservabilityReport({
          filePath: observabilityFilePath
        });
        const alerts = evaluateObservabilityAlerts(report.totals ? report : {}, thresholds);

        sendJson(response, 200, {
          status: "ok",
          alerts
        });
        await recordApiMetric("api.observability.alerts", requestStartedAt);
        return;
      }

      if (method === "POST" && pathname === "/api/evals/domain-suite") {
        const body = /** @type {{ suitePath?: string, suite?: Record<string, unknown> }} */ (
          await readJsonBody(request)
        );
        const hasInlineSuite = Boolean(body.suite && typeof body.suite === "object");
        let suitePath = defaultDomainSuitePath;

        if (!hasInlineSuite && typeof body.suitePath === "string" && body.suitePath.trim()) {
          try {
            suitePath = resolveSafePathWithinWorkspace(apiWorkspaceRoot, body.suitePath, "suitePath");
          } catch {
            sendErrorJson(response, 400, {
              requestId,
              code: "invalid_suite_path",
              message: "Invalid 'suitePath'. Path must stay inside workspace root."
            });
            await recordApiMetric("api.evals.domain-suite", requestStartedAt, {
              command: "api.evals.domain-suite",
              durationMs: 0,
              degraded: true,
              safety: {
                blocked: true,
                reason: "invalid-suite-path"
              }
            });
            return;
          }
        }

        /** @type {Record<string, unknown>} */
        let sourceSuite = {};
        if (hasInlineSuite) {
          sourceSuite = /** @type {Record<string, unknown>} */ (body.suite);
        } else {
          try {
            const loaded = await loadDomainEvalSuite(suitePath);
            sourceSuite =
              loaded && typeof loaded === "object"
                ? /** @type {Record<string, unknown>} */ (loaded)
                : {};
          } catch {
            sendErrorJson(response, 400, {
              requestId,
              code: "suite_load_failed",
              message: "Unable to load eval suite. Verify path and file format."
            });
            await recordApiMetric("api.evals.domain-suite", requestStartedAt, {
              command: "api.evals.domain-suite",
              durationMs: 0,
              degraded: true,
              safety: {
                blocked: true,
                reason: "suite-load-failed"
              }
            });
            return;
          }
        }
        const suiteRecord =
          sourceSuite && typeof sourceSuite === "object"
            ? /** @type {Record<string, unknown>} */ (sourceSuite)
            : {};

        const report = runDomainEvalSuite({
          suite: String(suiteRecord.suite ?? "nexus-domain-suite"),
          thresholds:
            suiteRecord.thresholds && typeof suiteRecord.thresholds === "object"
              ? /** @type {Record<string, unknown>} */ (suiteRecord.thresholds)
              : {},
          qualityPolicy:
            suiteRecord.qualityPolicy && typeof suiteRecord.qualityPolicy === "object"
              ? /** @type {Record<string, unknown>} */ (suiteRecord.qualityPolicy)
              : {},
          cases: Array.isArray(suiteRecord.cases) ? suiteRecord.cases : []
        });

        sendJson(response, 200, {
          status: report.status,
          suiteSource: hasInlineSuite ? "inline" : "path",
          report
        });
        await recordApiMetric("api.evals.domain-suite", requestStartedAt, {
          command: "api.evals.domain-suite",
          durationMs: 0,
          degraded: report.status !== "pass",
          safety: {
            blocked: report.status !== "pass",
            reason: report.status !== "pass" ? "domain-evals-blocked" : ""
          }
        });
        return;
      }

      if (method === "GET" && pathname === "/api/versioning/prompts") {
        const promptKey = String(requestUrl.searchParams.get("promptKey") ?? "").trim();

        if (!promptKey) {
          sendErrorJson(response, 400, {
            requestId,
            code: "missing_prompt_key",
            message: "Missing 'promptKey' query parameter."
          });
          await recordApiMetric("api.versioning.list", requestStartedAt, {
            command: "api.versioning.list",
            durationMs: 0,
            degraded: true,
            safety: {
              blocked: true,
              reason: "missing-prompt-key"
            }
          });
          return;
        }

        const versions = await promptVersionStore.listVersions(promptKey);
        sendJson(response, 200, {
          status: "ok",
          promptKey,
          versions
        });
        await recordApiMetric("api.versioning.list", requestStartedAt);
        return;
      }

      if (method === "POST" && pathname === "/api/versioning/prompts") {
        const body = /** @type {{ promptKey?: string, content?: string, metadata?: Record<string, unknown> }} */ (
          await readJsonBody(request)
        );
        const promptKey = String(body.promptKey ?? "").trim();
        const content = String(body.content ?? "").trim();

        if (!promptKey || !content) {
          sendErrorJson(response, 400, {
            requestId,
            code: "missing_prompt_version_input",
            message: "Missing 'promptKey' or 'content' in request body."
          });
          await recordApiMetric("api.versioning.save", requestStartedAt, {
            command: "api.versioning.save",
            durationMs: 0,
            degraded: true,
            safety: {
              blocked: true,
              reason: "missing-prompt-version-input"
            }
          });
          return;
        }

        const version = await promptVersionStore.saveVersion({
          promptKey,
          content,
          metadata: body.metadata ?? {}
        });

        sendJson(response, 200, {
          status: "ok",
          version
        });
        await recordApiMetric("api.versioning.save", requestStartedAt);
        return;
      }

      if (method === "GET" && pathname === "/api/versioning/compare") {
        const leftId = String(requestUrl.searchParams.get("leftId") ?? "").trim();
        const rightId = String(requestUrl.searchParams.get("rightId") ?? "").trim();

        if (!leftId || !rightId) {
          sendErrorJson(response, 400, {
            requestId,
            code: "missing_version_diff_input",
            message: "Missing 'leftId' or 'rightId' query parameters."
          });
          await recordApiMetric("api.versioning.compare", requestStartedAt, {
            command: "api.versioning.compare",
            durationMs: 0,
            degraded: true,
            safety: {
              blocked: true,
              reason: "missing-version-diff-input"
            }
          });
          return;
        }

        const diff = await promptVersionStore.diffVersions(leftId, rightId);
        sendJson(response, 200, {
          status: "ok",
          diff
        });
        await recordApiMetric("api.versioning.compare", requestStartedAt);
        return;
      }

      if (method === "POST" && pathname === "/api/versioning/rollback-plan") {
        const body = /** @type {{ promptKey?: string, evalScoresByVersion?: Record<string, number>, minScore?: number, preferPrevious?: boolean }} */ (
          await readJsonBody(request)
        );
        const promptKey = String(body.promptKey ?? "").trim();

        if (!promptKey) {
          sendErrorJson(response, 400, {
            requestId,
            code: "missing_prompt_key",
            message: "Missing 'promptKey' in request body."
          });
          await recordApiMetric("api.versioning.rollback-plan", requestStartedAt, {
            command: "api.versioning.rollback-plan",
            durationMs: 0,
            degraded: true,
            safety: {
              blocked: true,
              reason: "missing-prompt-key"
            }
          });
          return;
        }

        const plan = await rollbackPolicy.buildPlan(promptVersionStore, {
          promptKey,
          evalScoresByVersion:
            body.evalScoresByVersion && typeof body.evalScoresByVersion === "object"
              ? body.evalScoresByVersion
              : {},
          minScore: body.minScore,
          preferPrevious: body.preferPrevious
        });
        sendJson(response, 200, {
          status: "ok",
          rollback: plan
        });
        await recordApiMetric("api.versioning.rollback-plan", requestStartedAt);
        return;
      }

      if (method === "POST" && pathname === "/api/guard/output") {
        const body = /** @type {{ output?: string, guard?: object, compliance?: object, guardPolicyProfile?: string }} */ (
          await readJsonBody(request)
        );
        const output = String(body.output ?? "");
        const compliance = checkOutputCompliance(output, /** @type {any} */ (body.compliance ?? {}));
        const guardPolicy = resolveDomainGuardPolicy(
          body.guardPolicyProfile,
          /** @type {Record<string, unknown>} */ (body.guard ?? {})
        );
        const guard = enforceOutputGuard(output, /** @type {any} */ (guardPolicy));

        await outputAuditor.record({
          action: guard.action,
          reasons: [...guard.reasons, ...compliance.violations],
          outputLength: guard.output.length,
          source: "api:guard/output",
          metadata: {
            compliant: compliance.compliant
          }
        });

        sendJson(response, guard.allowed && compliance.compliant ? 200 : 422, {
          status: guard.allowed && compliance.compliant ? "ok" : "blocked",
          guard,
          compliance
        });
        await recordApiMetric("api.guard.output", requestStartedAt, {
          command: "api.guard.output",
          durationMs: 0,
          safety: {
            blocked: !(guard.allowed && compliance.compliant),
            reason: guard.reasons[0] ?? compliance.violations[0] ?? ""
          }
        });
        return;
      }

      if (method === "POST" && pathname === "/api/pipeline/run") {
        const body = /** @type {{ input?: unknown, pipeline?: import("../orchestration/pipeline-builder.js").WorkflowPipeline }} */ (
          await readJsonBody(request)
        );
        const pipeline = body.pipeline ?? buildDefaultNexusPipeline();
        /** @type {Record<string, unknown>} */
        let pipelineInput;

        try {
          pipelineInput = normalizePipelineInput(body.input ?? {}, apiWorkspaceRoot);
        } catch (error) {
          sendErrorJson(response, 400, {
            requestId,
            code: "invalid_pipeline_source_path",
            message: error instanceof Error ? error.message : String(error)
          });
          await recordApiMetric("api.pipeline.run", requestStartedAt, {
            command: "api.pipeline.run",
            durationMs: 0,
            degraded: true,
            safety: {
              blocked: true,
              reason: "invalid-pipeline-source-path"
            }
          });
          return;
        }

        const result = await pipelineBuilder.runPipeline(pipeline, pipelineInput);

        sendJson(response, 200, {
          status: "ok",
          pipeline: result
        });
        await recordApiMetric("api.pipeline.run", requestStartedAt);
        return;
      }

      if (method === "POST" && pathname === "/api/ask") {
        const payload = normalizePromptRequest(
          asRecord(await readJsonBody(request)),
          "ask"
        );

        if (!payload.ok) {
          sendErrorJson(response, 400, {
            requestId,
            code: payload.errorCode,
            message: payload.errorMessage
          });
          await recordApiMetric("api.ask", requestStartedAt, {
            command: "api.ask",
            durationMs: 0,
            degraded: true,
            safety: {
              blocked: true,
              reason: payload.errorCode
            }
          });
          return;
        }

        const promptRequest = payload.value;
        const explicitChunks = promptRequest.withContext ? promptRequest.chunks : [];
        const ragContext = await resolveRagAugmentedChunks(
          /** @type {Record<string, unknown>} */ (promptRequest),
          "ask",
          explicitChunks,
          defaultExecutors.recall,
          registry
        );
        const contextSelection = selectEndpointContext({
          endpoint: "ask",
          query: `${promptRequest.query} ${promptRequest.task ?? ""} ${promptRequest.objective ?? ""}`.trim(),
          chunks: ragContext.chunks,
          language: promptRequest.language,
          framework: promptRequest.framework,
          domain: promptRequest.domain,
          sddProfile: promptRequest.sddProfile,
          profileOverrides: {
            tokenBudget:
              typeof promptRequest.tokenBudget === "number"
                ? promptRequest.tokenBudget
                : options.llm?.tokenBudget,
            maxChunks:
              typeof promptRequest.maxChunks === "number"
                ? promptRequest.maxChunks
                : options.llm?.maxChunks,
            sourceBudgets:
              promptRequest.sourceBudgets &&
              typeof promptRequest.sourceBudgets === "object" &&
              !Array.isArray(promptRequest.sourceBudgets)
                ? promptRequest.sourceBudgets
                : undefined
          }
        });

        const builtPrompt = buildLlmPrompt({
          question: promptRequest.query,
          task: promptRequest.task,
          objective: promptRequest.objective,
          language: promptRequest.language,
          chunks: contextSelection.selectedChunks,
          tokenBudget: contextSelection.profile.tokenBudget,
          maxChunks: contextSelection.profile.maxChunks
        });
        const contextImpact = buildContextImpact({
          rawChunks: contextSelection.rawChunks,
          rawTokens: contextSelection.rawTokens,
          selectedChunks: builtPrompt.context.includedChunks.length,
          selectedTokens: contextSelection.usedTokens,
          suppressedChunks: builtPrompt.context.suppressedChunks.length
        });

        try {
          const generation = await registry.generateWithFallback(builtPrompt.prompt, {
            provider: promptRequest.provider,
            fallbackProviders: promptRequest.fallbackProviders,
            attemptTimeoutMs: Number(
              promptRequest.attemptTimeoutMs ?? options.llm?.attemptTimeoutMs ?? 0
            ),
            options: {
              model: promptRequest.model
            }
          });
          const generated = generation.generated;
          const parsed = parseLlmResponse(generated.content);
          const compliance = checkOutputCompliance(generated.content, /** @type {any} */ (promptRequest.compliance));
          const guardPolicy = resolveDomainGuardPolicy(
            promptRequest.guardPolicyProfile,
            promptRequest.guard
          );
          const guard = enforceOutputGuard(generated.content, /** @type {any} */ (guardPolicy));

          await outputAuditor.record({
            action: guard.action,
            reasons: [...guard.reasons, ...compliance.violations],
            outputLength: guard.output.length,
            source: "api:ask",
            metadata: {
              provider: generation.provider,
              fallbackAttempts: generation.attempts,
              compliant: compliance.compliant
            }
          });

          sendJson(response, guard.allowed && compliance.compliant ? 200 : 422, {
            status: guard.allowed && compliance.compliant ? "ok" : "blocked",
            provider: generation.provider,
            fallback: {
              attempts: generation.attempts,
              summary: generation.summary
            },
            prompt: {
              language: builtPrompt.language,
              stats: builtPrompt.context.stats,
              includedChunks: builtPrompt.context.includedChunks.length,
              suppressedChunks: builtPrompt.context.suppressedChunks.length
            },
            context: {
              mode: contextSelection.mode,
              profile: contextSelection.profile.endpoint,
              rag: ragContext.rag,
              sdd: contextSelection.sdd,
              rawChunks: contextSelection.rawChunks,
              rawTokens: contextSelection.rawTokens,
              selectedChunks: builtPrompt.context.includedChunks.length,
              selectedTokens: builtPrompt.context.stats.usedTokens,
              suppressedChunks: builtPrompt.context.suppressedChunks.length
            },
            impact: contextImpact,
            generation: {
              content: guard.output,
              finishReason: generated.finishReason,
              usage: generated.usage,
              model: generated.model
            },
            parsed,
            guard,
            compliance
          });
          await recordApiMetric("api.ask", requestStartedAt, {
            command: "api.ask",
            durationMs: 0,
            degraded: generation.summary.failedAttempts > 0,
            selection: {
              selectedCount: builtPrompt.context.includedChunks.length,
              suppressedCount: builtPrompt.context.suppressedChunks.length
            },
            recall: ragContext.recallMetric,
            sdd: buildSddMetricSummary(contextSelection.sdd),
            teaching: buildTeachingMetricSummary(parsed),
            safety: {
              blocked: !(guard.allowed && compliance.compliant),
              reason: guard.reasons[0] ?? compliance.violations[0] ?? ""
            }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const preview = builtPrompt.context.includedChunks
            .slice(0, 2)
            .map((chunk, index) => {
              const source = String(chunk.source ?? `chunk-${index + 1}`);
              const excerpt = String(chunk.content ?? "").trim().slice(0, 220);
              return `${index + 1}) [${source}] ${excerpt}`;
            });
          const fallbackResponse = [
            "⚠ NEXUS está en modo degradado (sin proveedor LLM disponible).",
            "",
            builtPrompt.context.includedChunks.length
              ? "Resumen de contexto recuperado:"
              : "No hay chunks seleccionados para esta consulta.",
            ...preview
          ]
            .filter(Boolean)
            .join("\n");

          sendJson(response, 200, {
            status: "degraded",
            degraded: true,
            provider: "offline-fallback",
            prompt: {
              language: builtPrompt.language,
              stats: builtPrompt.context.stats,
              includedChunks: builtPrompt.context.includedChunks.length,
              suppressedChunks: builtPrompt.context.suppressedChunks.length
            },
            context: {
              mode: contextSelection.mode,
              profile: contextSelection.profile.endpoint,
              rag: ragContext.rag,
              sdd: contextSelection.sdd,
              rawChunks: contextSelection.rawChunks,
              rawTokens: contextSelection.rawTokens,
              selectedChunks: builtPrompt.context.includedChunks.length,
              selectedTokens: builtPrompt.context.stats.usedTokens,
              suppressedChunks: builtPrompt.context.suppressedChunks.length
            },
            impact: contextImpact,
            generation: {
              content: fallbackResponse,
              finishReason: "degraded",
              usage: {
                inputTokens: builtPrompt.context.stats.usedTokens,
                outputTokens: estimateTokenCount(fallbackResponse)
              },
              model: "none"
            },
            fallback: {
              attempts: 0,
              summary: {
                attemptedProviders: 0,
                failedAttempts: 0,
                succeededAfterRetries: false
              }
            },
            error: message
          });
          await recordApiMetric("api.ask", requestStartedAt, {
            command: "api.ask",
            durationMs: 0,
            degraded: true,
            selection: {
              selectedCount: builtPrompt.context.includedChunks.length,
              suppressedCount: builtPrompt.context.suppressedChunks.length
            },
            recall: ragContext.recallMetric,
            sdd: buildSddMetricSummary(contextSelection.sdd),
            teaching: buildTeachingMetricSummary(undefined),
            safety: {
              blocked: false,
              reason: "llm-provider-unavailable"
            }
          });
        }
        return;
      }

      sendErrorJson(response, 404, {
        requestId,
        code: "route_not_found",
        message: `Route ${method} ${pathname} not found.`
      });
      await recordApiMetric("api.route.404", requestStartedAt, {
        command: "api.route.404",
        durationMs: 0,
        degraded: true,
        safety: {
          blocked: true,
          reason: "route-not-found"
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const invalidJson = /Invalid JSON request body\./i.test(message);
      const requestTooLarge = /Request body too large/i.test(message);
      const statusCode = requestTooLarge ? 413 : invalidJson ? 400 : 500;
      const clientMessage =
        requestTooLarge || invalidJson ? message : "Internal server error.";

      if (!requestTooLarge && !invalidJson) {
        console.error(`[nexus-api] request ${requestId} failed: ${message}`);
      }

      sendErrorJson(response, statusCode, {
        requestId,
        code: requestTooLarge ? "request_too_large" : invalidJson ? "invalid_json" : "internal_error",
        message: clientMessage
      });
      await recordApiMetric(
        requestTooLarge ? "api.route.413" : invalidJson ? "api.route.400" : "api.route.500",
        requestStartedAt,
        {
          command: requestTooLarge ? "api.route.413" : invalidJson ? "api.route.400" : "api.route.500",
          durationMs: 0,
          degraded: true,
          safety: {
            blocked: true,
            reason: requestTooLarge ? "request-too-large" : invalidJson ? "invalid-json" : "internal-error"
          }
        }
      );
    }
  });

  return {
    host,
    port,
    server,
    scheduler,
    syncRuntime,
    registry,
    promptVersionStore,
    driftMonitor,
    rollbackPolicy,
    openApiSpec,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(undefined));
      });

      const address = server.address();
      return {
        host,
        port: typeof address === "object" && address ? address.port : port
      };
    },
    async stop() {
      scheduler.stop();
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(undefined);
        });
      });
      return {
        stopped: true
      };
    }
  };
}

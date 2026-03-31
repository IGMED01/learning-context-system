// @ts-check

import { chunkDocument } from "../processing/chunker.js";
import { extractEntities } from "../processing/entity-extractor.js";
import { tagChunkMetadata } from "../processing/metadata-tagger.js";
import { getAdapter, listAdapters } from "../io/source-adapter.js";
import { createChunkRepository } from "../storage/chunk-repository.js";
import { createHybridRetriever } from "../storage/hybrid-retriever.js";
import { evaluateMemoryWrite, buildAcceptedMemoryMetadata } from "../memory/memory-hygiene.js";
import path from "node:path";

// Trigger adapter auto-registration for ingest by path/source.
import "../io/pdf-adapter.js";
import "../io/markdown-adapter.js";

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
function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @param {unknown} value
 */
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * @param {unknown} value
 */
function resolveProjectId(value) {
  return asText(value) || "default";
}

/**
 * @param {{ repositoryFilePath?: string, repositoryBaseDir?: string }} options
 */
function resolveRepositoryBaseDir(options) {
  const explicitBaseDir = asText(options.repositoryBaseDir);

  if (explicitBaseDir) {
    return path.resolve(explicitBaseDir);
  }

  const repositoryFilePath = asText(options.repositoryFilePath);

  if (!repositoryFilePath) {
    return undefined;
  }

  const resolvedRepositoryPath = path.resolve(repositoryFilePath);
  return path.extname(resolvedRepositoryPath)
    ? path.dirname(resolvedRepositoryPath)
    : resolvedRepositoryPath;
}

/**
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} metadata
 */
function shouldEvaluateIngestHygiene(input, metadata) {
  if (input.hygieneGate === false) {
    return false;
  }

  if (metadata.preChunked === true) {
    return true;
  }

  if (typeof metadata.ingestedBy === "string" && metadata.ingestedBy.trim()) {
    return true;
  }

  if (
    typeof input.sourcePath === "string" ||
    typeof input.inputPath === "string" ||
    typeof input.path === "string"
  ) {
    return true;
  }

  return Boolean(input.ingest && typeof input.ingest === "object");
}

/**
 * @param {string} kind
 */
function mapChunkKindToMemoryType(kind) {
  if (kind === "test") {
    return "test";
  }

  if (kind === "log") {
    return "generated";
  }

  return "learning";
}

/**
 * @param {Record<string, unknown>} entry
 * @param {Record<string, unknown>} metadata
 * @param {string} projectId
 * @param {ReturnType<typeof evaluateMemoryWrite> | null} evaluation
 */
function buildChunkTags(entry, metadata, projectId, evaluation) {
  const tags = {
    ...asRecord(metadata.tags),
    ...asRecord(entry.tags),
    projectId
  };

  if (!evaluation) {
    return tags;
  }

  return {
    ...tags,
    memoryStatus: evaluation.action === "quarantine" ? "quarantined" : "accepted",
    reviewStatus: evaluation.reviewStatus,
    reviewReasons: [...evaluation.reasons],
    signalScore: evaluation.signalScore,
    duplicateScore: evaluation.duplicateScore,
    durabilityScore: evaluation.durabilityScore,
    healthScore: evaluation.healthScore,
    ...buildAcceptedMemoryMetadata(evaluation, {
      sourceKind: "pipeline-ingest"
    })
  };
}

/**
 * @param {Record<string, unknown>} entry
 * @param {Record<string, unknown>} metadata
 * @param {string} projectId
 * @param {ReturnType<typeof evaluateMemoryWrite> | null} evaluation
 */
function normalizeChunkForRepository(entry, metadata, projectId, evaluation) {
  const id = asText(entry.id);
  const content = String(entry.content ?? "").trim();

  if (!id || !content) {
    return null;
  }

  const priority = asNumber(entry.priority ?? entry.score);

  return {
    id,
    source: asText(entry.source) || id,
    kind: asText(entry.kind) || "doc",
    content,
    certainty: asNumber(entry.certainty),
    recency: asNumber(entry.recency),
    teachingValue: asNumber(entry.teachingValue),
    priority,
    tags: buildChunkTags(entry, metadata, projectId, evaluation)
  };
}

/**
 * @param {Record<string, unknown>} payload
 */
function ingestDocuments(payload) {
  const source = Array.isArray(payload.documents)
    ? payload.documents
    : typeof payload.text === "string"
      ? [
          {
            source: String(payload.source ?? "inline"),
            content: payload.text,
            kind: String(payload.kind ?? "doc")
          }
        ]
      : [];

  return source
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => {
      const record = /** @type {Record<string, unknown>} */ (entry);
      return {
        source: typeof record.source === "string" ? record.source : "inline",
        content: typeof record.content === "string" ? record.content : "",
        kind: typeof record.kind === "string" ? record.kind : "doc"
      };
    })
    .filter((entry) => entry.content.trim().length > 0);
}

/**
 * @param {Record<string, unknown>} payload
 * @param {(sourcePath: string) => string} [resolveSourcePath]
 */
async function ingestWithAdapter(payload, resolveSourcePath) {
  const adapterName = asText(payload.adapter ?? payload.sourceAdapter ?? payload.ingestAdapter);
  const sourcePath = asText(payload.path ?? payload.sourcePath ?? payload.inputPath);

  if (!adapterName || !sourcePath) {
    return null;
  }

  const adapter = getAdapter(adapterName);

  if (!adapter) {
    const available = listAdapters();
    throw new Error(
      `Unknown source adapter '${adapterName}'. Available: ${
        available.length ? available.join(", ") : "none"
      }.`
    );
  }

  const projectId = resolveProjectId(payload.project);
  const maxContentChars = Number(payload.maxContentChars ?? 0);
  const safeSourcePath =
    typeof resolveSourcePath === "function" ? resolveSourcePath(sourcePath) : sourcePath;
  const readResult = await adapter.read(safeSourcePath, {
    project: projectId,
    maxContentChars: Number.isFinite(maxContentChars) && maxContentChars > 0
      ? Math.trunc(maxContentChars)
      : undefined
  });

  return {
    adapter: adapter.name,
    sourcePath: safeSourcePath,
    projectId,
    stats: readResult.stats,
    chunks: readResult.chunks.map((chunk, index) => ({
      id: String(chunk.id ?? `ingested-${index + 1}`),
      source: String(chunk.source ?? safeSourcePath),
      kind: String(chunk.kind ?? "doc"),
      content: String(chunk.content ?? ""),
      metadata: {
        ingestedBy: `adapter:${adapter.name}`,
        sourcePath: safeSourcePath
      }
    }))
  };
}

/**
 * NEXUS:5 — register default executors for ingest/process/store/recall pipeline.
 * @param {{
 *   repositoryFilePath?: string,
 *   repositoryBaseDir?: string,
 *   resolveSourcePath?: (sourcePath: string) => string
 * }} [options]
 */
export function createDefaultExecutors(options = {}) {
  const repositoryBaseDir = resolveRepositoryBaseDir(options);
  const repository = createChunkRepository({
    baseDir: repositoryBaseDir,
    filePath: options.repositoryFilePath
  });

  return {
    /**
     * @param {{ input: unknown }} context
     */
    async ingest(context) {
      const payload = asRecord(context.input);
      const projectId = resolveProjectId(payload.project ?? payload.projectId);
      const adapterIngest = await ingestWithAdapter(
        payload,
        typeof options.resolveSourcePath === "function"
          ? options.resolveSourcePath
          : undefined
      );

      if (adapterIngest) {
        return {
          documents: [],
          chunks: adapterIngest.chunks,
          skipChunking: true,
          ingest: {
            adapter: adapterIngest.adapter,
            sourcePath: adapterIngest.sourcePath,
            stats: adapterIngest.stats,
            totalChunks: adapterIngest.chunks.length
          },
          projectId: adapterIngest.projectId,
          query: typeof payload.query === "string" ? payload.query : "",
          limit:
            typeof payload.limit === "number" && Number.isFinite(payload.limit)
              ? Math.max(1, Math.trunc(payload.limit))
              : 5
        };
      }

      const documents = ingestDocuments(payload);

      return {
        documents,
        projectId,
        query: typeof payload.query === "string" ? payload.query : "",
        limit:
          typeof payload.limit === "number" && Number.isFinite(payload.limit)
            ? Math.max(1, Math.trunc(payload.limit))
            : 5
      };
    },

    /**
     * @param {{ input: unknown }} context
     */
    async process(context) {
      const input = asRecord(context.input);
      const projectId = resolveProjectId(input.projectId ?? input.project);
      const skipChunking = input.skipChunking === true;
      const preChunked = Array.isArray(input.chunks) ? input.chunks : [];
      const documents = Array.isArray(input.documents) ? input.documents : [];
      /** @type {Array<{ id: string, source: string, kind: string, content: string, metadata: Record<string, unknown> }>} */
      const chunks = [];

      if (skipChunking && preChunked.length > 0) {
        for (let index = 0; index < preChunked.length; index += 1) {
          const entry = preChunked[index];

          if (!entry || typeof entry !== "object") {
            continue;
          }

          const record = /** @type {Record<string, unknown>} */ (entry);
          const source = String(record.source ?? "inline");
          const content = String(record.content ?? "");

          if (!content.trim()) {
            continue;
          }

          const kind = String(record.kind ?? "doc");
          const metadata = asRecord(record.metadata);
          const metadataTags = tagChunkMetadata({
            source,
            kind,
            content
          });

          chunks.push({
            id: String(record.id ?? `${source}::${index}`),
            source,
            kind,
            content,
            metadata: {
              ...metadata,
              tags: {
                ...metadataTags,
                ...asRecord(metadata.tags)
              },
              entities: extractEntities(content),
              preChunked: true
            }
          });
        }

        return {
          ...input,
          projectId,
          chunks
        };
      }

      for (const document of documents) {
        if (!document || typeof document !== "object") {
          continue;
        }

        const item = /** @type {Record<string, unknown>} */ (document);
        const source = typeof item.source === "string" ? item.source : "inline";
        const content = typeof item.content === "string" ? item.content : "";
        const kind = typeof item.kind === "string" ? item.kind : "doc";

        for (const processed of chunkDocument(content, {
          source,
          maxCharsPerChunk: 1500
        })) {
          const metadataTags = tagChunkMetadata({
            source,
            kind,
            content: processed.content
          });

          chunks.push({
            id: processed.id,
            source,
            kind,
            content: processed.content,
            metadata: {
              ...processed.metadata,
              tags: metadataTags,
              entities: extractEntities(processed.content)
            }
          });
        }
      }

      return {
        ...input,
        projectId,
        chunks
      };
    },

    /**
     * @param {{ input: unknown }} context
     */
    async store(context) {
      const input = asRecord(context.input);
      const projectId = resolveProjectId(input.projectId ?? input.project);
      const chunks = Array.isArray(input.chunks) ? input.chunks : [];
      /** @type {Array<import("../types/core-contracts.d.ts").Chunk>} */
      const acceptedChunks = [];
      /** @type {Array<{ id: string, source: string, kind: string, reasons: string[], reviewStatus: string }>} */
      const quarantinedChunks = [];
      let hygieneEvaluated = 0;

      for (const chunk of chunks) {
        if (!chunk || typeof chunk !== "object") {
          continue;
        }

        const entry = /** @type {Record<string, unknown>} */ (chunk);
        const metadata = asRecord(entry.metadata);
        const shouldGateChunk = shouldEvaluateIngestHygiene(input, metadata);
        /** @type {ReturnType<typeof evaluateMemoryWrite> | null} */
        let evaluation = null;

        if (shouldGateChunk) {
          hygieneEvaluated += 1;
          evaluation = evaluateMemoryWrite({
            title:
              asText(entry.id) ||
              asText(entry.source).split(/[/\\]/u).at(-1) ||
              "pipeline-ingest",
            content: String(entry.content ?? ""),
            type: mapChunkKindToMemoryType(asText(entry.kind) || "doc"),
            project: projectId,
            scope: "project",
            topic: `pipeline/${asText(entry.kind) || "doc"}`,
            sourceKind: "pipeline-ingest"
          });

          if (evaluation.action === "quarantine") {
            quarantinedChunks.push({
              id: asText(entry.id) || "unknown",
              source: asText(entry.source) || "unknown",
              kind: asText(entry.kind) || "doc",
              reasons: [...evaluation.reasons],
              reviewStatus: evaluation.reviewStatus
            });
            continue;
          }
        }

        const normalizedChunk = normalizeChunkForRepository(entry, metadata, projectId, evaluation);

        if (normalizedChunk) {
          acceptedChunks.push(
            /** @type {import("../types/core-contracts.d.ts").Chunk} */ (normalizedChunk)
          );
        }
      }
      const saved = await repository.save(projectId, acceptedChunks);

      return {
        ...input,
        projectId,
        storedCount: saved.saved,
        quarantinedCount: quarantinedChunks.length,
        quarantinedChunks,
        hygiene: {
          evaluated: hygieneEvaluated,
          accepted: saved.saved,
          quarantined: quarantinedChunks.length
        },
        repositoryFilePath: repository.filePath,
        repositoryBaseDir: repositoryBaseDir ?? path.dirname(repository.filePath)
      };
    },

    /**
     * @param {{ input: unknown }} context
     */
    async recall(context) {
      const input = asRecord(context.input);
      const projectId = resolveProjectId(input.projectId ?? input.project);
      const query = typeof input.query === "string" ? input.query : "";
      const limit =
        typeof input.limit === "number" && Number.isFinite(input.limit)
          ? Math.max(1, Math.trunc(input.limit))
          : 5;
      const loadedChunks = await repository.load(projectId);
      const indexed = loadedChunks.filter((entry) => {
        const taggedProjectId = asText(asRecord(entry.tags).projectId);
        return !taggedProjectId || taggedProjectId === projectId;
      });
      const retriever = createHybridRetriever();
      retriever.index(
        indexed.map((entry) => ({
          id: entry.id,
          source: entry.source,
          kind: /** @type {import("../types/core-contracts.d.ts").ChunkKind} */ (entry.kind ?? "doc"),
          content: entry.content,
          certainty: 0.8,
          recency: 0.7,
          teachingValue: 0.7,
          priority: 0.75
        }))
      );
      const advancedResults = query ? retriever.search(query, { limit }) : [];
      const results = advancedResults.map((entry) => ({
        id: entry.chunk.id,
        source: entry.chunk.source,
        kind: entry.chunk.kind,
        content: entry.chunk.content,
        score: entry.score,
        breakdown: entry.breakdown
      }));

      return {
        ...input,
        projectId,
        query,
        limit,
        results,
        hit: results.length > 0,
        isolation: {
          loadedChunks: loadedChunks.length,
          indexedChunks: indexed.length
        }
      };
    }
  };
}

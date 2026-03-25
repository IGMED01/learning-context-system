// @ts-check

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { chunkDocument } from "../src/processing/chunker.js";
import { tagChunkMetadata } from "../src/processing/metadata-tagger.js";
import { extractEntities } from "../src/processing/entity-extractor.js";
import { createChunkRepository } from "../src/storage/chunk-repository.js";
import { createHybridRetriever } from "../src/storage/hybrid-retriever.js";
import { resolveDomainGuardPolicy } from "../src/guard/domain-policy-profiles.js";
import { enforceOutputGuard } from "../src/guard/output-guard.js";

function now() {
  return Date.now();
}

function ms(startedAt) {
  return Date.now() - startedAt;
}

/**
 * @param {number} count
 */
function buildSyntheticDocuments(count) {
  /** @type {Array<{ source: string, kind: "doc", content: string }>} */
  const documents = [];

  for (let index = 0; index < count; index += 1) {
    const id = String(index + 1).padStart(4, "0");
    documents.push({
      source: `synthetic/doc-${id}.md`,
      kind: "doc",
      content: [
        `# NEXUS synthetic document ${id}`,
        "",
        "## Auth boundary",
        "Validate JWT before route handlers and reject expired sessions.",
        "",
        "## Observability",
        "Track blocked rate, degraded rate, and recall hit rate for operations.",
        "",
        "## Versioning",
        "Compare prompt versions and choose rollback candidates using eval gates.",
        "",
        "## Security",
        "Never expose credentials, private keys, or access tokens in responses.",
        ""
      ].join("\n")
    });
  }

  return documents;
}

async function main() {
  const documentCount = Math.max(20, Number(process.argv[2] ?? 180));
  const tempRoot = await mkdtemp(path.join(tmpdir(), "nexus-foundations-stress-"));
  const repository = createChunkRepository({
    filePath: path.join(tempRoot, "chunks.jsonl")
  });

  try {
    const documents = buildSyntheticDocuments(documentCount);

    const processingStart = now();
    /** @type {import("../src/types/core-contracts.d.ts").Chunk[]} */
    const chunks = [];

    for (const doc of documents) {
      const processed = chunkDocument(doc.content, {
        source: doc.source,
        maxCharsPerChunk: 800
      });

      for (const chunk of processed) {
        const tags = tagChunkMetadata({
          source: doc.source,
          kind: "doc",
          content: chunk.content
        });
        const entities = extractEntities(chunk.content);
        chunks.push({
          id: chunk.id,
          source: doc.source,
          kind: "doc",
          content: chunk.content,
          certainty: tags.confidence,
          recency: 0.7,
          teachingValue: 0.65,
          priority: 0.6,
          processing: {
            section: chunk.metadata,
            tags,
            entities
          }
        });
      }
    }

    const processingMs = ms(processingStart);

    const storageStart = now();
    for (const chunk of chunks) {
      await repository.upsertChunk(chunk);
    }
    const stored = await repository.listChunks();
    const storageMs = ms(storageStart);

    const retrievalStart = now();
    const retriever = createHybridRetriever(stored);
    const retrieval = retriever.search("jwt validation request boundary", { limit: 8 });
    const retrievalMs = ms(retrievalStart);

    const guardStart = now();
    const guardPolicy = resolveDomainGuardPolicy("security_strict", {
      domainScope: {
        allowedDomains: ["security", "api"]
      }
    });
    const guard = enforceOutputGuard(
      "Authorization: Bearer sk-live-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      guardPolicy
    );
    const guardMs = ms(guardStart);

    const result = {
      status:
        retrieval.length >= 3 &&
        guard.action === "block" &&
        processingMs < 20_000 &&
        storageMs < 20_000
          ? "pass"
          : "warn",
      inputs: {
        documents: documentCount,
        producedChunks: chunks.length
      },
      timingsMs: {
        processing: processingMs,
        storage: storageMs,
        retrieval: retrievalMs,
        guard: guardMs,
        total: processingMs + storageMs + retrievalMs + guardMs
      },
      checks: {
        retrievalTopResults: retrieval.length,
        guardAction: guard.action,
        guardReasons: guard.reasons
      }
    };

    console.log("# NEXUS Foundations Stress");
    console.log(JSON.stringify(result, null, 2));

    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
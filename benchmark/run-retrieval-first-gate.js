#!/usr/bin/env node
// @ts-check

import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createNexusApiServer } from "../src/api/server.js";
import {
  evaluateRetrievalFirstGate,
  formatRetrievalFirstGateReport
} from "../src/eval/retrieval-first-gate.js";

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} targetPath
 */
async function cleanupDir(targetPath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retriable = /ENOTEMPTY|EPERM|EBUSY/i.test(message);
      if (!retriable || attempt === 4) {
        throw error;
      }

      await sleep(120 * (attempt + 1));
    }
  }
}

/**
 * @param {string[]} argv
 * @param {string} key
 * @param {string} fallback
 */
function option(argv, key, fallback) {
  const index = argv.indexOf(`--${key}`);
  if (index === -1) {
    return fallback;
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    return fallback;
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

/**
 * @param {string} raw
 * @param {string} sourceLabel
 */
function parseSuite(raw, sourceLabel) {
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`${sourceLabel} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  assertObject(parsed, sourceLabel);
  const payload = /** @type {Record<string, unknown>} */ (parsed);
  if (!Array.isArray(payload.cases) || payload.cases.length === 0) {
    throw new Error(`${sourceLabel} must include a non-empty 'cases' array.`);
  }

  const defaultsInput =
    payload.defaults && typeof payload.defaults === "object" && !Array.isArray(payload.defaults)
      ? /** @type {Record<string, unknown>} */ (payload.defaults)
      : {};
  const defaults = {
    ragLimit:
      typeof defaultsInput.ragLimit === "number" && Number.isFinite(defaultsInput.ragLimit)
        ? Math.max(1, Math.min(24, Math.trunc(defaultsInput.ragLimit)))
        : 6,
    rerankTopK:
      typeof defaultsInput.rerankTopK === "number" && Number.isFinite(defaultsInput.rerankTopK)
        ? Math.max(1, Math.min(48, Math.trunc(defaultsInput.rerankTopK)))
        : 12
  };

  const thresholds =
    payload.thresholds && typeof payload.thresholds === "object" && !Array.isArray(payload.thresholds)
      ? /** @type {Record<string, unknown>} */ (payload.thresholds)
      : {};

  const cases = payload.cases.map((entry, index) => {
    assertObject(entry, `cases[${index}]`);
    const row = /** @type {Record<string, unknown>} */ (entry);
    const endpoint = row.endpoint === "chat" ? "chat" : "ask";
    if (!Array.isArray(row.documents) || row.documents.length === 0) {
      throw new Error(`cases[${index}].documents must be a non-empty array.`);
    }
    if (!Array.isArray(row.expectedSources) || row.expectedSources.length === 0) {
      throw new Error(`cases[${index}].expectedSources must be a non-empty array.`);
    }

    const documents = row.documents.map((doc, docIndex) => {
      assertObject(doc, `cases[${index}].documents[${docIndex}]`);
      const parsedDoc = /** @type {Record<string, unknown>} */ (doc);
      return {
        title: assertString(parsedDoc.title, `cases[${index}].documents[${docIndex}].title`),
        content: assertString(parsedDoc.content, `cases[${index}].documents[${docIndex}].content`),
        type:
          typeof parsedDoc.type === "string" && parsedDoc.type.trim()
            ? parsedDoc.type.trim()
            : "architecture"
      };
    });

    return {
      name: assertString(row.name, `cases[${index}].name`),
      endpoint,
      project:
        typeof row.project === "string" && row.project.trim()
          ? row.project.trim()
          : `rag-case-${index + 1}`,
      query: assertString(row.query, `cases[${index}].query`),
      task: typeof row.task === "string" ? row.task.trim() : "",
      objective: typeof row.objective === "string" ? row.objective.trim() : "",
      expectedSources: row.expectedSources.map((item, itemIndex) =>
        assertString(item, `cases[${index}].expectedSources[${itemIndex}]`)
      ),
      documents,
      ragLimit:
        typeof row.ragLimit === "number" && Number.isFinite(row.ragLimit)
          ? Math.max(1, Math.min(24, Math.trunc(row.ragLimit)))
          : defaults.ragLimit,
      rerankTopK:
        typeof row.rerankTopK === "number" && Number.isFinite(row.rerankTopK)
          ? Math.max(1, Math.min(48, Math.trunc(row.rerankTopK)))
          : defaults.rerankTopK
    };
  });

  return {
    suite: typeof payload.suite === "string" ? payload.suite : "retrieval-first",
    thresholds,
    defaults,
    cases
  };
}

/**
 * @param {string} baseUrl
 * @param {ReturnType<typeof parseSuite>["cases"][number]} entry
 */
async function seedCaseDocuments(baseUrl, entry) {
  for (const document of entry.documents) {
    const response = await fetch(`${baseUrl}/api/remember`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: document.title,
        content: document.content,
        project: entry.project,
        type: document.type
      })
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(
        `[${entry.name}] Failed to seed document '${document.title}' (${response.status}): ${payload}`
      );
    }
  }
}

/**
 * @param {string} baseUrl
 * @param {ReturnType<typeof parseSuite>["cases"][number]} entry
 */
async function executeCase(baseUrl, entry) {
  await seedCaseDocuments(baseUrl, entry);

  const requestBody =
    entry.endpoint === "ask"
      ? {
          question: entry.query,
          task: entry.task,
          objective: entry.objective,
          project: entry.project,
          provider: "mock",
          rag: {
            enabled: true,
            autoRetrieve: true,
            rerank: true,
            limit: entry.ragLimit,
            rerankTopK: entry.rerankTopK
          }
        }
      : {
          query: entry.query,
          task: entry.task,
          objective: entry.objective,
          project: entry.project,
          provider: "mock",
          rag: {
            enabled: true,
            autoRetrieve: true,
            rerank: true,
            limit: entry.ragLimit,
            rerankTopK: entry.rerankTopK
          }
        };

  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/${entry.endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });
  const latencyMs = Math.max(0, Date.now() - startedAt);
  const payload = await response.json();
  const rag = payload?.context?.rag ?? {};
  const rankedSources = Array.isArray(rag.topSources)
    ? rag.topSources.filter((source) => typeof source === "string")
    : [];
  const ragError = typeof rag.error === "string" ? rag.error.trim() : "";
  const responseError =
    typeof payload?.error === "string" ? payload.error.trim() : "";

  return {
    name: entry.name,
    endpoint: entry.endpoint,
    expectedSources: entry.expectedSources,
    rankedSources,
    latencyMs,
    retrievedChunks:
      typeof rag.retrievedChunks === "number" && Number.isFinite(rag.retrievedChunks)
        ? rag.retrievedChunks
        : 0,
    error:
      !response.ok
        ? `${response.status}:${responseError || ragError || "request-failed"}`
        : ragError
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const format = option(argv, "format", "text").toLowerCase();
  const benchmarkPath = path.resolve(option(argv, "file", "benchmark/retrieval-first-benchmark.json"));

  if (format !== "text" && format !== "json") {
    throw new Error("Option --format must be 'text' or 'json'.");
  }

  const raw = await readFile(benchmarkPath, "utf8");
  const suite = parseSuite(raw, benchmarkPath);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "nexus-retrieval-gate-"));
  const server = createNexusApiServer({
    host: "127.0.0.1",
    port: 0,
    auth: {
      requireAuth: false
    },
    llm: {
      defaultProvider: "mock",
      providers: [
        {
          provider: "mock",
          async generate() {
            return {
              content: [
                "Change:",
                "Aplicamos retrieval-first para responder con contexto.",
                "Reason:",
                "Reducimos alucinación y mejoramos trazabilidad.",
                "Concepts:",
                "- Retrieval-first",
                "- RAG con rerank",
                "Practice:",
                "Valida Recall@k y MRR en tu dominio."
              ].join("\n")
            };
          }
        }
      ]
    },
    sync: {
      rootPath: tempRoot,
      autoStart: false
    },
    repositoryFilePath: path.join(tempRoot, "chunks.jsonl"),
    observabilityFilePath: path.join(tempRoot, "observability.json")
  });
  /** @type {Array<Awaited<ReturnType<typeof executeCase>>>} */
  const caseResults = [];

  let started = false;
  try {
    const start = await server.start();
    started = true;
    const baseUrl = `http://127.0.0.1:${start.port}`;

    for (const entry of suite.cases) {
      caseResults.push(await executeCase(baseUrl, entry));
    }
  } finally {
    if (started) {
      await server.stop();
    }
    await cleanupDir(tempRoot);
  }

  const report = evaluateRetrievalFirstGate({
    cases: caseResults,
    thresholds: suite.thresholds
  });
  const output = {
    suite: suite.suite,
    source: benchmarkPath,
    ...report
  };

  if (format === "json") {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(formatRetrievalFirstGateReport(report));
  }

  if (!report.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

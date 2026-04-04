// @ts-check

import { readFile, readdir, stat } from "node:fs/promises";
import { extname, relative, resolve, basename } from "node:path";
import {
  createSecurityScanStats,
  redactSensitiveContent,
  resolveSecurityPolicy
} from "../security/secret-redaction.js";
import { defaultChunkSignals, legalDocSignals, registerAdapter } from "./source-adapter.js";
import { slugify } from "../utils/text-utils.js";

const MAX_CHUNK_CHARS = 4000;
const MAX_PAGE_CHARS = 8000;

/**
 * @param {string} value
 */
function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}

/**
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitIntoChunks(text, maxChars) {
  if (text.length <= maxChars) {
    return [text];
  }

  const paragraphs = text.split(/\n{2,}/);
  /** @type {string[]} */
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }

    if (para.length > maxChars) {
      if (current.length > 0) {
        chunks.push(current.trim());
        current = "";
      }

      const sentences = para.split(/(?<=[.!?])\s+/);
      let sentenceBlock = "";

      for (const sentence of sentences) {
        if (sentenceBlock.length + sentence.length + 1 > maxChars && sentenceBlock.length > 0) {
          chunks.push(sentenceBlock.trim());
          sentenceBlock = "";
        }

        sentenceBlock += (sentenceBlock ? " " : "") + sentence;
      }

      if (sentenceBlock.trim()) {
        current = sentenceBlock;
      }
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * @param {string} rootPath
 */
function createScanStats(rootPath) {
  return {
    rootPath,
    discoveredFiles: 0,
    includedFiles: 0,
    ignoredFiles: 0,
    truncatedFiles: 0,
    redactedFiles: 0,
    redactionCount: 0,
    security: createSecurityScanStats(),
    kinds: { code: 0, test: 0, spec: 0, memory: 0, doc: 0, chat: 0, log: 0 }
  };
}

/**
 * @param {string} dirPath
 * @returns {Promise<string[]>}
 */
async function discoverPDFs(dirPath) {
  /** @type {string[]} */
  const pdfs = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = resolve(dirPath, entry.name);

    if (entry.isDirectory()) {
      const nested = await discoverPDFs(fullPath);
      pdfs.push(...nested);
    } else if (extname(entry.name).toLowerCase() === ".pdf") {
      pdfs.push(fullPath);
    }
  }

  return pdfs.sort();
}

/** @type {import("./source-adapter.js").SourceAdapter} */
export const pdfAdapter = {
  name: "pdf",
  supportedExtensions: [".pdf"],

  async scan(sourcePath, _options) {
    const resolvedPath = resolve(sourcePath);
    const info = await stat(resolvedPath);

    if (!info.isDirectory()) {
      if (extname(resolvedPath).toLowerCase() === ".pdf") {
        return { items: [resolvedPath], skipped: 0 };
      }

      return { items: [], skipped: 1 };
    }

    const allFiles = await discoverPDFs(resolvedPath);
    return { items: allFiles, skipped: 0 };
  },

  async read(sourcePath, options = {}) {
    const resolvedPath = resolve(sourcePath);
    const scanResult = await pdfAdapter.scan(resolvedPath, options);
    const stats = createScanStats(resolvedPath);
    /** @type {import("../types/core-contracts.d.ts").Chunk[]} */
    const allChunks = [];
    const project = options.project ?? "";
    const maxChars = options.maxContentChars ?? MAX_CHUNK_CHARS;
    const securityPolicy = resolveSecurityPolicy(options.security);

    /** @type {(buffer: Buffer) => Promise<{ text: string, numpages: number, info: Record<string, unknown> }>} */
    let pdfParse;

    try {
      const mod = await import("pdf-parse");
      pdfParse = /** @type {any} */ (mod.default ?? mod);
    } catch {
      throw new Error(
        "pdf-parse is required for PDF ingestion. Install it with: npm install pdf-parse"
      );
    }

    for (const pdfPath of scanResult.items) {
      stats.discoveredFiles += 1;

      try {
        const buffer = await readFile(pdfPath);
        const parsed = await pdfParse(buffer);
        const text = parsed.text?.trim();

        if (!text) {
          stats.ignoredFiles += 1;
          continue;
        }

        stats.includedFiles += 1;
        const relativePath = toPosixPath(relative(resolvedPath, pdfPath)) || basename(pdfPath);
        const fileSlug = slugify(basename(pdfPath, ".pdf"), { fallback: "document" });
        const isLegal = /normativ|ley|decreto|resoluci[oó]n|c[oó]digo|reglament|ordenanza/i.test(
          `${basename(pdfPath)} ${text.slice(0, 500)}`
        );
        const signals = isLegal ? legalDocSignals() : defaultChunkSignals("doc");

        const textChunks = splitIntoChunks(text, maxChars);

        for (let i = 0; i < textChunks.length; i++) {
          const chunkContent = textChunks[i];
          const redaction = redactSensitiveContent(chunkContent, securityPolicy);

          if (redaction.redacted) {
            stats.redactedFiles += 1;
            stats.redactionCount += redaction.redactionCount;
          }

          const wasTruncated = redaction.content.length > MAX_PAGE_CHARS;
          const content = wasTruncated
            ? `${redaction.content.slice(0, MAX_PAGE_CHARS)}\n/* content truncated */`
            : redaction.content;

          if (wasTruncated) {
            stats.truncatedFiles += 1;
          }

          const chunkId = textChunks.length > 1
            ? `pdf-${fileSlug}-part${i + 1}`
            : `pdf-${fileSlug}`;

          allChunks.push({
            id: chunkId,
            source: `pdf://${project ? project + "/" : ""}${relativePath}${textChunks.length > 1 ? `#part${i + 1}` : ""}`,
            kind: "doc",
            content: `[PDF: ${basename(pdfPath)}${textChunks.length > 1 ? ` — part ${i + 1}/${textChunks.length}` : ""}]\n${content}`,
            ...signals
          });
          stats.kinds.doc += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        allChunks.push({
          id: `pdf-error-${slugify(basename(pdfPath, ".pdf"), { fallback: "document" })}`,
          source: `pdf://${basename(pdfPath)}`,
          kind: "doc",
          content: `[PDF extraction failed: ${basename(pdfPath)}] ${message}`,
          certainty: 0.3,
          recency: 0.5,
          teachingValue: 0.1,
          priority: 0.2
        });
        stats.ignoredFiles += 1;
      }
    }

    return { chunks: allChunks, stats };
  }
};

// Auto-register
registerAdapter(pdfAdapter);

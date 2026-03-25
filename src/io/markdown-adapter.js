// @ts-check

import { readFile, readdir, stat } from "node:fs/promises";
import { extname, relative, resolve, basename } from "node:path";
import {
  createSecurityScanStats,
  redactSensitiveContent,
  resolveSecurityPolicy
} from "../security/secret-redaction.js";
import { defaultChunkSignals, legalDocSignals, registerAdapter } from "./source-adapter.js";

const MAX_SECTION_CHARS = 4000;
const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".rst"]);

/**
 * @param {string} value
 */
function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    || "document";
}

/**
 * @param {string} value
 */
function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}

/**
 * @typedef {{
 *   heading: string,
 *   level: number,
 *   content: string
 * }} MarkdownSection
 */

/**
 * @param {string} text
 * @returns {MarkdownSection[]}
 */
function splitByHeadings(text) {
  const lines = text.split(/\r?\n/);
  /** @type {MarkdownSection[]} */
  const sections = [];
  let currentHeading = "";
  let currentLevel = 0;
  /** @type {string[]} */
  let currentLines = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      if (currentLines.length > 0 || currentHeading) {
        sections.push({
          heading: currentHeading,
          level: currentLevel,
          content: currentLines.join("\n").trim()
        });
      }

      currentHeading = headingMatch[2].trim();
      currentLevel = headingMatch[1].length;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0 || currentHeading) {
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      content: currentLines.join("\n").trim()
    });
  }

  if (sections.length === 0 && text.trim()) {
    sections.push({
      heading: "",
      level: 0,
      content: text.trim()
    });
  }

  return sections;
}

/**
 * @param {MarkdownSection[]} sections
 * @param {number} maxChars
 * @returns {MarkdownSection[]}
 */
function mergeSections(sections, maxChars) {
  /** @type {MarkdownSection[]} */
  const merged = [];
  /** @type {MarkdownSection | null} */
  let buffer = null;

  for (const section of sections) {
    if (!buffer) {
      buffer = { ...section };
      continue;
    }

    const combined = `${buffer.content}\n\n## ${section.heading}\n${section.content}`;

    if (combined.length <= maxChars) {
      buffer.content = combined;
      if (!buffer.heading && section.heading) {
        buffer.heading = section.heading;
      }
    } else {
      merged.push(buffer);
      buffer = { ...section };
    }
  }

  if (buffer) {
    merged.push(buffer);
  }

  return merged;
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
async function discoverMarkdown(dirPath) {
  /** @type {string[]} */
  const files = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = resolve(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      const nested = await discoverMarkdown(fullPath);
      files.push(...nested);
    } else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

/** @type {import("./source-adapter.js").SourceAdapter} */
export const markdownAdapter = {
  name: "markdown",
  supportedExtensions: [".md", ".txt", ".rst"],

  async scan(sourcePath, _options) {
    const resolvedPath = resolve(sourcePath);
    const info = await stat(resolvedPath);

    if (!info.isDirectory()) {
      if (SUPPORTED_EXTENSIONS.has(extname(resolvedPath).toLowerCase())) {
        return { items: [resolvedPath], skipped: 0 };
      }

      return { items: [], skipped: 1 };
    }

    const allFiles = await discoverMarkdown(resolvedPath);
    return { items: allFiles, skipped: 0 };
  },

  async read(sourcePath, options = {}) {
    const resolvedPath = resolve(sourcePath);
    const scanResult = await markdownAdapter.scan(resolvedPath, options);
    const stats = createScanStats(resolvedPath);
    /** @type {import("../types/core-contracts.d.ts").Chunk[]} */
    const allChunks = [];
    const project = options.project ?? "";
    const maxChars = options.maxContentChars ?? MAX_SECTION_CHARS;
    const securityPolicy = resolveSecurityPolicy(options.security);

    for (const filePath of scanResult.items) {
      stats.discoveredFiles += 1;

      try {
        const raw = await readFile(filePath, "utf8");
        const text = raw.trim();

        if (!text) {
          stats.ignoredFiles += 1;
          continue;
        }

        stats.includedFiles += 1;
        const relativePath = toPosixPath(relative(resolvedPath, filePath)) || basename(filePath);
        const fileSlug = slugify(basename(filePath, extname(filePath)));
        const isLegal = /normativ|ley|decreto|resoluci[oó]n|c[oó]digo|reglament|ordenanza|art[ií]culo/i.test(
          `${basename(filePath)} ${text.slice(0, 500)}`
        );
        const signals = isLegal ? legalDocSignals() : defaultChunkSignals("doc");

        const sections = splitByHeadings(text);
        const merged = mergeSections(sections, maxChars);

        for (let i = 0; i < merged.length; i++) {
          const section = merged[i];
          const redaction = redactSensitiveContent(section.content, securityPolicy);

          if (redaction.redacted) {
            stats.redactedFiles += 1;
            stats.redactionCount += redaction.redactionCount;
          }

          const wasTruncated = redaction.content.length > maxChars;
          const content = wasTruncated
            ? `${redaction.content.slice(0, maxChars)}\n/* content truncated */`
            : redaction.content;

          if (wasTruncated) {
            stats.truncatedFiles += 1;
          }

          const sectionLabel = section.heading
            ? slugify(section.heading).slice(0, 30)
            : `part${i + 1}`;
          const chunkId = merged.length > 1
            ? `md-${fileSlug}-${sectionLabel}`
            : `md-${fileSlug}`;

          const headerPrefix = section.heading
            ? `[${basename(filePath)} — ${section.heading}]`
            : `[${basename(filePath)}]`;

          allChunks.push({
            id: chunkId,
            source: `markdown://${project ? project + "/" : ""}${relativePath}${section.heading ? `#${slugify(section.heading)}` : ""}`,
            kind: "doc",
            content: `${headerPrefix}\n${content}`,
            ...signals
          });
          stats.kinds.doc += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        allChunks.push({
          id: `md-error-${slugify(basename(filePath))}`,
          source: `markdown://${basename(filePath)}`,
          kind: "doc",
          content: `[Markdown read failed: ${basename(filePath)}] ${message}`,
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
registerAdapter(markdownAdapter);

// @ts-check

import { createObsidianProvider } from "../integrations/obsidian-provider.js";
import { buildCloseSummaryContent } from "./memory-utils.js";
import {
  applyMetadataGating,
  dedupeMemoryEntries,
  rankHybridMemoryEntries,
  toMemoryContextStdout,
  toMemorySearchStdout
} from "./memory-search-ranking.js";

/** @typedef {import("../types/core-contracts.d.ts").MemoryEntry} MemoryEntry */
/** @typedef {import("../types/core-contracts.d.ts").MemoryProvider} MemoryProvider */
/** @typedef {import("../types/core-contracts.d.ts").MemorySearchOptions} MemorySearchOptions */
/** @typedef {import("../types/core-contracts.d.ts").MemorySaveInput} MemorySaveInput */
/** @typedef {import("../types/core-contracts.d.ts").MemoryCloseInput} MemoryCloseInput */

const TAG_SCOPE_PREFIX = "memory-scope:";
const TAG_TOPIC_PREFIX = "memory-topic:";
const TAG_LANGUAGE_PREFIX = "memory-language:";
const TAG_TYPE_PREFIX = "memory-type:";
const TAG_RISK_PREFIX = "memory-risk:";
const TAG_SEVERITY_PREFIX = "memory-severity:";

/**
 * @param {unknown} value
 */
function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @param {unknown} value
 */
function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => asText(entry)).filter(Boolean)
    : [];
}

/**
 * @param {unknown} value
 * @param {string} fallback
 */
function normalizeIso(value, fallback) {
  const text = asText(value);
  if (!text) {
    return fallback;
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return new Date(parsed).toISOString();
}

/**
 * @param {string[]} tags
 * @param {string} prefix
 */
function readTagValue(tags, prefix) {
  const match = tags.find((tag) => tag.startsWith(prefix));
  if (!match) {
    return "";
  }
  return match.slice(prefix.length).trim();
}

/**
 * @param {Record<string, unknown>} entry
 * @param {string} fallbackProject
 * @returns {MemoryEntry}
 */
function toMemoryEntry(entry, fallbackProject = "") {
  const tags = asStringArray(entry.tags);
  const nowIso = new Date().toISOString();
  const createdAt = normalizeIso(entry.createdAt, nowIso);
  const updatedAt = normalizeIso(entry.updatedAt, createdAt);
  const type = asText(entry.type) || readTagValue(tags, TAG_TYPE_PREFIX) || "learning";
  const scope = asText(entry.scope) || readTagValue(tags, TAG_SCOPE_PREFIX) || "project";
  const topic = asText(entry.topic) || readTagValue(tags, TAG_TOPIC_PREFIX);
  const language =
    asText(entry.language) || readTagValue(tags, TAG_LANGUAGE_PREFIX);
  const riskTaxonomy = asText(entry.riskTaxonomy) || readTagValue(tags, TAG_RISK_PREFIX);
  const severity = asText(entry.severity) || readTagValue(tags, TAG_SEVERITY_PREFIX);
  const createdAtMs = Date.parse(createdAt);
  const updatedAtMs = Date.parse(updatedAt);

  return {
    id: asText(entry.id) || asText(entry.slug) || `${Date.now()}-obsidian`,
    title: asText(entry.title) || "Untitled memory",
    content: asText(entry.content),
    type,
    ...(language ? { language: language.toLowerCase() } : {}),
    project: asText(entry.project) || fallbackProject,
    scope,
    topic,
    createdAt,
    updatedAt,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : Date.now(),
    ...(severity ? { severity } : {}),
    ...(riskTaxonomy ? { riskTaxonomy } : {}),
    ...(typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
      ? { confidence: Math.max(0, Math.min(1, entry.confidence)) }
      : {}),
    ...(asText(entry.rule) ? { rule: asText(entry.rule) } : {}),
    ...(asText(entry.antiPattern) ? { antiPattern: asText(entry.antiPattern) } : {}),
    ...(asText(entry.fixPattern) ? { fixPattern: asText(entry.fixPattern) } : {}),
    ...(asText(entry.practicePrompt) ? { practicePrompt: asText(entry.practicePrompt) } : {}),
    ...(typeof entry.securityCritical === "boolean"
      ? { securityCritical: entry.securityCritical }
      : {})
  };
}

/**
 * @param {MemorySaveInput} input
 */
function buildKnowledgeTags(input) {
  /** @type {string[]} */
  const tags = [];
  const scope = asText(input.scope) || "project";
  const topic = asText(input.topic);
  const language = asText(input.language).toLowerCase();
  const type = asText(input.type) || "learning";

  tags.push(`${TAG_SCOPE_PREFIX}${scope}`);
  tags.push(`${TAG_TYPE_PREFIX}${type}`);

  if (topic) {
    tags.push(`${TAG_TOPIC_PREFIX}${topic}`);
  }

  if (language) {
    tags.push(`${TAG_LANGUAGE_PREFIX}${language}`);
  }

  const riskTaxonomy = asText(input.riskTaxonomy);
  if (riskTaxonomy) {
    tags.push(`${TAG_RISK_PREFIX}${riskTaxonomy}`);
  }

  const severity = asText(input.severity);
  if (severity) {
    tags.push(`${TAG_SEVERITY_PREFIX}${severity}`);
  }

  return tags;
}

/**
 * @param {MemoryEntry[]} entries
 * @param {MemorySearchOptions} options
 */
function buildSecuritySearchSummary(entries, options) {
  const riskIds = [
    ...new Set(
      entries
        .map((entry) => {
          const candidate = entry.riskTaxonomy;
          return typeof candidate === "string" ? candidate.trim() : "";
        })
        .filter(Boolean)
    )
  ];
  const confidenceValues = /** @type {number[]} */ (
    entries
      .map((entry) => entry.confidence)
      .filter((value) => typeof value === "number" && Number.isFinite(value))
  );
  const confidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : 0;

  return {
    riskIds,
    confidence: Number(confidence.toFixed(3)),
    isolationApplied: options.isolationMode !== "relaxed"
  };
}

/**
 * @param {ReturnType<typeof createObsidianProvider>} provider
 * @param {string} query
 * @param {MemorySearchOptions} options
 */
async function queryObsidianEntries(provider, query, options) {
  const requestedLimit = Math.max(1, Math.trunc(options.limit ?? 5));
  const gatherLimit = Math.max(120, requestedLimit * 8);
  const listed = await provider.list(options.project, { limit: gatherLimit });
  const memoryEntries = listed.map((entry) =>
    toMemoryEntry(/** @type {Record<string, unknown>} */ (entry), options.project ?? "")
  );
  const gated = applyMetadataGating(memoryEntries, options);

  if (!query.trim()) {
    return dedupeMemoryEntries(gated)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, requestedLimit);
  }

  return rankHybridMemoryEntries(gated, { query, options });
}

/**
 * @param {{
 *   cwd?: string,
 *   vaultDir?: string,
 *   pollIntervalMs?: number
 * }} [options]
 * @returns {MemoryProvider}
 */
export function createObsidianMemoryProvider(options = {}) {
  const provider = createObsidianProvider({
    cwd: options.cwd,
    vaultDir: options.vaultDir,
    pollIntervalMs: options.pollIntervalMs
  });

  return /** @type {MemoryProvider} */ ({
    name: "obsidian",
    config: {
      cwd: options.cwd ?? process.cwd(),
      vaultDir: options.vaultDir ?? ".lcs/obsidian-vault"
    },

    /**
     * @param {string} query
     * @param {MemorySearchOptions} [searchOptions]
     */
    async search(query, searchOptions = {}) {
      const entries = await queryObsidianEntries(provider, query, searchOptions);
      return {
        entries,
        stdout: toMemorySearchStdout(entries),
        provider: "obsidian",
        security: buildSecuritySearchSummary(entries, searchOptions)
      };
    },

    /**
     * @param {MemorySaveInput} input
     */
    async save(input) {
      const createdAt = new Date().toISOString();
      const result = await provider.sync({
        title: input.title,
        content: input.content,
        project: asText(input.project) || "_default",
        type: asText(input.type) || "learning",
        scope: asText(input.scope) || "project",
        topic: asText(input.topic),
        language: asText(input.language).toLowerCase(),
        source: asText(input.sourceKind) || "memory-obsidian",
        tags: buildKnowledgeTags(input),
        createdAt,
        updatedAt: createdAt,
        severity: asText(input.severity),
        confidence:
          typeof input.confidence === "number" && Number.isFinite(input.confidence)
            ? input.confidence
            : undefined,
        riskTaxonomy: asText(input.riskTaxonomy),
        rule: asText(input.rule),
        antiPattern: asText(input.antiPattern),
        fixPattern: asText(input.fixPattern),
        practicePrompt: asText(input.practicePrompt),
        securityCritical: input.securityCritical === true
      });

      return {
        id: asText(result.id) || `${Date.now()}-obsidian`,
        stdout: `Saved obsidian memory #${asText(result.id) || "unknown"}`,
        provider: "obsidian"
      };
    },

    /**
     * @param {string} id
     * @param {string} [project]
     */
    async delete(id, project) {
      const result = await provider.delete(id, project);
      return {
        deleted: result.deleted === true,
        id
      };
    },

    /**
     * @param {{ project?: string, limit?: number }} [listOptions]
     */
    async list(listOptions = {}) {
      const listed = await provider.list(listOptions.project, { limit: listOptions.limit });
      const entries = listed.map((entry) =>
        toMemoryEntry(/** @type {Record<string, unknown>} */ (entry), listOptions.project ?? "")
      );
      return dedupeMemoryEntries(entries)
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .slice(0, Math.max(1, Math.trunc(listOptions.limit ?? 50)));
    },

    async health() {
      const result = await provider.health();
      return {
        healthy: result.healthy === true,
        provider: "obsidian",
        detail: result.detail
      };
    },

    /**
     * @param {string} [project]
     */
    async recallContext(project) {
      const entries = await queryObsidianEntries(provider, "", {
        project,
        limit: 5
      });
      return {
        mode: "context",
        project: project ?? "",
        query: "",
        scope: "",
        type: "",
        limit: 5,
        stdout: toMemoryContextStdout(entries, project),
        stderr: "",
        provider: "obsidian"
      };
    },

    /**
     * @param {string} query
     * @param {MemorySearchOptions} [options]
     */
    async searchMemories(query, options = {}) {
      const result = await this.search(query, options);
      return {
        mode: "search",
        query,
        project: options.project ?? "",
        scope: options.scope ?? "",
        type: options.type ?? "",
        language: options.language ?? "",
        limit: options.limit ?? 5,
        stdout: result.stdout,
        stderr: "",
        provider: "obsidian"
      };
    },

    /**
     * @param {MemorySaveInput} input
     */
    async saveMemory(input) {
      const result = await this.save(input);
      return {
        action: "save",
        title: input.title,
        content: input.content,
        type: input.type ?? "learning",
        language: input.language ?? "",
        project: input.project ?? "",
        scope: input.scope ?? "project",
        topic: input.topic ?? "",
        stdout: result.stdout,
        stderr: "",
        provider: "obsidian"
      };
    },

    /**
     * @param {MemoryCloseInput} input
     */
    async closeSession(input) {
      const closedAt = new Date().toISOString();
      const title = input.title ?? `Session close - ${closedAt.slice(0, 10)}`;
      const content = buildCloseSummaryContent({
        summary: input.summary,
        learned: input.learned,
        next: input.next,
        workspace: process.cwd(),
        closedAt
      });
      const saved = await this.save({
        title,
        content,
        type: input.type ?? "learning",
        language: input.language,
        project: input.project,
        scope: input.scope ?? "project",
        topic: ""
      });

      return {
        ...saved,
        action: "close",
        title,
        summary: input.summary,
        learned: input.learned ?? "",
        next: input.next ?? "",
        content
      };
    },

    async stop() {
      await provider.stop?.();
    }
  });
}

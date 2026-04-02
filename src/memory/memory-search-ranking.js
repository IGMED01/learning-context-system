// @ts-check

/** @typedef {import("../types/core-contracts.d.ts").MemoryEntry} MemoryEntry */
/** @typedef {import("../types/core-contracts.d.ts").MemorySearchOptions} MemorySearchOptions */

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "de", "del", "el", "en",
  "es", "for", "from", "has", "he", "in", "is", "it", "its", "la", "las",
  "lo", "los", "of", "on", "or", "que", "se", "the", "to", "un", "una",
  "was", "were", "will", "with", "y"
]);

/**
 * @param {string} value
 */
function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/._-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * @param {string} value
 */
function tokenize(value) {
  return normalizeText(value)
    .split(/[\s/._-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !STOPWORDS.has(token));
}

/**
 * @param {MemoryEntry} entry
 */
function buildEntryText(entry) {
  return [entry.title, entry.content, entry.type, entry.topic, entry.language ?? ""]
    .join(" ")
    .slice(0, 12_000);
}

/**
 * @param {unknown} value
 */
function safeDateMs(value) {
  if (typeof value !== "string" || !value.trim()) {
    return Date.now();
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return Date.now();
  }

  return parsed;
}

/**
 * @param {MemoryEntry} entry
 * @param {number} nowMs
 */
function recencyScore(entry, nowMs) {
  const ageMs = Math.max(0, nowMs - safeDateMs(entry.updatedAt ?? entry.createdAt));
  const halfLifeDays = 21;
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
  const decay = Math.exp((-Math.log(2) * ageMs) / halfLifeMs);
  return Math.max(0, Math.min(1, decay));
}

/**
 * @param {string[]} left
 * @param {Set<string>} rightSet
 */
function overlapRatio(left, rightSet) {
  if (!left.length || rightSet.size === 0) {
    return 0;
  }

  let matched = 0;
  for (const token of left) {
    if (rightSet.has(token)) {
      matched += 1;
    }
  }

  return matched / Math.max(1, left.length);
}

/**
 * @param {MemoryEntry[]} entries
 * @returns {MemoryEntry[]}
 */
export function dedupeMemoryEntries(entries) {
  /**
   * @param {MemoryEntry} entry
   */
  function semanticKey(entry) {
    const title = normalizeText(entry.title);
    const content = normalizeText(entry.content).slice(0, 240);
    const project = normalizeText(entry.project ?? "");
    const scope = normalizeText(entry.scope ?? "");
    const type = normalizeText(entry.type ?? "");
    const language = normalizeText(entry.language ?? "");
    return `${project}::${scope}::${type}::${language}::${title}::${content}`;
  }

  /**
   * @param {MemoryEntry} left
   * @param {MemoryEntry} right
   */
  function newerEntry(left, right) {
    const leftTs = safeDateMs(left.updatedAt ?? left.createdAt);
    const rightTs = safeDateMs(right.updatedAt ?? right.createdAt);
    return rightTs >= leftTs ? right : left;
  }

  /** @type {Map<string, MemoryEntry>} */
  const byId = new Map();
  /** @type {MemoryEntry[]} */
  const idlessEntries = [];

  for (const entry of entries) {
    const id = String(entry.id ?? "").trim();
    if (!id) {
      idlessEntries.push(entry);
      continue;
    }

    const prior = byId.get(id);
    if (!prior) {
      byId.set(id, entry);
      continue;
    }

    byId.set(id, newerEntry(prior, entry));
  }

  /** @type {Map<string, MemoryEntry>} */
  const bySemantic = new Map();
  for (const entry of [...byId.values(), ...idlessEntries]) {
    const key = semanticKey(entry);
    const prior = bySemantic.get(key);
    if (!prior) {
      bySemantic.set(key, entry);
      continue;
    }
    bySemantic.set(key, newerEntry(prior, entry));
  }

  return [...bySemantic.values()];
}

/**
 * @param {MemoryEntry} entry
 * @param {MemorySearchOptions} options
 */
function matchesMetadata(entry, options) {
  if (options.project && entry.project !== options.project) {
    return false;
  }

  if (options.scope && entry.scope !== options.scope) {
    return false;
  }

  if (options.type && entry.type !== options.type) {
    return false;
  }

  const targetLanguage = normalizeText(options.language ?? "");
  if (!targetLanguage) {
    return true;
  }

  const isolationMode = options.isolationMode ?? "strict";
  const entryLanguage = normalizeText(entry.language ?? "");

  if (isolationMode === "strict") {
    return entryLanguage === targetLanguage;
  }

  if (!entryLanguage) {
    return true;
  }

  return entryLanguage === targetLanguage;
}

/**
 * @param {MemoryEntry[]} entries
 * @param {MemorySearchOptions} [options]
 */
export function applyMetadataGating(entries, options = {}) {
  return entries.filter((entry) => matchesMetadata(entry, options));
}

/**
 * @param {MemoryEntry[]} entries
 * @param {{
 *   query: string,
 *   options?: MemorySearchOptions
 * }} input
 */
export function rankHybridMemoryEntries(entries, input) {
  const query = String(input.query ?? "").trim();
  const options = input.options ?? {};
  const changedFiles = Array.isArray(options.changedFiles) ? options.changedFiles : [];
  const limit = Math.max(1, Math.trunc(options.limit ?? 5));
  const nowMs = Date.now();
  const queryTerms = new Set(tokenize(query));
  const changedPathTerms = new Set(changedFiles.flatMap((file) => tokenize(file)));
  const targetLanguage = normalizeText(options.language ?? "");

  const ranked = dedupeMemoryEntries(entries)
    .map((entry, index) => {
      const tokens = tokenize(buildEntryText(entry));
      const lexical = queryTerms.size ? overlapRatio(tokens, queryTerms) : 0;
      const pathAffinity = changedPathTerms.size ? overlapRatio(tokens, changedPathTerms) : 0;
      const recency = recencyScore(entry, nowMs);
      const entryLanguage = normalizeText(entry.language ?? "");
      const languagePenalty =
        targetLanguage && entryLanguage && entryLanguage !== targetLanguage ? 0.28 : 0;
      const score = lexical * 0.58 + pathAffinity * 0.16 + recency * 0.26 - languagePenalty;

      return {
        entry,
        score,
        index
      };
    })
    .sort((left, right) => {
      const delta = right.score - left.score;
      if (Math.abs(delta) > 0.0001) {
        return delta;
      }

      const rightTs = safeDateMs(right.entry.updatedAt ?? right.entry.createdAt);
      const leftTs = safeDateMs(left.entry.updatedAt ?? left.entry.createdAt);
      const tsDelta = rightTs - leftTs;
      if (tsDelta !== 0) {
        return tsDelta;
      }

      return left.index - right.index;
    });

  return ranked.slice(0, limit).map((item) => item.entry);
}

/**
 * @param {MemoryEntry[]} entries
 */
export function toMemorySearchStdout(entries) {
  if (!entries.length) {
    return "No memories found for that query.";
  }

  /** @type {string[]} */
  const lines = [`Found ${entries.length} memories:`, ""];

  entries.forEach((entry, index) => {
    lines.push(`[${index + 1}] #${entry.id} (${entry.type}) - ${entry.title}`);
    lines.push(`    ${String(entry.content ?? "").replace(/\s+/gu, " ").trim().slice(0, 220)}`);
    lines.push(
      `    ${entry.createdAt} | project: ${entry.project || "local"} | scope: ${entry.scope}${entry.language ? ` | language: ${entry.language}` : ""}`
    );
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

/**
 * @param {MemoryEntry[]} entries
 * @param {string} [project]
 */
export function toMemoryContextStdout(entries, project) {
  if (!entries.length) {
    return "No local memories available.";
  }

  const lines = ["Recent local memories:", ""];
  entries.forEach((entry, index) => {
    lines.push(
      `${index + 1}. [${entry.type}] ${entry.title} (${entry.createdAt})${
        entry.project ? ` | project: ${entry.project}` : ""
      }${entry.language ? ` | language: ${entry.language}` : ""}`
    );
  });

  if (project) {
    lines.push("");
    lines.push(`Filtered project: ${project}`);
  }

  return lines.join("\n");
}

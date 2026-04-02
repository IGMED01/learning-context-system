// @ts-check

/** @typedef {import("../types/core-contracts.d.ts").MemoryEntry} MemoryEntry */

const DEFAULT_MEMORY_LIMIT = 5;
const MAX_TEXT_CHARS = 12_000;
const DEFAULT_TOOL_AWARENESS_PENALTY = 0.16;
const MIN_TOOL_TOKEN_LENGTH = 3;

const MEMORY_RELEVANCE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "de",
  "del",
  "el",
  "en",
  "for",
  "from",
  "in",
  "is",
  "it",
  "la",
  "las",
  "los",
  "of",
  "on",
  "or",
  "que",
  "se",
  "the",
  "to",
  "un",
  "una",
  "with",
  "y"
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
    .filter(Boolean)
    .filter((token) => token.length >= 3)
    .filter((token) => !MEMORY_RELEVANCE_STOPWORDS.has(token));
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
 * Exponential recency decay with a 14-day half-life.
 *
 * @param {MemoryEntry} entry
 * @param {number} nowMs
 */
function recencyScore(entry, nowMs) {
  const ageMs = Math.max(0, nowMs - safeDateMs(entry.updatedAt ?? entry.createdAt));
  const halfLifeDays = 14;
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
 * @param {MemoryEntry} entry
 */
function buildEntryText(entry) {
  return [entry.title, entry.content, entry.type, entry.topic]
    .join(" ")
    .slice(0, MAX_TEXT_CHARS);
}

/**
 * @param {MemoryEntry} entry
 * @param {Set<string>} usedToolTerms
 * @param {number} penalty
 */
function toolAwarenessPenalty(entry, usedToolTerms, penalty) {
  if (!usedToolTerms.size) {
    return 0;
  }

  const tokens = new Set(tokenize(buildEntryText(entry)));
  for (const term of usedToolTerms) {
    if (tokens.has(term)) {
      return penalty;
    }
  }

  return 0;
}

/**
 * @param {MemoryEntry[]} entries
 */
function dedupeEntries(entries) {
  /** @type {Map<string, MemoryEntry>} */
  const unique = new Map();

  for (const entry of entries) {
    const id = String(entry.id ?? "").trim();
    const fallbackKey = `${normalizeText(entry.title)}::${normalizeText(entry.content).slice(0, 120)}`;
    const key = id || fallbackKey;

    if (!unique.has(key)) {
      unique.set(key, entry);
      continue;
    }

    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, entry);
      continue;
    }

    const existingTs = safeDateMs(existing.updatedAt ?? existing.createdAt);
    const candidateTs = safeDateMs(entry.updatedAt ?? entry.createdAt);
    if (candidateTs > existingTs) {
      unique.set(key, entry);
    }
  }

  return [...unique.values()];
}

/**
 * @typedef {{
 *   entries: MemoryEntry[],
 *   limit?: number,
 *   task?: string,
 *   objective?: string,
 *   focus?: string,
 *   changedFiles?: string[],
 *   alreadySurfacedMemoryIds?: string[],
 *   usedTools?: string[],
 *   allowResurfaceOnEmpty?: boolean,
 *   toolAwarenessPenalty?: number
 * }} RelevantMemoryInput
 */

/**
 * @typedef {{
 *   selected: MemoryEntry[],
 *   candidateCount: number,
 *   alreadySurfacedFiltered: number,
 *   resurfacedCount: number
 * }} RelevantMemoryResult
 */

/**
 * Rank memory candidates and prefer novel memories over already surfaced ones.
 *
 * @param {RelevantMemoryInput} input
 * @returns {RelevantMemoryResult}
 */
export function findRelevantMemories(input) {
  const limit = Math.max(1, Math.trunc(input.limit ?? DEFAULT_MEMORY_LIMIT));
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : [];
  const entries = dedupeEntries(Array.isArray(input.entries) ? input.entries : []);
  const alreadySurfaced = new Set(
    (input.alreadySurfacedMemoryIds ?? [])
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean)
  );
  const usedToolTerms = new Set(
    (input.usedTools ?? [])
      .flatMap((tool) => tokenize(tool))
      .filter((token) => token.length >= MIN_TOOL_TOKEN_LENGTH)
  );
  const toolPenalty = Math.max(
    0,
    Number.isFinite(Number(input.toolAwarenessPenalty))
      ? Number(input.toolAwarenessPenalty)
      : DEFAULT_TOOL_AWARENESS_PENALTY
  );
  const queryTerms = new Set(
    tokenize(
      [
        input.task ?? "",
        input.objective ?? "",
        input.focus ?? "",
        ...changedFiles
      ].join(" ")
    )
  );
  const nowMs = Date.now();
  const fallbackResurface = input.allowResurfaceOnEmpty === true;

  const ranked = entries
    .map((entry, index) => {
      const tokens = tokenize(buildEntryText(entry));
      const lexical = overlapRatio(tokens, queryTerms);
      const pathAffinity = overlapRatio(tokens, new Set(changedFiles.flatMap((file) => tokenize(file))));
      const recency = recencyScore(entry, nowMs);
      const resurfaced = alreadySurfaced.has(String(entry.id ?? "").trim());
      const awarenessPenalty = toolAwarenessPenalty(entry, usedToolTerms, toolPenalty);
      const noveltyPenalty = resurfaced ? 0.45 : 0;
      const score = lexical * 0.58 + pathAffinity * 0.14 + recency * 0.28 - noveltyPenalty - awarenessPenalty;

      return {
        entry,
        resurfaced,
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

  const novel = ranked.filter((item) => !item.resurfaced).map((item) => item.entry);
  const resurfaced = ranked.filter((item) => item.resurfaced).map((item) => item.entry);
  const selected = novel.slice(0, limit);
  const remainingSlots = Math.max(0, limit - selected.length);

  if (remainingSlots > 0 && fallbackResurface) {
    selected.push(...resurfaced.slice(0, remainingSlots));
  }

  return {
    selected,
    candidateCount: entries.length,
    alreadySurfacedFiltered: Math.max(0, entries.length - novel.length),
    resurfacedCount: selected.filter((entry) => alreadySurfaced.has(String(entry.id ?? "").trim())).length
  };
}


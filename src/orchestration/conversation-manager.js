// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").ConversationSession} ConversationSession
 * @typedef {import("../types/core-contracts.d.ts").ConversationTurn} ConversationTurn
 */

import { randomUUID } from "node:crypto";

/** @type {Map<string, ConversationSession>} */
const sessions = new Map();
const MAX_CONTEXT_CACHE_SIZE = 200;
/** @type {Map<string, string>} */
const contextCache = new Map();
const DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_MAX_TURNS = 120;
const DEFAULT_SUMMARY_EVERY = 12;
const DEFAULT_SUMMARY_KEEP_TURNS = 8;
const DEFAULT_CONTEXT_MAX_CHARS = 4_000;
const DEFAULT_RECALL_QUERY_MAX_CHARS = 2_000;
const DEFAULT_CONTRADICTION_LOOKBACK_TURNS = 16;
const DEFAULT_CONTRADICTION_MAX_ITEMS = 6;
const SUMMARY_KEY = "conversationSummary";
const TOTAL_TURNS_KEY = "__totalTurnsSeen";
const LAST_SUMMARY_AT_TURN_KEY = "__lastSummaryAtTurn";
const NOISE_TELEMETRY_KEY = "__noiseTelemetry";
const CONTRADICTION_STATE_KEY = "__contextContradictions";
const POLICY_ENV_KEYS = Object.freeze([
  "LCS_CONVERSATION_SESSION_TTL_MS",
  "LCS_CONVERSATION_MAX_TURNS",
  "LCS_CONVERSATION_SUMMARY_EVERY",
  "LCS_CONVERSATION_SUMMARY_KEEP_TURNS",
  "LCS_CONVERSATION_CONTEXT_MAX_CHARS",
  "LCS_CONVERSATION_RECALL_QUERY_MAX_CHARS",
  "LCS_CONVERSATION_CONTRADICTION_LOOKBACK_TURNS",
  "LCS_CONVERSATION_CONTRADICTION_MAX_ITEMS",
  "LCS_CONVERSATION_INCLUDE_CONTRADICTIONS"
]);
let cachedPolicy = null;
let cachedPolicyEnv = "";
let policyCacheHits = 0;
let policyRecomputations = 0;
let contextCacheHits = 0;
let contextComputations = 0;
const CONTRADICTION_NEGATIVE_TOKENS = new Set([
  "no",
  "not",
  "never",
  "without",
  "sin",
  "off",
  "false",
  "disabled",
  "disable",
  "denied",
  "deny",
  "reject",
  "blocked",
  "bloqueado",
  "inactivo"
]);
const CONTRADICTION_POSITIVE_TOKENS = new Set([
  "yes",
  "enabled",
  "enable",
  "on",
  "true",
  "allow",
  "allowed",
  "active",
  "activo",
  "accept",
  "accepted"
]);
const CONTRADICTION_STOPWORDS = new Set([
  "a",
  "al",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "cada",
  "con",
  "de",
  "del",
  "el",
  "en",
  "es",
  "esta",
  "está",
  "for",
  "from",
  "in",
  "is",
  "la",
  "las",
  "los",
  "must",
  "para",
  "por",
  "que",
  "should",
  "the",
  "to",
  "un",
  "una",
  "with",
  "y"
]);

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [opts]
 */
function parseIntEnv(raw, fallback, opts = {}) {
  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const value = Math.trunc(parsed);
  const min = opts.min ?? Number.MIN_SAFE_INTEGER;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {string | undefined} raw
 * @param {boolean} fallback
 */
function parseBooleanEnv(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }

  const normalized = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function buildPolicySnapshot() {
  return POLICY_ENV_KEYS
    .map((key) => `${key}=${process.env[key] ?? ""}`)
    .join("|");
}

/**
 * @param {string} sessionId
 */
function invalidateSessionContextCache(sessionId) {
  for (const key of contextCache.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      contextCache.delete(key);
    }
  }
}

/**
 * @param {string} key
 * @param {string} value
 */
function setContextCache(key, value) {
  if (contextCache.size >= MAX_CONTEXT_CACHE_SIZE) {
    const oldestKey = contextCache.keys().next().value;
    if (oldestKey) {
      contextCache.delete(oldestKey);
    }
  }

  contextCache.set(key, value);
}

function resolveConversationPolicy() {
  const envSnapshot = buildPolicySnapshot();
  if (cachedPolicy && envSnapshot === cachedPolicyEnv) {
    policyCacheHits += 1;
    return cachedPolicy;
  }

  policyRecomputations += 1;
  cachedPolicyEnv = envSnapshot;
  cachedPolicy = {
    sessionTtlMs: parseIntEnv(
      process.env.LCS_CONVERSATION_SESSION_TTL_MS,
      DEFAULT_SESSION_TTL_MS,
      { min: 0, max: 30 * 24 * 60 * 60 * 1000 }
    ),
    maxTurns: parseIntEnv(process.env.LCS_CONVERSATION_MAX_TURNS, DEFAULT_MAX_TURNS, {
      min: 1,
      max: 1_000
    }),
    summaryEvery: parseIntEnv(
      process.env.LCS_CONVERSATION_SUMMARY_EVERY,
      DEFAULT_SUMMARY_EVERY,
      { min: 0, max: 500 }
    ),
    summaryKeepTurns: parseIntEnv(
      process.env.LCS_CONVERSATION_SUMMARY_KEEP_TURNS,
      DEFAULT_SUMMARY_KEEP_TURNS,
      { min: 1, max: 200 }
    ),
    contextMaxChars: parseIntEnv(
      process.env.LCS_CONVERSATION_CONTEXT_MAX_CHARS,
      DEFAULT_CONTEXT_MAX_CHARS,
      { min: 500, max: 20_000 }
    ),
    recallQueryMaxChars: parseIntEnv(
      process.env.LCS_CONVERSATION_RECALL_QUERY_MAX_CHARS,
      DEFAULT_RECALL_QUERY_MAX_CHARS,
      { min: 300, max: 20_000 }
    ),
    contradictionLookbackTurns: parseIntEnv(
      process.env.LCS_CONVERSATION_CONTRADICTION_LOOKBACK_TURNS,
      DEFAULT_CONTRADICTION_LOOKBACK_TURNS,
      { min: 2, max: 200 }
    ),
    contradictionMaxItems: parseIntEnv(
      process.env.LCS_CONVERSATION_CONTRADICTION_MAX_ITEMS,
      DEFAULT_CONTRADICTION_MAX_ITEMS,
      { min: 1, max: 40 }
    ),
    includeContradictionsInContext: parseBooleanEnv(
      process.env.LCS_CONVERSATION_INCLUDE_CONTRADICTIONS,
      true
    )
  };

  return cachedPolicy;
}

/**
 * @param {string} value
 */
function normalizeText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
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
function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * @param {string} value
 */
function estimateTokens(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.ceil(normalized.length / 4));
}

/**
 * @param {ConversationTurn[]} turns
 */
function countDuplicateTurns(turns) {
  const seen = new Set();
  let duplicates = 0;

  for (const turn of turns) {
    const key = `${turn.role}:${normalizeText(turn.content).toLowerCase()}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }

    seen.add(key);
  }

  return duplicates;
}

/**
 * @param {ConversationTurn[]} turns
 */
function computeRoleEntropy(turns) {
  if (!turns.length) {
    return 0;
  }

  /** @type {Record<string, number>} */
  const counts = {};
  for (const turn of turns) {
    counts[turn.role] = (counts[turn.role] ?? 0) + 1;
  }

  return Object.values(counts).reduce((sum, count) => {
    const probability = count / turns.length;
    if (probability <= 0) {
      return sum;
    }

    return sum - probability * Math.log2(probability);
  }, 0);
}

/**
 * @param {ConversationSession} session
 */
function getNoiseTelemetryState(session) {
  const raw = asRecord(session.context[NOISE_TELEMETRY_KEY]);
  const last = asRecord(raw.last);

  return {
    samples: Math.max(0, Math.trunc(asFiniteNumber(raw.samples))),
    compactedTurnsTotal: Math.max(0, Math.trunc(asFiniteNumber(raw.compactedTurnsTotal))),
    inputTokensTotal: Math.max(0, Math.trunc(asFiniteNumber(raw.inputTokensTotal))),
    outputTokensTotal: Math.max(0, Math.trunc(asFiniteNumber(raw.outputTokensTotal))),
    suppressedTokensTotal: Math.max(0, Math.trunc(asFiniteNumber(raw.suppressedTokensTotal))),
    duplicateTurnsTotal: Math.max(0, Math.trunc(asFiniteNumber(raw.duplicateTurnsTotal))),
    entropyTotal: Math.max(0, asFiniteNumber(raw.entropyTotal)),
    last: {
      compactedTurns: Math.max(0, Math.trunc(asFiniteNumber(last.compactedTurns))),
      inputTokens: Math.max(0, Math.trunc(asFiniteNumber(last.inputTokens))),
      outputTokens: Math.max(0, Math.trunc(asFiniteNumber(last.outputTokens))),
      suppressedTokens: Math.max(0, Math.trunc(asFiniteNumber(last.suppressedTokens))),
      duplicateTurns: Math.max(0, Math.trunc(asFiniteNumber(last.duplicateTurns))),
      sourceEntropy: Math.max(0, asFiniteNumber(last.sourceEntropy)),
      updatedAt: typeof last.updatedAt === "string" ? last.updatedAt : ""
    }
  };
}

/**
 * @param {ConversationSession} session
 * @param {{
 *   compactedTurns: number,
 *   inputTokens: number,
 *   outputTokens: number,
 *   duplicateTurns: number,
 *   sourceEntropy: number
 * }} event
 */
function updateNoiseTelemetryState(session, event) {
  const current = getNoiseTelemetryState(session);
  const compactedTurns = Math.max(0, Math.trunc(event.compactedTurns));
  const inputTokens = Math.max(0, Math.trunc(event.inputTokens));
  const outputTokens = Math.max(0, Math.trunc(event.outputTokens));
  const duplicateTurns = Math.max(0, Math.trunc(event.duplicateTurns));
  const sourceEntropy = Math.max(0, event.sourceEntropy);
  const suppressedTokens = Math.max(0, inputTokens - outputTokens);

  current.samples += 1;
  current.compactedTurnsTotal += compactedTurns;
  current.inputTokensTotal += inputTokens;
  current.outputTokensTotal += outputTokens;
  current.suppressedTokensTotal += suppressedTokens;
  current.duplicateTurnsTotal += duplicateTurns;
  current.entropyTotal += sourceEntropy;
  current.last = {
    compactedTurns,
    inputTokens,
    outputTokens,
    suppressedTokens,
    duplicateTurns,
    sourceEntropy: Number(sourceEntropy.toFixed(4)),
    updatedAt: new Date().toISOString()
  };

  session.context[NOISE_TELEMETRY_KEY] = current;
}

/**
 * @param {string} value
 * @param {number} maxChars
 */
function clipText(value, maxChars) {
  const normalized = normalizeText(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

/**
 * @param {string} unit
 */
function normalizeTimeUnit(unit) {
  const normalized = normalizeText(unit).toLowerCase();
  if (!normalized) {
    return "";
  }

  if (["ms", "millisecond", "milliseconds"].includes(normalized)) {
    return "ms";
  }
  if (["s", "sec", "secs", "second", "seconds", "segundo", "segundos"].includes(normalized)) {
    return "s";
  }
  if (["m", "min", "mins", "minute", "minutes", "minuto", "minutos"].includes(normalized)) {
    return "m";
  }
  if (["h", "hr", "hrs", "hour", "hours", "hora", "horas"].includes(normalized)) {
    return "h";
  }
  if (["d", "day", "days", "dia", "dias", "día", "días"].includes(normalized)) {
    return "d";
  }

  return normalized;
}

/**
 * @param {string} text
 */
function tokenizeContradictionText(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
}

/**
 * @param {string} sentence
 */
function normalizeContradictionSentence(sentence) {
  return normalizeText(sentence)
    .replace(/^[-*]\s+/u, "")
    .replace(/^\[[^\]]+\]\s+/u, "");
}

/**
 * @param {string} text
 */
function extractNumericSignal(text) {
  const match = normalizeText(text).toLowerCase().match(
    /\b(\d{1,4})\s*(ms|millisecond(?:s)?|s|sec(?:s)?|second(?:s)?|segundo(?:s)?|m|min(?:ute)?(?:s)?|minuto(?:s)?|h|hr(?:s)?|hour(?:s)?|hora(?:s)?|d|day(?:s)?|d[ií]a(?:s)?)\b/u
  );

  if (!match) {
    return {
      value: null,
      unit: ""
    };
  }

  return {
    value: Number(match[1]),
    unit: normalizeTimeUnit(match[2])
  };
}

/**
 * @param {string} sentence
 * @param {"summary" | "recent"} source
 */
function buildContradictionClaim(sentence, source) {
  const normalizedSentence = normalizeContradictionSentence(sentence);
  const clipped = clipText(normalizedSentence, 220);
  const tokens = tokenizeContradictionText(clipped);

  if (tokens.length < 3) {
    return null;
  }

  const hasSignalVerb = tokens.some((token) =>
    [
      "is",
      "are",
      "es",
      "esta",
      "está",
      "must",
      "should",
      "debe",
      "enabled",
      "disabled",
      "true",
      "false",
      "on",
      "off",
      "sin",
      "without",
      "con",
      "with",
      "no",
      "not"
    ].includes(token)
  );
  const numericSignal = extractNumericSignal(clipped);

  if (!hasSignalVerb && numericSignal.value === null) {
    return null;
  }

  const polarity = tokens.some((token) => CONTRADICTION_NEGATIVE_TOKENS.has(token))
    ? -1
    : tokens.some((token) => CONTRADICTION_POSITIVE_TOKENS.has(token))
      ? 1
      : 0;
  const keyTokens = tokens
    .filter((token) => !CONTRADICTION_STOPWORDS.has(token))
    .filter((token) => !CONTRADICTION_NEGATIVE_TOKENS.has(token))
    .filter((token) => !CONTRADICTION_POSITIVE_TOKENS.has(token))
    .filter((token) => !/^\d+$/u.test(token))
    .slice(0, 8);

  if (keyTokens.length < 2) {
    return null;
  }

  return {
    key: keyTokens.join(" "),
    polarity,
    numericValue: numericSignal.value,
    numericUnit: numericSignal.unit,
    sentence: clipped,
    source
  };
}

/**
 * @param {string} summary
 * @param {ConversationTurn[]} recentTurns
 * @param {number} maxItems
 */
function detectSummaryContradictions(summary, recentTurns, maxItems) {
  const summarySentences = normalizeText(summary)
    .split(/[.!?\n]+/u)
    .map((entry) => normalizeText(entry))
    .filter(Boolean);
  const recentSentences = recentTurns
    .map((turn) => turn.content)
    .flatMap((content) =>
      normalizeText(content)
        .split(/[.!?\n]+/u)
        .map((entry) => normalizeText(entry))
        .filter(Boolean)
    );
  const summaryClaims = summarySentences
    .map((sentence) => buildContradictionClaim(sentence, "summary"))
    .filter(Boolean);
  const recentClaims = recentSentences
    .map((sentence) => buildContradictionClaim(sentence, "recent"))
    .filter(Boolean);

  if (!summaryClaims.length || !recentClaims.length) {
    return [];
  }

  /** @type {Set<string>} */
  const dedupe = new Set();
  /** @type {Array<{ key: string, kind: "polarity" | "numeric", summary: string, recent: string }>} */
  const contradictions = [];

  for (const recentClaim of recentClaims) {
    const matches = summaryClaims.filter((claim) => claim.key === recentClaim.key);

    for (const summaryClaim of matches) {
      const polarityConflict =
        recentClaim.polarity !== 0 &&
        summaryClaim.polarity !== 0 &&
        recentClaim.polarity !== summaryClaim.polarity;
      const numericConflict =
        recentClaim.numericValue !== null &&
        summaryClaim.numericValue !== null &&
        recentClaim.numericUnit &&
        summaryClaim.numericUnit &&
        recentClaim.numericUnit === summaryClaim.numericUnit &&
        recentClaim.numericValue !== summaryClaim.numericValue;

      if (!polarityConflict && !numericConflict) {
        continue;
      }

      const kind = polarityConflict ? "polarity" : "numeric";
      const signature = `${recentClaim.key}:${kind}:${summaryClaim.sentence}:${recentClaim.sentence}`;

      if (dedupe.has(signature)) {
        continue;
      }

      dedupe.add(signature);
      contradictions.push({
        key: recentClaim.key,
        kind,
        summary: summaryClaim.sentence,
        recent: recentClaim.sentence
      });

      if (contradictions.length >= maxItems) {
        return contradictions;
      }
    }
  }

  return contradictions;
}

/**
 * @param {ConversationSession} session
 */
function getContradictionState(session) {
  const raw = asRecord(session.context[CONTRADICTION_STATE_KEY]);
  const items = Array.isArray(raw.items)
    ? raw.items
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => asRecord(entry))
        .map((entry) => ({
          key: typeof entry.key === "string" ? entry.key : "",
          kind: entry.kind === "numeric" ? "numeric" : "polarity",
          summary: typeof entry.summary === "string" ? entry.summary : "",
          recent: typeof entry.recent === "string" ? entry.recent : ""
        }))
        .filter((entry) => entry.key && entry.summary && entry.recent)
    : [];

  return {
    count: Math.max(0, Math.trunc(asFiniteNumber(raw.count))),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    items
  };
}

/**
 * @param {ConversationSession} session
 */
function updateContradictionState(session) {
  const policy = resolveConversationPolicy();
  const summary = getSummary(session);
  const recentTurns = session.turns.slice(-policy.contradictionLookbackTurns);
  const items = detectSummaryContradictions(summary, recentTurns, policy.contradictionMaxItems);
  session.context[CONTRADICTION_STATE_KEY] = {
    count: items.length,
    updatedAt: new Date().toISOString(),
    items
  };
}

/**
 * @param {ConversationSession} session
 * @returns {string}
 */
function getSummary(session) {
  const value = session.context?.[SUMMARY_KEY];
  return typeof value === "string" ? value : "";
}

/**
 * @param {ConversationSession} session
 * @param {string} summary
 */
function setSummary(session, summary) {
  session.context[SUMMARY_KEY] = summary;
}

/**
 * @param {ConversationSession} session
 * @param {ConversationTurn[]} turns
 */
function appendSummaryFromTurns(session, turns) {
  if (!turns.length) {
    return;
  }

  const previous = getSummary(session);
  const rawCompactText = turns.map((turn) => `[${turn.role}] ${turn.content}`).join("\n");
  const dedupKeys = new Set();
  const lines = [];

  for (const turn of turns) {
    const dedupKey = `${turn.role}:${normalizeText(turn.content).toLowerCase()}`;
    if (dedupKeys.has(dedupKey)) {
      continue;
    }

    dedupKeys.add(dedupKey);
    lines.push(`- [${turn.role}] ${clipText(turn.content, 220)}`);
  }

  const next = `${previous}\n${lines.join("\n")}`.trim();
  const inputTokens = estimateTokens(rawCompactText);
  const outputTokens = estimateTokens(lines.join("\n"));
  const duplicateTurns = countDuplicateTurns(turns);
  const sourceEntropy = computeRoleEntropy(turns);

  // Cap summary size to keep memory bounded.
  setSummary(session, next.slice(-8_000));
  updateNoiseTelemetryState(session, {
    compactedTurns: turns.length,
    inputTokens,
    outputTokens,
    duplicateTurns,
    sourceEntropy
  });
}

/**
 * @param {ConversationSession} session
 * @param {number} count
 */
function pruneTurnsIntoSummary(session, count) {
  const safeCount = Math.max(0, Math.min(count, session.turns.length));
  if (safeCount === 0) {
    return;
  }

  const turnsToSummarize = session.turns.slice(0, safeCount);
  appendSummaryFromTurns(session, turnsToSummarize);
  session.turns.splice(0, safeCount);
}

/**
 * @param {ConversationSession} session
 */
function applyRetentionPolicy(session) {
  const policy = resolveConversationPolicy();
  const totalTurnsSeen = Number(session.context[TOTAL_TURNS_KEY] ?? session.turns.length);
  const lastSummaryAtTurn = Number(session.context[LAST_SUMMARY_AT_TURN_KEY] ?? 0);

  if (
    policy.summaryEvery > 0 &&
    totalTurnsSeen - lastSummaryAtTurn >= policy.summaryEvery &&
    session.turns.length > policy.summaryKeepTurns
  ) {
    const pruneCount = session.turns.length - policy.summaryKeepTurns;
    pruneTurnsIntoSummary(session, pruneCount);
    session.context[LAST_SUMMARY_AT_TURN_KEY] = totalTurnsSeen;
  }

  if (session.turns.length > policy.maxTurns) {
    pruneTurnsIntoSummary(session, session.turns.length - policy.maxTurns);
  }
}

/**
 * @param {number} [nowMs]
 * @returns {number}
 */
export function cleanupExpiredSessions(nowMs = Date.now()) {
  const { sessionTtlMs } = resolveConversationPolicy();

  if (sessionTtlMs <= 0) {
    return 0;
  }

  let removed = 0;

  for (const [sessionId, session] of sessions.entries()) {
    const updatedAtMs = Date.parse(session.updatedAt || session.createdAt);
    if (!Number.isFinite(updatedAtMs)) {
      continue;
    }

    if (nowMs - updatedAtMs > sessionTtlMs) {
      sessions.delete(sessionId);
      invalidateSessionContextCache(sessionId);
      removed += 1;
    }
  }

  return removed;
}

/**
 * @param {string} project
 * @returns {ConversationSession}
 */
export function createSession(project) {
  cleanupExpiredSessions();

  /** @type {ConversationSession} */
  const session = {
    sessionId: randomUUID(),
    project,
    turns: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    context: {}
  };

  sessions.set(session.sessionId, session);
  return session;
}

/**
 * @param {string} sessionId
 * @returns {ConversationSession | undefined}
 */
export function getSession(sessionId) {
  cleanupExpiredSessions();
  return sessions.get(sessionId);
}

/**
 * @param {string} sessionId
 * @param {"user" | "system"} role
 * @param {string} content
 * @param {Record<string, unknown>} [metadata]
 * @returns {ConversationTurn | undefined}
 */
export function addTurn(sessionId, role, content, metadata) {
  cleanupExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  /** @type {ConversationTurn} */
  const turn = {
    role,
    content: normalizeText(content),
    timestamp: new Date().toISOString(),
    metadata
  };

  session.turns.push(turn);
  session.context[TOTAL_TURNS_KEY] = Number(session.context[TOTAL_TURNS_KEY] ?? 0) + 1;
  applyRetentionPolicy(session);
  updateContradictionState(session);
  session.updatedAt = turn.timestamp;
  invalidateSessionContextCache(sessionId);

  return turn;
}

/**
 * @param {string} sessionId
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
export function updateContext(sessionId, key, value) {
  cleanupExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.context[key] = value;
  session.updatedAt = new Date().toISOString();
  invalidateSessionContextCache(sessionId);
  return true;
}

/**
 * @param {string} sessionId
 * @param {number} [maxTurns]
 * @returns {string}
 */
export function buildConversationContext(sessionId, maxTurns = 10) {
  cleanupExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) return "";

  const safeMaxTurns = Math.max(1, Math.trunc(maxTurns));
  const policySnapshot = buildPolicySnapshot();
  const cacheKey = `${sessionId}:${session.updatedAt}:${safeMaxTurns}:${policySnapshot}`;
  if (contextCache.has(cacheKey)) {
    contextCacheHits += 1;
    return contextCache.get(cacheKey) ?? "";
  }

  contextComputations += 1;
  const policy = resolveConversationPolicy();
  const recentTurns = session.turns.slice(-safeMaxTurns);
  const summary = getSummary(session);
  const contradictionState = getContradictionState(session);
  /** @type {string[]} */
  const sections = [];

  if (summary) {
    sections.push(`[summary]\n${summary}`);
  }

  if (
    policy.includeContradictionsInContext &&
    contradictionState.items.length
  ) {
    sections.push(
      [
        "[contradictions]",
        ...contradictionState.items.map(
          (item) =>
            `- (${item.kind}) key='${item.key}' | summary='${item.summary}' | recent='${item.recent}'`
        )
      ].join("\n")
    );
  }

  if (recentTurns.length) {
    sections.push(
      recentTurns
        .map((t) => `[${t.role}] ${t.content}`)
        .join("\n")
    );
  }

  if (!sections.length) {
    return "";
  }

  const context = sections.join("\n\n");
  const trimmed = context.length > policy.contextMaxChars
    ? context.slice(-policy.contextMaxChars)
    : context;
  setContextCache(cacheKey, trimmed);
  return trimmed;
}

/**
 * Build a recall query using current user text + compact conversation context.
 *
 * @param {string} content
 * @param {string} conversationContext
 * @returns {string}
 */
export function buildConversationRecallQuery(content, conversationContext) {
  const policy = resolveConversationPolicy();
  const safeContent = clipText(content, 1_000);
  const safeContext = clipText(conversationContext, 6_000);

  if (!safeContext) {
    return safeContent;
  }

  const marker = "Conversation context:";
  const availableForContext = Math.max(
    0,
    policy.recallQueryMaxChars - safeContent.length - marker.length - 2
  );
  const contextTail =
    safeContext.length > availableForContext
      ? safeContext.slice(-availableForContext)
      : safeContext;

  const query = `${safeContent}\n\n${marker}\n${contextTail}`.trim();
  return query.length > policy.recallQueryMaxChars
    ? query.slice(0, policy.recallQueryMaxChars)
    : query;
}

/**
 * @param {string} sessionId
 */
export function getConversationNoiseTelemetry(sessionId) {
  cleanupExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      available: false,
      noise_ratio: 0,
      redundancy_ratio: 0,
      context_half_life: 1,
      source_entropy: 0,
      contradiction_count: 0,
      contradiction_ratio: 0,
      contradictions: []
    };
  }

  const telemetry = getNoiseTelemetryState(session);
  const contradictionState = getContradictionState(session);
  const totalTurnsSeen = Math.max(
    session.turns.length,
    Math.trunc(Number(session.context[TOTAL_TURNS_KEY] ?? session.turns.length))
  );
  const retainedTurns = session.turns.length;
  const noiseRatio = telemetry.inputTokensTotal
    ? Number((telemetry.suppressedTokensTotal / telemetry.inputTokensTotal).toFixed(4))
    : 0;
  const redundancyRatio = telemetry.compactedTurnsTotal
    ? Number((telemetry.duplicateTurnsTotal / telemetry.compactedTurnsTotal).toFixed(4))
    : 0;
  const contextHalfLife = totalTurnsSeen
    ? Number((retainedTurns / totalTurnsSeen).toFixed(4))
    : 1;
  const sourceEntropy = telemetry.samples
    ? Number((telemetry.entropyTotal / telemetry.samples).toFixed(4))
    : 0;
  const contradictionCount = contradictionState.items.length;
  const contradictionRatio = totalTurnsSeen
    ? Number((contradictionCount / totalTurnsSeen).toFixed(4))
    : 0;

  return {
    available: telemetry.samples > 0,
    samples: telemetry.samples,
    compacted_turns: telemetry.compactedTurnsTotal,
    input_tokens: telemetry.inputTokensTotal,
    output_tokens: telemetry.outputTokensTotal,
    suppressed_tokens: telemetry.suppressedTokensTotal,
    duplicate_turns: telemetry.duplicateTurnsTotal,
    retained_turns: retainedTurns,
    total_turns_seen: totalTurnsSeen,
    noise_ratio: noiseRatio,
    redundancy_ratio: redundancyRatio,
    context_half_life: contextHalfLife,
    source_entropy: sourceEntropy,
    contradiction_count: contradictionCount,
    contradiction_ratio: contradictionRatio,
    contradictions: contradictionState.items,
    last: telemetry.last
  };
}

/**
 * @param {string} [project]
 * @returns {ConversationSession[]}
 */
export function listSessions(project) {
  cleanupExpiredSessions();
  const all = [...sessions.values()];
  if (!project) return all;
  return all.filter((s) => s.project === project);
}

/**
 * @param {string} sessionId
 * @returns {boolean}
 */
export function deleteSession(sessionId) {
  const deleted = sessions.delete(sessionId);
  if (deleted) {
    invalidateSessionContextCache(sessionId);
  }
  return deleted;
}

export function resetAllSessions() {
  sessions.clear();
  contextCache.clear();
  cachedPolicy = null;
  cachedPolicyEnv = "";
  policyCacheHits = 0;
  policyRecomputations = 0;
  contextCacheHits = 0;
  contextComputations = 0;
}

/**
 * Test/diagnostic helper for context memoization.
 */
export function getConversationMemoizationStats() {
  return {
    policy: {
      cacheHits: policyCacheHits,
      recomputations: policyRecomputations,
      hasCachedPolicy: Boolean(cachedPolicy)
    },
    context: {
      cacheHits: contextCacheHits,
      computations: contextComputations,
      cacheSize: contextCache.size,
      maxCacheSize: MAX_CONTEXT_CACHE_SIZE
    }
  };
}

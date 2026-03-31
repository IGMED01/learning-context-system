/**
 * Conversation Manager — multi-turn session state.
 *
 * Maintains conversation history per session, accumulating
 * context across turns. Each session has:
 *   - A list of turns (user/system messages)
 *   - Accumulated context (e.g., recalled chunks, guard results)
 *   - Project scope
 *
 * Sessions are stored in-memory for the API server lifetime.
 * For persistence, sessions can be serialized to the memory store.
 */

import type { ConversationSession, ConversationTurn } from "../types/core-contracts.d.ts";

import { randomUUID } from "node:crypto";

// ── Session Store ────────────────────────────────────────────────────

const sessions = new Map<string, ConversationSession>();
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

function parseIntEnv(raw: string | undefined, fallback: number, opts: { min?: number, max?: number } = {}) {
  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const value = Math.trunc(parsed);
  const min = opts.min ?? Number.MIN_SAFE_INTEGER;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(min, value));
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
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

function resolveConversationPolicy() {
  return {
    sessionTtlMs: parseIntEnv(process.env.LCS_CONVERSATION_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS, {
      min: 0,
      max: 30 * 24 * 60 * 60 * 1000
    }),
    maxTurns: parseIntEnv(process.env.LCS_CONVERSATION_MAX_TURNS, DEFAULT_MAX_TURNS, {
      min: 1,
      max: 1_000
    }),
    summaryEvery: parseIntEnv(process.env.LCS_CONVERSATION_SUMMARY_EVERY, DEFAULT_SUMMARY_EVERY, {
      min: 0,
      max: 500
    }),
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
}

function normalizeText(value: string) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function estimateTokens(value: string): number {
  const normalized = normalizeText(value);
  if (!normalized) {
    return 0;
  }

  return Math.max(1, Math.ceil(normalized.length / 4));
}

function countDuplicateTurns(turns: ConversationTurn[]): number {
  const seen = new Set<string>();
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

function computeRoleEntropy(turns: ConversationTurn[]): number {
  if (!turns.length) {
    return 0;
  }

  const counts: Record<string, number> = {};

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

function getNoiseTelemetryState(session: ConversationSession) {
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

function updateNoiseTelemetryState(
  session: ConversationSession,
  event: {
    compactedTurns: number;
    inputTokens: number;
    outputTokens: number;
    duplicateTurns: number;
    sourceEntropy: number;
  }
) {
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

function clipText(value: string, maxChars: number) {
  const normalized = normalizeText(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function normalizeTimeUnit(unit: string): string {
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

function tokenizeContradictionText(text: string): string[] {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
}

function normalizeContradictionSentence(sentence: string): string {
  return normalizeText(sentence)
    .replace(/^[-*]\s+/u, "")
    .replace(/^\[[^\]]+\]\s+/u, "");
}

function extractNumericSignal(text: string): { value: number | null, unit: string } {
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
    unit: normalizeTimeUnit(match[2] ?? "")
  };
}

type ContradictionClaim = {
  key: string;
  polarity: -1 | 0 | 1;
  numericValue: number | null;
  numericUnit: string;
  sentence: string;
  source: "summary" | "recent";
};

function buildContradictionClaim(
  sentence: string,
  source: "summary" | "recent"
): ContradictionClaim | null {
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

type ContradictionItem = {
  key: string;
  kind: "polarity" | "numeric";
  summary: string;
  recent: string;
};

function detectSummaryContradictions(
  summary: string,
  recentTurns: ConversationTurn[],
  maxItems: number
): ContradictionItem[] {
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
    .filter((claim): claim is ContradictionClaim => Boolean(claim));
  const recentClaims = recentSentences
    .map((sentence) => buildContradictionClaim(sentence, "recent"))
    .filter((claim): claim is ContradictionClaim => Boolean(claim));

  if (!summaryClaims.length || !recentClaims.length) {
    return [];
  }

  const dedupe = new Set<string>();
  const contradictions: ContradictionItem[] = [];

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

      const kind: "polarity" | "numeric" = polarityConflict ? "polarity" : "numeric";
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

function getContradictionState(session: ConversationSession): {
  count: number;
  updatedAt: string;
  items: ContradictionItem[];
} {
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

function updateContradictionState(session: ConversationSession): void {
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

function getSummary(session: ConversationSession) {
  const value = session.context?.[SUMMARY_KEY];
  return typeof value === "string" ? value : "";
}

function setSummary(session: ConversationSession, summary: string) {
  session.context[SUMMARY_KEY] = summary;
}

function appendSummaryFromTurns(session: ConversationSession, turns: ConversationTurn[]) {
  if (!turns.length) {
    return;
  }

  const previous = getSummary(session);
  const rawCompactText = turns.map((turn) => `[${turn.role}] ${turn.content}`).join("\n");
  const dedupKeys = new Set<string>();
  const lines: string[] = [];

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

  setSummary(session, next.slice(-8_000));
  updateNoiseTelemetryState(session, {
    compactedTurns: turns.length,
    inputTokens,
    outputTokens,
    duplicateTurns,
    sourceEntropy
  });
}

function pruneTurnsIntoSummary(session: ConversationSession, count: number) {
  const safeCount = Math.max(0, Math.min(count, session.turns.length));
  if (safeCount === 0) {
    return;
  }

  const turnsToSummarize = session.turns.slice(0, safeCount);
  appendSummaryFromTurns(session, turnsToSummarize);
  session.turns.splice(0, safeCount);
}

function applyRetentionPolicy(session: ConversationSession) {
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

export function cleanupExpiredSessions(nowMs: number = Date.now()): number {
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
      removed += 1;
    }
  }

  return removed;
}

export function createSession(project: string): ConversationSession {
  cleanupExpiredSessions();

  const session: ConversationSession = {
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

export function getSession(sessionId: string): ConversationSession | undefined {
  cleanupExpiredSessions();
  return sessions.get(sessionId);
}

export function addTurn(
  sessionId: string,
  role: "user" | "system",
  content: string,
  metadata?: Record<string, unknown>
): ConversationTurn | undefined {
  cleanupExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  const turn: ConversationTurn = {
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

  return turn;
}

export function updateContext(
  sessionId: string,
  key: string,
  value: unknown
): boolean {
  cleanupExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.context[key] = value;
  session.updatedAt = new Date().toISOString();
  return true;
}

/**
 * Build a summary of the conversation for injection into recall/teach.
 * Returns the last N turns concatenated as context.
 */
export function buildConversationContext(
  sessionId: string,
  maxTurns: number = 10
): string {
  cleanupExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) return "";

  const policy = resolveConversationPolicy();
  const safeMaxTurns = Math.max(1, Math.trunc(maxTurns));
  const recentTurns = session.turns.slice(-safeMaxTurns);
  const summary = getSummary(session);
  const contradictionState = getContradictionState(session);
  const sections: string[] = [];

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
  return context.length > policy.contextMaxChars
    ? context.slice(-policy.contextMaxChars)
    : context;
}

export function buildConversationRecallQuery(content: string, conversationContext: string): string {
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

export function getConversationNoiseTelemetry(sessionId: string) {
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

export function listSessions(project?: string): ConversationSession[] {
  cleanupExpiredSessions();
  const all = [...sessions.values()];
  if (!project) return all;
  return all.filter((s) => s.project === project);
}

export function deleteSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

export function resetAllSessions(): void {
  sessions.clear();
}

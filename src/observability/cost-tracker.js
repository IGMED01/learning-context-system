// @ts-check

import path from "node:path";
import { atomicWrite, readFile } from "../integrations/fs-safe.js";

const MODEL_SHORT_NAMES = {
  "claude-opus-4-6": "opus-4-6",
  "claude-sonnet-4-6": "sonnet-4-6",
  "claude-haiku-4-5-20251001": "haiku-4-5",
  "gpt-4o": "gpt-4o",
  "gpt-4o-mini": "gpt-4o-mini",
  "llama-3.3-70b-versatile": "llama-3.3-70b",
  "mixtral-8x7b-32768": "mixtral-8x7b"
};

/** @type {Map<string, {
 *   sessionId: string,
 *   totalCostUSD: number,
 *   totalDurationMs: number,
 *   modelUsage: Record<string, {
 *     modelId: string,
 *     provider: string,
 *     inputTokens: number,
 *     outputTokens: number,
 *     cacheReadTokens: number,
 *     cacheWriteTokens: number,
 *     costUSD: number,
 *     calls: number
 *   }>
 * }>} */
const sessions = new Map();

/**
 * @param {unknown} value
 */
function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @param {unknown} value
 */
function asPositiveNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, numeric);
}

/**
 * @param {string} modelId
 */
function getShortName(modelId) {
  const normalized = asText(modelId);
  if (!normalized) {
    return "unknown-model";
  }

  return MODEL_SHORT_NAMES[normalized] ?? normalized.split("/").pop() ?? normalized;
}

/**
 * @param {string} sessionId
 */
export function initSession(sessionId) {
  const id = asText(sessionId);
  if (!id) {
    return null;
  }

  if (!sessions.has(id)) {
    sessions.set(id, {
      sessionId: id,
      totalCostUSD: 0,
      totalDurationMs: 0,
      modelUsage: {}
    });
  }

  return sessions.get(id) ?? null;
}

/**
 * @param {string} sessionId
 * @param {{
 *   modelId?: string,
 *   provider?: string,
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   cacheReadTokens?: number,
 *   cacheWriteTokens?: number,
 *   costUSD?: number,
 *   durationMs?: number
 * }} usage
 */
export function recordUsage(sessionId, usage) {
  const session = initSession(sessionId);
  if (!session) {
    return null;
  }

  const modelId = asText(usage.modelId) || "unknown-model";
  const provider = asText(usage.provider) || "unknown-provider";
  const key = getShortName(modelId);
  const inputTokens = asPositiveNumber(usage.inputTokens);
  const outputTokens = asPositiveNumber(usage.outputTokens);
  const cacheReadTokens = asPositiveNumber(usage.cacheReadTokens);
  const cacheWriteTokens = asPositiveNumber(usage.cacheWriteTokens);
  const costUSD = asPositiveNumber(usage.costUSD);
  const durationMs = asPositiveNumber(usage.durationMs);
  const current = session.modelUsage[key] ?? {
    modelId,
    provider,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUSD: 0,
    calls: 0
  };

  current.inputTokens += inputTokens;
  current.outputTokens += outputTokens;
  current.cacheReadTokens += cacheReadTokens;
  current.cacheWriteTokens += cacheWriteTokens;
  current.costUSD += costUSD;
  current.calls += 1;

  session.modelUsage[key] = current;
  session.totalCostUSD += costUSD;
  session.totalDurationMs += durationMs;

  return session;
}

/**
 * @param {string} sessionId
 */
export function getSessionCosts(sessionId) {
  const id = asText(sessionId);
  return id ? sessions.get(id) ?? null : null;
}

/**
 * @param {string} sessionId
 */
export function formatSessionCosts(sessionId) {
  const session = getSessionCosts(sessionId);
  if (!session) {
    return "No cost data";
  }

  const lines = [
    `Session cost: $${session.totalCostUSD.toFixed(6)} (${Math.trunc(session.totalDurationMs)}ms total)`
  ];

  for (const [name, usage] of Object.entries(session.modelUsage)) {
    lines.push(
      `${name} [${usage.provider}] in=${Math.trunc(usage.inputTokens)} out=${Math.trunc(usage.outputTokens)} ` +
      `cache_r=${Math.trunc(usage.cacheReadTokens)} cache_w=${Math.trunc(usage.cacheWriteTokens)} ` +
      `calls=${Math.trunc(usage.calls)} cost=$${usage.costUSD.toFixed(6)}`
    );
  }

  return lines.join("\n");
}

/**
 * @param {string} sessionId
 * @param {string} cwd
 */
export async function saveSessionCosts(sessionId, cwd) {
  const session = getSessionCosts(sessionId);
  if (!session) {
    return null;
  }

  const targetPath = path.join(path.resolve(cwd || process.cwd()), ".lcs", "costs", `${session.sessionId}.json`);
  await atomicWrite(targetPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  return targetPath;
}

/**
 * @param {string} sessionId
 * @param {string} cwd
 */
export async function restoreSessionCosts(sessionId, cwd) {
  const id = asText(sessionId);
  if (!id) {
    return null;
  }

  if (sessions.has(id)) {
    return sessions.get(id) ?? null;
  }

  const targetPath = path.join(path.resolve(cwd || process.cwd()), ".lcs", "costs", `${id}.json`);

  try {
    const raw = await readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.sessionId !== id) {
      return null;
    }

    const record = /** @type {Record<string, unknown>} */ (parsed);
    const modelUsage =
      record.modelUsage && typeof record.modelUsage === "object" && !Array.isArray(record.modelUsage)
        ? /** @type {Record<string, unknown>} */ (record.modelUsage)
        : {};
    /** @type {Record<string, {
     *   modelId: string,
     *   provider: string,
     *   inputTokens: number,
     *   outputTokens: number,
     *   cacheReadTokens: number,
     *   cacheWriteTokens: number,
     *   costUSD: number,
     *   calls: number
     * }>} */
    const normalizedUsage = {};

    for (const [name, value] of Object.entries(modelUsage)) {
      const usage = value && typeof value === "object" && !Array.isArray(value)
        ? /** @type {Record<string, unknown>} */ (value)
        : {};
      normalizedUsage[name] = {
        modelId: asText(usage.modelId) || name,
        provider: asText(usage.provider) || "unknown-provider",
        inputTokens: asPositiveNumber(usage.inputTokens),
        outputTokens: asPositiveNumber(usage.outputTokens),
        cacheReadTokens: asPositiveNumber(usage.cacheReadTokens),
        cacheWriteTokens: asPositiveNumber(usage.cacheWriteTokens),
        costUSD: asPositiveNumber(usage.costUSD),
        calls: Math.max(0, Math.trunc(asPositiveNumber(usage.calls)))
      };
    }

    const session = {
      sessionId: id,
      totalCostUSD: asPositiveNumber(record.totalCostUSD),
      totalDurationMs: asPositiveNumber(record.totalDurationMs),
      modelUsage: normalizedUsage
    };
    sessions.set(id, session);
    return session;
  } catch {
    return null;
  }
}

/**
 * @param {string} sessionId
 */
export function endSession(sessionId) {
  const id = asText(sessionId);
  if (!id) {
    return false;
  }

  return sessions.delete(id);
}

/**
 * Test utility: clears all tracked sessions.
 */
export function clearCostSessions() {
  sessions.clear();
}


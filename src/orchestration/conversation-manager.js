// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").ConversationSession} ConversationSession
 * @typedef {import("../types/core-contracts.d.ts").ConversationTurn} ConversationTurn
 */

import { randomUUID } from "node:crypto";

/** @type {Map<string, ConversationSession>} */
const sessions = new Map();

/**
 * @param {string} project
 * @returns {ConversationSession}
 */
export function createSession(project) {
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
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  /** @type {ConversationTurn} */
  const turn = {
    role,
    content,
    timestamp: new Date().toISOString(),
    metadata
  };

  session.turns.push(turn);
  session.updatedAt = turn.timestamp;

  return turn;
}

/**
 * @param {string} sessionId
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
export function updateContext(sessionId, key, value) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.context[key] = value;
  session.updatedAt = new Date().toISOString();
  return true;
}

/**
 * @param {string} sessionId
 * @param {number} [maxTurns]
 * @returns {string}
 */
export function buildConversationContext(sessionId, maxTurns = 10) {
  const session = sessions.get(sessionId);
  if (!session || session.turns.length === 0) return "";

  const recentTurns = session.turns.slice(-maxTurns);

  return recentTurns
    .map((t) => `[${t.role}] ${t.content}`)
    .join("\n");
}

/**
 * @param {string} [project]
 * @returns {ConversationSession[]}
 */
export function listSessions(project) {
  const all = [...sessions.values()];
  if (!project) return all;
  return all.filter((s) => s.project === project);
}

/**
 * @param {string} sessionId
 * @returns {boolean}
 */
export function deleteSession(sessionId) {
  return sessions.delete(sessionId);
}

export function resetAllSessions() {
  sessions.clear();
}

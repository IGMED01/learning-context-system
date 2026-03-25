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

export function createSession(project: string): ConversationSession {
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
  return sessions.get(sessionId);
}

export function addTurn(
  sessionId: string,
  role: "user" | "system",
  content: string,
  metadata?: Record<string, unknown>
): ConversationTurn | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  const turn: ConversationTurn = {
    role,
    content,
    timestamp: new Date().toISOString(),
    metadata
  };

  session.turns.push(turn);
  session.updatedAt = turn.timestamp;

  return turn;
}

export function updateContext(
  sessionId: string,
  key: string,
  value: unknown
): boolean {
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
  const session = sessions.get(sessionId);
  if (!session || session.turns.length === 0) return "";

  const recentTurns = session.turns.slice(-maxTurns);

  return recentTurns
    .map((t) => `[${t.role}] ${t.content}`)
    .join("\n");
}

export function listSessions(project?: string): ConversationSession[] {
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

// @ts-check

import { randomBytes } from "node:crypto";

export const TASK_TYPES = Object.freeze({
  AGENT: "agent",
  GATE: "gate",
  REPAIR: "repair",
  WORKFLOW: "workflow",
  MITOSIS: "mitosis",
  INGEST: "ingest"
});

export const TASK_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

const ID_PREFIXES = Object.freeze({
  [TASK_TYPES.AGENT]: "a",
  [TASK_TYPES.GATE]: "g",
  [TASK_TYPES.REPAIR]: "r",
  [TASK_TYPES.WORKFLOW]: "w",
  [TASK_TYPES.MITOSIS]: "m",
  [TASK_TYPES.INGEST]: "i"
});

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * @typedef {{
 *   id: string,
 *   type: string,
 *   status: string,
 *   description: string,
 *   createdAt: string,
 *   updatedAt: string,
 *   startedAt?: string,
 *   endedAt?: string,
 *   error?: string,
 *   metadata: Record<string, unknown>,
 *   abortController: AbortController
 * }} Task
 */

/** @type {Map<string, Task>} */
const tasks = new Map();
let cleanupInterval = null;

function ensureCleanupScheduled() {
  if (cleanupInterval) {
    return;
  }

  cleanupInterval = setInterval(() => {
    cleanupExpiredTasks(3_600_000);
  }, 600_000);
  cleanupInterval.unref();
}

/**
 * @param {string} type
 */
function generateTaskId(type) {
  const prefix = ID_PREFIXES[type] ?? "x";
  const bytes = randomBytes(5);
  const random = Array.from(bytes)
    .map((value) => ALPHABET[value % ALPHABET.length])
    .join("");
  return `${prefix}${random}`;
}

/**
 * @param {string} status
 */
export function isTerminal(status) {
  return (
    status === TASK_STATUS.COMPLETED ||
    status === TASK_STATUS.FAILED ||
    status === TASK_STATUS.CANCELLED
  );
}

/**
 * @param {string} type
 * @param {string} description
 * @param {Record<string, unknown>} [metadata]
 * @returns {Task}
 */
export function createTask(type, description, metadata = {}) {
  ensureCleanupScheduled();
  const now = new Date().toISOString();
  const task = {
    id: generateTaskId(type),
    type: String(type ?? "").trim() || TASK_TYPES.WORKFLOW,
    status: TASK_STATUS.PENDING,
    description: String(description ?? "").slice(0, 500),
    createdAt: now,
    updatedAt: now,
    metadata: { ...metadata },
    abortController: new AbortController()
  };
  tasks.set(task.id, task);
  return task;
}

/**
 * @param {string} id
 * @returns {Task | undefined}
 */
export function getTask(id) {
  return tasks.get(id);
}

export function getAllTasks() {
  return [...tasks.values()];
}

/**
 * @param {string} status
 */
export function getTasksByStatus(status) {
  return getAllTasks().filter((task) => task.status === status);
}

/**
 * @param {string} id
 * @param {string} status
 * @param {unknown} [error]
 */
export function updateTaskStatus(id, status, error) {
  const task = tasks.get(id);
  if (!task) {
    return false;
  }

  task.status = status;
  task.updatedAt = new Date().toISOString();
  if (status === TASK_STATUS.RUNNING && !task.startedAt) {
    task.startedAt = task.updatedAt;
  }
  if (isTerminal(status) && !task.endedAt) {
    task.endedAt = task.updatedAt;
  }
  if (error !== undefined && error !== null) {
    task.error = String(error).slice(0, 2_000);
  }
  return true;
}

/**
 * @param {string} id
 */
export function cancelTask(id) {
  const task = tasks.get(id);
  if (!task || isTerminal(task.status)) {
    return false;
  }

  task.abortController.abort();
  updateTaskStatus(id, TASK_STATUS.CANCELLED);
  return true;
}

/**
 * @param {number} [maxAgeMs]
 */
export function cleanupExpiredTasks(maxAgeMs = 3_600_000) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  for (const [id, task] of tasks.entries()) {
    const endedAt = task.endedAt ? Date.parse(task.endedAt) : Number.NaN;
    if (isTerminal(task.status) && Number.isFinite(endedAt) && endedAt < cutoff) {
      tasks.delete(id);
      removed += 1;
    }
  }

  return removed;
}

/**
 * @param {Task} task
 */
export function serializeTask(task) {
  const { abortController, ...rest } = task;
  return rest;
}

/**
 * Test utility: reset in-memory tasks.
 */
export function clearTaskStore() {
  tasks.clear();
}

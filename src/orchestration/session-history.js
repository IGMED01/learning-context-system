// @ts-check

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_HISTORY_DIR = ".lcs/session-history";
const DEFAULT_INLINE_CONTENT_BYTES = 1024;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [opts]
 */
function parsePositiveInteger(value, fallback, opts = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const normalized = Math.trunc(numeric);
  const min = opts.min ?? 1;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  if (normalized < min || normalized > max) {
    return fallback;
  }

  return normalized;
}

/**
 * @param {string} sessionId
 */
function safeSessionSlug(sessionId) {
  return String(sessionId ?? "")
    .trim()
    .replace(/[^a-z0-9_-]+/giu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "") || "session";
}

/**
 * @param {string} value
 */
function toHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @typedef {{
 *   role: "user" | "system",
 *   content: string,
 *   timestamp: string,
 *   metadata?: Record<string, unknown>
 * }} SessionHistoryTurn
 */

/**
 * @typedef {{
 *   v: number,
 *   sessionId: string,
 *   role: "user" | "system",
 *   timestamp: string,
 *   content?: string,
 *   contentHash?: string,
 *   contentBytes: number,
 *   contentPreview?: string,
 *   metadata?: Record<string, unknown>
 * }} SessionHistoryRecord
 */

/**
 * @param {string} historyDir
 * @param {string} sessionId
 */
function sessionFilePath(historyDir, sessionId) {
  return path.join(historyDir, `${safeSessionSlug(sessionId)}.jsonl`);
}

/**
 * @param {string} historyDir
 * @param {string} contentHash
 */
function blobFilePath(historyDir, contentHash) {
  return path.join(historyDir, "blobs", `${contentHash}.txt`);
}

/**
 * @param {string} value
 * @param {number} maxChars
 */
function preview(value, maxChars = 220) {
  const compact = String(value ?? "").replace(/\s+/gu, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact;
}

/**
 * @param {SessionHistoryRecord} record
 */
function toTurn(record) {
  return {
    role: record.role,
    content: typeof record.content === "string" ? record.content : record.contentPreview ?? "",
    timestamp: record.timestamp,
    metadata: record.metadata
  };
}

/**
 * @param {{
 *   cwd?: string,
 *   historyDir?: string,
 *   inlineContentBytes?: number,
 *   maxLineBytes?: number
 * }} [options]
 */
export function createSessionHistoryStore(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const historyDir = path.resolve(cwd, options.historyDir ?? process.env.LCS_SESSION_HISTORY_DIR ?? DEFAULT_HISTORY_DIR);
  const inlineContentBytes = parsePositiveInteger(
    options.inlineContentBytes ?? process.env.LCS_SESSION_HISTORY_INLINE_BYTES,
    DEFAULT_INLINE_CONTENT_BYTES,
    { min: 64, max: 16 * 1024 }
  );
  const maxLineBytes = parsePositiveInteger(
    options.maxLineBytes ?? process.env.LCS_SESSION_HISTORY_MAX_LINE_BYTES,
    DEFAULT_MAX_LINE_BYTES,
    { min: 512, max: 512 * 1024 }
  );

  /** @type {Map<string, Promise<void>>} */
  const appendQueue = new Map();

  /**
   * @param {string} sessionId
   * @param {SessionHistoryTurn} turn
   * @returns {Promise<void>}
   */
  async function appendTurn(sessionId, turn) {
    const filePath = sessionFilePath(historyDir, sessionId);
    const content = String(turn.content ?? "");
    const contentBytes = Buffer.byteLength(content, "utf8");
    /** @type {SessionHistoryRecord} */
    const record = {
      v: 1,
      sessionId,
      role: turn.role,
      timestamp: turn.timestamp,
      contentBytes,
      metadata: turn.metadata
    };

    await mkdir(path.dirname(filePath), { recursive: true });

    if (contentBytes <= inlineContentBytes) {
      record.content = content;
    } else {
      const contentHash = toHash(content);
      const blobPath = blobFilePath(historyDir, contentHash);
      record.contentHash = contentHash;
      record.contentPreview = preview(content);

      await mkdir(path.dirname(blobPath), { recursive: true });
      try {
        const existing = await stat(blobPath);
        if (!existing.isFile() || existing.size === 0) {
          await writeFile(blobPath, content, "utf8");
        }
      } catch {
        await writeFile(blobPath, content, "utf8");
      }
    }

    const rawLine = JSON.stringify(record);
    const line = Buffer.byteLength(rawLine, "utf8") > maxLineBytes
      ? JSON.stringify({
          ...record,
          metadata: undefined,
          content: undefined,
          contentPreview: preview(content, 160),
          contentHash: record.contentHash || toHash(content)
        })
      : rawLine;

    await appendFile(filePath, `${line}\n`, "utf8");
  }

  /**
   * @param {string} sessionId
   * @param {SessionHistoryTurn} turn
   */
  function enqueueTurn(sessionId, turn) {
    const key = safeSessionSlug(sessionId);
    const previous = appendQueue.get(key) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => appendTurn(sessionId, turn));
    appendQueue.set(key, pending);
    return pending.finally(() => {
      if (appendQueue.get(key) === pending) {
        appendQueue.delete(key);
      }
    });
  }

  /**
   * @param {SessionHistoryRecord} record
   * @returns {Promise<SessionHistoryTurn>}
   */
  async function hydrateRecord(record) {
    if (typeof record.content === "string") {
      return toTurn(record);
    }

    if (typeof record.contentHash !== "string" || !record.contentHash) {
      return toTurn(record);
    }

    const blobPath = blobFilePath(historyDir, record.contentHash);
    try {
      const content = await readFile(blobPath, "utf8");
      return {
        ...toTurn(record),
        content
      };
    } catch {
      return toTurn(record);
    }
  }

  /**
   * @param {string} sessionId
   * @param {number} [limit]
   * @returns {Promise<SessionHistoryTurn[]>}
   */
  async function loadRecent(sessionId, limit = 40) {
    const filePath = sessionFilePath(historyDir, sessionId);
    const safeLimit = parsePositiveInteger(limit, 40, { min: 1, max: 2_000 });

    let raw = "";
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }

    const lines = raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const selectedLines = lines.slice(-safeLimit);
    /** @type {SessionHistoryRecord[]} */
    const records = [];

    for (const line of selectedLines) {
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object") {
          continue;
        }
        const candidate = /** @type {Record<string, unknown>} */ (parsed);
        if (
          (candidate.role !== "user" && candidate.role !== "system") ||
          typeof candidate.timestamp !== "string"
        ) {
          continue;
        }

        records.push({
          v: 1,
          sessionId: String(candidate.sessionId ?? sessionId),
          role: candidate.role,
          timestamp: candidate.timestamp,
          content: typeof candidate.content === "string" ? candidate.content : undefined,
          contentHash:
            typeof candidate.contentHash === "string" ? candidate.contentHash : undefined,
          contentBytes: parsePositiveInteger(candidate.contentBytes, 0, { min: 0 }),
          contentPreview:
            typeof candidate.contentPreview === "string" ? candidate.contentPreview : undefined,
          metadata:
            candidate.metadata && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata)
              ? /** @type {Record<string, unknown>} */ (candidate.metadata)
              : undefined
        });
      } catch {
        // skip malformed line
      }
    }

    return Promise.all(records.map((record) => hydrateRecord(record)));
  }

  /**
   * @param {string} sessionId
   */
  async function flush(sessionId) {
    const key = safeSessionSlug(sessionId);
    const pending = appendQueue.get(key);
    if (pending) {
      await pending.catch(() => undefined);
    }
  }

  return {
    config: {
      cwd,
      historyDir,
      inlineContentBytes,
      maxLineBytes
    },
    enqueueTurn,
    loadRecent,
    flush
  };
}


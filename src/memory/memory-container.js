// @ts-check

/**
 * memory-container.js — NEXUS Project-Scoped Memory Containers
 *
 * Provides isolated memory namespaces per project, with optional TTL
 * on individual entries.  Designed as a thin wrapper over the
 * local-memory-store persistence layer.
 *
 * Key capabilities:
 *   • Each project gets its own container (`.lcs/memory/<slug>/`)
 *   • Per-entry TTL: `expiresAt` ISO timestamp — ignored once past
 *   • Bulk TTL purge: `container.purgeExpired()` — called by `lcs doctor`
 *   • Cross-container search: `MemoryContainerRegistry.searchAll()`
 *   • Zero external deps — pure Node.js fs + json
 *
 * Storage layout (unchanged from local-memory-store):
 *   .lcs/memory/<project-slug>/memories.jsonl
 *
 * TTL contract:
 *   - `save({ ..., ttlMs: 3600000 })` writes `expiresAt` as ISO string
 *   - `search/list` silently filters expired entries at read time
 *   - `purgeExpired()` rewrites the file without expired entries
 */

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  slugify,
  compactText,
  tokenize,
  makeTimestampId,
  toErrorMessage
} from "../utils/text-utils.js";

/** @typedef {import("../types/core-contracts.d.ts").MemoryEntry} MemoryEntry */
/** @typedef {import("../types/core-contracts.d.ts").MemorySaveInput} MemorySaveInput */
/** @typedef {import("../types/core-contracts.d.ts").MemorySearchOptions} MemorySearchOptions */
/** @typedef {import("../types/core-contracts.d.ts").MemorySearchResult} MemorySearchResult */
/** @typedef {import("../types/core-contracts.d.ts").MemorySaveResult} MemorySaveResult */
/** @typedef {import("../types/core-contracts.d.ts").MemoryHealthResult} MemoryHealthResult */

/**
 * @typedef {{
 *   title: string,
 *   content: string,
 *   type?: string,
 *   scope?: string,
 *   topic?: string,
 *   ttlMs?: number,
 *   expiresAt?: string,
 *   sourceKind?: string,
 *   reviewStatus?: string,
 *   protected?: boolean
 * }} ContainerSaveInput
 */

/**
 * @typedef {{
 *   purged: number,
 *   remaining: number,
 *   durationMs: number
 * }} PurgeResult
 */

/**
 * @typedef {{
 *   project: string,
 *   slug: string,
 *   filePath: string,
 *   baseDir: string,
 *   cwd: string
 * }} ContainerConfig
 */

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * @param {string} baseDir
 * @param {string} projectSlug
 * @returns {string}
 */
function containerFilePath(baseDir, projectSlug) {
  return path.join(baseDir, projectSlug, "memories.jsonl");
}

/**
 * Check whether a memory entry is expired relative to `now`.
 * Entries without `expiresAt` never expire.
 *
 * @param {MemoryEntry | (MemoryEntry & { expiresAt?: string })} entry
 * @param {number} [nowMs] - Current time in ms (defaults to Date.now())
 * @returns {boolean}
 */
function isExpired(entry, nowMs) {
  const expires = /** @type {any} */ (entry).expiresAt;
  if (typeof expires !== "string" || !expires) return false;
  const expireTime = new Date(expires).getTime();
  if (Number.isNaN(expireTime)) return false;
  return (nowMs ?? Date.now()) > expireTime;
}

/**
 * @param {string} filePath
 * @returns {Promise<MemoryEntry[]>}
 */
async function readEntries(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    /** @type {MemoryEntry[]} */
    const entries = [];

    for (const line of raw.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const rec = /** @type {Record<string, unknown>} */ (parsed);
          entries.push({
            id: typeof rec.id === "string" ? rec.id : makeTimestampId("entry"),
            title: typeof rec.title === "string" ? rec.title : "Untitled",
            content: typeof rec.content === "string" ? rec.content : "",
            type: typeof rec.type === "string" ? rec.type : "learning",
            project: typeof rec.project === "string" ? rec.project : "",
            scope: typeof rec.scope === "string" ? rec.scope : "project",
            topic: typeof rec.topic === "string" ? rec.topic : "",
            createdAt: typeof rec.createdAt === "string" ? rec.createdAt : new Date().toISOString(),
            // Preserve hygiene + TTL fields
            ...(typeof rec.expiresAt === "string" && rec.expiresAt ? { expiresAt: rec.expiresAt } : {}),
            ...(typeof rec.sourceKind === "string" ? { sourceKind: rec.sourceKind } : {}),
            ...(typeof rec.reviewStatus === "string" ? { reviewStatus: rec.reviewStatus } : {}),
            ...(typeof rec.protected === "boolean" ? { protected: rec.protected } : {})
          });
        }
      } catch {
        // skip malformed lines
      }
    }

    return entries;
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * @param {string} filePath
 * @param {MemoryEntry[]} entries
 * @returns {Promise<void>}
 */
async function writeEntries(filePath, entries) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e));
  await writeFile(filePath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
}

// ── TF-IDF search (local, no external dep) ────────────────────────────

/**
 * Simple TF-IDF scoring for container search.
 * @param {MemoryEntry[]} entries
 * @param {string} query
 * @param {number} limit
 * @returns {MemoryEntry[]}
 */
function tfidfSearch(entries, query, limit) {
  const qTerms = tokenize(query);
  if (!qTerms.length) {
    return entries.slice(0, limit);
  }

  /** @type {Map<string, number>[]} */
  const docTFs = entries.map((e) => {
    const tokens = tokenize(`${e.title} ${e.content} ${e.type} ${e.topic}`);
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    const total = tokens.length || 1;
    /** @type {Map<string, number>} */
    const tf = new Map();
    for (const [term, cnt] of counts) tf.set(term, cnt / total);
    return tf;
  });

  const N = docTFs.length || 1;
  /** @type {Map<string, number>} */
  const idf = new Map();
  for (const term of qTerms) {
    const df = docTFs.filter((tf) => tf.has(term)).length;
    idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
  }

  /** @type {Array<{ entry: MemoryEntry, score: number }>} */
  const scored = [];
  for (let i = 0; i < entries.length; i++) {
    let score = 0;
    for (const term of qTerms) {
      score += (docTFs[i].get(term) ?? 0) * (idf.get(term) ?? 1);
    }
    if (score > 0) scored.push({ entry: entries[i], score });
  }

  scored.sort((a, b) => {
    const diff = b.score - a.score;
    return Math.abs(diff) > 0.001 ? diff : b.entry.createdAt.localeCompare(a.entry.createdAt);
  });

  return scored.slice(0, limit).map((s) => s.entry);
}

// ── MemoryContainer ────────────────────────────────────────────────────

/**
 * Create a project-scoped memory container.
 *
 * @param {{
 *   project: string,
 *   cwd?: string,
 *   baseDir?: string
 * }} opts
 */
export function createMemoryContainer(opts) {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const baseDir = path.resolve(cwd, opts.baseDir ?? ".lcs/memory");
  const projectSlug = slugify(opts.project, { fallback: "_default" });
  const filePath = containerFilePath(baseDir, projectSlug);

  /** @type {ContainerConfig} */
  const config = { project: opts.project, slug: projectSlug, filePath, baseDir, cwd };

  // ── read (filters expired at read time) ──

  /**
   * @param {number} [nowMs]
   * @returns {Promise<MemoryEntry[]>}
   */
  async function readLive(nowMs) {
    const all = await readEntries(filePath);
    return all.filter((e) => !isExpired(e, nowMs));
  }

  // ── search ──

  /**
   * @param {string} query
   * @param {{ limit?: number, type?: string, scope?: string }} [options]
   * @returns {Promise<MemorySearchResult>}
   */
  async function search(query, options = {}) {
    const live = await readLive();
    const filtered = live.filter((e) => {
      if (options.type && e.type !== options.type) return false;
      if (options.scope && e.scope !== options.scope) return false;
      return true;
    });

    const limit = Math.max(1, options.limit ?? 10);
    const results = tfidfSearch(filtered, query, limit);

    return {
      entries: results,
      stdout: results.length
        ? `Found ${results.length} memories in container "${opts.project}":\n` +
          results.map((e, i) => `  [${i + 1}] ${e.title} (${e.type})`).join("\n")
        : `No memories found in container "${opts.project}" for query: ${query}`,
      provider: "container"
    };
  }

  // ── save ──

  /**
   * Save a memory entry to this container.
   * Pass `ttlMs` for a time-limited entry (e.g. `ttlMs: 86400000` for 24h).
   *
   * @param {ContainerSaveInput} input
   * @returns {Promise<MemorySaveResult>}
   */
  async function save(input) {
    const live = await readLive();
    const createdAt = new Date().toISOString();
    const id = makeTimestampId(input.title);

    /** @type {MemoryEntry & { expiresAt?: string, sourceKind?: string, reviewStatus?: string, protected?: boolean }} */
    const entry = {
      id,
      title: compactText(input.title),
      content: input.content,
      type: input.type ?? "learning",
      project: opts.project,
      scope: input.scope ?? "project",
      topic: input.topic ?? "",
      createdAt
    };

    // TTL handling: prefer explicit expiresAt, else compute from ttlMs
    const explicitExpiry = input.expiresAt;
    const computedExpiry = input.ttlMs && input.ttlMs > 0
      ? new Date(Date.now() + input.ttlMs).toISOString()
      : undefined;
    const expiresAt = explicitExpiry ?? computedExpiry;
    if (expiresAt) {
      /** @type {any} */ (entry).expiresAt = expiresAt;
    }

    if (input.sourceKind) /** @type {any} */ (entry).sourceKind = input.sourceKind;
    if (input.reviewStatus) /** @type {any} */ (entry).reviewStatus = input.reviewStatus;
    if (typeof input.protected === "boolean") /** @type {any} */ (entry).protected = input.protected;

    live.push(entry);
    await writeEntries(filePath, live);

    return {
      id,
      stdout: `Saved memory #${id} to container "${opts.project}"${expiresAt ? ` (expires ${expiresAt})` : ""}`,
      provider: "container"
    };
  }

  // ── delete ──

  /**
   * @param {string} id
   * @returns {Promise<{ deleted: boolean, id: string }>}
   */
  async function deleteEntry(id) {
    const all = await readEntries(filePath);
    const filtered = all.filter((e) => e.id !== id);

    if (filtered.length < all.length) {
      await writeEntries(filePath, filtered);
      return { deleted: true, id };
    }

    return { deleted: false, id };
  }

  // ── list ──

  /**
   * @param {{ limit?: number, includeExpired?: boolean }} [options]
   * @returns {Promise<MemoryEntry[]>}
   */
  async function list(options = {}) {
    const entries = options.includeExpired
      ? await readEntries(filePath)
      : await readLive();
    const limit = options.limit ?? 50;
    return entries
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  // ── purge expired ──

  /**
   * Remove all expired entries from this container.
   * Called automatically by `lcs doctor`.
   *
   * @returns {Promise<PurgeResult>}
   */
  async function purgeExpired() {
    const start = Date.now();
    const all = await readEntries(filePath);
    const nowMs = Date.now();
    const live = all.filter((e) => !isExpired(e, nowMs));
    const purged = all.length - live.length;

    if (purged > 0) {
      await writeEntries(filePath, live);
    }

    return {
      purged,
      remaining: live.length,
      durationMs: Date.now() - start
    };
  }

  // ── health ──

  /**
   * @returns {Promise<MemoryHealthResult>}
   */
  async function health() {
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      const entries = await readEntries(filePath);
      return {
        healthy: true,
        provider: "container",
        detail: `Container "${opts.project}" (${projectSlug}): ${entries.length} total entries at ${filePath}`
      };
    } catch (err) {
      return {
        healthy: false,
        provider: "container",
        detail: `Container "${opts.project}" error: ${toErrorMessage(err)}`
      };
    }
  }

  // ── stats ──

  /**
   * Return a summary of the container (entry count, expired count, oldest, newest).
   * @returns {Promise<{
   *   total: number,
   *   live: number,
   *   expired: number,
   *   oldestAt: string | null,
   *   newestAt: string | null,
   *   project: string
   * }>}
   */
  async function stats() {
    const all = await readEntries(filePath);
    const nowMs = Date.now();
    const liveEntries = all.filter((e) => !isExpired(e, nowMs));
    const sorted = [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return {
      total: all.length,
      live: liveEntries.length,
      expired: all.length - liveEntries.length,
      oldestAt: sorted[0]?.createdAt ?? null,
      newestAt: sorted[sorted.length - 1]?.createdAt ?? null,
      project: opts.project
    };
  }

  return {
    config,
    search,
    save,
    delete: deleteEntry,
    list,
    purgeExpired,
    health,
    stats
  };
}

// ── MemoryContainerRegistry ────────────────────────────────────────────

/**
 * Registry that manages multiple project containers.
 * Use this when you need cross-project search or lifecycle management.
 *
 * @param {{
 *   cwd?: string,
 *   baseDir?: string
 * }} [opts]
 */
export function createMemoryContainerRegistry(opts = {}) {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const baseDir = path.resolve(cwd, opts.baseDir ?? ".lcs/memory");

  /** @type {Map<string, ReturnType<typeof createMemoryContainer>>} */
  const containers = new Map();

  /**
   * Get (or lazily create) a container for a project.
   * @param {string} project
   * @returns {ReturnType<typeof createMemoryContainer>}
   */
  function getContainer(project) {
    const key = slugify(project, { fallback: "_default" });

    if (!containers.has(key)) {
      containers.set(key, createMemoryContainer({ project, cwd, baseDir }));
    }

    return /** @type {ReturnType<typeof createMemoryContainer>} */ (containers.get(key));
  }

  /**
   * List all project slugs that have a container directory on disk.
   * @returns {Promise<string[]>}
   */
  async function listProjects() {
    try {
      const dirs = await readdir(baseDir, { withFileTypes: true });
      return dirs.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  }

  /**
   * Search across ALL project containers.
   * Collects top results from each container, deduplicates by id, and returns the top N by insertion order (container order = alphabetical slug).
   * For heavier cross-container ranking, call each container's search() individually and score externally.
   *
   * @param {string} query
   * @param {{ limit?: number, type?: string, scope?: string }} [options]
   * @returns {Promise<MemorySearchResult>}
   */
  async function searchAll(query, options = {}) {
    const projects = await listProjects();
    /** @type {MemoryEntry[]} */
    const allEntries = [];

    for (const slug of projects) {
      // Use slug directly as project label (containers are keyed by slug)
      const container = createMemoryContainer({ project: slug, cwd, baseDir });
      const result = await container.search(query, { ...options, limit: options.limit ?? 20 });
      allEntries.push(...result.entries);
    }

    const limit = options.limit ?? 10;
    const deduped = allEntries.filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i);
    const topN = deduped.slice(0, limit);

    return {
      entries: topN,
      stdout: topN.length
        ? `Found ${topN.length} memories across ${projects.length} containers:\n` +
          topN.map((e, i) => `  [${i + 1}] [${e.project}] ${e.title} (${e.type})`).join("\n")
        : `No memories found across ${projects.length} containers for: ${query}`,
      provider: "container-registry"
    };
  }

  /**
   * Purge expired entries across ALL containers.
   * @returns {Promise<{ totalPurged: number, byProject: Record<string, number>, durationMs: number }>}
   */
  async function purgeAllExpired() {
    const start = Date.now();
    const projects = await listProjects();
    /** @type {Record<string, number>} */
    const byProject = {};
    let totalPurged = 0;

    for (const slug of projects) {
      const container = createMemoryContainer({ project: slug, cwd, baseDir });
      const result = await container.purgeExpired();
      byProject[slug] = result.purged;
      totalPurged += result.purged;
    }

    return { totalPurged, byProject, durationMs: Date.now() - start };
  }

  /**
   * Health check across all known containers.
   * @returns {Promise<MemoryHealthResult>}
   */
  async function health() {
    const projects = await listProjects();

    return {
      healthy: true,
      provider: "container-registry",
      detail: `Container registry at ${baseDir}: ${projects.length} project(s) — ${projects.join(", ") || "none"}`
    };
  }

  return {
    getContainer,
    listProjects,
    searchAll,
    purgeAllExpired,
    health,
    baseDir,
    cwd
  };
}

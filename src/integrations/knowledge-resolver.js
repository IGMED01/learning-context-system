// @ts-check

import path from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { atomicWrite, readFile } from "./fs-safe.js";
import { createNotionProvider } from "./notion-provider.js";
import { createObsidianProvider } from "./obsidian-provider.js";
import {
  ProviderConnectionError,
  ProviderValidationError,
  ProviderWriteError,
  normalizeRetryPolicy,
  withRetry
} from "./knowledge-provider.js";
import { log } from "../core/logger.js";

const DEFAULT_SYNC_CONFIG = {
  knowledgeBackend: "local-only",
  retryPolicy: {
    maxAttempts: 3,
    backoffMs: 1_000,
    maxBackoffMs: 30_000
  },
  dlq: {
    enabled: true,
    path: ".lcs/dlq",
    ttlDays: 7
  }
};

/**
 * @param {unknown} value
 */
function asText(value) {
  return typeof value === "string" ? value.trim() : "";
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
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} value
 * @param {Partial<import("./knowledge-provider.js").KnowledgeEntry>} [fallback]
 * @returns {import("./knowledge-provider.js").KnowledgeEntry}
 */
function normalizeKnowledgeEntry(value, fallback = {}) {
  const record = asRecord(value);
  const fallbackRecord = asRecord(fallback);
  const title = asText(record.title) || asText(fallbackRecord.title) || "untitled";
  const content = asText(record.content) || asText(fallbackRecord.content);
  const project = asText(record.project) || asText(fallbackRecord.project);
  const type = asText(record.type) || asText(fallbackRecord.type) || "memories";
  const source = asText(record.source) || asText(fallbackRecord.source) || "lcs-cli";
  const createdAt = asText(record.createdAt) || asText(fallbackRecord.createdAt) || new Date().toISOString();
  const updatedAt = asText(record.updatedAt) || asText(fallbackRecord.updatedAt) || createdAt;
  const tags = asArray(record.tags).map((tag) => asText(tag)).filter(Boolean);

  return {
    id: asText(record.id) || asText(fallbackRecord.id) || `${createdAt.replace(/[-:.TZ]/gu, "")}-${slugify(title)}`,
    title,
    content,
    project,
    type,
    source,
    tags,
    createdAt,
    updatedAt,
    slug: asText(record.slug) || asText(fallbackRecord.slug) || slugify(title)
  };
}

/**
 * @param {string} value
 */
function compactLine(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * @param {string} value
 */
function slugify(value) {
  const compact = compactLine(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/(^-|-$)/gu, "");

  return compact.slice(0, 100) || "default";
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInteger(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * @param {unknown} value
 * @returns {"local-only" | "notion" | "obsidian"}
 */
function normalizeKnowledgeBackend(value) {
  const normalized = asText(value).toLowerCase();
  if (normalized === "notion" || normalized === "obsidian" || normalized === "local-only") {
    return normalized;
  }

  return "local-only";
}

/**
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * @param {{
 *   backend?: unknown,
 *   knowledgeBackend?: unknown,
 *   retryPolicy?: unknown,
 *   dlq?: unknown
 }} [input]
 */
export function resolveKnowledgeSyncConfig(input = {}) {
  const retryPolicyRaw = asRecord(input.retryPolicy);
  const dlqRaw = asRecord(input.dlq);
  const retryPolicy = normalizeRetryPolicy({
    maxAttempts: Number(retryPolicyRaw.maxAttempts),
    backoffMs: Number(retryPolicyRaw.backoffMs),
    maxBackoffMs: Number(retryPolicyRaw.maxBackoffMs)
  });

  return {
    knowledgeBackend: normalizeKnowledgeBackend(input.knowledgeBackend ?? input.backend),
    retryPolicy,
    dlq: {
      enabled: dlqRaw.enabled !== false,
      path: asText(dlqRaw.path) || DEFAULT_SYNC_CONFIG.dlq.path,
      ttlDays: clampInteger(Number(dlqRaw.ttlDays), 1, 365, DEFAULT_SYNC_CONFIG.dlq.ttlDays)
    }
  };
}

/**
 * @param {string} targetPath
 */
async function readJsonLines(targetPath) {
  try {
    const raw = await readFile(targetPath, "utf8");
    return raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
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
}

/**
 * @param {string} targetPath
 * @param {unknown[]} entries
 */
async function writeJsonLines(targetPath, entries) {
  const lines = entries.map((entry) => JSON.stringify(entry));
  await atomicWrite(targetPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
}

/**
 * @param {{
 *   cwd?: string,
 *   baseDir?: string
 }} [options]
 * @returns {import("./knowledge-provider.js").KnowledgeProvider}
 */
function createLocalKnowledgeProvider(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const baseDir = path.resolve(cwd, options.baseDir ?? ".lcs/knowledge");

  /**
   * @param {string} project
   */
  function projectFile(project) {
    return path.join(baseDir, slugify(project || "_default"), "entries.jsonl");
  }

  return {
    name: "local-only",

    /**
     * @param {import("./knowledge-provider.js").KnowledgeEntry} entry
     */
    async sync(entry) {
      const title = asText(entry.title);
      const content = asText(entry.content);
      const project = asText(entry.project);
      const source = asText(entry.source) || "lcs-cli";
      const tags = asArray(entry.tags).map((tag) => asText(tag)).filter(Boolean);
      const type = asText(entry.type) || "memories";

      if (!title) {
        throw new ProviderValidationError("Knowledge entry title is required.", {
          provider: "local-only"
        });
      }

      if (!content) {
        throw new ProviderValidationError("Knowledge entry content is required.", {
          provider: "local-only"
        });
      }

      const createdAt = new Date().toISOString();
      const id = asText(entry.id) || `${createdAt.replace(/[-:.TZ]/gu, "")}-${slugify(title)}`;
      const filePath = projectFile(project);
      await mkdir(path.dirname(filePath), { recursive: true });
      const current = await readJsonLines(filePath);
      current.push(
        normalizeKnowledgeEntry(
          {
            id,
            title,
            content,
            project,
            type,
            source,
            tags,
            createdAt,
            updatedAt: createdAt,
            slug: asText(entry.slug) || slugify(title)
          },
          entry
        )
      );
      await writeJsonLines(filePath, current);

      return {
        id,
        action: "append",
        status: "synced",
        backend: "local-only",
        title,
        project,
        source,
        tags,
        parentPageId: "",
        appendedBlocks: 1,
        createdAt,
        path: filePath
      };
    },

    /**
     * @param {string} id
     * @param {string} [project]
     */
    async delete(id, project = "") {
      const filePath = projectFile(project);
      const entries = await readJsonLines(filePath);
      const nextEntries = entries.filter((entry) => asText(asRecord(entry).id) !== id);
      const deleted = nextEntries.length < entries.length;
      if (deleted) {
        await writeJsonLines(filePath, nextEntries);
      }
      return {
        deleted,
        id,
        backend: "local-only"
      };
    },

    /**
     * @param {string} query
     * @param {{ project?: string, limit?: number }} [options]
     */
    async search(query, options = {}) {
      const entries = await this.list(options.project, { limit: options.limit ?? 200 });
      const needle = asText(query).toLowerCase();
      if (!needle) {
        return entries;
      }

      return entries.filter((entry) => {
        const haystack = `${entry.title}\n${entry.content}\n${entry.tags?.join(" ") ?? ""}`.toLowerCase();
        return haystack.includes(needle);
      });
    },

    /**
     * @param {string} [project]
     * @param {{ limit?: number }} [options]
     */
    async list(project = "", options = {}) {
      const filePath = projectFile(project);
      const entries = await readJsonLines(filePath);
      const normalized = entries
        .map((entry) => normalizeKnowledgeEntry(entry))
        .sort((left, right) => asText(right.createdAt).localeCompare(asText(left.createdAt)));
      const limit = clampInteger(Number(options?.limit ?? normalized.length), 1, 2000, normalized.length);
      return normalized.slice(0, limit);
    },

    async health() {
      try {
        await mkdir(baseDir, { recursive: true });
        return {
          healthy: true,
          provider: "local-only",
          detail: `Local knowledge backend ready at ${baseDir}`
        };
      } catch (error) {
        return {
          healthy: false,
          provider: "local-only",
          detail: error instanceof Error ? error.message : String(error)
        };
      }
    },

    /**
     * @param {string} _project
     */
    async getPendingSyncs(_project) {
      return [];
    }
  };
}

/**
 * @param {{
 *   cwd?: string,
 *   backend?: "local-only" | "obsidian" | "notion",
 *   syncConfig?: unknown,
 *   notion?: {
 *     token?: string,
 *     parentPageId?: string,
 *     apiBaseUrl?: string,
 *     fetchImpl?: typeof fetch
 *   },
 *   obsidian?: {
 *     vaultDir?: string,
 *     pollIntervalMs?: number,
 *     parseFrontmatter?: (raw: string) => { data: Record<string, unknown>, content: string }
 *   },
 *   providers?: {
 *     localOnly?: ReturnType<typeof createLocalKnowledgeProvider>,
 *     notion?: ReturnType<typeof createNotionProvider>,
 *     obsidian?: ReturnType<typeof createObsidianProvider>
 *   }
 * }} [options]
 */
export function createKnowledgeResolver(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const syncConfig = resolveKnowledgeSyncConfig(asRecord(options.syncConfig));
  const selectedBackend = options.backend ?? syncConfig.knowledgeBackend;
  const retryPolicy = normalizeRetryPolicy(syncConfig.retryPolicy);
  const dlqEnabled = syncConfig.dlq.enabled === true;
  const dlqRoot = path.resolve(cwd, syncConfig.dlq.path);
  const dlqTtlDays = clampInteger(Number(syncConfig.dlq.ttlDays), 1, 365, 7);
  const providerCache = new Map();
  const retryTimerMs = 5 * 60 * 1000;

  /**
   * @param {string} project
   */
  function projectKey(project) {
    return slugify(project || "_default");
  }

  /**
   * @param {string} project
   */
  function pendingFile(project) {
    return path.join(dlqRoot, projectKey(project), "pending.jsonl");
  }

  /**
   * @param {string} project
   */
  function quarantineFile(project) {
    return path.join(dlqRoot, projectKey(project), "quarantine.jsonl");
  }

  /**
   * @param {string} project
   */
  async function readPending(project) {
    return readJsonLines(pendingFile(project));
  }

  /**
   * @param {string} project
   * @param {unknown[]} entries
   */
  async function writePending(project, entries) {
    const target = pendingFile(project);
    await mkdir(path.dirname(target), { recursive: true });
    await writeJsonLines(target, entries);
  }

  /**
   * @param {string} project
   * @param {unknown[]} entries
   */
  async function appendQuarantine(project, entries) {
    if (!entries.length) {
      return;
    }
    const target = quarantineFile(project);
    await mkdir(path.dirname(target), { recursive: true });
    const existing = await readJsonLines(target);
    existing.push(...entries);
    await writeJsonLines(target, existing);
  }

  /**
   * @param {unknown} error
   */
  function normalizeErrorMessage(error) {
    return error instanceof Error ? error.message : String(error ?? "Unknown error");
  }

  /**
   * @param {number} attempts
   */
  function nextRetryAt(attempts) {
    const factor = Math.max(0, attempts - 1);
    const waitMs = Math.min(retryPolicy.maxBackoffMs, retryPolicy.backoffMs * Math.pow(2, factor));
    return new Date(Date.now() + waitMs).toISOString();
  }

  /**
   * @param {string} backend
   */
  function buildProvider(backend) {
    if (backend === "notion") {
      const injected = options.providers?.notion;
      const resolved = injected ?? createNotionProvider(options.notion ?? {});
      return withRetry(resolved, retryPolicy);
    }

    if (backend === "obsidian") {
      const injected = options.providers?.obsidian;
      const resolved = injected ?? createObsidianProvider({
        cwd,
        ...options.obsidian
      });
      return withRetry(resolved, retryPolicy);
    }

    const injected = options.providers?.localOnly;
    const resolved = injected ?? createLocalKnowledgeProvider({ cwd });
    return withRetry(resolved, retryPolicy);
  }

  /**
   * @param {string} project
   */
  function getProvider(project) {
    const key = `${selectedBackend}:${projectKey(project)}`;
    if (!providerCache.has(key)) {
      providerCache.set(key, buildProvider(selectedBackend));
    }

    return providerCache.get(key);
  }

  /**
   * @param {string} project
   * @param {string} backend
   * @param {import("./knowledge-provider.js").KnowledgeEntry} entry
   * @param {unknown} error
   */
  async function enqueueDlq(project, backend, entry, error) {
    if (!dlqEnabled) {
      return;
    }

    const pending = await readPending(project);
    const createdAt = new Date().toISOString();
    pending.push({
      originalEntry: entry,
      backend,
      attempts: 1,
      lastError: normalizeErrorMessage(error),
      createdAt,
      nextRetryAt: nextRetryAt(1)
    });
    await writePending(project, pending);
  }

  /**
   * @param {string} project
   */
  async function retryPendingProject(project) {
    if (!dlqEnabled) {
      return {
        project,
        retried: 0,
        succeeded: 0,
        failed: 0,
        quarantined: 0
      };
    }

    const pending = await readPending(project);
    if (!pending.length) {
      return {
        project,
        retried: 0,
        succeeded: 0,
        failed: 0,
        quarantined: 0
      };
    }

    const provider = getProvider(project);
    if (!provider) {
      return {
        project,
        retried: 0,
        succeeded: 0,
        failed: pending.length,
        quarantined: 0
      };
    }

    const health = await provider.health();
    if (!health.healthy) {
      return {
        project,
        retried: 0,
        succeeded: 0,
        failed: pending.length,
        quarantined: 0
      };
    }

    const now = Date.now();
    const keep = [];
    const quarantine = [];
    let retried = 0;
    let succeeded = 0;
    let failed = 0;

    for (const rawItem of pending) {
      const item = asRecord(rawItem);
      const createdAtText = asText(item.createdAt);
      const createdAtMs = createdAtText ? Date.parse(createdAtText) : Date.now();
      const ageMs = Math.max(0, now - (Number.isFinite(createdAtMs) ? createdAtMs : now));
      const ttlMs = dlqTtlDays * 24 * 60 * 60 * 1000;

      if (ageMs > ttlMs) {
        quarantine.push(item);
        continue;
      }

      const dueAt = Date.parse(asText(item.nextRetryAt));
      if (Number.isFinite(dueAt) && dueAt > now) {
        keep.push(item);
        continue;
      }

      retried += 1;
      try {
        await provider.sync(
          /** @type {import("./knowledge-provider.js").KnowledgeEntry} */ (asRecord(item.originalEntry))
        );
        succeeded += 1;
      } catch (error) {
        failed += 1;
        const attempts = clampInteger(Number(item.attempts) + 1, 1, 10_000, 2);
        keep.push({
          ...item,
          attempts,
          lastError: normalizeErrorMessage(error),
          nextRetryAt: nextRetryAt(attempts)
        });
      }
    }

    await writePending(project, keep);
    await appendQuarantine(project, quarantine);

    return {
      project,
      retried,
      succeeded,
      failed,
      quarantined: quarantine.length
    };
  }

  async function retryAllProjects() {
    if (!dlqEnabled) {
      return [];
    }

    try {
      await mkdir(dlqRoot, { recursive: true });
      const projects = await readdir(dlqRoot, { withFileTypes: true });
      const targetProjects = projects
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      const results = [];
      for (const project of targetProjects) {
        results.push(await retryPendingProject(project));
      }
      return results;
    } catch (error) {
      log("warn", "knowledge resolver retry loop failed", {
        error: normalizeErrorMessage(error)
      });
      return [];
    }
  }

  const retryTimer = dlqEnabled
    ? setInterval(() => {
        retryAllProjects().catch((error) => {
          log("warn", "knowledge resolver retry timer failed", {
            error: normalizeErrorMessage(error)
          });
        });
      }, retryTimerMs)
    : null;
  retryTimer?.unref?.();

  return {
    backend: selectedBackend,
    config: {
      cwd,
      sync: syncConfig
    },

    /**
     * @param {import("./knowledge-provider.js").KnowledgeEntry} entry
     */
    async sync(entry) {
      const project = asText(entry.project) || "_default";
      const provider = getProvider(project);
      if (!provider) {
        throw new ProviderConnectionError("Knowledge provider could not be resolved.", {
          provider: selectedBackend
        });
      }

      try {
        const result = await provider.sync(entry);
        const pending = await this.getPendingSyncs(project);
        return {
          ...result,
          backend: provider.name,
          pendingSyncs: pending
        };
      } catch (error) {
        const mapped = error instanceof ProviderValidationError
          ? error
          : error instanceof ProviderWriteError
            ? error
            : new ProviderWriteError(normalizeErrorMessage(error), {
                provider: provider.name,
                cause: error,
                transient: true
              });

        if (!(mapped instanceof ProviderValidationError) && dlqEnabled) {
          await enqueueDlq(project, provider.name, entry, mapped);
          const pending = await this.getPendingSyncs(project);
          return {
            id: asText(entry.id) || `${provider.name}-${Date.now()}`,
            action: "queue",
            status: "queued",
            backend: provider.name,
            title: asText(entry.title),
            project,
            source: asText(entry.source) || "lcs-cli",
            tags: asArray(entry.tags).map((tag) => asText(tag)).filter(Boolean),
            parentPageId: "",
            appendedBlocks: 0,
            createdAt: new Date().toISOString(),
            queued: true,
            warning: mapped.message,
            pendingSyncs: pending
          };
        }

        throw mapped;
      }
    },

    /**
     * @param {string} query
     * @param {{ project?: string, limit?: number }} [options]
     */
    async search(query, options = {}) {
      const project = asText(options.project) || "_default";
      const provider = getProvider(project);
      if (!provider) {
        return [];
      }
      return provider.search(query, options);
    },

    /**
     * @param {string} [project]
     * @param {{ limit?: number }} [options]
     */
    async list(project = "", options = {}) {
      const targetProject = asText(project) || "_default";
      const provider = getProvider(targetProject);
      if (!provider) {
        return [];
      }
      return provider.list(targetProject, options);
    },

    /**
     * @param {string} id
     * @param {string} [project]
     */
    async delete(id, project = "") {
      const targetProject = asText(project) || "_default";
      const provider = getProvider(targetProject);
      if (!provider) {
        return {
          deleted: false,
          id,
          backend: selectedBackend
        };
      }
      return provider.delete(id, targetProject);
    },

    /**
     * @param {string} [project]
     */
    async health(project = "_default") {
      const provider = getProvider(project);
      if (!provider) {
        return {
          healthy: false,
          provider: selectedBackend,
          detail: "Provider unavailable"
        };
      }
      return provider.health();
    },

    /**
     * @param {string} project
     */
    async getPendingSyncs(project) {
      if (!dlqEnabled) {
        return [];
      }
      return readPending(project);
    },

    /**
     * @param {string} project
     */
    async retryPending(project) {
      return retryPendingProject(project);
    },

    async retryPendingAll() {
      return retryAllProjects();
    },

    async stop() {
      if (retryTimer) {
        clearInterval(retryTimer);
      }

      for (const provider of providerCache.values()) {
        if (provider && typeof provider.stop === "function") {
          await provider.stop();
        }
      }
      providerCache.clear();
    }
  };
}

export { createLocalKnowledgeProvider };

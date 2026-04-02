// @ts-check

import path from "node:path";
import { lstat, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import matter from "gray-matter";
import lockfile from "proper-lockfile";
import { Mutex } from "async-mutex";
import PQueue from "p-queue";
import { atomicWrite } from "./fs-safe.js";
import { log } from "../core/logger.js";
import {
  ProviderConnectionError,
  ProviderValidationError,
  ProviderWriteError
} from "./knowledge-provider.js";

const DEFAULT_VAULT_DIR = ".lcs/obsidian-vault";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const SLUG_PATTERN = /^[a-z0-9_-]{1,100}$/u;

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
function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => asText(entry)).filter(Boolean)
    : [];
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
  const project = asText(record.project) || asText(fallbackRecord.project) || "_default";
  const type = asText(record.type) || asText(fallbackRecord.type) || "memories";
  const source = asText(record.source) || asText(fallbackRecord.source) || "obsidian";
  const createdAt = asText(record.createdAt) || asText(fallbackRecord.createdAt) || new Date().toISOString();
  const updatedAt = asText(record.updatedAt) || asText(fallbackRecord.updatedAt) || createdAt;
  const slug = asText(record.slug) || asText(fallbackRecord.slug) || slugify(title);
  const tags = asStringArray(record.tags);
  const scope = asText(record.scope) || asText(fallbackRecord.scope);
  const topic = asText(record.topic) || asText(fallbackRecord.topic);
  const language = asText(record.language) || asText(fallbackRecord.language);
  const sector = asText(record.sector) || asText(fallbackRecord.sector);
  const memoryType = asText(record.memoryType) || asText(fallbackRecord.memoryType);

  return {
    id: asText(record.id) || asText(fallbackRecord.id) || slug,
    title,
    content,
    project,
    type,
    source,
    tags,
    createdAt,
    updatedAt,
    slug,
    ...(scope ? { scope } : {}),
    ...(topic ? { topic } : {}),
    ...(language ? { language } : {}),
    ...(sector ? { sector } : {}),
    ...(memoryType ? { memoryType } : {})
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

  return compact.slice(0, 100) || "note";
}

/**
 * @param {string} typeValue
 * @returns {string}
 */
function resolveVaultSector(typeValue) {
  const normalized = slugify(typeValue || "memories");

  if (["skill", "skills"].includes(normalized)) {
    return "skills";
  }

  if (["tool", "tools", "cli", "runtime", "integration", "adapter"].includes(normalized)) {
    return "tools";
  }

  if (
    [
      "learning",
      "lesson",
      "lessons",
      "teaching",
      "teaching-packet",
      "learning-packet",
      "learning-packets",
      "session-close"
    ].includes(normalized)
  ) {
    return "learning-packets";
  }

  if (
    [
      "project",
      "projects",
      "architecture",
      "decision",
      "pattern",
      "bugfix",
      "release"
    ].includes(normalized)
  ) {
    return "projects";
  }

  return "memories";
}

/**
 * @param {string} root
 * @param {string[]} segments
 * @param {string} fieldName
 */
function resolveSafeChildPath(root, segments, fieldName) {
  const target = path.resolve(root, ...segments);
  const normalizedRoot = path.resolve(root);

  if (!target.startsWith(`${normalizedRoot}${path.sep}`) && target !== normalizedRoot) {
    throw new ProviderValidationError(`${fieldName} must stay within vault root.`, {
      provider: "obsidian"
    });
  }

  return target;
}

/**
 * @param {string} root
 * @param {string} candidate
 */
async function assertNoSymlinkOnPath(root, candidate) {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);

  if (
    !normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`) &&
    normalizedCandidate !== normalizedRoot
  ) {
    return;
  }

  let cursor = normalizedRoot;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  const parts = relative.split(path.sep).filter(Boolean);

  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new ProviderValidationError(`Symlink paths are not allowed: ${cursor}`, {
          provider: "obsidian"
        });
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }

      throw error;
    }
  }
}

/**
 * @param {string} filePath
 */
function inferTypeFromPath(filePath) {
  const normalized = filePath.replace(/\\/gu, "/");
  const match = normalized.match(/\/NEXUS\/[^/]+\/([^/]+)\//u);
  return match?.[1] ?? "memories";
}

/**
 * @param {string} raw
 * @param {string} filePath
 * @param {string} project
 * @param {(raw: string) => { data: Record<string, unknown>, content: string }} parseFrontmatter
 * @returns {import("./knowledge-provider.js").KnowledgeEntry}
 */
function parseMarkdownEntry(raw, filePath, project, parseFrontmatter) {
  const parsed = parseFrontmatter(raw);
  const data = asRecord(parsed.data);
  const titleFromFile = path.basename(filePath, ".md");
  const nowIso = new Date().toISOString();
  const title = asText(data.title) || titleFromFile;
  const type = asText(data.type) || asText(data.memoryType) || inferTypeFromPath(filePath);
  const sector = asText(data.sector) || inferTypeFromPath(filePath);
  const createdAt = asText(data.createdAt) || nowIso;
  const updatedAt = asText(data.updatedAt) || createdAt;
  const source = asText(data.source) || "obsidian";
  const tags = asStringArray(data.tags);
  const scope = asText(data.scope);
  const topic = asText(data.topic);
  const language = asText(data.language);

  return {
    id: asText(data.id) || slugify(title),
    title,
    content: asText(parsed.content),
    project: asText(data.project) || project,
    type,
    source,
    tags,
    createdAt,
    updatedAt,
    slug: slugify(title),
    ...(scope ? { scope } : {}),
    ...(topic ? { topic } : {}),
    ...(language ? { language } : {}),
    ...(sector ? { sector } : {}),
    ...(type ? { memoryType: type } : {})
  };
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listMarkdownFiles(dir) {
  /** @type {string[]} */
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".nexus-index.json") {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * @param {string} indexPath
 */
async function readIndex(indexPath) {
  try {
    const raw = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    const files =
      parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object"
        ? /** @type {Record<string, unknown>} */ (parsed.files)
        : {};

    return {
      version: 1,
      files
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {
        version: 1,
        files: /** @type {Record<string, unknown>} */ ({})
      };
    }

    throw error;
  }
}

/**
 * @param {string} indexPath
 * @param {{ version: number, files: Record<string, unknown> }} index
 */
async function writeIndex(indexPath, index) {
  await atomicWrite(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

/**
 * @param {{
 *   cwd?: string,
 *   vaultDir?: string,
 *   pollIntervalMs?: number,
 *   parseFrontmatter?: (raw: string) => { data: Record<string, unknown>, content: string }
 * }} [options]
 * @returns {import("./knowledge-provider.js").KnowledgeProvider}
 */
export function createObsidianProvider(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const vaultRoot = path.resolve(cwd, options.vaultDir ?? DEFAULT_VAULT_DIR, "NEXUS");
  const pollIntervalMs = Math.max(5_000, Number(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  const parseFrontmatter = options.parseFrontmatter ?? ((raw) => matter(raw));

  /** @type {Map<string, PQueue>} */
  const projectQueues = new Map();
  /** @type {Map<string, Mutex>} */
  const slugMutexes = new Map();
  /** @type {Map<string, NodeJS.Timeout>} */
  const projectPollers = new Map();
  /** @type {Map<string, { entries: Map<string, import("./knowledge-provider.js").KnowledgeEntry>, index: { version: number, files: Record<string, unknown> } }>} */
  const projectCaches = new Map();

  /**
   * @param {string} project
   */
  function normalizeProject(project) {
    return slugify(project || "_default");
  }

  /**
   * @param {string} value
   */
  function normalizeType(value) {
    return slugify(value || "memories");
  }

  /**
   * @param {string} explicit
   * @param {string} fallback
   */
  function normalizeSlug(explicit, fallback) {
    const trimmed = asText(explicit);
    if (trimmed) {
      if (!SLUG_PATTERN.test(trimmed)) {
        throw new ProviderValidationError(
          "Slug must match ^[a-z0-9_-]+$ with max length 100.",
          { provider: "obsidian" }
        );
      }

      if (trimmed.includes("..") || /[\\/]/u.test(trimmed) || trimmed.includes("\u0000")) {
        throw new ProviderValidationError("Invalid slug path segments.", {
          provider: "obsidian"
        });
      }

      return trimmed;
    }

    const generated = slugify(fallback);
    if (!SLUG_PATTERN.test(generated)) {
      throw new ProviderValidationError("Unable to derive a safe slug for this entry.", {
        provider: "obsidian"
      });
    }
    return generated;
  }

  /**
   * @param {string} projectKey
   */
  function getProjectQueue(projectKey) {
    if (!projectQueues.has(projectKey)) {
      projectQueues.set(
        projectKey,
        new PQueue({
          concurrency: 1
        })
      );
    }

    return /** @type {PQueue} */ (projectQueues.get(projectKey));
  }

  /**
   * @param {string} key
   */
  function getSlugMutex(key) {
    if (!slugMutexes.has(key)) {
      slugMutexes.set(key, new Mutex());
    }

    return /** @type {Mutex} */ (slugMutexes.get(key));
  }

  /**
   * @param {string} projectKey
   * @returns {Promise<string>}
   */
  async function ensureProjectDir(projectKey) {
    const projectDir = resolveSafeChildPath(vaultRoot, [projectKey], "project");
    await assertNoSymlinkOnPath(vaultRoot, projectDir);
    await mkdir(projectDir, { recursive: true });
    return projectDir;
  }

  /**
   * @param {string} projectKey
   */
  async function refreshProjectCache(projectKey) {
    const projectDir = await ensureProjectDir(projectKey);
    const indexPath = path.join(projectDir, ".nexus-index.json");
    const priorIndex = await readIndex(indexPath);
    const markdownFiles = await listMarkdownFiles(projectDir);
    /** @type {Record<string, unknown>} */
    const nextFiles = {};
    /** @type {Map<string, import("./knowledge-provider.js").KnowledgeEntry>} */
    const entryMap = new Map();

    for (const filePath of markdownFiles) {
      const relativePath = path.relative(projectDir, filePath).replace(/\\/gu, "/");
      const info = await stat(filePath);
      const priorMeta = asRecord(priorIndex.files[relativePath]);
      const priorMtimeMs = Number(priorMeta.mtimeMs ?? -1);
      const priorSize = Number(priorMeta.size ?? -1);
      const unchanged = priorMtimeMs === info.mtimeMs && priorSize === info.size;
      const priorEntry = normalizeKnowledgeEntry(priorMeta.entry, {
        project: projectKey,
        type: inferTypeFromPath(filePath),
        source: "obsidian"
      });

      if (unchanged && priorEntry.title && priorEntry.content) {
        entryMap.set(filePath, priorEntry);
        nextFiles[relativePath] = {
          ...priorMeta,
          mtimeMs: info.mtimeMs,
          size: info.size
        };
        continue;
      }

      const raw = await readFile(filePath, "utf8");
      const entry = parseMarkdownEntry(raw, filePath, projectKey, parseFrontmatter);
      entryMap.set(filePath, entry);
      nextFiles[relativePath] = {
        mtimeMs: info.mtimeMs,
        size: info.size,
        parsedAt: new Date().toISOString(),
        entry
      };
    }

    const nextIndex = /** @type {{ version: number, files: Record<string, unknown> }} */ ({
      version: 1,
      files: nextFiles
    });
    await writeIndex(indexPath, nextIndex);
    projectCaches.set(projectKey, {
      entries: entryMap,
      index: nextIndex
    });

    return {
      projectDir,
      indexPath
    };
  }

  /**
   * @param {string} projectKey
   */
  async function getProjectCache(projectKey) {
    if (!projectCaches.has(projectKey)) {
      await refreshProjectCache(projectKey);
    }

    return /** @type {{ entries: Map<string, import("./knowledge-provider.js").KnowledgeEntry>, index: { version: number, files: Record<string, unknown> } }} */ (
      projectCaches.get(projectKey)
    );
  }

  /**
   * @param {string} projectKey
   * @param {string} absolutePath
   * @param {import("./knowledge-provider.js").KnowledgeEntry} entry
   */
  async function upsertCacheEntry(projectKey, absolutePath, entry) {
    const projectDir = await ensureProjectDir(projectKey);
    const cache = await getProjectCache(projectKey);
    cache.entries.set(absolutePath, entry);

    const info = await stat(absolutePath);
    const rel = path.relative(projectDir, absolutePath).replace(/\\/gu, "/");
    cache.index.files[rel] = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      parsedAt: new Date().toISOString(),
      entry
    };
    await writeIndex(path.join(projectDir, ".nexus-index.json"), cache.index);
  }

  /**
   * @param {string} projectKey
   */
  function ensurePolling(projectKey) {
    if (projectPollers.has(projectKey)) {
      return;
    }

    const timer = setInterval(() => {
      refreshProjectCache(projectKey).catch((error) => {
        log("warn", "obsidian cache refresh failed", {
          project: projectKey,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, pollIntervalMs);
    timer.unref?.();
    projectPollers.set(projectKey, timer);
  }

  return {
    name: "obsidian",

    /**
     * @param {import("./knowledge-provider.js").KnowledgeEntry} entry
     */
    async sync(entry) {
      const projectKey = normalizeProject(asText(entry.project) || "_default");
      const rawType = asText(entry.type) || "memories";
      const typeKey = normalizeType(asText(entry.sector) || resolveVaultSector(rawType));
      const title = asText(entry.title);
      const content = asText(entry.content);

      if (!title) {
        throw new ProviderValidationError("Knowledge entry title is required.", {
          provider: "obsidian"
        });
      }

      if (!content) {
        throw new ProviderValidationError("Knowledge entry content is required.", {
          provider: "obsidian"
        });
      }

      const slug = normalizeSlug(asText(entry.slug), title);
      const mutex = getSlugMutex(`${projectKey}:${slug}`);
      const queue = getProjectQueue(projectKey);

      return queue.add(async () =>
        mutex.runExclusive(async () => {
          const projectDir = await ensureProjectDir(projectKey);
          const typeDir = resolveSafeChildPath(projectDir, [typeKey], "type");
          await assertNoSymlinkOnPath(vaultRoot, typeDir);
          await mkdir(typeDir, { recursive: true });

          const filePath = resolveSafeChildPath(typeDir, [`${slug}.md`], "slug");
          await assertNoSymlinkOnPath(vaultRoot, filePath);
          await writeFile(filePath, "", { flag: "a" });

          /** @type {(() => Promise<void>) | null} */
          let release = null;

          try {
            release = await lockfile.lock(filePath, {
              realpath: false,
              retries: {
                retries: 2,
                minTimeout: 40,
                maxTimeout: 160
              }
            });
          } catch {
            release = null;
          }

          try {
            let createdAt = asText(entry.createdAt);

            if (!createdAt) {
              try {
                const rawExisting = await readFile(filePath, "utf8");
                const parsedExisting = parseFrontmatter(rawExisting);
                createdAt = asText(parsedExisting.data?.createdAt);
              } catch {
                createdAt = "";
              }
            }

            const nowIso = new Date().toISOString();
            const updatedAt = asText(entry.updatedAt) || nowIso;
            const finalCreatedAt = createdAt || updatedAt;
            const scope = asText(entry.scope);
            const topic = asText(entry.topic);
            const language = asText(entry.language).toLowerCase();
            const frontmatter = {
              id: asText(entry.id) || slug,
              title,
              project: projectKey,
              type: rawType,
              memoryType: rawType,
              sector: typeKey,
              source: asText(entry.source) || "lcs-cli",
              tags: asStringArray(entry.tags),
              createdAt: finalCreatedAt,
              updatedAt,
              ...(scope ? { scope } : {}),
              ...(topic ? { topic } : {}),
              ...(language ? { language } : {})
            };
            const markdown = matter.stringify(content, frontmatter);

            await atomicWrite(filePath, markdown, "utf8");
            const payload = {
              id: frontmatter.id,
              title,
              content,
              project: projectKey,
              type: rawType,
              memoryType: rawType,
              sector: typeKey,
              source: frontmatter.source,
              tags: frontmatter.tags,
              createdAt: finalCreatedAt,
              updatedAt,
              slug,
              ...(scope ? { scope } : {}),
              ...(topic ? { topic } : {}),
              ...(language ? { language } : {})
            };

            await upsertCacheEntry(projectKey, filePath, payload);
            ensurePolling(projectKey);

            return {
              id: frontmatter.id,
              action: "sync",
              status: "synced",
              backend: "obsidian",
              title,
              project: projectKey,
              source: frontmatter.source,
              tags: frontmatter.tags,
              path: filePath,
              createdAt: updatedAt,
              appendedBlocks: 1
            };
          } catch (error) {
            throw new ProviderWriteError(
              error instanceof Error ? error.message : String(error),
              {
                provider: "obsidian",
                cause: error,
                transient: true
              }
            );
          } finally {
            if (release) {
              try {
                await release();
              } catch {
                // no-op
              }
            }
          }
        })
      );
    },

    /**
     * @param {string} id
     * @param {string} [project]
     */
    async delete(id, project = "") {
      const targetProject = asText(project) ? normalizeProject(project) : "";
      const projects = targetProject
        ? [targetProject]
        : (() => {
            try {
              const dirs = projectCaches.size
                ? [...projectCaches.keys()]
                : [];
              return dirs.length ? dirs : ["_default"];
            } catch {
              return ["_default"];
            }
          })();

      for (const projectKey of projects) {
        const cache = await getProjectCache(projectKey);
        for (const [filePath, entry] of cache.entries.entries()) {
          const entryId = asText(entry.id);

          if (entryId !== id) {
            continue;
          }

          await unlink(filePath);
          cache.entries.delete(filePath);
          const projectDir = await ensureProjectDir(projectKey);
          const rel = path.relative(projectDir, filePath).replace(/\\/gu, "/");
          delete cache.index.files[rel];
          await writeIndex(path.join(projectDir, ".nexus-index.json"), cache.index);

          return {
            deleted: true,
            id,
            backend: "obsidian"
          };
        }
      }

      return {
        deleted: false,
        id,
        backend: "obsidian"
      };
    },

    /**
     * @param {string} query
     * @param {{ project?: string, limit?: number }} [options]
     */
    async search(query, options = {}) {
      const list = await this.list(options.project, { limit: options.limit });
      const needle = asText(query).toLowerCase();

      if (!needle) {
        return list;
      }

      return list.filter((entry) => {
        const haystack = `${entry.title}\n${entry.content}\n${entry.tags?.join(" ") ?? ""}`.toLowerCase();
        return haystack.includes(needle);
      });
    },

    /**
     * @param {string} [project]
     * @param {{ limit?: number }} [options]
     */
    async list(project = "", options = {}) {
      const limit = Math.max(1, Math.min(500, Math.trunc(Number(options?.limit ?? 200))));

      if (project) {
        const projectKey = normalizeProject(project);
        const cache = await getProjectCache(projectKey);
        return [...cache.entries.values()].slice(0, limit);
      }

      /** @type {import("./knowledge-provider.js").KnowledgeEntry[]} */
      const entries = [];
      try {
        const rootEntries = await readdir(vaultRoot, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (!entry.isDirectory()) {
            continue;
          }
          const cache = await getProjectCache(entry.name);
          entries.push(...cache.entries.values());
        }
      } catch (error) {
        if (
          typeof error === "object" &&
          error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return [];
        }
        throw new ProviderConnectionError(
          error instanceof Error ? error.message : String(error),
          {
            provider: "obsidian",
            cause: error
          }
        );
      }

      return entries.slice(0, limit);
    },

    async health() {
      try {
        await mkdir(vaultRoot, { recursive: true });
        return {
          healthy: true,
          provider: "obsidian",
          detail: `Obsidian vault ready at ${vaultRoot}`
        };
      } catch (error) {
        return {
          healthy: false,
          provider: "obsidian",
          detail: error instanceof Error ? error.message : String(error)
        };
      }
    },

    /**
     * @param {string} _project
     */
    async getPendingSyncs(_project) {
      return [];
    },

    async stop() {
      for (const timer of projectPollers.values()) {
        clearInterval(timer);
      }
      projectPollers.clear();
      projectQueues.clear();
      slugMutexes.clear();
      projectCaches.clear();
    }
  };
}

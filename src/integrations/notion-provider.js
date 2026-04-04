// @ts-check

import { createNotionSyncClient, resolveNotionConfig } from "./notion-sync.js";
import {
  ProviderConnectionError,
  ProviderRateLimitError,
  ProviderValidationError,
  ProviderWriteError
} from "./knowledge-provider.js";

/**
 * @param {unknown} value
 */
function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @param {unknown} value
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
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
 * @param {number} value
 * @param {number} fallback
 */
function clampLimit(value, fallback = 100) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(200, Math.trunc(value)));
}

/**
 * @param {Record<string, unknown>} block
 */
function blockToInlineText(block) {
  const type = asText(block.type);

  if (!type) {
    return "";
  }

  const payload = asRecord(block[type]);
  const richText = asArray(payload.rich_text);

  return richText
    .map((entry) => {
      const record = asRecord(entry);
      const text = asRecord(record.text);
      return asText(text.content);
    })
    .filter(Boolean)
    .join("");
}

/**
 * @param {Array<Record<string, unknown>>} blocks
 */
function blocksToEntries(blocks) {
  /** @type {Array<{
 *   id: string,
 *   title: string,
 *   content: string,
 *   project: string,
 *   type: string,
 *   source: string,
 *   tags: string[],
 *   createdAt: string,
 *   updatedAt: string
 * }>} */
  const entries = [];
  /** @type {{
 *   id: string,
 *   title: string,
 *   contentLines: string[],
 *   project: string,
 *   type: string,
 *   source: string,
 *   tags: string[],
 *   createdAt: string,
 *   updatedAt: string
 * } | null} */
  let current = null;

  /**
   * @param {typeof current} value
   */
  function flush(value) {
    if (!value) {
      return;
    }

    entries.push({
      id: value.id,
      title: value.title,
      content: value.contentLines.join("\n").trim(),
      project: value.project,
      type: value.type,
      source: value.source,
      tags: value.tags,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt
    });
  }

  for (const block of blocks) {
    const type = asText(block.type);
    const text = blockToInlineText(block);

    if (!type || !text) {
      continue;
    }

    if (type === "heading_3") {
      flush(current);
      const rawTitle = text.replace(/\(\d{4}-\d{2}-\d{2}\)$/u, "").trim();
      current = {
        id: asText(block.id) || `notion-${Date.now()}-${entries.length + 1}`,
        title: rawTitle || text,
        contentLines: [],
        project: "",
        type: "learning",
        source: "lcs-cli",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (type === "paragraph") {
      if (/^Project:/iu.test(text) && /Source:/iu.test(text)) {
        const parts = text.split("|").map((part) => part.trim());
        const projectPart = parts.find((part) => /^Project:/iu.test(part)) ?? "";
        const sourcePart = parts.find((part) => /^Source:/iu.test(part)) ?? "";
        const tagsPart = parts.find((part) => /^Tags:/iu.test(part)) ?? "";
        const generatedPart = parts.find((part) => /^Generated:/iu.test(part)) ?? "";
        const project = projectPart.replace(/^Project:\s*/iu, "").trim();
        const source = sourcePart.replace(/^Source:\s*/iu, "").trim();
        const tags = tagsPart
          .replace(/^Tags:\s*/iu, "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
        const generated = generatedPart.replace(/^Generated:\s*/iu, "").trim();

        if (project) {
          current.project = project;
        }
        if (source) {
          current.source = source;
        }
        if (tags.length) {
          current.tags = tags;
        }
        if (generated) {
          current.createdAt = generated;
          current.updatedAt = generated;
        }
      } else {
        current.contentLines.push(text);
      }
      continue;
    }

    if (type === "bulleted_list_item" || type === "numbered_list_item") {
      current.contentLines.push(text);
    }
  }

  flush(current);
  return entries;
}

/**
 * @param {unknown} error
 * @param {string} provider
 */
function mapNotionError(error, provider) {
  if (
    error instanceof ProviderConnectionError ||
    error instanceof ProviderRateLimitError ||
    error instanceof ProviderValidationError ||
    error instanceof ProviderWriteError
  ) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error ?? "Unknown Notion error");
  const statusFromProperty =
    typeof error === "object" &&
    error &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : null;
  const statusFromMessage = (() => {
    const match = message.match(/\((\d{3})\)/u);
    return match ? Number(match[1]) : null;
  })();
  const status = statusFromProperty ?? statusFromMessage;
  const retryAfterMs =
    typeof error === "object" &&
    error &&
    "retryAfterMs" in error &&
    typeof error.retryAfterMs === "number"
      ? error.retryAfterMs
      : 0;

  if (status === 429) {
    return new ProviderRateLimitError(message, {
      provider,
      retryAfterMs,
      cause: error
    });
  }

  if (status !== null && status >= 500) {
    return new ProviderConnectionError(message, {
      provider,
      cause: error
    });
  }

  if (/missing required value|invalid|validation|must be/i.test(message)) {
    return new ProviderValidationError(message, {
      provider,
      cause: error
    });
  }

  if (status !== null && status >= 400) {
    return new ProviderWriteError(message, {
      provider,
      cause: error
    });
  }

  return new ProviderConnectionError(message, {
    provider,
    cause: error
  });
}

/**
 * @param {{
 *   token?: string,
 *   parentPageId?: string,
 *   apiBaseUrl?: string,
 *   fetchImpl?: typeof fetch
 * }} [options]
 * @returns {import("./knowledge-provider.js").KnowledgeProvider}
 */
export function createNotionProvider(options = {}) {
  const notion = createNotionSyncClient(options);
  const providerName = "notion";

  return {
    name: providerName,

    /**
     * @param {import("./knowledge-provider.js").KnowledgeEntry} entry
     */
    async sync(entry) {
      const title = asText(entry.title);
      const content = asText(entry.content);

      if (!title) {
        throw new ProviderValidationError("Knowledge entry title is required.", {
          provider: providerName
        });
      }

      if (!content) {
        throw new ProviderValidationError("Knowledge entry content is required.", {
          provider: providerName
        });
      }

      try {
        const result = await notion.appendKnowledgeEntry({
          title,
          content,
          project: asText(entry.project),
          source: asText(entry.source) || "lcs-cli",
          tags: Array.isArray(entry.tags) ? entry.tags : []
        });

        return {
          ...result,
          id: asText(entry.id) || `${providerName}-${Date.now()}`,
          status: "synced",
          backend: providerName
        };
      } catch (error) {
        throw mapNotionError(error, providerName);
      }
    },

    /**
     * @param {string} id
     */
    async delete(id) {
      return {
        deleted: false,
        id,
        backend: providerName
      };
    },

    /**
     * @param {string} query
     * @param {{ limit?: number }} [options]
     */
    async search(query, options = {}) {
      const list = await this.list("", { limit: options.limit });
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
     * @param {string} _project
     * @param {{ limit?: number }} [options]
     */
    async list(_project = "", options = {}) {
      try {
        const listed = await notion.listChildren({
          pageSize: clampLimit(Number(options.limit ?? 100))
        });
        const entries = blocksToEntries(asArray(listed.blocks).map((entry) => asRecord(entry)));
        const limit = clampLimit(Number(options.limit ?? entries.length), 100);
        return entries.slice(0, limit);
      } catch (error) {
        throw mapNotionError(error, providerName);
      }
    },

    async health() {
      const cfg = resolveNotionConfig(options);
      if (!cfg.token) {
        return {
          healthy: false,
          provider: providerName,
          detail: "Missing Notion token."
        };
      }

      if (!cfg.parentPageId) {
        return {
          healthy: false,
          provider: providerName,
          detail: "Missing Notion parent page id."
        };
      }

      try {
        await notion.listChildren({ pageSize: 1 });
        return {
          healthy: true,
          provider: providerName,
          detail: "Notion provider reachable."
        };
      } catch (error) {
        const mapped = mapNotionError(error, providerName);
        return {
          healthy: false,
          provider: providerName,
          detail: mapped.message
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

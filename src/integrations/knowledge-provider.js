// @ts-check

/**
 * @typedef {{
 *   id?: string,
 *   title: string,
 *   content: string,
 *   project?: string,
 *   type?: string,
 *   source?: string,
 *   tags?: string[],
 *   createdAt?: string,
 *   updatedAt?: string,
 *   slug?: string
 * }} KnowledgeEntry
 */

/**
 * @typedef {{
 *   maxAttempts?: number,
 *   backoffMs?: number,
 *   maxBackoffMs?: number
 * }} RetryPolicy
 */

/**
 * @typedef {{
 *   healthy: boolean,
 *   provider: string,
 *   detail: string
 * }} ProviderHealth
 */

/**
 * @typedef {{
 *   id?: string,
 *   action?: string,
 *   status?: string,
 *   backend?: string,
 *   [key: string]: unknown
 * }} KnowledgeSyncResult
 */

/**
 * @typedef {{
 *   delete: (id: string, project?: string) => Promise<{ deleted: boolean, id: string, backend?: string }>,
 *   getPendingSyncs: (project: string) => Promise<Array<Record<string, unknown>>>,
 *   health: () => Promise<ProviderHealth>,
 *   list: (project?: string, options?: { limit?: number }) => Promise<KnowledgeEntry[]>,
 *   name: string,
 *   search: (query: string, options?: { project?: string, limit?: number }) => Promise<KnowledgeEntry[]>,
 *   sync: (entry: KnowledgeEntry) => Promise<KnowledgeSyncResult>,
 *   stop?: () => Promise<void> | void
 * }} KnowledgeProvider
 */

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
 * @param {RetryPolicy | undefined} retryPolicy
 */
export function normalizeRetryPolicy(retryPolicy) {
  const maxAttempts = clampInteger(Number(retryPolicy?.maxAttempts), 1, 12, 3);
  const backoffMs = clampInteger(Number(retryPolicy?.backoffMs), 100, 120_000, 1_000);
  const maxBackoffMs = clampInteger(
    Number(retryPolicy?.maxBackoffMs),
    backoffMs,
    600_000,
    30_000
  );

  return {
    maxAttempts,
    backoffMs,
    maxBackoffMs
  };
}

/**
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export class ProviderConnectionError extends Error {
  /**
   * @param {string} message
   * @param {{ provider?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderConnectionError";
    this.provider = options.provider ?? "";
  }
}

export class ProviderWriteError extends Error {
  /**
   * @param {string} message
   * @param {{ provider?: string, cause?: unknown, transient?: boolean }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderWriteError";
    this.provider = options.provider ?? "";
    this.transient = options.transient === true;
  }
}

export class ProviderRateLimitError extends Error {
  /**
   * @param {string} message
   * @param {{ provider?: string, cause?: unknown, retryAfterMs?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderRateLimitError";
    this.provider = options.provider ?? "";
    this.retryAfterMs = clampInteger(Number(options.retryAfterMs), 0, 3_600_000, 0);
  }
}

export class ProviderValidationError extends Error {
  /**
   * @param {string} message
   * @param {{ provider?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderValidationError";
    this.provider = options.provider ?? "";
  }
}

/**
 * @param {unknown} error
 */
export function isRetryableProviderError(error) {
  if (error instanceof ProviderRateLimitError) {
    return true;
  }

  if (error instanceof ProviderConnectionError) {
    return true;
  }

  if (error instanceof ProviderWriteError) {
    return error.transient === true;
  }

  return false;
}

/**
 * @param {unknown} error
 * @param {number} attempt
 * @param {{ backoffMs: number, maxBackoffMs: number }} policy
 */
function calculateRetryDelay(error, attempt, policy) {
  if (error instanceof ProviderRateLimitError && error.retryAfterMs > 0) {
    return Math.min(policy.maxBackoffMs, error.retryAfterMs);
  }

  const factor = Math.max(0, attempt - 1);
  const exponential = policy.backoffMs * Math.pow(2, factor);
  return Math.min(policy.maxBackoffMs, exponential);
}

/**
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{
 *   policy: ReturnType<typeof normalizeRetryPolicy>,
 *   operationName: string
 * }} input
 * @returns {Promise<T>}
 */
async function runWithRetry(operation, input) {
  const { policy } = input;
  /** @type {unknown} */
  let lastError = null;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryableProviderError(error) || attempt >= policy.maxAttempts) {
        throw error;
      }

      const waitMs = calculateRetryDelay(error, attempt, policy);
      await delay(waitMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${input.operationName} failed after retries.`);
}

/**
 * Decorates a provider with retry logic on sync/delete/search/list/health.
 *
 * @param {KnowledgeProvider} provider
 * @param {RetryPolicy | undefined} retryPolicy
 * @returns {KnowledgeProvider}
 */
export function withRetry(provider, retryPolicy) {
  const policy = normalizeRetryPolicy(retryPolicy);

  return {
    ...provider,
    async sync(entry) {
      return runWithRetry(
        () => provider.sync(entry),
        { policy, operationName: `${provider.name}.sync` }
      );
    },
    async delete(id, project) {
      return runWithRetry(
        () => provider.delete(id, project),
        { policy, operationName: `${provider.name}.delete` }
      );
    },
    async search(query, options) {
      return runWithRetry(
        () => provider.search(query, options),
        { policy, operationName: `${provider.name}.search` }
      );
    },
    async list(project, options) {
      return runWithRetry(
        () => provider.list(project, options),
        { policy, operationName: `${provider.name}.list` }
      );
    },
    async health() {
      return runWithRetry(
        () => provider.health(),
        { policy, operationName: `${provider.name}.health` }
      );
    },
    async getPendingSyncs(project) {
      return provider.getPendingSyncs(project);
    }
  };
}


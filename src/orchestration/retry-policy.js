// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").RetryConfig} RetryConfig
 */

/** @type {RetryConfig} */
export const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 5000,
  backoffMultiplier: 2
};

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {Partial<RetryConfig>} [config]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, config = {}) {
  const opts = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= opts.maxRetries) break;

      const delay = Math.min(
        opts.baseDelayMs * Math.pow(opts.backoffMultiplier, attempt),
        opts.maxDelayMs
      );
      const jitter = delay * (0.75 + Math.random() * 0.5);
      await sleep(jitter);
    }
  }

  throw lastError;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

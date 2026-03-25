/**
 * Retry Policy — exponential backoff with jitter.
 *
 * Used by WorkflowEngine and ActionExecutor to retry
 * transient failures (API calls, webhooks, memory saves).
 */

import type { RetryConfig } from "../types/core-contracts.d.ts";

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 5000,
  backoffMultiplier: 2
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: unknown;

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
      // Add jitter: ±25%
      const jitter = delay * (0.75 + Math.random() * 0.5);
      await sleep(jitter);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

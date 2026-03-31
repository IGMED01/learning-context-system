// @ts-check

import { normalizeGenerateResult } from "./provider.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * @typedef {{
 *   apiKey?: string,
 *   baseUrl?: string,
 *   model?: string,
 *   embeddingModel?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch
 * }} OpenAiProviderOptions
 */

/**
 * @param {unknown} value
 */
function asText(value) {
  return typeof value === "string" ? value : "";
}

/**
 * @param {unknown} value
 */
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * @param {OpenAiProviderOptions} [options]
 */
export function createOpenAiProvider(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new Error("OpenAI provider requires Fetch API support.");
  }

  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || "";

  return {
    provider: "openai",

    /**
     * @param {string} prompt
     * @param {import("./provider.js").LlmGenerateOptions} [generateOptions]
     */
    async generate(prompt, generateOptions = {}) {
      if (!apiKey) {
        throw new Error("Missing OPENAI_API_KEY for OpenAI provider.");
      }

      const controller = new AbortController();
      const timeoutMs = Math.max(1000, Number(generateOptions.timeoutMs ?? options.timeoutMs ?? 30_000));
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(`${options.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: generateOptions.model ?? options.model ?? DEFAULT_MODEL,
            temperature: Number(generateOptions.temperature ?? 0.2),
            max_tokens: Math.max(64, Number(generateOptions.maxTokens ?? 700)),
            messages: [
              ...(generateOptions.systemPrompt
                ? [
                    {
                      role: "system",
                      content: generateOptions.systemPrompt
                    }
                  ]
                : []),
              {
                role: "user",
                content: prompt
              }
            ]
          })
        });

        const rawText = await response.text();
        let payload = {};

        try {
          payload = rawText ? JSON.parse(rawText) : {};
        } catch {
          payload = {};
        }

        if (!response.ok) {
          const message =
            payload &&
            typeof payload === "object" &&
            "error" in payload &&
            payload.error &&
            typeof payload.error === "object" &&
            "message" in payload.error
              ? asText(/** @type {Record<string, unknown>} */ (payload.error).message)
              : rawText || response.statusText;

          throw new Error(`OpenAI API request failed (${response.status}): ${message}`);
        }

        const record = /** @type {Record<string, unknown>} */ (payload);
        const choices = Array.isArray(record.choices) ? record.choices : [];
        const firstChoice =
          choices.length && choices[0] && typeof choices[0] === "object"
            ? /** @type {Record<string, unknown>} */ (choices[0])
            : {};
        const messageRecord =
          firstChoice.message && typeof firstChoice.message === "object"
            ? /** @type {Record<string, unknown>} */ (firstChoice.message)
            : {};
        const usageRecord =
          record.usage && typeof record.usage === "object"
            ? /** @type {Record<string, unknown>} */ (record.usage)
            : {};
        const inputTokens = Math.max(
          0,
          Math.trunc(asNumber(usageRecord.prompt_tokens ?? usageRecord.input_tokens))
        );
        const outputTokens = Math.max(
          0,
          Math.trunc(asNumber(usageRecord.completion_tokens ?? usageRecord.output_tokens))
        );

        return normalizeGenerateResult({
          content: asText(messageRecord.content),
          model: asText(record.model) || generateOptions.model || options.model || DEFAULT_MODEL,
          finishReason: asText(firstChoice.finish_reason),
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: Math.max(
              0,
              Math.trunc(
                asNumber(usageRecord.total_tokens) || inputTokens + outputTokens
              )
            )
          },
          raw: payload
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`OpenAI API request timed out after ${timeoutMs}ms.`);
        }

        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },

    /**
     * @param {string} prompt
     * @param {import("./provider.js").LlmGenerateOptions} [generateOptions]
     */
    async *stream(prompt, generateOptions = {}) {
      const generated = await this.generate(prompt, generateOptions);
      if (generated.content) {
        yield generated.content;
      }
    },

    /**
     * @param {string} text
     * @param {{ model?: string }} [embedOptions]
     */
    async embed(text, embedOptions = {}) {
      if (!apiKey) {
        throw new Error("Missing OPENAI_API_KEY for OpenAI embeddings.");
      }

      const controller = new AbortController();
      const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 20_000));
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const model = embedOptions.model ?? options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
        const response = await fetchImpl(`${options.baseUrl ?? DEFAULT_BASE_URL}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            input: text
          })
        });
        const rawText = await response.text();
        let payload = {};

        try {
          payload = rawText ? JSON.parse(rawText) : {};
        } catch {
          payload = {};
        }

        if (!response.ok) {
          const message =
            payload &&
            typeof payload === "object" &&
            "error" in payload &&
            payload.error &&
            typeof payload.error === "object" &&
            "message" in payload.error
              ? asText(/** @type {Record<string, unknown>} */ (payload.error).message)
              : rawText || response.statusText;

          throw new Error(`OpenAI embedding request failed (${response.status}): ${message}`);
        }

        const record = /** @type {Record<string, unknown>} */ (payload);
        const data = Array.isArray(record.data) ? record.data : [];
        const first =
          data.length && data[0] && typeof data[0] === "object"
            ? /** @type {Record<string, unknown>} */ (data[0])
            : {};
        const vector = Array.isArray(first.embedding)
          ? first.embedding
              .map((value) => (typeof value === "number" && Number.isFinite(value) ? value : 0))
              .filter((value) => Number.isFinite(value))
          : [];

        if (!vector.length) {
          throw new Error("OpenAI embedding response did not include a valid vector.");
        }

        return {
          vector,
          dimensions: vector.length,
          model,
          raw: payload
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`OpenAI embedding request timed out after ${timeoutMs}ms.`);
        }

        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

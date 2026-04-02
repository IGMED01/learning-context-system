// @ts-check
/**
 * OpenRouter LLM provider — supports free models.
 * Set OPENROUTER_API_KEY env var, or GROQ_API_KEY for Groq fallback.
 */

import { log } from "../core/logger.js";
import { formatSessionCosts, recordUsage } from "../observability/cost-tracker.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";

/**
 * @param {{ query: string, context?: string, model?: string, sessionId?: string }} opts
 * @returns {Promise<{ ok: boolean, response: string, model: string, tokens: number, provider: string, failures: Array<{ provider: string, error: string, status: number | string }> }>}
 */
export async function chatCompletion({ query, context, model, sessionId }) {
  // Try providers in order: OpenRouter → Groq → Cerebras
  const providers = [];
  /** @type {Array<{ provider: string, error: string, status: number | string }>} */
  const failures = [];

  if (process.env.OPENROUTER_API_KEY) {
    providers.push({
      name: "openrouter",
      url: OPENROUTER_URL,
      key: process.env.OPENROUTER_API_KEY,
      model: model || "mistralai/mistral-7b-instruct:free",
      headers: { "HTTP-Referer": "https://github.com/IGMED01/Nexus-Context-Orchestration-Engine-for-LLM-Systems", "X-Title": "NEXUS" }
    });
  }

  if (process.env.GROQ_API_KEY) {
    providers.push({
      name: "groq",
      url: GROQ_URL,
      key: process.env.GROQ_API_KEY,
      model: model || "llama-3.3-70b-versatile",
      headers: {}
    });
  }

  if (process.env.CEREBRAS_API_KEY) {
    providers.push({
      name: "cerebras",
      url: CEREBRAS_URL,
      key: process.env.CEREBRAS_API_KEY,
      model: model || "llama-3.3-70b",
      headers: {}
    });
  }

  if (providers.length === 0) {
    return {
      ok: false,
      response: "No LLM API key configured. Set OPENROUTER_API_KEY, GROQ_API_KEY, or CEREBRAS_API_KEY.",
      model: "none",
      tokens: 0,
      provider: "none",
      failures
    };
  }

  const systemPrompt = context
    ? `Eres NEXUS, un asistente de inteligencia contextual. Responde SOLO usando el contexto proporcionado. Si la respuesta no está en el contexto, dilo claramente. Sé conciso y preciso.\n\n--- CONTEXTO ---\n${context}\n--- FIN CONTEXTO ---`
    : `Eres un asistente general sin acceso a documentos específicos. Responde con conocimiento general. Aclara que no tienes acceso a documentación específica del usuario.`;

  for (const p of providers) {
    const startedAt = Date.now();
    try {
      const res = await fetch(p.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${p.key}`,
          ...p.headers
        },
        body: JSON.stringify({
          model: p.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: query }
          ],
          max_tokens: 1024,
          temperature: 0.3
        })
      });

      if (!res.ok) {
        const body = await res.text();
        const error = body.trim() || `HTTP ${res.status}`;
        failures.push({
          provider: p.name,
          error,
          status: res.status
        });
        log("warn", "llm provider failed", {
          provider: p.name,
          model: p.model,
          status: res.status,
          error
        });
        continue;
      }

      const data = await res.json();
      const choice = data.choices?.[0];
      if (!choice) {
        failures.push({
          provider: p.name,
          error: "Missing choices[0] in provider response.",
          status: "invalid_response"
        });
        log("warn", "llm provider returned malformed response", {
          provider: p.name,
          model: p.model
        });
        continue;
      }

      const usage = data?.usage && typeof data.usage === "object" ? data.usage : {};
      const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0);
      const completionTokens = Number(
        usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0
      );
      const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens);
      const costUSD = Number(usage.total_cost ?? usage.cost ?? usage.usd ?? data?.cost ?? 0);

      if (sessionId && sessionId.trim()) {
        recordUsage(sessionId, {
          modelId: data.model ?? p.model,
          provider: p.name,
          inputTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
          outputTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
          costUSD: Number.isFinite(costUSD) ? costUSD : 0,
          durationMs: Date.now() - startedAt
        });
        log("info", "session cost updated", {
          sessionId,
          provider: p.name,
          model: data.model ?? p.model,
          summary: formatSessionCosts(sessionId)
        });
      }

      return {
        ok: true,
        response: choice.message?.content ?? "",
        model: data.model ?? p.model,
        tokens: Number.isFinite(totalTokens) ? totalTokens : 0,
        provider: p.name,
        failures
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        typeof error === "object" &&
        error &&
        "status" in error &&
        typeof error.status === "number"
          ? error.status
          : "unknown";
      failures.push({
        provider: p.name,
        error: message,
        status
      });
      log("warn", "llm provider failed", {
        provider: p.name,
        model: p.model,
        error: message,
        status
      });
      continue;
    }
  }

  return {
    ok: false,
    response: "All LLM providers failed.",
    model: "none",
    tokens: 0,
    provider: "none",
    failures
  };
}

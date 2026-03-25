/**
 * Action Executor — runs post-response actions.
 *
 * Actions are side effects that happen after the main pipeline:
 *   - save_to_memory: persist a result to the memory store
 *   - webhook: POST to an external URL
 *   - log: structured log output
 *   - notify: placeholder for notification systems
 *
 * Each action is fire-and-forget by default but can be awaited.
 * Failures are caught and reported, never bubble up.
 */

import type { ActionDef, ActionResult, ActionType } from "../types/core-contracts.d.ts";

import { withRetry } from "./retry-policy.js";
import { runCli } from "../cli/app.js";

type ActionHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

const actionHandlers = new Map<ActionType, ActionHandler>();

// ── Built-in Actions ─────────────────────────────────────────────────

actionHandlers.set("save_to_memory", async (params) => {
  const title = String(params.title ?? "auto-save");
  const content = String(params.content ?? "");
  const project = String(params.project ?? "");

  const result = await runCli([
    "remember",
    "--title", title,
    "--content", content,
    ...(project ? ["--project", project] : []),
    "--format", "json"
  ]);

  return { exitCode: result.exitCode, stdout: result.stdout };
});

actionHandlers.set("webhook", async (params) => {
  const url = String(params.url ?? "");
  const body = params.body ?? {};

  if (!url) throw new Error("Webhook action requires a 'url' parameter.");

  const response = await withRetry(() =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  );

  return { status: response.status, ok: response.ok };
});

actionHandlers.set("log", async (params) => {
  const message = String(params.message ?? "");
  const level = String(params.level ?? "info");

  console.log(JSON.stringify({ level, action: "log", message, timestamp: new Date().toISOString() }));

  return { logged: true };
});

actionHandlers.set("notify", async (params) => {
  // Placeholder — would integrate with Slack, email, etc.
  const channel = String(params.channel ?? "default");
  const message = String(params.message ?? "");

  console.log(JSON.stringify({ level: "info", action: "notify", channel, message, timestamp: new Date().toISOString() }));

  return { notified: true, channel };
});

// ── Executor ─────────────────────────────────────────────────────────

export async function executeAction(action: ActionDef): Promise<ActionResult> {
  const startMs = Date.now();
  const handler = actionHandlers.get(action.type);

  if (!handler) {
    return {
      type: action.type,
      status: "error",
      durationMs: Date.now() - startMs,
      error: `Unknown action type: ${action.type}`
    };
  }

  try {
    const output = await handler(action.params);
    return {
      type: action.type,
      status: "success",
      durationMs: Date.now() - startMs,
      output
    };
  } catch (err) {
    return {
      type: action.type,
      status: "error",
      durationMs: Date.now() - startMs,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function executeActions(actions: ActionDef[]): Promise<ActionResult[]> {
  return Promise.all(actions.map(executeAction));
}

export function registerAction(type: ActionType, handler: ActionHandler): void {
  actionHandlers.set(type, handler);
}

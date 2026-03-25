// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").ActionDef} ActionDef
 * @typedef {import("../types/core-contracts.d.ts").ActionResult} ActionResult
 * @typedef {import("../types/core-contracts.d.ts").ActionType} ActionType
 * @typedef {(params: Record<string, unknown>) => Promise<Record<string, unknown>>} ActionHandler
 */

import { withRetry } from "./retry-policy.js";
import { runCli } from "../cli/app.js";

/** @type {Map<ActionType, ActionHandler>} */
const actionHandlers = new Map();

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
  const channel = String(params.channel ?? "default");
  const message = String(params.message ?? "");

  console.log(JSON.stringify({ level: "info", action: "notify", channel, message, timestamp: new Date().toISOString() }));

  return { notified: true, channel };
});

// ── Executor ─────────────────────────────────────────────────────────

/**
 * @param {ActionDef} action
 * @returns {Promise<ActionResult>}
 */
export async function executeAction(action) {
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

/**
 * @param {ActionDef[]} actions
 * @returns {Promise<ActionResult[]>}
 */
export async function executeActions(actions) {
  return Promise.all(actions.map(executeAction));
}

/**
 * @param {ActionType} type
 * @param {ActionHandler} handler
 */
export function registerAction(type, handler) {
  actionHandlers.set(type, handler);
}

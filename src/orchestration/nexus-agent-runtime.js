// @ts-check

/**
 * NEXUS Agent Runtime Adapter.
 *
 * Runtime execution is local-first and does not require external binaries.
 */

const RUNTIME_DISABLED_REASON =
  "NEXUS agent runtime is disabled in this workspace.";
const MAX_CONTEXT_CHARS = 12_000;
const MAX_AGENT_TASK_CHARS = 4_000;
const MAX_SWARM_AGENTS = 8;
const DEFAULT_RUNTIME_MODE = "local";

/**
 * @returns {"local" | "disabled"}
 */
function resolveRuntimeMode() {
  const raw = String(process.env.NEXUS_AGENT_RUNTIME_MODE ?? DEFAULT_RUNTIME_MODE)
    .trim()
    .toLowerCase();

  if (raw === "disabled" || raw === "off") {
    return "disabled";
  }

  return "local";
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function toMsg(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
function normalizeText(value, maxChars) {
  const compact = String(value ?? "").replace(/\s+/gu, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact;
}

/**
 * @param {string} task
 * @param {string} context
 * @param {string} agentType
 * @param {string} agentName
 * @returns {string}
 */
function buildLocalAgentText(task, context, agentType, agentName) {
  const contextPreview = normalizeText(context, 800);
  const lines = [
    `Agent runtime: local`,
    `Agent: ${agentName}`,
    `Role: ${agentType}`,
    `Task: ${task}`
  ];

  if (contextPreview) {
    lines.push(`Context (truncated): ${contextPreview}`);
  }

  lines.push("Suggested next actions:");
  lines.push("1) Validate current constraints and expected output contract.");
  lines.push("2) Apply the smallest safe code change needed.");
  lines.push("3) Run typecheck/tests and capture evidence.");
  lines.push("4) Produce Change / Reason / Concepts / Practice.");

  return lines.join("\n");
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
function stringifyJson(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * @typedef {{
 *   agentType: "coder" | "reviewer" | "tester" | "analyst" | "security",
 *   name?: string,
 *   task: string,
 *   context?: string,
 *   format?: "json" | "text"
 * }} SpawnAgentOptions
 */

/**
 * @typedef {{
 *   agentId?: string,
 *   output: string,
 *   success: boolean,
 *   error?: string
 * }} AgentResult
 */

/**
 * @typedef {{
 *   task: string,
 *   context?: string,
 *   agents?: number,
 *   strategy?: "hierarchical" | "mesh",
 *   format?: "json" | "text"
 * }} SpawnSwarmOptions
 */

/**
 * @typedef {{
 *   swarmId?: string,
 *   output: string,
 *   agentResults?: AgentResult[],
 *   success: boolean,
 *   error?: string
 * }} SwarmResult
 */

/**
 * Spawn a single specialized local agent for a targeted task.
 *
 * @param {SpawnAgentOptions} opts
 * @returns {Promise<AgentResult>}
 */
export async function spawnAgent(opts) {
  const { agentType, name, task, context, format = "json" } = opts;
  const agentName = name ?? `nexus-${agentType}-${Date.now()}`;
  const runtimeMode = resolveRuntimeMode();
  const safeTask = normalizeText(task, MAX_AGENT_TASK_CHARS);
  const safeContext = normalizeText(context ?? "", MAX_CONTEXT_CHARS);

  if (!safeTask) {
    return {
      output: "",
      success: false,
      error: "Missing required field: task."
    };
  }

  if (runtimeMode === "disabled") {
    return {
      output: "",
      success: false,
      error: RUNTIME_DISABLED_REASON
    };
  }

  try {
    const textOutput = buildLocalAgentText(safeTask, safeContext, agentType, agentName);
    const output =
      format === "json"
        ? stringifyJson({
            status: "ok",
            runtime: "local",
            agent: {
              id: agentName,
              type: agentType
            },
            task: safeTask,
            summary: textOutput
          })
        : textOutput;
    return {
      agentId: agentName,
      output,
      success: true
    };
  } catch (error) {
    return {
      output: "",
      success: false,
      error: toMsg(error)
    };
  }
}

/**
 * Launch a local multi-agent swarm simulation for complex tasks.
 *
 * @param {SpawnSwarmOptions} opts
 * @returns {Promise<SwarmResult>}
 */
export async function spawnSwarm(opts) {
  const runtimeMode = resolveRuntimeMode();
  if (runtimeMode === "disabled") {
    return {
      output: "",
      agentResults: [],
      success: false,
      error: RUNTIME_DISABLED_REASON
    };
  }

  const { task, context, agents = 3, strategy = "hierarchical", format = "json" } = opts;
  const safeAgents = Math.max(1, Math.min(MAX_SWARM_AGENTS, Math.trunc(Number(agents) || 1)));
  const agentResults = /** @type {AgentResult[]} */ ([]);

  for (let index = 0; index < safeAgents; index += 1) {
    const agentResult = await spawnAgent({
      agentType: "coder",
      name: `nexus-swarm-${index + 1}`,
      task: `${task} [swarm-${index + 1}]`,
      context,
      format
    });
    agentResults.push(agentResult);
  }

  const successful = agentResults.filter((result) => result.success);
  const outputPayload = {
    status: successful.length === agentResults.length ? "ok" : "partial",
    runtime: "local",
    strategy,
    agentsRequested: safeAgents,
    agentsSucceeded: successful.length,
    summary: successful.map((result) => result.output).join("\n\n---\n\n")
  };

  try {
    return {
      swarmId: `swarm-${Date.now()}`,
      output:
        format === "json"
          ? stringifyJson(outputPayload)
          : String(outputPayload.summary ?? ""),
      agentResults,
      success: successful.length > 0
    };
  } catch (error) {
    return {
      output: "",
      agentResults: [],
      success: false,
      error: toMsg(error)
    };
  }
}

/**
 * List available agent types.
 * @returns {Promise<string[]>}
 */
export async function listAgentTypes() {
  return ["coder", "reviewer", "tester", "analyst", "security"];
}

/**
 * Check if local agent runtime is available.
 * @returns {Promise<boolean>}
 */
export async function isAgentRuntimeAvailable() {
  return resolveRuntimeMode() !== "disabled";
}

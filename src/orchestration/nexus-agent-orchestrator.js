// @ts-check

/**
 * NEXUS Agent Bridge
 *
 * Connects NEXUS context selection to the active agent runtime.
 * Before spawning an agent, this module:
 *   1. Runs NEXUS context selection (noise-canceler) on the workspace
 *   2. Extracts the most relevant chunks (code, spec, memory)
 *   3. Injects the NEXUS-selected context + axioms into the agent prompt
 *   4. Spawns an agent with enriched context
 *   5. Optionally runs the Code Gate on the agent's output
 *
 * This makes agents NEXUS-aware:
 *   - They receive only relevant context (not the full repo)
 *   - They see applicable axioms (gotchas, security rules)
 *   - Their output is gated before being accepted
 *
 * Workflow:
 *   workspace → NEXUS select → axiom inject → runtime agent → Code Gate → result
 */

import { loadWorkspaceChunks } from "../io/workspace-chunks.js";
import { selectEndpointContext } from "../context/context-mode.js";
import { createAxiomInjector } from "../memory/axiom-injector.js";
import { spawnAgent, spawnSwarm, isAgentRuntimeAvailable } from "./nexus-agent-runtime.js";
import { runCodeGate, getGateErrors, formatGateErrors } from "../guard/code-gate.js";

/** @typedef {import("../types/core-contracts.d.ts").Chunk} Chunk */
/** @typedef {import("../types/core-contracts.d.ts").SelectedChunk} SelectedChunk */

/**
 * @typedef {{
 *   task: string,
 *   objective?: string,
 *   workspace?: string,
 *   changedFiles?: string[],
 *   focus?: string,
 *   project?: string,
 *   agentType?: "coder" | "reviewer" | "tester" | "analyst" | "security",
 *   tokenBudget?: number,
 *   maxChunks?: number,
 *   runGate?: boolean,
 *   language?: string,
 *   framework?: string,
 *   useSwarm?: boolean,
 *   swarmAgents?: number,
 *   scoringProfile?: string,
 *   sddProfile?: string
 * }} NexusAgentOptions
 */

/**
 * @typedef {{
 *   success: boolean,
 *   output: string,
 *   nexusContext: {
 *     selectedChunks: number,
 *     usedTokens: number,
 *     structuralHits: number,
 *     axiomsInjected: number,
 *     sddCoverage?: Record<string, boolean>,
 *     sddGate?: {
 *       enabled: boolean,
 *       passed: boolean,
 *       minCoverageRatio: number,
 *       coverageRatio: number,
 *       minRequiredKinds: number,
 *       requiredKinds: string[],
 *       coveredKinds: string[],
 *       missingKinds: string[],
 *       reason: string
 *     }
 *   },
 *   gateResult?: import("../types/core-contracts.d.ts").CodeGateResult,
 *   agentId?: string,
 *   error?: string
 * }} NexusAgentResult
 */

/**
 * Build the enriched context string for the runtime agent.
 *
 * @param {SelectedChunk[]} selected
 * @param {string} axiomBlock
 * @param {string} task
 * @param {string} objective
 * @param {string[]} changedFiles
 * @returns {string}
 */
function buildAgentContext(selected, axiomBlock, task, objective, changedFiles) {
  const sections = [];

  sections.push(`## Task\n${task}`);

  if (objective) {
    sections.push(`## Objective\n${objective}`);
  }

  if (changedFiles.length) {
    sections.push(`## Changed Files\n${changedFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (axiomBlock) {
    sections.push(axiomBlock);
  }

  if (selected.length) {
    sections.push("## Relevant Context (NEXUS-selected)");
    for (const chunk of selected) {
      const header = `### ${chunk.source} [${chunk.kind}] score=${chunk.score.toFixed(2)}`;
      sections.push(`${header}\n\`\`\`\n${chunk.content}\n\`\`\``);
    }
  }

  return sections.join("\n\n");
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampFloat(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

/**
 * @param {{
 *   runGate: boolean,
 *   sdd: {
 *     requiredKinds?: unknown,
 *     coverage?: unknown
 *   } | null
 * }}
 */
function evaluateSddFailFastGate(input) {
  const minCoverageRatio = clampFloat(
    Number(process.env.LCS_AGENT_SDD_MIN_COVERAGE ?? 1),
    0,
    1,
    1
  );
  const minRequiredKinds = clampNumber(
    Number(process.env.LCS_AGENT_SDD_MIN_REQUIRED_KINDS ?? 1),
    0,
    6,
    1
  );
  /** @type {string[]} */
  const requiredKinds = Array.isArray(input.sdd?.requiredKinds)
    ? input.sdd.requiredKinds
        .filter((entry) => typeof entry === "string" && entry.trim())
        .map((entry) => entry.trim())
    : [];
  const coverage = input.sdd?.coverage && typeof input.sdd.coverage === "object"
    ? /** @type {Record<string, unknown>} */ (input.sdd.coverage)
    : {};
  const coveredKinds = requiredKinds.filter((kind) => coverage[kind] === true);
  const missingKinds = requiredKinds.filter((kind) => coverage[kind] !== true);
  const coverageRatio = requiredKinds.length
    ? Number((coveredKinds.length / requiredKinds.length).toFixed(3))
    : 0;

  if (!input.runGate) {
    return {
      enabled: false,
      passed: true,
      minCoverageRatio,
      coverageRatio,
      minRequiredKinds,
      requiredKinds,
      coveredKinds,
      missingKinds,
      reason: "disabled"
    };
  }

  if (requiredKinds.length < minRequiredKinds) {
    return {
      enabled: true,
      passed: false,
      minCoverageRatio,
      coverageRatio,
      minRequiredKinds,
      requiredKinds,
      coveredKinds,
      missingKinds,
      reason: `required-kinds-below-minimum (${requiredKinds.length}/${minRequiredKinds})`
    };
  }

  if (coverageRatio < minCoverageRatio) {
    return {
      enabled: true,
      passed: false,
      minCoverageRatio,
      coverageRatio,
      minRequiredKinds,
      requiredKinds,
      coveredKinds,
      missingKinds,
      reason: `coverage-below-minimum (${coverageRatio} < ${minCoverageRatio})`
    };
  }

  return {
    enabled: true,
    passed: true,
    minCoverageRatio,
    coverageRatio,
    minRequiredKinds,
    requiredKinds,
    coveredKinds,
    missingKinds,
    reason: "ok"
  };
}

/**
 * Spawn a NEXUS-aware runtime agent with context-enriched prompt.
 *
 * @param {NexusAgentOptions} opts
 * @returns {Promise<NexusAgentResult>}
 */
export async function spawnNexusAgent(opts) {
  const safeTask = String(opts.task ?? "").trim().slice(0, 4000);
  const safeObjective = String(opts.objective ?? "").trim().slice(0, 3000);

  if (!safeTask) {
    return {
      success: false,
      output: "",
      nexusContext: {
        selectedChunks: 0,
        usedTokens: 0,
        structuralHits: 0,
        axiomsInjected: 0
      },
      error: "Missing required field: task"
    };
  }

  const {
    workspace = ".",
    changedFiles,
    focus,
    project = "default",
    agentType = "coder",
    tokenBudget,
    maxChunks,
    runGate = false,
    language,
    framework,
    useSwarm = false,
    swarmAgents,
    scoringProfile,
    sddProfile
  } = opts;
  const safeChangedFiles = Array.isArray(changedFiles)
    ? changedFiles.filter((entry) => typeof entry === "string").slice(0, 100)
    : [];
  const safeTokenBudget = clampNumber(tokenBudget, 64, 4_000, 350);
  const safeMaxChunks = clampNumber(maxChunks, 1, 20, 6);
  const safeSwarmAgents = clampNumber(swarmAgents, 1, 8, 3);
  const focusQuery = focus ?? `${safeTask} ${safeObjective}`.trim();

  // ── Step 1: NEXUS context selection ─────────────────────────────────────────
  let selected = /** @type {SelectedChunk[]} */ ([]);
  let usedTokens = 0;
  let structuralHits = 0;
  let sddCoverage = /** @type {Record<string, boolean>} */ ({});
  let sddSummary = /** @type {{ requiredKinds?: string[], coverage?: Record<string, boolean> } | null} */ (null);

  try {
    const workspaceResult = await loadWorkspaceChunks(workspace);
    const selectionResult = selectEndpointContext({
      endpoint: "agent",
      query: focusQuery,
      chunks: workspaceResult.payload.chunks,
      changedFiles: safeChangedFiles,
      language,
      framework,
      agentType,
      sddProfile:
        typeof sddProfile === "string" && sddProfile.trim()
          ? sddProfile.trim()
          : undefined,
      forceSelection: true,
      profileOverrides: {
        tokenBudget: safeTokenBudget,
        maxChunks: safeMaxChunks,
        scoringProfile:
          typeof scoringProfile === "string" && scoringProfile.trim()
            ? scoringProfile.trim()
            : "vertical-tuned"
      }
    });

    selected = /** @type {SelectedChunk[]} */ (selectionResult.selectedChunks);
    usedTokens = selectionResult.usedTokens;
    structuralHits = selected.filter(
      (c) => (c.diagnostics?.structuralSignalCount ?? 0) > 0
    ).length;
    sddCoverage = selectionResult.sdd?.coverage ?? {};
    sddSummary = {
      requiredKinds: Array.isArray(selectionResult.sdd?.requiredKinds)
        ? selectionResult.sdd.requiredKinds
        : [],
      coverage: sddCoverage
    };
  } catch {
    // Non-fatal: proceed without workspace context
  }
  const sddGate = evaluateSddFailFastGate({
    runGate,
    sdd: sddSummary
  });

  if (runGate && !sddGate.passed) {
    return {
      success: false,
      output: "",
      nexusContext: {
        selectedChunks: selected.length,
        usedTokens,
        structuralHits,
        axiomsInjected: 0,
        sddCoverage,
        sddGate
      },
      error: `SDD gate blocked agent run: ${sddGate.reason}. Missing: ${
        sddGate.missingKinds.length ? sddGate.missingKinds.join(", ") : "n/a"
      }.`
    };
  }

  // ── Step 2: Axiom injection ──────────────────────────────────────────────────
  let axiomBlock = "";
  let axiomsInjected = 0;

  try {
    const injector = createAxiomInjector({ project, maxAxioms: 3 });
    const focusTerms = `${safeTask} ${safeObjective}`.trim().split(/\s+/).filter(Boolean);

    axiomBlock = await injector.inject({ language, framework, focusTerms });
    axiomsInjected = axiomBlock ? (axiomBlock.match(/##/g) ?? []).length : 0;
  } catch {
    // Non-fatal: proceed without axioms
  }

  // ── Step 3: Build enriched context ───────────────────────────────────────────
  const context = buildAgentContext(selected, axiomBlock, safeTask, safeObjective, safeChangedFiles);

  // ── Step 4: Check runtime availability ───────────────────────────────────────
  const runtimeAvailable = await isAgentRuntimeAvailable();

  if (!runtimeAvailable) {
    return {
      success: false,
      output: "",
      nexusContext: {
        selectedChunks: selected.length,
        usedTokens,
        structuralHits,
        axiomsInjected,
        sddCoverage,
        sddGate
      },
      error: "NEXUS agent runtime is disabled in this workspace."
    };
  }

  // ── Step 5: Spawn runtime agent / swarm ──────────────────────────────────────
  let agentOutput = "";
  let agentId = "";
  let agentSuccess = false;

  if (useSwarm) {
    const swarmResult = await spawnSwarm({
      task: safeTask,
      context,
      agents: safeSwarmAgents,
      strategy: "hierarchical",
      format: "json"
    });
    agentOutput = swarmResult.output;
    agentSuccess = swarmResult.success;
  } else {
    const agentResult = await spawnAgent({
      agentType,
      task: safeTask,
      context,
      format: "json"
    });
    agentOutput = agentResult.output;
    agentId = agentResult.agentId ?? "";
    agentSuccess = agentResult.success;
  }

  const nexusContext = {
    selectedChunks: selected.length,
    usedTokens,
    structuralHits,
    axiomsInjected,
    sddCoverage,
    sddGate
  };

  if (!agentSuccess) {
    return {
      success: false,
      output: agentOutput,
      nexusContext,
      agentId,
      error: "Agent execution did not complete successfully"
    };
  }

  // ── Step 6: Optional Code Gate ────────────────────────────────────────────────
  if (runGate && agentOutput) {
    const gateResult = await runCodeGate({ cwd: workspace, tools: ["typecheck", "lint"] });
    const gateErrors = getGateErrors(gateResult);

    return {
      success: gateResult.passed,
      output: agentOutput,
      nexusContext,
      gateResult,
      agentId,
      error: gateErrors.length ? formatGateErrors(gateErrors) : undefined
    };
  }

  return {
    success: true,
    output: agentOutput,
    nexusContext,
    agentId
  };
}

/**
 * Summary of what NEXUS contributed to the agent run.
 *
 * @param {NexusAgentResult} result
 * @returns {string}
 */
export function formatNexusAgentSummary(result) {
  const { nexusContext, gateResult } = result;
  const sddCoverageEntries = Object.entries(nexusContext.sddCoverage ?? {});
  const sddCoverageText = sddCoverageEntries.length
    ? sddCoverageEntries
        .map(([kind, covered]) => `${kind}:${covered ? "ok" : "missing"}`)
        .join(", ")
    : "n/a";
  const lines = [
    `Agent: ${result.success ? "✓ success" : "✗ failed"}`,
    `NEXUS context: ${nexusContext.selectedChunks} chunks / ${nexusContext.usedTokens} tokens`,
    `  structural hits: ${nexusContext.structuralHits}`,
    `  axioms injected: ${nexusContext.axiomsInjected}`,
    `  sdd coverage: ${sddCoverageText}`,
    `  sdd gate: ${nexusContext.sddGate?.enabled ? (nexusContext.sddGate.passed ? "pass" : "fail") : "disabled"}`
  ];

  if (gateResult) {
    lines.push(`Code Gate: ${gateResult.status} (${gateResult.errorCount} errors)`);
  }

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  return lines.join("\n");
}

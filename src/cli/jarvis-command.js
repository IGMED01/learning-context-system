// @ts-check

/**
 * NEXUS JARVIS — Standalone orchestration pipeline
 *
 * Runs the full JARVIS coordination flow in Node.js without requiring
 * Claude Code agent teams or Gentle AI. Uses NEXUS modules directly:
 *
 *   FASE 0 — Memory recall (Engram + local fallback)
 *   FASE 1 — Context selection (noise-canceler) + LLM generation
 *   FASE 2 — Output guard + compliance check
 *   FASE 3 — Memory save (decisions + axiom candidates)
 *
 * Entry point: lcs jarvis "<task>" [options]
 * API entry:   POST /api/jarvis
 */

import { selectContextWindow } from "../context/noise-canceler.js";
import { evaluateGuard } from "../guard/guard-engine.js";
import { createClaudeProvider } from "../llm/claude-provider.js";
import { buildLlmPrompt } from "../llm/prompt-builder.js";
import { loadWorkspaceChunks } from "../io/workspace-chunks.js";
import { ensureTeachingArtifacts } from "../learning/teaching-validator.js";
import { createAxiomInjector } from "../memory/axiom-injector.js";

/** @typedef {import("../types/core-contracts.d.ts").Chunk} Chunk */

// ── Task classification ───────────────────────────────────────────────

const TASK_PATTERNS = [
  { type: "recall",        pattern: /\b(recordar|recall|qué decidimos|what did we|explain|explicar|lookup|qué hace|what is)\b/i },
  { type: "audit",         pattern: /\b(audit|revisar código|security check|review only|solo revisar)\b/i },
  { type: "test_only",     pattern: /\b(escribir tests|write tests|agregar tests|add tests|test coverage)\b/i },
  { type: "security_scan", pattern: /\b(es seguro|is this safe|viola|violates|check axioms|chequear axiomas)\b/i }
];

/**
 * @param {string} task
 * @returns {"recall" | "audit" | "test_only" | "security_scan" | "codegen"}
 */
function classifyTask(task) {
  for (const { type, pattern } of TASK_PATTERNS) {
    if (pattern.test(task)) {
      return /** @type {any} */ (type);
    }
  }
  return "codegen";
}

// ── Phase runners ─────────────────────────────────────────────────────

/**
 * @param {{
 *   memoryClient: any,
 *   query: string,
 *   project: string
 * }} opts
 */
async function runMemoryRecall({ memoryClient, query, project }) {
  try {
    const result = await memoryClient.searchMemories(query, { project, limit: 10 });
    const stdout = typeof result.stdout === "string" ? result.stdout : JSON.stringify(result);
    const entries = parseMemoryEntries(stdout);
    return { status: "ok", entries, backend: result.backend ?? "local" };
  } catch (error) {
    return { status: "degraded", entries: [], backend: "local", error: String(error) };
  }
}

/**
 * @param {string} raw
 * @returns {unknown[]}
 */
function parseMemoryEntries(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.entries ?? [];
  } catch {
    return [];
  }
}

/**
 * @param {{
 *   chunks: Chunk[],
 *   focus: string,
 *   tokenBudget: number,
 *   maxChunks: number
 * }} opts
 */
function runContextSelection({ chunks, focus, tokenBudget, maxChunks }) {
  if (!chunks || chunks.length === 0) {
    return { selectedChunks: [], summary: { selectedCount: 0, suppressedCount: 0 } };
  }
  return selectContextWindow(chunks, { focus, tokenBudget, maxChunks });
}

/**
 * @param {{
 *   provider: ReturnType<typeof createClaudeProvider>,
 *   task: string,
 *   memoryContext: string,
 *   selectedChunks: unknown[],
 *   priorFindings: string[],
 *   axiomBlock?: string,
 *   maxTokens: number
 * }} opts
 */
async function runGeneration({ provider, task, memoryContext, selectedChunks, priorFindings, axiomBlock, maxTokens }) {
  const contextBlock = selectedChunks.length > 0
    ? `## Selected Context\n${JSON.stringify(selectedChunks, null, 2)}`
    : "";

  const memoryBlock = memoryContext
    ? `## Recalled Memory\n${memoryContext}`
    : "";

  const findingsBlock = priorFindings.length > 0
    ? `## Prior Findings (address these):\n${priorFindings.map(f => `- ${f}`).join("\n")}`
    : "";

  const prompt = [
    memoryBlock,
    contextBlock,
    axiomBlock || "",
    findingsBlock,
    `## Task\n${task}`
  ].filter(Boolean).join("\n\n");

  const result = await provider.generate(prompt, {
    maxTokens,
    systemPrompt: [
      "You are a NEXUS code generation specialist.",
      "Generate minimal, production-safe code.",
      "Never introduce injection vulnerabilities, hardcoded credentials, or eval() with external input.",
      "Follow the Lean Engineering Rule: smallest valid change, no speculative abstractions.",
      "End with a Teaching Loop: Change / Reason / Concepts / Practice."
    ].join(" ")
  });

  return {
    output: typeof result === "string" ? result : (result.text ?? ""),
    status: "ok"
  };
}

/**
 * @param {{
 *   output: string,
 *   guardConfig: any,
 *   project?: string
 * }} opts
 */
function runGuard({ output, guardConfig, project = "nexus" }) {
  if (!guardConfig || !guardConfig.enabled) {
    return { passed: true, blocked: false, reasons: [] };
  }
  const evaluation = evaluateGuard(
    { query: output, project, command: "jarvis" },
    guardConfig
  );
  const reasons = evaluation.blockedBy
    ? [evaluation.userMessage || evaluation.blockedBy]
    : [];
  return {
    passed: !evaluation.blocked,
    blocked: evaluation.blocked,
    reasons
  };
}

/**
 * @param {{
 *   memoryClient: any,
 *   title: string,
 *   content: string,
 *   project: string
 * }} opts
 */
async function runMemorySave({ memoryClient, title, content, project }) {
  try {
    await memoryClient.saveMemory({ title, content, project });
    return { status: "ok" };
  } catch (error) {
    return { status: "degraded", error: String(error) };
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────

/**
 * @param {{
 *   task: string,
 *   chunks?: Chunk[],
 *   workspace?: string,
 *   securityConfig?: any,
 *   scanConfig?: any,
 *   memoryClient?: any,
 *   guardConfig?: any,
 *   project?: string,
 *   tokenBudget?: number,
 *   maxChunks?: number,
 *   maxOutputTokens?: number,
 *   apiKey?: string,
 *   model?: string,
 *   models?: { proposal?: string, codegen?: string, review?: string, security?: string, repair?: string },
 *   saveMemory?: boolean
 * }} opts
 * @returns {Promise<JarvisResult>}
 */
export async function runJarvisCommand(opts) {
  const {
    task,
    chunks: providedChunks,
    workspace = ".",
    securityConfig,
    scanConfig,
    memoryClient,
    guardConfig,
    project = "nexus",
    tokenBudget = 350,
    maxChunks = 6,
    maxOutputTokens = 2000,
    apiKey,
    model,
    models: phaseModels = {},
    saveMemory = true
  } = opts;

  const startedAt = Date.now();
  const taskType = classifyTask(task);

  /** @param {string} phase */
  const modelFor = (phase) => phaseModels[phase] || model;

  // ── Auto-load workspace chunks if not provided ────────────────────
  let chunks = providedChunks ?? [];
  if (chunks.length === 0 && taskType !== "recall") {
    try {
      const wsResult = await loadWorkspaceChunks(workspace, {
        security: securityConfig,
        scan: scanConfig
      });
      chunks = wsResult.chunks ?? [];
    } catch {
      // Workspace loading failed — continue with empty chunks
      chunks = [];
    }
  }

  /** @type {JarvisTrace[]} */
  const trace = [];

  /** @type {string[]} */
  const priorFindings = [];

  // ── FASE 0: Memory Recall ─────────────────────────────────────────
  let memoryContext = "";
  let memoryRecallStatus = "skipped";

  if (memoryClient && taskType !== "audit") {
    const phaseStart = Date.now();
    const recallResult = await runMemoryRecall({ memoryClient, query: task, project });
    memoryRecallStatus = recallResult.status;
    if (recallResult.entries.length > 0) {
      memoryContext = JSON.stringify(recallResult.entries, null, 2);
    }
    trace.push({ phase: "enrichment", agent: "nexus-memory", status: recallResult.status, durationMs: Date.now() - phaseStart });
  }

  // ── Axiom enrichment ──────────────────────────────────────────────
  let axiomBlock = "";
  if (taskType === "codegen" || taskType === "audit" || taskType === "security_scan") {
    try {
      const injector = createAxiomInjector({ project });
      axiomBlock = await injector.inject({ focusTerms: task.split(/\s+/).slice(0, 5) });
    } catch {
      // Axiom injection is best-effort
    }
  }

  // ── FASE 1a: Proposal / Design (pre-codegen) ──────────────────────
  let proposalOutput = "";

  if (taskType === "codegen") {
    const phaseStart = Date.now();
    try {
      const effectiveApiKey = apiKey || process.env.ANTHROPIC_API_KEY || "";
      if (effectiveApiKey) {
        const provider = createClaudeProvider({ apiKey: effectiveApiKey, model: modelFor("proposal") });
        const proposalResult = await provider.generate(
          [
            memoryContext ? `## Recalled Memory\n${memoryContext}` : "",
            `## Task\n${task}`,
            "",
            "Produce a brief implementation proposal (max 200 words):",
            "1. Files to create/modify",
            "2. Key design decisions",
            "3. Risks or edge cases",
            "Do NOT write code yet. Only the plan."
          ].filter(Boolean).join("\n"),
          { maxTokens: 600, temperature: 0 }
        );
        proposalOutput = typeof proposalResult === "string" ? proposalResult : (proposalResult.text ?? "");
      }
    } catch {
      // Proposal is optional — proceed without it
    }
    trace.push({ phase: "proposal", agent: "nexus-coder", status: proposalOutput ? "ok" : "skipped", durationMs: Date.now() - phaseStart });
  }

  // ── FASE 1b: Context Selection + Generation ──────────────────────
  let generationOutput = "";
  let generationStatus = "skipped";

  if (taskType === "codegen") {
    const phaseStart = Date.now();

    const selectionResult = runContextSelection({ chunks, focus: task, tokenBudget, maxChunks });

    try {
      const effectiveApiKey = apiKey || process.env.ANTHROPIC_API_KEY || "";
      if (!effectiveApiKey) {
        throw new Error("ANTHROPIC_API_KEY is required for generation. Set it via env or --api-key.");
      }

      const provider = createClaudeProvider({ apiKey: effectiveApiKey, model: modelFor("codegen") });

      // Inject proposal into prior findings so the coder follows the plan
      const codegenFindings = proposalOutput
        ? [`Implementation plan:\n${proposalOutput}`, ...priorFindings]
        : priorFindings;

      const genResult = await runGeneration({
        provider,
        task,
        memoryContext,
        selectedChunks: selectionResult.selectedChunks ?? [],
        priorFindings: codegenFindings,
        axiomBlock,
        maxTokens: maxOutputTokens
      });

      generationOutput = ensureTeachingArtifacts(genResult.output, { task });
      generationStatus = "ok";
    } catch (error) {
      generationStatus = "failed";
      generationOutput = `Generation failed: ${String(error)}`;
    }

    trace.push({ phase: "generation", agent: "nexus-coder", status: generationStatus, durationMs: Date.now() - phaseStart });
  }

  // ── FASE 2: Review + Security Guard (parallel) ────────────────────
  let guardStatus = "skipped";
  let guardBlocked = false;
  /** @type {Array<{ severity: string, message: string }>} */
  let reviewFindings = [];

  if (generationOutput && generationStatus === "ok") {
    const phaseStart = Date.now();

    // Run guard check and LLM review in parallel
    const guardPromise = Promise.resolve(runGuard({ output: generationOutput, guardConfig, project }));

    const reviewPromise = (async () => {
      try {
        const effectiveApiKey = apiKey || process.env.ANTHROPIC_API_KEY || "";
        if (!effectiveApiKey) return { findings: [] };
        const provider = createClaudeProvider({ apiKey: effectiveApiKey, model: modelFor("review") });
        const reviewResult = await provider.generate(
          [
            "Review the following code for: type errors, security issues (OWASP top-10), and violations of lean engineering.",
            "Return ONLY a JSON array of finding objects: [{\"severity\": \"critical|warn|info\", \"message\": \"...\"}]",
            "If no issues found, return [].",
            "",
            "```",
            generationOutput.slice(0, 4000),
            "```"
          ].join("\n"),
          { maxTokens: 800, temperature: 0 }
        );
        const text = typeof reviewResult === "string" ? reviewResult : (reviewResult.text ?? "[]");
        const cleaned = text.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim();
        const parsed = JSON.parse(cleaned);
        return { findings: Array.isArray(parsed) ? parsed : [] };
      } catch {
        return { findings: [] };
      }
    })();

    const [guardResult, reviewResult] = await Promise.all([guardPromise, reviewPromise]);

    guardBlocked = guardResult.blocked;
    guardStatus = guardResult.passed ? "ok" : "blocked";
    reviewFindings = reviewResult.findings;

    if (!guardResult.passed) {
      priorFindings.push(...guardResult.reasons);
    }

    // Critical review findings block the pipeline
    for (const f of reviewFindings) {
      if (f.severity === "critical") {
        priorFindings.push(`[review] ${f.message}`);
        guardBlocked = true;
      }
    }

    trace.push({ phase: "review", agent: "nexus-reviewer", status: reviewFindings.length > 0 ? "findings" : "clean", durationMs: Date.now() - phaseStart });
    trace.push({ phase: "guard", agent: "nexus-security", status: guardStatus, durationMs: Date.now() - phaseStart });
  }

  // ── FASE 3: Memory Save ───────────────────────────────────────────
  let memorySaveStatus = "skipped";

  if (memoryClient && saveMemory && generationStatus === "ok" && !guardBlocked) {
    const phaseStart = Date.now();
    const saveResult = await runMemorySave({
      memoryClient,
      title: `JARVIS: ${task.slice(0, 80)}`,
      content: generationOutput,
      project
    });
    memorySaveStatus = saveResult.status;
    trace.push({ phase: "persistence", agent: "nexus-memory", status: saveResult.status, durationMs: Date.now() - phaseStart });
  }

  // ── Final Report ──────────────────────────────────────────────────
  const overallStatus = guardBlocked
    ? "blocked"
    : generationStatus === "failed"
      ? "partial"
      : "completed";

  return {
    taskType,
    status: overallStatus,
    task,
    output: generationOutput,
    memoryRecallStatus,
    memorySaveStatus,
    guardBlocked,
    guardFindings: priorFindings,
    trace,
    durationMs: Date.now() - startedAt
  };
}

/**
 * @param {JarvisResult} result
 * @returns {string}
 */
export function formatJarvisResultAsText(result) {
  const lines = [
    `## NEXUS JARVIS — Reporte`,
    ``,
    `Tipo:    ${result.taskType}`,
    `Status:  ${result.status}`,
    `Tiempo:  ${result.durationMs}ms`,
    ``
  ];

  if (result.output) {
    lines.push(`## Output`, ``, result.output, ``);
  }

  if (result.guardBlocked) {
    lines.push(`## Guard`, ``, `BLOQUEADO por output guard.`);
    for (const finding of result.guardFindings) {
      lines.push(`  - ${finding}`);
    }
    lines.push(``);
  }

  lines.push(`## Traza`);
  lines.push(``);
  for (const entry of result.trace) {
    lines.push(`  [${entry.phase}] ${entry.agent} → ${entry.status} (${entry.durationMs}ms)`);
  }

  return lines.join("\n");
}

// ── Types ─────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   taskType: string,
 *   status: "completed" | "partial" | "blocked",
 *   task: string,
 *   output: string,
 *   memoryRecallStatus: string,
 *   memorySaveStatus: string,
 *   guardBlocked: boolean,
 *   guardFindings: string[],
 *   trace: JarvisTrace[],
 *   durationMs: number
 * }} JarvisResult
 */

/**
 * @typedef {{
 *   phase: string,
 *   agent: string,
 *   status: string,
 *   durationMs: number
 * }} JarvisTrace
 */

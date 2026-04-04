// @ts-check

/**
 * NEXUS Skill Registry — Discovers, registers, and invokes skills.
 *
 * A skill is a named, reusable operation with:
 *   - id: unique kebab-case identifier
 *   - description: human-readable summary
 *   - handler: async function(opts) => result
 *   - tags: classification labels (e.g., "codegen", "audit", "memory")
 *
 * The registry provides:
 *   - Static skill registration
 *   - Dynamic skill discovery from filesystem (`.lcs/skills/`)
 *   - Tag-based filtering
 *   - Invocation with standardized input/output
 */

/**
 * @typedef {{
 *   id: string,
 *   description: string,
 *   tags: string[],
 *   handler: (opts: Record<string, unknown>) => Promise<SkillResult>
 * }} Skill
 */

/**
 * @typedef {{
 *   status: "ok" | "failed" | "skipped",
 *   output: string,
 *   durationMs: number,
 *   metadata?: Record<string, unknown>
 * }} SkillResult
 */

/**
 * @param {{ skillsDir?: string }} [options]
 */
export function createSkillRegistry(options = {}) {
  /** @type {Map<string, Skill>} */
  const skills = new Map();

  return {
    /**
     * Register a skill.
     * @param {Skill} skill
     */
    register(skill) {
      if (!skill.id || typeof skill.handler !== "function") {
        throw new Error(`Invalid skill: id and handler are required.`);
      }
      skills.set(skill.id, skill);
    },

    /**
     * List all registered skills (optionally filtered by tag).
     * @param {{ tag?: string }} [filter]
     * @returns {Array<{ id: string, description: string, tags: string[] }>}
     */
    list(filter = {}) {
      const entries = [...skills.values()];
      const filtered = filter.tag
        ? entries.filter((s) => s.tags.includes(filter.tag))
        : entries;
      return filtered.map(({ id, description, tags }) => ({ id, description, tags }));
    },

    /**
     * Get a skill by id.
     * @param {string} id
     * @returns {Skill | undefined}
     */
    get(id) {
      return skills.get(id);
    },

    /**
     * Invoke a skill by id.
     * @param {string} id
     * @param {Record<string, unknown>} [opts]
     * @returns {Promise<SkillResult>}
     */
    async invoke(id, opts = {}) {
      const skill = skills.get(id);
      if (!skill) {
        return { status: "failed", output: `Skill '${id}' not found.`, durationMs: 0 };
      }
      const start = Date.now();
      try {
        const result = await skill.handler(opts);
        return { ...result, durationMs: Date.now() - start };
      } catch (error) {
        return {
          status: "failed",
          output: `Skill '${id}' threw: ${error instanceof Error ? error.message : String(error)}`,
          durationMs: Date.now() - start
        };
      }
    },

    /** @returns {number} */
    get size() {
      return skills.size;
    }
  };
}

/**
 * Create a registry pre-loaded with NEXUS built-in skills.
 * Skills delegate to real module functions — no stubs.
 * @returns {ReturnType<typeof createSkillRegistry>}
 */
export function createDefaultSkillRegistry() {
  const registry = createSkillRegistry();

  registry.register({
    id: "jarvis",
    description: "Full JARVIS orchestration pipeline (recall → propose → generate → review → save)",
    tags: ["codegen", "orchestration", "core"],
    async handler(opts) {
      const { runJarvisCommand, formatJarvisResultAsText } = await import("../cli/jarvis-command.js");
      const task = typeof opts.task === "string" ? opts.task : "";
      if (!task) return { status: "failed", output: "jarvis: --task is required.", durationMs: 0 };
      const result = await runJarvisCommand({ task, .../** @type {any} */ (opts) });
      return { status: result.status === "blocked" ? "failed" : "ok", output: formatJarvisResultAsText(result), durationMs: result.durationMs };
    }
  });

  registry.register({
    id: "recall",
    description: "Search memory for past decisions, axioms, or context",
    tags: ["memory", "core"],
    async handler(opts) {
      const memoryClient = /** @type {any} */ (opts.memoryClient);
      if (!memoryClient) return { status: "failed", output: "recall: memoryClient is required.", durationMs: 0 };
      const query = typeof opts.query === "string" ? opts.query : "";
      const result = await memoryClient.searchMemories(query, { project: opts.project ?? "nexus", limit: 10 });
      const raw = typeof result.stdout === "string" ? result.stdout : JSON.stringify(result);
      return { status: "ok", output: raw, durationMs: 0 };
    }
  });

  registry.register({
    id: "remember",
    description: "Save a decision or axiom to persistent memory",
    tags: ["memory", "core"],
    async handler(opts) {
      const memoryClient = /** @type {any} */ (opts.memoryClient);
      if (!memoryClient) return { status: "failed", output: "remember: memoryClient is required.", durationMs: 0 };
      await memoryClient.saveMemory({ title: opts.title ?? "", content: opts.content ?? "", project: opts.project ?? "nexus" });
      return { status: "ok", output: `Saved: ${opts.title ?? "(untitled)"}`, durationMs: 0 };
    }
  });

  registry.register({
    id: "guard",
    description: "Run output guard and compliance checks on text",
    tags: ["security", "core"],
    async handler(opts) {
      const { evaluateGuard } = await import("../guard/guard-engine.js");
      const text = typeof opts.text === "string" ? opts.text : "";
      const guardConfig = opts.guardConfig ?? { enabled: false };
      const result = evaluateGuard({ query: text, project: String(opts.project ?? "nexus"), command: "guard" }, /** @type {any} */ (guardConfig));
      return { status: result.blocked ? "failed" : "ok", output: result.userMessage || (result.blocked ? "Blocked." : "Passed."), durationMs: result.durationMs };
    }
  });

  registry.register({
    id: "doctor",
    description: "Run project health checks and diagnostics",
    tags: ["system", "core"],
    async handler(opts) {
      const { runProjectDoctor } = await import("../system/project-ops.js");
      const { defaultProjectConfig } = await import("../contracts/config-contracts.js");
      const result = await runProjectDoctor({
        cwd: typeof opts.cwd === "string" ? opts.cwd : process.cwd(),
        configInfo: /** @type {any} */ (opts.configInfo ?? { found: false, path: "", config: defaultProjectConfig() })
      });
      const failed = result.checks.filter(c => c.status === "fail").map(c => `FAIL ${c.id}: ${c.detail}`);
      const warns = result.checks.filter(c => c.status === "warn").map(c => `WARN ${c.id}: ${c.detail}`);
      return { status: result.summary.fail > 0 ? "failed" : "ok", output: [...failed, ...warns].join("\n") || "All checks passed.", durationMs: 0 };
    }
  });

  registry.register({
    id: "archive",
    description: "Consolidate decisions and axioms into documentation",
    tags: ["documentation", "core"],
    async handler(opts) {
      const { runArchiveCommand, formatArchiveResultAsText } = await import("../cli/archive-command.js");
      const result = await runArchiveCommand({ project: String(opts.project ?? "nexus"), memoryClient: opts.memoryClient, cwd: typeof opts.cwd === "string" ? opts.cwd : process.cwd() });
      return { status: result.status === "failed" ? "failed" : "ok", output: formatArchiveResultAsText(result), durationMs: result.durationMs };
    }
  });

  registry.register({
    id: "ask",
    description: "Ask a question with NEXUS context selection and LLM generation (delegates to jarvis codegen)",
    tags: ["codegen", "core"],
    async handler(opts) {
      const { runJarvisCommand, formatJarvisResultAsText } = await import("../cli/jarvis-command.js");
      const task = typeof opts.question === "string" ? opts.question : (typeof opts.task === "string" ? opts.task : "");
      if (!task) return { status: "failed", output: "ask: question or task is required.", durationMs: 0 };
      const result = await runJarvisCommand({ task, .../** @type {any} */ (opts) });
      return { status: result.status === "blocked" ? "failed" : "ok", output: formatJarvisResultAsText(result), durationMs: result.durationMs };
    }
  });

  registry.register({
    id: "benchmark",
    description: "Run eval suite from a JSONL or JSON file and return a scored report",
    tags: ["eval", "core"],
    async handler(opts) {
      const start = Date.now();
      const filePath = typeof opts.filePath === "string" ? opts.filePath
        : typeof opts.file === "string" ? opts.file
        : "";
      if (!filePath) {
        return { status: "failed", output: "benchmark: filePath is required (e.g. skill.invoke('benchmark', { filePath: 'evals/suite.jsonl' }))", durationMs: 0 };
      }
      const { loadEvalSuite, runEvalSuite } = await import("../eval/eval-runner.js");
      const suite = await loadEvalSuite(filePath);
      const report = await runEvalSuite(suite, { minScore: typeof opts.minScore === "number" ? opts.minScore : 0.5, verbose: opts.verbose === true });
      const passed = report.results.filter((/** @type {any} */ r) => r.passed).length;
      const total = report.results.length;
      return {
        status: report.passed ? "ok" : "failed",
        output: `Benchmark: ${passed}/${total} passed | avg score: ${report.averageScore?.toFixed(3) ?? "n/a"} | suite: ${suite.name ?? filePath}`,
        durationMs: Date.now() - start,
        metadata: { passed, total, averageScore: report.averageScore }
      };
    }
  });

  return registry;
}

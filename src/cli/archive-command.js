// @ts-check

/**
 * NEXUS Archive — Consolidates decisions, axioms, and memory into
 * structured documentation (equivalent to SDD's archive phase).
 *
 * Usage: lcs archive [--project <id>] [--output <path>]
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createAxiomInjector } from "../memory/axiom-injector.js";

/**
 * @typedef {{
 *   project?: string,
 *   memoryClient?: any,
 *   outputPath?: string,
 *   cwd?: string
 * }} ArchiveOptions
 */

/**
 * @typedef {{
 *   status: "ok" | "empty" | "failed",
 *   outputPath: string,
 *   sections: { axioms: number, decisions: number, total: number },
 *   error?: string,
 *   durationMs: number
 * }} ArchiveResult
 */

/**
 * @param {ArchiveOptions} opts
 * @returns {Promise<ArchiveResult>}
 */
export async function runArchiveCommand(opts = {}) {
  const start = Date.now();
  const project = opts.project || "nexus";
  const cwd = opts.cwd || process.cwd();
  const outputPath = opts.outputPath || path.join(cwd, ".lcs", "archive", `${project}-archive.md`);

  const lines = [
    `# NEXUS Archive — ${project}`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    ``,
  ];

  let axiomCount = 0;
  let decisionCount = 0;

  // ── Axioms ─────────────────────────────────────────────────────
  try {
    const injector = createAxiomInjector({ project });
    const axioms = await injector.list();
    axiomCount = axioms.length;

    if (axioms.length > 0) {
      lines.push(`## Axioms (${axioms.length})`, ``);
      for (const axiom of axioms) {
        lines.push(`### ${axiom.title}`);
        lines.push(`- **Type**: ${axiom.type}`);
        if (axiom.tags?.length) lines.push(`- **Tags**: ${axiom.tags.join(", ")}`);
        lines.push(``);
        lines.push(axiom.body);
        lines.push(``);
      }
    }
  } catch {
    lines.push(`## Axioms`, ``, `_No axiom store available._`, ``);
  }

  // ── Memory decisions ───────────────────────────────────────────
  if (opts.memoryClient) {
    try {
      const result = await opts.memoryClient.searchMemories("decision OR axiom OR architecture", {
        project,
        limit: 50
      });
      const entries = Array.isArray(result.entries) ? result.entries : [];
      decisionCount = entries.length;

      if (entries.length > 0) {
        lines.push(`## Decisions & Memory (${entries.length})`, ``);
        for (const entry of entries) {
          const title = entry.title || entry.key || "Untitled";
          const content = entry.content || entry.value || JSON.stringify(entry);
          lines.push(`### ${title}`);
          lines.push(content);
          lines.push(``);
        }
      }
    } catch {
      lines.push(`## Decisions`, ``, `_Memory client not available or query failed._`, ``);
    }
  }

  const total = axiomCount + decisionCount;

  if (total === 0) {
    return {
      status: "empty",
      outputPath,
      sections: { axioms: 0, decisions: 0, total: 0 },
      durationMs: Date.now() - start
    };
  }

  // ── Write output ───────────────────────────────────────────────
  try {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, lines.join("\n"), "utf8");
  } catch (error) {
    return {
      status: "failed",
      outputPath,
      sections: { axioms: axiomCount, decisions: decisionCount, total },
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start
    };
  }

  return {
    status: "ok",
    outputPath,
    sections: { axioms: axiomCount, decisions: decisionCount, total },
    durationMs: Date.now() - start
  };
}

/**
 * @param {ArchiveResult} result
 * @returns {string}
 */
export function formatArchiveResultAsText(result) {
  if (result.status === "empty") {
    return "Archive: No axioms or decisions found to consolidate.";
  }
  if (result.status === "failed") {
    return `Archive: Failed to write output to ${result.outputPath}.`;
  }
  return [
    `Archive consolidated successfully.`,
    `  Axioms:    ${result.sections.axioms}`,
    `  Decisions: ${result.sections.decisions}`,
    `  Total:     ${result.sections.total}`,
    `  Output:    ${result.outputPath}`,
    `  Duration:  ${result.durationMs}ms`
  ].join("\n");
}

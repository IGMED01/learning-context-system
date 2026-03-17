// @ts-check

/**
 * @param {ReturnType<import("../context/noise-canceler.js").selectContextWindow>} result
 */
export function formatSelectionAsText(result) {
  const lines = [
    `Focus: ${result.focus}`,
    `Token budget: ${result.usedTokens}/${result.tokenBudget}`,
    "",
    "Selected chunks:"
  ];

  if (!result.selected.length) {
    lines.push("- none");
  } else {
    for (const chunk of result.selected) {
      lines.push(
        `- [${chunk.kind}] ${chunk.id} from ${chunk.source} | score=${chunk.score.toFixed(3)}`
      );
      lines.push(`  ${chunk.content}`);
    }
  }

  lines.push("");
  lines.push("Suppressed chunks:");

  if (!result.suppressed.length) {
    lines.push("- none");
  } else {
    for (const chunk of result.suppressed) {
      lines.push(`- ${chunk.id} | ${chunk.reason} | score=${chunk.score.toFixed(3)}`);
    }
  }

  return lines.join("\n");
}

/**
 * @param {ReturnType<import("../learning/mentor-loop.js").buildLearningPacket>} packet
 */
export function formatLearningPacketAsText(packet) {
  const lines = [
    `Task: ${packet.task}`,
    `Objective: ${packet.objective}`,
    `Changed files: ${packet.changedFiles.join(", ") || "none"}`,
    `Token budget used: ${packet.diagnostics.usedTokens}/${packet.diagnostics.tokenBudget}`,
    "",
    "Memory recall:",
    `- Enabled: ${packet.memoryRecall?.enabled ? "yes" : "no"}`,
    `- Status: ${packet.memoryRecall?.status || "none"}`,
    `- Primary query: ${packet.memoryRecall?.query || "none"}`,
    `- Queries tried: ${packet.memoryRecall?.queriesTried?.join(" | ") || "none"}`,
    `- Matched queries: ${packet.memoryRecall?.matchedQueries?.join(" | ") || "none"}`,
    `- Project: ${packet.memoryRecall?.project || "none"}`,
    `- Recovered chunks: ${packet.memoryRecall?.recoveredChunks ?? 0}`
  ];

  if (packet.memoryRecall?.error) {
    lines.push(`- Error: ${packet.memoryRecall.error}`);
  }

  lines.push(`- Selected recalled chunks: ${packet.memoryRecall?.selectedChunks ?? 0}`);
  lines.push(`- Suppressed recalled chunks: ${packet.memoryRecall?.suppressedChunks ?? 0}`);
  lines.push("");
  lines.push("Teaching checklist:");

  for (const item of packet.teachingChecklist) {
    lines.push(`- ${item}`);
  }

  lines.push("");
  lines.push("Selected context:");

  for (const chunk of packet.selectedContext) {
    lines.push(
      `- [${chunk.kind}] ${chunk.id} from ${chunk.source} | score=${chunk.score.toFixed(3)}`
    );
    lines.push(`  ${chunk.content}`);
  }

  lines.push("");
  lines.push("Suppressed context:");

  if (!packet.suppressedContext.length) {
    lines.push("- none");
  } else {
    for (const chunk of packet.suppressedContext) {
      lines.push(`- ${chunk.id} | ${chunk.reason} | score=${chunk.score.toFixed(3)}`);
    }
  }

  return lines.join("\n");
}

/**
 * @param {{
 *   mode: string,
 *   project?: string,
 *   query?: string,
 *   type?: string,
 *   scope?: string,
 *   limit?: number | null,
 *   stdout?: string,
 *   dataDir?: string
 * }} result
 */
export function formatMemoryRecallAsText(result) {
  const lines = [
    `Recall mode: ${result.mode}`,
    `Project: ${result.project || "none"}`,
    `Query: ${result.query || "none"}`,
    `Type filter: ${result.type || "none"}`,
    `Scope: ${result.scope || "none"}`,
    `Limit: ${result.limit ?? "default"}`,
    `Data dir: ${result.dataDir || "unknown"}`,
    "",
    "Recovered memory:"
  ];

  lines.push(result.stdout || "- none");
  return lines.join("\n");
}

/**
 * @param {{
 *   title: string,
 *   type?: string,
 *   project?: string,
 *   scope?: string,
 *   topic?: string,
 *   stdout?: string,
 *   dataDir?: string
 * }} result
 * @param {string} heading
 */
export function formatMemoryWriteAsText(result, heading) {
  const lines = [
    heading,
    `Title: ${result.title}`,
    `Project: ${result.project || "none"}`,
    `Type: ${result.type || "none"}`,
    `Scope: ${result.scope || "none"}`,
    `Topic: ${result.topic || "none"}`,
    `Data dir: ${result.dataDir || "unknown"}`,
    "",
    "Engram response:"
  ];

  lines.push(result.stdout || "- no output");
  return lines.join("\n");
}

export function usageText() {
  return [
    "Usage:",
    "  node src/cli.js select (--input <file> | --workspace <dir>) --focus <text> [--token-budget 350] [--max-chunks 6] [--min-score 0.25] [--format json|text]",
    "  node src/cli.js teach (--input <file> | --workspace <dir>) --task <text> --objective <text> [--changed-files a,b] [--project <name>] [--recall-query <text>] [--memory-limit 3] [--memory-type <name>] [--memory-scope <name>] [--no-recall] [--strict-recall] [--engram-bin <file>] [--engram-data-dir <dir>] [--token-budget 350] [--max-chunks 6] [--min-score 0.25] [--format json|text]",
    "  node src/cli.js readme [--workspace <dir>] [--input <file>] [--focus <text>] [--task <text>] [--objective <text>] [--title <text>] [--output <file>] [--format json|text]",
    "  node src/cli.js recall [--project <name>] [--query <text>] [--type <name>] [--scope <name>] [--limit 5] [--engram-bin <file>] [--engram-data-dir <dir>] [--format json|text]",
    "  node src/cli.js remember --title <text> (--content <text> | --message <text>) [--project <name>] [--type <name>] [--scope <name>] [--topic <key>] [--engram-bin <file>] [--engram-data-dir <dir>] [--format json|text]",
    "  node src/cli.js close --summary <text> [--learned <text>] [--next <text>] [--title <text>] [--project <name>] [--type <name>] [--scope <name>] [--engram-bin <file>] [--engram-data-dir <dir>] [--format json|text]",
    "",
    "Input file format:",
    '  { "chunks": [ { "id": "x", "source": "src/file.ts", "kind": "code", "content": "..." } ] }',
    "",
    "Notes:",
    "  --workspace scans the local repository and builds chunks automatically.",
    "  readme defaults to --workspace . when no input source is provided.",
    "  teach recalls Engram memories automatically unless you pass --no-recall.",
    "  teach now tries multiple smarter recall queries before giving up.",
    "  recall without --query asks Engram for recent context.",
    "  remember and close write durable memories into Engram."
  ].join("\n");
}

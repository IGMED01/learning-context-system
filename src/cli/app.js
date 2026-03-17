// @ts-check

import { buildLearningReadme } from "../analysis/readme-generator.js";
import { selectContextWindow } from "../context/noise-canceler.js";
import { buildLearningPacket } from "../learning/mentor-loop.js";
import { createEngramClient } from "../memory/engram-client.js";
import { resolveTeachRecall } from "../memory/teach-recall.js";
import { loadChunkFile } from "../io/json-file.js";
import { writeTextFile } from "../io/text-file.js";
import { loadWorkspaceChunks } from "../io/workspace-chunks.js";
import {
  formatLearningPacketAsText,
  formatMemoryRecallAsText,
  formatMemoryWriteAsText,
  formatSelectionAsText,
  usageText
} from "./formatters.js";
import {
  assertNumberRules,
  listOption,
  numberOption,
  parseArgv,
  requireOption
} from "./arg-parser.js";

function serialize(result, format) {
  if (format === "text") {
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }

  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result, null, 2);
}

async function loadChunkSource(command, options) {
  if (options.input) {
    return loadChunkFile(options.input);
  }

  if (options.workspace || command === "readme") {
    return loadWorkspaceChunks(options.workspace || ".");
  }

  throw new Error("Provide --input <file> or --workspace <dir>.");
}

function readNumericOptions(options) {
  return {
    tokenBudget: assertNumberRules(numberOption(options, "token-budget", 350), "token-budget", {
      min: 1,
      integer: true
    }),
    maxChunks: assertNumberRules(numberOption(options, "max-chunks", 6), "max-chunks", {
      min: 1,
      integer: true
    }),
    minScore: assertNumberRules(numberOption(options, "min-score", 0.25), "min-score", {
      min: 0,
      max: 1
    }),
    sentenceBudget: assertNumberRules(
      numberOption(options, "sentence-budget", 3),
      "sentence-budget",
      {
        min: 1,
        integer: true
      }
    )
  };
}

function getContentOption(options) {
  const value = options.content ?? options.message;

  if (!value || value === "true") {
    throw new Error("Missing required option --content <text> (or --message <text>).");
  }

  return value;
}

function getEngramClient(options, dependencies) {
  if (dependencies.engramClient) {
    return dependencies.engramClient;
  }

  return createEngramClient({
    binaryPath: options["engram-bin"],
    dataDir: options["engram-data-dir"]
  });
}

function countRecalledChunks(chunks) {
  return chunks.filter((chunk) => chunk.source.startsWith("engram://")).length;
}

/**
 * @param {string[]} argv
 * @param {{ engramClient?: ReturnType<typeof createEngramClient> }} [dependencies]
 */
export async function runCli(argv, dependencies = {}) {
  const { command, options } = parseArgv(argv);
  const defaultFormat =
    command === "readme" ||
    command === "recall" ||
    command === "remember" ||
    command === "close"
      ? "text"
      : "json";
  const format =
    options.format === "json" ? "json" : options.format === "text" ? "text" : defaultFormat;

  if (!command || command === "help" || options.help === "true") {
    return {
      exitCode: 0,
      stdout: usageText()
    };
  }

  if (
    command !== "select" &&
    command !== "teach" &&
    command !== "readme" &&
    command !== "recall" &&
    command !== "remember" &&
    command !== "close"
  ) {
    return {
      exitCode: 1,
      stderr: `Unknown command '${command}'.\n\n${usageText()}`
    };
  }

  if (command === "recall") {
    const engram = getEngramClient(options, dependencies);
    const project = options.project;
    const query = options.query;
    const type = options.type;
    const scope = options.scope;
    const limit =
      query !== undefined
        ? assertNumberRules(numberOption(options, "limit", 5), "limit", {
            min: 1,
            integer: true
          })
        : undefined;
    const result = query
      ? await engram.searchMemories(query, {
          project,
          type,
          scope,
          limit
        })
      : await engram.recallContext(project);

    return {
      exitCode: 0,
      stdout: format === "text" ? formatMemoryRecallAsText(result) : serialize(result, format)
    };
  }

  if (command === "remember") {
    const engram = getEngramClient(options, dependencies);
    const result = await engram.saveMemory({
      title: requireOption(options, "title"),
      content: getContentOption(options),
      type: options.type ?? "learning",
      project: options.project,
      scope: options.scope ?? "project",
      topic: options.topic
    });

    return {
      exitCode: 0,
      stdout:
        format === "text"
          ? formatMemoryWriteAsText(result, "Memory saved")
          : serialize(result, format)
    };
  }

  if (command === "close") {
    const engram = getEngramClient(options, dependencies);
    const result = await engram.closeSession({
      summary: requireOption(options, "summary"),
      learned: options.learned,
      next: options.next,
      title: options.title,
      project: options.project,
      scope: options.scope ?? "project",
      type: options.type ?? "learning"
    });

    return {
      exitCode: 0,
      stdout:
        format === "text"
          ? formatMemoryWriteAsText(result, "Session close note saved")
          : serialize(result, format)
    };
  }

  const { payload, path } = await loadChunkSource(command, options);
  const numeric = readNumericOptions(options);

  if (command === "select") {
    const focus = requireOption(options, "focus");
    const result = selectContextWindow(payload.chunks, {
      focus,
      tokenBudget: numeric.tokenBudget,
      maxChunks: numeric.maxChunks,
      sentenceBudget: numeric.sentenceBudget,
      minScore: numeric.minScore
    });

    return {
      exitCode: 0,
      stdout:
        format === "text"
          ? formatSelectionAsText(result)
          : serialize(
              {
                input: path,
                ...result
              },
              format
            )
    };
  }

  if (command === "readme") {
    const task = options.task;
    const objective = options.objective;
    const focus =
      options.focus ??
      `${task ?? ""} ${objective ?? ""} understand code dependencies concepts`.trim();
    const result = await buildLearningReadme({
      title: options.title || "README.LEARN",
      task,
      objective,
      focus,
      projectRoot: options.workspace || ".",
      chunks: payload.chunks,
      tokenBudget: numeric.tokenBudget,
      maxChunks: numeric.maxChunks,
      minScore: numeric.minScore,
      sentenceBudget: numeric.sentenceBudget
    });

    if (options.output) {
      const writtenPath = await writeTextFile(options.output, result.markdown);
      return {
        exitCode: 0,
        stdout:
          format === "json"
            ? serialize(
                {
                  input: path,
                  output: writtenPath,
                  ...result
                },
                format
              )
            : `README generated at ${writtenPath}`
      };
    }

    return {
      exitCode: 0,
      stdout:
        format === "json"
          ? serialize(
              {
                input: path,
                ...result
              },
              format
            )
          : result.markdown
    };
  }

  const task = requireOption(options, "task");
  const objective = requireOption(options, "objective");
  const changedFiles = listOption(options, "changed-files");
  const focus = options.focus ?? `${task} ${objective}`;
  const engram = getEngramClient(options, dependencies);
  const memoryLimit = assertNumberRules(numberOption(options, "memory-limit", 3), "memory-limit", {
    min: 1,
    integer: true
  });
  const teachChunks = await resolveTeachRecall({
    task,
    objective,
    focus,
    changedFiles,
    project: options.project,
    explicitQuery: options["no-recall"] === "true" ? "__disabled__" : options["recall-query"],
    limit: memoryLimit,
    scope: options["memory-scope"] ?? "project",
    type: options["memory-type"],
    strictRecall: options["strict-recall"] === "true",
    baseChunks: payload.chunks,
    searchMemories: engram.searchMemories
  });
  const packet = buildLearningPacket({
    task,
    objective,
    focus,
    changedFiles,
    chunks: teachChunks.chunks,
    tokenBudget: numeric.tokenBudget,
    maxChunks: numeric.maxChunks,
    sentenceBudget: numeric.sentenceBudget,
    minScore: numeric.minScore
  });
  const selectedMemoryChunks = countRecalledChunks(packet.selectedContext);
  const suppressedMemoryChunks = packet.suppressedContext.filter((chunk) =>
    String(chunk.id).startsWith("engram-memory-")
  ).length;
  const packetWithMemory = {
    ...packet,
    memoryRecall: {
      ...teachChunks.memoryRecall,
      selectedChunks: selectedMemoryChunks,
      suppressedChunks: suppressedMemoryChunks
    }
  };

  return {
    exitCode: 0,
    stdout:
      format === "text"
        ? formatLearningPacketAsText(packetWithMemory)
        : serialize(
            {
              input: path,
              ...packetWithMemory
            },
            format
          )
  };
}

// @ts-check

function fail(message) {
  throw new Error(message);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string.`);
  }

  return value;
}

function assertOptionalString(value, label) {
  if (value === undefined) {
    return "";
  }

  return assertString(value, label);
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be a boolean.`);
  }

  return value;
}

function assertNumber(
  value,
  label,
  { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}
) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    fail(`${label} must be a number.`);
  }

  if (value < min) {
    fail(`${label} must be >= ${min}.`);
  }

  if (value > max) {
    fail(`${label} must be <= ${max}.`);
  }

  return value;
}

function assertStringArray(value, label) {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    fail(`${label} must be an array of strings.`);
  }

  return value.map((item, index) => assertString(item, `${label}[${index}]`));
}

function validateProviderMemory(value, caseIndex, memoryIndex) {
  assertObject(value, `cases[${caseIndex}].provider.memories[${memoryIndex}]`);
  const memory = /** @type {Record<string, unknown>} */ (value);

  return {
    query: assertString(memory.query, `cases[${caseIndex}].provider.memories[${memoryIndex}].query`),
    observationId: assertString(
      memory.observationId,
      `cases[${caseIndex}].provider.memories[${memoryIndex}].observationId`
    ),
    type: assertString(memory.type, `cases[${caseIndex}].provider.memories[${memoryIndex}].type`),
    title: assertString(memory.title, `cases[${caseIndex}].provider.memories[${memoryIndex}].title`),
    body: assertString(memory.body, `cases[${caseIndex}].provider.memories[${memoryIndex}].body`),
    timestamp:
      assertOptionalString(
        memory.timestamp,
        `cases[${caseIndex}].provider.memories[${memoryIndex}].timestamp`
      ) || "2026-03-17 00:00:00"
  };
}

function validateCase(value, index) {
  assertObject(value, `cases[${index}]`);
  const entry = /** @type {Record<string, unknown>} */ (value);
  assertObject(entry.input, `cases[${index}].input`);
  assertObject(entry.expectations, `cases[${index}].expectations`);

  const input = /** @type {Record<string, unknown>} */ (entry.input);
  const expectations = /** @type {Record<string, unknown>} */ (entry.expectations);
  const provider = entry.provider ? /** @type {Record<string, unknown>} */ (entry.provider) : {};

  return {
    name: assertString(entry.name, `cases[${index}].name`),
    input: {
      workspace: assertString(input.workspace, `cases[${index}].input.workspace`),
      task: assertString(input.task, `cases[${index}].input.task`),
      objective: assertString(input.objective, `cases[${index}].input.objective`),
      changedFiles: assertStringArray(input.changedFiles, `cases[${index}].input.changedFiles`),
      project: assertOptionalString(input.project, `cases[${index}].input.project`),
      recallQuery: assertOptionalString(input.recallQuery, `cases[${index}].input.recallQuery`),
      noRecall:
        input.noRecall === undefined
          ? false
          : assertBoolean(input.noRecall, `cases[${index}].input.noRecall`),
      tokenBudget:
        input.tokenBudget === undefined
          ? 350
          : assertNumber(input.tokenBudget, `cases[${index}].input.tokenBudget`, { min: 1 }),
      maxChunks:
        input.maxChunks === undefined
          ? 6
          : assertNumber(input.maxChunks, `cases[${index}].input.maxChunks`, { min: 1 })
    },
    provider: {
      memories: Array.isArray(provider.memories)
        ? provider.memories.map((memory, memoryIndex) =>
            validateProviderMemory(memory, index, memoryIndex)
          )
        : []
    },
    expectations: {
      codeFocus: assertString(expectations.codeFocus, `cases[${index}].expectations.codeFocus`),
      relatedTest: assertString(
        expectations.relatedTest,
        `cases[${index}].expectations.relatedTest`
      ),
      excludedSources: assertStringArray(
        expectations.excludedSources,
        `cases[${index}].expectations.excludedSources`
      ),
      memoryRecallStatus: assertString(
        expectations.memoryRecallStatus,
        `cases[${index}].expectations.memoryRecallStatus`
      ),
      selectedMemoryChunks:
        expectations.selectedMemoryChunks === undefined
          ? 0
          : assertNumber(
              expectations.selectedMemoryChunks,
              `cases[${index}].expectations.selectedMemoryChunks`,
              { min: 0 }
            ),
      suppressedMemoryChunks:
        expectations.suppressedMemoryChunks === undefined
          ? 0
          : assertNumber(
              expectations.suppressedMemoryChunks,
              `cases[${index}].expectations.suppressedMemoryChunks`,
              { min: 0 }
            )
    }
  };
}

/**
 * @param {string} raw
 * @param {string} sourceLabel
 */
export function parseVerticalBenchmarkFile(raw, sourceLabel) {
  try {
    const value = JSON.parse(raw);

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`${sourceLabel} must be a JSON object.`);
    }

    const payload = /** @type {Record<string, unknown>} */ (value);

    if (!Array.isArray(payload.cases)) {
      fail(`${sourceLabel} must contain a 'cases' array.`);
    }

    return {
      cases: payload.cases.map((entry, index) => validateCase(entry, index))
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`${sourceLabel} is not valid JSON: ${error.message}`);
    }

    throw error;
  }
}

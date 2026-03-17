// @ts-check

import { validateChunk } from "./context-contracts.js";

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

  assertString(value, label);
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be a boolean.`);
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

  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      fail(`${label}[${index}] must be a non-empty string.`);
    }

    return item;
  });
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

function validateProviderRule(value, caseIndex, ruleIndex) {
  assertObject(value, `cases[${caseIndex}].provider.rules[${ruleIndex}]`);
  const rule = /** @type {Record<string, unknown>} */ (value);

  return {
    observationId: assertOptionalString(
      rule.observationId,
      `cases[${caseIndex}].provider.rules[${ruleIndex}].observationId`
    ),
    type:
      assertOptionalString(rule.type, `cases[${caseIndex}].provider.rules[${ruleIndex}].type`) ||
      "memory",
    title: assertString(rule.title, `cases[${caseIndex}].provider.rules[${ruleIndex}].title`),
    body: assertString(rule.body, `cases[${caseIndex}].provider.rules[${ruleIndex}].body`),
    timestamp:
      assertOptionalString(
        rule.timestamp,
        `cases[${caseIndex}].provider.rules[${ruleIndex}].timestamp`
      ) || "2026-03-17 00:00:00",
    project: assertOptionalString(
      rule.project,
      `cases[${caseIndex}].provider.rules[${ruleIndex}].project`
    ),
    scope:
      assertOptionalString(rule.scope, `cases[${caseIndex}].provider.rules[${ruleIndex}].scope`) ||
      "project",
    requiresAll: assertStringArray(
      rule.requiresAll,
      `cases[${caseIndex}].provider.rules[${ruleIndex}].requiresAll`
    ),
    requiresAny: assertStringArray(
      rule.requiresAny,
      `cases[${caseIndex}].provider.rules[${ruleIndex}].requiresAny`
    )
  };
}

function validateRecallBenchmarkCase(value, index) {
  assertObject(value, `cases[${index}]`);
  const entry = /** @type {Record<string, unknown>} */ (value);

  assertString(entry.name, `cases[${index}].name`);
  assertObject(entry.input, `cases[${index}].input`);
  assertObject(entry.provider, `cases[${index}].provider`);
  assertObject(entry.expectations, `cases[${index}].expectations`);

  const input = /** @type {Record<string, unknown>} */ (entry.input);
  const provider = /** @type {Record<string, unknown>} */ (entry.provider);
  const expectations = /** @type {Record<string, unknown>} */ (entry.expectations);

  if (provider.rules !== undefined && !Array.isArray(provider.rules)) {
    fail(`cases[${index}].provider.rules must be an array.`);
  }

  const status = assertString(expectations.status, `cases[${index}].expectations.status`);

  if (!["recalled", "empty", "failed", "disabled", "skipped"].includes(status)) {
    fail(
      `cases[${index}].expectations.status must be one of recalled, empty, failed, disabled, skipped.`
    );
  }

  return {
    name: /** @type {string} */ (entry.name),
    input: {
      task: assertOptionalString(input.task, `cases[${index}].input.task`),
      objective: assertOptionalString(input.objective, `cases[${index}].input.objective`),
      focus: assertString(input.focus, `cases[${index}].input.focus`),
      changedFiles: assertStringArray(input.changedFiles, `cases[${index}].input.changedFiles`),
      explicitQuery: assertOptionalString(input.explicitQuery, `cases[${index}].input.explicitQuery`),
      project: assertOptionalString(input.project, `cases[${index}].input.project`),
      limit:
        input.limit === undefined
          ? 3
          : assertNumber(input.limit, `cases[${index}].input.limit`, { min: 1 }),
      strictRecall:
        input.strictRecall === undefined
          ? false
          : assertBoolean(input.strictRecall, `cases[${index}].input.strictRecall`),
      baseChunks: Array.isArray(input.baseChunks)
        ? input.baseChunks.map((chunk, chunkIndex) => validateChunk(chunk, chunkIndex))
        : []
    },
    provider: {
      failMessage: assertOptionalString(
        provider.failMessage,
        `cases[${index}].provider.failMessage`
      ),
      rules: (provider.rules ?? []).map((rule, ruleIndex) =>
        validateProviderRule(rule, index, ruleIndex)
      )
    },
    expectations: {
      status,
      recoveredIds: assertStringArray(
        expectations.recoveredIds,
        `cases[${index}].expectations.recoveredIds`
      ),
      minRecoveredChunks:
        expectations.minRecoveredChunks === undefined
          ? 0
          : assertNumber(
              expectations.minRecoveredChunks,
              `cases[${index}].expectations.minRecoveredChunks`,
              { min: 0 }
            ),
      exactRecoveredChunks:
        expectations.exactRecoveredChunks === undefined
          ? -1
          : assertNumber(
              expectations.exactRecoveredChunks,
              `cases[${index}].expectations.exactRecoveredChunks`,
              { min: 0 }
            ),
      maxQueriesTried:
        expectations.maxQueriesTried === undefined
          ? Number.POSITIVE_INFINITY
          : assertNumber(
              expectations.maxQueriesTried,
              `cases[${index}].expectations.maxQueriesTried`,
              { min: 0 }
            ),
      maxFirstMatchIndex:
        expectations.maxFirstMatchIndex === undefined
          ? Number.POSITIVE_INFINITY
          : assertNumber(
              expectations.maxFirstMatchIndex,
              `cases[${index}].expectations.maxFirstMatchIndex`,
              { min: 0 }
            )
    }
  };
}

/**
 * @param {string} raw
 * @param {string} sourceLabel
 */
export function parseRecallBenchmarkFile(raw, sourceLabel) {
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
      cases: payload.cases.map((entry, index) => validateRecallBenchmarkCase(entry, index))
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`${sourceLabel} is not valid JSON: ${error.message}`);
    }

    throw error;
  }
}

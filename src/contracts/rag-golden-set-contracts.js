// @ts-check

function fail(message) {
  throw new Error(message);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array of strings.`);
  }

  return value.map((entry, index) => assertString(entry, `${label}[${index}]`));
}

/**
 * @param {string} raw
 * @param {string} sourceLabel
 * @param {{ minCases?: number }} [options]
 */
export function parseRagGoldenSetFile(raw, sourceLabel, options = {}) {
  const minCases = Number.isFinite(options.minCases) ? Math.max(1, Math.trunc(options.minCases)) : 200;

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(
      `${sourceLabel} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  assertObject(parsed, sourceLabel);
  const payload = /** @type {Record<string, unknown>} */ (parsed);
  const suite = assertString(payload.suite, `${sourceLabel}.suite`);

  if (!Array.isArray(payload.documents) || payload.documents.length === 0) {
    fail(`${sourceLabel}.documents must be a non-empty array.`);
  }

  if (!Array.isArray(payload.cases) || payload.cases.length < minCases) {
    fail(`${sourceLabel}.cases must include at least ${minCases} cases.`);
  }

  const documents = payload.documents.map((entry, index) => {
    assertObject(entry, `documents[${index}]`);
    const doc = /** @type {Record<string, unknown>} */ (entry);
    return {
      id: assertString(doc.id, `documents[${index}].id`),
      project: assertString(doc.project, `documents[${index}].project`),
      domain: assertString(doc.domain, `documents[${index}].domain`),
      title: assertString(doc.title, `documents[${index}].title`),
      content: assertString(doc.content, `documents[${index}].content`)
    };
  });

  const documentIds = new Set();
  for (const doc of documents) {
    if (documentIds.has(doc.id)) {
      fail(`Duplicate document id '${doc.id}'.`);
    }
    documentIds.add(doc.id);
  }

  const cases = payload.cases.map((entry, index) => {
    assertObject(entry, `cases[${index}]`);
    const row = /** @type {Record<string, unknown>} */ (entry);
    const expectedDocIds = assertStringArray(row.expectedDocIds, `cases[${index}].expectedDocIds`);

    for (const docId of expectedDocIds) {
      if (!documentIds.has(docId)) {
        fail(`cases[${index}] references unknown expectedDocId '${docId}'.`);
      }
    }

    return {
      id: assertString(row.id, `cases[${index}].id`),
      project: assertString(row.project, `cases[${index}].project`),
      domain: assertString(row.domain, `cases[${index}].domain`),
      query: assertString(row.query, `cases[${index}].query`),
      expectedDocIds
    };
  });

  return {
    suite,
    documents,
    cases,
    metadata:
      payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? /** @type {Record<string, unknown>} */ (payload.metadata)
        : {}
  };
}


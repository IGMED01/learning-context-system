// @ts-check

/**
 * NEXUS Teaching Validator — Ensures LLM outputs contain the required
 * Teaching Loop sections (Change / Reason / Concepts / Practice).
 *
 * Used as a post-generation check across all CLI commands to guarantee
 * teaching artifacts are present before returning results to the user.
 */

const REQUIRED_SECTIONS = ["change", "reason", "concepts", "practice"];

/**
 * @typedef {{
 *   valid: boolean,
 *   missing: string[],
 *   score: number
 * }} TeachingValidation
 */

/**
 * Validate that an LLM output contains teaching loop sections.
 *
 * @param {string} output — raw LLM response text
 * @returns {TeachingValidation}
 */
export function validateTeachingArtifacts(output) {
  if (!output || typeof output !== "string") {
    return { valid: false, missing: [...REQUIRED_SECTIONS], score: 0 };
  }

  const found = [];
  const missing = [];

  for (const section of REQUIRED_SECTIONS) {
    // Match section headers like "## Change", "**Change**", "Change:", "1) Change"
    const patterns = [
      new RegExp(`#+\\s*${section}`, "i"),
      new RegExp(`\\*\\*${section}\\*\\*`, "i"),
      new RegExp(`\\d+\\)\\s*${section}`, "i"),
      new RegExp(`^${section}\\s*:`, "im")
    ];

    if (patterns.some((p) => p.test(output))) {
      found.push(section);
    } else {
      missing.push(section);
    }
  }

  const score = found.length / REQUIRED_SECTIONS.length;

  return {
    valid: missing.length === 0,
    missing,
    score
  };
}

/**
 * Append a teaching loop stub if the output is missing sections.
 * Used as a fallback to ensure every response has teaching value.
 *
 * @param {string} output
 * @param {{ task?: string }} [context]
 * @returns {string}
 */
export function ensureTeachingArtifacts(output, context = {}) {
  const validation = validateTeachingArtifacts(output);
  if (validation.valid) return output;

  const stub = [
    "",
    "---",
    "## Teaching Loop",
    ""
  ];

  if (validation.missing.includes("change")) {
    stub.push(`**Change**: ${context.task ? `Applied changes for: ${context.task}` : "See output above."}`);
  }
  if (validation.missing.includes("reason")) {
    stub.push(`**Reason**: Addresses the stated task requirements.`);
  }
  if (validation.missing.includes("concepts")) {
    stub.push(`**Concepts**: Review the output for key patterns and decisions.`);
  }
  if (validation.missing.includes("practice")) {
    stub.push(`**Practice**: Try modifying the output to handle an additional edge case.`);
  }

  return output + stub.join("\n");
}

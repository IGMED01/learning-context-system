// @ts-check

/**
 * @typedef {import("../types/core-contracts.d.ts").GuardConfig} GuardConfig
 * @typedef {import("../types/core-contracts.d.ts").GuardEvaluation} GuardEvaluation
 * @typedef {import("../types/core-contracts.d.ts").GuardInput} GuardInput
 * @typedef {import("../types/core-contracts.d.ts").GuardRuleConfig} GuardRuleConfig
 * @typedef {import("../types/core-contracts.d.ts").GuardRuleResult} GuardRuleResult
 * @typedef {import("../types/core-contracts.d.ts").GuardVerdict} GuardVerdict
 */

/**
 * @typedef {(input: GuardInput, config: GuardRuleConfig) => GuardRuleResult} RuleEvaluator
 */

// ── Rule Evaluator Registry ──────────────────────────────────────────

/** @type {Map<string, RuleEvaluator>} */
const evaluators = new Map();

/**
 * @param {string} type
 * @param {RuleEvaluator} evaluator
 */
export function registerGuardRule(type, evaluator) {
  evaluators.set(type, evaluator);
}

/**
 * @returns {string[]}
 */
export function listRegisteredRules() {
  return [...evaluators.keys()];
}

// ── Default Guard Config ─────────────────────────────────────────────

/**
 * @returns {GuardConfig}
 */
export function defaultGuardConfig() {
  return {
    enabled: false,
    rules: [],
    defaultBlockMessage: "This query is outside the scope of this project."
  };
}

// ── Guard Engine Core ────────────────────────────────────────────────

/**
 * @param {GuardInput} input
 * @param {GuardConfig} config
 * @returns {GuardEvaluation}
 */
export function evaluateGuard(input, config) {
  const startMs = Date.now();

  if (!config.enabled) {
    return {
      blocked: false,
      warned: false,
      blockedBy: "",
      userMessage: "",
      results: [],
      durationMs: Date.now() - startMs
    };
  }

  /** @type {GuardRuleResult[]} */
  const results = [];
  let blocked = false;
  let warned = false;
  let blockedBy = "";
  let blockMessage = "";

  for (const ruleConfig of config.rules) {
    if (!ruleConfig.enabled) {
      continue;
    }

    const evaluator = evaluators.get(ruleConfig.type);

    if (!evaluator) {
      results.push({
        rule: ruleConfig.type,
        verdict: /** @type {GuardVerdict} */ ("warn"),
        reason: `Unknown guard rule type: '${ruleConfig.type}'`,
        confidence: 0
      });
      warned = true;
      continue;
    }

    const result = evaluator(input, ruleConfig);
    results.push(result);

    if (result.verdict === "block") {
      blocked = true;
      blockedBy = result.rule;
      blockMessage = result.reason;
      break;
    }

    if (result.verdict === "warn") {
      warned = true;
    }
  }

  return {
    blocked,
    warned,
    blockedBy,
    userMessage: blocked ? blockMessage || config.defaultBlockMessage : "",
    results,
    durationMs: Date.now() - startMs
  };
}

// ── Built-in Rule: Input Validation ──────────────────────────────────

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /you\s+are\s+now\s+(a|an|in)\s+/i,
  /disregard\s+(all\s+)?(previous|prior|your)\s+/i,
  /pretend\s+(you\s+are|to\s+be|you're)\s+/i,
  /act\s+as\s+(if|a|an|though)\s+/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /```\s*(system|assistant|user)\s*/i,
  /('\s*OR\s+'|\s+OR\s+1\s*=\s*1|;\s*DROP\s+TABLE|UNION\s+SELECT)/i,
  /(\/\*|\*\/|--\s)/,
  /\.\.\//,
  /\x00/,
  /\\u0000/
];

registerGuardRule("input-validation", (input, config) => {
  const params = config.params;
  const minLength = typeof params.minLength === "number" ? params.minLength : 3;
  const maxLength = typeof params.maxLength === "number" ? params.maxLength : 2000;
  const blockInjection = params.blockInjection !== false;

  const query = input.query.trim();

  if (query.length < minLength) {
    return {
      rule: "input-validation",
      verdict: /** @type {GuardVerdict} */ ("block"),
      reason: `Query too short (${query.length} chars, minimum ${minLength}). Please provide a more specific question.`,
      confidence: 0.95
    };
  }

  if (query.length > maxLength) {
    return {
      rule: "input-validation",
      verdict: /** @type {GuardVerdict} */ ("block"),
      reason: `Query too long (${query.length} chars, maximum ${maxLength}). Please shorten your question.`,
      confidence: 0.95
    };
  }

  if (blockInjection) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(query)) {
        return {
          rule: "input-validation",
          verdict: /** @type {GuardVerdict} */ ("block"),
          reason: "Query contains a pattern that looks like a prompt injection or code injection attempt.",
          confidence: 0.85
        };
      }
    }
  }

  return {
    rule: "input-validation",
    verdict: /** @type {GuardVerdict} */ ("allow"),
    reason: "Input validation passed",
    confidence: 1
  };
});

// ── Built-in Rule: Domain Scope ──────────────────────────────────────

registerGuardRule("domain-scope", (input, config) => {
  const params = config.params;
  const allowedTopics = Array.isArray(params.allowedTopics) ? /** @type {string[]} */ (params.allowedTopics) : [];
  const blockedTopics = Array.isArray(params.blockedTopics) ? /** @type {string[]} */ (params.blockedTopics) : [];
  const mode = typeof params.mode === "string" ? params.mode : "both";
  const minOverlap = typeof params.minTopicOverlap === "number" ? params.minTopicOverlap : 1;

  const queryLower = input.query.toLowerCase();

  if (mode === "blocklist" || mode === "both") {
    for (const blocked of blockedTopics) {
      if (queryLower.includes(blocked.toLowerCase())) {
        return {
          rule: "domain-scope",
          verdict: /** @type {GuardVerdict} */ ("block"),
          reason: `Query contains blocked topic: "${blocked}". This project does not cover this area.`,
          confidence: 0.88
        };
      }
    }
  }

  if ((mode === "allowlist" || mode === "both") && allowedTopics.length > 0) {
    let matchCount = 0;

    for (const allowed of allowedTopics) {
      if (queryLower.includes(allowed.toLowerCase())) {
        matchCount++;
      }
    }

    if (matchCount < minOverlap) {
      return {
        rule: "domain-scope",
        verdict: /** @type {GuardVerdict} */ ("block"),
        reason: `Query does not match any allowed topic for this project. Covered topics: ${allowedTopics.slice(0, 5).join(", ")}${allowedTopics.length > 5 ? "..." : ""}.`,
        confidence: 0.75
      };
    }
  }

  return {
    rule: "domain-scope",
    verdict: /** @type {GuardVerdict} */ ("allow"),
    reason: "Query is within project domain scope",
    confidence: 0.9
  };
});

// ── Optional Rule: Scope Filter (formerly "Jurisdiction") ────────────
// Generic scope filter — OPTIONAL, never enabled by default.
// Works with any scope concept (geographic, organizational, domain).
// Does NOTHING unless explicitly configured and enabled in guard config.

registerGuardRule("jurisdiction", (input, config) => {
  const params = config.params;
  const allowed = Array.isArray(params.allowedJurisdictions) ? /** @type {string[]} */ (params.allowedJurisdictions) : [];
  const blocked = Array.isArray(params.blockedJurisdictions) ? /** @type {string[]} */ (params.blockedJurisdictions) : [];
  const strictMode = params.strictMode === true;

  const queryLower = input.query.toLowerCase();

  for (const jurisdiction of blocked) {
    if (queryLower.includes(jurisdiction.toLowerCase())) {
      const suggestion = allowed.length ? ` This system covers: ${allowed.join(", ")}.` : "";
      return {
        rule: "jurisdiction",
        verdict: /** @type {GuardVerdict} */ ("block"),
        reason: `Query references jurisdiction "${jurisdiction}" which is not covered by this project.${suggestion}`,
        confidence: 0.92
      };
    }
  }

  if (strictMode && allowed.length > 0) {
    const mentionsAllowed = allowed.some((j) => queryLower.includes(j.toLowerCase()));

    if (!mentionsAllowed) {
      return {
        rule: "jurisdiction",
        verdict: /** @type {GuardVerdict} */ ("warn"),
        reason: `Query does not explicitly mention a covered jurisdiction. Covered: ${allowed.join(", ")}.`,
        confidence: 0.6
      };
    }
  }

  return {
    rule: "jurisdiction",
    verdict: /** @type {GuardVerdict} */ ("allow"),
    reason: "Jurisdiction check passed",
    confidence: 0.9
  };
});

// ── Built-in Rule: Rate Limit ────────────────────────────────────────

/** @type {Map<string, { timestamps: number[] }>} */
const rateLimitWindows = new Map();

registerGuardRule("rate-limit", (input, config) => {
  const params = config.params;
  const maxRequests = typeof params.maxRequests === "number" ? params.maxRequests : 60;
  const windowMs = typeof params.windowMs === "number" ? params.windowMs : 60_000;

  const key = `${input.project}:rate`;
  const now = Date.now();

  if (!rateLimitWindows.has(key)) {
    rateLimitWindows.set(key, { timestamps: [] });
  }

  const window = /** @type {{ timestamps: number[] }} */ (rateLimitWindows.get(key));
  window.timestamps = window.timestamps.filter((ts) => now - ts < windowMs);

  if (window.timestamps.length >= maxRequests) {
    const oldestInWindow = window.timestamps[0];
    const retryAfterMs = windowMs - (now - oldestInWindow);
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);

    return {
      rule: "rate-limit",
      verdict: /** @type {GuardVerdict} */ ("block"),
      reason: `Rate limit exceeded: ${maxRequests} requests per ${windowMs / 1000}s. Retry in ${retryAfterSec}s.`,
      confidence: 1
    };
  }

  window.timestamps.push(now);

  return {
    rule: "rate-limit",
    verdict: /** @type {GuardVerdict} */ ("allow"),
    reason: `Rate limit OK (${window.timestamps.length}/${maxRequests})`,
    confidence: 1
  };
});

// ── Built-in Rule: Keyword Block ─────────────────────────────────────

registerGuardRule("keyword-block", (input, config) => {
  const params = config.params;
  const keywords = Array.isArray(params.keywords) ? /** @type {string[]} */ (params.keywords) : [];
  const customMessage = typeof params.message === "string" ? params.message : "";

  const queryLower = input.query.toLowerCase();

  for (const keyword of keywords) {
    if (queryLower.includes(keyword.toLowerCase())) {
      return {
        rule: "keyword-block",
        verdict: /** @type {GuardVerdict} */ ("block"),
        reason: customMessage || `Query contains blocked keyword: "${keyword}".`,
        confidence: 0.95
      };
    }
  }

  return {
    rule: "keyword-block",
    verdict: /** @type {GuardVerdict} */ ("allow"),
    reason: "No blocked keywords found",
    confidence: 1
  };
});

// ── Utility ──────────────────────────────────────────────────────────

/**
 * @param {GuardEvaluation} evaluation
 * @returns {string}
 */
export function formatGuardResultAsText(evaluation) {
  /** @type {string[]} */
  const lines = [];

  if (evaluation.blocked) {
    lines.push(`Guard BLOCKED query.`);
    lines.push(`  Rule: ${evaluation.blockedBy}`);
    lines.push(`  Reason: ${evaluation.userMessage}`);
  } else if (evaluation.warned) {
    lines.push(`Guard ALLOWED query with warnings.`);
  } else {
    lines.push(`Guard ALLOWED query.`);
  }

  if (evaluation.results.length > 0) {
    lines.push("");
    lines.push("Rule evaluations:");

    for (const result of evaluation.results) {
      const icon = result.verdict === "allow" ? "PASS" : result.verdict === "block" ? "FAIL" : "WARN";
      lines.push(`  [${icon}] ${result.rule}: ${result.reason} (confidence: ${(result.confidence * 100).toFixed(0)}%)`);
    }
  }

  lines.push(`  Duration: ${evaluation.durationMs}ms`);

  return lines.join("\n");
}

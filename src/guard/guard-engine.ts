/**
 * Guard Engine — evaluates queries against configurable rules before
 * they reach the recall/teach pipeline.
 *
 * Architecture:
 *   Query → [InputValidator] → [DomainScope] → [Jurisdiction] → [RateLimit] → [KeywordBlock] → ALLOW
 *                 ↓                  ↓               ↓              ↓               ↓
 *              BLOCK             BLOCK           BLOCK          BLOCK           BLOCK
 *
 * Each rule is a pure function: (input, config) → GuardRuleResult
 * The engine runs them in config order; first "block" wins.
 *
 * Design decisions:
 * - Rules are declarative (JSON config), not code — operators can change behavior without deploys
 * - Each rule produces a confidence score — useful for future soft-blocking / review queues
 * - The engine is sync-capable but async-ready (rate limit needs state)
 * - Follows LCS pattern: evaluateSafetyGate() returns { blocked, reason, details[] }
 */

import type {
  GuardConfig,
  GuardEvaluation,
  GuardInput,
  GuardRuleConfig,
  GuardRuleResult,
  GuardVerdict
} from "../types/core-contracts.d.ts";

// ── Rule Evaluator Registry ──────────────────────────────────────────

type RuleEvaluator = (input: GuardInput, config: GuardRuleConfig) => GuardRuleResult;

const evaluators = new Map<string, RuleEvaluator>();

export function registerGuardRule(type: string, evaluator: RuleEvaluator): void {
  evaluators.set(type, evaluator);
}

export function listRegisteredRules(): string[] {
  return [...evaluators.keys()];
}

// ── Default Guard Config ─────────────────────────────────────────────

export function defaultGuardConfig(): GuardConfig {
  return {
    enabled: false,
    rules: [],
    defaultBlockMessage: "This query is outside the scope of this project."
  };
}

// ── Guard Engine Core ────────────────────────────────────────────────

/**
 * Evaluate a query against all configured guard rules.
 *
 * Rules run in config order. First "block" verdict stops evaluation.
 * If guard is disabled, returns allow immediately.
 *
 * This is the single entry point for all guard checks.
 * Wire it into the CLI pipeline BEFORE recall/teach.
 */
export function evaluateGuard(input: GuardInput, config: GuardConfig): GuardEvaluation {
  const startMs = Date.now();

  // Guard disabled = allow everything
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

  const results: GuardRuleResult[] = [];
  let blocked = false;
  let warned = false;
  let blockedBy = "";
  let blockMessage = "";

  for (const ruleConfig of config.rules) {
    // Skip disabled rules
    if (!ruleConfig.enabled) {
      continue;
    }

    const evaluator = evaluators.get(ruleConfig.type);

    if (!evaluator) {
      // Unknown rule type — warn but don't block
      results.push({
        rule: ruleConfig.type,
        verdict: "warn",
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
      break; // First block wins — don't evaluate further rules
    }

    if (result.verdict === "warn") {
      warned = true;
    }
  }

  return {
    blocked,
    warned,
    blockedBy,
    userMessage: blocked
      ? blockMessage || config.defaultBlockMessage
      : "",
    results,
    durationMs: Date.now() - startMs
  };
}

// ── Built-in Rule: Input Validation ──────────────────────────────────
//
// Validates basic query hygiene:
// - Minimum length (avoids garbage queries burning tokens)
// - Maximum length (prevents payload attacks)
// - Prompt injection patterns (SQL-style, jailbreak patterns)
// - Encoding attacks (null bytes, unicode exploits)
//
// Config params:
//   minLength: number (default 3)
//   maxLength: number (default 2000)
//   blockInjection: boolean (default true)

const INJECTION_PATTERNS = [
  // Classic prompt injection / jailbreak attempts
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /you\s+are\s+now\s+(a|an|in)\s+/i,
  /disregard\s+(all\s+)?(previous|prior|your)\s+/i,
  /pretend\s+(you\s+are|to\s+be|you're)\s+/i,
  /act\s+as\s+(if|a|an|though)\s+/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /```\s*(system|assistant|user)\s*/i,

  // SQL/NoSQL injection in queries
  /('\s*OR\s+'|\s+OR\s+1\s*=\s*1|;\s*DROP\s+TABLE|UNION\s+SELECT)/i,
  /(\/\*|\*\/|--\s)/,

  // Path traversal
  /\.\.\//,

  // Encoding attacks
  /\x00/, // null byte
  /\\u0000/, // escaped null
];

registerGuardRule("input-validation", (input: GuardInput, config: GuardRuleConfig): GuardRuleResult => {
  const params = config.params;
  const minLength = typeof params.minLength === "number" ? params.minLength : 3;
  const maxLength = typeof params.maxLength === "number" ? params.maxLength : 2000;
  const blockInjection = params.blockInjection !== false;

  const query = input.query.trim();

  // Length checks
  if (query.length < minLength) {
    return {
      rule: "input-validation",
      verdict: "block",
      reason: `Query too short (${query.length} chars, minimum ${minLength}). Please provide a more specific question.`,
      confidence: 0.95
    };
  }

  if (query.length > maxLength) {
    return {
      rule: "input-validation",
      verdict: "block",
      reason: `Query too long (${query.length} chars, maximum ${maxLength}). Please shorten your question.`,
      confidence: 0.95
    };
  }

  // Injection detection
  if (blockInjection) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(query)) {
        return {
          rule: "input-validation",
          verdict: "block",
          reason: "Query contains a pattern that looks like a prompt injection or code injection attempt.",
          confidence: 0.85
        };
      }
    }
  }

  return {
    rule: "input-validation",
    verdict: "allow",
    reason: "Input validation passed",
    confidence: 1
  };
});

// ── Built-in Rule: Domain Scope ──────────────────────────────────────
//
// Ensures queries relate to the project's configured domain.
// Uses keyword matching against allowed/blocked topic lists.
//
// Config params:
//   allowedTopics: string[] — keywords that indicate on-topic queries
//   blockedTopics: string[] — keywords that indicate off-topic queries
//   mode: "allowlist" | "blocklist" | "both" (default "both")
//   minTopicOverlap: number — minimum matching keywords to allow (default 1)
//
// How it works:
// - "allowlist" mode: query MUST contain at least one allowed topic keyword
// - "blocklist" mode: query must NOT contain any blocked topic keyword
// - "both" mode: both conditions must pass

registerGuardRule("domain-scope", (input: GuardInput, config: GuardRuleConfig): GuardRuleResult => {
  const params = config.params;
  const allowedTopics = Array.isArray(params.allowedTopics) ? params.allowedTopics as string[] : [];
  const blockedTopics = Array.isArray(params.blockedTopics) ? params.blockedTopics as string[] : [];
  const mode = typeof params.mode === "string" ? params.mode : "both";
  const minOverlap = typeof params.minTopicOverlap === "number" ? params.minTopicOverlap : 1;

  const queryLower = input.query.toLowerCase();
  const queryTokens = queryLower.split(/\s+/);

  // Check blocked topics
  if (mode === "blocklist" || mode === "both") {
    for (const blocked of blockedTopics) {
      const blockedLower = blocked.toLowerCase();

      if (queryLower.includes(blockedLower)) {
        return {
          rule: "domain-scope",
          verdict: "block",
          reason: `Query contains blocked topic: "${blocked}". This project does not cover this area.`,
          confidence: 0.88
        };
      }
    }
  }

  // Check allowed topics
  if ((mode === "allowlist" || mode === "both") && allowedTopics.length > 0) {
    let matchCount = 0;

    for (const allowed of allowedTopics) {
      const allowedLower = allowed.toLowerCase();

      if (queryLower.includes(allowedLower)) {
        matchCount++;
      }
    }

    if (matchCount < minOverlap) {
      return {
        rule: "domain-scope",
        verdict: "block",
        reason: `Query does not match any allowed topic for this project. Covered topics: ${allowedTopics.slice(0, 5).join(", ")}${allowedTopics.length > 5 ? "..." : ""}.`,
        confidence: 0.75
      };
    }
  }

  return {
    rule: "domain-scope",
    verdict: "allow",
    reason: "Query is within project domain scope",
    confidence: 0.9
  };
});

// ── Optional Rule: Scope Filter (formerly "Jurisdiction") ────────────
//
// Generic scope filter that restricts queries to a defined domain boundary.
// This is an OPTIONAL rule — never enabled by default. It exists as a
// reusable template for projects that need geographic, organizational,
// or domain-based scoping (e.g., a legal system restricted to one region,
// a corporate KB restricted to one department, etc.).
//
// The rule is universal: it works with ANY scope concept, not just
// geographic jurisdictions. The param names use "jurisdiction" for
// backward compatibility, but they represent any scope boundary.
//
// Config params:
//   allowedJurisdictions: string[] — scope keywords that are allowed
//   blockedJurisdictions: string[] — scope keywords that are blocked
//   strictMode: boolean — if true, query MUST mention an allowed scope (default false)
//
// Examples:
//   Legal project:  allowedJurisdictions: ["salta"], blockedJurisdictions: ["buenos aires"]
//   Corporate KB:   allowedJurisdictions: ["engineering"], blockedJurisdictions: ["sales", "hr"]
//   Regional API:   allowedJurisdictions: ["latam"], blockedJurisdictions: ["apac", "emea"]
//
// IMPORTANT: This rule does NOTHING unless explicitly configured and enabled.
// It is NOT part of the default guard pipeline.

registerGuardRule("jurisdiction", (input: GuardInput, config: GuardRuleConfig): GuardRuleResult => {
  const params = config.params;
  const allowed = Array.isArray(params.allowedJurisdictions) ? params.allowedJurisdictions as string[] : [];
  const blocked = Array.isArray(params.blockedJurisdictions) ? params.blockedJurisdictions as string[] : [];
  const strictMode = params.strictMode === true;

  const queryLower = input.query.toLowerCase();

  // Check blocked jurisdictions first
  for (const jurisdiction of blocked) {
    const jLower = jurisdiction.toLowerCase();

    if (queryLower.includes(jLower)) {
      const suggestion = allowed.length
        ? ` This system covers: ${allowed.join(", ")}.`
        : "";

      return {
        rule: "jurisdiction",
        verdict: "block",
        reason: `Query references jurisdiction "${jurisdiction}" which is not covered by this project.${suggestion}`,
        confidence: 0.92
      };
    }
  }

  // Strict mode: must mention an allowed jurisdiction
  if (strictMode && allowed.length > 0) {
    const mentionsAllowed = allowed.some((j) => queryLower.includes(j.toLowerCase()));

    if (!mentionsAllowed) {
      return {
        rule: "jurisdiction",
        verdict: "warn",
        reason: `Query does not explicitly mention a covered jurisdiction. Covered: ${allowed.join(", ")}.`,
        confidence: 0.6
      };
    }
  }

  return {
    rule: "jurisdiction",
    verdict: "allow",
    reason: "Jurisdiction check passed",
    confidence: 0.9
  };
});

// ── Built-in Rule: Rate Limit ────────────────────────────────────────
//
// Per-project sliding window rate limiter.
// Prevents abuse and controls costs before queries hit memory/LLM.
//
// Config params:
//   maxRequests: number — max requests per window (default 60)
//   windowMs: number — window size in milliseconds (default 60000 = 1 min)

/** @internal In-memory sliding window counters per project */
const rateLimitWindows = new Map<string, { timestamps: number[] }>();

registerGuardRule("rate-limit", (input: GuardInput, config: GuardRuleConfig): GuardRuleResult => {
  const params = config.params;
  const maxRequests = typeof params.maxRequests === "number" ? params.maxRequests : 60;
  const windowMs = typeof params.windowMs === "number" ? params.windowMs : 60_000;

  const key = `${input.project}:rate`;
  const now = Date.now();

  if (!rateLimitWindows.has(key)) {
    rateLimitWindows.set(key, { timestamps: [] });
  }

  const window = rateLimitWindows.get(key)!;

  // Prune old timestamps outside the window
  window.timestamps = window.timestamps.filter((ts) => now - ts < windowMs);

  if (window.timestamps.length >= maxRequests) {
    const oldestInWindow = window.timestamps[0];
    const retryAfterMs = windowMs - (now - oldestInWindow);
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);

    return {
      rule: "rate-limit",
      verdict: "block",
      reason: `Rate limit exceeded: ${maxRequests} requests per ${windowMs / 1000}s. Retry in ${retryAfterSec}s.`,
      confidence: 1
    };
  }

  // Record this request
  window.timestamps.push(now);

  return {
    rule: "rate-limit",
    verdict: "allow",
    reason: `Rate limit OK (${window.timestamps.length}/${maxRequests})`,
    confidence: 1
  };
});

// ── Built-in Rule: Keyword Block ─────────────────────────────────────
//
// Simple keyword blocklist. Blocks queries containing specific words/phrases.
// Useful for quick content filtering without domain-scope complexity.
//
// Config params:
//   keywords: string[] — exact words/phrases to block
//   message: string — custom block message (optional)

registerGuardRule("keyword-block", (input: GuardInput, config: GuardRuleConfig): GuardRuleResult => {
  const params = config.params;
  const keywords = Array.isArray(params.keywords) ? params.keywords as string[] : [];
  const customMessage = typeof params.message === "string" ? params.message : "";

  const queryLower = input.query.toLowerCase();

  for (const keyword of keywords) {
    if (queryLower.includes(keyword.toLowerCase())) {
      return {
        rule: "keyword-block",
        verdict: "block",
        reason: customMessage || `Query contains blocked keyword: "${keyword}".`,
        confidence: 0.95
      };
    }
  }

  return {
    rule: "keyword-block",
    verdict: "allow",
    reason: "No blocked keywords found",
    confidence: 1
  };
});

// ── Utility: Format guard result for CLI output ──────────────────────

export function formatGuardResultAsText(evaluation: GuardEvaluation): string {
  const lines: string[] = [];

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
